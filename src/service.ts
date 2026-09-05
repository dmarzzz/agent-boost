import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentBoostConfig } from "./config.js";
import type {
  ChainClient,
  DelegationPolicy,
  OnboardingRecord,
  PaymentPlan,
  PaymentRequest,
  PolicyUpdatePlan,
  PolicyUpdateReceipt,
  PrivateBalanceCreationPlan,
  PrivateBalanceCreationRequest,
  PrivateBalanceFundingPlan,
  PrivateBalanceFundingRequest,
  PrivateBalancePolicyUpdatePlan,
  PrivateBalancePolicyUpdateRequest,
  PrivateBalanceRecord,
  PublicOnboardingSnapshot,
  RegularTransferPlan,
  RegularTransferRequest,
  RecoveryTransferPlan,
  RecoveryTransferRequest,
  WalletAdapter,
  WalletProfileRecord,
  WalletReauthorizationPlan,
  WalletSelectionBinding,
  WalletTreePolicySnapshot,
  WalletTreeSnapshot,
} from "./contracts.js";
import {
  MAX_POLICY_LIFETIME_LIMIT_WEI,
  MAX_POLICY_PAYMENT_LIMIT_WEI,
  MAX_POLICY_PAYMENTS,
  MAX_POLICY_TTL_MS,
  SEPOLIA_CHAIN_ID,
} from "./contracts.js";
import { AgentBoostRequestError } from "./errors.js";
import { KohakuWalletAdapter } from "./kohaku/index.js";
import type { AgentBoostRuntime, NamedRecipientResult } from "./mcp.js";
import { OnboardingController } from "./onboarding.js";
import { PaymentController } from "./payment.js";
import { PrivateBalanceController } from "./private-balance.js";
import { PrivateBalancePolicyController } from "./private-balance-policy.js";
import { WalletPolicyController } from "./policy.js";
import {
  publicChangeBalanceWei,
  refreshPublicChangeAccount,
} from "./public-change.js";
import { RegularTransferController } from "./regular-transfer.js";
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

interface TransferPlanningReferenceInput {
  recipient?: string;
  recipientWalletName?: string;
  sourceWalletName?: string;
  sourcePrivateBalanceName?: string;
  amountWei: string;
}

interface ExpectedActiveWalletInput {
  expectedActiveWalletName?: string;
  expectedActiveSelectionEpoch?: number;
}

type WalletLifecycleSetup = Pick<
  OnboardingRecord,
  "setupId" | "revision" | "phase"
>;

interface WalletLifecycleSetupResult {
  setup_phase: OnboardingRecord["phase"] | "not_started";
  setup?: WalletLifecycleSetup;
  setup_continuation_status?: "unavailable";
}

const UNRESOLVED_ONBOARDING_PHASES = new Set<OnboardingRecord["phase"]>([
  "not_started",
  "creating_wallet",
  "preparing_privacy",
  "awaiting_funding",
  "funding_pending",
  "funded_public",
  "shielding",
]);

function walletLifecycleSetup(
  setup: WalletLifecycleSetup,
): WalletLifecycleSetupResult {
  return {
    setup_phase: setup.phase,
    ...(UNRESOLVED_ONBOARDING_PHASES.has(setup.phase)
      ? {
          setup: {
            setupId: setup.setupId,
            revision: setup.revision,
            phase: setup.phase,
          },
        }
      : {}),
  };
}

// These labels exist only to keep a just-planned friendly name visible across
// the confirmation turn. Durable plans remain strict version-2 records, and a
// restarted runtime derives the label again from the saved public address.
const TRANSIENT_RECIPIENT_LABEL_LIMIT = 256;

type TransferPlanningKind = "regular" | "private" | "recovery";

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
  readonly #regularTransfers: RegularTransferController;
  readonly #policy: WalletPolicyController;
  readonly #privateBalances: PrivateBalanceController;
  readonly #privateBalancePolicy: PrivateBalancePolicyController;
  readonly #recovery: RecoveryTransferController;
  readonly #ui: OnboardingUiServer;
  readonly #openBrowser: (url: string) => Promise<boolean>;
  readonly #egress: CoveredEgressPort;
  #walletOperationQueue: Promise<unknown> = Promise.resolve();
  readonly #recipientWalletNamesByDecision = new Map<string, string>();
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
      withdrawalAmountWei: config.shieldAmountWei,
    });
    this.#regularTransfers = new RegularTransferController({
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
    this.#privateBalances = new PrivateBalanceController({
      store: this.#store,
      wallet: this.#wallet,
      chain: this.#chain,
      shieldDenominationWei: config.shieldAmountWei,
      executeEnabled: config.executeEnabled,
    });
    this.#privateBalancePolicy = new PrivateBalancePolicyController({
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
      await this.#regularTransfers.recoverInterruptedRequests();
      await this.#payments.recoverInterruptedRequests();
      await this.#recovery.recoverInterruptedRequests();
      await this.#privateBalances.recoverInterruptedRequests();
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
    await this.#walletOperationQueue.catch(() => undefined);
    await Promise.allSettled([
      this.#onboarding.stop(),
      this.#payments.stop(),
      this.#regularTransfers.stop(),
      this.#recovery.stop(),
      this.#privateBalances.stop(),
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
      contract: "org.agentboost.wallet/1.8",
      chain_id: "eip155:11155111",
      network_name: "Sepolia",
      asset_type: "eip155:11155111/slip44:60",
      funding_target_atomic: this.#config.fundingTargetWei.toString(),
      privacy_protocol: "tornado",
      private_payment_operation: "unshield_next_tail_call",
      regular_transfer_operation: "public_eth_transfer",
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
        selection_requires_separate_reauthorization: false,
        selection_preserves_valid_authorization: true,
        multiple_profiles: true,
        recovery_transfer_available:
          this.#wallet.executeRecoveryTransfer !== undefined,
        regular_transfer_available:
          this.#wallet.executeRegularTransfer !== undefined,
      },
      private_balance_management: {
        available: true,
        named: true,
        multiple_per_profile: true,
        create_available: true,
        fund_from_main_available: true,
        fund_from_private_balance_available: true,
        per_balance_policy_editing: true,
        public_change: {
          nested_under_source_private_balance: true,
          regular_transfer_source: true,
        },
      },
      regular_transfer: {
        available: this.#wallet.executeRegularTransfer !== undefined,
        source_kinds: ["main", "private_balance_public_change"],
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
    const activeProfile = before.wallet.profiles[activeWalletId];
    const reservedPrivateBalanceIds = unresolvedPrivateBalanceIds(before);
    const activePrivateSamples = new Map<string, string>();
    const activePublicChangeSamples = new Map<string, Map<string, string>>();
    if (activeProfile && activeOnboarding?.phase === "private_ready") {
      for (const privateBalance of Object.values(activeProfile.privateBalances)) {
        if (privateBalance.status !== "available" ||
          reservedPrivateBalanceIds.has(privateBalance.privateBalanceId)) continue;
        try {
          const balance = this.#wallet.getPrivateBalanceWeiForWallet
            ? await this.#wallet.getPrivateBalanceWeiForWallet(
                privateBalance.backendWalletName,
              )
            : privateBalance.privateBalanceId === activeProfile.defaultPrivateBalanceId
              ? await this.#wallet.getPrivateBalanceWei()
              : undefined;
          if (balance !== undefined) {
            activePrivateSamples.set(
              privateBalance.privateBalanceId,
              balance.toString(),
            );
          }
        } catch {
          // Preserve this pocket's last-known balance and continue rendering
          // the rest of the hierarchy when one backend sync is unavailable.
        }
        const publicSamples = new Map<string, string>();
        await Promise.all(Object.values(privateBalance.publicChangeAccounts ?? {}).map(
          async (account) => {
            try {
              const balance = await this.#chain.getBalanceWei(account.address);
              publicSamples.set(account.address.toLowerCase(), balance.toString());
            } catch {
              // Preserve this account's last-known balance. A public-change
              // read is never confirmation evidence for the originating send.
            }
          },
        ));
        if (publicSamples.size > 0) {
          activePublicChangeSamples.set(
            privateBalance.privateBalanceId,
            publicSamples,
          );
        }
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
      if (draft.wallet.activeWalletId === activeWalletId && draft.onboarding &&
        activeOnboarding && draft.onboarding.setupId === activeOnboarding.setupId) {
        const profile = draft.wallet.profiles[activeWalletId];
        if (!profile) return;
        let pocketChanged = false;
        for (const [privateBalanceId, balanceWei] of activePrivateSamples) {
          const pocket = profile.privateBalances[privateBalanceId];
          if (!pocket || pocket.balanceWei === balanceWei) continue;
          pocket.balanceWei = balanceWei;
          pocket.revision += 1;
          pocket.updatedAt = observedAt;
          pocketChanged = true;
        }
        for (const [privateBalanceId, samples] of activePublicChangeSamples) {
          for (const [address, balanceWei] of samples) {
            const pocket = profile.privateBalances[privateBalanceId];
            const account = pocket?.publicChangeAccounts?.[address];
            if (!pocket || !account || account.balanceWei === balanceWei) continue;
            refreshPublicChangeAccount({
              profile,
              privateBalanceId,
              address,
              balanceWei: BigInt(balanceWei),
              observedAt,
            });
            pocketChanged = true;
          }
        }
        const aggregate = sumPrivateBalanceRecordsWei(profile).toString();
        if (draft.onboarding.privateBalanceWei !== aggregate || pocketChanged) {
          draft.onboarding.privateBalanceWei = aggregate;
          draft.onboarding.revision += 1;
          draft.onboarding.updatedAt = observedAt;
        }
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
        const privateBalances = Object.values(profile.privateBalances)
          .filter((privateBalance) => privateBalance.status === "available")
          .sort((left, right) => {
            if (left.privateBalanceId === profile.defaultPrivateBalanceId) return -1;
            if (right.privateBalanceId === profile.defaultPrivateBalanceId) return 1;
            return left.name.localeCompare(right.name);
          });
        return {
          shortName: profile.name,
          active,
          setupPhase: onboarding?.phase ?? "not_started",
          ...(onboarding ? {
            policy: walletTreePolicySnapshot(
              onboarding.delegation,
              walletTreeWalletPaymentsUsed(current, profile.authorizationId),
              active,
            ),
          } : {}),
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
          subwallets: privateBalances.map((privateBalance) => {
            const liveBalance = active
              ? activePrivateSamples.get(privateBalance.privateBalanceId)
              : undefined;
            const trackedPublicAccounts = Object.values(
              privateBalance.publicChangeAccounts ?? {},
            );
            const livePublicAccounts = activePublicChangeSamples.get(
              privateBalance.privateBalanceId,
            );
            const publicChangeWei = publicChangeBalanceWei(privateBalance);
            const hasUsableBackend = onboarding?.phase === "private_ready" ||
              privateBalance.privateBalanceId !== profile.defaultPrivateBalanceId;
            return {
              shortName: privateBalance.name,
              role: "private_payment_pocket" as const,
              policy: walletTreePolicySnapshot(
                privateBalance.delegation,
                walletTreePrivateBalancePaymentsUsed(
                  current,
                  privateBalance.privateBalanceId,
                  profile.authorizationId,
                ),
                active,
              ),
              ...(hasUsableBackend ? {
                balanceWei: liveBalance ?? privateBalance.balanceWei,
              } : {}),
              status: hasUsableBackend ? "ready" as const : privateStatus,
              freshness: liveBalance !== undefined
                ? "live" as const
                : hasUsableBackend
                  ? "last_known" as const
                  : "unavailable" as const,
              ...(trackedPublicAccounts.length > 0 ? {
                publicChangeWei: publicChangeWei.toString(),
                publicChangeFreshness: active &&
                    livePublicAccounts?.size === trackedPublicAccounts.length
                  ? "live" as const
                  : "last_known" as const,
              } : {}),
            };
          }),
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

  previewPrivateBalanceCreation(input: {
    name: string;
    walletName?: string;
  }): Promise<Record<string, unknown>> {
    return this.#withWalletOperation(async () => {
      await this.#activateNamedWalletIfNeeded(input.walletName);
      return publicPrivateBalanceCreationPlan(
        await this.#privateBalances.previewCreation({ name: input.name }),
      );
    });
  }

  async getPrivateBalanceCreation(
    decisionId: string,
  ): Promise<Record<string, unknown>> {
    return publicPrivateBalanceCreationPlan(
      await this.#privateBalances.getCreation(decisionId),
    );
  }

  applyPrivateBalanceCreation(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<Record<string, unknown>> {
    return this.#withWalletOperation(async () => {
      if (!input.userConfirmed) {
        return publicPrivateBalanceCreationPlan(
          await this.#privateBalances.cancelCreation(input.decisionId),
        );
      }
      return publicPrivateBalanceCreationRequest(
        await this.#privateBalances.applyCreation(input),
      );
    });
  }

  async getPrivateBalanceCreationRequest(
    requestIdOrDecisionId: string,
  ): Promise<Record<string, unknown>> {
    const requestId = requestIdOrDecisionId.startsWith("pbc_")
      ? uniqueRequestIdForDecision(
          (await this.#store.read()).privateBalanceCreationRequests,
          requestIdOrDecisionId,
          "PRIVATE_BALANCE_CREATION_REQUEST_NOT_FOUND",
        )
      : requestIdOrDecisionId;
    return publicPrivateBalanceCreationRequest(
      await this.#privateBalances.creationStatus(requestId),
    );
  }

  previewPrivateBalanceFunding(input: {
    walletName?: string;
    sourcePrivateBalanceName?: string;
    targetPrivateBalanceName: string;
    amountWei: string;
  }): Promise<Record<string, unknown>> {
    return this.#withWalletOperation(async () => {
      await this.#activateNamedWalletIfNeeded(input.walletName);
      return publicPrivateBalanceFundingPlan(
        await this.#privateBalances.previewFunding({
          source: input.sourcePrivateBalanceName === undefined
            ? { kind: "main" }
            : {
                kind: "private_balance",
                privateBalance: input.sourcePrivateBalanceName,
              },
          targetPrivateBalance: input.targetPrivateBalanceName,
          amountWei: input.amountWei,
        }),
      );
    });
  }

  async getPrivateBalanceFunding(
    decisionId: string,
  ): Promise<Record<string, unknown>> {
    return publicPrivateBalanceFundingPlan(
      await this.#privateBalances.getFunding(decisionId),
    );
  }

  applyPrivateBalanceFunding(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<Record<string, unknown>> {
    return this.#withWalletOperation(async () => {
      if (!input.userConfirmed) {
        return publicPrivateBalanceFundingPlan(
          await this.#privateBalances.cancelFunding(input.decisionId),
        );
      }
      return publicPrivateBalanceFundingRequest(
        await this.#privateBalances.executeFunding(input),
      );
    });
  }

  async getPrivateBalanceFundingRequest(
    requestIdOrDecisionId: string,
  ): Promise<Record<string, unknown>> {
    const requestId = requestIdOrDecisionId.startsWith("pbf_")
      ? uniqueRequestIdForDecision(
          (await this.#store.read()).privateBalanceFundingRequests,
          requestIdOrDecisionId,
          "PRIVATE_BALANCE_FUNDING_REQUEST_NOT_FOUND",
        )
      : requestIdOrDecisionId;
    return publicPrivateBalanceFundingRequest(
      await this.#privateBalances.fundingStatus(requestId),
    );
  }

  privateBalancePolicy(input: {
    walletName?: string;
    privateBalanceName?: string;
  }): Promise<Record<string, unknown>> {
    return this.#withWalletOperation(async () => {
      const state = await this.#store.read();
      const profile = this.#resolveNamedWalletProfile(state, input.walletName);
      const privateBalance = resolvePrivateBalanceRecord(
        profile,
        input.privateBalanceName,
      );
      const result = await this.#privateBalancePolicy.get({
        walletId: profile.walletId,
        privateBalanceId: privateBalance.privateBalanceId,
      });
      return {
        wallet_name: profile.name,
        private_balance_name: result.privateBalance.privateBalanceName,
        policy: result.policy,
      };
    });
  }

  planPrivateBalancePolicyUpdate(input: {
    walletName?: string;
    privateBalanceName?: string;
    perPaymentLimitWei?: string;
    lifetimeLimitWei?: string;
    maxPayments?: number;
    ttlMs?: number;
    enabled?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.#withWalletOperation(async () => {
      const state = await this.#store.read();
      const profile = this.#resolveNamedWalletProfile(state, input.walletName);
      const privateBalance = resolvePrivateBalanceRecord(
        profile,
        input.privateBalanceName,
      );
      return publicPrivateBalancePolicyPlan(
        await this.#privateBalancePolicy.plan({
          walletId: profile.walletId,
          privateBalanceId: privateBalance.privateBalanceId,
          ...(input.perPaymentLimitWei === undefined ? {} : {
            perPaymentLimitWei: input.perPaymentLimitWei,
          }),
          ...(input.lifetimeLimitWei === undefined ? {} : {
            lifetimeLimitWei: input.lifetimeLimitWei,
          }),
          ...(input.maxPayments === undefined ? {} : {
            maxPayments: input.maxPayments,
          }),
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        }),
      );
    });
  }

  async getPrivateBalancePolicyUpdate(
    decisionId: string,
  ): Promise<Record<string, unknown>> {
    return publicPrivateBalancePolicyPlan(
      await this.#privateBalancePolicy.getPlan(decisionId),
    );
  }

  applyPrivateBalancePolicyUpdate(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<Record<string, unknown>> {
    return this.#withWalletOperation(async () => {
      if (!input.userConfirmed) {
        return publicPrivateBalancePolicyPlan(
          await this.#privateBalancePolicy.cancel(input.decisionId),
        );
      }
      return publicPrivateBalancePolicyRequest(
        await this.#privateBalancePolicy.apply(input),
      );
    });
  }

  async getPrivateBalancePolicyUpdateRequest(
    requestIdOrDecisionId: string,
  ): Promise<Record<string, unknown>> {
    const state = await this.#store.read();
    const requestId = requestIdOrDecisionId.startsWith("pbp_")
      ? uniqueRequestIdForDecision(
          state.privateBalancePolicyUpdateRequests,
          requestIdOrDecisionId,
          "PRIVATE_BALANCE_POLICY_REQUEST_NOT_FOUND",
        )
      : requestIdOrDecisionId;
    const request = state.privateBalancePolicyUpdateRequests[requestId];
    if (!request) throw new Error("PRIVATE_BALANCE_POLICY_REQUEST_NOT_FOUND");
    return publicPrivateBalancePolicyRequest(request);
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

  planPrivatePayment(
    input: TransferPlanningReferenceInput,
  ): Promise<PaymentPlan & NamedRecipientResult> {
    return this.#withWalletOperation(async () => {
      const resolved = await this.#resolveTransferPlanningInput(input, "private");
      const state = await this.#store.read();
      const profile = state.wallet?.profiles[state.wallet.activeWalletId];
      if (!profile) throw new Error("ACTIVE_WALLET_PROFILE_MISSING");
      const privateBalance = resolvePrivateBalanceRecord(
        profile,
        input.sourcePrivateBalanceName,
      );
      const plan = await this.#payments.plan({
        recipient: resolved.recipient,
        amountWei: resolved.amountWei,
        privateBalanceId: privateBalance.privateBalanceId,
      });
      return this.#decorateDecisionRecipient(plan, resolved.recipientWalletName);
    });
  }

  planRegularTransfer(
    input: TransferPlanningReferenceInput,
  ): Promise<RegularTransferPlan & NamedRecipientResult> {
    return this.#withWalletOperation(async () => {
      const resolved = await this.#resolveTransferPlanningInput(input, "regular");
      const state = await this.#store.read();
      const profile = state.wallet?.profiles[state.wallet.activeWalletId];
      if (!profile) throw new Error("ACTIVE_WALLET_PROFILE_MISSING");
      const sourcePrivateBalance = input.sourcePrivateBalanceName === undefined
        ? undefined
        : resolvePrivateBalanceRecord(profile, input.sourcePrivateBalanceName);
      const plan = await this.#regularTransfers.plan({
        recipient: resolved.recipient,
        amountWei: resolved.amountWei,
        ...(sourcePrivateBalance === undefined
          ? {}
          : { sourcePrivateBalanceId: sourcePrivateBalance.privateBalanceId }),
      });
      return publicRegularTransferPlan(
        this.#decorateDecisionRecipient(plan, resolved.recipientWalletName),
      );
    });
  }

  walletPolicy(input: { walletName?: string } = {}) {
    return this.#withWalletOperation(async () => {
      const state = await this.#store.read();
      const profile = this.#resolveNamedWalletProfile(state, input.walletName);
      return {
        ...(await this.#policy.get(profile.walletId)),
        wallet: {
          walletId: profile.walletId,
          walletName: profile.name,
          selectionEpoch: profile.selectionEpoch,
        },
      };
    });
  }

  planPolicyUpdate(input: {
    walletName?: string;
    perPaymentLimitWei?: string;
    lifetimeLimitWei?: string;
    maxPayments?: number;
    ttlMs?: number;
    enabled?: boolean;
  }): Promise<PolicyUpdatePlan> {
    return this.#withWalletOperation(async () => {
      const state = await this.#store.read();
      const profile = this.#resolveNamedWalletProfile(state, input.walletName);
      return this.#policy.plan({
        walletId: profile.walletId,
        ...(input.perPaymentLimitWei === undefined ? {} : {
          perPaymentLimitWei: input.perPaymentLimitWei,
        }),
        ...(input.lifetimeLimitWei === undefined ? {} : {
          lifetimeLimitWei: input.lifetimeLimitWei,
        }),
        ...(input.maxPayments === undefined ? {} : {
          maxPayments: input.maxPayments,
        }),
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      });
    });
  }

  getPolicyUpdatePlan(decisionId: string): Promise<PolicyUpdatePlan> {
    return this.#policy.getPlan(decisionId);
  }

  getLatestPolicyUpdatePlan(): Promise<PolicyUpdatePlan> {
    return this.#policy.getLatestPlan();
  }

  cancelPolicyUpdatePlan(decisionId: string): Promise<PolicyUpdatePlan> {
    return this.#withWalletOperation(() => this.#policy.cancel(decisionId));
  }

  applyPolicyUpdate(input: {
    decisionId: string;
    userConfirmed: boolean;
  }): Promise<PolicyUpdateReceipt> {
    return this.#withWalletOperation(() => this.#policy.apply(input));
  }

  async getPaymentPlan(
    decisionId: string,
  ): Promise<PaymentPlan & NamedRecipientResult> {
    return this.#decorateStoredRecipient(await this.#payments.getPlan(decisionId));
  }

  cancelPrivatePaymentPlan(
    decisionId: string,
  ): Promise<PaymentPlan & NamedRecipientResult> {
    return this.#withWalletOperation(async () =>
      this.#decorateStoredRecipient(await this.#payments.cancel(decisionId))
    );
  }

  async getRegularTransferPlan(
    decisionId: string,
  ): Promise<RegularTransferPlan & NamedRecipientResult> {
    return publicRegularTransferPlan(
      await this.#decorateStoredRecipient(
        await this.#regularTransfers.getPlan(decisionId),
      ),
    );
  }

  cancelRegularTransferPlan(
    decisionId: string,
  ): Promise<RegularTransferPlan & NamedRecipientResult> {
    return this.#withWalletOperation(async () =>
      publicRegularTransferPlan(
        await this.#decorateStoredRecipient(
          await this.#regularTransfers.cancel(decisionId),
        ),
      )
    );
  }

  executePrivatePayment(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<PaymentRequest & NamedRecipientResult> {
    return this.#withWalletOperation(async () => {
      const request = publicPaymentRequest(await this.#payments.execute(input));
      return this.#decorateRequestRecipient(request);
    });
  }

  executeRegularTransfer(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<RegularTransferRequest & NamedRecipientResult> {
    return this.#withWalletOperation(async () => {
      const request = publicRegularTransferRequest(
        await this.#regularTransfers.execute(input),
      );
      return this.#decorateRequestRecipient(request);
    });
  }

  async getRequest(
    requestIdOrDecisionId: string,
  ): Promise<PaymentRequest & NamedRecipientResult> {
    const requestId = requestIdOrDecisionId.startsWith("wd_")
      ? uniqueRequestIdForDecision(
          (await this.#store.read()).requests,
          requestIdOrDecisionId,
          "REQUEST_NOT_FOUND",
        )
      : requestIdOrDecisionId;
    return this.#decorateRequestRecipient(
      publicPaymentRequest(await this.#payments.getRequest(requestId)),
    );
  }

  async getRegularTransferRequest(
    requestIdOrDecisionId: string,
  ): Promise<RegularTransferRequest & NamedRecipientResult> {
    const requestId = requestIdOrDecisionId.startsWith("rwd_")
      ? uniqueRequestIdForDecision(
          (await this.#store.read()).regularRequests,
          requestIdOrDecisionId,
          "REGULAR_TRANSFER_REQUEST_NOT_FOUND",
        )
      : requestIdOrDecisionId;
    return this.#decorateRequestRecipient(
      publicRegularTransferRequest(
        await this.#regularTransfers.getRequest(requestId),
      ),
    );
  }

  listWallets(): Promise<Record<string, unknown>> {
    return this.#withWalletOperation(() => this.#listWalletsUnlocked());
  }

  async #listWalletsUnlocked(): Promise<Record<string, unknown>> {
    const state = await this.#store.read();
    const profiles = Object.values(state.wallet?.profiles ?? {}).sort((left, right) => {
      if (left.walletId === state.wallet?.activeWalletId) return -1;
      if (right.walletId === state.wallet?.activeWalletId) return 1;
      if (left.status !== right.status) return left.status === "available" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    const wallets = profiles.map((profile) => publicWalletProfile(profile, state));
    const registeredNames = new Set(profiles.map((profile) => profile.name));
    const privateBackendNames = new Set(profiles.flatMap((profile) =>
      Object.values(profile.privateBalances).map(
        (privateBalance) => privateBalance.backendWalletName,
      )
    ));
    let localInventoryStatus: "ready" | "unavailable" | "unsupported" = "unsupported";
    let unregisteredLocalWallets: Array<{
      name: string;
      network: "sepolia" | "mainnet" | "unknown";
      adoptable: boolean;
    }> = [];
    if (this.#wallet.listWallets) {
      try {
        const inventory = await this.#wallet.listWallets();
        localInventoryStatus = "ready";
        unregisteredLocalWallets = inventory
          .filter((wallet) =>
            !registeredNames.has(wallet.name) &&
            !privateBackendNames.has(wallet.name)
          )
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((wallet) => ({
            name: wallet.name,
            network: wallet.network,
            adoptable: wallet.network === "sepolia",
          }));
      } catch {
        // Registered profiles remain selectable even if Kohaku inventory is
        // temporarily unreadable. Adoption fails closed until it is healthy.
        localInventoryStatus = "unavailable";
      }
    }
    return {
      active_wallet_id: wallets.find((wallet) => wallet.active)?.wallet_id,
      wallets,
      unregistered_local_wallets: unregisteredLocalWallets,
      local_inventory_status: localInventoryStatus,
      counts: {
        registered: wallets.length,
        available: wallets.filter((wallet) => wallet.status === "available").length,
        archived: wallets.filter((wallet) => wallet.status === "archived").length,
        unregistered_local: unregisteredLocalWallets.length,
        adoptable_local: unregisteredLocalWallets.filter((wallet) => wallet.adoptable).length,
      },
    };
  }

  async createWallet(input: {
    name: string;
    userConfirmed: boolean;
  } & ExpectedActiveWalletInput): Promise<Record<string, unknown>> {
    if (!input.userConfirmed) {
      throw new Error("The user must confirm creating and selecting a new wallet");
    }
    if (!this.#wallet.listWallets || !this.#wallet.selectWallet) {
      throw new Error("WALLET_MANAGEMENT_UNAVAILABLE");
    }
    return this.#withWalletOperation(async () => {
      const before = await this.#store.read();
      assertExpectedActiveWallet(
        before,
        input,
        "create a wallet",
      );
      const inventory = await this.#wallet.listWallets!();
      if (inventory.some((wallet) => wallet.name === input.name)) {
        throw new Error("WALLET_NAME_ALREADY_EXISTS");
      }
      const previousName = before.wallet?.activeName ??
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
      const setup = await this.#continueSelectedWalletSetup(activated.current.onboarding);
      const current = await this.#store.read();
      const selected = current.wallet!.profiles[activated.profile.walletId]!;
      const authorization = walletAuthorizationStatus(selected, current);
      return {
        wallet: publicWalletProfile(selected, current),
        archive_id: activated.archiveId,
        ...setup,
        authorization_required: authorization !== "active",
        authorization_status: authorization,
      };
    });
  }

  async adoptWallet(input: {
    name: string;
    userConfirmed: boolean;
  } & ExpectedActiveWalletInput): Promise<Record<string, unknown>> {
    if (!input.userConfirmed) {
      throw new Error("The user must confirm adopting and selecting the wallet");
    }
    if (!this.#wallet.listWallets || !this.#wallet.selectWallet) {
      throw new Error("WALLET_MANAGEMENT_UNAVAILABLE");
    }
    return this.#withWalletOperation(async () => {
      const before = await this.#store.read();
      assertExpectedActiveWallet(
        before,
        input,
        "adopt a wallet",
      );
      const inventory = await this.#wallet.listWallets!();
      const localWallet = inventory.find((wallet) => wallet.name === input.name);
      if (!localWallet) throw new Error("LOCAL_WALLET_NOT_FOUND");
      if (localWallet.network !== "sepolia") {
        throw new Error("ONLY_SEPOLIA_WALLETS_CAN_BE_ADOPTED");
      }
      const existing = Object.values(before.wallet?.profiles ?? {}).find(
        (profile) => profile.name === input.name,
      );
      if (existing && before.wallet?.activeWalletId === existing.walletId) {
        const authorization = walletAuthorizationStatus(existing, before);
        const setup = before.onboarding ?? existing.onboarding;
        return {
          wallet: publicWalletProfile(existing, before),
          changed: false,
          ...(setup
            ? walletLifecycleSetup(setup)
            : { setup_phase: "not_started" as const }),
          authorization_required: authorization !== "active",
          authorization_status: authorization,
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
      const setup = await this.#continueSelectedWalletSetup(activated.current.onboarding);
      const current = await this.#store.read();
      const selected = current.wallet!.profiles[activated.profile.walletId]!;
      const authorization = walletAuthorizationStatus(selected, current);
      return {
        wallet: publicWalletProfile(selected, current),
        changed: true,
        archive_id: activated.archiveId,
        ...setup,
        authorization_required: authorization !== "active",
        authorization_status: authorization,
      };
    });
  }

  async selectWallet(input: {
    walletId: string;
    userConfirmed: boolean;
    expectedActiveWalletName?: string;
    expectedActiveSelectionEpoch?: number;
  }): Promise<Record<string, unknown>> {
    if (!this.#wallet.selectWallet || !this.#wallet.listWallets) {
      throw new Error("WALLET_MANAGEMENT_UNAVAILABLE");
    }
    return this.#withWalletOperation(async () => {
      const before = await this.#store.read();
      const profile = before.wallet?.profiles[input.walletId];
      if (!profile) throw new Error("WALLET_NOT_FOUND");
      const hasExpectedActiveName = input.expectedActiveWalletName !== undefined;
      const hasExpectedActiveEpoch = input.expectedActiveSelectionEpoch !== undefined;
      if (hasExpectedActiveName !== hasExpectedActiveEpoch) {
        throw new AgentBoostRequestError(
          "WALLET_SWITCH_BINDING_REQUIRED",
          "Both active-wallet binding fields from the switch preview are required together.",
          {
            required_fields: [
              "expected_active_wallet_name",
              "expected_active_selection_epoch",
            ],
          },
        );
      }
      if (hasExpectedActiveName && hasExpectedActiveEpoch) {
        const active = before.wallet?.profiles[before.wallet.activeWalletId];
        if (
          !active ||
          active.name !== input.expectedActiveWalletName ||
          active.selectionEpoch !== input.expectedActiveSelectionEpoch
        ) {
          throw new AgentBoostRequestError(
            "WALLET_SWITCH_PREVIEW_STALE",
            "The active wallet changed after this switch preview. Nothing was changed; review the current saved profiles and create a new switch preview.",
            {
              expected_active_wallet_name: input.expectedActiveWalletName,
              expected_active_selection_epoch: input.expectedActiveSelectionEpoch,
              ...(active
                ? {
                    active_wallet_name: active.name,
                    active_selection_epoch: active.selectionEpoch,
                  }
                : {}),
            },
          );
        }
      }
      if (before.wallet?.activeName === profile.name) {
        const authorization = walletAuthorizationStatus(profile, before);
        const setup = before.onboarding ?? profile.onboarding;
        return {
          wallet: publicWalletProfile(profile, before),
          changed: false,
          ...(setup
            ? walletLifecycleSetup(setup)
            : { setup_phase: "not_started" as const }),
          authorization_required: authorization !== "active",
          authorization_status: authorization,
        };
      }
      if (!input.userConfirmed) {
        throw new Error("The user must confirm changing the active wallet");
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
      const setup = await this.#continueSelectedWalletSetup(activated.current.onboarding);
      const current = await this.#store.read();
      const selected = current.wallet!.profiles[activated.profile.walletId]!;
      const authorization = walletAuthorizationStatus(selected, current);
      return {
        wallet: publicWalletProfile(selected, current),
        changed: true,
        archive_id: activated.archiveId,
        ...setup,
        authorization_required: authorization !== "active",
        authorization_status: authorization,
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
        (request) => request.phase !== "failed" &&
          request.authorization.authorizationId === profile.authorizationId,
      ).length + Object.values(state.regularRequests).filter(
        (request) => request.phase !== "failed" &&
          request.authorization.authorizationId === profile.authorizationId,
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

  cancelWalletReauthorizationPlan(decisionId: string): Promise<WalletReauthorizationPlan> {
    return this.#withWalletOperation(() => this.#store.cancelReauthorizationPlan(decisionId));
  }

  planRecoveryTransfer(
    input: TransferPlanningReferenceInput,
  ): Promise<RecoveryTransferPlan & NamedRecipientResult> {
    return this.#withWalletOperation(async () => {
      const resolved = await this.#resolveTransferPlanningInput(input, "recovery");
      const state = await this.#store.read();
      const profile = state.wallet?.profiles[state.wallet.activeWalletId];
      if (!profile) throw new Error("ACTIVE_WALLET_PROFILE_MISSING");
      const privateBalance = resolvePrivateBalanceRecord(
        profile,
        input.sourcePrivateBalanceName,
      );
      const plan = await this.#recovery.plan({
        recipient: resolved.recipient,
        amountWei: resolved.amountWei,
        privateBalanceId: privateBalance.privateBalanceId,
      });
      return this.#decorateDecisionRecipient(plan, resolved.recipientWalletName);
    });
  }

  #decorateDecisionRecipient<T extends { decisionId: string; recipient: string }>(
    value: T,
    recipientWalletName: string | undefined,
  ): T & NamedRecipientResult {
    if (recipientWalletName === undefined) return value;
    this.#rememberRecipientWalletName(value.decisionId, recipientWalletName);
    return { ...value, recipientWalletName };
  }

  #rememberRecipientWalletName(decisionId: string, walletName: string): void {
    // Refresh insertion order so the bounded map behaves like a tiny LRU.
    this.#recipientWalletNamesByDecision.delete(decisionId);
    this.#recipientWalletNamesByDecision.set(decisionId, walletName);
    while (this.#recipientWalletNamesByDecision.size > TRANSIENT_RECIPIENT_LABEL_LIMIT) {
      const oldest = this.#recipientWalletNamesByDecision.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.#recipientWalletNamesByDecision.delete(oldest);
    }
  }

  async #decorateStoredRecipient<
    T extends { decisionId: string; recipient: string },
  >(value: T): Promise<T & NamedRecipientResult> {
    const recipientWalletName = this.#recipientWalletNamesByDecision.get(value.decisionId) ??
      await this.#uniqueWalletNameForAddress(value.recipient);
    return this.#decorateDecisionRecipient(value, recipientWalletName);
  }

  async #decorateRequestRecipient<
    T extends { requestId: string; decisionId: string; recipient: string },
  >(value: T): Promise<T & NamedRecipientResult> {
    let recipientWalletName = this.#recipientWalletNamesByDecision.get(value.decisionId);
    if (recipientWalletName === undefined) {
      try {
        recipientWalletName = await this.#uniqueWalletNameForAddress(value.recipient);
      } catch {
        // The request is already durable and may already have been broadcast.
        // A presentation-only friendly-name lookup must never hide that request
        // from execute or status callers, since doing so would also hide the
        // stable request ID needed for safe reconciliation.
        return value;
      }
    }
    if (recipientWalletName === undefined) return value;
    this.#rememberRecipientWalletName(value.decisionId, recipientWalletName);
    return { ...value, recipientWalletName };
  }

  async #uniqueWalletNameForAddress(address: string): Promise<string | undefined> {
    const state = await this.#store.read();
    const matches = Object.values(state.wallet?.profiles ?? {}).filter((profile) => {
      const onboarding = profile.walletId === state.wallet?.activeWalletId
        ? state.onboarding
        : profile.onboarding;
      return onboarding?.address?.toLowerCase() === address.toLowerCase();
    });
    return matches.length === 1 ? matches[0]!.name : undefined;
  }

  async #resolveTransferPlanningInput(
    input: TransferPlanningReferenceInput,
    kind: TransferPlanningKind,
  ): Promise<{ recipient: string; recipientWalletName?: string; amountWei: string }> {
    if ((input.recipient === undefined) === (input.recipientWalletName === undefined)) {
      throw new AgentBoostRequestError(
        "TRANSFER_RECIPIENT_REFERENCE_CONFLICT",
        "Provide exactly one recipient address or saved wallet friendly name.",
      );
    }

    const state = await this.#store.read();
    const profiles = Object.values(state.wallet?.profiles ?? {});
    const active = state.wallet?.profiles[state.wallet.activeWalletId];
    if (!active) throw new Error("ACTIVE_WALLET_PROFILE_MISSING");

    let source = active;
    let sourceSwitchRequired = false;
    if (input.sourceWalletName !== undefined) {
      source = resolveFriendlyWalletProfile(
        profiles,
        input.sourceWalletName,
        "source",
      );
      if (source.status === "archived") {
        throw new AgentBoostRequestError(
          "SOURCE_WALLET_ARCHIVED",
          `Saved wallet ${source.name} is archived and cannot be a transfer source.`,
          { source_wallet_name: source.name },
        );
      }
      if (source.walletId !== active.walletId) {
        sourceSwitchRequired = true;
      }
    }

    const sourceOnboarding = source.walletId === state.wallet?.activeWalletId
      ? state.onboarding
      : source.onboarding;
    if (
      sourceOnboarding &&
      sourceOnboarding.delegation.chainId !== SEPOLIA_CHAIN_ID
    ) {
      throw new AgentBoostRequestError(
        "SOURCE_WALLET_NETWORK_UNSUPPORTED",
        `Saved wallet ${source.name} is not a Sepolia wallet.`,
        { source_wallet_name: source.name, required_network: "Sepolia" },
      );
    }

    let recipient = input.recipient;
    let recipientWalletName: string | undefined;
    let recipientProfile: WalletProfileRecord | undefined;
    if (input.recipientWalletName !== undefined) {
      recipientProfile = resolveFriendlyWalletProfile(
        profiles,
        input.recipientWalletName,
        "recipient",
      );
      if (recipientProfile.status === "archived") {
        throw new AgentBoostRequestError(
          "RECIPIENT_WALLET_ARCHIVED",
          `Saved wallet ${recipientProfile.name} is archived and cannot be used as a named recipient.`,
          { recipient_wallet_name: recipientProfile.name },
        );
      }
      const onboarding = recipientProfile.walletId === state.wallet?.activeWalletId
        ? state.onboarding
        : recipientProfile.onboarding;
      if (onboarding?.delegation.chainId !== SEPOLIA_CHAIN_ID) {
        throw new AgentBoostRequestError(
          onboarding
            ? "RECIPIENT_WALLET_NETWORK_UNSUPPORTED"
            : "RECIPIENT_WALLET_MAIN_ADDRESS_UNAVAILABLE",
          onboarding
            ? `Saved wallet ${recipientProfile.name} is not a Sepolia wallet.`
            : `Saved wallet ${recipientProfile.name} does not have a known Sepolia main receiving address yet.`,
          {
            recipient_wallet_name: recipientProfile.name,
            resolved_account: "main",
            required_network: "Sepolia",
          },
        );
      }
      if (!onboarding.address || !/^0x[0-9a-fA-F]{40}$/u.test(onboarding.address)) {
        throw new AgentBoostRequestError(
          "RECIPIENT_WALLET_MAIN_ADDRESS_UNAVAILABLE",
          `Saved wallet ${recipientProfile.name} does not have a known Sepolia main receiving address yet.`,
          {
            recipient_wallet_name: recipientProfile.name,
            resolved_account: "main",
            required_network: "Sepolia",
          },
        );
      }
      recipient = onboarding.address;
      recipientWalletName = recipientProfile.name;
    }

    if (!recipient) throw new Error("TRANSFER_RECIPIENT_MISSING");
    const sourceAddress = sourceOnboarding?.address;
    const sendsToSourceMain = recipientProfile?.walletId === source.walletId ||
      (sourceAddress !== undefined && recipient.toLowerCase() === sourceAddress.toLowerCase());
    // A regular same-main send is invalid regardless of which profile happens
    // to be active, so do not ask the user to approve a pointless switch first.
    if (
      kind === "regular" &&
      input.sourcePrivateBalanceName === undefined &&
      sendsToSourceMain
    ) {
      throw new AgentBoostRequestError(
        "REGULAR_TRANSFER_SELF_SEND_BLOCKED",
        `A regular transfer cannot send from ${source.name} main back to the same main account.`,
        {
          source_wallet_name: source.name,
          ...(recipientWalletName === undefined
            ? {}
            : { recipient_wallet_name: recipientWalletName }),
        },
      );
    }
    if (kind === "private" && sendsToSourceMain) {
      throw new AgentBoostRequestError(
        "USE_RECOVERY_TRANSFER",
        `Moving private funds to ${source.name} main is a recovery transfer, not a private payment. Create an exact recovery-transfer preview instead.`,
        {
          source_wallet_name: source.name,
          recipient_wallet_name: recipientWalletName ?? source.name,
          resolved_account: "main",
          required_action: "plan_recovery_transfer",
        },
      );
    }

    if (sourceSwitchRequired) {
      await this.#activateWalletForNamedOperation(source, state);
    }

    return {
      recipient,
      ...(recipientWalletName === undefined ? {} : { recipientWalletName }),
      amountWei: input.amountWei,
    };
  }

  async getRecoveryPlan(
    decisionId: string,
  ): Promise<RecoveryTransferPlan & NamedRecipientResult> {
    return this.#decorateStoredRecipient(await this.#recovery.getPlan(decisionId));
  }

  cancelRecoveryPlan(
    decisionId: string,
  ): Promise<RecoveryTransferPlan & NamedRecipientResult> {
    return this.#withWalletOperation(async () =>
      this.#decorateStoredRecipient(await this.#recovery.cancel(decisionId))
    );
  }

  executeRecoveryTransfer(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<RecoveryTransferRequest & NamedRecipientResult> {
    return this.#withWalletOperation(async () => {
      const request = publicRecoveryRequest(await this.#recovery.execute(input));
      return this.#decorateRequestRecipient(request);
    });
  }

  async getRecoveryRequest(
    requestIdOrDecisionId: string,
  ): Promise<RecoveryTransferRequest & NamedRecipientResult> {
    const requestId = requestIdOrDecisionId.startsWith("wr_")
      ? uniqueRequestIdForDecision(
          (await this.#store.read()).recoveryRequests,
          requestIdOrDecisionId,
          "RECOVERY_REQUEST_NOT_FOUND",
        )
      : requestIdOrDecisionId;
    return this.#decorateRequestRecipient(
      publicRecoveryRequest(await this.#recovery.getRequest(requestId)),
    );
  }

  startNewDemo(
    input: { userConfirmed: boolean } & ExpectedActiveWalletInput,
  ): Promise<NewDemoResult> {
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
    return this.#withWalletOperation(() => this.#startNewDemo(input));
  }

  async status(): Promise<Record<string, unknown>> {
    const state = await this.#store.read();
    return {
      state_path: this.#store.path,
      onboarding: state.onboarding,
      requests: Object.values(state.requests),
      regular_requests: Object.values(state.regularRequests),
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

  async #startNewDemo(input: ExpectedActiveWalletInput): Promise<NewDemoResult> {
    const before = await this.#store.read();
    assertExpectedActiveWallet(
      before,
      input,
      "archive this workflow and start a new demo wallet",
    );
    await this.#onboarding.stop();
    await this.#payments.stop();
    await this.#regularTransfers.stop();
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
      this.#regularTransfers.resetForWalletSelection();
      this.#recovery.resetForWalletSelection();
      await this.#onboarding.resume().catch(() => undefined);
      throw error;
    }
    this.#payments.resetForNewDemo();
    this.#regularTransfers.resetForWalletSelection();
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

  async #activateNamedWalletIfNeeded(
    walletName: string | undefined,
  ): Promise<WalletProfileRecord> {
    const before = await this.#store.read();
    const active = this.#resolveNamedWalletProfile(before);
    const profile = this.#resolveNamedWalletProfile(before, walletName);
    if (profile.walletId === active.walletId) return active;
    await this.#activateWalletForNamedOperation(profile, before);
    const after = await this.#store.read();
    const selected = after.wallet?.profiles[after.wallet.activeWalletId];
    if (!selected || selected.walletId !== profile.walletId) {
      throw new Error("WALLET_SELECTION_CHANGED");
    }
    return selected;
  }

  #resolveNamedWalletProfile(
    state: StateDocument,
    walletName?: string,
  ): WalletProfileRecord {
    const active = state.wallet?.profiles[state.wallet.activeWalletId];
    if (!active) throw new Error("ACTIVE_WALLET_PROFILE_MISSING");
    if (walletName === undefined) return active;
    const profile = resolveFriendlyWalletProfile(
      Object.values(state.wallet?.profiles ?? {}),
      walletName,
      "source",
    );
    if (profile.status === "archived") {
      throw new AgentBoostRequestError(
        "SOURCE_WALLET_ARCHIVED",
        `Saved wallet ${profile.name} is archived and cannot be targeted.`,
        { source_wallet_name: profile.name },
      );
    }
    return profile;
  }

  async #activateWalletForNamedOperation(
    profile: WalletProfileRecord,
    before: StateDocument,
  ): Promise<void> {
    if (!this.#wallet.selectWallet) {
      throw new AgentBoostRequestError(
        "SOURCE_WALLET_LOAD_UNAVAILABLE",
        `Saved wallet ${profile.name} cannot be loaded by this wallet adapter.`,
        { source_wallet_name: profile.name },
      );
    }
    const previousName = before.wallet?.activeName ?? this.#config.kohakuWalletName;
    await this.#stopWalletWork();
    this.#wallet.selectWallet(profile.name);
    let activated: Awaited<ReturnType<StateStore["activateWalletProfile"]>>;
    try {
      activated = await this.#store.activateWalletProfile(profile.walletId);
    } catch (error) {
      this.#wallet.selectWallet(previousName);
      this.#resetWalletControllers();
      await this.#onboarding.resume().catch(() => undefined);
      throw error;
    }
    this.#resetWalletControllers();
    await this.#continueSelectedWalletSetup(activated.current.onboarding);
  }

  async #continueSelectedWalletSetup(
    setup: OnboardingRecord | undefined,
  ): Promise<WalletLifecycleSetupResult> {
    try {
      if (setup) {
        await this.#onboarding.resume();
        return walletLifecycleSetup(await this.#onboarding.getRecord());
      }
      const started = await this.#startOnboardingUnlocked();
      return walletLifecycleSetup(started.snapshot);
    } catch {
      // Adapter selection and durable profile activation already committed.
      // A nonessential startup/resume failure must not turn that success into a
      // misleading rejected mutation or invite the caller to repeat it.
      return {
        setup_phase: setup?.phase ?? "not_started",
        setup_continuation_status: "unavailable",
      };
    }
  }

  async #stopWalletWork(): Promise<void> {
    await this.#onboarding.stop();
    await this.#payments.stop();
    await this.#regularTransfers.stop();
    await this.#recovery.stop();
    await this.#privateBalances.stop();
  }

  #resetWalletControllers(): void {
    this.#payments.resetForNewDemo();
    this.#regularTransfers.resetForWalletSelection();
    this.#recovery.resetForWalletSelection();
    this.#privateBalances.resetForWalletSelection();
  }
}

function uniqueRequestIdForDecision<T extends { requestId: string; decisionId: string }>(
  requests: Record<string, T>,
  decisionId: string,
  notFoundCode: string,
): string {
  const matches = Object.values(requests).filter(
    (request) => request.decisionId === decisionId,
  );
  if (matches.length === 0) throw new Error(notFoundCode);
  if (matches.length !== 1) throw new Error("DECISION_REQUEST_BINDING_AMBIGUOUS");
  return matches[0]!.requestId;
}

function publicPaymentRequest(request: PaymentRequest): PaymentRequest {
  const publicRequest = { ...request };
  delete publicRequest.broadcastStartedAt;
  delete publicRequest.recipientBalanceBeforeWei;
  delete publicRequest.reconciliation;
  return publicRequest;
}

function publicRegularTransferRequest(
  request: RegularTransferRequest,
): RegularTransferRequest {
  const publicRequest = { ...request };
  if (request.sourcePrivateBalance) {
    publicRequest.sourcePrivateBalance = publicPrivateBalanceBinding(
      request.sourcePrivateBalance,
    ) as unknown as typeof request.sourcePrivateBalance;
  }
  delete publicRequest.sourcePublicAddress;
  delete publicRequest.broadcastStartedAt;
  delete publicRequest.policySpendDebitedAt;
  delete publicRequest.policySpendRestoredAt;
  delete publicRequest.privatePolicySpendDebitedAt;
  delete publicRequest.privatePolicySpendRestoredAt;
  delete publicRequest.recipientBalanceBeforeWei;
  delete publicRequest.reconciliation;
  return publicRequest;
}

function publicRegularTransferPlan(
  plan: RegularTransferPlan & NamedRecipientResult,
): RegularTransferPlan & NamedRecipientResult {
  const publicPlan = { ...plan };
  if (plan.sourcePrivateBalance) {
    publicPlan.sourcePrivateBalance = publicPrivateBalanceBinding(
      plan.sourcePrivateBalance,
    ) as unknown as typeof plan.sourcePrivateBalance;
  }
  delete publicPlan.sourcePublicAddress;
  return publicPlan;
}

function publicPrivateBalanceBinding(
  binding: import("./contracts.js").PrivateBalanceBinding,
): Record<string, unknown> {
  const { backendWalletName: _backendWalletName, ...publicBinding } = binding;
  return publicBinding;
}

function publicPrivateBalanceCreationPlan(
  plan: PrivateBalanceCreationPlan,
): Record<string, unknown> {
  const { backendWalletName: _backendWalletName, ...publicPlan } = plan;
  return publicPlan;
}

function publicPrivateBalanceCreationRequest(
  request: PrivateBalanceCreationRequest,
): Record<string, unknown> {
  return {
    ...request,
    privateBalance: publicPrivateBalanceBinding(request.privateBalance),
  };
}

function publicPrivateBalanceFundingPlan(
  plan: PrivateBalanceFundingPlan,
): Record<string, unknown> {
  const {
    sourceExecutorAddress: _sourceExecutorAddress,
    targetCommitment: _targetCommitment,
    preparedDepositCall: _preparedDepositCall,
    ...publicPlan
  } = plan;
  return {
    ...publicPlan,
    ...(plan.sourcePrivateBalance ? {
      sourcePrivateBalance: publicPrivateBalanceBinding(
        plan.sourcePrivateBalance,
      ),
    } : {}),
    targetPrivateBalance: publicPrivateBalanceBinding(
      plan.targetPrivateBalance,
    ),
  };
}

function publicPrivateBalanceFundingRequest(
  request: PrivateBalanceFundingRequest,
): Record<string, unknown> {
  const {
    targetCommitment: _targetCommitment,
    preparedDepositCall: _preparedDepositCall,
    ...publicRequest
  } = request;
  return {
    ...publicRequest,
    ...(request.sourcePrivateBalance ? {
      sourcePrivateBalance: publicPrivateBalanceBinding(
        request.sourcePrivateBalance,
      ),
    } : {}),
    targetPrivateBalance: publicPrivateBalanceBinding(
      request.targetPrivateBalance,
    ),
  };
}

function publicPrivateBalancePolicyPlan(
  plan: PrivateBalancePolicyUpdatePlan,
): Record<string, unknown> {
  return {
    ...plan,
    privateBalance: publicPrivateBalanceBinding(plan.privateBalance),
  };
}

function publicPrivateBalancePolicyRequest(
  request: PrivateBalancePolicyUpdateRequest,
): Record<string, unknown> {
  return {
    ...request,
    privateBalance: publicPrivateBalanceBinding(request.privateBalance),
  };
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

function walletTreePolicySnapshot(
  policy: DelegationPolicy,
  paymentsUsed: number,
  active: boolean,
): WalletTreePolicySnapshot {
  return {
    ...policy,
    paymentsUsed,
    paymentsRemaining: Math.max(0, policy.maxPayments - paymentsUsed),
    freshness: active ? "current" : "last_known",
  };
}

function walletTreeWalletPaymentsUsed(
  state: StateDocument,
  authorizationId: string | undefined,
): number {
  if (!authorizationId) return 0;
  return Object.values(state.requests).filter((request) =>
    request.phase !== "failed" &&
    request.authorization.authorizationId === authorizationId
  ).length + Object.values(state.regularRequests).filter((request) =>
    request.phase !== "failed" &&
    request.authorization.authorizationId === authorizationId
  ).length;
}

function walletTreePrivateBalancePaymentsUsed(
  state: StateDocument,
  privateBalanceId: string,
  authorizationId: string | undefined,
): number {
  if (!authorizationId) return 0;
  return Object.values(state.requests).filter((request) =>
    request.privateBalanceId === privateBalanceId &&
    request.phase !== "failed" &&
    request.authorization.authorizationId === authorizationId
  ).length + Object.values(state.regularRequests).filter((request) =>
    request.sourcePrivateBalance?.privateBalanceId === privateBalanceId &&
    request.phase !== "failed" &&
    request.authorization.authorizationId === authorizationId
  ).length;
}

function sumPrivateBalanceRecordsWei(profile: WalletProfileRecord): bigint {
  return Object.values(profile.privateBalances).reduce(
    (sum, privateBalance) => privateBalance.status === "available"
      ? sum + BigInt(privateBalance.balanceWei)
      : sum,
    0n,
  );
}

function unresolvedPrivateBalanceIds(state: StateDocument): Set<string> {
  const unresolved = (phase: string): boolean =>
    phase === "executing" || phase === "submitted" || phase === "indeterminate";
  const ids = new Set<string>();
  for (const request of Object.values(state.requests)) {
    if (request.privateBalanceId && unresolved(request.phase)) {
      ids.add(request.privateBalanceId);
    }
  }
  for (const request of Object.values(state.recoveryRequests)) {
    if (request.privateBalanceId && unresolved(request.phase)) {
      ids.add(request.privateBalanceId);
    }
  }
  for (const request of Object.values(state.regularRequests)) {
    if (request.sourcePrivateBalance && unresolved(request.phase)) {
      ids.add(request.sourcePrivateBalance.privateBalanceId);
    }
  }
  for (const request of Object.values(state.privateBalanceFundingRequests)) {
    if (!unresolved(request.phase)) continue;
    ids.add(request.targetPrivateBalance.privateBalanceId);
    if (request.sourcePrivateBalance) {
      ids.add(request.sourcePrivateBalance.privateBalanceId);
    }
  }
  return ids;
}

function resolvePrivateBalanceRecord(
  profile: WalletProfileRecord,
  reference: string | undefined,
): PrivateBalanceRecord {
  if (reference === undefined) {
    const defaultPrivateBalance =
      profile.privateBalances[profile.defaultPrivateBalanceId];
    if (!defaultPrivateBalance) throw new Error("PRIVATE_BALANCE_NOT_FOUND");
    return defaultPrivateBalance;
  }
  const requested = reference.trim();
  const balances = Object.values(profile.privateBalances);
  const exact = balances.filter((balance) => balance.name === requested);
  const folded = exact.length === 0
    ? balances.filter(
        (balance) => balance.name.toLowerCase() === requested.toLowerCase(),
      )
    : exact;
  if (folded.length > 1) throw new Error("PRIVATE_BALANCE_AMBIGUOUS");
  const privateBalance = folded[0];
  if (!privateBalance) throw new Error("PRIVATE_BALANCE_NOT_FOUND");
  if (privateBalance.status !== "available") {
    throw new Error("PRIVATE_BALANCE_ARCHIVED");
  }
  return privateBalance;
}

function resolveFriendlyWalletProfile(
  profiles: WalletProfileRecord[],
  reference: string,
  role: "source" | "recipient",
): WalletProfileRecord {
  const requested = reference.trim();
  const exact = profiles.filter((profile) => profile.name === requested);
  if (exact.length === 1) return exact[0]!;

  const caseFolded = requested.toLowerCase();
  const caseMatches = profiles.filter(
    (profile) => profile.name.toLowerCase() === caseFolded,
  );
  if (caseMatches.length === 1) return caseMatches[0]!;
  if (caseMatches.length > 1) {
    throw ambiguousWalletReference(role, requested, caseMatches);
  }

  const referenceKeys = humanWalletReferenceKeys(requested);
  const normalized = profiles.filter((profile) => {
    const profileKeys = humanWalletReferenceKeys(profile.name);
    return [...referenceKeys].some((key) => profileKeys.has(key));
  });
  if (normalized.length === 1) return normalized[0]!;
  if (normalized.length > 1) {
    throw ambiguousWalletReference(role, requested, normalized);
  }

  if (
    role === "recipient" &&
    [...referenceKeys].some((key) =>
      key === "private" || key === "privateaccount" ||
      key === "main" || key === "mainaccount"
    )
  ) {
    throw new AgentBoostRequestError(
      "RECIPIENT_PRIVATE_ACCOUNT_UNSUPPORTED",
      `${requested || "That label"} names a wallet view, not a saved wallet profile. Provide a saved profile friendly name; Agent Boost resolves that profile to its Sepolia main/public receiving address, never its private pocket.`,
      {
        requested_wallet_name: requested,
        required_recipient: "saved_profile_name_or_sepolia_address",
        resolved_account: "main",
      },
    );
  }

  const code = role === "source"
    ? "SOURCE_WALLET_NOT_FOUND"
    : "RECIPIENT_WALLET_NOT_FOUND";
  throw new AgentBoostRequestError(
    code,
    `No saved wallet profile uniquely matches ${requested || "the empty name"}.`,
    { requested_wallet_name: requested },
  );
}

function ambiguousWalletReference(
  role: "source" | "recipient",
  requested: string,
  matches: WalletProfileRecord[],
): AgentBoostRequestError {
  return new AgentBoostRequestError(
    role === "source" ? "SOURCE_WALLET_AMBIGUOUS" : "RECIPIENT_WALLET_AMBIGUOUS",
    `More than one saved wallet profile matches ${requested}; use an exact friendly name.`,
    {
      requested_wallet_name: requested,
      matching_wallet_names: matches.map((profile) => profile.name).sort(),
    },
  );
}

function humanWalletReferenceKeys(reference: string): Set<string> {
  const tokens = reference
    .trim()
    .toLowerCase()
    .split(/[\s_-]+/u)
    .filter(Boolean);
  const variants: string[][] = [];
  const queue: string[][] = [tokens];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const variant = queue.shift()!;
    const key = variant.join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(variant);
    if (variant[0] === "my" || variant[0] === "the") queue.push(variant.slice(1));
    if (["wallet", "profile", "account"].includes(variant.at(-1) ?? "")) {
      queue.push(variant.slice(0, -1));
    }
    if (
      ["wallet", "profile", "account"].includes(variant[0] ?? "") &&
      (variant[1] === "called" || variant[1] === "named")
    ) {
      queue.push(variant.slice(2));
    }
    if (variant[0] === "called" || variant[0] === "named") {
      queue.push(variant.slice(1));
    }
  }
  return new Set(variants.map((variant) => variant.join("")).filter(Boolean));
}

function publicRecoveryRequest(
  request: RecoveryTransferRequest,
): RecoveryTransferRequest {
  const publicRequest = { ...request };
  delete publicRequest.broadcastStartedAt;
  delete publicRequest.recipientBalanceBeforeWei;
  delete publicRequest.reconciliation;
  return publicRequest;
}

function assertExpectedActiveWallet(
  state: StateDocument,
  input: ExpectedActiveWalletInput,
  action: string,
): void {
  const expectedName = input.expectedActiveWalletName;
  const expectedEpoch = input.expectedActiveSelectionEpoch;
  if (
    typeof expectedName !== "string" ||
    expectedName.length === 0 ||
    !Number.isSafeInteger(expectedEpoch) ||
    expectedEpoch! < 0
  ) {
    throw new AgentBoostRequestError(
      "WALLET_LIFECYCLE_BINDING_REQUIRED",
      `A confirmed request to ${action} requires the active-wallet binding from its preceding preview.`,
      {
        lifecycle_action: action,
        required_fields: [
          "expected_active_wallet_name",
          "expected_active_selection_epoch",
        ],
      },
    );
  }

  const active = state.wallet?.profiles[state.wallet.activeWalletId];
  if (
    !active ||
    active.name !== expectedName ||
    active.selectionEpoch !== expectedEpoch
  ) {
    throw new AgentBoostRequestError(
      "WALLET_LIFECYCLE_PREVIEW_STALE",
      `The active wallet changed after the preview to ${action}. Nothing was changed; review current saved profiles and create a new preview.`,
      {
        lifecycle_action: action,
        expected_active_wallet_name: expectedName,
        expected_active_selection_epoch: expectedEpoch,
        ...(active
          ? {
              active_wallet_name: active.name,
              active_selection_epoch: active.selectionEpoch,
            }
          : {}),
      },
    );
  }
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
    setup_phase: onboarding?.phase ?? "not_started",
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
    (request) => request.phase !== "failed" &&
      request.authorization.authorizationId === profile.authorizationId,
  ).length + Object.values(state.regularRequests).filter(
    (request) => request.phase !== "failed" &&
      request.authorization.authorizationId === profile.authorizationId,
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

  getUserOperationReceiptStatus(
    userOperationHash: string,
    expectedSender?: string,
  ) {
    if (!this.#chain.getUserOperationReceiptStatus) {
      return Promise.reject(new Error("UserOperation receipt lookup is unavailable"));
    }
    return this.#read(() =>
      this.#chain.getUserOperationReceiptStatus!(
        userOperationHash,
        expectedSender,
      )
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
    regular_requests: Object.values(state.regularRequests),
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
