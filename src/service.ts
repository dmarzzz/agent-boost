import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentBoostConfig } from "./config.js";
import type {
  ChainClient,
  OnboardingRecord,
  PaymentPlan,
  PaymentRequest,
  PublicOnboardingSnapshot,
  WalletAdapter,
} from "./contracts.js";
import { KohakuWalletAdapter } from "./kohaku/index.js";
import type { AgentBoostRuntime } from "./mcp.js";
import { OnboardingController } from "./onboarding.js";
import { PaymentController } from "./payment.js";
import { SepoliaRpcClient } from "./rpc/index.js";
import { StateStore } from "./state/store.js";
import { RuntimeLock } from "./state/runtime-lock.js";
import {
  generateFundingQrPng,
  OnboardingUiServer,
  openVisibleBrowser,
} from "./ui/index.js";

export interface RuntimeDependencies {
  wallet?: WalletAdapter;
  chain?: ChainClient;
  openBrowser?: (url: string) => Promise<boolean>;
}

export class LocalAgentBoostRuntime implements AgentBoostRuntime {
  readonly #config: AgentBoostConfig;
  readonly #store: StateStore;
  readonly #runtimeLock = new RuntimeLock();
  readonly #wallet: WalletAdapter;
  readonly #chain: ChainClient;
  readonly #onboarding: OnboardingController;
  readonly #payments: PaymentController;
  readonly #ui: OnboardingUiServer;
  readonly #openBrowser: (url: string) => Promise<boolean>;

  constructor(config: AgentBoostConfig, dependencies: RuntimeDependencies = {}) {
    this.#config = config;
    this.#store = new StateStore(config.stateDir);
    this.#wallet =
      dependencies.wallet ??
      new KohakuWalletAdapter({
        dataDir: config.kohakuDataDir,
        walletName: config.kohakuWalletName,
        passwordFile: config.kohakuPasswordFile,
        rpcUrl: config.rpcUrl,
        executable: config.kohakuBin,
        tornadoWithdrawalWei: config.shieldAmountWei,
      });
    this.#chain = dependencies.chain ?? new SepoliaRpcClient(config.rpcUrl);
    this.#onboarding = new OnboardingController({
      store: this.#store,
      wallet: this.#wallet,
      chain: this.#chain,
      config,
    });
    this.#payments = new PaymentController({
      store: this.#store,
      wallet: this.#wallet,
      chain: this.#chain,
      executeEnabled: config.executeEnabled,
      executionLimitWei: config.paymentLimitWei,
    });
    this.#ui = new OnboardingUiServer({
      getSnapshot: () => this.#onboarding.getPublicSnapshot(),
      host: config.uiHost,
      port: config.uiPort,
    });
    this.#openBrowser = dependencies.openBrowser ?? openVisibleBrowser;
  }

  async initialize(): Promise<void> {
    await this.#runtimeLock.acquire();
    try {
      await ensurePasswordFile(this.#config.kohakuPasswordFile);
      await this.#store.initialize();
      await this.#payments.recoverInterruptedRequests();
      await this.#onboarding.resume();
    } catch (error) {
      await this.#runtimeLock.release();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([this.#onboarding.stop(), this.#ui.stop()]);
    await this.#runtimeLock.release();
  }

  async capabilities(): Promise<Record<string, unknown>> {
    const state = await this.#store.read();
    const setup = state.onboarding;
    return {
      contract: "org.agentboost.wallet/1.0",
      chain_id: "eip155:11155111",
      network_name: "Sepolia",
      asset_type: "eip155:11155111/slip44:60",
      funding_target_atomic: this.#config.fundingTargetWei.toString(),
      privacy_protocol: "tornado",
      private_payment_operation: "unshield_next_tail_call",
      authority: {
        mode: "testnet_delegated",
        can_cause_signing: true,
        mainnet_available: false,
        per_payment_limit_atomic: this.#config.paymentLimitWei.toString(),
        lifetime_limit_atomic: this.#config.paymentLimitWei.toString(),
        max_payments: 1,
        requires_exact_verbal_confirmation: true,
      },
      privacy: {
        claim: "privacy-improving shielded Sepolia test payment",
        hides_direct_deposit_withdrawal_link: true,
        guarantees_anonymity: false,
        rpc_egress_private: false,
        funding_source_private: false,
        limitations: [
          "funding source and amount remain public",
          "Ethereum RPC metadata remains visible until private egress is added",
          "timing and the Sepolia anonymity set can enable correlation",
          "the wallet is disposable and has no recovery UX",
        ],
      },
      adapters: {
        wallet: {
          name: "kohaku",
          compatible_commit: KohakuWalletAdapter.compatibleCommit,
        },
        egress: { name: "shade-tree", available: false, stage: "next" },
      },
      readiness: {
        phase: setup?.phase ?? "not_started",
        wallet_ready: setup?.phase === "private_ready",
        address_ready: setup?.address !== undefined,
        egress_ready: false,
      },
    };
  }

  async startOnboarding(): Promise<{
    record: OnboardingRecord;
    snapshot: PublicOnboardingSnapshot;
    uiOpened: boolean;
    qrPngBase64?: string;
  }> {
    let record = await this.#onboarding.start();
    let uiUrl: string | undefined;
    let uiOpened = false;
    try {
      uiUrl = (await this.#ui.start()).url;
      if (this.#config.autoOpenUi) uiOpened = await this.#openBrowser(uiUrl);
    } catch {
      // Headless and port-conflict fallbacks still return the QR through MCP.
    }

    if (uiUrl) {
      const state = await this.#store.update((draft) => {
        if (!draft.onboarding || draft.onboarding.setupId !== record.setupId) return;
        draft.onboarding.uiUrl = uiUrl;
        draft.onboarding.uiOpened = uiOpened;
        draft.onboarding.revision += 1;
        draft.onboarding.updatedAt = new Date().toISOString();
      });
      record = state.onboarding as OnboardingRecord;
    }
    const snapshot = await this.#onboarding.getPublicSnapshot();
    const remaining =
      BigInt(snapshot.requiredFundingWei) - BigInt(snapshot.publicBalanceWei);
    const qrPngBase64 =
      snapshot.address && remaining > 0n
        ? (await generateFundingQrPng(snapshot.address, remaining.toString())).toString(
            "base64",
          )
        : undefined;
    return {
      record,
      snapshot,
      uiOpened,
      ...(qrPngBase64 ? { qrPngBase64 } : {}),
    };
  }

  onboardingStatus(input: {
    setupId: string;
    sinceRevision?: number;
    waitMs?: number;
  }): Promise<OnboardingRecord> {
    return this.#onboarding.status(input);
  }

  async walletContext(): Promise<Record<string, unknown>> {
    let record = await this.#onboarding.getRecord();
    let publicWalletTotal = BigInt(record.publicBalanceWei);
    if (record.address) {
      const [fundingAddressBalance, walletBalances] = await Promise.all([
        this.#chain.getBalanceWei(record.address),
        record.phase === "private_ready"
          ? this.#wallet.getBalanceSnapshot
            ? this.#wallet.getBalanceSnapshot()
            : this.#wallet.getPrivateBalanceWei().then((privateBalanceWei) => ({
                publicBalanceWei: fundingAddressBalanceFallback(record),
                privateBalanceWei,
              }))
          : Promise.resolve({
              publicBalanceWei: fundingAddressBalanceFallback(record),
              privateBalanceWei: BigInt(record.privateBalanceWei),
            }),
      ]);
      publicWalletTotal = walletBalances.publicBalanceWei;
      const privateBalance = walletBalances.privateBalanceWei;
      const state = await this.#store.update((draft) => {
        if (!draft.onboarding || draft.onboarding.setupId !== record.setupId) return;
        const changed =
          draft.onboarding.publicBalanceWei !== fundingAddressBalance.toString() ||
          draft.onboarding.privateBalanceWei !== privateBalance.toString();
        if (!changed) return;
        draft.onboarding.publicBalanceWei = fundingAddressBalance.toString();
        draft.onboarding.privateBalanceWei = privateBalance.toString();
        draft.onboarding.revision += 1;
        draft.onboarding.updatedAt = new Date().toISOString();
      });
      record = state.onboarding as OnboardingRecord;
    }
    return {
      chain_id: "eip155:11155111",
      account_id: record.address
        ? `eip155:11155111:${record.address}`
        : undefined,
      address: record.address,
      setup_phase: record.phase,
      balances: {
        funding_address_eth_atomic: record.publicBalanceWei,
        public_wallet_total_atomic: publicWalletTotal.toString(),
        private_payment_spendable_atomic: record.privateBalanceWei,
      },
      delegation: record.delegation,
      freshness: { observed_at: record.updatedAt, revision: record.revision },
      egress_privacy: false,
    };
  }

  planPrivatePayment(input: {
    recipient: string;
    amountWei: string;
  }): Promise<PaymentPlan> {
    return this.#payments.plan(input);
  }

  executePrivatePayment(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<PaymentRequest> {
    return this.#payments.execute(input);
  }

  getRequest(requestId: string): Promise<PaymentRequest> {
    return this.#payments.getRequest(requestId);
  }

  async status(): Promise<Record<string, unknown>> {
    const state = await this.#store.read();
    return {
      state_path: this.#store.path,
      onboarding: state.onboarding,
      requests: Object.values(state.requests),
    };
  }
}

function fundingAddressBalanceFallback(record: OnboardingRecord): bigint {
  return BigInt(record.publicBalanceWei);
}

export async function createLocalRuntime(
  config: AgentBoostConfig,
  dependencies: RuntimeDependencies = {},
): Promise<LocalAgentBoostRuntime> {
  const runtime = new LocalAgentBoostRuntime(config, dependencies);
  await runtime.initialize();
  return runtime;
}

async function ensurePasswordFile(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Kohaku password path must be a regular file, not a symlink");
    }
    await realpath(path);
    await chmod(path, 0o600);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}
