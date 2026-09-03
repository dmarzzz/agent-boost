import { randomUUID } from "node:crypto";

import {
  MAX_POLICY_LIFETIME_LIMIT_WEI,
  MAX_POLICY_PAYMENT_LIMIT_WEI,
  MAX_POLICY_PAYMENTS,
  MAX_POLICY_TTL_MS,
  type DelegationPolicy,
  type PolicyUpdatePlan,
  type PolicyUpdateReceipt,
  type WalletAuthorizationBinding,
  type WalletSelectionBinding,
  type WalletPolicySnapshot,
} from "./contracts.js";
import { StateStore } from "./state/store.js";

const ATOMIC_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface PolicyClock {
  now(): Date;
}

const SYSTEM_CLOCK: PolicyClock = { now: () => new Date() };

function maxPayments(policy: DelegationPolicy): number {
  return policy.maxPayments ?? 1;
}

function snapshot(
  policy: DelegationPolicy,
  paymentsUsed: number,
): WalletPolicySnapshot {
  const maximum = maxPayments(policy);
  return {
    ...policy,
    maxPayments: maximum,
    paymentsUsed,
    paymentsRemaining: Math.max(0, maximum - paymentsUsed),
  };
}

function samePolicy(
  left: WalletPolicySnapshot,
  right: WalletPolicySnapshot,
): boolean {
  return (
    left.mode === right.mode &&
    left.chainId === right.chainId &&
    left.perPaymentLimitWei === right.perPaymentLimitWei &&
    left.lifetimeLimitWei === right.lifetimeLimitWei &&
    left.spentWei === right.spentWei &&
    left.maxPayments === right.maxPayments &&
    left.paymentsUsed === right.paymentsUsed &&
    left.expiresAt === right.expiresAt &&
    left.enabled === right.enabled
  );
}

function requireAtomic(value: string | undefined, name: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!ATOMIC_PATTERN.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${name} must be a positive canonical atomic-unit string`);
  }
  return BigInt(value);
}

export class WalletPolicyController {
  readonly #store: StateStore;
  readonly #clock: PolicyClock;
  readonly #defaultTtlMs: number;

  constructor(options: {
    store: StateStore;
    defaultTtlMs: number;
    clock?: PolicyClock;
  }) {
    this.#store = options.store;
    this.#defaultTtlMs = options.defaultTtlMs;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
  }

  async get(): Promise<WalletPolicySnapshot> {
    const state = await this.#store.read();
    if (!state.onboarding) throw new Error("WALLET_NOT_INITIALIZED");
    return snapshot(state.onboarding.delegation, paymentsUsedByActiveAuthorization(state));
  }

  async getPlan(decisionId: string): Promise<PolicyUpdatePlan> {
    const plan = (await this.#store.read()).policyPlans[decisionId];
    if (!plan) throw new Error("POLICY_DECISION_NOT_FOUND");
    return plan;
  }

  async getLatestPlan(): Promise<PolicyUpdatePlan> {
    const plans = Object.values((await this.#store.read()).policyPlans);
    let latest: PolicyUpdatePlan | undefined;
    for (const plan of plans) {
      if (
        latest === undefined ||
        new Date(plan.createdAt).getTime() >= new Date(latest.createdAt).getTime()
      ) {
        latest = plan;
      }
    }
    if (!latest) throw new Error("POLICY_DECISION_NOT_FOUND");
    return latest;
  }

  async plan(input: {
    perPaymentLimitWei?: string;
    lifetimeLimitWei?: string;
    maxPayments?: number;
    ttlMs?: number;
    enabled?: boolean;
  }): Promise<PolicyUpdatePlan> {
    if (
      input.perPaymentLimitWei === undefined &&
      input.lifetimeLimitWei === undefined &&
      input.maxPayments === undefined &&
      input.ttlMs === undefined &&
      input.enabled === undefined
    ) {
      throw new Error("At least one wallet policy setting must change");
    }
    const requestedPerPayment = requireAtomic(
      input.perPaymentLimitWei,
      "per_payment_limit_native",
    );
    const requestedLifetime = requireAtomic(
      input.lifetimeLimitWei,
      "lifetime_limit_native",
    );
    if (
      input.maxPayments !== undefined &&
      (!Number.isSafeInteger(input.maxPayments) || input.maxPayments <= 0)
    ) {
      throw new Error("max_payments must be a positive integer");
    }
    if (
      input.ttlMs !== undefined &&
      (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0)
    ) {
      throw new Error("expires_in_hours must be positive");
    }

    const state = await this.#store.read();
    if (!state.onboarding) throw new Error("WALLET_NOT_INITIALIZED");
    const now = this.#clock.now();
    const active = activeWalletContext(state);
    const paymentsUsed = paymentsUsedByAuthorization(state, active.authorizationId);
    const current = snapshot(state.onboarding.delegation, paymentsUsed);
    const perPayment = requestedPerPayment ?? BigInt(current.perPaymentLimitWei);
    const maximumPayments = input.maxPayments ?? current.maxPayments;
    const derivedLifetime =
      input.perPaymentLimitWei !== undefined || input.maxPayments !== undefined;
    const lifetime = requestedLifetime ?? (
      derivedLifetime
        ? perPayment * BigInt(maximumPayments)
        : BigInt(current.lifetimeLimitWei)
    );
    const currentExpired =
      new Date(current.expiresAt).getTime() <= now.getTime();
    const ttlMs = input.ttlMs ?? (currentExpired ? this.#defaultTtlMs : undefined);
    const expiresAt = ttlMs === undefined
      ? current.expiresAt
      : new Date(now.getTime() + ttlMs).toISOString();
    const proposed = snapshot(
      {
        mode: current.mode,
        chainId: current.chainId,
        perPaymentLimitWei: perPayment.toString(),
        lifetimeLimitWei: lifetime.toString(),
        spentWei: current.spentWei,
        maxPayments: maximumPayments,
        expiresAt,
        enabled: input.enabled ?? current.enabled,
      },
      paymentsUsed,
    );

    const blockers: string[] = [];
    if (perPayment > MAX_POLICY_PAYMENT_LIMIT_WEI) {
      blockers.push("HARD_MAX_PER_PAYMENT_LIMIT");
    }
    if (maximumPayments > MAX_POLICY_PAYMENTS) {
      blockers.push("HARD_MAX_PAYMENTS");
    }
    if (lifetime > MAX_POLICY_LIFETIME_LIMIT_WEI) {
      blockers.push("HARD_MAX_LIFETIME_LIMIT");
    }
    if (lifetime > perPayment * BigInt(maximumPayments)) {
      blockers.push("LIFETIME_EXCEEDS_PAYMENT_ENVELOPE");
    }
    if (lifetime < BigInt(current.spentWei)) {
      blockers.push("LIFETIME_BELOW_SPENT");
    }
    if (maximumPayments < paymentsUsed) {
      blockers.push("MAX_PAYMENTS_BELOW_USED");
    }
    if (new Date(expiresAt).getTime() <= now.getTime()) {
      blockers.push("EXPIRY_IN_PAST");
    }
    if (new Date(expiresAt).getTime() - now.getTime() > MAX_POLICY_TTL_MS) {
      blockers.push("HARD_MAX_EXPIRY");
    }
    if (proposed.enabled && !active.authorizationId) {
      blockers.push("REAUTHORIZATION_REQUIRED");
    }
    if (samePolicy(current, proposed)) blockers.push("NOTHING_CHANGED");

    const plan: PolicyUpdatePlan = {
      version: 1,
      decisionId: `wpd_${randomUUID()}`,
      wallet: active.wallet,
      ...(active.authorizationId ? { authorizationId: active.authorizationId } : {}),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      current,
      proposed,
      decision: blockers.length === 0 ? "allow" : "deny",
      blockers,
      approval: { action: "confirm", userConfirmationRequired: true },
    };
    await this.#store.update((draft) => {
      draft.policyPlans[plan.decisionId] = plan;
    });
    return plan;
  }

  async apply(input: {
    decisionId: string;
    userConfirmed: boolean;
  }): Promise<PolicyUpdateReceipt> {
    if (!input.userConfirmed) {
      throw new Error("The user must confirm the exact wallet policy update");
    }
    let receipt: PolicyUpdateReceipt | undefined;
    const state = await this.#store.update((draft) => {
      const plan = draft.policyPlans[input.decisionId];
      if (!plan) throw new Error("POLICY_DECISION_NOT_FOUND");
      if (plan.decision !== "allow") throw new Error("POLICY_DECISION_DENIED");
      if (plan.appliedAt) {
        if (!plan.appliedPolicy) throw new Error("POLICY_RECEIPT_MISSING");
        receipt = {
          version: 1,
          decisionId: plan.decisionId,
          wallet: plan.wallet,
          appliedAt: plan.appliedAt,
          policy: plan.appliedPolicy,
          authorizationEffect: "preserved",
          counterEffect: "preserved",
        };
        return;
      }
      const now = this.#clock.now();
      if (new Date(plan.expiresAt).getTime() <= now.getTime()) {
        throw new Error("POLICY_DECISION_EXPIRED");
      }
      if (!draft.onboarding) throw new Error("WALLET_NOT_INITIALIZED");
      const active = activeWalletContext(draft);
      if (!sameWallet(active.wallet, plan.wallet) ||
        active.authorizationId !== plan.authorizationId) {
        throw new Error("WALLET_SELECTION_CHANGED");
      }
      const live = snapshot(
        draft.onboarding.delegation,
        paymentsUsedByAuthorization(draft, active.authorizationId),
      );
      if (!samePolicy(live, plan.current)) {
        throw new Error("POLICY_CHANGED_REFRESH_PLAN");
      }
      const { paymentsUsed: _used, paymentsRemaining: _remaining, ...delegation } =
        plan.proposed;
      draft.onboarding.delegation = delegation;
      draft.onboarding.revision += 1;
      draft.onboarding.updatedAt = now.toISOString();
      plan.appliedAt = now.toISOString();
      plan.appliedPolicy = snapshot(delegation, paymentsUsedByAuthorization(
        draft,
        active.authorizationId,
      ));
      receipt = {
        version: 1,
        decisionId: plan.decisionId,
        wallet: plan.wallet,
        appliedAt: plan.appliedAt,
        policy: plan.appliedPolicy,
        authorizationEffect: "preserved",
        counterEffect: "preserved",
      };
    });
    if (receipt) return receipt;
    const plan = state.policyPlans[input.decisionId];
    if (!plan?.appliedAt) throw new Error("POLICY_UPDATE_FAILED");
    return {
      version: 1,
      decisionId: plan.decisionId,
      wallet: plan.wallet,
      appliedAt: plan.appliedAt,
      policy: plan.appliedPolicy ?? plan.proposed,
      authorizationEffect: "preserved",
      counterEffect: "preserved",
    };
  }
}

function activeWalletContext(state: Awaited<ReturnType<StateStore["read"]>>): {
  wallet: WalletSelectionBinding;
  authorizationId?: string;
} {
  const registry = state.wallet;
  const profile = registry?.profiles[registry.activeWalletId];
  if (!profile || profile.selectionEpoch < 1) throw new Error("ACTIVE_WALLET_MISSING");
  if (state.onboarding?.delegation.enabled && !profile.authorizationId) {
    throw new Error("ACTIVE_WALLET_AUTHORIZATION_MISSING");
  }
  return {
    wallet: {
      walletId: profile.walletId,
      walletName: profile.name,
      selectionEpoch: profile.selectionEpoch,
    },
    ...(profile.authorizationId ? { authorizationId: profile.authorizationId } : {}),
  };
}

function paymentsUsedByActiveAuthorization(
  state: Awaited<ReturnType<StateStore["read"]>>,
): number {
  return paymentsUsedByAuthorization(state, activeWalletContext(state).authorizationId);
}

function paymentsUsedByAuthorization(
  state: Awaited<ReturnType<StateStore["read"]>>,
  authorizationId: string | undefined,
): number {
  if (!authorizationId) return 0;
  return Object.values(state.requests).filter(
    (request) => request.authorization.authorizationId === authorizationId,
  ).length;
}

function sameWallet(left: WalletSelectionBinding, right: WalletSelectionBinding): boolean {
  return left.walletId === right.walletId && left.walletName === right.walletName &&
    left.selectionEpoch === right.selectionEpoch;
}
