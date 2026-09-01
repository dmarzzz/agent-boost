import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  DEFAULT_SHIELD_WEI,
  type WalletAdapter,
} from "../contracts.js";
import { KOHAKU_COMMIT } from "./pin.js";
import {
  SpawnCommandRunner,
  type CommandInvocation,
  type CommandResult,
  type CommandRunner,
} from "./runner.js";

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const WALLET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FROM_SELECTOR_RE = /^(?:[0-9]+|s[0-9]+|0x[0-9a-fA-F]{40})$/;

export interface KohakuWalletAdapterOptions {
  dataDir: string;
  walletName: string;
  passwordFile: string;
  rpcUrl: string;
  executable?: string;
  runner?: CommandRunner;
  shieldFrom?: string;
  /** Tornado note denomination withdrawn to fund an exact tail-call payment. */
  tornadoWithdrawalWei?: bigint;
}

interface KohakuBalanceRow {
  symbol?: unknown;
  raw_token_holdings?: unknown;
  status?: unknown;
}

interface KohakuBalancesPayload {
  public_balances_aggregated?: unknown;
  private_balances?: {
    tornado?: unknown;
  };
}

/**
 * Kohaku 0.1-note payments withdraw to a fresh wallet-controlled 7702 account,
 * then send the requested value as a tail call. Kohaku forwards the remainder
 * (less the paymaster fee) to that fresh account.
 */
export class KohakuWalletAdapter implements WalletAdapter {
  static readonly compatibleCommit = KOHAKU_COMMIT;

  readonly #dataDir: string;
  readonly #walletName: string;
  readonly #passwordFile: string;
  readonly #rpcUrl: string;
  readonly #executable: string;
  readonly #runner: CommandRunner;
  readonly #shieldFrom: string;
  readonly #tornadoWithdrawalWei: bigint;
  readonly #queueKey: string;

  private static readonly queues = new Map<string, Promise<void>>();

  constructor(options: KohakuWalletAdapterOptions) {
    if (!WALLET_NAME_RE.test(options.walletName)) {
      throw new Error(
        "Kohaku wallet name must contain only letters, digits, dot, underscore, or dash",
      );
    }
    if (
      options.walletName === "proving-artifacts" ||
      options.walletName === "public-sync-cache"
    ) {
      throw new Error(`Kohaku wallet name is reserved: ${options.walletName}`);
    }
    const rpcUrl = parseHttpsUrl(options.rpcUrl);
    const shieldFrom = options.shieldFrom ?? "0";
    if (!FROM_SELECTOR_RE.test(shieldFrom)) {
      throw new Error("Kohaku shield source must be an account index or address");
    }
    const withdrawalWei = options.tornadoWithdrawalWei ?? DEFAULT_SHIELD_WEI;
    if (withdrawalWei <= 0n) {
      throw new Error("Tornado withdrawal amount must be positive");
    }

    this.#dataDir = resolve(options.dataDir);
    this.#walletName = options.walletName;
    this.#passwordFile = resolve(options.passwordFile);
    this.#rpcUrl = rpcUrl;
    this.#executable = options.executable ?? "kohaku";
    this.#runner = options.runner ?? new SpawnCommandRunner();
    this.#shieldFrom = shieldFrom;
    this.#tornadoWithdrawalWei = withdrawalWei;
    this.#queueKey = `${this.#dataDir}\0${this.#walletName}`;
  }

  ensureWallet(): Promise<void> {
    return this.#serialized(async () => {
      await this.#securePaths();
      const result = await this.#run([
        "list-wallets",
        "--dataDir",
        this.#dataDir,
        "--non-interactive",
      ]);
      const payload = parseJsonObject(result.stdout, "list-wallets");
      const wallets = payload.wallets;
      if (!isRecord(wallets)) {
        throw new Error("Kohaku list-wallets returned an invalid wallets object");
      }

      const existing = wallets[this.#walletName];
      if (existing !== undefined) {
        if (!isRecord(existing) || existing.mainnet !== false) {
          throw new Error(
            `Existing Kohaku wallet ${this.#walletName} is not marked as Sepolia testnet`,
          );
        }
        return;
      }

      await this.#run([
        "create-wallet",
        this.#walletName,
        "--testnet",
        "--password",
        this.#passwordFile,
        "--dataDir",
        this.#dataDir,
        "--non-interactive",
      ], true);
    });
  }

  nextFreshAddress(): Promise<string> {
    return this.#serialized(async () => {
      const result = await this.#runWalletCommand(
        "next-fresh-address",
        [],
        false,
      );
      const address = result.stdout.trim();
      if (!ETH_ADDRESS_RE.test(address)) {
        throw new Error("Kohaku next-fresh-address returned an invalid address");
      }
      return address;
    });
  }

  prewarmPrivacy(): Promise<void> {
    return this.#serialized(async () => {
      await this.#run([
        "fetch-artifacts",
        "--tornado",
        "--dataDir",
        this.#dataDir,
        "--non-interactive",
      ]);
    });
  }

  shieldWei(amountWei: bigint): Promise<{ transactionHash?: string }> {
    if (amountWei <= 0n) {
      return Promise.reject(new Error("Shield amount must be positive"));
    }
    return this.#serialized(async () => {
      const result = await this.#runWalletCommand("shield", [
        "--protocol",
        "tornado",
        "--from",
        this.#shieldFrom,
        "--amount-wei",
        amountWei.toString(),
        "--broadcast",
      ]);
      return optionalTransactionHash(result.stdout);
    });
  }

  getPrivateBalanceWei(): Promise<bigint> {
    return this.getBalanceSnapshot().then((snapshot) => snapshot.privateBalanceWei);
  }

  getBalanceSnapshot(): Promise<{
    publicBalanceWei: bigint;
    privateBalanceWei: bigint;
  }> {
    return this.#serialized(async () => {
      const result = await this.#runWalletCommand("balances", [
        "--include",
        "tornado",
        "--skip-stealth-scan",
      ]);
      const payload = parseJsonObject(
        result.stdout,
        "balances",
      ) as KohakuBalancesPayload;
      const privateRows = payload.private_balances?.tornado;
      if (!Array.isArray(privateRows)) {
        throw new Error("Kohaku balances returned no Tornado balance array");
      }
      const publicRows = payload.public_balances_aggregated;
      if (!Array.isArray(publicRows)) {
        throw new Error("Kohaku balances returned no public balance array");
      }

      let privateBalanceWei = 0n;
      for (const value of privateRows) {
        if (!isRecord(value)) continue;
        const row = value as KohakuBalanceRow;
        if (row.symbol !== "ETH" || row.status !== "spendable") continue;
        if (
          typeof row.raw_token_holdings !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/.test(row.raw_token_holdings)
        ) {
          throw new Error("Kohaku returned an invalid Tornado ETH balance");
        }
        privateBalanceWei += BigInt(row.raw_token_holdings);
      }
      let publicBalanceWei = 0n;
      for (const value of publicRows) {
        if (!isRecord(value) || value.symbol !== "ETH") continue;
        if (
          typeof value.raw_token_holdings !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/.test(value.raw_token_holdings)
        ) {
          throw new Error("Kohaku returned an invalid public ETH balance");
        }
        publicBalanceWei += BigInt(value.raw_token_holdings);
      }
      return { publicBalanceWei, privateBalanceWei };
    });
  }

  executePrivatePayment(input: {
    recipient: string;
    amountWei: bigint;
  }): Promise<{ transactionHash?: string }> {
    if (!ETH_ADDRESS_RE.test(input.recipient)) {
      return Promise.reject(new Error("Payment recipient must be an Ethereum address"));
    }
    if (input.amountWei <= 0n) {
      return Promise.reject(new Error("Payment amount must be positive"));
    }
    if (input.amountWei >= this.#tornadoWithdrawalWei) {
      return Promise.reject(
        new Error(
          "Payment must be smaller than the Tornado withdrawal so the paymaster fee can be reserved",
        ),
      );
    }

    return this.#serialized(async () => {
      const tailCall = `${input.recipient}:0x:${input.amountWei.toString()}`;
      const result = await this.#runWalletCommand("unshield", [
        "--protocol",
        "tornado",
        "--next",
        "--amount-wei",
        this.#tornadoWithdrawalWei.toString(),
        "--tail-calls",
        tailCall,
        "--broadcast",
      ]);
      return optionalTransactionHash(result.stdout);
    });
  }

  async #runWalletCommand(
    command: string,
    commandArgs: readonly string[] = [],
    includeRpc = true,
  ): Promise<CommandResult> {
    return this.#run([
      command,
      "--wallet",
      this.#walletName,
      "--password",
      this.#passwordFile,
      "--dataDir",
      this.#dataDir,
      "--non-interactive",
      ...commandArgs,
    ], includeRpc);
  }

  async #run(
    args: readonly string[],
    includeRpc = false,
  ): Promise<CommandResult> {
    await this.#securePaths();
    const invocation: CommandInvocation = {
      executable: this.#executable,
      args,
      ...(includeRpc ? { env: { RPC_URL: this.#rpcUrl } } : {}),
    };
    let result: CommandResult;
    try {
      result = await this.#runner.run(invocation);
    } finally {
      await hardenTree(this.#dataDir);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Kohaku command ${args[0] ?? "unknown"} failed with exit code ${result.exitCode.toString()}`,
      );
    }
    return result;
  }

  async #securePaths(): Promise<void> {
    await ensureSecureDirectory(this.#dataDir, "Kohaku data directory");
    const secretDir = dirname(this.#passwordFile);
    await ensureSecureDirectory(secretDir, "Kohaku secret directory");

    let passwordStat;
    try {
      passwordStat = await lstat(this.#passwordFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Kohaku password file does not exist: ${this.#passwordFile}`,
        );
      }
      throw error;
    }
    if (!passwordStat.isFile() || passwordStat.isSymbolicLink()) {
      throw new Error("Kohaku password path must be a regular file, not a symlink");
    }
    await chmod(this.#passwordFile, 0o600);
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = KohakuWalletAdapter.queues.get(this.#queueKey) ??
      Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    KohakuWalletAdapter.queues.set(this.#queueKey, queued);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (KohakuWalletAdapter.queues.get(this.#queueKey) === queued) {
        KohakuWalletAdapter.queues.delete(this.#queueKey);
      }
    }
  }
}

async function ensureSecureDirectory(path: string, label: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a directory, not a symlink`);
  }
  await chmod(path, 0o700);
}

function parseHttpsUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Kohaku RPC URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Kohaku RPC URL must use HTTPS");
  }
  return parsed.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(stdout: string, command: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Kohaku ${command} returned invalid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Kohaku ${command} returned a non-object JSON value`);
  }
  return parsed;
}

function optionalTransactionHash(stdout: string): { transactionHash?: string } {
  const payload = parseJsonObject(stdout, "broadcast");
  const transactionHash = findTransactionHash(payload);
  return transactionHash ? { transactionHash } : {};
}

function findTransactionHash(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["explorerHash", "transactionHash", "txHash", "hash"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && TX_HASH_RE.test(candidate)) {
      return candidate;
    }
  }
  for (const candidate of Object.values(value)) {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const nested = findTransactionHash(entry);
        if (nested) return nested;
      }
    } else {
      const nested = findTransactionHash(candidate);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function hardenTree(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(path, 0o700);
    const entries = await readdir(path);
    await Promise.all(entries.map((entry) => hardenTree(resolve(path, entry))));
    return;
  }
  if (stat.isFile()) {
    await chmod(path, 0o600);
  }
}
