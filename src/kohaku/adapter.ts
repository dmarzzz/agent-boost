import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as AbiFunction from "ox/AbiFunction";
import * as AbiParameters from "ox/AbiParameters";

import {
  DEFAULT_SHIELD_WEI,
  REGULAR_TRANSFER_GAS_RESERVE_WEI,
  TORNADO_DEPOSIT_GAS_RESERVE_WEI,
  type PrivateBroadcastCheckpoint,
  type RawTransactionBroadcastCheckpoint,
  type WalletAdapter,
  type WalletInventoryItem,
} from "../contracts.js";
import { WalletExecutionError } from "../errors.js";
import { KOHAKU_COMMIT } from "./pin.js";
import {
  SpawnCommandRunner,
  type CommandInvocation,
  type CommandResult,
  type CommandRunner,
} from "./runner.js";
import { repairTornadoStateWithShadow } from "./tornado-state-repair.js";

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const WALLET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FROM_SELECTOR_RE = /^(?:[0-9]+|s[0-9]+|0x[0-9a-fA-F]{40})$/;
const DECIMAL_UINT_RE = /^(?:0|[1-9][0-9]*)$/;
const TORNADO_DEPOSIT_SELECTOR = "0xb214faa5";
const TORNADO_WITHDRAW_SELECTOR = "0x21a0adb6";
const TORNADO_DEPOSIT_CALL_RE = /^0xb214faa5([0-9a-fA-F]{64})$/;
const SEPOLIA_TORNADO_ETH_0_1_POOL =
  "0x8c4a04d872a6c1be37964a21ba3a138525dff50b";
const SEPOLIA_TORNADO_ETH_0_1_ADAPTER =
  "0xa616aae443fccabfc2f1ea2afe001e5046ffdce0";
const SEPOLIA_TORNADO_PAYMASTER =
  "0x1c5accb9c09d72945b79ec986776136be01d7b2f";
const ENTRY_POINT_V08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
const SIMPLE_7702_IMPLEMENTATION =
  "0xe6cae83bde06e4c305530e199d7217f42808555b";
const PRIVATE_BROADCAST_JOURNAL_DIRECTORY =
  ".agent-boost-private-broadcast-journal";
const RAW_TRANSACTION_BROADCAST_JOURNAL_DIRECTORY =
  ".agent-boost-raw-transaction-journal";
const PRIVATE_BROADCAST_REQUEST_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX_QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const TORNADO_TAIL_FEE_PAD_NUMERATOR = 23n;
const TORNADO_TAIL_FEE_PAD_DENOMINATOR = 20n;
const REGULAR_TRANSFER_MAX_GAS = 100_000n;
const TORNADO_DEPOSIT_MAX_GAS = 3_000_000n;
const MAX_PRIVATE_PAYMASTER_FEE_RESERVE_WEI = 10_000_000_000_000_000n;
const TOR_GUARD_STATE_CORRUPTION_LINE =
  "Bootstrap failed: tor: corrupted data in persistent state: Error setting up the guard manager";
const TOR_CACHE_RECOVERY_HINT = "Try: kohaku clear-tor-cache";
const TOR_GUARD_STATE_CORRUPTION_DECORATED_LINE =
  `■  ✖ ${TOR_GUARD_STATE_CORRUPTION_LINE}`;
const TOR_CACHE_RECOVERY_DECORATED_HINT =
  `│    → ${TOR_CACHE_RECOVERY_HINT}`;
const TORNADO_STALE_ROOT_LINE_RE =
  /^■  ✖ State root verification failed: root not found in Pool recent history(?: \(expected=(?:0|[1-9][0-9]*), currentOnChain=(?:0|[1-9][0-9]*)\))?$/u;
const NETWORK_GUARD_PATH = fileURLToPath(
  new URL("./network-guard.mjs", import.meta.url),
);
const EXECUTE_FUNCTION = AbiFunction.from(
  "function execute(address target,uint256 value,bytes data)",
);
const EXECUTE_BATCH_FUNCTION = AbiFunction.from(
  "function executeBatch((address target,uint256 value,bytes data)[] calls)",
);
const TORNADO_WITHDRAW_FUNCTION = AbiFunction.from(
  "function withdraw(bytes proof,bytes32 root,bytes32 nullifierHash,address recipient,address relayer,uint256 fee,uint256 refund)",
);
const PAYMASTER_DATA_PARAMETERS = AbiParameters.from(
  "(address adapter, bytes adapterData)",
);
const TORNADO_SPONSOR_PARAMETERS = AbiParameters.from(
  "(bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee, uint256 refund)",
);

interface PreparedTornadoDepositCall {
  to: string;
  data: string;
  valueWei: string;
}

interface PreparedAccountCall {
  target: string;
  value: bigint;
  data: string;
}

/**
 * Pinned Kohaku rebuilds the UserOperation for the broadcast invocation.
 * Bind every spend-relevant call field while permitting only regenerated
 * direct-withdraw proof/root bytes and fee-derived self-change to move.
 */
interface PrivateBroadcastCallPlan {
  version: 1;
  withdrawalAmountWei: string;
  maxFeeReserveWei: string;
  gasFloors: {
    callGasLimit: string;
    verificationGasLimit: string;
    preVerificationGas: string;
    paymasterVerificationGasLimit: string;
    paymasterPostOpGasLimit: string;
  };
  directWithdrawals: Array<{
    poolAddress: string;
    nullifierHash: string;
  }>;
  sponsor: {
    adapterAddress: string;
    nullifierHash: string;
  };
  tailCall: {
    target: string;
    data: string;
    valueWei: string;
  };
}

interface PreparedPaymasterSponsorship {
  adapterAddress: string;
  nullifierHash: string;
  feeWei: bigint;
}

interface PreparedUserOperationGasLimits {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
}

interface ValidatedPrivatePreparation {
  sender: string;
  callPlan: PrivateBroadcastCallPlan;
}

interface RawTransactionIntent {
  version: 1;
  from: string;
  to: string;
  valueWei: string;
  data: string;
  maxGas: string;
  maxFeeWei: string;
}

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
 * Kohaku 0.1-note payments withdraw to a fresh 7702 payment subaccount,
 * then send the requested value as a tail call. Kohaku forwards the remainder
 * (less the paymaster fee) to that fresh account. "Subaccount" describes its
 * funding role; the main account has no authority over it.
 */
export class KohakuWalletAdapter implements WalletAdapter {
  static readonly compatibleCommit = KOHAKU_COMMIT;

  readonly #dataDir: string;
  #walletName: string;
  readonly #passwordFile: string;
  readonly #rpcUrl: string;
  readonly #rpcRelayToken: string | undefined;
  readonly #executable: string;
  readonly #runner: CommandRunner;
  readonly #shieldFrom: string;
  readonly #tornadoWithdrawalWei: bigint;
  readonly #queueKey: string;

  private static readonly queues = new Map<string, Promise<void>>();

  constructor(options: KohakuWalletAdapterOptions) {
    validateWalletName(options.walletName);
    const rpcUrl = parseRpcUrl(options.rpcUrl);
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
    this.#rpcRelayToken = relayToken(rpcUrl);
    this.#executable = options.executable ?? "kohaku";
    this.#runner = options.runner ?? new SpawnCommandRunner();
    this.#shieldFrom = shieldFrom;
    this.#tornadoWithdrawalWei = withdrawalWei;
    this.#queueKey = this.#dataDir;
  }

  selectWallet(walletName: string): void {
    validateWalletName(walletName);
    this.#walletName = walletName;
  }

  listWallets(): Promise<WalletInventoryItem[]> {
    return this.#serialized(async () => {
      const result = await this.#run([
        "list-wallets",
        "--dataDir",
        this.#dataDir,
        "--non-interactive",
      ]);
      const payload = parseJsonObject(result.stdout, "list-wallets");
      if (!isRecord(payload.wallets)) {
        throw new Error("Kohaku list-wallets returned an invalid wallets object");
      }
      return Object.entries(payload.wallets).map(([name, value]) => {
        if (!isRecord(value)) {
          throw new Error("Kohaku list-wallets returned invalid wallet metadata");
        }
        const network = value.mainnet === false
          ? "sepolia"
          : value.mainnet === true
            ? "mainnet"
            : "unknown";
        return { name, network };
      });
    });
  }

  ensureWallet(): Promise<void> {
    const walletName = this.#walletName;
    return this.ensureBackendWallet(walletName);
  }

  ensureBackendWallet(walletName: string): Promise<void> {
    validateWalletName(walletName);
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

      const existing = wallets[walletName];
      if (existing !== undefined) {
        if (!isRecord(existing) || existing.mainnet !== false) {
          throw new Error(
            `Existing Kohaku wallet ${walletName} is not marked as Sepolia testnet`,
          );
        }
        return;
      }

      await this.#run([
        "create-wallet",
        walletName,
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
    const walletName = this.#walletName;
    return this.#serialized(async () => {
      const result = await this.#runWalletCommand(
        walletName,
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

  peekNextFreshAddressForWallet(walletName: string): Promise<string> {
    validateWalletName(walletName);
    return this.#serialized(() => this.#peekNextFreshAddress(walletName));
  }

  ensurePrivateChangeAccount(
    walletName: string,
    expectedAddress: string,
  ): Promise<void> {
    validateWalletName(walletName);
    validateExecutorAddress(expectedAddress);
    return this.#serialized(async () => {
      const balances = await this.#runWalletCommand(walletName, "balances", [
        "--verbose",
        "--include",
        "tornado",
        "--skip-stealth-scan",
      ]);
      const payload = parseJsonObject(balances.stdout, "balances --verbose");
      const indexes = payload.public_account_indexes_by_address;
      if (!isRecord(indexes)) {
        throw new Error(
          "Kohaku balances --verbose returned no public account index map",
        );
      }
      let alreadyPersisted = false;
      for (const [address, index] of Object.entries(indexes)) {
        if (
          !ETH_ADDRESS_RE.test(address) ||
          typeof index !== "number" ||
          !Number.isSafeInteger(index) ||
          index < 0
        ) {
          throw new Error(
            "Kohaku balances --verbose returned an invalid public account index map",
          );
        }
        if (address.toLowerCase() === expectedAddress.toLowerCase()) {
          alreadyPersisted = true;
        }
      }
      if (alreadyPersisted) return;
      const peeked = await this.#peekNextFreshAddress(walletName);
      if (peeked.toLowerCase() !== expectedAddress.toLowerCase()) {
        throw new Error(
          "Cannot persist the private change account without exact next-address evidence",
        );
      }
      const result = await this.#runWalletCommand(
        walletName,
        "next-fresh-address",
        [],
        false,
      );
      const persisted = result.stdout.trim();
      if (
        !ETH_ADDRESS_RE.test(persisted) ||
        persisted.toLowerCase() !== expectedAddress.toLowerCase()
      ) {
        throw new Error(
          "Kohaku persisted a different private change account than expected",
        );
      }
    });
  }

  getPrivateBroadcastCheckpoint(
    requestId: string,
  ): Promise<PrivateBroadcastCheckpoint | undefined> {
    validatePrivateBroadcastRequestId(requestId);
    return this.#serialized(() => this.#readPrivateBroadcastCheckpoint(requestId));
  }

  getRawTransactionBroadcastCheckpoint(
    requestId: string,
  ): Promise<RawTransactionBroadcastCheckpoint | undefined> {
    validatePrivateBroadcastRequestId(requestId);
    return this.#serialized(() =>
      this.#readRawTransactionBroadcastCheckpoint(requestId)
    );
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

  shieldWei(amountWei: bigint, input: {
    sourceAddress: string;
    preparedDepositCall?: PreparedTornadoDepositCall;
    broadcastRequestId: string;
    beforeBroadcast: (
      preparedDepositCall: PreparedTornadoDepositCall,
    ) => Promise<void>;
  }): Promise<{ transactionHash: string }> {
    try {
      assertExactTornadoDepositAmount(amountWei);
      validateExecutorAddress(input.sourceAddress);
      validatePrivateBroadcastRequestId(input.broadcastRequestId);
      if (input.preparedDepositCall !== undefined) {
        validatePreparedTornadoDepositCall(input.preparedDepositCall);
      }
    } catch (error) {
      return Promise.reject(walletExecutionError(error, false));
    }
    const walletName = this.#walletName;
    return this.#serialized(async () => {
      const existing = await this.#readRawTransactionBroadcastCheckpoint(
        input.broadcastRequestId,
      );
      if (existing) {
        throw walletExecutionError(
          new Error("Raw transaction request already has a durable checkpoint"),
          true,
        );
      }

      let call: PreparedTornadoDepositCall;
      let expectedIntent: RawTransactionIntent;
      const transactionArgs = [
        "--from",
        input.sourceAddress,
        "--targets",
        SEPOLIA_TORNADO_ETH_0_1_POOL,
        "--payloads",
        "",
        "--values",
        amountWei.toString(),
      ];
      try {
        if (input.preparedDepositCall) {
          call = validatePreparedTornadoDepositCall(input.preparedDepositCall);
        } else {
          const prepared = await this.#runWalletCommand(walletName, "shield", [
            "--protocol",
            "tornado",
            "--from",
            input.sourceAddress,
            "--amount-wei",
            amountWei.toString(),
            "--skip-sim",
          ]);
          call = parsePreparedTornadoDeposit(
            prepared.stdout,
            input.sourceAddress,
          ).preparedDepositCall;
        }
        transactionArgs[5] = call.data;
        const transaction = await this.#runWalletCommand(
          walletName,
          "transact-raw",
          transactionArgs,
        );
        expectedIntent = validateMainDepositPreparation(
          transaction.stdout,
          input.sourceAddress,
          call,
        );
      } catch (error) {
        throw walletExecutionError(error, false);
      }

      try {
        await input.beforeBroadcast(call);
      } catch (error) {
        throw walletExecutionError(error, false);
      }

      return this.#runJournaledRawTransactionBroadcast({
        walletName,
        command: "transact-raw",
        args: [...transactionArgs, "--broadcast"],
        requestId: input.broadcastRequestId,
        expectedIntent,
      });
    });
  }

  getPrivateBalanceWei(): Promise<bigint> {
    return this.getBalanceSnapshot().then((snapshot) => snapshot.privateBalanceWei);
  }

  getPrivateBalanceWeiForWallet(walletName: string): Promise<bigint> {
    return this.getBalanceSnapshotForWallet(walletName).then(
      (snapshot) => snapshot.privateBalanceWei,
    );
  }

  syncBackendWallet(walletName: string): Promise<bigint> {
    return this.getPrivateBalanceWeiForWallet(walletName);
  }

  getBalanceSnapshot(): Promise<{
    publicBalanceWei: bigint;
    privateBalanceWei: bigint;
  }> {
    const walletName = this.#walletName;
    return this.getBalanceSnapshotForWallet(walletName);
  }

  getBalanceSnapshotForWallet(walletName: string): Promise<{
    publicBalanceWei: bigint;
    privateBalanceWei: bigint;
  }> {
    validateWalletName(walletName);
    return this.#serialized(async () => {
      const result = await this.#runWalletCommand(walletName, "balances", [
        "--include",
        "tornado",
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

  async prepareTornadoEthDeposit(input: {
    targetWalletName: string;
    executorAddress: string;
    amountWei: bigint;
  }): Promise<{
    targetCommitment: string;
    preparedDepositCall: PreparedTornadoDepositCall;
  }> {
    validateWalletName(input.targetWalletName);
    validateExecutorAddress(input.executorAddress);
    assertExactTornadoDepositAmount(input.amountWei);

    return this.#serialized(async () => {
      const result = await this.#runWalletCommand(
        input.targetWalletName,
        "shield",
        [
          "--protocol",
          "tornado",
          "--from",
          input.executorAddress,
          "--amount-wei",
          input.amountWei.toString(),
          "--skip-sim",
        ],
      );
      return parsePreparedTornadoDeposit(
        result.stdout,
        input.executorAddress,
      );
    });
  }

  async executePreparedMainDeposit(input: {
    sourceWalletName: string;
    sourceExecutorAddress: string;
    preparedDepositCall: PreparedTornadoDepositCall;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash?: string }> {
    let call: PreparedTornadoDepositCall;
    try {
      validateWalletName(input.sourceWalletName);
      validateExecutorAddress(input.sourceExecutorAddress);
      validatePrivateBroadcastRequestId(input.broadcastRequestId);
      call = validatePreparedTornadoDepositCall(input.preparedDepositCall);
    } catch (error) {
      throw walletExecutionError(error, false);
    }

    return this.#serialized(async () => {
      const existing = await this.#readRawTransactionBroadcastCheckpoint(
        input.broadcastRequestId,
      );
      if (existing) {
        throw walletExecutionError(
          new Error("Raw transaction request already has a durable checkpoint"),
          true,
        );
      }
      const args = [
        "--from",
        input.sourceExecutorAddress,
        "--targets",
        call.to,
        "--payloads",
        call.data,
        "--values",
        call.valueWei,
      ];
      let expectedIntent: RawTransactionIntent;
      try {
        const preparation = await this.#runWalletCommand(
          input.sourceWalletName,
          "transact-raw",
          args,
        );
        expectedIntent = validateMainDepositPreparation(
          preparation.stdout,
          input.sourceExecutorAddress,
          call,
        );
      } catch (error) {
        throw walletExecutionError(error, false);
      }

      try {
        await input.beforeBroadcast?.();
      } catch (error) {
        throw walletExecutionError(error, false);
      }

      return this.#runJournaledRawTransactionBroadcast({
        walletName: input.sourceWalletName,
        command: "transact-raw",
        args: [...args, "--broadcast"],
        requestId: input.broadcastRequestId,
        expectedIntent,
      });
    });
  }

  async executePrivateRebalance(input: {
    sourceWalletName: string;
    sourceExecutorAddress: string;
    withdrawalAmountWei: bigint;
    preparedDepositCall: PreparedTornadoDepositCall;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash?: string; userOperationHash?: string }> {
    let call: PreparedTornadoDepositCall;
    try {
      validateWalletName(input.sourceWalletName);
      validateExecutorAddress(input.sourceExecutorAddress);
      validatePrivateBroadcastRequestId(input.broadcastRequestId);
      call = validatePreparedTornadoDepositCall(input.preparedDepositCall);
      validateTornadoRebalanceWithdrawal(
        input.withdrawalAmountWei,
        BigInt(call.valueWei),
      );
    } catch (error) {
      throw walletExecutionError(error, false);
    }

    return this.#serialized(async () => {
      let args: string[];
      let preparation: ValidatedPrivatePreparation;
      try {
        const existing = await this.#readPrivateBroadcastCheckpoint(
          input.broadcastRequestId,
        );
        if (existing) {
          throw walletExecutionError(
            new Error("Private broadcast request already has a durable UserOperation"),
            true,
          );
        }
        const executorAddress = await this.#peekNextFreshAddress(
          input.sourceWalletName,
        );
        if (
          executorAddress.toLowerCase() !==
          input.sourceExecutorAddress.toLowerCase()
        ) {
          throw new Error(
            "Private rebalance plan is stale because the source executor changed",
          );
        }
        args = [
          "--protocol",
          "tornado",
          "--next",
          "--amount-wei",
          input.withdrawalAmountWei.toString(),
          "--tail-calls",
          `${call.to}:${call.data}:${call.valueWei}`,
        ];

        const prepared = await this.#runWalletCommand(
          input.sourceWalletName,
          "unshield",
          args,
        );
        preparation = validatePrivateRebalancePreparation({
          stdout: prepared.stdout,
          executorAddress,
          withdrawalAmountWei: input.withdrawalAmountWei,
          preparedDepositCall: call,
        });
      } catch (error) {
        if (error instanceof WalletExecutionError) throw error;
        throw walletExecutionError(error, false);
      }

      try {
        await input.beforeBroadcast?.();
      } catch (error) {
        throw walletExecutionError(error, false);
      }

      return this.#runJournaledPrivateBroadcast({
        walletName: input.sourceWalletName,
        args: [...args, "--broadcast"],
        requestId: input.broadcastRequestId,
        expectedSender: preparation.sender,
        expectedCallPlan: preparation.callPlan,
      });
    });
  }

  executePrivatePayment(input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash?: string; userOperationHash?: string }> {
    const walletName = this.#walletName;
    return this.executePrivatePaymentFromWallet(walletName, input);
  }

  executePrivatePaymentFromWallet(walletName: string, input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash?: string; userOperationHash?: string }> {
    return this.#executePrivateTailTransfer(walletName, {
      ...input,
      label: "Payment",
    });
  }

  executeRegularTransfer(input: {
    sourceAddress: string;
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash?: string }> {
    const walletName = this.#walletName;
    return this.#executeRegularTransferFrom(walletName, {
      sourceSelector: this.#shieldFrom,
      expectedSourceAddress: input.sourceAddress,
      recipient: input.recipient,
      amountWei: input.amountWei,
      broadcastRequestId: input.broadcastRequestId,
      beforeBroadcast: input.beforeBroadcast,
    });
  }

  executeRegularTransferFromWallet(walletName: string, input: {
    sourceAddress: string;
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash?: string }> {
    return this.#executeRegularTransferFrom(walletName, {
      sourceSelector: input.sourceAddress,
      expectedSourceAddress: input.sourceAddress,
      recipient: input.recipient,
      amountWei: input.amountWei,
      broadcastRequestId: input.broadcastRequestId,
      beforeBroadcast: input.beforeBroadcast,
    });
  }

  #executeRegularTransferFrom(walletName: string, input: {
    sourceSelector: string;
    expectedSourceAddress?: string;
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash?: string }> {
    try {
      validateWalletName(walletName);
      if (!FROM_SELECTOR_RE.test(input.sourceSelector)) {
        throw new Error("Transfer source must be a saved account index or address");
      }
      if (
        input.expectedSourceAddress !== undefined &&
        !ETH_ADDRESS_RE.test(input.expectedSourceAddress)
      ) {
        throw new Error("Transfer source must be an Ethereum address");
      }
      if (!ETH_ADDRESS_RE.test(input.recipient)) {
        throw new Error("Transfer recipient must be an Ethereum address");
      }
      if (input.amountWei <= 0n) {
        throw new Error("Transfer amount must be positive");
      }
      validatePrivateBroadcastRequestId(input.broadcastRequestId);
    } catch (error) {
      return Promise.reject(walletExecutionError(error, false));
    }

    return this.#serialized(async () => {
      const existing = await this.#readRawTransactionBroadcastCheckpoint(
        input.broadcastRequestId,
      );
      if (existing) {
        throw walletExecutionError(
          new Error("Raw transaction request already has a durable checkpoint"),
          true,
        );
      }
      const args = [
        "--from",
        input.sourceSelector,
        "--to",
        input.recipient,
        "--token",
        "eth",
        "--amount-wei",
        input.amountWei.toString(),
      ];
      let expectedIntent: RawTransactionIntent;
      try {
        const preparation = await this.#runWalletCommand(
          walletName,
          "transfer",
          args,
        );
        expectedIntent = validateRegularTransferPreparation({
          stdout: preparation.stdout,
          ...(input.expectedSourceAddress === undefined
            ? {}
            : { expectedSourceAddress: input.expectedSourceAddress }),
          recipient: input.recipient,
          amountWei: input.amountWei,
        });
      } catch (error) {
        throw walletExecutionError(error, false);
      }
      try {
        await input.beforeBroadcast();
      } catch (error) {
        throw walletExecutionError(error, false);
      }
      return this.#runJournaledRawTransactionBroadcast({
        walletName,
        command: "transfer",
        args: [...args, "--broadcast"],
        requestId: input.broadcastRequestId,
        expectedIntent,
      });
    });
  }

  executeRecoveryTransfer(input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash?: string; userOperationHash?: string }> {
    const walletName = this.#walletName;
    return this.executeRecoveryTransferFromWallet(walletName, input);
  }

  executeRecoveryTransferFromWallet(walletName: string, input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash?: string; userOperationHash?: string }> {
    return this.#executePrivateTailTransfer(walletName, {
      ...input,
      label: "Recovery",
    });
  }

  #executePrivateTailTransfer(walletName: string, input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
    label: "Payment" | "Recovery";
  }): Promise<{ transactionHash?: string; userOperationHash?: string }> {
    try {
      validateWalletName(walletName);
      validatePrivateBroadcastRequestId(input.broadcastRequestId);
      if (!ETH_ADDRESS_RE.test(input.recipient)) {
        throw new Error(`${input.label} recipient must be an Ethereum address`);
      }
      if (input.amountWei <= 0n) {
        throw new Error(`${input.label} amount must be positive`);
      }
      if (input.amountWei >= this.#tornadoWithdrawalWei) {
        throw new Error(
          `${input.label} amount must be smaller than the Tornado withdrawal so the paymaster fee can be reserved`,
        );
      }
    } catch (error) {
      return Promise.reject(walletExecutionError(error, false));
    }

    return this.#serialized(async () => {
      const tailCall = `${input.recipient}:0x:${input.amountWei.toString()}`;
      const args = [
        "--protocol",
        "tornado",
        "--next",
        "--amount-wei",
        this.#tornadoWithdrawalWei.toString(),
        "--tail-calls",
        tailCall,
      ];
      let preparation: ValidatedPrivatePreparation;
      try {
        const existing = await this.#readPrivateBroadcastCheckpoint(
          input.broadcastRequestId,
        );
        if (existing) {
          throw walletExecutionError(
            new Error("Private broadcast request already has a durable UserOperation"),
            true,
          );
        }
        const result = await this.#runWalletCommand(walletName, "unshield", args);
        preparation = validatePrivateTailPreparation({
          stdout: result.stdout,
          recipient: input.recipient,
          amountWei: input.amountWei,
          withdrawalAmountWei: this.#tornadoWithdrawalWei,
        });
      } catch (error) {
        if (error instanceof WalletExecutionError) throw error;
        throw walletExecutionError(error, false);
      }

      try {
        await input.beforeBroadcast();
      } catch (error) {
        throw walletExecutionError(error, false);
      }

      return this.#runJournaledPrivateBroadcast({
        walletName,
        args: [...args, "--broadcast"],
        requestId: input.broadcastRequestId,
        expectedSender: preparation.sender,
        expectedCallPlan: preparation.callPlan,
      });
    });
  }

  async #runJournaledPrivateBroadcast(input: {
    walletName: string;
    args: readonly string[];
    requestId: string;
    expectedSender: string;
    expectedCallPlan: PrivateBroadcastCallPlan;
  }): Promise<{ transactionHash?: string; userOperationHash?: string }> {
    const journalPath = await this.#privateBroadcastJournalPath(input.requestId);
    try {
      const result = await this.#runWalletCommand(
        input.walletName,
        "unshield",
        input.args,
        true,
        {
          AGENT_BOOST_PRIVATE_BROADCAST_JOURNAL_PATH: journalPath,
          AGENT_BOOST_PRIVATE_BROADCAST_REQUEST_ID: input.requestId,
          AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_SENDER: input.expectedSender,
          AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_CALL_PLAN:
            JSON.stringify(input.expectedCallPlan),
        },
      );
      const checkpoint = await this.#readPrivateBroadcastCheckpoint(
        input.requestId,
      );
      if (!checkpoint) {
        throw new Error(
          "Kohaku exited without an exact private broadcast checkpoint",
        );
      }
      if (checkpoint.sender.toLowerCase() !== input.expectedSender.toLowerCase()) {
        throw new Error("Private broadcast checkpoint changed the prepared sender");
      }
      const identifiers = optionalPaymentIdentifiers(result.stdout);
      if (
        identifiers.userOperationHash !== undefined &&
        identifiers.userOperationHash.toLowerCase() !==
          checkpoint.userOperationHash.toLowerCase()
      ) {
        throw new Error(
          "Kohaku broadcast output disagrees with the exact UserOperation checkpoint",
        );
      }
      return {
        ...(identifiers.transactionHash
          ? { transactionHash: identifiers.transactionHash }
          : {}),
        userOperationHash: checkpoint.userOperationHash,
      };
    } catch (error) {
      let checkpoint: PrivateBroadcastCheckpoint | undefined;
      try {
        checkpoint = await this.#readPrivateBroadcastCheckpoint(input.requestId);
      } catch (journalError) {
        throw walletExecutionError(journalError, true);
      }
      throw walletExecutionError(error, checkpoint !== undefined);
    }
  }

  async #runJournaledRawTransactionBroadcast(input: {
    walletName: string;
    command: "transfer" | "transact-raw";
    args: readonly string[];
    requestId: string;
    expectedIntent: RawTransactionIntent;
  }): Promise<{ transactionHash: string }> {
    const journalPath = await this.#rawTransactionBroadcastJournalPath(
      input.requestId,
    );
    try {
      const result = await this.#runWalletCommand(
        input.walletName,
        input.command,
        input.args,
        true,
        {
          AGENT_BOOST_RAW_TRANSACTION_JOURNAL_PATH: journalPath,
          AGENT_BOOST_RAW_TRANSACTION_REQUEST_ID: input.requestId,
          AGENT_BOOST_RAW_TRANSACTION_EXPECTED_INTENT:
            JSON.stringify(input.expectedIntent),
        },
      );
      const checkpoint = await this.#readRawTransactionBroadcastCheckpoint(
        input.requestId,
      );
      if (!checkpoint) {
        throw new Error(
          "Kohaku exited without an exact raw transaction checkpoint",
        );
      }
      assertRawTransactionCheckpointIntent(checkpoint, input.expectedIntent);
      let outputHash: string | undefined;
      if (result.stdout.trim() !== "") {
        outputHash = optionalTransactionHash(result.stdout).transactionHash;
      }
      if (
        outputHash !== undefined &&
        outputHash.toLowerCase() !== checkpoint.transactionHash.toLowerCase()
      ) {
        throw new Error(
          "Kohaku broadcast output disagrees with the exact raw transaction checkpoint",
        );
      }
      return { transactionHash: checkpoint.transactionHash };
    } catch (error) {
      let checkpoint: RawTransactionBroadcastCheckpoint | undefined;
      try {
        checkpoint = await this.#readRawTransactionBroadcastCheckpoint(
          input.requestId,
        );
      } catch (journalError) {
        throw walletExecutionError(journalError, true);
      }
      throw walletExecutionError(error, checkpoint !== undefined);
    }
  }

  async #privateBroadcastJournalPath(requestId: string): Promise<string> {
    validatePrivateBroadcastRequestId(requestId);
    const directory = resolve(
      this.#dataDir,
      PRIVATE_BROADCAST_JOURNAL_DIRECTORY,
    );
    await ensureSecureDirectory(directory, "Private broadcast journal directory");
    const filename = `${createHash("sha256").update(requestId).digest("hex")}.json`;
    return resolve(directory, filename);
  }

  async #rawTransactionBroadcastJournalPath(requestId: string): Promise<string> {
    validatePrivateBroadcastRequestId(requestId);
    const directory = resolve(
      this.#dataDir,
      RAW_TRANSACTION_BROADCAST_JOURNAL_DIRECTORY,
    );
    await ensureSecureDirectory(
      directory,
      "Raw transaction broadcast journal directory",
    );
    const filename = `${createHash("sha256").update(requestId).digest("hex")}.json`;
    return resolve(directory, filename);
  }

  async #readPrivateBroadcastCheckpoint(
    requestId: string,
  ): Promise<PrivateBroadcastCheckpoint | undefined> {
    const path = await this.#privateBroadcastJournalPath(requestId);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Private broadcast checkpoint must be a regular file");
    }
    await chmod(path, 0o600);
    return parsePrivateBroadcastCheckpoint(await readFile(path, "utf8"), requestId);
  }

  async #readRawTransactionBroadcastCheckpoint(
    requestId: string,
  ): Promise<RawTransactionBroadcastCheckpoint | undefined> {
    const path = await this.#rawTransactionBroadcastJournalPath(requestId);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Raw transaction checkpoint must be a regular file");
    }
    await chmod(path, 0o600);
    return parseRawTransactionBroadcastCheckpoint(
      await readFile(path, "utf8"),
      requestId,
    );
  }

  async #peekNextFreshAddress(walletName: string): Promise<string> {
    const result = await this.#runWalletCommand(
      walletName,
      "next-fresh-address",
      ["--peek"],
      false,
    );
    const address = result.stdout.trim();
    if (!ETH_ADDRESS_RE.test(address)) {
      throw new Error(
        "Kohaku next-fresh-address --peek returned an invalid address",
      );
    }
    return address;
  }

  async #runWalletCommand(
    walletName: string,
    command: string,
    commandArgs: readonly string[] = [],
    includeRpc = true,
    extraEnv: Readonly<Record<string, string>> = {},
  ): Promise<CommandResult> {
    return this.#run([
      command,
      "--wallet",
      walletName,
      "--password",
      this.#passwordFile,
      "--dataDir",
      this.#dataDir,
      "--non-interactive",
      ...commandArgs,
    ], includeRpc, extraEnv);
  }

  async #run(
    args: readonly string[],
    includeRpc = false,
    extraEnv: Readonly<Record<string, string>> = {},
  ): Promise<CommandResult> {
    await this.#securePaths();
    const invocation: CommandInvocation = {
      executable: this.#executable,
      args,
      ...(includeRpc || Object.keys(extraEnv).length > 0
        ? {
            env: {
              ...(includeRpc
                ? {
                    RPC_URL: this.#rpcUrl,
                    AGENT_BOOST_ALLOWED_RPC_URL: this.#rpcUrl,
                    NODE_OPTIONS: `--import=${pathToFileURL(NETWORK_GUARD_PATH).href}`,
                  }
                : {}),
              ...extraEnv,
            },
          }
        : {}),
    };
    const walletName = walletNameFromArgs(args) ?? this.#walletName;
    let result = await this.#runHardened(invocation, walletName);
    if (
      result.exitCode !== 0 &&
      isRecoverableTorGuardStateCorruption(result) &&
      isIdempotentKohakuInvocation(args)
    ) {
      const cleared = await this.#runHardened({
        executable: this.#executable,
        args: [
          "clear-tor-cache",
          "--dataDir",
          this.#dataDir,
          "--non-interactive",
        ],
      }, walletName);
      if (cleared.exitCode === 0) {
        // This is deliberately the only retry. A repeated corruption failure
        // must surface instead of entering a destructive recovery loop.
        result = await this.#runHardened(invocation, walletName);
      }
    }
    if (
      result.exitCode !== 0 &&
      isRecoverableTornadoRootFailure(result) &&
      isRepairableTornadoPreparation(args)
    ) {
      // Pinned Kohaku can persist a per-pool checkpoint after an incomplete
      // public-log tail. Rebuild only in a quarantined copy, using the exact
      // failed preparation. The helper promotes the encrypted candidate only
      // after that same no-broadcast invocation succeeds and the live state
      // still matches the ciphertext we inspected.
      result = await repairTornadoStateWithShadow({
        dataDir: this.#dataDir,
        walletName,
        passwordFile: this.#passwordFile,
        runCandidate: async ({ dataDir }) => {
          const candidateInvocation = {
            ...invocation,
            args: replaceInvocationDataDir(args, this.#dataDir, dataDir),
          };
          const candidate = await this.#runHardened(
            candidateInvocation,
            walletName,
            dataDir,
          );
          if (candidate.exitCode !== 0) {
            throw new Error("Kohaku Tornado repair candidate failed");
          }
          return candidate;
        },
      });
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Kohaku command ${args[0] ?? "unknown"} failed with exit code ${result.exitCode.toString()}`,
      );
    }
    return result;
  }

  async #runHardened(
    invocation: CommandInvocation,
    walletName: string,
    dataDir = this.#dataDir,
  ): Promise<CommandResult> {
    let result: CommandResult;
    try {
      result = await this.#runner.run(invocation);
    } finally {
      try {
        await redactRelayTokenFromTrafficLog(
          dataDir,
          walletName,
          this.#rpcRelayToken,
        );
      } finally {
        await hardenTree(dataDir);
      }
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

function walletNameFromArgs(args: readonly string[]): string | undefined {
  const index = args.indexOf("--wallet");
  return index >= 0 ? args[index + 1] : undefined;
}

function isRecoverableTorGuardStateCorruption(
  result: CommandResult,
): boolean {
  return [result.stdout, result.stderr].some((output) => {
    // Cache deletion is permitted only for Kohaku's two exact adjacent-line
    // signatures. Keep each stream isolated and do not normalize decoration.
    const lines = output.split(/\r?\n/u);
    return lines.some((line, index) => {
      const nextLine = lines[index + 1];
      return (
        line === TOR_GUARD_STATE_CORRUPTION_LINE &&
        nextLine === TOR_CACHE_RECOVERY_HINT
      ) || (
        line === TOR_GUARD_STATE_CORRUPTION_DECORATED_LINE &&
        nextLine === TOR_CACHE_RECOVERY_DECORATED_HINT
      );
    });
  });
}

function isIdempotentKohakuInvocation(args: readonly string[]): boolean {
  if (args.includes("--broadcast")) return false;
  switch (args[0]) {
    case "list-wallets":
    case "balances":
      return true;
    case "next-fresh-address":
      return args.includes("--peek");
    default:
      // Even non-broadcast preparation commands may consume addresses, create
      // notes, or mutate local state. Unknown commands therefore stay single-shot.
      return false;
  }
}

function isRecoverableTornadoRootFailure(result: CommandResult): boolean {
  return [result.stdout, result.stderr].some((output) =>
    output.split(/\r?\n/u).some((line) =>
      TORNADO_STALE_ROOT_LINE_RE.test(line.trim())
    )
  );
}

function isRepairableTornadoPreparation(args: readonly string[]): boolean {
  return args.length === 15 &&
    args[0] === "unshield" &&
    args[1] === "--wallet" &&
    typeof args[2] === "string" &&
    WALLET_NAME_RE.test(args[2]) &&
    args[3] === "--password" &&
    typeof args[4] === "string" &&
    args[5] === "--dataDir" &&
    typeof args[6] === "string" &&
    args[7] === "--non-interactive" &&
    args[8] === "--protocol" &&
    args[9] === "tornado" &&
    args[10] === "--next" &&
    args[11] === "--amount-wei" &&
    typeof args[12] === "string" &&
    DECIMAL_UINT_RE.test(args[12]) &&
    BigInt(args[12]) > 0n &&
    args[13] === "--tail-calls" &&
    typeof args[14] === "string" &&
    args[14].length > 0;
}

function replaceInvocationDataDir(
  args: readonly string[],
  expectedDataDir: string,
  replacementDataDir: string,
): readonly string[] {
  if (!isRepairableTornadoPreparation(args) || args[6] !== expectedDataDir) {
    throw new Error("Kohaku Tornado repair invocation changed unexpectedly");
  }
  const replaced = [...args];
  replaced[6] = replacementDataDir;
  return replaced;
}

async function ensureSecureDirectory(path: string, label: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a directory, not a symlink`);
  }
  await chmod(path, 0o700);
}

function validateWalletName(walletName: string): void {
  if (!WALLET_NAME_RE.test(walletName)) {
    throw new Error(
      "Kohaku wallet name must contain only letters, digits, dot, underscore, or dash",
    );
  }
  if (walletName === "proving-artifacts" || walletName === "public-sync-cache") {
    throw new Error(`Kohaku wallet name is reserved: ${walletName}`);
  }
}

function validateExecutorAddress(address: string): void {
  if (!ETH_ADDRESS_RE.test(address)) {
    throw new Error("Kohaku executor must be an Ethereum address");
  }
}

function validatePrivateBroadcastRequestId(requestId: string): void {
  if (!PRIVATE_BROADCAST_REQUEST_ID_RE.test(requestId)) {
    throw new Error(
      "Private broadcast request ID must be a short opaque identifier",
    );
  }
}

function walletExecutionError(
  error: unknown,
  mayHaveBroadcast: boolean,
): WalletExecutionError {
  const message = error instanceof Error
    ? error.message
    : "Kohaku wallet execution failed";
  return new WalletExecutionError(
    mayHaveBroadcast
      ? "KOHAKU_BROADCAST_OUTCOME_UNKNOWN"
      : "KOHAKU_PREBROADCAST_FAILED",
    message,
    { mayHaveBroadcast, cause: error },
  );
}

function assertExactTornadoDepositAmount(amountWei: bigint): void {
  if (amountWei !== DEFAULT_SHIELD_WEI) {
    throw new Error(
      `Tornado ETH pocket deposits must equal the pinned ${DEFAULT_SHIELD_WEI.toString()} wei denomination`,
    );
  }
}

function validatePreparedTornadoDepositCall(
  value: PreparedTornadoDepositCall,
): PreparedTornadoDepositCall {
  if (!isRecord(value)) {
    throw new Error("Prepared Tornado deposit call must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "data,to,valueWei") {
    throw new Error("Prepared Tornado deposit call has unexpected fields");
  }
  if (
    typeof value.to !== "string" ||
    value.to.toLowerCase() !== SEPOLIA_TORNADO_ETH_0_1_POOL
  ) {
    throw new Error("Prepared Tornado deposit targets an unapproved pool");
  }
  if (
    typeof value.valueWei !== "string" ||
    !DECIMAL_UINT_RE.test(value.valueWei) ||
    BigInt(value.valueWei) !== DEFAULT_SHIELD_WEI
  ) {
    throw new Error("Prepared Tornado deposit has an invalid denomination value");
  }
  if (
    typeof value.data !== "string" ||
    !TORNADO_DEPOSIT_CALL_RE.test(value.data)
  ) {
    throw new Error(
      "Prepared Tornado deposit calldata must be exactly deposit(bytes32)",
    );
  }
  return {
    to: SEPOLIA_TORNADO_ETH_0_1_POOL,
    data: `${TORNADO_DEPOSIT_SELECTOR}${value.data.slice(10).toLowerCase()}`,
    valueWei: DEFAULT_SHIELD_WEI.toString(),
  };
}

function parsePreparedTornadoDeposit(
  stdout: string,
  executorAddress: string,
): {
  targetCommitment: string;
  preparedDepositCall: PreparedTornadoDepositCall;
} {
  const payload = parseJsonObject(stdout, "shield --skip-sim");
  if (payload.calls !== undefined || !Array.isArray(payload.transactions)) {
    throw new Error(
      "Kohaku shield --skip-sim returned an unexpected transaction shape",
    );
  }
  if (payload.transactions.length !== 1) {
    throw new Error(
      "Kohaku shield --skip-sim must return exactly one deposit call",
    );
  }
  const transaction = payload.transactions[0];
  if (!isRecord(transaction)) {
    throw new Error("Kohaku shield --skip-sim returned an invalid transaction");
  }
  const keys = Object.keys(transaction).sort();
  if (keys.join(",") !== "data,from,to,value") {
    throw new Error(
      "Kohaku shield --skip-sim transaction has unexpected fields",
    );
  }
  if (
    typeof transaction.from !== "string" ||
    transaction.from.toLowerCase() !== executorAddress.toLowerCase()
  ) {
    throw new Error(
      "Kohaku shield --skip-sim changed the requested executor address",
    );
  }
  const preparedDepositCall = validatePreparedTornadoDepositCall({
    to: typeof transaction.to === "string" ? transaction.to : "",
    data: typeof transaction.data === "string" ? transaction.data : "",
    valueWei: typeof transaction.value === "string" ? transaction.value : "",
  });
  const match = TORNADO_DEPOSIT_CALL_RE.exec(preparedDepositCall.data);
  if (!match?.[1] || /^0+$/.test(match[1])) {
    throw new Error("Kohaku shield --skip-sim returned an invalid commitment");
  }
  return {
    targetCommitment: `0x${match[1]}`,
    preparedDepositCall,
  };
}

function validateMainDepositPreparation(
  stdout: string,
  executorAddress: string,
  expectedCall: PreparedTornadoDepositCall,
): RawTransactionIntent {
  const payload = parseJsonObject(stdout, "transact-raw prepare");
  if (
    typeof payload.from !== "string" ||
    payload.from.toLowerCase() !== executorAddress.toLowerCase() ||
    payload.calls !== undefined ||
    !Array.isArray(payload.transactions) ||
    payload.transactions.length !== 1
  ) {
    throw new Error("Kohaku transact-raw prepare returned mismatched operation data");
  }
  const transaction = payload.transactions[0];
  if (!isRecord(transaction)) {
    throw new Error("Kohaku transact-raw prepare returned an invalid transaction");
  }
  const keys = Object.keys(transaction).sort();
  if (keys.join(",") !== "data,from,to,value") {
    throw new Error("Kohaku transact-raw prepare transaction has unexpected fields");
  }
  if (
    typeof transaction.from !== "string" ||
    transaction.from.toLowerCase() !== executorAddress.toLowerCase()
  ) {
    throw new Error("Kohaku transact-raw prepare changed the source executor");
  }
  const actualCall = validatePreparedTornadoDepositCall({
    to: typeof transaction.to === "string" ? transaction.to : "",
    data: typeof transaction.data === "string" ? transaction.data : "",
    valueWei: typeof transaction.value === "string" ? transaction.value : "",
  });
  if (
    actualCall.to !== expectedCall.to ||
    actualCall.data !== expectedCall.data ||
    actualCall.valueWei !== expectedCall.valueWei
  ) {
    throw new Error("Kohaku transact-raw prepare changed the target deposit call");
  }
  if (
    !isRecord(payload.fees) ||
    payload.fees.kind !== "network-gas" ||
    payload.fees.asset !== "ETH" ||
    typeof payload.fees.estimatedMax !== "string" ||
    !DECIMAL_UINT_RE.test(payload.fees.estimatedMax) ||
    BigInt(payload.fees.estimatedMax) <= 0n ||
    BigInt(payload.fees.estimatedMax) > TORNADO_DEPOSIT_GAS_RESERVE_WEI
  ) {
    throw new Error("Kohaku transact-raw prepare returned an invalid fee quote");
  }
  return rawTransactionIntent({
    from: executorAddress,
    to: actualCall.to,
    valueWei: actualCall.valueWei,
    data: actualCall.data,
    maxGas: TORNADO_DEPOSIT_MAX_GAS,
    maxFeeWei: TORNADO_DEPOSIT_GAS_RESERVE_WEI,
  });
}

function validateRegularTransferPreparation(input: {
  stdout: string;
  expectedSourceAddress?: string;
  recipient: string;
  amountWei: bigint;
}): RawTransactionIntent {
  const payload = parseJsonObject(input.stdout, "transfer prepare");
  if (
    payload.stealth !== false ||
    payload.recipient !== input.recipient ||
    payload.amount !== input.amountWei.toString() ||
    payload.token !== "eth" ||
    payload.calls !== undefined ||
    !Array.isArray(payload.transactions) ||
    payload.transactions.length !== 1
  ) {
    throw new Error("Kohaku transfer prepare returned mismatched operation data");
  }
  const transaction = payload.transactions[0];
  if (
    !isRecord(transaction) ||
    Object.keys(transaction).sort().join(",") !== "data,from,to,value" ||
    typeof transaction.from !== "string" ||
    !ETH_ADDRESS_RE.test(transaction.from) ||
    (input.expectedSourceAddress !== undefined &&
      transaction.from.toLowerCase() !== input.expectedSourceAddress.toLowerCase()) ||
    typeof transaction.to !== "string" ||
    transaction.to.toLowerCase() !== input.recipient.toLowerCase() ||
    transaction.data !== "0x" ||
    transaction.value !== input.amountWei.toString()
  ) {
    throw new Error("Kohaku transfer prepare changed the exact transfer call");
  }
  if (
    !isRecord(payload.fees) ||
    payload.fees.kind !== "network-gas" ||
    payload.fees.asset !== "ETH" ||
    typeof payload.fees.estimatedMax !== "string" ||
    !DECIMAL_UINT_RE.test(payload.fees.estimatedMax) ||
    BigInt(payload.fees.estimatedMax) <= 0n ||
    BigInt(payload.fees.estimatedMax) > REGULAR_TRANSFER_GAS_RESERVE_WEI
  ) {
    throw new Error("Kohaku transfer prepare returned an invalid fee quote");
  }
  return rawTransactionIntent({
    from: transaction.from,
    to: transaction.to,
    valueWei: transaction.value,
    data: transaction.data,
    maxGas: REGULAR_TRANSFER_MAX_GAS,
    maxFeeWei: REGULAR_TRANSFER_GAS_RESERVE_WEI,
  });
}

function rawTransactionIntent(input: {
  from: string;
  to: string;
  valueWei: string;
  data: string;
  maxGas: bigint;
  maxFeeWei: bigint;
}): RawTransactionIntent {
  return {
    version: 1,
    from: input.from.toLowerCase(),
    to: input.to.toLowerCase(),
    valueWei: input.valueWei,
    data: input.data.toLowerCase(),
    maxGas: input.maxGas.toString(),
    maxFeeWei: input.maxFeeWei.toString(),
  };
}

function validateTornadoRebalanceWithdrawal(
  withdrawalAmountWei: bigint,
  depositValueWei: bigint,
): void {
  if (withdrawalAmountWei <= 0n) {
    throw new Error("Private rebalance withdrawal must be positive");
  }
  if (withdrawalAmountWei % DEFAULT_SHIELD_WEI !== 0n) {
    throw new Error(
      "Private rebalance withdrawal must use whole Tornado denominations",
    );
  }
  if (withdrawalAmountWei <= depositValueWei) {
    throw new Error(
      "Private rebalance needs an additional full denomination for the dynamic paymaster fee",
    );
  }
}

function validatePrivateRebalancePreparation(input: {
  stdout: string;
  executorAddress: string;
  withdrawalAmountWei: bigint;
  preparedDepositCall: PreparedTornadoDepositCall;
}): ValidatedPrivatePreparation {
  const payload = parseUnshieldJsonObject(input.stdout, "unshield prepare");
  const operation = validateTornadoPrivatePreparation({
    payload,
    expectedSender: input.executorAddress,
    expectedAmountWei: input.withdrawalAmountWei,
  });
  const directWithdrawalCount =
    Number(input.withdrawalAmountWei / DEFAULT_SHIELD_WEI) - 1;
  const paddedFeeWei =
    (operation.estimatedFeeWei * TORNADO_TAIL_FEE_PAD_NUMERATOR) /
    TORNADO_TAIL_FEE_PAD_DENOMINATOR;
  if (
    BigInt(input.preparedDepositCall.valueWei) + paddedFeeWei >
    input.withdrawalAmountWei
  ) {
    throw new Error(
      "Private rebalance withdrawal is insufficient for the current padded paymaster fee",
    );
  }
  const callPlan = validatePreparedAccountCalls({
    calls: operation.calls,
    sender: operation.sender,
    sponsorship: operation.sponsorship,
    gasLimits: operation.gasLimits,
    directWithdrawalCount,
    tailCall: {
      target: input.preparedDepositCall.to,
      data: input.preparedDepositCall.data,
      value: BigInt(input.preparedDepositCall.valueWei),
    },
    withdrawalAmountWei: input.withdrawalAmountWei,
    estimatedFeeWei: operation.estimatedFeeWei,
  });
  return {
    sender: operation.sender,
    callPlan,
  };
}

function validatePrivateTailPreparation(input: {
  stdout: string;
  recipient: string;
  amountWei: bigint;
  withdrawalAmountWei: bigint;
}): ValidatedPrivatePreparation {
  const payload = parseUnshieldJsonObject(input.stdout, "unshield prepare");
  if (typeof payload.recipient !== "string") {
    throw new Error("Kohaku unshield prepare returned no private sender");
  }
  const operation = validateTornadoPrivatePreparation({
    payload,
    expectedSender: payload.recipient,
    expectedAmountWei: input.withdrawalAmountWei,
  });
  const callPlan = validatePreparedAccountCalls({
    calls: operation.calls,
    sender: operation.sender,
    sponsorship: operation.sponsorship,
    gasLimits: operation.gasLimits,
    directWithdrawalCount: 0,
    tailCall: {
      target: input.recipient,
      data: "0x",
      value: input.amountWei,
    },
    withdrawalAmountWei: input.withdrawalAmountWei,
    estimatedFeeWei: operation.estimatedFeeWei,
  });
  return {
    sender: operation.sender,
    callPlan,
  };
}

function validateTornadoPrivatePreparation(input: {
  payload: Record<string, unknown>;
  expectedSender: string;
  expectedAmountWei: bigint;
}): {
  sender: string;
  calls: PreparedAccountCall[];
  sponsorship: PreparedPaymasterSponsorship;
  gasLimits: PreparedUserOperationGasLimits;
  estimatedFeeWei: bigint;
} {
  const { payload } = input;
  if (
    payload.mode !== "prepare" ||
    payload.protocol !== "tornado" ||
    payload.token !== "ETH" ||
    payload.amountWei !== input.expectedAmountWei.toString()
  ) {
    throw new Error("Kohaku unshield prepare returned mismatched operation data");
  }
  if (
    typeof payload.recipient !== "string" ||
    !ETH_ADDRESS_RE.test(payload.recipient) ||
    payload.recipient.toLowerCase() !== input.expectedSender.toLowerCase()
  ) {
    throw new Error("Kohaku unshield prepare changed the private sender");
  }
  const estimatedFeeWei = validateTornadoFeeQuote(payload.fees);
  const privateOperation = payload.privateOperation;
  if (
    !isRecord(privateOperation) ||
    privateOperation.__type !== "privateOperation" ||
    !Array.isArray(privateOperation.withdrawals) ||
    privateOperation.withdrawals.length !== 1
  ) {
    throw new Error(
      "Kohaku unshield prepare must contain exactly one private relay operation",
    );
  }
  const withdrawal = privateOperation.withdrawals[0];
  if (
    !isRecord(withdrawal) ||
    withdrawal.mode !== "paymaster" ||
    withdrawal.isERC20 !== false ||
    typeof withdrawal.poolAddress !== "string" ||
    !DECIMAL_UINT_RE.test(withdrawal.poolAddress) ||
    BigInt(withdrawal.poolAddress) !== BigInt(SEPOLIA_TORNADO_ETH_0_1_POOL) ||
    typeof withdrawal.paymasterAddress !== "string" ||
    withdrawal.paymasterAddress.toLowerCase() !== SEPOLIA_TORNADO_PAYMASTER ||
    typeof withdrawal.entryPointAddress !== "string" ||
    withdrawal.entryPointAddress.toLowerCase() !== ENTRY_POINT_V08 ||
    typeof withdrawal.bundlerUrl !== "string" ||
    !isSepoliaPimlicoBundlerUrl(withdrawal.bundlerUrl) ||
    !isRecord(withdrawal.proof)
  ) {
    throw new Error("Kohaku unshield prepare returned an unapproved Sepolia relay");
  }
  const userOperation = validateSerializedPrivateUserOperation(
    withdrawal.userOperation,
    input.expectedSender,
  );
  return {
    sender: userOperation.sender,
    calls: decodePreparedAccountCalls(userOperation.callData),
    sponsorship: userOperation.sponsorship,
    gasLimits: userOperation.gasLimits,
    estimatedFeeWei,
  };
}

function validateTornadoFeeQuote(value: unknown): bigint {
  if (
    !isRecord(value) ||
    value.kind !== "tornado-paymaster" ||
    value.asset !== "ETH" ||
    typeof value.estimatedMax !== "string" ||
    !DECIMAL_UINT_RE.test(value.estimatedMax)
  ) {
    throw new Error("Kohaku unshield prepare returned an invalid fee quote");
  }
  const estimatedFeeWei = BigInt(value.estimatedMax);
  if (estimatedFeeWei <= 0n) {
    throw new Error("Kohaku unshield prepare returned a zero paymaster fee");
  }
  return estimatedFeeWei;
}

function isSepoliaPimlicoBundlerUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const exactPath =
    url.pathname === "/v2/11155111/rpc" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "";
  if (!exactPath) return false;
  return (
    (url.protocol === "https:" &&
      url.hostname === "public.pimlico.io" &&
      url.port === "") ||
    (url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "")
  );
}

function validateSerializedPrivateUserOperation(
  value: unknown,
  expectedSender: string,
): {
  sender: string;
  callData: string;
  sponsorship: PreparedPaymasterSponsorship;
  gasLimits: PreparedUserOperationGasLimits;
} {
  if (!isRecord(value)) {
    throw new Error("Kohaku unshield prepare returned no serialized UserOperation");
  }
  const expectedKeys = [
    "callData",
    "callGasLimit",
    "eip7702Auth",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "nonce",
    "paymaster",
    "paymasterData",
    "paymasterPostOpGasLimit",
    "paymasterVerificationGasLimit",
    "preVerificationGas",
    "sender",
    "signature",
    "verificationGasLimit",
  ].sort();
  if (Object.keys(value).sort().join(",") !== expectedKeys.join(",")) {
    throw new Error("Kohaku unshield prepare returned unexpected UserOperation fields");
  }
  if (
    typeof value.sender !== "string" ||
    !ETH_ADDRESS_RE.test(value.sender) ||
    value.sender.toLowerCase() !== expectedSender.toLowerCase() ||
    typeof value.paymaster !== "string" ||
    value.paymaster.toLowerCase() !== SEPOLIA_TORNADO_PAYMASTER ||
    typeof value.callData !== "string" ||
    !HEX_BYTES_RE.test(value.callData) ||
    value.callData === "0x" ||
    typeof value.paymasterData !== "string" ||
    !HEX_BYTES_RE.test(value.paymasterData) ||
    value.paymasterData === "0x" ||
    typeof value.signature !== "string" ||
    !SIGNATURE_RE.test(value.signature)
  ) {
    throw new Error("Kohaku unshield prepare returned a malformed UserOperation");
  }
  if (parseHexQuantity(value.nonce, "nonce") !== 0n) {
    throw new Error("Kohaku unshield prepare returned a nonzero UserOperation nonce");
  }
  const gasLimits: PreparedUserOperationGasLimits = {
    callGasLimit: parseHexQuantity(value.callGasLimit, "call gas"),
    verificationGasLimit: parseHexQuantity(
      value.verificationGasLimit,
      "verification gas",
    ),
    preVerificationGas: parseHexQuantity(
      value.preVerificationGas,
      "pre-verification gas",
    ),
    paymasterVerificationGasLimit: parseHexQuantity(
      value.paymasterVerificationGasLimit,
      "paymaster verification gas",
    ),
    paymasterPostOpGasLimit: parseHexQuantity(
      value.paymasterPostOpGasLimit,
      "paymaster post-op gas",
    ),
  };
  if (Object.values(gasLimits).some((limit) => limit <= 0n)) {
    throw new Error("Kohaku unshield prepare returned a zero gas limit");
  }
  const maxFeePerGas = parseHexQuantity(value.maxFeePerGas, "max fee");
  const maxPriorityFeePerGas = parseHexQuantity(
    value.maxPriorityFeePerGas,
    "priority fee",
  );
  if (
    maxFeePerGas <= 0n ||
    maxPriorityFeePerGas <= 0n ||
    maxPriorityFeePerGas > maxFeePerGas
  ) {
    throw new Error("Kohaku unshield prepare returned invalid gas pricing");
  }
  const authorization = value.eip7702Auth;
  if (
    !isRecord(authorization) ||
    Object.keys(authorization).sort().join(",") !==
      "address,chainId,nonce,r,s,yParity" ||
    typeof authorization.address !== "string" ||
    authorization.address.toLowerCase() !== SIMPLE_7702_IMPLEMENTATION ||
    authorization.chainId !== "0xaa36a7" ||
    authorization.nonce !== "0x0" ||
    typeof authorization.r !== "string" ||
    !BYTES32_RE.test(authorization.r) ||
    typeof authorization.s !== "string" ||
    !BYTES32_RE.test(authorization.s) ||
    !["0x0", "0x1", "0x00", "0x01"].includes(
      typeof authorization.yParity === "string" ? authorization.yParity : "",
    )
  ) {
    throw new Error("Kohaku unshield prepare returned invalid EIP-7702 authority");
  }
  const sender = value.sender.toLowerCase();
  return {
    sender,
    callData: value.callData,
    sponsorship: decodePreparedPaymasterSponsorship(
      value.paymasterData,
      sender,
    ),
    gasLimits,
  };
}

function decodePreparedPaymasterSponsorship(
  paymasterData: string,
  sender: string,
): PreparedPaymasterSponsorship {
  try {
    const [{ adapter: adapterAddress, adapterData }] = AbiParameters.decode(
      PAYMASTER_DATA_PARAMETERS,
      paymasterData as `0x${string}`,
    );
    const [{ proof, root, nullifierHash, recipient, relayer, fee, refund }] =
      AbiParameters.decode(TORNADO_SPONSOR_PARAMETERS, adapterData);
    if (
      AbiParameters.encode(PAYMASTER_DATA_PARAMETERS, [{
        adapter: adapterAddress,
        adapterData,
      }]).toLowerCase() !== paymasterData.toLowerCase() ||
      AbiParameters.encode(TORNADO_SPONSOR_PARAMETERS, [{
        proof,
        root,
        nullifierHash,
        recipient,
        relayer,
        fee,
        refund,
      }]).toLowerCase() !== adapterData.toLowerCase() ||
      adapterAddress.toLowerCase() !== SEPOLIA_TORNADO_ETH_0_1_ADAPTER ||
      proof === "0x" ||
      !BYTES32_RE.test(root) ||
      !BYTES32_RE.test(nullifierHash) ||
      /^0x0{64}$/u.test(nullifierHash) ||
      recipient.toLowerCase() !== sender.toLowerCase() ||
      relayer.toLowerCase() !== SEPOLIA_TORNADO_PAYMASTER ||
      fee <= 0n ||
      refund !== 0n
    ) {
      throw new Error("Prepared paymaster sponsorship changed");
    }
    return {
      adapterAddress: adapterAddress.toLowerCase(),
      nullifierHash: nullifierHash.toLowerCase(),
      feeWei: fee,
    };
  } catch (error) {
    throw new Error(
      "Kohaku unshield prepare returned invalid paymaster sponsorship data",
      { cause: error },
    );
  }
}

function parseHexQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !HEX_QUANTITY_RE.test(value)) {
    throw new Error(`Kohaku unshield prepare returned malformed ${label}`);
  }
  return BigInt(value);
}

function decodePreparedAccountCalls(callData: string): PreparedAccountCall[] {
  try {
    if (callData.slice(0, 10).toLowerCase() === TORNADO_WITHDRAW_SELECTOR) {
      throw new Error("Tornado withdrawal cannot be the account entry call");
    }
    if (
      callData.slice(0, 10).toLowerCase() ===
      AbiFunction.getSelector(EXECUTE_FUNCTION)
    ) {
      const [target, value, data] = AbiFunction.decodeData(
        EXECUTE_FUNCTION,
        callData as `0x${string}`,
      );
      return [{ target: target.toLowerCase(), value, data: data.toLowerCase() }];
    }
    if (
      callData.slice(0, 10).toLowerCase() ===
      AbiFunction.getSelector(EXECUTE_BATCH_FUNCTION)
    ) {
      const [calls] = AbiFunction.decodeData(
        EXECUTE_BATCH_FUNCTION,
        callData as `0x${string}`,
      );
      return calls.map((call) => ({
        target: call.target.toLowerCase(),
        value: call.value,
        data: call.data.toLowerCase(),
      }));
    }
  } catch (error) {
    throw new Error("Kohaku unshield prepare returned invalid account calldata", {
      cause: error,
    });
  }
  throw new Error("Kohaku unshield prepare returned an unapproved account call");
}

function validatePreparedAccountCalls(input: {
  calls: readonly PreparedAccountCall[];
  sender: string;
  sponsorship: PreparedPaymasterSponsorship;
  gasLimits: PreparedUserOperationGasLimits;
  directWithdrawalCount: number;
  tailCall: PreparedAccountCall;
  withdrawalAmountWei: bigint;
  estimatedFeeWei: bigint;
}): PrivateBroadcastCallPlan {
  const minimumCalls = input.directWithdrawalCount + 1;
  if (
    input.calls.length < minimumCalls ||
    input.calls.length > minimumCalls + 1
  ) {
    throw new Error("Kohaku unshield prepare changed the exact tail-call plan");
  }
  const directWithdrawals = Array.from(
    { length: input.directWithdrawalCount },
    (_, index) =>
      validateDirectTornadoWithdrawal(input.calls[index], input.sender),
  );
  if (directWithdrawals.some(
    (withdrawal) => withdrawal.nullifierHash === input.sponsorship.nullifierHash,
  )) {
    throw new Error(
      "Kohaku unshield prepare reused its sponsored Tornado nullifier",
    );
  }
  const remainder = input.calls.slice(input.directWithdrawalCount);
  const tail = remainder.at(-1);
  if (
    !tail ||
    tail.target !== input.tailCall.target.toLowerCase() ||
    tail.value !== input.tailCall.value ||
    tail.data !== input.tailCall.data.toLowerCase()
  ) {
    throw new Error("Kohaku unshield prepare changed the requested tail call");
  }
  let privateChange: PreparedAccountCall | undefined;
  if (remainder.length === 2) {
    const change = remainder[0];
    if (
      !change ||
      change.target !== input.sender.toLowerCase() ||
      change.data !== "0x" ||
      change.value <= 0n
    ) {
      throw new Error("Kohaku unshield prepare changed the private change call");
    }
    privateChange = change;
  }
  const paddedFeeWei =
    (input.estimatedFeeWei * TORNADO_TAIL_FEE_PAD_NUMERATOR) /
    TORNADO_TAIL_FEE_PAD_DENOMINATOR;
  const sentValueWei = input.calls.reduce((sum, call) => sum + call.value, 0n);
  if (sentValueWei + paddedFeeWei !== input.withdrawalAmountWei) {
    throw new Error(
      "Kohaku unshield prepare reserved an unexpected padded paymaster fee",
    );
  }
  // Kohaku's private-change CALL returns value to the same 7702 sender. It is
  // balance-neutral, but both it and the immutable tail must each be fundable.
  const largestRequiredBalanceWei = privateChange !== undefined &&
      privateChange.value > input.tailCall.value
    ? privateChange.value
    : input.tailCall.value;
  const availableFeeReserveWei =
    input.withdrawalAmountWei - largestRequiredBalanceWei;
  const maxFeeReserveWei = availableFeeReserveWei <
      MAX_PRIVATE_PAYMASTER_FEE_RESERVE_WEI
    ? availableFeeReserveWei
    : MAX_PRIVATE_PAYMASTER_FEE_RESERVE_WEI;
  if (paddedFeeWei > maxFeeReserveWei) {
    throw new Error(
      "Kohaku unshield prepare exceeded the private paymaster fee cap",
    );
  }
  if (input.sponsorship.feeWei > maxFeeReserveWei) {
    throw new Error(
      "Kohaku unshield prepare sponsorship fee exceeded its safe cap",
    );
  }
  return {
    version: 1,
    withdrawalAmountWei: input.withdrawalAmountWei.toString(),
    maxFeeReserveWei: maxFeeReserveWei.toString(),
    gasFloors: {
      callGasLimit: input.gasLimits.callGasLimit.toString(),
      // A low account/paymaster validation cap reverts the whole operation,
      // including sponsor-note collection. These remain positive-only rather
      // than rejecting legitimate estimate jitter. preVerificationGas is also
      // positive-only: EntryPoint v0.8 adds it equally to required prefund and
      // charged gas, so it cancels from the post-validation low-prefund check.
      verificationGasLimit: "1",
      preVerificationGas: "1",
      paymasterVerificationGasLimit: "1",
      paymasterPostOpGasLimit:
        input.gasLimits.paymasterPostOpGasLimit.toString(),
    },
    directWithdrawals,
    sponsor: {
      adapterAddress: input.sponsorship.adapterAddress,
      nullifierHash: input.sponsorship.nullifierHash,
    },
    tailCall: {
      target: input.tailCall.target.toLowerCase(),
      data: input.tailCall.data.toLowerCase(),
      valueWei: input.tailCall.value.toString(),
    },
  };
}

function validateDirectTornadoWithdrawal(
  call: PreparedAccountCall | undefined,
  sender: string,
): { poolAddress: string; nullifierHash: string } {
  if (
    !call ||
    call.target !== SEPOLIA_TORNADO_ETH_0_1_POOL ||
    call.value !== 0n ||
    call.data.slice(0, 10) !== TORNADO_WITHDRAW_SELECTOR
  ) {
    throw new Error("Kohaku unshield prepare changed a direct Tornado withdrawal");
  }
  try {
    const [proof, root, nullifierHash, recipient, relayer, fee, refund] =
      AbiFunction.decodeData(
        TORNADO_WITHDRAW_FUNCTION,
        call.data as `0x${string}`,
      );
    if (
      proof === "0x" ||
      !BYTES32_RE.test(root) ||
      !BYTES32_RE.test(nullifierHash) ||
      recipient.toLowerCase() !== sender.toLowerCase() ||
      relayer.toLowerCase() !==
        "0x0000000000000000000000000000000000000000" ||
      fee !== 0n ||
      refund !== 0n
    ) {
      throw new Error("Direct Tornado withdrawal arguments changed");
    }
    return {
      poolAddress: call.target,
      nullifierHash: nullifierHash.toLowerCase(),
    };
  } catch (error) {
    throw new Error("Kohaku unshield prepare returned invalid Tornado calldata", {
      cause: error,
    });
  }
}

function parseRpcUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Kohaku RPC URL must be a valid URL");
  }
  if (parsed.protocol === "https:") return parsed.toString();
  const isPrivateLoopbackRelay =
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    parsed.port !== "" &&
    /^\/rpc\/[A-Za-z0-9_-]{43}$/u.test(parsed.pathname) &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "";
  if (!isPrivateLoopbackRelay) {
    throw new Error(
      "Kohaku RPC URL must use HTTPS or an authenticated Agent Boost loopback relay",
    );
  }
  return parsed.toString();
}

function relayToken(rpcUrl: string): string | undefined {
  const parsed = new URL(rpcUrl);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    return undefined;
  }
  return parsed.pathname.split("/").at(-1);
}

async function redactRelayTokenFromTrafficLog(
  dataDir: string,
  walletName: string,
  token: string | undefined,
): Promise<void> {
  if (!token) return;
  const path = resolve(dataDir, walletName, "network-traffic.ndjson");
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Kohaku network traffic log must be a regular file");
  }
  const contents = await readFile(path, "utf8");
  if (!contents.includes(token)) return;
  await writeFile(path, contents.replaceAll(token, "<redacted>"), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUnshieldJsonObject(
  stdout: string,
  command: string,
): Record<string, unknown> {
  const json = stdout.replace(
    /^(?:Merkle tree for [0-9]{1,10} leaves took [0-9]{1,10}ms\r?\n){1,16}/u,
    "",
  );
  return parseJsonObject(json, command);
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

function parsePrivateBroadcastCheckpoint(
  contents: string,
  expectedRequestId: string,
): PrivateBroadcastCheckpoint {
  const payload = parseJsonObject(contents, "private broadcast checkpoint");
  const keys = Object.keys(payload).sort();
  if (
    keys.join(",") !==
    "entryPointAddress,journaledAt,requestId,sender,userOperationHash,version"
  ) {
    throw new Error("Private broadcast checkpoint has unexpected fields");
  }
  if (
    payload.version !== 1 ||
    payload.requestId !== expectedRequestId ||
    typeof payload.userOperationHash !== "string" ||
    !TX_HASH_RE.test(payload.userOperationHash) ||
    typeof payload.sender !== "string" ||
    !ETH_ADDRESS_RE.test(payload.sender) ||
    payload.sender !== payload.sender.toLowerCase() ||
    typeof payload.entryPointAddress !== "string" ||
    payload.entryPointAddress !== ENTRY_POINT_V08 ||
    typeof payload.journaledAt !== "string" ||
    !isCanonicalIsoTimestamp(payload.journaledAt)
  ) {
    throw new Error("Private broadcast checkpoint is invalid");
  }
  return {
    version: 1,
    requestId: payload.requestId,
    userOperationHash: payload.userOperationHash.toLowerCase(),
    sender: payload.sender,
    entryPointAddress: ENTRY_POINT_V08,
    journaledAt: payload.journaledAt,
  };
}

function parseRawTransactionBroadcastCheckpoint(
  contents: string,
  expectedRequestId: string,
): RawTransactionBroadcastCheckpoint {
  const payload = parseJsonObject(contents, "raw transaction checkpoint");
  const keys = Object.keys(payload).sort();
  if (
    keys.join(",") !==
    "chainId,data,from,gas,journaledAt,nonce,requestId,to,transactionHash,transactionType,valueWei,version"
  ) {
    throw new Error("Raw transaction checkpoint has unexpected fields");
  }
  if (
    payload.version !== 1 ||
    payload.requestId !== expectedRequestId ||
    typeof payload.transactionHash !== "string" ||
    !TX_HASH_RE.test(payload.transactionHash) ||
    typeof payload.from !== "string" ||
    !ETH_ADDRESS_RE.test(payload.from) ||
    payload.from !== payload.from.toLowerCase() ||
    typeof payload.to !== "string" ||
    !ETH_ADDRESS_RE.test(payload.to) ||
    payload.to !== payload.to.toLowerCase() ||
    typeof payload.valueWei !== "string" ||
    !DECIMAL_UINT_RE.test(payload.valueWei) ||
    typeof payload.data !== "string" ||
    !HEX_BYTES_RE.test(payload.data) ||
    payload.data !== payload.data.toLowerCase() ||
    payload.chainId !== 11_155_111 ||
    typeof payload.nonce !== "string" ||
    !DECIMAL_UINT_RE.test(payload.nonce) ||
    typeof payload.gas !== "string" ||
    !DECIMAL_UINT_RE.test(payload.gas) ||
    BigInt(payload.gas) <= 0n ||
    !["legacy", "eip2930", "eip1559"].includes(
      typeof payload.transactionType === "string"
        ? payload.transactionType
        : "",
    ) ||
    typeof payload.journaledAt !== "string" ||
    !isCanonicalIsoTimestamp(payload.journaledAt)
  ) {
    throw new Error("Raw transaction checkpoint is invalid");
  }
  return {
    version: 1,
    requestId: payload.requestId,
    transactionHash: payload.transactionHash.toLowerCase(),
    from: payload.from,
    to: payload.to,
    valueWei: payload.valueWei,
    data: payload.data,
    chainId: 11_155_111,
    nonce: payload.nonce,
    gas: payload.gas,
    transactionType: payload.transactionType as
      | "legacy"
      | "eip2930"
      | "eip1559",
    journaledAt: payload.journaledAt,
  };
}

function assertRawTransactionCheckpointIntent(
  checkpoint: RawTransactionBroadcastCheckpoint,
  expected: RawTransactionIntent,
): void {
  if (
    checkpoint.from !== expected.from ||
    checkpoint.to !== expected.to ||
    checkpoint.valueWei !== expected.valueWei ||
    checkpoint.data !== expected.data ||
    BigInt(checkpoint.gas) > BigInt(expected.maxGas)
  ) {
    throw new Error(
      "Raw transaction checkpoint changed the approved transaction intent",
    );
  }
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function optionalTransactionHash(stdout: string): { transactionHash?: string } {
  const payload = parseJsonObject(stdout, "broadcast");
  const transactionHash = findHashForKeys(payload, [
    "transactionHash",
    "txHash",
    "bundleTxHash",
    "hash",
    "hashes",
  ]);
  return transactionHash ? { transactionHash } : {};
}

function optionalPaymentIdentifiers(stdout: string): {
  transactionHash?: string;
  userOperationHash?: string;
} {
  const payload = parseUnshieldJsonObject(stdout, "broadcast");
  const transactionHash = findHashForKeys(payload, [
    "transactionHash",
    "txHash",
    "bundleTxHash",
  ]);
  const userOperationHash = findHashForKeys(payload, [
    "userOperationHash",
    "userOpHash",
  ]);
  return {
    ...(transactionHash ? { transactionHash } : {}),
    ...(userOperationHash ? { userOperationHash } : {}),
  };
}

function findHashForKeys(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && TX_HASH_RE.test(candidate)) {
      return candidate;
    }
    if (Array.isArray(candidate)) {
      const hash = candidate.find(
        (entry): entry is string => typeof entry === "string" && TX_HASH_RE.test(entry),
      );
      if (hash) return hash;
    }
  }
  for (const candidate of Object.values(value)) {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const nested = findHashForKeys(entry, keys);
        if (nested) return nested;
      }
    } else {
      const nested = findHashForKeys(candidate, keys);
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
