import { createHash, randomUUID } from "node:crypto";

import {
  MAX_POLICY_LIFETIME_LIMIT_WEI,
  MAX_POLICY_PAYMENT_LIMIT_WEI,
  MAX_POLICY_PAYMENTS,
  MAX_POLICY_TTL_MS,
  type DelegationPolicy,
  type PrivateBalanceBinding,
  type PrivateBalancePolicyUpdatePlan,
  type PrivateBalancePolicyUpdateRequest,
  type PrivateBalanceRecord,
  type WalletPolicySnapshot,
  type WalletProfileRecord,
} from "./contracts.js";
import { StateStore, type StateDocument } from "./state/store.js";

const ATOMIC_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface PrivateBalancePolicyClock {
  now(): Date;
}

export interface PrivateBalancePolicyTarget {
  walletId?: string;
  privateBalanceId?: string;
}

const SYSTEM_CLOCK: PrivateBalancePolicyClock = { now: () => new Date() };

export class PrivateBalancePolicyController {
  readonly #store: StateStore;
  readonly #clock: PrivateBalancePolicyClock;
  readonly #defaultTtlMs: number;

  constructor(options: {
    store: StateStore;
    defaultTtlMs: number;
    clock?: PrivateBalancePolicyClock;
  }) {
    this.#store = options.store;
    this.#defaultTtlMs = options.defaultTtlMs;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
  }

  async get(target: PrivateBalancePolicyTarget = {}): Promise<{
    privateBalance: PrivateBalanceBinding;
    policy: WalletPolicySnapshot;
  }> {
    const state = await this.#store.read();
    const { profile, privateBalance } = policyContext(state, target);
    return {
      privateBalance: bindPrivateBalance(profile, privateBalance),
      policy: snapshot(
        privateBalance.delegation,
        paymentsUsed(
          state,
          privateBalance.privateBalanceId,
          profile.authorizationId,
        ),
      ),
    };
  }

  async plan(input: {
    walletId?: string;
    privateBalanceId?: string;
    perPaymentLimitWei?: string;
    lifetimeLimitWei?: string;
    maxPayments?: number;
    ttlMs?: number;
    enabled?: boolean;
  }): Promise<PrivateBalancePolicyUpdatePlan> {
    if (input.perPaymentLimitWei === undefined &&
      input.lifetimeLimitWei === undefined && input.maxPayments === undefined &&
      input.ttlMs === undefined && input.enabled === undefined) {
      throw new Error("At least one private-balance policy setting must change");
    }
    const requestedPerPayment = requireAtomic(
      input.perPaymentLimitWei,
      "per_payment_limit_native",
    );
    const requestedLifetime = requireAtomic(
      input.lifetimeLimitWei,
      "lifetime_limit_native",
    );
    if (input.maxPayments !== undefined &&
      (!Number.isSafeInteger(input.maxPayments) || input.maxPayments <= 0)) {
      throw new Error("max_payments must be a positive integer");
    }
    if (input.ttlMs !== undefined &&
      (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0)) {
      throw new Error("expires_in_hours must be positive");
    }

    const state = await this.#store.read();
    const { profile, privateBalance, onboarding } = policyContext(state, input);
    const authorizationId = profile.authorizationId;
    const used = paymentsUsed(
      state,
      privateBalance.privateBalanceId,
      profile.authorizationId,
    );
    const current = snapshot(privateBalance.delegation, used);
    const now = this.#clock.now();
    const perPayment = requestedPerPayment ?? BigInt(current.perPaymentLimitWei);
    const maximumPayments = input.maxPayments ?? current.maxPayments;
    const paymentEnvelope = perPayment * BigInt(maximumPayments);
    const deriveLifetime = input.perPaymentLimitWei !== undefined ||
      input.maxPayments !== undefined;
    const lifetime = requestedLifetime ?? (deriveLifetime
      ? BigInt(maxAtomic(current.spentWei, paymentEnvelope.toString()))
      : BigInt(current.lifetimeLimitWei));
    const expired = new Date(current.expiresAt).getTime() <= now.getTime();
    const ttlMs = input.ttlMs ?? (expired ? this.#defaultTtlMs : undefined);
    const expiresAt = ttlMs === undefined
      ? current.expiresAt
      : new Date(now.getTime() + ttlMs).toISOString();
    const proposed = snapshot({
      mode: current.mode,
      chainId: current.chainId,
      perPaymentLimitWei: perPayment.toString(),
      lifetimeLimitWei: lifetime.toString(),
      spentWei: current.spentWei,
      maxPayments: maximumPayments,
      expiresAt,
      enabled: input.enabled ?? current.enabled,
    }, used);
    const blockers = policyBlockers({
      current,
      proposed,
      aggregate: onboarding?.delegation,
      now,
    });
    const binding = bindPrivateBalance(profile, privateBalance);
    const plan: PrivateBalancePolicyUpdatePlan = {
      version: 1,
      decisionId: `pbp_${randomUUID()}`,
      privateBalance: binding,
      current,
      proposed,
      intentDigest: policyDigest(binding, current, proposed),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      decision: blockers.length === 0 ? "allow" : "deny",
      blockers,
      approval: { action: "confirm", userConfirmationRequired: true },
    };
    await this.#store.update((draft) => {
      const liveContext = policyContext(draft, {
        walletId: binding.walletId,
        privateBalanceId: binding.privateBalanceId,
      });
      if (liveContext.profile.authorizationId !== authorizationId) {
        throw new Error("WALLET_REAUTHORIZED_REFRESH_PLAN");
      }
      for (const existing of Object.values(
        draft.privateBalancePolicyUpdatePlans,
      )) {
        if (!existing.appliedAt && existing.decision === "allow" &&
          existing.privateBalance.privateBalanceId ===
            privateBalance.privateBalanceId) {
          existing.decision = "deny";
          if (!existing.blockers.includes("SUPERSEDED_BY_NEW_PREVIEW")) {
            existing.blockers.push("SUPERSEDED_BY_NEW_PREVIEW");
          }
        }
      }
      draft.privateBalancePolicyUpdatePlans[plan.decisionId] = plan;
    });
    return plan;
  }

  async getPlan(decisionId: string): Promise<PrivateBalancePolicyUpdatePlan> {
    const plan = (await this.#store.read())
      .privateBalancePolicyUpdatePlans[decisionId];
    if (!plan) throw new Error("PRIVATE_BALANCE_POLICY_DECISION_NOT_FOUND");
    return plan;
  }

  async cancel(decisionId: string): Promise<PrivateBalancePolicyUpdatePlan> {
    const state = await this.#store.update((draft) => {
      const plan = draft.privateBalancePolicyUpdatePlans[decisionId];
      if (!plan) throw new Error("PRIVATE_BALANCE_POLICY_DECISION_NOT_FOUND");
      if (plan.appliedAt) {
        throw new Error("PRIVATE_BALANCE_POLICY_DECISION_ALREADY_APPLIED");
      }
      plan.decision = "deny";
      if (!plan.blockers.includes("USER_CANCELLED")) {
        plan.blockers.push("USER_CANCELLED");
        plan.cancelledAt = this.#clock.now().toISOString();
      }
    });
    return state.privateBalancePolicyUpdatePlans[decisionId]!;
  }

  async apply(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<PrivateBalancePolicyUpdateRequest> {
    if (!input.userConfirmed) {
      throw new Error("The user must confirm the exact private-balance policy update");
    }
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.clientRequestId)) {
      throw new Error("client_request_id must be a stable 8-200 character identifier");
    }
    let requestId = "";
    const state = await this.#store.update((draft) => {
      const existing = Object.values(
        draft.privateBalancePolicyUpdateRequests,
      ).find((request) => request.clientRequestId === input.clientRequestId);
      if (existing) {
        if (existing.decisionId !== input.decisionId) {
          throw new Error("IDEMPOTENCY_CONFLICT");
        }
        requestId = existing.requestId;
        return;
      }
      const plan = draft.privateBalancePolicyUpdatePlans[input.decisionId];
      if (!plan) throw new Error("PRIVATE_BALANCE_POLICY_DECISION_NOT_FOUND");
      if (plan.blockers.includes("USER_CANCELLED")) {
        throw new Error("PRIVATE_BALANCE_POLICY_DECISION_CANCELLED");
      }
      if (plan.decision !== "allow") {
        throw new Error("PRIVATE_BALANCE_POLICY_DECISION_DENIED");
      }
      if (new Date(plan.expiresAt).getTime() <= this.#clock.now().getTime()) {
        throw new Error("PRIVATE_BALANCE_POLICY_DECISION_EXPIRED");
      }
      if (Object.values(draft.privateBalancePolicyUpdateRequests).some(
        (request) => request.decisionId === plan.decisionId,
      )) {
        throw new Error("PRIVATE_BALANCE_POLICY_DECISION_ALREADY_CONSUMED");
      }
      const { profile, privateBalance } = policyContext(draft, {
        walletId: plan.privateBalance.walletId,
        privateBalanceId: plan.privateBalance.privateBalanceId,
      });
      const liveBinding = bindPrivateBalance(profile, privateBalance);
      if (!samePrivateBalanceBinding(liveBinding, plan.privateBalance)) {
        throw new Error("PRIVATE_BALANCE_CHANGED_REFRESH_PLAN");
      }
      const live = snapshot(
        privateBalance.delegation,
        paymentsUsed(
          draft,
          privateBalance.privateBalanceId,
          profile.authorizationId,
        ),
      );
      if (!samePolicy(live, plan.current) ||
        plan.intentDigest !== policyDigest(plan.privateBalance, plan.current, plan.proposed)) {
        throw new Error("PRIVATE_BALANCE_POLICY_CHANGED_REFRESH_PLAN");
      }
      const { paymentsUsed: _used, paymentsRemaining: _remaining, ...delegation } =
        plan.proposed;
      const now = this.#clock.now().toISOString();
      privateBalance.delegation = delegation;
      privateBalance.revision += 1;
      privateBalance.updatedAt = now;
      plan.appliedAt = now;
      plan.appliedPolicy = snapshot(
        delegation,
        paymentsUsed(
          draft,
          privateBalance.privateBalanceId,
          profile.authorizationId,
        ),
      );
      requestId = `pbpr_${randomUUID()}`;
      plan.consumedByRequestId = requestId;
      draft.privateBalancePolicyUpdateRequests[requestId] = {
        version: 1,
        requestId,
        clientRequestId: input.clientRequestId,
        decisionId: plan.decisionId,
        privateBalance: plan.privateBalance,
        phase: "applied",
        createdAt: now,
        updatedAt: now,
        appliedAt: now,
        policy: plan.appliedPolicy,
      };
    });
    const request = state.privateBalancePolicyUpdateRequests[requestId];
    if (!request) throw new Error("PRIVATE_BALANCE_POLICY_UPDATE_FAILED");
    return request;
  }
}

function policyContext(
  state: StateDocument,
  target: PrivateBalancePolicyTarget = {},
): {
  profile: WalletProfileRecord;
  privateBalance: PrivateBalanceRecord;
  onboarding: WalletProfileRecord["onboarding"];
} {
  const registry = state.wallet;
  const walletId = target.walletId ?? registry?.activeWalletId;
  const profile = walletId === undefined
    ? undefined
    : registry?.profiles[walletId];
  if (!profile || profile.selectionEpoch < 1 || profile.status === "archived") {
    throw new Error(target.walletId === undefined
      ? "ACTIVE_WALLET_MISSING"
      : "WALLET_NOT_FOUND");
  }
  const id = target.privateBalanceId ?? profile.defaultPrivateBalanceId;
  const privateBalance = profile.privateBalances[id];
  if (!privateBalance || privateBalance.status !== "available") {
    throw new Error("PRIVATE_BALANCE_NOT_FOUND");
  }
  const onboarding = profile.walletId === registry?.activeWalletId
    ? state.onboarding
    : profile.onboarding;
  return { profile, privateBalance, onboarding };
}

function bindPrivateBalance(
  profile: WalletProfileRecord,
  privateBalance: PrivateBalanceRecord,
): PrivateBalanceBinding {
  return {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
    privateBalanceId: privateBalance.privateBalanceId,
    privateBalanceName: privateBalance.name,
    backendWalletName: privateBalance.backendWalletName,
    privateBalanceRevision: privateBalance.revision,
  };
}

function snapshot(
  policy: DelegationPolicy,
  used: number,
): WalletPolicySnapshot {
  return {
    ...policy,
    paymentsUsed: used,
    paymentsRemaining: Math.max(0, policy.maxPayments - used),
  };
}

function paymentsUsed(
  state: StateDocument,
  privateBalanceId: string,
  authorizationId: string | undefined,
): number {
  if (!authorizationId) return 0;
  return Object.values(state.requests).filter((request) =>
    request.privateBalanceId === privateBalanceId && request.phase !== "failed" &&
    request.authorization.authorizationId === authorizationId
  ).length + Object.values(state.regularRequests).filter((request) =>
    request.sourcePrivateBalance?.privateBalanceId === privateBalanceId &&
    request.phase !== "failed" &&
    request.authorization.authorizationId === authorizationId
  ).length;
}

function requireAtomic(value: string | undefined, name: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!ATOMIC_PATTERN.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${name} must be a positive canonical atomic-unit string`);
  }
  return BigInt(value);
}

function maxAtomic(...values: string[]): string {
  return values.reduce((maximum, value) =>
    BigInt(value) > BigInt(maximum) ? value : maximum);
}

function policyBlockers(input: {
  current: WalletPolicySnapshot;
  proposed: WalletPolicySnapshot;
  aggregate: DelegationPolicy | undefined;
  now: Date;
}): string[] {
  const blockers: string[] = [];
  const perPayment = BigInt(input.proposed.perPaymentLimitWei);
  const lifetime = BigInt(input.proposed.lifetimeLimitWei);
  const spent = BigInt(input.proposed.spentWei);
  if (perPayment > MAX_POLICY_PAYMENT_LIMIT_WEI) {
    blockers.push("HARD_MAX_PER_PAYMENT_LIMIT");
  }
  if (input.proposed.maxPayments > MAX_POLICY_PAYMENTS) {
    blockers.push("HARD_MAX_PAYMENTS");
  }
  if (lifetime > MAX_POLICY_LIFETIME_LIMIT_WEI) {
    blockers.push("HARD_MAX_LIFETIME_LIMIT");
  }
  if (lifetime > perPayment * BigInt(input.proposed.maxPayments) &&
    lifetime !== spent) {
    blockers.push("LIFETIME_EXCEEDS_PAYMENT_ENVELOPE");
  }
  if (lifetime < BigInt(input.current.spentWei)) {
    blockers.push("LIFETIME_BELOW_SPENT");
  }
  if (input.proposed.maxPayments < input.current.paymentsUsed) {
    blockers.push("MAX_PAYMENTS_BELOW_USED");
  }
  const expiresAt = new Date(input.proposed.expiresAt).getTime();
  if (expiresAt <= input.now.getTime()) blockers.push("EXPIRY_IN_PAST");
  if (expiresAt - input.now.getTime() > MAX_POLICY_TTL_MS) {
    blockers.push("HARD_MAX_EXPIRY");
  }
  if (input.proposed.enabled) {
    if (!input.aggregate?.enabled) {
      blockers.push("WALLET_POLICY_DISABLED");
    } else {
      if (perPayment > BigInt(input.aggregate.perPaymentLimitWei)) {
        blockers.push("EXCEEDS_WALLET_PER_PAYMENT_LIMIT");
      }
      if (lifetime > BigInt(input.aggregate.lifetimeLimitWei)) {
        blockers.push("EXCEEDS_WALLET_LIFETIME_LIMIT");
      }
      if (input.proposed.maxPayments > input.aggregate.maxPayments) {
        blockers.push("EXCEEDS_WALLET_MAX_PAYMENTS");
      }
      if (expiresAt > Date.parse(input.aggregate.expiresAt)) {
        blockers.push("EXCEEDS_WALLET_EXPIRY");
      }
    }
  }
  if (samePolicy(input.current, input.proposed)) blockers.push("NOTHING_CHANGED");
  return blockers;
}

function samePolicy(left: WalletPolicySnapshot, right: WalletPolicySnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function samePrivateBalanceBinding(
  left: PrivateBalanceBinding,
  right: PrivateBalanceBinding,
): boolean {
  return left.walletId === right.walletId && left.walletName === right.walletName &&
    left.selectionEpoch === right.selectionEpoch &&
    left.privateBalanceId === right.privateBalanceId &&
    left.privateBalanceName === right.privateBalanceName &&
    left.backendWalletName === right.backendWalletName &&
    left.privateBalanceRevision === right.privateBalanceRevision;
}

function policyDigest(
  privateBalance: PrivateBalanceBinding,
  current: WalletPolicySnapshot,
  proposed: WalletPolicySnapshot,
): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    operation: "update_private_balance_policy",
    chain_id: "eip155:11155111",
    wallet_id: privateBalance.walletId,
    selection_epoch: privateBalance.selectionEpoch,
    private_balance_id: privateBalance.privateBalanceId,
    private_balance_revision: privateBalance.privateBalanceRevision,
    current,
    proposed,
  })).digest("hex")}`;
}
