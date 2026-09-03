import { createHash, randomUUID } from "node:crypto";

import type {
  ChainClient,
  PaymentApproval,
  PaymentPlan,
  PaymentRequest,
  WalletAuthorizationBinding,
  WalletAdapter,
} from "./contracts.js";
import {
  MAX_POLICY_LIFETIME_LIMIT_WEI,
  MAX_POLICY_PAYMENT_LIMIT_WEI,
  MAX_POLICY_PAYMENTS,
  SEPOLIA_CHAIN_ID,
} from "./contracts.js";
import { StateStore, type StateDocument } from "./state/store.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ATOMIC_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface PaymentClock {
  now(): Date;
}

const SYSTEM_CLOCK: PaymentClock = { now: () => new Date() };

function digestIntent(
  recipient: string,
  amountWei: string,
  authorization: WalletAuthorizationBinding,
): string {
  const canonical = JSON.stringify({
    chain_id: "eip155:11155111",
    recipient: recipient.toLowerCase(),
    asset_type: "eip155:11155111/slip44:60",
    amount_atomic: amountWei,
    operation: "tornado_unshield_tail_call",
    wallet_id: authorization.walletId,
    selection_epoch: authorization.selectionEpoch,
    authorization_id: authorization.authorizationId,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export class PaymentController {
  readonly #store: StateStore;
  readonly #wallet: WalletAdapter;
  readonly #chain: ChainClient | undefined;
  readonly #clock: PaymentClock;
  readonly #executeEnabled: boolean;
  readonly #executionLimitWei: bigint | undefined;
  readonly #paymentApproval: PaymentApproval;
  #execution: Promise<PaymentRequest> | undefined;
  #acceptingExecutions = true;

  constructor(options: {
    store: StateStore;
    wallet: WalletAdapter;
    chain?: ChainClient;
    clock?: PaymentClock;
    executeEnabled?: boolean;
    executionLimitWei?: bigint;
    paymentApproval?: PaymentApproval;
  }) {
    this.#store = options.store;
    this.#wallet = options.wallet;
    this.#chain = options.chain;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#executeEnabled = options.executeEnabled ?? true;
    this.#executionLimitWei = options.executionLimitWei;
    this.#paymentApproval = options.paymentApproval ?? "confirm";
  }

  async recoverInterruptedRequests(): Promise<void> {
    const state = await this.#store.update((draft) => {
      for (const request of Object.values(draft.requests)) {
        if (request.phase !== "executing") continue;
        request.phase = "indeterminate";
        request.updatedAt = this.#clock.now().toISOString();
        request.error = {
          code: "EXECUTION_INTERRUPTED",
          message:
            "Agent Boost restarted during payment execution; do not create or execute a replacement payment.",
        };
      }
    });
    for (const request of Object.values(state.requests)) {
      if (
        request.phase === "executing" ||
        request.phase === "submitted" ||
        request.phase === "indeterminate"
      ) {
        await this.reconcileRequest(request.requestId);
      }
    }
  }

  async plan(input: {
    recipient: string;
    amountWei: string;
  }): Promise<PaymentPlan> {
    if (!ADDRESS_PATTERN.test(input.recipient)) {
      throw new Error("recipient must be a 20-byte Ethereum address");
    }
    if (!ATOMIC_PATTERN.test(input.amountWei) || BigInt(input.amountWei) <= 0n) {
      throw new Error("amount_atomic must be a positive canonical integer string");
    }

    const blockers: string[] = [];
    await this.#store.ensureWalletProfile("agent-boost");
    let state = await this.#store.read();
    if (state.onboarding?.phase === "private_ready") {
      try {
        const privateBalance = await this.#wallet.getPrivateBalanceWei();
        state = await this.#store.update((draft) => {
          if (!draft.onboarding) return;
          draft.onboarding.privateBalanceWei = privateBalance.toString();
          draft.onboarding.revision += 1;
          draft.onboarding.updatedAt = this.#clock.now().toISOString();
        });
      } catch {
        blockers.push("PRIVATE_BALANCE_UNAVAILABLE");
      }
    }
    const onboarding = state.onboarding;
    const authorization = activeAuthorization(state);
    const amount = BigInt(input.amountWei);
    if (!this.#executeEnabled) blockers.push("EXECUTION_DISABLED");
    if (this.#paymentApproval === "deny") blockers.push("SECURITY_POLICY_DENIED");
    if (!onboarding || onboarding.phase !== "private_ready") {
      blockers.push("PRIVATE_BALANCE_NOT_READY");
    }
    if (!onboarding?.delegation.enabled) blockers.push("DELEGATION_DISABLED");
    if (
      onboarding &&
      paymentCount(state, authorization) >= (onboarding.delegation.maxPayments ?? 1)
    ) {
      blockers.push("PAYMENT_COUNT_LIMIT");
    }
    if (
      onboarding &&
      new Date(onboarding.delegation.expiresAt).getTime() <= this.#clock.now().getTime()
    ) {
      blockers.push("DELEGATION_EXPIRED");
    }
    if (onboarding) {
      if (
        (onboarding.delegation.maxPayments ?? 1) > MAX_POLICY_PAYMENTS ||
        BigInt(onboarding.delegation.perPaymentLimitWei) >
          MAX_POLICY_PAYMENT_LIMIT_WEI ||
        BigInt(onboarding.delegation.lifetimeLimitWei) >
          MAX_POLICY_LIFETIME_LIMIT_WEI
      ) {
        blockers.push("POLICY_OUTSIDE_HARD_BOUNDS");
      }
      const remaining =
        BigInt(onboarding.delegation.lifetimeLimitWei) -
        BigInt(onboarding.delegation.spentWei);
      if (amount > BigInt(onboarding.delegation.perPaymentLimitWei)) {
        blockers.push("PER_PAYMENT_LIMIT");
      }
      if (amount > remaining) blockers.push("LIFETIME_LIMIT");
      if (amount > BigInt(onboarding.privateBalanceWei)) {
        blockers.push("INSUFFICIENT_PRIVATE_BALANCE");
      }
    }

    const now = this.#clock.now();
    const plan: PaymentPlan = {
      version: 1,
      decisionId: `wd_${randomUUID()}`,
      recipient: input.recipient,
      amountWei: input.amountWei,
      authorization,
      intentDigest: digestIntent(input.recipient, input.amountWei, authorization),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      decision: blockers.length === 0 ? "allow" : "deny",
      blockers,
      approval: {
        action: this.#paymentApproval,
        userConfirmationRequired: this.#paymentApproval === "confirm",
      },
    };
    await this.#store.update((draft) => {
      draft.plans[plan.decisionId] = plan;
    });
    return plan;
  }

  async execute(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<PaymentRequest> {
    if (!this.#acceptingExecutions) throw new Error("PAYMENT_RUNTIME_STOPPING");
    if (this.#paymentApproval === "deny") {
      throw new Error("SECURITY_POLICY_DENIED");
    }
    if (this.#paymentApproval === "confirm" && !input.userConfirmed) {
      throw new Error("The user must confirm the exact test payment");
    }
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.clientRequestId)) {
      throw new Error("client_request_id must be a stable 8-200 character identifier");
    }

    const state = await this.#store.read();
    const existing = Object.values(state.requests).find(
      (request) => request.clientRequestId === input.clientRequestId,
    );
    if (existing) {
      if (existing.decisionId !== input.decisionId) {
        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      return existing;
    }
    if (Object.values(state.requests).some(
      (request) => request.decisionId === input.decisionId,
    )) {
      throw new Error("DECISION_ALREADY_CONSUMED");
    }
    if (this.#execution) throw new Error("PAYMENT_ALREADY_EXECUTING");

    const plan = state.plans[input.decisionId];
    if (!plan) throw new Error("DECISION_NOT_FOUND");
    if (plan.blockers.includes("USER_CANCELLED")) throw new Error("DECISION_CANCELLED");
    if (plan.decision !== "allow") throw new Error("DECISION_DENIED");
    if (new Date(plan.expiresAt).getTime() <= this.#clock.now().getTime()) {
      throw new Error("DECISION_EXPIRED");
    }

    // stop() can run while the state read above is pending. Recheck immediately
    // before registering the execution; there is no await between this gate and
    // the assignment, so shutdown will either reject this work or drain it.
    if (!this.#acceptingExecutions) throw new Error("PAYMENT_RUNTIME_STOPPING");
    this.#execution = this.#executePlan(plan, input.clientRequestId);
    try {
      return await this.#execution;
    } finally {
      this.#execution = undefined;
    }
  }

  async getPlan(decisionId: string): Promise<PaymentPlan> {
    const plan = (await this.#store.read()).plans[decisionId];
    if (!plan) throw new Error("DECISION_NOT_FOUND");
    return plan;
  }

  async cancel(decisionId: string): Promise<PaymentPlan> {
    const state = await this.#store.update((draft) => {
      const plan = draft.plans[decisionId];
      if (!plan) throw new Error("DECISION_NOT_FOUND");
      if (Object.values(draft.requests).some(
        (request) => request.decisionId === decisionId,
      )) {
        throw new Error("DECISION_ALREADY_CONSUMED");
      }
      plan.decision = "deny";
      if (!plan.blockers.includes("USER_CANCELLED")) plan.blockers.push("USER_CANCELLED");
    });
    return state.plans[decisionId]!;
  }

  async getRequest(requestId: string): Promise<PaymentRequest> {
    const request = (await this.#store.read()).requests[requestId];
    if (!request) throw new Error("REQUEST_NOT_FOUND");
    if (
      request.phase === "executing" ||
      request.phase === "submitted" ||
      request.phase === "indeterminate"
    ) {
      return this.reconcileRequest(requestId);
    }
    return request;
  }

  async reconcileRequest(requestId: string): Promise<PaymentRequest> {
    const request = (await this.#store.read()).requests[requestId];
    if (!request) throw new Error("REQUEST_NOT_FOUND");
    if (
      request.phase !== "executing" &&
      request.phase !== "submitted" &&
      request.phase !== "indeterminate"
    ) {
      return request;
    }

    let receiptStatus: "pending" | "success" | "reverted" | undefined;
    if (
      request.transactionHash &&
      this.#chain?.getTransactionReceiptStatus
    ) {
      try {
        receiptStatus = await this.#chain.getTransactionReceiptStatus(
          request.transactionHash,
        );
      } catch {
        // Receipt lookup is best-effort. Reconciliation never broadcasts.
      }
    }

    let delivered = false;
    if (this.#chain && request.recipientBalanceBeforeWei !== undefined) {
      try {
        const currentBalance = await this.#chain.getBalanceWei(request.recipient);
        delivered =
          currentBalance >=
          BigInt(request.recipientBalanceBeforeWei) + BigInt(request.amountWei);
      } catch {
        // A temporarily unavailable balance probe leaves the request unresolved.
      }
    }

    const checkedAt = this.#clock.now().toISOString();
    const updated = await this.#store.update((draft) => {
      const current = draft.requests[requestId];
      if (!current) throw new Error("REQUEST_NOT_FOUND");
      if (
        current.phase !== "executing" &&
        current.phase !== "submitted" &&
        current.phase !== "indeterminate"
      ) {
        return;
      }
      current.reconciliation = {
        attempts: (current.reconciliation?.attempts ?? 0) + 1,
        checkedAt,
      };
      if (receiptStatus === "reverted") {
        current.phase = "failed";
        current.updatedAt = checkedAt;
        current.error = {
          code: "TRANSACTION_REVERTED",
          message: "The payment transaction was included but reverted.",
        };
      } else if (receiptStatus === "success" || delivered) {
        current.phase = "confirmed";
        current.updatedAt = checkedAt;
        current.confirmation = {
          method: receiptStatus === "success"
            ? "transaction_receipt"
            : "recipient_balance_delta",
          checkedAt,
        };
        delete current.error;
      }
    });
    return updated.requests[requestId] as PaymentRequest;
  }

  async stop(): Promise<void> {
    this.#acceptingExecutions = false;
    await this.#execution?.catch(() => undefined);
  }

  resetForNewDemo(): void {
    if (this.#execution) throw new Error("PAYMENT_ALREADY_EXECUTING");
    this.#acceptingExecutions = true;
  }

  async #executePlan(
    plan: PaymentPlan,
    clientRequestId: string,
  ): Promise<PaymentRequest> {
    if (!this.#executeEnabled) throw new Error("EXECUTION_DISABLED");
    if (this.#chain) await this.#chain.assertSepolia();
    const livePrivateBalance = await this.#wallet.getPrivateBalanceWei();
    let recipientBalanceBefore: bigint | undefined;
    if (this.#chain) {
      try {
        recipientBalanceBefore = await this.#chain.getBalanceWei(plan.recipient);
      } catch {
        // The payment can proceed, but balance-delta reconciliation will not be
        // available if no transaction identifier is returned.
      }
    }
    const now = this.#clock.now().toISOString();
    const request: PaymentRequest = {
      version: 1,
      requestId: `req_${randomUUID()}`,
      clientRequestId,
      decisionId: plan.decisionId,
      recipient: plan.recipient,
      amountWei: plan.amountWei,
      authorization: plan.authorization,
      phase: "executing",
      createdAt: now,
      updatedAt: now,
      ...(recipientBalanceBefore !== undefined
        ? { recipientBalanceBeforeWei: recipientBalanceBefore.toString() }
        : {}),
    };

    await this.#store.update((draft) => {
      const onboarding = draft.onboarding;
      const storedPlan = draft.plans[plan.decisionId];
      const active = activeAuthorization(draft);
      if (Object.values(draft.requests).some(
        (existing) => existing.decisionId === plan.decisionId,
      )) {
        throw new Error("DECISION_ALREADY_CONSUMED");
      }
      if (
        !storedPlan ||
        storedPlan.decision !== "allow" ||
        storedPlan.intentDigest !== plan.intentDigest ||
        storedPlan.recipient !== plan.recipient ||
        storedPlan.amountWei !== plan.amountWei ||
        !sameAuthorization(storedPlan.authorization, plan.authorization) ||
        !sameAuthorization(active, plan.authorization)
      ) {
        throw new Error("DECISION_CHANGED");
      }
      if (!onboarding || onboarding.phase !== "private_ready") {
        throw new Error("PRIVATE_BALANCE_NOT_READY");
      }
      if (onboarding.delegation.chainId !== SEPOLIA_CHAIN_ID) {
        throw new Error("CHAIN_NOT_SEPOLIA");
      }
      if (
        paymentCount(draft, plan.authorization) >=
        (onboarding.delegation.maxPayments ?? 1)
      ) {
        throw new Error("PAYMENT_COUNT_LIMIT");
      }
      const amount = BigInt(plan.amountWei);
      const spent = BigInt(onboarding.delegation.spentWei);
      const limit = BigInt(onboarding.delegation.lifetimeLimitWei);
      if (
        (onboarding.delegation.maxPayments ?? 1) > MAX_POLICY_PAYMENTS ||
        BigInt(onboarding.delegation.perPaymentLimitWei) >
          MAX_POLICY_PAYMENT_LIMIT_WEI ||
        limit > MAX_POLICY_LIFETIME_LIMIT_WEI
      ) {
        throw new Error("POLICY_OUTSIDE_HARD_BOUNDS");
      }
      const nowMs = this.#clock.now().getTime();
      if (new Date(storedPlan.expiresAt).getTime() <= nowMs) {
        throw new Error("DECISION_EXPIRED");
      }
      if (!onboarding.delegation.enabled) throw new Error("DELEGATION_DISABLED");
      if (new Date(onboarding.delegation.expiresAt).getTime() <= nowMs) {
        throw new Error("DELEGATION_EXPIRED");
      }
      if (amount > BigInt(onboarding.delegation.perPaymentLimitWei)) {
        throw new Error("PER_PAYMENT_LIMIT");
      }
      if (this.#executionLimitWei !== undefined && amount > this.#executionLimitWei) {
        throw new Error("EXECUTION_LIMIT");
      }
      if (spent + amount > limit) throw new Error("LIFETIME_LIMIT");
      if (amount > livePrivateBalance) {
        throw new Error("INSUFFICIENT_PRIVATE_BALANCE");
      }
      onboarding.privateBalanceWei = livePrivateBalance.toString();
      onboarding.delegation.spentWei = (spent + amount).toString();
      onboarding.revision += 1;
      onboarding.updatedAt = this.#clock.now().toISOString();
      draft.requests[request.requestId] = request;
    });

    try {
      if (this.#chain) await this.#chain.assertSepolia();
      const result = await this.#wallet.executePrivatePayment({
        recipient: plan.recipient,
        amountWei: BigInt(plan.amountWei),
      });
      let delivered = false;
      if (this.#chain && recipientBalanceBefore !== undefined) {
        try {
          const recipientBalanceAfter = await this.#chain.getBalanceWei(plan.recipient);
          delivered =
            recipientBalanceAfter >= recipientBalanceBefore + BigInt(plan.amountWei);
        } catch {
          // Kohaku waits for inclusion, but without the post-balance proof the
          // strongest honest state is submitted rather than confirmed.
        }
      }
      let privateBalanceAfter: bigint | undefined;
      try {
        privateBalanceAfter = await this.#wallet.getPrivateBalanceWei();
      } catch {
        // The payment result remains durable even when the follow-up balance
        // refresh is temporarily unavailable.
      }
      const updated = await this.#store.update((draft) => {
        const current = draft.requests[request.requestId];
        if (!current) throw new Error("REQUEST_NOT_FOUND");
        current.phase = result.confirmed || delivered
          ? "confirmed"
          : result.transactionHash || result.userOperationHash
            ? "submitted"
            : "indeterminate";
        current.updatedAt = this.#clock.now().toISOString();
        if (result.transactionHash) current.transactionHash = result.transactionHash;
        if (result.userOperationHash) {
          current.userOperationHash = result.userOperationHash;
        }
        if (result.confirmed || delivered) {
          current.confirmation = {
            method: result.confirmed ? "adapter" : "recipient_balance_delta",
            checkedAt: current.updatedAt,
          };
          delete current.error;
        }
        if (draft.onboarding && privateBalanceAfter !== undefined) {
          draft.onboarding.privateBalanceWei = privateBalanceAfter.toString();
          draft.onboarding.revision += 1;
          draft.onboarding.updatedAt = this.#clock.now().toISOString();
        }
      });
      return updated.requests[request.requestId] as PaymentRequest;
    } catch (error) {
      const updated = await this.#store.update((draft) => {
        const current = draft.requests[request.requestId];
        if (!current) return;
        current.phase = "indeterminate";
        current.updatedAt = this.#clock.now().toISOString();
        current.error = {
          code: "PRIVATE_PAYMENT_UNRESOLVED",
          message:
            "The private payment may have been submitted. Do not retry with a new client request ID.",
        };
      });
      return updated.requests[request.requestId] as PaymentRequest;
    }
  }
}

function activeAuthorization(state: {
  wallet?: { activeName: string; profiles: Record<string, import("./contracts.js").WalletProfileRecord> };
}): WalletAuthorizationBinding {
  const wallet = state.wallet;
  const profile = wallet
    ? Object.values(wallet.profiles).find((candidate) => candidate.name === wallet.activeName)
    : undefined;
  if (!profile || profile.selectionEpoch < 1 || !profile.authorizationId) {
    throw new Error("ACTIVE_WALLET_AUTHORIZATION_MISSING");
  }
  return {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
    authorizationId: profile.authorizationId,
  };
}

function sameAuthorization(
  left: WalletAuthorizationBinding | undefined,
  right: WalletAuthorizationBinding | undefined,
): boolean {
  if (!left || !right) return false;
  return left.walletId === right.walletId &&
    left.walletName === right.walletName &&
    left.selectionEpoch === right.selectionEpoch &&
    left.authorizationId === right.authorizationId;
}

function paymentCount(
  state: StateDocument,
  authorization: WalletAuthorizationBinding,
): number {
  return Object.values(state.requests).filter(
    (request) => sameAuthorization(request.authorization, authorization),
  ).length + Object.values(state.regularRequests).filter(
    (request) => sameAuthorization(request.authorization, authorization),
  ).length;
}
