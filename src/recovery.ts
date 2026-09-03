import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_SHIELD_WEI,
  type ChainClient,
  type RecoveryTransferPlan,
  type RecoveryTransferRequest,
  type WalletAdapter,
  type WalletProfileRecord,
  type WalletSelectionBinding,
} from "./contracts.js";
import { StateStore, type StateDocument } from "./state/store.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;
export const DEFAULT_RECOVERY_FEE_RESERVE_WEI = 10_000_000_000_000_000n;

export interface RecoveryClock {
  now(): Date;
}

const SYSTEM_CLOCK: RecoveryClock = { now: () => new Date() };

/**
 * Owner-confirmed recovery is separate from delegated payment authority. It
 * consumes one configured Tornado denomination, sends the exact requested
 * amount through Kohaku's wallet-controlled `--next` account, and reserves
 * the remainder for paymaster fees. It is not a full-wallet sweep.
 */
export class RecoveryTransferController {
  readonly #store: StateStore;
  readonly #wallet: WalletAdapter;
  readonly #chain: ChainClient;
  readonly #clock: RecoveryClock;
  readonly #executeEnabled: boolean;
  readonly #withdrawalAmountWei: bigint;
  readonly #feeReserveWei: bigint;
  #execution: Promise<RecoveryTransferRequest> | undefined;
  #acceptingExecutions = true;

  constructor(options: {
    store: StateStore;
    wallet: WalletAdapter;
    chain: ChainClient;
    clock?: RecoveryClock;
    executeEnabled?: boolean;
    withdrawalAmountWei?: bigint;
    feeReserveWei?: bigint;
  }) {
    this.#store = options.store;
    this.#wallet = options.wallet;
    this.#chain = options.chain;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#executeEnabled = options.executeEnabled ?? true;
    this.#withdrawalAmountWei = options.withdrawalAmountWei ?? DEFAULT_SHIELD_WEI;
    this.#feeReserveWei = options.feeReserveWei ?? DEFAULT_RECOVERY_FEE_RESERVE_WEI;
    if (this.#withdrawalAmountWei <= 0n || this.#feeReserveWei <= 0n ||
      this.#feeReserveWei >= this.#withdrawalAmountWei) {
      throw new Error("Recovery withdrawal and fee reserve configuration is invalid");
    }
  }

  async recoverInterruptedRequests(): Promise<void> {
    const state = await this.#store.update((draft) => {
      for (const request of Object.values(draft.recoveryRequests)) {
        if (request.phase !== "executing") continue;
        request.phase = "indeterminate";
        request.updatedAt = this.#clock.now().toISOString();
        request.error = {
          code: "RECOVERY_EXECUTION_INTERRUPTED",
          message:
            "The runtime restarted during recovery execution; do not create or execute a replacement transfer.",
        };
      }
    });
    for (const request of Object.values(state.recoveryRequests)) {
      if (isUnresolved(request.phase)) await this.reconcileRequest(request.requestId);
    }
  }

  async plan(input: {
    recipient: string;
    amountWei: string;
  }): Promise<RecoveryTransferPlan> {
    if (!ADDRESS_PATTERN.test(input.recipient)) {
      throw new Error("recipient must be a 20-byte Ethereum address");
    }
    if (!CANONICAL_INTEGER.test(input.amountWei) || BigInt(input.amountWei) <= 0n) {
      throw new Error("amount_wei must be a positive canonical integer string");
    }
    const blockers: string[] = [];
    if (!this.#executeEnabled) blockers.push("EXECUTION_DISABLED");
    if (!this.#wallet.executeRecoveryTransfer) blockers.push("RECOVERY_TRANSFER_UNAVAILABLE");

    let state = await this.#store.read();
    if (!state.onboarding || state.onboarding.phase !== "private_ready") {
      blockers.push("PRIVATE_BALANCE_NOT_READY");
    } else {
      try {
        const privateBalance = await this.#wallet.getPrivateBalanceWei();
        state = await this.#store.update((draft) => {
          if (!draft.onboarding) return;
          if (draft.onboarding.privateBalanceWei !== privateBalance.toString()) {
            draft.onboarding.privateBalanceWei = privateBalance.toString();
            draft.onboarding.revision += 1;
            draft.onboarding.updatedAt = this.#clock.now().toISOString();
          }
        });
      } catch {
        blockers.push("PRIVATE_BALANCE_UNAVAILABLE");
      }
    }

    const wallet = activeSelection(state);
    const privateBalance = BigInt(state.onboarding?.privateBalanceWei ?? "0");
    const maxRecipient = this.#withdrawalAmountWei - this.#feeReserveWei;
    const amount = BigInt(input.amountWei);
    if (privateBalance < this.#withdrawalAmountWei) {
      blockers.push("SPENDABLE_RECOVERY_DENOMINATION_UNAVAILABLE");
    }
    if (amount > maxRecipient) blockers.push("RECOVERY_AMOUNT_EXCEEDS_SAFE_MAXIMUM");
    const remaining = privateBalance > this.#withdrawalAmountWei
      ? privateBalance - this.#withdrawalAmountWei
      : 0n;
    const balanceRevision = state.onboarding?.revision ?? 0;
    const now = this.#clock.now();
    const plan: RecoveryTransferPlan = {
      version: 1,
      decisionId: `wr_${randomUUID()}`,
      wallet,
      recipient: input.recipient,
      amountWei: input.amountWei,
      withdrawalAmountWei: this.#withdrawalAmountWei.toString(),
      feeReserveWei: this.#feeReserveWei.toString(),
      maxRecipientAmountWei: maxRecipient.toString(),
      privateBalanceSnapshotWei: privateBalance.toString(),
      remainingPrivateBalanceEstimateWei: remaining.toString(),
      balanceRevision,
      scope: "single_tornado_denomination",
      feeModel: "reserved_from_wallet_controlled_remainder",
      intentDigest: recoveryDigest({
        wallet,
        recipient: input.recipient,
        amountWei: input.amountWei,
        withdrawalAmountWei: this.#withdrawalAmountWei.toString(),
        feeReserveWei: this.#feeReserveWei.toString(),
        privateBalanceSnapshotWei: privateBalance.toString(),
        balanceRevision,
      }),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      decision: blockers.length === 0 ? "allow" : "deny",
      blockers,
      approval: { action: "confirm", userConfirmationRequired: true },
    };
    await this.#store.update((draft) => {
      draft.recoveryPlans[plan.decisionId] = plan;
    });
    return plan;
  }

  async getPlan(decisionId: string): Promise<RecoveryTransferPlan> {
    const plan = (await this.#store.read()).recoveryPlans[decisionId];
    if (!plan) throw new Error("RECOVERY_DECISION_NOT_FOUND");
    return plan;
  }

  async execute(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<RecoveryTransferRequest> {
    if (!this.#acceptingExecutions) throw new Error("RECOVERY_RUNTIME_STOPPING");
    if (!input.userConfirmed) throw new Error("The user must confirm the exact recovery transfer");
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.clientRequestId)) {
      throw new Error("client_request_id must be a stable 8-200 character identifier");
    }
    const state = await this.#store.read();
    const existing = Object.values(state.recoveryRequests).find(
      (request) => request.clientRequestId === input.clientRequestId,
    );
    if (existing) {
      if (existing.decisionId !== input.decisionId) throw new Error("IDEMPOTENCY_CONFLICT");
      return existing;
    }
    if (this.#execution) throw new Error("RECOVERY_ALREADY_EXECUTING");
    const plan = state.recoveryPlans[input.decisionId];
    if (!plan) throw new Error("RECOVERY_DECISION_NOT_FOUND");
    if (plan.decision !== "allow") throw new Error("RECOVERY_DECISION_DENIED");
    if (plan.consumedByRequestId) throw new Error("RECOVERY_DECISION_ALREADY_CONSUMED");
    if (new Date(plan.expiresAt).getTime() <= this.#clock.now().getTime()) {
      throw new Error("RECOVERY_DECISION_EXPIRED");
    }
    if (!sameSelection(activeSelection(state), plan.wallet)) {
      throw new Error("WALLET_SELECTION_CHANGED");
    }
    this.#execution = this.#executePlan(plan, input.clientRequestId);
    try {
      return await this.#execution;
    } finally {
      this.#execution = undefined;
    }
  }

  async getRequest(requestId: string): Promise<RecoveryTransferRequest> {
    const request = (await this.#store.read()).recoveryRequests[requestId];
    if (!request) throw new Error("RECOVERY_REQUEST_NOT_FOUND");
    return isUnresolved(request.phase) ? this.reconcileRequest(requestId) : request;
  }

  async reconcileRequest(requestId: string): Promise<RecoveryTransferRequest> {
    const request = (await this.#store.read()).recoveryRequests[requestId];
    if (!request) throw new Error("RECOVERY_REQUEST_NOT_FOUND");
    if (!isUnresolved(request.phase)) return request;

    let receiptStatus: "pending" | "success" | "reverted" | undefined;
    if (request.transactionHash && this.#chain.getTransactionReceiptStatus) {
      try {
        receiptStatus = await this.#chain.getTransactionReceiptStatus(request.transactionHash);
      } catch {
        // Reconciliation is read-only and best effort.
      }
    }
    let delivered = false;
    if (request.recipientBalanceBeforeWei !== undefined) {
      try {
        const current = await this.#chain.getBalanceWei(request.recipient);
        delivered = current >=
          BigInt(request.recipientBalanceBeforeWei) + BigInt(request.amountWei);
      } catch {
        // Leave unresolved when the read path is unavailable.
      }
    }
    const checkedAt = this.#clock.now().toISOString();
    const updated = await this.#store.update((draft) => {
      const current = draft.recoveryRequests[requestId];
      if (!current) throw new Error("RECOVERY_REQUEST_NOT_FOUND");
      if (!isUnresolved(current.phase)) return;
      current.reconciliation = {
        attempts: (current.reconciliation?.attempts ?? 0) + 1,
        checkedAt,
      };
      if (receiptStatus === "reverted") {
        current.phase = "failed";
        current.updatedAt = checkedAt;
        current.error = {
          code: "RECOVERY_TRANSACTION_REVERTED",
          message: "The recovery transaction was included but reverted.",
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
    return updated.recoveryRequests[requestId]!;
  }

  async stop(): Promise<void> {
    this.#acceptingExecutions = false;
    await this.#execution?.catch(() => undefined);
  }

  resetForWalletSelection(): void {
    if (this.#execution) throw new Error("RECOVERY_ALREADY_EXECUTING");
    this.#acceptingExecutions = true;
  }

  async #executePlan(plan: RecoveryTransferPlan, clientRequestId: string): Promise<RecoveryTransferRequest> {
    if (!this.#executeEnabled || !this.#wallet.executeRecoveryTransfer) {
      throw new Error("RECOVERY_TRANSFER_UNAVAILABLE");
    }
    await this.#chain.assertSepolia();
    const livePrivateBalance = await this.#wallet.getPrivateBalanceWei();
    let recipientBalanceBefore: bigint | undefined;
    try {
      recipientBalanceBefore = await this.#chain.getBalanceWei(plan.recipient);
    } catch {
      // Receipt reconciliation may still prove delivery.
    }
    const now = this.#clock.now().toISOString();
    const request: RecoveryTransferRequest = {
      version: 1,
      requestId: `wrr_${randomUUID()}`,
      clientRequestId,
      decisionId: plan.decisionId,
      wallet: plan.wallet,
      recipient: plan.recipient,
      amountWei: plan.amountWei,
      withdrawalAmountWei: plan.withdrawalAmountWei,
      feeReserveWei: plan.feeReserveWei,
      remainingPrivateBalanceEstimateWei: plan.remainingPrivateBalanceEstimateWei,
      scope: plan.scope,
      feeModel: plan.feeModel,
      phase: "executing",
      createdAt: now,
      updatedAt: now,
      ...(recipientBalanceBefore === undefined ? {} : {
        recipientBalanceBeforeWei: recipientBalanceBefore.toString(),
      }),
    };

    await this.#store.update((draft) => {
      const stored = draft.recoveryPlans[plan.decisionId];
      if (!stored || stored.decision !== "allow" || stored.consumedByRequestId ||
        stored.intentDigest !== plan.intentDigest || stored.recipient !== plan.recipient ||
        stored.amountWei !== plan.amountWei ||
        stored.withdrawalAmountWei !== plan.withdrawalAmountWei ||
        stored.feeReserveWei !== plan.feeReserveWei ||
        stored.privateBalanceSnapshotWei !== plan.privateBalanceSnapshotWei ||
        stored.balanceRevision !== plan.balanceRevision ||
        !sameSelection(stored.wallet, plan.wallet) ||
        !sameSelection(activeSelection(draft), plan.wallet)) {
        throw new Error("RECOVERY_DECISION_CHANGED");
      }
      if (new Date(stored.expiresAt).getTime() <= this.#clock.now().getTime()) {
        throw new Error("RECOVERY_DECISION_EXPIRED");
      }
      const collision = Object.values(draft.recoveryRequests).find(
        (existing) => existing.clientRequestId === clientRequestId,
      );
      if (collision) throw new Error("IDEMPOTENCY_CONFLICT");
      if (livePrivateBalance.toString() !== plan.privateBalanceSnapshotWei ||
        livePrivateBalance < BigInt(plan.withdrawalAmountWei)) {
        throw new Error("RECOVERY_BALANCE_CHANGED");
      }
      stored.consumedByRequestId = request.requestId;
      draft.recoveryRequests[request.requestId] = request;
    });

    try {
      await this.#chain.assertSepolia();
      const result = await this.#wallet.executeRecoveryTransfer({
        recipient: plan.recipient,
        amountWei: BigInt(plan.amountWei),
      });
      let delivered = false;
      if (recipientBalanceBefore !== undefined) {
        try {
          const after = await this.#chain.getBalanceWei(plan.recipient);
          delivered = after >= recipientBalanceBefore + BigInt(plan.amountWei);
        } catch {
          // Keep submitted/indeterminate until a later read can prove delivery.
        }
      }
      let privateBalanceAfter: bigint | undefined;
      try {
        privateBalanceAfter = await this.#wallet.getPrivateBalanceWei();
      } catch {
        // The durable request remains sufficient for later reconciliation.
      }
      const updated = await this.#store.update((draft) => {
        const current = draft.recoveryRequests[request.requestId];
        if (!current) throw new Error("RECOVERY_REQUEST_NOT_FOUND");
        current.phase = result.confirmed || delivered
          ? "confirmed"
          : result.transactionHash || result.userOperationHash
            ? "submitted"
            : "indeterminate";
        current.updatedAt = this.#clock.now().toISOString();
        if (result.transactionHash) current.transactionHash = result.transactionHash;
        if (result.userOperationHash) current.userOperationHash = result.userOperationHash;
        if (result.confirmed || delivered) {
          current.confirmation = {
            method: result.confirmed ? "adapter" : "recipient_balance_delta",
            checkedAt: current.updatedAt,
          };
        }
        if (draft.onboarding && privateBalanceAfter !== undefined) {
          draft.onboarding.privateBalanceWei = privateBalanceAfter.toString();
          draft.onboarding.revision += 1;
          draft.onboarding.updatedAt = current.updatedAt;
        }
      });
      return updated.recoveryRequests[request.requestId]!;
    } catch {
      const updated = await this.#store.update((draft) => {
        const current = draft.recoveryRequests[request.requestId];
        if (!current) return;
        current.phase = "indeterminate";
        current.updatedAt = this.#clock.now().toISOString();
        current.error = {
          code: "RECOVERY_TRANSFER_UNRESOLVED",
          message:
            "The confirmed recovery transfer may have been submitted. Do not retry it with a new request ID.",
        };
      });
      return updated.recoveryRequests[request.requestId]!;
    }
  }
}

function recoveryDigest(input: {
  wallet: WalletSelectionBinding;
  recipient: string;
  amountWei: string;
  withdrawalAmountWei: string;
  feeReserveWei: string;
  privateBalanceSnapshotWei: string;
  balanceRevision: number;
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    chain_id: "eip155:11155111",
    asset_type: "eip155:11155111/slip44:60",
    operation: "tornado_single_denomination_recovery_transfer",
    wallet_id: input.wallet.walletId,
    wallet_name: input.wallet.walletName,
    selection_epoch: input.wallet.selectionEpoch,
    recipient: input.recipient.toLowerCase(),
    amount_atomic: input.amountWei,
    withdrawal_amount_atomic: input.withdrawalAmountWei,
    fee_reserve_atomic: input.feeReserveWei,
    private_balance_snapshot_atomic: input.privateBalanceSnapshotWei,
    balance_revision: input.balanceRevision,
  })).digest("hex")}`;
}

function activeSelection(state: Pick<StateDocument, "wallet">): WalletSelectionBinding {
  const profile = activeProfile(state.wallet);
  if (!profile || profile.selectionEpoch < 1) throw new Error("ACTIVE_WALLET_MISSING");
  return {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
  };
}

function activeProfile(wallet: StateDocument["wallet"]): WalletProfileRecord | undefined {
  return wallet?.profiles[wallet.activeWalletId];
}

function sameSelection(
  left: WalletSelectionBinding | undefined,
  right: WalletSelectionBinding | undefined,
): boolean {
  return left !== undefined && right !== undefined && left.walletId === right.walletId &&
    left.walletName === right.walletName && left.selectionEpoch === right.selectionEpoch;
}

function isUnresolved(phase: RecoveryTransferRequest["phase"]): boolean {
  return phase === "executing" || phase === "submitted" || phase === "indeterminate";
}
