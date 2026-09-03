import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentBoostConfig } from "./config.js";
import type {
  ChainClient,
  OnboardingRecord,
  PaymentPlan,
  PaymentRequest,
  PolicyUpdatePlan,
  PolicyUpdateReceipt,
  PublicOnboardingSnapshot,
  RecoveryTransferPlan,
  RecoveryTransferRequest,
  WalletAdapter,
  WalletProfileRecord,
  WalletReauthorizationPlan,
  WalletSelectionBinding,
  WalletTreeSnapshot,
} from "./contracts.js";
import {
  MAX_POLICY_LIFETIME_LIMIT_WEI,
  MAX_POLICY_PAYMENT_LIMIT_WEI,
  MAX_POLICY_PAYMENTS,
  MAX_POLICY_TTL_MS,
} from "./contracts.js";
import { KohakuWalletAdapter } from "./kohaku/index.js";
import type { AgentBoostRuntime } from "./mcp.js";
import { OnboardingController } from "./onboarding.js";
import { PaymentController } from "./payment.js";
import { WalletPolicyController } from "./policy.js";
import { RecoveryTransferController } from "./recovery.js";
import { SepoliaRpcClient } from "./rpc/index.js";
import {
  ShadeTreeEgress,
  type CoveredEgressPort,
  type CoveredFetchInput,
  type CoveredFetchResult,
} from "./shade-tree/index.js";
import { StateStore, type StateDocument } from "./state/store.js";
import { RuntimeLock } from "./state/runtime-lock.js";
import {
  TorRpcProxy,
  TorRpcRoute,
  type TorRpcProxyPort,
  type TorRpcRoutePort,
} from "./tor/index.js";
import {
  generateFundingQrCardPng,
  OnboardingUiServer,
  openVisibleBrowser,
} from "./ui/index.js";

export interface RuntimeDependencies {
  wallet?: WalletAdapter;
  chain?: ChainClient;
  rpcRoute?: TorRpcRoutePort;
  rpcProxy?: TorRpcProxyPort;
  openBrowser?: (url: string) => Promise<boolean>;
  coveredEgress?: CoveredEgressPort;
}

interface NewDemoResult {
  archiveId: string;
  previousSetupId?: string;
  previousRequestCount: number;
  record: OnboardingRecord;
  snapshot: PublicOnboardingSnapshot;
  uiOpened: boolean;
  qrPngBase64?: string;
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
  readonly #policy: WalletPolicyController;
  readonly #recovery: RecoveryTransferController;
  readonly #ui: OnboardingUiServer;
  readonly #openBrowser: (url: string) => Promise<boolean>;
  readonly #egress: CoveredEgressPort;
  #reset: Promise<NewDemoResult> | undefined;
  #walletOperationQueue: Promise<unknown> = Promise.resolve();
  #shuttingDown = false;

  constructor(config: AgentBoostConfig, dependencies: RuntimeDependencies = {}) {
    this.#config = config;
    this.#store = new StateStore(config.stateDir, config.kohakuWalletName);
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
    const chain =
      dependencies.chain ??
      new SepoliaRpcClient({
        rpcUrl: config.rpcUrl,
        fetch: requiredRpcRoute(this.#rpcRoute).fetchRpc,
      });
    this.#chain = this.#rpcRoute
      ? new RecoveringTorChainClient(chain, this.#rpcRoute)
      : chain;
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
      executionLimitWei: MAX_POLICY_PAYMENT_LIMIT_WEI,
      paymentApproval: config.security.effective["payment.execute"],
    });
    this.#policy = new WalletPolicyController({
      store: this.#store,
      defaultTtlMs: config.delegationTtlMs,
    });
    this.#recovery = new RecoveryTransferController({
      store: this.#store,
      wallet: this.#wallet,
      chain: this.#chain,
      executeEnabled: config.executeEnabled,
      withdrawalAmountWei: config.shieldAmountWei,
    });
    this.#ui = new OnboardingUiServer({
      getSnapshot: () => this.#getPublicSnapshot(),
      host: config.uiHost,
      port: config.uiPort,
    });
    this.#openBrowser = dependencies.openBrowser ?? openVisibleBrowser;
    this.#egress = dependencies.coveredEgress ?? new ShadeTreeEgress(config);
  }

  async initialize(): Promise<void> {
    await this.#runtimeLock.acquire();
    try {
      await ensurePasswordFile(this.#config.kohakuPasswordFile);
      await this.#store.initialize();
      const activeWallet = await this.#store.ensureWalletProfile(
        this.#config.kohakuWalletName,
      );
      this.#wallet.selectWallet?.(activeWallet);
      if (this.#rpcRoute) {
        // The wrapped chain read owns Tor bootstrap as well as recovery, so a
        // transient first bootstrap does not abort the MCP process.
        await this.#chain.assertSepolia();
      }
      await this.#rpcProxy?.start();
      await this.#egress.start();
      await this.#payments.recoverInterruptedRequests();
      await this.#recovery.recoverInterruptedRequests();
      await this.#onboarding.resume();
    } catch (error) {
      await this.#rpcProxy?.stop().catch(() => undefined);
      await this.#egress.stop().catch(() => undefined);
      await this.#rpcRoute?.close().catch(() => undefined);
      await this.#runtimeLock.release();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    await this.#reset?.catch(() => undefined);
    await this.#walletOperationQueue.catch(() => undefined);
    await Promise.allSettled([
      this.#onboarding.stop(),
      this.#payments.stop(),
      this.#recovery.stop(),
      this.#ui.stop(),
      this.#egress.stop(),
    ]);
    await this.#rpcProxy?.stop().catch(() => undefined);
    await this.#rpcRoute?.close().catch(() => undefined);
    await this.#runtimeLock.release();
  }

  async capabilities(): Promise<Record<string, unknown>> {
    const state = await this.#store.read();
    const setup = state.onboarding;
    const egress = await this.#egress.status();
    return {
      contract: "org.agentboost.wallet/1.5",
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
        lifetime_limit_atomic: this.#config.paymentLifetimeLimitWei.toString(),
        max_payments: this.#config.maxPayments,
        default_lifetime_seconds: Math.floor(
          this.#config.delegationTtlMs / 1_000,
        ),
        requires_exact_verbal_confirmation: false,
        requires_user_confirmation:
          this.#config.security.effective["payment.execute"] === "confirm",
        policy_editing: {
          available: true,
          requires_user_confirmation: true,
          hard_max_per_payment_atomic:
            MAX_POLICY_PAYMENT_LIMIT_WEI.toString(),
          hard_max_lifetime_atomic:
            MAX_POLICY_LIFETIME_LIMIT_WEI.toString(),
          hard_max_payments: MAX_POLICY_PAYMENTS,
          hard_max_lifetime_seconds: Math.floor(MAX_POLICY_TTL_MS / 1_000),
        },
      },
      security: {
        default: this.#config.security.default,
        overrides: this.#config.security.overrides,
        effective: this.#config.security.effective,
        hard_limits: {
          chain_id: "eip155:11155111",
          mainnet_available: false,
          rpc_direct_fallback: false,
          per_payment_limit_atomic: MAX_POLICY_PAYMENT_LIMIT_WEI.toString(),
          lifetime_limit_atomic: MAX_POLICY_LIFETIME_LIMIT_WEI.toString(),
          max_payments: MAX_POLICY_PAYMENTS,
        },
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
          "only explicit covered-fetch calls use Shade Tree; Hermes and other agent traffic are not blanket-routed",
          "timing and the Sepolia anonymity set can enable correlation",
          "demo resets archive local state and retain old Kohaku wallet data",
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
        general_egress: {
          name: "shade-tree",
          available: egress.status === "ready",
          contract: "org.agentboost.egress/0.1",
          mode: "explicit_fetch",
          status: egress.status,
          direct_fallback: false,
        },
      },
      readiness: {
        phase: setup?.phase ?? "not_started",
        wallet_ready: setup?.phase === "private_ready",
        address_ready: setup?.address !== undefined,
        rpc_egress: this.#rpcRoute?.status ?? "ready",
        general_egress_ready: egress.status === "ready",
      },
      demo_reset: {
        available: this.#wallet.selectWallet !== undefined,
        requires_user_confirmation: true,
        archives_previous_state: true,
        rebroadcasts_unresolved_payments: false,
      },
      wallet_management: {
        available:
          this.#wallet.selectWallet !== undefined &&
          this.#wallet.listWallets !== undefined,
        managed_wallets_only: true,
        accepts_seed_or_password: false,
        selection_requires_separate_reauthorization: true,
        recovery_transfer_available:
          this.#wallet.executeRecoveryTransfer !== undefined,
      },
      wallet_tree: {
        available: true,
        hierarchy: "profile_container",
        account_short_names: ["main", "private"],
        active_balances_refreshed_live: true,
        inactive_public_balances_refreshed_live: true,
        inactive_private_balances: "last_known",
        includes_addresses: false,
        implies_control: false,
      },
    };
  }

  startOnboarding(): Promise<{
    record: OnboardingRecord;
    snapshot: PublicOnboardingSnapshot;
    uiOpened: boolean;
    qrPngBase64?: string;
  }> {
    return this.#withWalletOperation(() => this.#startOnboardingUnlocked());
  }

  async #startOnboardingUnlocked(): Promise<{
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
        ? (await generateFundingQrCardPng(snapshot.address, remaining.toString())).toString(
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

  walletContext(): Promise<Record<string, unknown>> {
    return this.#withWalletOperation(() => this.#walletContextUnlocked());
  }

  async #walletContextUnlocked(): Promise<Record<string, unknown>> {
    let record = await this.#onboarding.getRecord();
    let observedAt = record.updatedAt;
    while (record.address) {
      const observedSetupId = record.setupId;
      const observedAddress = record.address;
      const addressBalance = await this.#chain.getBalanceWei(observedAddress);
      observedAt = new Date().toISOString();
      const state = await this.#store.update((draft) => {
        if (
          !draft.onboarding ||
          draft.onboarding.setupId !== observedSetupId ||
          draft.onboarding.address !== observedAddress
        ) return;
        if (draft.onboarding.publicBalanceWei === addressBalance.toString()) return;
        draft.onboarding.publicBalanceWei = addressBalance.toString();
        draft.onboarding.revision += 1;
        draft.onboarding.updatedAt = new Date().toISOString();
      });
      record = state.onboarding as OnboardingRecord;
      if (record.setupId === observedSetupId && record.address === observedAddress) break;
      observedAt = record.updatedAt;
    }
    return {
      chain_id: "eip155:11155111",
      account_role: "main_funding_source",
      controls_subaccounts: false,
      account_id: record.address
        ? `eip155:11155111:${record.address}`
        : undefined,
      address: record.address,
      setup_phase: record.phase,
      // Public contract invariant: this value comes only from eth_getBalance
      // for the returned main account, never from wallet/subaccount accounting.
      ...(record.address ? { balance_atomic: record.publicBalanceWei } : {}),
      delegation: record.delegation,
      security: {
        payment_execute: this.#config.security.effective["payment.execute"],
      },
      freshness: { observed_at: observedAt, revision: record.revision },
      rpc_route: {
        mode: "tor",
        scope: "ethereum_json_rpc",
        status: this.#rpcRoute?.status ?? "ready",
        direct_fallback: false,
      },
      general_egress_privacy: false,
      covered_egress: {
        mode: "explicit_fetch",
        status: (await this.#egress.status()).status,
        direct_fallback: false,
      },
    };
  }

  walletTree(): Promise<WalletTreeSnapshot> {
    return this.#withWalletOperation(() => this.#walletTreeUnlocked());
  }

  async #walletTreeUnlocked(): Promise<WalletTreeSnapshot> {
    const before = await this.#store.read();
    if (!before.wallet) throw new Error("WALLET_REGISTRY_MISSING");
    const activeWalletId = before.wallet.activeWalletId;
    const available = Object.values(before.wallet.profiles)
      .filter((profile) => profile.status === "available")
      .sort((left, right) => {
        if (left.walletId === activeWalletId) return -1;
        if (right.walletId === activeWalletId) return 1;
        return left.name.localeCompare(right.name);
      });

    const publicSamples = new Map<string, {
      setupId: string;
      address: string;
      balanceWei?: string;
    }>();
    await Promise.all(available.map(async (profile) => {
      const onboarding = profile.walletId === activeWalletId
        ? before.onboarding
        : profile.onboarding;
      if (!onboarding?.address) return;
      const sample = { setupId: onboarding.setupId, address: onboarding.address };
      try {
        publicSamples.set(profile.walletId, {
          ...sample,
          balanceWei: (await this.#chain.getBalanceWei(onboarding.address)).toString(),
        });
      } catch {
        publicSamples.set(profile.walletId, sample);
      }
    }));

    const activeOnboarding = before.onboarding;
    let activePrivateBalanceWei: string | undefined;
    if (activeOnboarding?.phase === "private_ready") {
      try {
        activePrivateBalanceWei = (await this.#wallet.getPrivateBalanceWei()).toString();
      } catch {
        // The tree remains useful while marking this one balance unavailable.
      }
    }

    const observedAt = new Date().toISOString();
    const current = await this.#store.update((draft) => {
      if (!draft.wallet) return;
      for (const profile of Object.values(draft.wallet.profiles)) {
        const onboarding = profile.walletId === draft.wallet.activeWalletId
          ? draft.onboarding
          : profile.onboarding;
        const sample = publicSamples.get(profile.walletId);
        if (
          onboarding &&
          sample?.balanceWei !== undefined &&
          onboarding.setupId === sample.setupId &&
          onboarding.address === sample.address &&
          onboarding.publicBalanceWei !== sample.balanceWei
        ) {
          onboarding.publicBalanceWei = sample.balanceWei;
          onboarding.revision += 1;
          onboarding.updatedAt = observedAt;
        }
      }
      if (
        draft.wallet.activeWalletId === activeWalletId &&
        draft.onboarding &&
        activeOnboarding &&
        draft.onboarding.setupId === activeOnboarding.setupId &&
        activePrivateBalanceWei !== undefined &&
        draft.onboarding.privateBalanceWei !== activePrivateBalanceWei
      ) {
        draft.onboarding.privateBalanceWei = activePrivateBalanceWei;
        draft.onboarding.revision += 1;
        draft.onboarding.updatedAt = observedAt;
      }
    });

    const profiles = Object.values(current.wallet?.profiles ?? {})
      .filter((profile) => profile.status === "available")
      .sort((left, right) => {
        if (left.walletId === activeWalletId) return -1;
        if (right.walletId === activeWalletId) return 1;
        return left.name.localeCompare(right.name);
      })
      .map((profile) => {
        const active = profile.walletId === activeWalletId;
        const onboarding = active ? current.onboarding : profile.onboarding;
        const publicSample = publicSamples.get(profile.walletId);
        const publicIsLive = Boolean(
          onboarding?.address &&
          publicSample?.balanceWei !== undefined &&
          onboarding.setupId === publicSample.setupId &&
          onboarding.address === publicSample.address,
        );
        const privateStatus = walletTreePrivateStatus(onboarding);
        const privateIsLive = active &&
          onboarding?.phase === "private_ready" &&
          activePrivateBalanceWei !== undefined;
        const privateIsLastKnown = !active && onboarding?.phase === "private_ready";
        const privateBalanceWei = privateIsLive
          ? activePrivateBalanceWei
          : privateIsLastKnown
            ? onboarding.privateBalanceWei
            : undefined;
        return {
          shortName: profile.name,
          active,
          setupPhase: onboarding?.phase ?? "not_started",
          main: {
            shortName: "main" as const,
            role: "main_funding_source" as const,
            ...(publicIsLive && publicSample?.balanceWei !== undefined
              ? { balanceWei: publicSample.balanceWei }
              : {}),
            status: onboarding?.address
              ? publicIsLive ? "ready" as const : "unavailable" as const
              : "not_created" as const,
            freshness: publicIsLive ? "live" as const : "unavailable" as const,
          },
          subwallets: [{
            shortName: "private" as const,
            role: "private_payment_pocket" as const,
            ...(privateBalanceWei !== undefined
              ? { balanceWei: privateBalanceWei }
              : {}),
            status: privateIsLive || privateIsLastKnown
              ? "ready" as const
              : privateStatus,
            freshness: privateIsLive
              ? "live" as const
              : privateIsLastKnown
                ? "last_known" as const
                : "unavailable" as const,
          }],
        };
      });

    return {
      version: 1,
      chainId: 11_155_111,
      network: "Sepolia",
      observedAt,
      profiles,
      archivedProfiles: Object.values(current.wallet?.profiles ?? {})
        .filter((profile) => profile.status === "archived").length,
      relationship: { type: "profile_container", impliesControl: false },
    };
  }

  egressCapabilities(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.#egress.capabilities());
  }

  async egressStatus(): Promise<Record<string, unknown>> {
    return {
      ...(await this.#egress.status()),
      direct_fallback: false,
      enrollment_secret_exposed: false,
    };
  }

  egressFetch(input: CoveredFetchInput): Promise<CoveredFetchResult> {
    return this.#egress.fetch(input);
  }

  planPrivatePayment(input: {
    recipient: string;
    amountWei: string;
  }): Promise<PaymentPlan> {
    return this.#withWalletOperation(() => this.#payments.plan(input));
  }

  walletPolicy() {
    return this.#policy.get();
  }

  planPolicyUpdate(input: {
    perPaymentLimitWei?: string;
    lifetimeLimitWei?: string;
    maxPayments?: number;
    ttlMs?: number;
    enabled?: boolean;
  }): Promise<PolicyUpdatePlan> {
    return this.#withWalletOperation(() => this.#policy.plan(input));
  }

  getPolicyUpdatePlan(decisionId: string): Promise<PolicyUpdatePlan> {
    return this.#policy.getPlan(decisionId);
  }

  getLatestPolicyUpdatePlan(): Promise<PolicyUpdatePlan> {
    return this.#policy.getLatestPlan();
  }

  applyPolicyUpdate(input: {
    decisionId: string;
    userConfirmed: boolean;
  }): Promise<PolicyUpdateReceipt> {
    return this.#withWalletOperation(() => this.#policy.apply(input));
  }

  getPaymentPlan(decisionId: string): Promise<PaymentPlan> {
    return this.#payments.getPlan(decisionId);
  }

  executePrivatePayment(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<PaymentRequest> {
    return this.#withWalletOperation(() =>
      this.#payments.execute(input).then(publicPaymentRequest)
    );
  }

  getRequest(requestId: string): Promise<PaymentRequest> {
    return this.#payments.getRequest(requestId).then(publicPaymentRequest);
  }

  async listWallets(): Promise<Record<string, unknown>> {
    const state = await this.#store.read();
    const profiles = Object.values(state.wallet?.profiles ?? {});
    const wallets = profiles.map((profile) => publicWalletProfile(
      profile,
      state,
    ));
    return {
      active_wallet_id: wallets.find((wallet) => wallet.active)?.wallet_id,
      wallets,
    };
  }

  async createWallet(input: {
    name: string;
    userConfirmed: boolean;
  }): Promise<Record<string, unknown>> {
    if (!input.userConfirmed) {
      throw new Error("The user must confirm creating and selecting a new wallet");
    }
    if (!this.#wallet.listWallets || !this.#wallet.selectWallet) {
      throw new Error("WALLET_MANAGEMENT_UNAVAILABLE");
    }
    return this.#withWalletOperation(async () => {
      const inventory = await this.#wallet.listWallets!();
      if (inventory.some((wallet) => wallet.name === input.name)) {
        throw new Error("WALLET_NAME_ALREADY_EXISTS");
      }
      const previousName = (await this.#store.read()).wallet?.activeName ??
        this.#config.kohakuWalletName;
      await this.#stopWalletWork();
      this.#wallet.selectWallet!(input.name);
      let activated;
      try {
        await this.#wallet.ensureWallet();
        const profile = await this.#store.registerManagedWallet(input.name);
        activated = await this.#store.activateWalletProfile(profile.walletId);
      } catch (error) {
        this.#wallet.selectWallet!(previousName);
        this.#resetWalletControllers();
        await this.#onboarding.resume().catch(() => undefined);
        throw error;
      }
      this.#resetWalletControllers();
      const started = await this.#startOnboardingUnlocked();
      return {
        wallet: publicWalletProfile(activated.profile, activated.current),
        archive_id: activated.archiveId,
        setup_phase: started.record.phase,
        authorization_required: true,
      };
    });
  }

  async adoptWallet(input: {
    name: string;
    userConfirmed: boolean;
  }): Promise<Record<string, unknown>> {
    if (!input.userConfirmed) {
      throw new Error("The user must confirm adopting and selecting the wallet");
    }
    if (!this.#wallet.listWallets || !this.#wallet.selectWallet) {
      throw new Error("WALLET_MANAGEMENT_UNAVAILABLE");
    }
    return this.#withWalletOperation(async () => {
      const inventory = await this.#wallet.listWallets!();
      const localWallet = inventory.find((wallet) => wallet.name === input.name);
      if (!localWallet) throw new Error("LOCAL_WALLET_NOT_FOUND");
      if (localWallet.network !== "sepolia") {
        throw new Error("ONLY_SEPOLIA_WALLETS_CAN_BE_ADOPTED");
      }

      const before = await this.#store.read();
      const existing = Object.values(before.wallet?.profiles ?? {}).find(
        (profile) => profile.name === input.name,
      );
      if (existing && before.wallet?.activeWalletId === existing.walletId) {
        return {
          wallet: publicWalletProfile(existing, before),
          changed: false,
          authorization_required: existing.authorizationId === undefined,
        };
      }

      const previousName = before.wallet?.activeName ?? this.#config.kohakuWalletName;
      await this.#stopWalletWork();
      this.#wallet.selectWallet!(input.name);
      let activated;
      try {
        // The inventory check above makes this a validation-only call; a
        // missing or non-Sepolia wallet is rejected before selection changes.
        await this.#wallet.ensureWallet();
        const profile = existing ??
          await this.#store.registerManagedWallet(input.name, "adopted");
        activated = await this.#store.activateWalletProfile(profile.walletId);
      } catch (error) {
        this.#wallet.selectWallet!(previousName);
        this.#resetWalletControllers();
        await this.#onboarding.resume().catch(() => undefined);
        throw error;
      }

      this.#resetWalletControllers();
      let setup = activated.current.onboarding;
      if (setup) await this.#onboarding.resume();
      else setup = (await this.#startOnboardingUnlocked()).record;
      return {
        wallet: publicWalletProfile(activated.profile, activated.current),
        changed: true,
        archive_id: activated.archiveId,
        setup_phase: setup.phase,
        authorization_required: true,
      };
    });
  }

  async selectWallet(input: {
    walletId: string;
    userConfirmed: boolean;
  }): Promise<Record<string, unknown>> {
    if (!input.userConfirmed) {
      throw new Error("The user must confirm changing the active wallet");
    }
    if (!this.#wallet.selectWallet || !this.#wallet.listWallets) {
      throw new Error("WALLET_MANAGEMENT_UNAVAILABLE");
    }
    return this.#withWalletOperation(async () => {
      const before = await this.#store.read();
      const profile = before.wallet?.profiles[input.walletId];
      if (!profile) throw new Error("WALLET_NOT_FOUND");
      if (before.wallet?.activeName === profile.name) {
        const authorization = walletAuthorizationStatus(profile, before);
        return {
          wallet: publicWalletProfile(profile, before),
          changed: false,
          authorization_required: authorization !== "active",
          authorization_status: authorization,
        };
      }
      const previousName = before.wallet?.activeName ?? this.#config.kohakuWalletName;
      await this.#stopWalletWork();
      this.#wallet.selectWallet!(profile.name);
      let activated;
      try {
        activated = await this.#store.activateWalletProfile(profile.walletId);
      } catch (error) {
        this.#wallet.selectWallet!(previousName);
        this.#resetWalletControllers();
        await this.#onboarding.resume().catch(() => undefined);
        throw error;
      }
      // Durable state and adapter now agree. Later onboarding failures stay on
      // this selected wallet and must never roll the adapter back independently.
      this.#resetWalletControllers();
      let setup = activated.current.onboarding;
      if (setup) await this.#onboarding.resume();
      else setup = (await this.#startOnboardingUnlocked()).record;
      return {
        wallet: publicWalletProfile(activated.profile, activated.current),
        changed: true,
        archive_id: activated.archiveId,
        setup_phase: setup.phase,
        authorization_required: true,
      };
    });
  }

  async archiveWallet(input: {
    walletId: string;
    userConfirmed: boolean;
  }): Promise<Record<string, unknown>> {
    if (!input.userConfirmed) {
      throw new Error("The user must confirm archiving this wallet profile");
    }
    return this.#withWalletOperation(async () => {
      const profile = await this.#store.archiveWalletProfile(input.walletId);
      return { wallet: publicWalletProfile(profile, await this.#store.read()) };
    });
  }

  async planWalletReauthorization(): Promise<WalletReauthorizationPlan> {
    return this.#withWalletOperation(() => this.#planWalletReauthorizationUnlocked());
  }

  async #planWalletReauthorizationUnlocked(): Promise<WalletReauthorizationPlan> {
    const state = await this.#store.read();
    const profile = state.wallet?.profiles[state.wallet.activeWalletId];
    if (!profile || !state.onboarding) throw new Error("WALLET_SETUP_NOT_STARTED");
    const blockers: string[] = [];
    if (!this.#config.executeEnabled) blockers.push("EXECUTION_DISABLED");
    if (this.#config.security.effective["payment.execute"] === "deny") {
      blockers.push("SECURITY_POLICY_DENIED");
    }
    if (state.onboarding.phase !== "private_ready") {
      blockers.push("PRIVATE_BALANCE_NOT_READY");
    }
    const now = new Date();
    const wallet = {
      walletId: profile.walletId,
      walletName: profile.name,
      selectionEpoch: profile.selectionEpoch,
    };
    const paymentsUsed = profile.authorizationId
      ? Object.values(state.requests).filter(
        (request) => request.authorization.authorizationId === profile.authorizationId,
      ).length
      : 0;
    const currentPolicy = {
      ...state.onboarding.delegation,
      paymentsUsed,
      paymentsRemaining: Math.max(
        0,
        state.onboarding.delegation.maxPayments - paymentsUsed,
      ),
    };
    const proposedPolicy = {
      ...currentPolicy,
      spentWei: "0",
      paymentsUsed: 0,
      paymentsRemaining: currentPolicy.maxPayments,
      expiresAt: new Date(now.getTime() + this.#config.delegationTtlMs).toISOString(),
      enabled: true,
    };
    const plan: WalletReauthorizationPlan = {
      version: 1,
      decisionId: `wra_${randomUUID()}`,
      wallet,
      ...(profile.authorizationId ? { priorAuthorizationId: profile.authorizationId } : {}),
      currentPolicy,
      proposedPolicy,
      authorizationEffect: "replace",
      counterEffect: "reset_spend_and_payment_count",
      intentDigest: reauthorizationDigest({
        wallet,
        ...(profile.authorizationId
          ? { priorAuthorizationId: profile.authorizationId }
          : {}),
        currentPolicy,
        proposedPolicy,
      }),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      decision: blockers.length === 0 ? "allow" : "deny",
      blockers,
      approval: { action: "confirm", userConfirmationRequired: true },
    };
    await this.#store.storeReauthorizationPlan(plan);
    return plan;
  }

  async reauthorizeWallet(input: {
    decisionId: string;
    userConfirmed: boolean;
  }): Promise<Record<string, unknown>> {
    if (!input.userConfirmed) {
      throw new Error("The user must confirm a fresh wallet authorization");
    }
    return this.#withWalletOperation(async () => {
      const plan = (await this.#store.read()).reauthorizationPlans[input.decisionId];
      if (!plan || plan.decision !== "allow") {
        throw new Error("REAUTHORIZATION_DECISION_NOT_ALLOWED");
      }
      const applied = await this.#store.applyReauthorizationPlan(input.decisionId);
      const state = await this.#store.read();
      return {
        wallet: publicWalletProfile(applied.profile, state),
        delegation: applied.onboarding.delegation,
      };
    });
  }

  async getWalletReauthorizationPlan(decisionId: string): Promise<WalletReauthorizationPlan> {
    const plan = (await this.#store.read()).reauthorizationPlans[decisionId];
    if (!plan) throw new Error("REAUTHORIZATION_DECISION_NOT_FOUND");
    return plan;
  }

  planRecoveryTransfer(input: {
    recipient: string;
    amountWei: string;
  }): Promise<RecoveryTransferPlan> {
    return this.#withWalletOperation(() => this.#recovery.plan(input));
  }

  getRecoveryPlan(decisionId: string): Promise<RecoveryTransferPlan> {
    return this.#recovery.getPlan(decisionId);
  }

  executeRecoveryTransfer(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<RecoveryTransferRequest> {
    return this.#withWalletOperation(() =>
      this.#recovery.execute(input).then(publicRecoveryRequest)
    );
  }

  getRecoveryRequest(requestId: string): Promise<RecoveryTransferRequest> {
    return this.#recovery.getRequest(requestId).then(publicRecoveryRequest);
  }

  startNewDemo(input: { userConfirmed: boolean }): Promise<NewDemoResult> {
    if (this.#shuttingDown) {
      return Promise.reject(new Error("AGENT_BOOST_RUNTIME_STOPPING"));
    }
    if (!input.userConfirmed) {
      return Promise.reject(
        new Error("The user must confirm archiving the current demo and creating a new wallet"),
      );
    }
    if (!this.#wallet.selectWallet) {
      return Promise.reject(new Error("DEMO_RESET_UNAVAILABLE"));
    }
    if (this.#reset) return this.#reset;
    this.#reset = this.#withWalletOperation(() => this.#startNewDemo()).finally(() => {
      this.#reset = undefined;
    });
    return this.#reset;
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
      covered_egress: await this.egressStatus(),
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

  async #startNewDemo(): Promise<NewDemoResult> {
    await this.#onboarding.stop();
    await this.#payments.stop();
    await this.#recovery.stop();
    const previous = await this.#store.read();
    const previousWalletName = previous.wallet?.activeName ?? this.#config.kohakuWalletName;
    const newWalletName = `agent-boost-${randomBytes(8).toString("hex")}`;
    let archived;
    try {
      this.#wallet.selectWallet?.(newWalletName);
      await this.#wallet.ensureWallet();
      archived = await this.#store.archiveAndReset(newWalletName);
    } catch (error) {
      this.#wallet.selectWallet?.(previousWalletName);
      this.#payments.resetForNewDemo();
      this.#recovery.resetForWalletSelection();
      await this.#onboarding.resume().catch(() => undefined);
      throw error;
    }
    this.#payments.resetForNewDemo();
    this.#recovery.resetForWalletSelection();
    const started = await this.#startOnboardingUnlocked();
    return {
      archiveId: archived.archiveId,
      ...(archived.previous.onboarding?.setupId
        ? { previousSetupId: archived.previous.onboarding.setupId }
        : {}),
      previousRequestCount: Object.keys(archived.previous.requests).length,
      ...started,
    };
  }

  #withWalletOperation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#walletOperationQueue.then(async () => {
      if (this.#shuttingDown) throw new Error("AGENT_BOOST_RUNTIME_STOPPING");
      return operation();
    });
    this.#walletOperationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async #stopWalletWork(): Promise<void> {
    await this.#onboarding.stop();
    await this.#payments.stop();
    await this.#recovery.stop();
  }

  #resetWalletControllers(): void {
    this.#payments.resetForNewDemo();
    this.#recovery.resetForWalletSelection();
  }
}

function publicPaymentRequest(request: PaymentRequest): PaymentRequest {
  const publicRequest = { ...request };
  delete publicRequest.recipientBalanceBeforeWei;
  delete publicRequest.reconciliation;
  return publicRequest;
}

function walletTreePrivateStatus(
  onboarding: OnboardingRecord | undefined,
): "ready" | "preparing" | "not_created" | "unavailable" {
  if (!onboarding || onboarding.phase === "not_started" || onboarding.phase === "creating_wallet") {
    return "not_created";
  }
  if (onboarding.phase === "private_ready") return "unavailable";
  if (onboarding.phase === "failed") return "unavailable";
  return "preparing";
}

function publicRecoveryRequest(
  request: RecoveryTransferRequest,
): RecoveryTransferRequest {
  const publicRequest = { ...request };
  delete publicRequest.recipientBalanceBeforeWei;
  delete publicRequest.reconciliation;
  return publicRequest;
}

function publicWalletProfile(
  profile: WalletProfileRecord,
  state: StateDocument,
): Record<string, unknown> & { active: boolean; wallet_id: string } {
  const active = state.wallet?.activeWalletId === profile.walletId;
  const onboarding = active ? state.onboarding : profile.onboarding;
  const authorizationStatus = walletAuthorizationStatus(profile, state);
  return {
    wallet_id: profile.walletId,
    name: profile.name,
    network: "sepolia",
    chain_id: "eip155:11155111",
    origin: profile.origin,
    status: profile.status,
    active,
    selection_epoch: profile.selectionEpoch,
    authorized: authorizationStatus === "active",
    authorization_status: authorizationStatus,
    ...(active && onboarding?.delegation.expiresAt
      ? { authorization_expires_at: onboarding.delegation.expiresAt }
      : {}),
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
  };
}

function walletAuthorizationStatus(
  profile: WalletProfileRecord,
  state: StateDocument,
): "inactive" | "missing" | "disabled" | "expired" | "exhausted" | "active" {
  if (state.wallet?.activeWalletId !== profile.walletId) return "inactive";
  if (!profile.authorizationId) return "missing";
  const onboarding = state.onboarding;
  if (!onboarding?.delegation.enabled) return "disabled";
  if (new Date(onboarding.delegation.expiresAt).getTime() <= Date.now()) {
    return "expired";
  }
  const requestsUsed = Object.values(state.requests).filter(
    (request) => request.authorization.authorizationId === profile.authorizationId,
  ).length;
  if (
    BigInt(onboarding.delegation.spentWei) >=
      BigInt(onboarding.delegation.lifetimeLimitWei) ||
    requestsUsed >= onboarding.delegation.maxPayments
  ) {
    return "exhausted";
  }
  return "active";
}

function reauthorizationDigest(input: {
  wallet: WalletSelectionBinding;
  priorAuthorizationId?: string;
  currentPolicy: Record<string, unknown>;
  proposedPolicy: Record<string, unknown>;
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    operation: "wallet_reauthorization",
    chain_id: "eip155:11155111",
    wallet_id: input.wallet.walletId,
    wallet_name: input.wallet.walletName,
    selection_epoch: input.wallet.selectionEpoch,
    prior_authorization_id: input.priorAuthorizationId,
    current_policy: input.currentPolicy,
    proposed_policy: input.proposedPolicy,
  })).digest("hex")}`;
}

function requiredRpcRoute(route: TorRpcRoutePort | undefined): TorRpcRoutePort {
  if (!route) throw new Error("Tor RPC route is required");
  return route;
}

function requiredRpcProxy(proxy: TorRpcProxyPort | undefined): TorRpcProxyPort {
  if (!proxy) throw new Error("Tor RPC proxy is required");
  return proxy;
}

/**
 * Tor circuits and public testnet RPCs can both fail transiently during a
 * cold start. Read-only chain calls are safe to retry after rebuilding the
 * Tor route; signing and broadcast operations remain outside this wrapper.
 */
class RecoveringTorChainClient implements ChainClient {
  readonly #chain: ChainClient;
  readonly #route: TorRpcRoutePort;
  #routeRecovery: Promise<void> | undefined;

  constructor(chain: ChainClient, route: TorRpcRoutePort) {
    this.#chain = chain;
    this.#route = route;
  }

  assertSepolia(): Promise<void> {
    return this.#read(() => this.#chain.assertSepolia());
  }

  getBalanceWei(address: string): Promise<bigint> {
    return this.#read(() => this.#chain.getBalanceWei(address));
  }

  getTransactionReceiptStatus(transactionHash: string) {
    if (!this.#chain.getTransactionReceiptStatus) {
      return Promise.reject(new Error("Transaction receipt lookup is unavailable"));
    }
    return this.#read(() =>
      this.#chain.getTransactionReceiptStatus!(transactionHash)
    );
  }

  async #read<T>(operation: () => Promise<T>): Promise<T> {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.#ensureRoute();
        return await operation();
      } catch (error) {
        failure = error;
        if (isChainMismatch(error) || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw failure;
  }

  async #ensureRoute(): Promise<void> {
    if (this.#route.status === "ready") return;
    this.#routeRecovery ??= this.#route.ready().finally(() => {
      this.#routeRecovery = undefined;
    });
    await this.#routeRecovery;
  }
}

function isChainMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("RPC chain mismatch:");
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
  const store = new StateStore(config.stateDir, config.kohakuWalletName);
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
