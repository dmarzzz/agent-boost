import { createHash, randomUUID } from "node:crypto";

import type {
  ChainClient,
  PaymentApproval,
  RegularTransferPlan,
  RegularTransferRequest,
  WalletAdapter,
  WalletAuthorizationBinding,
} from "./contracts.js";
import {
  MAX_POLICY_LIFETIME_LIMIT_WEI,
  MAX_POLICY_PAYMENT_LIMIT_WEI,
  MAX_POLICY_PAYMENTS,
  REGULAR_TRANSFER_GAS_RESERVE_WEI,
  SEPOLIA_CHAIN_ID,
} from "./contracts.js";
import { StateStore, type StateDocument } from "./state/store.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ATOMIC_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface RegularTransferClock {
  now(): Date;
}

const SYSTEM_CLOCK: RegularTransferClock = { now: () => new Date() };

function digestIntent(
  recipient: string,
  amountWei: string,
  gasReserveWei: string,
  authorization: WalletAuthorizationBinding,
): string {
  const canonical = JSON.stringify({
    chain_id: "eip155:11155111",
    recipient: recipient.toLowerCase(),
    asset_type: "eip155:11155111/slip44:60",
    amount_atomic: amountWei,
    gas_reserve_atomic: gasReserveWei,
    operation: "regular_public_eth_transfer",
    wallet_id: authorization.walletId,
    selection_epoch: authorization.selectionEpoch,
    authorization_id: authorization.authorizationId,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export class RegularTransferController {
  readonly #store: StateStore;
  readonly #wallet: WalletAdapter;
  readonly #chain: ChainClient;
  readonly #clock: RegularTransferClock;
  readonly #executeEnabled: boolean;
  readonly #executionLimitWei: bigint | undefined;
  readonly #paymentApproval: PaymentApproval;
  readonly #gasReserveWei: bigint;
  #execution: Promise<RegularTransferRequest> | undefined;
  #acceptingExecutions = true;

  constructor(options: {
    store: StateStore;
    wallet: WalletAdapter;
    chain: ChainClient;
    clock?: RegularTransferClock;
    executeEnabled?: boolean;
    executionLimitWei?: bigint;
    paymentApproval?: PaymentApproval;
    gasReserveWei?: bigint;
  }) {
    this.#store = options.store;
    this.#wallet = options.wallet;
    this.#chain = options.chain;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#executeEnabled = options.executeEnabled ?? true;
    this.#executionLimitWei = options.executionLimitWei;
    this.#paymentApproval = options.paymentApproval ?? "confirm";
    this.#gasReserveWei = options.gasReserveWei ?? REGULAR_TRANSFER_GAS_RESERVE_WEI;
    if (this.#gasReserveWei < 0n) throw new Error("Regular transfer gas reserve cannot be negative");
  }

  async recoverInterruptedRequests(): Promise<void> {
    const state = await this.#store.update((draft) => {
      for (const request of Object.values(draft.regularRequests)) {
        if (request.phase !== "executing") continue;
        request.phase = "indeterminate";
        request.updatedAt = this.#clock.now().toISOString();
        request.error = {
          code: "EXECUTION_INTERRUPTED",
          message:
            "Agent Boost restarted during regular transfer execution; do not create or execute a replacement transfer.",
        };
      }
    });
    for (const request of Object.values(state.regularRequests)) {
      if (
        request.phase === "executing" ||
        request.phase === "submitted" ||
        request.phase === "indeterminate"
      ) {
        await this.reconcileRequest(request.requestId);
      }
    }
  }

  async plan(input: { recipient: string; amountWei: string }): Promise<RegularTransferPlan> {
    if (!ADDRESS_PATTERN.test(input.recipient)) {
      throw new Error("recipient must be a 20-byte Ethereum address");
    }
    if (!ATOMIC_PATTERN.test(input.amountWei) || BigInt(input.amountWei) <= 0n) {
      throw new Error("amount_atomic must be a positive canonical integer string");
    }

    await this.#store.ensureWalletProfile("agent-boost");
    let state = await this.#store.read();
    const authorization = activeAuthorization(state);
    const blockers: string[] = [];
    const onboarding = state.onboarding;
    let mainBalance = BigInt(onboarding?.publicBalanceWei ?? "0");
    if (!onboarding?.address) {
      blockers.push("MAIN_ACCOUNT_NOT_READY");
    } else {
      try {
        await this.#chain.assertSepolia();
        mainBalance = await this.#chain.getBalanceWei(onboarding.address);
        state = await this.#store.update((draft) => {
          if (!draft.onboarding || draft.onboarding.address !== onboarding.address) return;
          if (draft.onboarding.publicBalanceWei === mainBalance.toString()) return;
          draft.onboarding.publicBalanceWei = mainBalance.toString();
          draft.onboarding.revision += 1;
          draft.onboarding.updatedAt = this.#clock.now().toISOString();
        });
      } catch {
        blockers.push("MAIN_BALANCE_UNAVAILABLE");
      }
    }

    const current = state.onboarding;
    const amount = BigInt(input.amountWei);
    if (!this.#wallet.executeRegularTransfer) blockers.push("REGULAR_TRANSFER_UNAVAILABLE");
    if (!this.#executeEnabled) blockers.push("EXECUTION_DISABLED");
    if (this.#paymentApproval === "deny") blockers.push("SECURITY_POLICY_DENIED");
    if (!current?.delegation.enabled) blockers.push("DELEGATION_DISABLED");
    if (current?.delegation.chainId !== SEPOLIA_CHAIN_ID) blockers.push("CHAIN_NOT_SEPOLIA");
    if (
      current &&
      paymentCount(state, authorization) >= (current.delegation.maxPayments ?? 1)
    ) {
      blockers.push("PAYMENT_COUNT_LIMIT");
    }
    if (
      current &&
      new Date(current.delegation.expiresAt).getTime() <= this.#clock.now().getTime()
    ) {
      blockers.push("DELEGATION_EXPIRED");
    }
    if (current) {
      const policy = current.delegation;
      const remaining = BigInt(policy.lifetimeLimitWei) - BigInt(policy.spentWei);
      if (
        (policy.maxPayments ?? 1) > MAX_POLICY_PAYMENTS ||
        BigInt(policy.perPaymentLimitWei) > MAX_POLICY_PAYMENT_LIMIT_WEI ||
        BigInt(policy.lifetimeLimitWei) > MAX_POLICY_LIFETIME_LIMIT_WEI
      ) {
        blockers.push("POLICY_OUTSIDE_HARD_BOUNDS");
      }
      if (amount > BigInt(policy.perPaymentLimitWei)) blockers.push("PER_PAYMENT_LIMIT");
      if (amount > remaining) blockers.push("LIFETIME_LIMIT");
    }
    if (this.#executionLimitWei !== undefined && amount > this.#executionLimitWei) {
      blockers.push("EXECUTION_LIMIT");
    }
    if (amount + this.#gasReserveWei > mainBalance) {
      blockers.push("INSUFFICIENT_MAIN_BALANCE_WITH_GAS_RESERVE");
    }

    const now = this.#clock.now();
    const plan: RegularTransferPlan = {
      version: 1,
      decisionId: `rwd_${randomUUID()}`,
      recipient: input.recipient,
      amountWei: input.amountWei,
      mainBalanceSnapshotWei: mainBalance.toString(),
      gasReserveWei: this.#gasReserveWei.toString(),
      authorization,
      intentDigest: digestIntent(
        input.recipient,
        input.amountWei,
        this.#gasReserveWei.toString(),
        authorization,
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
      draft.regularPlans[plan.decisionId] = plan;
    });
    return plan;
  }

  async execute(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<RegularTransferRequest> {
    if (!this.#acceptingExecutions) throw new Error("REGULAR_TRANSFER_RUNTIME_STOPPING");
    if (this.#paymentApproval === "deny") throw new Error("SECURITY_POLICY_DENIED");
    if (this.#paymentApproval === "confirm" && !input.userConfirmed) {
      throw new Error("The user must confirm the exact regular transfer");
    }
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.clientRequestId)) {
      throw new Error("client_request_id must be a stable 8-200 character identifier");
    }

    const state = await this.#store.read();
    const existing = Object.values(state.regularRequests).find(
      (request) => request.clientRequestId === input.clientRequestId,
    );
    if (existing) {
      if (existing.decisionId !== input.decisionId) throw new Error("IDEMPOTENCY_CONFLICT");
      return existing;
    }
    if (this.#execution) throw new Error("REGULAR_TRANSFER_ALREADY_EXECUTING");
    const plan = state.regularPlans[input.decisionId];
    if (!plan) throw new Error("REGULAR_TRANSFER_DECISION_NOT_FOUND");
    if (plan.decision !== "allow") throw new Error("REGULAR_TRANSFER_DECISION_DENIED");
    if (new Date(plan.expiresAt).getTime() <= this.#clock.now().getTime()) {
      throw new Error("REGULAR_TRANSFER_DECISION_EXPIRED");
    }
    if (!this.#acceptingExecutions) throw new Error("REGULAR_TRANSFER_RUNTIME_STOPPING");

    this.#execution = this.#executePlan(plan, input.clientRequestId);
    try {
      return await this.#execution;
    } finally {
      this.#execution = undefined;
    }
  }

  async getPlan(decisionId: string): Promise<RegularTransferPlan> {
    const plan = (await this.#store.read()).regularPlans[decisionId];
    if (!plan) throw new Error("REGULAR_TRANSFER_DECISION_NOT_FOUND");
    return plan;
  }

  async getRequest(requestId: string): Promise<RegularTransferRequest> {
    const request = (await this.#store.read()).regularRequests[requestId];
    if (!request) throw new Error("REGULAR_TRANSFER_REQUEST_NOT_FOUND");
    if (
      request.phase === "executing" ||
      request.phase === "submitted" ||
      request.phase === "indeterminate"
    ) {
      return this.reconcileRequest(requestId);
    }
    return request;
  }

  async reconcileRequest(requestId: string): Promise<RegularTransferRequest> {
    const request = (await this.#store.read()).regularRequests[requestId];
    if (!request) throw new Error("REGULAR_TRANSFER_REQUEST_NOT_FOUND");
    if (
      request.phase !== "executing" &&
      request.phase !== "submitted" &&
      request.phase !== "indeterminate"
    ) {
      return request;
    }

    let receiptStatus: "pending" | "success" | "reverted" | undefined;
    if (request.transactionHash && this.#chain.getTransactionReceiptStatus) {
      try {
        receiptStatus = await this.#chain.getTransactionReceiptStatus(request.transactionHash);
      } catch {
        // Reconciliation is read-only and best-effort.
      }
    }
    let delivered = false;
    if (request.recipientBalanceBeforeWei !== undefined) {
      try {
        const currentBalance = await this.#chain.getBalanceWei(request.recipient);
        delivered = currentBalance >=
          BigInt(request.recipientBalanceBeforeWei) + BigInt(request.amountWei);
      } catch {
        // Leave unresolved until a later status read.
      }
    }

    const checkedAt = this.#clock.now().toISOString();
    const updated = await this.#store.update((draft) => {
      const current = draft.regularRequests[requestId];
      if (!current || !["executing", "submitted", "indeterminate"].includes(current.phase)) return;
      current.reconciliation = {
        attempts: (current.reconciliation?.attempts ?? 0) + 1,
        checkedAt,
      };
      if (receiptStatus === "reverted") {
        current.phase = "failed";
        current.updatedAt = checkedAt;
        current.error = {
          code: "TRANSACTION_REVERTED",
          message: "The regular transfer transaction was included but reverted.",
        };
      } else if (receiptStatus === "success" || delivered) {
        current.phase = "confirmed";
        current.updatedAt = checkedAt;
        current.confirmation = {
          method: receiptStatus === "success" ? "transaction_receipt" : "recipient_balance_delta",
          checkedAt,
        };
        delete current.error;
      }
    });
    return updated.regularRequests[requestId] as RegularTransferRequest;
  }

  async stop(): Promise<void> {
    this.#acceptingExecutions = false;
    await this.#execution?.catch(() => undefined);
  }

  resetForWalletSelection(): void {
    if (this.#execution) throw new Error("REGULAR_TRANSFER_ALREADY_EXECUTING");
    this.#acceptingExecutions = true;
  }

  async #executePlan(
    plan: RegularTransferPlan,
    clientRequestId: string,
  ): Promise<RegularTransferRequest> {
    if (!this.#executeEnabled) throw new Error("EXECUTION_DISABLED");
    if (!this.#wallet.executeRegularTransfer) throw new Error("REGULAR_TRANSFER_UNAVAILABLE");
    await this.#chain.assertSepolia();
    const before = await this.#store.read();
    const mainAddress = before.onboarding?.address;
    if (!mainAddress) throw new Error("MAIN_ACCOUNT_NOT_READY");
    const liveMainBalance = await this.#chain.getBalanceWei(mainAddress);
    let recipientBalanceBefore: bigint | undefined;
    try {
      recipientBalanceBefore = await this.#chain.getBalanceWei(plan.recipient);
    } catch {
      // A transaction hash can still support receipt reconciliation.
    }

    const now = this.#clock.now().toISOString();
    const request: RegularTransferRequest = {
      version: 1,
      requestId: `rreq_${randomUUID()}`,
      clientRequestId,
      decisionId: plan.decisionId,
      recipient: plan.recipient,
      amountWei: plan.amountWei,
      gasReserveWei: plan.gasReserveWei,
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
      const storedPlan = draft.regularPlans[plan.decisionId];
      const active = activeAuthorization(draft);
      if (!storedPlan || storedPlan.decision !== "allow" ||
        storedPlan.intentDigest !== plan.intentDigest ||
        storedPlan.recipient !== plan.recipient || storedPlan.amountWei !== plan.amountWei ||
        storedPlan.gasReserveWei !== plan.gasReserveWei ||
        !sameAuthorization(storedPlan.authorization, plan.authorization) ||
        !sameAuthorization(active, plan.authorization)) {
        throw new Error("REGULAR_TRANSFER_DECISION_CHANGED");
      }
      if (!onboarding?.address || onboarding.address !== mainAddress) {
        throw new Error("MAIN_ACCOUNT_CHANGED");
      }
      if (onboarding.delegation.chainId !== SEPOLIA_CHAIN_ID) throw new Error("CHAIN_NOT_SEPOLIA");
      if (paymentCount(draft, plan.authorization) >= (onboarding.delegation.maxPayments ?? 1)) {
        throw new Error("PAYMENT_COUNT_LIMIT");
      }
      const amount = BigInt(plan.amountWei);
      const spent = BigInt(onboarding.delegation.spentWei);
      const limit = BigInt(onboarding.delegation.lifetimeLimitWei);
      if ((onboarding.delegation.maxPayments ?? 1) > MAX_POLICY_PAYMENTS ||
        BigInt(onboarding.delegation.perPaymentLimitWei) > MAX_POLICY_PAYMENT_LIMIT_WEI ||
        limit > MAX_POLICY_LIFETIME_LIMIT_WEI) {
        throw new Error("POLICY_OUTSIDE_HARD_BOUNDS");
      }
      const nowMs = this.#clock.now().getTime();
      if (new Date(storedPlan.expiresAt).getTime() <= nowMs) {
        throw new Error("REGULAR_TRANSFER_DECISION_EXPIRED");
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
      if (amount + BigInt(plan.gasReserveWei) > liveMainBalance) {
        throw new Error("INSUFFICIENT_MAIN_BALANCE_WITH_GAS_RESERVE");
      }
      onboarding.publicBalanceWei = liveMainBalance.toString();
      onboarding.delegation.spentWei = (spent + amount).toString();
      onboarding.revision += 1;
      onboarding.updatedAt = this.#clock.now().toISOString();
      draft.regularRequests[request.requestId] = request;
    });

    try {
      await this.#chain.assertSepolia();
      const result = await this.#wallet.executeRegularTransfer({
        recipient: plan.recipient,
        amountWei: BigInt(plan.amountWei),
      });
      let delivered = false;
      if (recipientBalanceBefore !== undefined) {
        try {
          const recipientBalanceAfter = await this.#chain.getBalanceWei(plan.recipient);
          delivered = recipientBalanceAfter >=
            recipientBalanceBefore + BigInt(plan.amountWei);
        } catch {
          // Receipt polling can still confirm the transaction later.
        }
      }
      let mainBalanceAfter: bigint | undefined;
      try {
        mainBalanceAfter = await this.#chain.getBalanceWei(mainAddress);
      } catch {
        // Preserve the last live pre-submit balance until a future read.
      }
      const updated = await this.#store.update((draft) => {
        const current = draft.regularRequests[request.requestId];
        if (!current) throw new Error("REGULAR_TRANSFER_REQUEST_NOT_FOUND");
        current.phase = result.confirmed || delivered
          ? "confirmed"
          : result.transactionHash
            ? "submitted"
            : "indeterminate";
        current.updatedAt = this.#clock.now().toISOString();
        if (result.transactionHash) current.transactionHash = result.transactionHash;
        if (result.confirmed || delivered) {
          current.confirmation = {
            method: result.confirmed ? "adapter" : "recipient_balance_delta",
            checkedAt: current.updatedAt,
          };
          delete current.error;
        }
        if (draft.onboarding && mainBalanceAfter !== undefined) {
          draft.onboarding.publicBalanceWei = mainBalanceAfter.toString();
          draft.onboarding.revision += 1;
          draft.onboarding.updatedAt = this.#clock.now().toISOString();
        }
      });
      return updated.regularRequests[request.requestId] as RegularTransferRequest;
    } catch {
      const updated = await this.#store.update((draft) => {
        const current = draft.regularRequests[request.requestId];
        if (!current) return;
        current.phase = "indeterminate";
        current.updatedAt = this.#clock.now().toISOString();
        current.error = {
          code: "REGULAR_TRANSFER_UNRESOLVED",
          message:
            "The regular transfer may have been submitted. Do not retry with a new client request ID.",
        };
      });
      return updated.regularRequests[request.requestId] as RegularTransferRequest;
    }
  }
}

function activeAuthorization(state: StateDocument): WalletAuthorizationBinding {
  const wallet = state.wallet;
  const profile = wallet?.profiles[wallet.activeWalletId];
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
  return left.walletId === right.walletId && left.walletName === right.walletName &&
    left.selectionEpoch === right.selectionEpoch &&
    left.authorizationId === right.authorizationId;
}

function paymentCount(state: StateDocument, authorization: WalletAuthorizationBinding): number {
  return Object.values(state.requests).filter(
    (request) => sameAuthorization(request.authorization, authorization),
  ).length + Object.values(state.regularRequests).filter(
    (request) => sameAuthorization(request.authorization, authorization),
  ).length;
}
