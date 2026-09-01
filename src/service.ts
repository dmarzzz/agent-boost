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
  TorRpcProxy,
  TorRpcRoute,
  type TorRpcProxyPort,
  type TorRpcRoutePort,
} from "./tor/index.js";
import {
  generateFundingQrPng,
  OnboardingUiServer,
  openVisibleBrowser,
} from "./ui/index.js";

export interface RuntimeDependencies {
  wallet?: WalletAdapter;
  chain?: ChainClient;
  rpcRoute?: TorRpcRoutePort;
  rpcProxy?: TorRpcProxyPort;
  openBrowser?: (url: string) => Promise<boolean>;
}

export class LocalAgentBoostRuntime implements AgentBoostRuntime {
  readonly #config: AgentBoostConfig;
  readonly #store: StateStore;
  readonly #runtimeLock = new RuntimeLock();
  readonly #rpcRoute: TorRpcRoutePort | undefined;
  readonly #rpcProxy: TorRpcProxyPort | undefined;
  readonly #wallet: WalletAdapter;
  readonly #chain: ChainClient;
  readonly #onboarding: OnboardingController;
  readonly #payments: PaymentController;
  readonly #ui: OnboardingUiServer;
  readonly #openBrowser: (url: string) => Promise<boolean>;

  constructor(config: AgentBoostConfig, dependencies: RuntimeDependencies = {}) {
    this.#config = config;
    this.#store = new StateStore(config.stateDir);
    const needsRpcRoute =
      dependencies.rpcRoute !== undefined ||
      dependencies.wallet === undefined ||
      dependencies.chain === undefined;
    this.#rpcRoute = needsRpcRoute
      ? dependencies.rpcRoute ??
        new TorRpcRoute({
          rpcUrl: config.rpcUrl,
          dataDir: config.torDataDir,
          bootstrapTimeoutMs: config.torBootstrapTimeoutMs,
        })
      : undefined;
    this.#rpcProxy = dependencies.wallet === undefined
      ? dependencies.rpcProxy ??
        new TorRpcProxy({
          upstreamUrl: config.rpcUrl,
          fetch: requiredRpcRoute(this.#rpcRoute).fetchRpc,
          port: config.torRpcPort,
        })
      : dependencies.rpcProxy;
    this.#wallet =
      dependencies.wallet ??
      new KohakuWalletAdapter({
        dataDir: config.kohakuDataDir,
        walletName: config.kohakuWalletName,
        passwordFile: config.kohakuPasswordFile,
        rpcUrl: requiredRpcProxy(this.#rpcProxy).url,
        executable: config.kohakuBin,
        tornadoWithdrawalWei: config.shieldAmountWei,
      });
    this.#chain =
      dependencies.chain ??
      new SepoliaRpcClient({
        rpcUrl: config.rpcUrl,
        fetch: requiredRpcRoute(this.#rpcRoute).fetchRpc,
      });
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
      getSnapshot: () => this.#getPublicSnapshot(),
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
      if (this.#rpcRoute) {
        await this.#rpcRoute.ready();
        await this.#chain.assertSepolia();
      }
      await this.#rpcProxy?.start();
      await this.#payments.recoverInterruptedRequests();
      await this.#onboarding.resume();
    } catch (error) {
      await this.#rpcProxy?.stop().catch(() => undefined);
      await this.#rpcRoute?.close().catch(() => undefined);
      await this.#runtimeLock.release();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([
      this.#onboarding.stop(),
      this.#payments.stop(),
      this.#ui.stop(),
    ]);
    await this.#rpcProxy?.stop().catch(() => undefined);
    await this.#rpcRoute?.close().catch(() => undefined);
    await this.#runtimeLock.release();
  }

  async capabilities(): Promise<Record<string, unknown>> {
    const state = await this.#store.read();
    const setup = state.onboarding;
    return {
      contract: "org.agentboost.wallet/1.1",
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
        rpc_egress: {
          mode: "tor",
          scope: "ethereum_json_rpc",
          covers: ["agent_boost", "kohaku"],
          dns_resolution: "tor_exit",
          direct_fallback: false,
          hides_origin_ip_from_rpc_provider: true,
          hides_rpc_activity_from_provider: false,
        },
        general_agent_egress_private: false,
        funding_source_private: false,
        limitations: [
          "funding source and amount remain public",
          "the RPC provider still sees methods, addresses, payloads, and timing",
          "Hermes and other agent traffic are not routed through Tor",
          "timing and the Sepolia anonymity set can enable correlation",
          "the wallet is disposable and has no recovery UX",
        ],
      },
      adapters: {
        wallet: {
          name: "kohaku",
          compatible_commit: KohakuWalletAdapter.compatibleCommit,
        },
        rpc_egress: {
          name: "tor-js",
          available: true,
          scope: "ethereum_json_rpc",
          direct_fallback: false,
        },
        general_egress: { name: "shade-tree", available: false, stage: "next" },
      },
      readiness: {
        phase: setup?.phase ?? "not_started",
        wallet_ready: setup?.phase === "private_ready",
        address_ready: setup?.address !== undefined,
        rpc_egress: this.#rpcRoute?.status ?? "ready",
        general_egress_ready: false,
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
    const snapshot = await this.#getPublicSnapshot();
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
      rpc_route: {
        mode: "tor",
        scope: "ethereum_json_rpc",
        status: this.#rpcRoute?.status ?? "ready",
        direct_fallback: false,
      },
      general_egress_privacy: false,
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
      rpc_route: {
        mode: "tor",
        scope: "ethereum_json_rpc",
        status: this.#rpcRoute?.status ?? "ready",
        direct_fallback: false,
      },
    };
  }

  async #getPublicSnapshot(): Promise<PublicOnboardingSnapshot> {
    return {
      ...(await this.#onboarding.getPublicSnapshot()),
      rpcRoute: {
        mode: "tor",
        scope: "ethereum_json_rpc",
        status: this.#rpcRoute?.status ?? "ready",
        directFallback: false,
      },
    };
  }
}

function fundingAddressBalanceFallback(record: OnboardingRecord): bigint {
  return BigInt(record.publicBalanceWei);
}

function requiredRpcRoute(route: TorRpcRoutePort | undefined): TorRpcRoutePort {
  if (!route) throw new Error("Tor RPC route is required");
  return route;
}

function requiredRpcProxy(proxy: TorRpcProxyPort | undefined): TorRpcProxyPort {
  if (!proxy) throw new Error("Tor RPC proxy is required");
  return proxy;
}

export async function createLocalRuntime(
  config: AgentBoostConfig,
  dependencies: RuntimeDependencies = {},
): Promise<LocalAgentBoostRuntime> {
  const runtime = new LocalAgentBoostRuntime(config, dependencies);
  await runtime.initialize();
  return runtime;
}

/**
 * Read the atomic public workflow projection without acquiring wallet
 * authority. This remains available while the Hermes MCP process owns the
 * runtime lock and never resumes or invokes a wallet operation.
 */
export async function readLocalStatus(
  config: AgentBoostConfig,
): Promise<Record<string, unknown>> {
  const store = new StateStore(config.stateDir);
  await store.initialize();
  const state = await store.read();
  return {
    state_path: store.path,
    onboarding: state.onboarding,
    requests: Object.values(state.requests),
  };
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
