import { randomUUID } from "node:crypto";

import type { AgentBoostConfig } from "./config.js";
import {
  SEPOLIA_CHAIN_ID,
  type ChainClient,
  type OnboardingRecord,
  type PublicOnboardingSnapshot,
  type WalletAdapter,
} from "./contracts.js";
import { StateStore } from "./state/store.js";

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
    const existing = (await this.#store.read()).onboarding;
    if (existing && existing.phase !== "failed") {
      this.#resume(existing);
      return existing;
    }

    const now = this.#clock.now();
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
        lifetimeLimitWei: this.#config.paymentLimitWei.toString(),
        spentWei: "0",
        expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
        enabled: this.#config.executeEnabled,
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
    if (record) this.#resume(record);
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
      this.#workflow = this.#waitForPrivateBalance(record.setupId);
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

        const balance = await this.#chain.getBalanceWei(current.address);
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
          await this.#chain.assertSepolia();
          await this.#wallet.shieldWei(this.#config.shieldAmountWei);
          await this.#waitForPrivateBalance(setupId);
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
      await this.#fail(setupId, "FUNDING_OR_SHIELD_FAILED", error, true);
    } finally {
      this.#workflow = undefined;
    }
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
        const current = await this.getRecord();
        let publicBalance = BigInt(current.publicBalanceWei);
        if (current.address) {
          try {
            publicBalance = await this.#chain.getBalanceWei(current.address);
          } catch {
            // The private balance is the readiness authority. A temporary
            // public-balance refresh failure must not erase a completed shield.
          }
        }
        await this.#transition(setupId, "private_ready", {
          privateBalanceWei: privateBalance.toString(),
          publicBalanceWei: publicBalance.toString(),
        });
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
      "address" | "publicBalanceWei" | "privateBalanceWei" | "uiUrl" | "uiOpened"
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
    default:
      return "Wallet setup did not complete. Inspect local diagnostics before retrying.";
  }
}
