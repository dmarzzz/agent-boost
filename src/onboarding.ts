import { createHash, randomUUID } from "node:crypto";

import type { AgentBoostConfig } from "./config.js";
import {
  SEPOLIA_CHAIN_ID,
  type ChainClient,
  type OnboardingRecord,
  type PublicOnboardingSnapshot,
  type RawTransactionBroadcastCheckpoint,
  type WalletAdapter,
} from "./contracts.js";
import { matchingRawTransactionBroadcastCheckpoint } from "./public-change.js";
import { StateStore } from "./state/store.js";

const SEPOLIA_TORNADO_ETH_0_1_POOL =
  "0x8c4a04d872a6c1be37964a21ba3a138525dff50b";
const TORNADO_DEPOSIT_CALL_PATTERN = /^0xb214faa5([0-9a-fA-F]{64})$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface OnboardingClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: OnboardingClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class OnboardingController {
  readonly #store: StateStore;
  readonly #wallet: WalletAdapter;
  readonly #chain: ChainClient;
  readonly #config: AgentBoostConfig;
  readonly #clock: OnboardingClock;
  #workflow: Promise<void> | undefined;
  #stopped = false;

  constructor(options: {
    store: StateStore;
    wallet: WalletAdapter;
    chain: ChainClient;
    config: AgentBoostConfig;
    clock?: OnboardingClock;
  }) {
    this.#store = options.store;
    this.#wallet = options.wallet;
    this.#chain = options.chain;
    this.#config = options.config;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
  }

  async start(): Promise<OnboardingRecord> {
    this.#stopped = false;
    await this.#store.ensureWalletProfile(this.#config.kohakuWalletName);
    const existing = (await this.#store.read()).onboarding;
    if (existing) {
      if (existing.phase !== "failed") {
        this.#resume(existing);
        return existing;
      }

      // A retryable failure must keep the same setup and main account address. In
      // particular, a temporary RPC failure while waiting for funding should
      // not invalidate a QR code the participant may already be scanning.
      if (existing.error?.retryable) {
        if (!existing.address) {
          await this.#transition(existing.setupId, "creating_wallet");
          this.#workflow = this.#initialize(existing.setupId);
          await this.#waitUntilPresentable(existing.setupId);
          return this.getRecord();
        }

        const publicBalance = BigInt(existing.publicBalanceWei);
        const privateBalance = BigInt(existing.privateBalanceWei);
        if (privateBalance >= this.#config.shieldAmountWei) {
          await this.#transition(existing.setupId, "private_ready");
          return this.getRecord();
        }
        if (publicBalance < this.#config.fundingTargetWei) {
          await this.#transition(
            existing.setupId,
            publicBalance === 0n ? "awaiting_funding" : "funding_pending",
          );
          const resumed = await this.getRecord();
          this.#resume(resumed);
          return resumed;
        }

        // A full public balance plus no exact journal is safe to retry: the
        // guarded adapter cannot reach the network without first creating the
        // stable setup-bound checkpoint. If one exists, the resume path only
        // reconciles that transaction and never broadcasts another deposit.
        await this.#transition(existing.setupId, "shielding");
        const resumed = await this.getRecord();
        this.#resume(resumed);
        return resumed;
      }
      return existing;
    }

    const now = this.#clock.now();
    const walletProfile = await this.#store.activeWalletProfile();
    const record: OnboardingRecord = {
      version: 1,
      setupId: `setup_${randomUUID()}`,
      revision: 1,
      phase: "creating_wallet",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      publicBalanceWei: "0",
      privateBalanceWei: "0",
      requiredFundingWei: this.#config.fundingTargetWei.toString(),
      shieldAmountWei: this.#config.shieldAmountWei.toString(),
      delegation: {
        mode: "testnet_delegated",
        chainId: SEPOLIA_CHAIN_ID,
        perPaymentLimitWei: this.#config.paymentLimitWei.toString(),
        lifetimeLimitWei: this.#config.paymentLifetimeLimitWei.toString(),
        spentWei: "0",
        maxPayments: this.#config.maxPayments,
        expiresAt: new Date(
          now.getTime() + this.#config.delegationTtlMs,
        ).toISOString(),
        enabled:
          walletProfile.authorizationId !== undefined &&
          this.#config.executeEnabled &&
          this.#config.security.effective["payment.execute"] !== "deny",
      },
    };
    await this.#store.update((draft) => {
      draft.onboarding = record;
    });

    this.#workflow = this.#initialize(record.setupId);
    await this.#waitUntilPresentable(record.setupId);
    return this.getRecord();
  }

  async resume(): Promise<void> {
    this.#stopped = false;
    const record = (await this.#store.read()).onboarding;
    if (!record) return;
    if (record.phase === "failed" && record.error?.retryable) {
      await this.start();
      return;
    }
    this.#resume(record);
  }

  async getRecord(): Promise<OnboardingRecord> {
    const record = (await this.#store.read()).onboarding;
    if (!record) throw new Error("Agent Boost onboarding has not started");
    return record;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#workflow;
  }

  async getPublicSnapshot(): Promise<PublicOnboardingSnapshot> {
    const record = await this.getRecord();
    return {
      setupId: record.setupId,
      revision: record.revision,
      phase: record.phase,
      ...(record.address ? { address: record.address } : {}),
      publicBalanceWei: record.publicBalanceWei,
      privateBalanceWei: record.privateBalanceWei,
      requiredFundingWei: record.requiredFundingWei,
      shieldAmountWei: record.shieldAmountWei,
      delegation: record.delegation,
      ...(record.error ? { error: record.error } : {}),
    };
  }

  async status(options: {
    setupId: string;
    sinceRevision?: number;
    waitMs?: number;
  }): Promise<OnboardingRecord> {
    const current = await this.getRecord();
    if (current.setupId !== options.setupId) {
      throw new Error("Unknown onboarding setup ID");
    }
    const waitMs = Math.min(Math.max(options.waitMs ?? 0, 0), 90_000);
    const record = await this.#store.waitForOnboardingRevision(
      options.sinceRevision ?? -1,
      waitMs,
    );
    if (!record || record.setupId !== options.setupId) {
      throw new Error("Onboarding state is unavailable");
    }
    return record;
  }

  #resume(record: OnboardingRecord): void {
    if (this.#workflow) return;
    if (
      record.phase === "creating_wallet" ||
      record.phase === "preparing_privacy"
    ) {
      this.#workflow = this.#initialize(record.setupId);
    } else if (
      record.phase === "awaiting_funding" ||
      record.phase === "funding_pending" ||
      record.phase === "funded_public"
    ) {
      this.#workflow = this.#monitorFundingAndShield(record.setupId);
    } else if (record.phase === "shielding") {
      this.#workflow = this.#resumeShielding(record.setupId);
    }
  }

  async #resumeShielding(setupId: string): Promise<void> {
    try {
      await this.#shieldOrRecover(setupId);
    } catch (error) {
      await this.#failFundingOrShield(setupId, error);
    } finally {
      this.#workflow = undefined;
    }
  }

  async #initialize(setupId: string): Promise<void> {
    try {
      await this.#chain.assertSepolia();
      await this.#wallet.ensureWallet();
      let current = await this.getRecord();
      if (current.setupId !== setupId) return;

      let address = current.address;
      if (!address) address = await this.#wallet.nextFreshAddress();
      await this.#transition(setupId, "preparing_privacy", { address });
      await this.#transition(setupId, "awaiting_funding", { address });
      await this.#wallet.prewarmPrivacy();
      await this.#monitorFundingAndShield(setupId);
    } catch (error) {
      await this.#fail(setupId, "ONBOARDING_FAILED", error);
    } finally {
      this.#workflow = undefined;
    }
  }

  async #monitorFundingAndShield(setupId: string): Promise<void> {
    try {
      const started = this.#clock.now().getTime();
      while (
        !this.#stopped &&
        this.#clock.now().getTime() - started < this.#config.setupTimeoutMs
      ) {
        const current = await this.getRecord();
        if (current.setupId !== setupId || !current.address) return;
        if (current.phase === "private_ready" || current.phase === "failed") return;

        let balance: bigint;
        try {
          balance = await this.#chain.getBalanceWei(current.address);
        } catch {
          // The address and QR remain useful while a Tor circuit or public
          // testnet RPC recovers. Keep polling instead of turning a transient
          // read failure into a broken first-run experience.
          await this.#clock.sleep(this.#config.fundingPollMs);
          continue;
        }
        const phase =
          balance === 0n
            ? "awaiting_funding"
            : balance < this.#config.fundingTargetWei
              ? "funding_pending"
              : "funded_public";
        await this.#transition(setupId, phase, {
          publicBalanceWei: balance.toString(),
        });

        if (balance >= this.#config.fundingTargetWei) {
          if (!this.#config.autoShield) return;
          await this.#transition(setupId, "shielding");
          await this.#shieldOrRecover(setupId);
          return;
        }
        await this.#clock.sleep(this.#config.fundingPollMs);
      }
      if (this.#stopped) return;
      await this.#fail(
        setupId,
        "SETUP_TIMEOUT",
        new Error("Funding was not confirmed before the setup deadline"),
        true,
      );
    } catch (error) {
      await this.#failFundingOrShield(setupId, error);
    } finally {
      this.#workflow = undefined;
    }
  }

  async #shieldOrRecover(setupId: string): Promise<void> {
    let current = await this.getRecord();
    if (
      current.setupId !== setupId ||
      current.phase === "private_ready" ||
      current.phase === "failed" ||
      !current.address
    ) {
      return;
    }
    const sourceAddress = current.address;

    // Check the authoritative private balance before deciding that an absent
    // journal permits a send. This also recovers a process crash after the
    // deposit became spendable but before the final state transition.
    if (await this.#observePrivateReady(setupId)) return;
    current = await this.getRecord();

    const requestId = onboardingShieldBroadcastRequestId(setupId);
    let checkpoint = await this.#matchingShieldCheckpoint(current, requestId);
    if (checkpoint) {
      await this.#assertShieldCheckpointNotReverted(checkpoint);
      await this.#recordShieldTransactionHash(
        setupId,
        checkpoint.transactionHash,
      );
      await this.#waitForPrivateBalance(setupId);
      return;
    }

    await this.#chain.assertSepolia();
    const livePublicBalance = await this.#chain.getBalanceWei(sourceAddress);
    if (livePublicBalance < this.#config.fundingTargetWei) {
      await this.#transition(
        setupId,
        livePublicBalance === 0n ? "awaiting_funding" : "funding_pending",
        { publicBalanceWei: livePublicBalance.toString() },
      );
      return;
    }
    let result: Awaited<ReturnType<WalletAdapter["shieldWei"]>>;
    try {
      result = await this.#wallet.shieldWei(this.#config.shieldAmountWei, {
        sourceAddress,
        ...(current.shieldPreparedDepositCall === undefined
          ? {}
          : { preparedDepositCall: current.shieldPreparedDepositCall }),
        broadcastRequestId: requestId,
        beforeBroadcast: async (preparedDepositCall) => {
          const validated = validateOnboardingShieldCall(
            preparedDepositCall,
            this.#config.shieldAmountWei,
          );
          await this.#transition(setupId, "shielding", {
            shieldPreparedDepositCall: validated,
            shieldBroadcastStartedAt:
              current.shieldBroadcastStartedAt ?? this.#clock.now().toISOString(),
          });
        },
      });
    } catch (error) {
      current = await this.getRecord();
      checkpoint = await this.#matchingShieldCheckpoint(current, requestId);
      if (!checkpoint) throw error;
      await this.#assertShieldCheckpointNotReverted(checkpoint);
      await this.#recordShieldTransactionHash(
        setupId,
        checkpoint.transactionHash,
      );
      await this.#waitForPrivateBalance(setupId);
      return;
    }

    current = await this.getRecord();
    checkpoint = await this.#matchingShieldCheckpoint(current, requestId);
    if (this.#wallet.getRawTransactionBroadcastCheckpoint && !checkpoint) {
      throw new Error("ONBOARDING_SHIELD_BROADCAST_CHECKPOINT_MISSING");
    }
    if (checkpoint) {
      await this.#assertShieldCheckpointNotReverted(checkpoint);
    }
    if (
      result.transactionHash !== undefined &&
      (!TRANSACTION_HASH_PATTERN.test(result.transactionHash) ||
        (checkpoint !== undefined &&
          result.transactionHash.toLowerCase() !==
            checkpoint.transactionHash.toLowerCase()))
    ) {
      throw new Error("ONBOARDING_SHIELD_BROADCAST_CHECKPOINT_MISMATCH");
    }
    const transactionHash = checkpoint?.transactionHash ?? result.transactionHash;
    if (transactionHash) {
      await this.#recordShieldTransactionHash(setupId, transactionHash);
    }
    await this.#waitForPrivateBalance(setupId);
  }

  async #matchingShieldCheckpoint(
    record: OnboardingRecord,
    requestId: string,
  ): Promise<RawTransactionBroadcastCheckpoint | undefined> {
    if (!this.#wallet.getRawTransactionBroadcastCheckpoint) return undefined;
    if (!record.shieldPreparedDepositCall) {
      const orphan = await this.#wallet.getRawTransactionBroadcastCheckpoint(
        requestId,
      );
      if (orphan) {
        throw new Error("ONBOARDING_SHIELD_CHECKPOINT_STATE_MISSING");
      }
      return undefined;
    }
    return matchingRawTransactionBroadcastCheckpoint({
      wallet: this.#wallet,
      requestId,
      expectedFrom: record.address ?? "",
      expectedTo: record.shieldPreparedDepositCall.to,
      expectedValueWei: record.shieldPreparedDepositCall.valueWei,
      expectedData: record.shieldPreparedDepositCall.data,
      ...(record.shieldTransactionHash === undefined
        ? {}
        : { storedTransactionHash: record.shieldTransactionHash }),
    });
  }

  async #recordShieldTransactionHash(
    setupId: string,
    transactionHash: string,
  ): Promise<void> {
    if (!TRANSACTION_HASH_PATTERN.test(transactionHash)) {
      throw new Error("ONBOARDING_SHIELD_TRANSACTION_HASH_INVALID");
    }
    const current = await this.getRecord();
    if (
      current.shieldTransactionHash !== undefined &&
      current.shieldTransactionHash.toLowerCase() !== transactionHash.toLowerCase()
    ) {
      throw new Error("ONBOARDING_SHIELD_BROADCAST_CHECKPOINT_MISMATCH");
    }
    await this.#transition(setupId, "shielding", {
      shieldTransactionHash: transactionHash.toLowerCase(),
    });
  }

  async #assertShieldCheckpointNotReverted(
    checkpoint: RawTransactionBroadcastCheckpoint,
  ): Promise<void> {
    if (!this.#chain.getTransactionReceiptStatus) return;
    let status: Awaited<ReturnType<NonNullable<
      ChainClient["getTransactionReceiptStatus"]
    >>>;
    try {
      status = await this.#chain.getTransactionReceiptStatus(
        checkpoint.transactionHash,
      );
    } catch {
      // Receipt lookup is read-only and best effort. An unavailable provider
      // leaves the journaled send indeterminate, so waiting remains the only
      // safe action.
      return;
    }
    if (status === "reverted") {
      throw new Error("ONBOARDING_SHIELD_TRANSACTION_REVERTED");
    }
  }

  async #failFundingOrShield(setupId: string, error: unknown): Promise<void> {
    if (
      error instanceof Error &&
      error.message === "ONBOARDING_SHIELD_TRANSACTION_REVERTED"
    ) {
      await this.#fail(
        setupId,
        "SHIELD_TRANSACTION_REVERTED",
        error,
        false,
      );
      return;
    }
    await this.#fail(setupId, "FUNDING_OR_SHIELD_FAILED", error, true);
  }

  async #observePrivateReady(setupId: string): Promise<boolean> {
    const privateBalance = await this.#wallet.getPrivateBalanceWei();
    await this.#transition(setupId, "shielding", {
      privateBalanceWei: privateBalance.toString(),
    });
    if (privateBalance < this.#config.shieldAmountWei) return false;
    await this.#completePrivateReady(setupId, privateBalance);
    return true;
  }

  async #completePrivateReady(
    setupId: string,
    privateBalance: bigint,
  ): Promise<void> {
    const current = await this.getRecord();
    let publicBalance = BigInt(current.publicBalanceWei);
    if (current.address) {
      try {
        publicBalance = await this.#chain.getBalanceWei(current.address);
      } catch {
        // The private balance is the readiness authority. A temporary public
        // balance refresh failure must not erase a completed shield.
      }
    }
    await this.#transition(setupId, "private_ready", {
      privateBalanceWei: privateBalance.toString(),
      publicBalanceWei: publicBalance.toString(),
    });
  }

  async #waitForPrivateBalance(setupId: string): Promise<void> {
    const started = this.#clock.now().getTime();
    while (
      !this.#stopped &&
      this.#clock.now().getTime() - started < this.#config.setupTimeoutMs
    ) {
      const privateBalance = await this.#wallet.getPrivateBalanceWei();
      await this.#transition(setupId, "shielding", {
        privateBalanceWei: privateBalance.toString(),
      });
      if (privateBalance >= this.#config.shieldAmountWei) {
        await this.#completePrivateReady(setupId, privateBalance);
        return;
      }
      await this.#clock.sleep(this.#config.privateBalancePollMs);
    }
    if (this.#stopped) return;
    await this.#fail(
      setupId,
      "PRIVATE_BALANCE_TIMEOUT",
      new Error("The shield transaction did not become spendable before the deadline"),
      true,
    );
  }

  async #waitUntilPresentable(setupId: string): Promise<void> {
    let revision = 0;
    while (true) {
      const state = await this.status({ setupId, sinceRevision: revision, waitMs: 30_000 });
      if (
        state.phase === "awaiting_funding" ||
        state.phase === "funding_pending" ||
        state.phase === "funded_public" ||
        state.phase === "shielding" ||
        state.phase === "private_ready" ||
        state.phase === "failed"
      ) {
        return;
      }
      revision = state.revision;
    }
  }

  async #transition(
    setupId: string,
    phase: OnboardingRecord["phase"],
    patch: Partial<Pick<
      OnboardingRecord,
      | "address"
      | "publicBalanceWei"
      | "privateBalanceWei"
      | "uiUrl"
      | "uiOpened"
      | "shieldPreparedDepositCall"
      | "shieldBroadcastStartedAt"
      | "shieldTransactionHash"
    >> = {},
  ): Promise<void> {
    await this.#store.update((draft) => {
      const record = draft.onboarding;
      if (!record || record.setupId !== setupId) return;

      const patchChanged = Object.entries(patch).some(
        ([key, value]) => record[key as keyof OnboardingRecord] !== value,
      );
      if (record.phase === phase && !patchChanged && record.error === undefined) {
        return;
      }

      record.phase = phase;
      record.revision += 1;
      record.updatedAt = this.#clock.now().toISOString();
      Object.assign(record, patch);
      delete record.error;
    });
  }

  async #fail(
    setupId: string,
    code: string,
    error: unknown,
    retryable = false,
  ): Promise<void> {
    void error;
    const message = publicFailureMessage(code);
    await this.#store.update((draft) => {
      const record = draft.onboarding;
      if (!record || record.setupId !== setupId) return;
      record.phase = "failed";
      record.revision += 1;
      record.updatedAt = this.#clock.now().toISOString();
      record.error = { code, message, retryable };
    });
  }
}

function publicFailureMessage(code: string): string {
  switch (code) {
    case "SETUP_TIMEOUT":
      return "Funding was not confirmed before the setup deadline.";
    case "PRIVATE_BALANCE_TIMEOUT":
      return "The shielded balance did not become spendable before the setup deadline.";
    case "FUNDING_OR_SHIELD_FAILED":
      return "Funding verification or shielding did not complete. Inspect local diagnostics before retrying.";
    case "SHIELD_TRANSACTION_REVERTED":
      return "The shield transaction reverted and was not retried automatically.";
    default:
      return "Wallet setup did not complete. Inspect local diagnostics before retrying.";
  }
}

function onboardingShieldBroadcastRequestId(setupId: string): string {
  const digest = createHash("sha256")
    .update("agent-boost:onboarding-shield:v1\0")
    .update(setupId)
    .digest("hex");
  return `onboarding-shield:${digest}`;
}

function validateOnboardingShieldCall(
  value: { to: string; data: string; valueWei: string },
  expectedAmountWei: bigint,
): { to: string; data: string; valueWei: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).sort().join(",") !== "data,to,valueWei" ||
    typeof value.to !== "string" ||
    value.to.toLowerCase() !== SEPOLIA_TORNADO_ETH_0_1_POOL ||
    typeof value.data !== "string" ||
    typeof value.valueWei !== "string" ||
    value.valueWei !== expectedAmountWei.toString()
  ) {
    throw new Error("ONBOARDING_SHIELD_PREPARATION_INVALID");
  }
  const match = TORNADO_DEPOSIT_CALL_PATTERN.exec(value.data);
  if (!match?.[1] || /^0{64}$/u.test(match[1])) {
    throw new Error("ONBOARDING_SHIELD_PREPARATION_INVALID");
  }
  return {
    to: SEPOLIA_TORNADO_ETH_0_1_POOL,
    data: `0xb214faa5${match[1].toLowerCase()}`,
    valueWei: expectedAmountWei.toString(),
  };
}
