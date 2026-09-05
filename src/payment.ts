import { createHash, randomUUID } from "node:crypto";

import type {
  ChainClient,
  PaymentApproval,
  PaymentPlan,
  PaymentRequest,
  PrivateBalanceRecord,
  WalletAuthorizationBinding,
  WalletAdapter,
} from "./contracts.js";
import {
  DEFAULT_SHIELD_WEI,
  MAX_POLICY_LIFETIME_LIMIT_WEI,
  MAX_POLICY_PAYMENT_LIMIT_WEI,
  MAX_POLICY_PAYMENTS,
  SEPOLIA_CHAIN_ID,
} from "./contracts.js";
import { WalletExecutionError } from "./errors.js";
import {
  matchingPrivateBroadcastCheckpoint,
  observeConfirmedPublicChange,
  recordPublicChangeAccount,
} from "./public-change.js";
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
  privateBalance: PrivateBalanceRecord,
  privateBalanceDebitWei: string,
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
    private_balance_id: privateBalance.privateBalanceId,
    private_balance_revision: privateBalance.revision,
    private_balance_debit_atomic: privateBalanceDebitWei,
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
  readonly #withdrawalAmountWei: bigint;
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
    withdrawalAmountWei?: bigint;
  }) {
    this.#store = options.store;
    this.#wallet = options.wallet;
    this.#chain = options.chain;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#executeEnabled = options.executeEnabled ?? true;
    this.#executionLimitWei = options.executionLimitWei;
    this.#paymentApproval = options.paymentApproval ?? "confirm";
    this.#withdrawalAmountWei = options.withdrawalAmountWei ?? DEFAULT_SHIELD_WEI;
    if (this.#withdrawalAmountWei <= 0n) {
      throw new Error("Private withdrawal amount must be positive");
    }
  }

  async recoverInterruptedRequests(): Promise<void> {
    const state = await this.#store.update((draft) => {
      for (const request of Object.values(draft.requests)) {
        if (request.phase !== "executing") continue;
        const now = this.#clock.now().toISOString();
        request.updatedAt = now;
        if (request.broadcastStartedAt) {
          request.phase = "indeterminate";
          request.error = {
            code: "EXECUTION_INTERRUPTED",
            message:
              "Agent Boost restarted after payment broadcast began; do not create or execute a replacement payment.",
          };
        } else {
          request.phase = "failed";
          request.error = {
            code: "EXECUTION_INTERRUPTED_BEFORE_BROADCAST",
            message: "Agent Boost restarted before payment broadcast began; the reserved balance and policy spend were restored.",
          };
          restorePrivateBalanceDebit(draft, request, now);
        }
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
    privateBalanceId?: string;
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
    let selected = activePrivateBalance(state, input.privateBalanceId);
    const unresolved = hasUnresolvedPrivateBalanceActivity(
      state,
      selected.privateBalanceId,
    );
    if (state.onboarding?.phase === "private_ready" && !unresolved) {
      try {
        const privateBalance = await this.#getPrivateBalanceWei(selected);
        state = await this.#store.update((draft) => {
          const context = activePrivateBalance(draft, selected.privateBalanceId);
          const profile = activeWalletProfile(draft);
          const now = this.#clock.now().toISOString();
          if (context.balanceWei !== privateBalance.toString()) {
            context.balanceWei = privateBalance.toString();
            context.revision += 1;
            context.updatedAt = now;
          }
          const aggregate = sumPrivateBalancesWei(profile).toString();
          if (draft.onboarding && draft.onboarding.privateBalanceWei !== aggregate) {
            draft.onboarding.privateBalanceWei = aggregate;
            draft.onboarding.revision += 1;
            draft.onboarding.updatedAt = now;
          }
        });
        selected = activePrivateBalance(state, selected.privateBalanceId);
      } catch {
        blockers.push("PRIVATE_BALANCE_UNAVAILABLE");
      }
    }
    const onboarding = state.onboarding;
    const authorization = activeAuthorization(state);
    const amount = BigInt(input.amountWei);
    const privateBalanceDebitWei = this.#withdrawalAmountWei.toString();
    if (!this.#executeEnabled) blockers.push("EXECUTION_DISABLED");
    if (this.#paymentApproval === "deny") blockers.push("SECURITY_POLICY_DENIED");
    if (!onboarding || onboarding.phase !== "private_ready") {
      blockers.push("PRIVATE_BALANCE_NOT_READY");
    }
    if (!onboarding?.delegation.enabled) blockers.push("DELEGATION_DISABLED");
    if (unresolved) blockers.push("PRIVATE_BALANCE_OPERATION_UNRESOLVED");
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
    const pocketPolicy = selected.delegation;
    const pocketPaymentsUsed = privateBalancePaymentCount(
      state,
      selected.privateBalanceId,
      authorization.authorizationId,
    );
    if (selected.status !== "available") blockers.push("PRIVATE_BALANCE_ARCHIVED");
    if (!pocketPolicy.enabled) blockers.push("PRIVATE_BALANCE_POLICY_DISABLED");
    if (new Date(pocketPolicy.expiresAt).getTime() <= this.#clock.now().getTime()) {
      blockers.push("PRIVATE_BALANCE_POLICY_EXPIRED");
    }
    if (
      pocketPolicy.maxPayments > MAX_POLICY_PAYMENTS ||
      BigInt(pocketPolicy.perPaymentLimitWei) > MAX_POLICY_PAYMENT_LIMIT_WEI ||
      BigInt(pocketPolicy.lifetimeLimitWei) > MAX_POLICY_LIFETIME_LIMIT_WEI
    ) {
      blockers.push("PRIVATE_BALANCE_POLICY_OUTSIDE_HARD_BOUNDS");
    }
    if (pocketPaymentsUsed >= pocketPolicy.maxPayments) {
      blockers.push("PRIVATE_BALANCE_PAYMENT_COUNT_LIMIT");
    }
    if (amount > BigInt(pocketPolicy.perPaymentLimitWei)) {
      blockers.push("PRIVATE_BALANCE_PER_PAYMENT_LIMIT");
    }
    if (
      BigInt(pocketPolicy.spentWei) + amount >
        BigInt(pocketPolicy.lifetimeLimitWei)
    ) {
      blockers.push("PRIVATE_BALANCE_LIFETIME_LIMIT");
    }
    if (amount >= this.#withdrawalAmountWei) {
      blockers.push("AMOUNT_MUST_BE_SMALLER_THAN_PRIVATE_DENOMINATION");
    }
    if (this.#withdrawalAmountWei > BigInt(selected.balanceWei)) {
      blockers.push("INSUFFICIENT_SELECTED_PRIVATE_BALANCE");
    }

    const now = this.#clock.now();
    const plan: PaymentPlan = {
      version: 1,
      decisionId: `wd_${randomUUID()}`,
      recipient: input.recipient,
      amountWei: input.amountWei,
      authorization,
      privateBalanceId: selected.privateBalanceId,
      privateBalanceRevision: selected.revision,
      privateBalanceDebitWei,
      intentDigest: digestIntent(
        input.recipient,
        input.amountWei,
        authorization,
        selected,
        privateBalanceDebitWei,
      ),
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
    const initialState = await this.#store.read();
    const request = initialState.requests[requestId];
    if (!request) throw new Error("REQUEST_NOT_FOUND");
    if (
      request.phase !== "executing" &&
      request.phase !== "submitted" &&
      request.phase !== "indeterminate"
    ) {
      return request;
    }

    let receiptStatus: "pending" | "success" | "reverted" | undefined;
    let receiptTransactionHash: string | undefined;
    let receiptMethod: "transaction_receipt" | "user_operation_receipt" | undefined;
    let checkpoint: Awaited<ReturnType<typeof matchingPrivateBroadcastCheckpoint>>;
    let reconciliationError:
      | "PRIVATE_BROADCAST_CHECKPOINT_MISMATCH"
      | "PUBLIC_CHANGE_TRACKING_PENDING"
      | undefined;
    try {
      checkpoint = await matchingPrivateBroadcastCheckpoint({
        wallet: this.#wallet,
        requestId,
        ...(request.userOperationHash === undefined
          ? {}
          : { storedUserOperationHash: request.userOperationHash }),
      });
    } catch {
      reconciliationError = "PRIVATE_BROADCAST_CHECKPOINT_MISMATCH";
    }
    const userOperationHash = reconciliationError
      ? undefined
      : request.userOperationHash ?? checkpoint?.userOperationHash;
    if (userOperationHash) {
      if (this.#chain?.getUserOperationReceiptStatus) {
        try {
          const result = await this.#chain.getUserOperationReceiptStatus(
            userOperationHash,
            checkpoint?.sender,
          );
          receiptStatus = result.status;
          if (result.status !== "pending") {
            if (request.transactionHash &&
              request.transactionHash.toLowerCase() !== result.transactionHash.toLowerCase()) {
              throw new Error("UserOperation receipt transaction hash mismatch");
            }
            receiptTransactionHash = result.transactionHash;
            receiptMethod = "user_operation_receipt";
          }
        } catch {
          // Receipt lookup is best-effort. Reconciliation never broadcasts.
          receiptStatus = undefined;
          receiptTransactionHash = undefined;
          receiptMethod = undefined;
        }
      }
    } else if (!request.userOperationHash && !checkpoint && !reconciliationError &&
      request.transactionHash && this.#chain?.getTransactionReceiptStatus) {
      try {
        receiptStatus = await this.#chain.getTransactionReceiptStatus(
          request.transactionHash,
        );
        receiptMethod = "transaction_receipt";
      } catch {
        // Receipt lookup is best-effort. Reconciliation never broadcasts.
      }
    }

    let publicChangeWei: bigint | undefined;
    if (receiptStatus === "success" && checkpoint && request.privateBalanceId) {
      const privateBalance = initialState.wallet?.profiles[
        request.authorization.walletId
      ]?.privateBalances[request.privateBalanceId];
      if (!privateBalance) {
        reconciliationError = "PUBLIC_CHANGE_TRACKING_PENDING";
        receiptStatus = undefined;
      } else {
        try {
          publicChangeWei = await observeConfirmedPublicChange({
            wallet: this.#wallet,
            chain: this.#chain!,
            backendWalletName: privateBalance.backendWalletName,
            checkpoint,
          });
        } catch {
          reconciliationError = "PUBLIC_CHANGE_TRACKING_PENDING";
          receiptStatus = undefined;
        }
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
      if (!current.userOperationHash && checkpoint) {
        current.userOperationHash = checkpoint.userOperationHash;
      }
      if (receiptTransactionHash) current.transactionHash = receiptTransactionHash;
      if (receiptStatus === "reverted") {
        current.phase = "failed";
        current.updatedAt = checkedAt;
        current.error = {
          code: "TRANSACTION_REVERTED",
          message: "The payment transaction was included but reverted.",
        };
        restorePrivateBalanceDebit(draft, current, checkedAt);
      } else if (receiptStatus === "success") {
        if (checkpoint && publicChangeWei !== undefined && current.privateBalanceId) {
          const profile = draft.wallet?.profiles[current.authorization.walletId];
          if (!profile) throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_TARGET_MISSING");
          recordPublicChangeAccount({
            profile,
            privateBalanceId: current.privateBalanceId,
            sourceRequestId: current.requestId,
            address: checkpoint.sender,
            balanceWei: publicChangeWei,
            observedAt: checkedAt,
          });
          current.publicChangeWei = publicChangeWei.toString();
        }
        current.phase = "confirmed";
        current.updatedAt = checkedAt;
        current.confirmation = {
          method: receiptMethod ?? "transaction_receipt",
          checkedAt,
        };
        delete current.error;
      } else if (!current.broadcastStartedAt) {
        current.phase = "failed";
        current.updatedAt = checkedAt;
        current.error = {
          code: "PAYMENT_NOT_BROADCAST",
          message: "The payment stopped before broadcast; the reserved balance and policy spend were restored.",
        };
        restorePrivateBalanceDebit(draft, current, checkedAt);
      } else if (reconciliationError) {
        current.updatedAt = checkedAt;
        current.error = {
          code: reconciliationError,
          message: reconciliationError === "PRIVATE_BROADCAST_CHECKPOINT_MISMATCH"
            ? "The durable private broadcast checkpoint does not match this payment. It was not retried."
            : "The payment is on-chain, but its wallet-controlled public change is still being recovered before completion is reported.",
        };
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
    if (!plan.privateBalanceId || plan.privateBalanceRevision === undefined ||
      !plan.privateBalanceDebitWei) {
      throw new Error("PRIVATE_BALANCE_BINDING_MISSING");
    }
    const privateBalanceId = plan.privateBalanceId;
    const privateBalanceRevision = plan.privateBalanceRevision;
    const privateBalanceDebitWei = plan.privateBalanceDebitWei;
    if (this.#chain) await this.#chain.assertSepolia();
    const sourcePrivateBalance = activePrivateBalance(
      await this.#store.read(),
      privateBalanceId,
    );
    const livePrivateBalance = await this.#getPrivateBalanceWei(sourcePrivateBalance);
    const now = this.#clock.now().toISOString();
    const request: PaymentRequest = {
      version: 1,
      requestId: `req_${randomUUID()}`,
      clientRequestId,
      decisionId: plan.decisionId,
      recipient: plan.recipient,
      amountWei: plan.amountWei,
      authorization: plan.authorization,
      privateBalanceId,
      privateBalanceRevision,
      privateBalanceDebitWei,
      privateBalanceDebitedAt: now,
      phase: "executing",
      createdAt: now,
      updatedAt: now,
    };

    await this.#store.update((draft) => {
      const onboarding = draft.onboarding;
      const profile = activeWalletProfile(draft);
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
        storedPlan.privateBalanceId !== plan.privateBalanceId ||
        storedPlan.privateBalanceRevision !== plan.privateBalanceRevision ||
        storedPlan.privateBalanceDebitWei !== plan.privateBalanceDebitWei ||
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
      const privateBalance = profile.privateBalances[privateBalanceId];
      if (!privateBalance || privateBalance.status !== "available") {
        throw new Error("PRIVATE_BALANCE_NOT_FOUND");
      }
      if (privateBalance.revision !== privateBalanceRevision) {
        throw new Error("PRIVATE_BALANCE_CHANGED");
      }
      if (hasUnresolvedPrivateBalanceActivity(draft, privateBalance.privateBalanceId)) {
        throw new Error("PRIVATE_BALANCE_OPERATION_UNRESOLVED");
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
      const privateDebit = BigInt(privateBalanceDebitWei);
      if (privateDebit !== this.#withdrawalAmountWei) {
        throw new Error("PRIVATE_BALANCE_DEBIT_CHANGED");
      }
      if (amount >= privateDebit) {
        throw new Error("AMOUNT_MUST_BE_SMALLER_THAN_PRIVATE_DENOMINATION");
      }
      if (privateDebit > livePrivateBalance || privateDebit > BigInt(privateBalance.balanceWei)) {
        throw new Error("INSUFFICIENT_SELECTED_PRIVATE_BALANCE");
      }
      const pocketPolicy = privateBalance.delegation;
      if (!pocketPolicy.enabled) throw new Error("PRIVATE_BALANCE_POLICY_DISABLED");
      if (new Date(pocketPolicy.expiresAt).getTime() <= nowMs) {
        throw new Error("PRIVATE_BALANCE_POLICY_EXPIRED");
      }
      if (privateBalancePaymentCount(
        draft,
        privateBalance.privateBalanceId,
        plan.authorization.authorizationId,
      ) >=
        pocketPolicy.maxPayments) {
        throw new Error("PRIVATE_BALANCE_PAYMENT_COUNT_LIMIT");
      }
      if (amount > BigInt(pocketPolicy.perPaymentLimitWei)) {
        throw new Error("PRIVATE_BALANCE_PER_PAYMENT_LIMIT");
      }
      const pocketSpent = BigInt(pocketPolicy.spentWei);
      if (pocketSpent + amount > BigInt(pocketPolicy.lifetimeLimitWei)) {
        throw new Error("PRIVATE_BALANCE_LIFETIME_LIMIT");
      }
      privateBalance.balanceWei = (livePrivateBalance - privateDebit).toString();
      privateBalance.revision += 1;
      privateBalance.updatedAt = now;
      privateBalance.delegation.spentWei = (pocketSpent + amount).toString();
      onboarding.privateBalanceWei = sumPrivateBalancesWei(profile).toString();
      onboarding.delegation.spentWei = (spent + amount).toString();
      onboarding.revision += 1;
      onboarding.updatedAt = this.#clock.now().toISOString();
      draft.requests[request.requestId] = request;
    });

    try {
      if (this.#chain) await this.#chain.assertSepolia();
      const result = await this.#executePrivatePayment(sourcePrivateBalance, {
        recipient: plan.recipient,
        amountWei: BigInt(plan.amountWei),
        broadcastRequestId: request.requestId,
        beforeBroadcast: () => this.#markBroadcastStarted(request.requestId),
      });
      let checkpoint: Awaited<ReturnType<typeof matchingPrivateBroadcastCheckpoint>>;
      let checkpointMismatch = false;
      if (result.confirmed) {
        try {
          checkpoint = await matchingPrivateBroadcastCheckpoint({
            wallet: this.#wallet,
            requestId: request.requestId,
            ...(result.userOperationHash === undefined
              ? {}
              : { storedUserOperationHash: result.userOperationHash }),
          });
        } catch {
          checkpointMismatch = true;
          // A mismatched journal must never be converted into an adapter-confirmed
          // payment. Reconciliation will retain the request for operator review.
        }
      }
      const exactUserOperationHash = result.userOperationHash ??
        checkpoint?.userOperationHash;
      let privateBalanceAfter: bigint | undefined;
      try {
        privateBalanceAfter = await this.#getPrivateBalanceWei(sourcePrivateBalance);
      } catch {
        // The payment result remains durable even when the follow-up balance
        // refresh is temporarily unavailable.
      }
      const updated = await this.#store.update((draft) => {
        const current = draft.requests[request.requestId];
        if (!current) throw new Error("REQUEST_NOT_FOUND");
        current.phase = checkpointMismatch
          ? "indeterminate"
          : exactUserOperationHash
          ? "submitted"
          : result.confirmed
          ? "confirmed"
          : result.transactionHash || result.userOperationHash
            ? "submitted"
            : "indeterminate";
        current.updatedAt = this.#clock.now().toISOString();
        if (result.transactionHash) current.transactionHash = result.transactionHash;
        if (exactUserOperationHash) {
          current.userOperationHash = exactUserOperationHash;
        }
        if (result.confirmed && !exactUserOperationHash && !checkpointMismatch) {
          current.confirmation = {
            method: "adapter",
            checkedAt: current.updatedAt,
          };
          delete current.error;
        } else if (checkpointMismatch) {
          current.error = {
            code: "PRIVATE_BROADCAST_CHECKPOINT_MISMATCH",
            message:
              "The durable private broadcast checkpoint does not match this payment. It was not retried.",
          };
        }
        if (draft.onboarding && privateBalanceAfter !== undefined && current.privateBalanceId) {
          const profile = activeWalletProfileForId(draft, current.authorization.walletId);
          const pocket = profile?.privateBalances[current.privateBalanceId];
          if (pocket && privateBalanceAfter < BigInt(pocket.balanceWei)) {
            pocket.balanceWei = privateBalanceAfter.toString();
            pocket.revision += 1;
            pocket.updatedAt = current.updatedAt;
          }
          draft.onboarding.privateBalanceWei = profile
            ? sumPrivateBalancesWei(profile).toString()
            : draft.onboarding.privateBalanceWei;
          draft.onboarding.revision += 1;
          draft.onboarding.updatedAt = this.#clock.now().toISOString();
        }
      });
      return updated.requests[request.requestId] as PaymentRequest;
    } catch (error) {
      const definitelyNotBroadcast = error instanceof WalletExecutionError &&
        !error.mayHaveBroadcast;
      const updated = await this.#store.update((draft) => {
        const current = draft.requests[request.requestId];
        if (!current) return;
        current.updatedAt = this.#clock.now().toISOString();
        if (definitelyNotBroadcast) {
          current.phase = "failed";
          current.error = {
            code: "PRIVATE_PAYMENT_REJECTED_BEFORE_BROADCAST",
            message: "The private payment failed before broadcast; the reserved balance and policy spend were restored.",
          };
          restorePrivateBalanceDebit(draft, current, current.updatedAt);
        } else {
          current.phase = "indeterminate";
          current.error = {
            code: "PRIVATE_PAYMENT_UNRESOLVED",
            message:
              "The private payment may have been submitted. Do not retry with a new client request ID.",
          };
        }
      });
      return updated.requests[request.requestId] as PaymentRequest;
    }
  }

  #getPrivateBalanceWei(privateBalance: PrivateBalanceRecord): Promise<bigint> {
    if (this.#wallet.getPrivateBalanceWeiForWallet) {
      return this.#wallet.getPrivateBalanceWeiForWallet(
        privateBalance.backendWalletName,
      );
    }
    this.#wallet.selectWallet?.(privateBalance.backendWalletName);
    return this.#wallet.getPrivateBalanceWei();
  }

  #executePrivatePayment(
    privateBalance: PrivateBalanceRecord,
    input: {
      recipient: string;
      amountWei: bigint;
      broadcastRequestId: string;
      beforeBroadcast: () => Promise<void>;
    },
  ): Promise<{
    transactionHash?: string;
    userOperationHash?: string;
    confirmed?: boolean;
  }> {
    if (this.#wallet.executePrivatePaymentFromWallet) {
      return this.#wallet.executePrivatePaymentFromWallet(
        privateBalance.backendWalletName,
        input,
      );
    }
    this.#wallet.selectWallet?.(privateBalance.backendWalletName);
    return this.#wallet.executePrivatePayment(input);
  }

  async #markBroadcastStarted(requestId: string): Promise<void> {
    await this.#store.update((draft) => {
      const request = draft.requests[requestId];
      if (!request || request.phase !== "executing" || request.broadcastStartedAt) {
        throw new Error("PAYMENT_REQUEST_NOT_EXECUTABLE");
      }
      request.broadcastStartedAt = this.#clock.now().toISOString();
      request.updatedAt = request.broadcastStartedAt;
    });
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
    (request) => request.phase !== "failed" &&
      request.authorization.authorizationId === authorization.authorizationId,
  ).length + Object.values(state.regularRequests).filter(
    (request) => request.phase !== "failed" &&
      request.authorization.authorizationId === authorization.authorizationId,
  ).length;
}

function activeWalletProfile(state: StateDocument): import("./contracts.js").WalletProfileRecord {
  const profile = state.wallet?.profiles[state.wallet.activeWalletId];
  if (!profile) throw new Error("ACTIVE_WALLET_PROFILE_MISSING");
  return profile;
}

function activeWalletProfileForId(
  state: StateDocument,
  walletId: string,
): import("./contracts.js").WalletProfileRecord | undefined {
  return state.wallet?.profiles[walletId];
}

function activePrivateBalance(
  state: StateDocument,
  privateBalanceId?: string,
): PrivateBalanceRecord {
  const profile = activeWalletProfile(state);
  const id = privateBalanceId ?? profile.defaultPrivateBalanceId;
  const privateBalance = profile.privateBalances[id];
  if (!privateBalance) throw new Error("PRIVATE_BALANCE_NOT_FOUND");
  return privateBalance;
}

function sumPrivateBalancesWei(
  profile: import("./contracts.js").WalletProfileRecord,
): bigint {
  return Object.values(profile.privateBalances).reduce(
    (sum, privateBalance) => privateBalance.status === "available"
      ? sum + BigInt(privateBalance.balanceWei)
      : sum,
    0n,
  );
}

function privateBalancePaymentCount(
  state: StateDocument,
  privateBalanceId: string,
  authorizationId: string,
): number {
  return Object.values(state.requests).filter(
    (request) => request.privateBalanceId === privateBalanceId &&
      request.phase !== "failed" &&
      request.authorization.authorizationId === authorizationId,
  ).length + Object.values(state.regularRequests).filter(
    (request) => request.sourcePrivateBalance?.privateBalanceId ===
        privateBalanceId &&
      request.phase !== "failed" &&
      request.authorization.authorizationId === authorizationId,
  ).length;
}

function hasUnresolvedPrivateBalanceActivity(
  state: StateDocument,
  privateBalanceId: string,
): boolean {
  const unresolvedPayment = Object.values(state.requests).some(
    (request) => request.privateBalanceId === privateBalanceId &&
      (request.phase === "executing" || request.phase === "submitted" ||
        request.phase === "indeterminate"),
  );
  if (unresolvedPayment) return true;
  const unresolvedRecovery = Object.values(state.recoveryRequests).some(
    (request) => request.privateBalanceId === privateBalanceId &&
      (request.phase === "executing" || request.phase === "submitted" ||
        request.phase === "indeterminate"),
  );
  if (unresolvedRecovery) return true;
  const unresolvedRegular = Object.values(state.regularRequests).some(
    (request) => request.sourcePrivateBalance?.privateBalanceId ===
        privateBalanceId &&
      (request.phase === "executing" || request.phase === "submitted" ||
        request.phase === "indeterminate"),
  );
  if (unresolvedRegular) return true;
  return Object.values(state.privateBalanceFundingRequests).some((request) =>
    (request.phase === "executing" || request.phase === "submitted" ||
      request.phase === "indeterminate") &&
    (request.targetPrivateBalance.privateBalanceId === privateBalanceId ||
      request.sourcePrivateBalance?.privateBalanceId === privateBalanceId)
  );
}

function restorePrivateBalanceDebit(
  state: StateDocument,
  request: PaymentRequest,
  restoredAt: string,
): void {
  if (request.privateBalanceRestoredAt || !request.privateBalanceDebitedAt ||
    !request.privateBalanceId || !request.privateBalanceDebitWei) {
    return;
  }
  const profile = state.wallet?.profiles[request.authorization.walletId];
  const privateBalance = profile?.privateBalances[request.privateBalanceId];
  if (!profile || !privateBalance) {
    throw new Error("PRIVATE_BALANCE_RESTORE_TARGET_MISSING");
  }
  const debit = BigInt(request.privateBalanceDebitWei);
  const amount = BigInt(request.amountWei);
  privateBalance.balanceWei = (BigInt(privateBalance.balanceWei) + debit).toString();
  privateBalance.delegation.spentWei = subtractFloorZero(
    BigInt(privateBalance.delegation.spentWei),
    amount,
  ).toString();
  privateBalance.revision += 1;
  privateBalance.updatedAt = restoredAt;

  const onboarding = state.wallet?.activeWalletId === profile.walletId
    ? state.onboarding
    : profile.onboarding;
  if (onboarding) {
    onboarding.privateBalanceWei = sumPrivateBalancesWei(profile).toString();
    onboarding.delegation.spentWei = subtractFloorZero(
      BigInt(onboarding.delegation.spentWei),
      amount,
    ).toString();
    onboarding.revision += 1;
    onboarding.updatedAt = restoredAt;
  }
  request.privateBalanceRestoredAt = restoredAt;
}

function subtractFloorZero(value: bigint, decrement: bigint): bigint {
  return value > decrement ? value - decrement : 0n;
}
