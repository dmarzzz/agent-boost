import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_SHIELD_WEI,
  type ChainClient,
  type PrivateBalanceRecord,
  type RecoveryTransferPlan,
  type RecoveryTransferRequest,
  type WalletAdapter,
  type WalletProfileRecord,
  type WalletSelectionBinding,
} from "./contracts.js";
import { WalletExecutionError } from "./errors.js";
import {
  matchingPrivateBroadcastCheckpoint,
  observeConfirmedPublicChange,
  recordPublicChangeAccount,
} from "./public-change.js";
import { StateStore, type StateDocument } from "./state/store.js";
import {
  assertUserOperationReceiptEvidenceMatches,
  sameUserOperationTerminalResult,
  terminalUserOperationReceiptEvidence,
} from "./user-operation-receipt.js";

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
        const now = this.#clock.now().toISOString();
        request.updatedAt = now;
        if (request.broadcastStartedAt) {
          request.phase = "indeterminate";
          request.error = {
            code: "RECOVERY_EXECUTION_INTERRUPTED",
            message:
              "The runtime restarted after recovery broadcast began; do not create or execute a replacement transfer.",
          };
        } else {
          request.phase = "failed";
          request.error = {
            code: "RECOVERY_INTERRUPTED_BEFORE_BROADCAST",
            message: "The runtime restarted before recovery broadcast began; the reserved private balance was restored.",
          };
          restorePrivateBalanceDebit(draft, request, now);
        }
      }
    });
    for (const request of Object.values(state.recoveryRequests)) {
      if (isUnresolved(request.phase)) await this.reconcileRequest(request.requestId);
    }
  }

  async plan(input: {
    recipient: string;
    amountWei: string;
    privateBalanceId?: string;
  }): Promise<RecoveryTransferPlan> {
    if (!ADDRESS_PATTERN.test(input.recipient)) {
      throw new Error("recipient must be a 20-byte Ethereum address");
    }
    if (!CANONICAL_INTEGER.test(input.amountWei) || BigInt(input.amountWei) <= 0n) {
      throw new Error("amount_wei must be a positive canonical integer string");
    }
    const blockers: string[] = [];
    if (!this.#executeEnabled) blockers.push("EXECUTION_DISABLED");
    if (!this.#wallet.executeRecoveryTransfer &&
      !this.#wallet.executeRecoveryTransferFromWallet) {
      blockers.push("RECOVERY_TRANSFER_UNAVAILABLE");
    }

    let state = await this.#store.read();
    let selected = activePrivateBalance(state, input.privateBalanceId);
    const unresolved = hasUnresolvedPrivateBalanceActivity(
      state,
      selected.privateBalanceId,
    );
    if (unresolved) {
      blockers.push("PRIVATE_BALANCE_OPERATION_UNRESOLVED");
    }
    if (!state.onboarding || state.onboarding.phase !== "private_ready") {
      blockers.push("PRIVATE_BALANCE_NOT_READY");
    } else if (!unresolved) {
      try {
        const privateBalance = await this.#getPrivateBalanceWei(selected);
        state = await this.#store.update((draft) => {
          if (!draft.onboarding) return;
          const profile = activeWalletProfile(draft);
          const pocket = activePrivateBalance(draft, selected.privateBalanceId);
          const now = this.#clock.now().toISOString();
          if (pocket.balanceWei !== privateBalance.toString()) {
            pocket.balanceWei = privateBalance.toString();
            pocket.revision += 1;
            pocket.updatedAt = now;
          }
          const aggregate = sumPrivateBalancesWei(profile).toString();
          if (draft.onboarding.privateBalanceWei !== aggregate) {
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

    const wallet = activeSelection(state);
    const privateBalance = BigInt(selected.balanceWei);
    const maxRecipient = this.#withdrawalAmountWei - this.#feeReserveWei;
    const amount = BigInt(input.amountWei);
    if (privateBalance < this.#withdrawalAmountWei) {
      blockers.push("SPENDABLE_RECOVERY_DENOMINATION_UNAVAILABLE");
    }
    if (amount > maxRecipient) blockers.push("RECOVERY_AMOUNT_EXCEEDS_SAFE_MAXIMUM");
    const remaining = privateBalance > this.#withdrawalAmountWei
      ? privateBalance - this.#withdrawalAmountWei
      : 0n;
    const balanceRevision = selected.revision;
    const now = this.#clock.now();
    const plan: RecoveryTransferPlan = {
      version: 1,
      decisionId: `wr_${randomUUID()}`,
      wallet,
      privateBalanceId: selected.privateBalanceId,
      privateBalanceRevision: selected.revision,
      privateBalanceDebitWei: this.#withdrawalAmountWei.toString(),
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
        privateBalanceId: selected.privateBalanceId,
        privateBalanceRevision: selected.revision,
        privateBalanceDebitWei: this.#withdrawalAmountWei.toString(),
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

  async cancel(decisionId: string): Promise<RecoveryTransferPlan> {
    const state = await this.#store.update((draft) => {
      const plan = draft.recoveryPlans[decisionId];
      if (!plan) throw new Error("RECOVERY_DECISION_NOT_FOUND");
      if (plan.consumedByRequestId || Object.values(draft.recoveryRequests).some(
        (request) => request.decisionId === decisionId,
      )) {
        throw new Error("RECOVERY_DECISION_ALREADY_CONSUMED");
      }
      plan.decision = "deny";
      if (!plan.blockers.includes("USER_CANCELLED")) plan.blockers.push("USER_CANCELLED");
    });
    return state.recoveryPlans[decisionId]!;
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
    if (plan.blockers.includes("USER_CANCELLED")) {
      throw new Error("RECOVERY_DECISION_CANCELLED");
    }
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
    const initialState = await this.#store.read();
    const request = initialState.recoveryRequests[requestId];
    if (!request) throw new Error("RECOVERY_REQUEST_NOT_FOUND");
    if (!isUnresolved(request.phase)) return request;

    let receiptStatus: "pending" | "success" | "reverted" | undefined;
    let receiptTransactionHash: string | undefined;
    let receiptMethod: "transaction_receipt" | "user_operation_receipt" | undefined;
    let receiptEvidence = request.userOperationReceiptEvidence;
    let newReceiptEvidence: typeof receiptEvidence;
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
    if (receiptEvidence && !checkpoint && !reconciliationError) {
      reconciliationError = "PRIVATE_BROADCAST_CHECKPOINT_MISMATCH";
    }
    const userOperationHash = reconciliationError
      ? undefined
      : request.userOperationHash ?? checkpoint?.userOperationHash;
    if (receiptEvidence && checkpoint && !reconciliationError) {
      try {
        assertUserOperationReceiptEvidenceMatches({
          evidence: receiptEvidence,
          checkpoint,
          ...(request.userOperationHash === undefined
            ? {}
            : { storedUserOperationHash: request.userOperationHash }),
          ...(request.transactionHash === undefined
            ? {}
            : { storedTransactionHash: request.transactionHash }),
        });
        receiptStatus = receiptEvidence.status;
        receiptTransactionHash = receiptEvidence.transactionHash;
        receiptMethod = "user_operation_receipt";
      } catch {
        reconciliationError = "PRIVATE_BROADCAST_CHECKPOINT_MISMATCH";
      }
    } else if (userOperationHash) {
      if (this.#chain.getUserOperationReceiptStatus) {
        try {
          const result = await this.#chain.getUserOperationReceiptStatus(
            userOperationHash,
            checkpoint?.sender,
          );
          receiptStatus = result.status;
          if (result.status !== "pending") {
            if (request.transactionHash &&
              request.transactionHash.toLowerCase() !==
                result.transactionHash.toLowerCase()) {
              throw new Error("UserOperation receipt transaction hash mismatch");
            }
            newReceiptEvidence = checkpoint
              ? terminalUserOperationReceiptEvidence({
                  userOperationHash,
                  receipt: result,
                  observedAt: this.#clock.now().toISOString(),
                  ...(request.transactionHash === undefined
                    ? {}
                    : { storedTransactionHash: request.transactionHash }),
                })
              : undefined;
            receiptTransactionHash = result.transactionHash;
            receiptMethod = "user_operation_receipt";
          }
        } catch {
          // Reconciliation is read-only and best effort.
          receiptStatus = undefined;
          receiptTransactionHash = undefined;
          receiptMethod = undefined;
        }
      }
    } else if (!request.userOperationHash && !checkpoint && !reconciliationError &&
      request.transactionHash && this.#chain.getTransactionReceiptStatus) {
      try {
        receiptStatus = await this.#chain.getTransactionReceiptStatus(request.transactionHash);
        receiptMethod = "transaction_receipt";
      } catch {
        // Reconciliation is read-only and best effort.
      }
    }
    if (newReceiptEvidence && checkpoint) {
      const evidenceState = await this.#store.update((draft) => {
        const current = draft.recoveryRequests[requestId];
        if (!current) throw new Error("RECOVERY_REQUEST_NOT_FOUND");
        if (current.userOperationHash &&
          current.userOperationHash.toLowerCase() !==
            newReceiptEvidence!.userOperationHash.toLowerCase()) {
          throw new Error("UserOperation receipt evidence hash mismatch");
        }
        if (current.transactionHash &&
          current.transactionHash.toLowerCase() !==
            newReceiptEvidence!.transactionHash.toLowerCase()) {
          throw new Error("UserOperation receipt transaction hash mismatch");
        }
        if (current.userOperationReceiptEvidence) {
          if (!sameUserOperationTerminalResult(
            current.userOperationReceiptEvidence,
            newReceiptEvidence!,
          )) {
            throw new Error("UserOperation terminal receipt evidence is immutable");
          }
        } else {
          current.userOperationHash = newReceiptEvidence!.userOperationHash;
          current.transactionHash = newReceiptEvidence!.transactionHash;
          current.userOperationReceiptEvidence = newReceiptEvidence!;
          current.updatedAt = newReceiptEvidence!.observedAt;
        }
      });
      receiptEvidence = evidenceState.recoveryRequests[requestId]
        ?.userOperationReceiptEvidence;
      if (!receiptEvidence) throw new Error("UserOperation receipt evidence was not persisted");
      assertUserOperationReceiptEvidenceMatches({
        evidence: receiptEvidence,
        checkpoint,
        storedUserOperationHash: receiptEvidence.userOperationHash,
        storedTransactionHash: receiptEvidence.transactionHash,
      });
      receiptStatus = receiptEvidence.status;
      receiptTransactionHash = receiptEvidence.transactionHash;
      receiptMethod = "user_operation_receipt";
    }
    let publicChangeWei: bigint | undefined;
    if (receiptStatus === "success" && checkpoint && request.privateBalanceId) {
      const privateBalance = initialState.wallet?.profiles[
        request.wallet.walletId
      ]?.privateBalances[request.privateBalanceId];
      if (!privateBalance) {
        reconciliationError = "PUBLIC_CHANGE_TRACKING_PENDING";
        receiptStatus = undefined;
      } else {
        try {
          publicChangeWei = await observeConfirmedPublicChange({
            wallet: this.#wallet,
            chain: this.#chain,
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
      const current = draft.recoveryRequests[requestId];
      if (!current) throw new Error("RECOVERY_REQUEST_NOT_FOUND");
      if (!isUnresolved(current.phase)) return;
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
          code: "RECOVERY_TRANSACTION_REVERTED",
          message: "The recovery transaction was included but reverted.",
        };
        restorePrivateBalanceDebit(draft, current, checkedAt);
      } else if (receiptStatus === "success") {
        if (checkpoint && publicChangeWei !== undefined && current.privateBalanceId) {
          const profile = draft.wallet?.profiles[current.wallet.walletId];
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
          code: "RECOVERY_NOT_BROADCAST",
          message: "The recovery stopped before broadcast; the reserved private balance was restored.",
        };
        restorePrivateBalanceDebit(draft, current, checkedAt);
      } else if (reconciliationError) {
        current.updatedAt = checkedAt;
        current.error = {
          code: reconciliationError,
          message: reconciliationError === "PRIVATE_BROADCAST_CHECKPOINT_MISMATCH"
            ? "The durable private broadcast checkpoint does not match this recovery. It was not retried."
            : "The recovery is on-chain, but its wallet-controlled public change is still being recovered before completion is reported.",
        };
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
    if (!this.#executeEnabled || (!this.#wallet.executeRecoveryTransfer &&
      !this.#wallet.executeRecoveryTransferFromWallet)) {
      throw new Error("RECOVERY_TRANSFER_UNAVAILABLE");
    }
    if (!plan.privateBalanceId || plan.privateBalanceRevision === undefined ||
      !plan.privateBalanceDebitWei) {
      throw new Error("PRIVATE_BALANCE_BINDING_MISSING");
    }
    const privateBalanceId = plan.privateBalanceId;
    const privateBalanceRevision = plan.privateBalanceRevision;
    const privateBalanceDebitWei = plan.privateBalanceDebitWei;
    await this.#chain.assertSepolia();
    const sourcePrivateBalance = activePrivateBalance(
      await this.#store.read(),
      privateBalanceId,
    );
    const livePrivateBalance = await this.#getPrivateBalanceWei(sourcePrivateBalance);
    const now = this.#clock.now().toISOString();
    const request: RecoveryTransferRequest = {
      version: 1,
      requestId: `wrr_${randomUUID()}`,
      clientRequestId,
      decisionId: plan.decisionId,
      wallet: plan.wallet,
      privateBalanceId,
      privateBalanceRevision,
      privateBalanceDebitWei,
      privateBalanceDebitedAt: now,
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
    };

    await this.#store.update((draft) => {
      const stored = draft.recoveryPlans[plan.decisionId];
      const profile = activeWalletProfile(draft);
      if (!stored || stored.decision !== "allow" || stored.consumedByRequestId ||
        stored.intentDigest !== plan.intentDigest || stored.recipient !== plan.recipient ||
        stored.amountWei !== plan.amountWei ||
        stored.withdrawalAmountWei !== plan.withdrawalAmountWei ||
        stored.feeReserveWei !== plan.feeReserveWei ||
        stored.privateBalanceSnapshotWei !== plan.privateBalanceSnapshotWei ||
        stored.balanceRevision !== plan.balanceRevision ||
        stored.privateBalanceId !== privateBalanceId ||
        stored.privateBalanceRevision !== privateBalanceRevision ||
        stored.privateBalanceDebitWei !== privateBalanceDebitWei ||
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
      const pocket = profile.privateBalances[privateBalanceId];
      if (!pocket || pocket.status !== "available") {
        throw new Error("PRIVATE_BALANCE_NOT_FOUND");
      }
      if (pocket.revision !== privateBalanceRevision) {
        throw new Error("PRIVATE_BALANCE_CHANGED");
      }
      if (hasUnresolvedPrivateBalanceActivity(draft, privateBalanceId)) {
        throw new Error("PRIVATE_BALANCE_OPERATION_UNRESOLVED");
      }
      if (livePrivateBalance.toString() !== plan.privateBalanceSnapshotWei ||
        livePrivateBalance < BigInt(privateBalanceDebitWei) ||
        BigInt(pocket.balanceWei) < BigInt(privateBalanceDebitWei)) {
        throw new Error("RECOVERY_BALANCE_CHANGED");
      }
      pocket.balanceWei = (
        livePrivateBalance - BigInt(privateBalanceDebitWei)
      ).toString();
      pocket.revision += 1;
      pocket.updatedAt = now;
      if (draft.onboarding) {
        draft.onboarding.privateBalanceWei = sumPrivateBalancesWei(profile).toString();
        draft.onboarding.revision += 1;
        draft.onboarding.updatedAt = now;
      }
      stored.consumedByRequestId = request.requestId;
      draft.recoveryRequests[request.requestId] = request;
    });

    try {
      await this.#chain.assertSepolia();
      const result = await this.#executeRecoveryTransfer(sourcePrivateBalance, {
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
          // Exact receipt reconciliation owns checkpoint mismatch handling.
        }
      }
      const exactUserOperationHash = result.userOperationHash ??
        checkpoint?.userOperationHash;
      let privateBalanceAfter: bigint | undefined;
      try {
        privateBalanceAfter = await this.#getPrivateBalanceWei(sourcePrivateBalance);
      } catch {
        // The durable request remains sufficient for later reconciliation.
      }
      const updated = await this.#store.update((draft) => {
        const current = draft.recoveryRequests[request.requestId];
        if (!current) throw new Error("RECOVERY_REQUEST_NOT_FOUND");
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
        if (exactUserOperationHash) current.userOperationHash = exactUserOperationHash;
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
              "The durable private broadcast checkpoint does not match this recovery. It was not retried.",
          };
        }
        if (draft.onboarding && privateBalanceAfter !== undefined &&
          current.privateBalanceId) {
          const profile = draft.wallet?.profiles[current.wallet.walletId];
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
          draft.onboarding.updatedAt = current.updatedAt;
        }
      });
      return updated.recoveryRequests[request.requestId]!;
    } catch (error) {
      const definitelyNotBroadcast = error instanceof WalletExecutionError &&
        !error.mayHaveBroadcast;
      const updated = await this.#store.update((draft) => {
        const current = draft.recoveryRequests[request.requestId];
        if (!current) return;
        current.updatedAt = this.#clock.now().toISOString();
        if (definitelyNotBroadcast) {
          current.phase = "failed";
          current.error = {
            code: "RECOVERY_REJECTED_BEFORE_BROADCAST",
            message: "The recovery failed before broadcast; the reserved private balance was restored.",
          };
          restorePrivateBalanceDebit(draft, current, current.updatedAt);
        } else {
          current.phase = "indeterminate";
          current.error = {
            code: "RECOVERY_TRANSFER_UNRESOLVED",
            message:
              "The confirmed recovery transfer may have been submitted. Do not retry it with a new request ID.",
          };
        }
      });
      return updated.recoveryRequests[request.requestId]!;
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

  #executeRecoveryTransfer(
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
    if (this.#wallet.executeRecoveryTransferFromWallet) {
      return this.#wallet.executeRecoveryTransferFromWallet(
        privateBalance.backendWalletName,
        input,
      );
    }
    this.#wallet.selectWallet?.(privateBalance.backendWalletName);
    return this.#wallet.executeRecoveryTransfer!(input);
  }

  async #markBroadcastStarted(requestId: string): Promise<void> {
    await this.#store.update((draft) => {
      const request = draft.recoveryRequests[requestId];
      if (!request || request.phase !== "executing" || request.broadcastStartedAt) {
        throw new Error("RECOVERY_REQUEST_NOT_EXECUTABLE");
      }
      request.broadcastStartedAt = this.#clock.now().toISOString();
      request.updatedAt = request.broadcastStartedAt;
    });
  }
}

function recoveryDigest(input: {
  wallet: WalletSelectionBinding;
  privateBalanceId: string;
  privateBalanceRevision: number;
  privateBalanceDebitWei: string;
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
    private_balance_id: input.privateBalanceId,
    private_balance_revision: input.privateBalanceRevision,
    private_balance_debit_atomic: input.privateBalanceDebitWei,
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

function activeWalletProfile(state: StateDocument): WalletProfileRecord {
  const profile = activeProfile(state.wallet);
  if (!profile) throw new Error("ACTIVE_WALLET_PROFILE_MISSING");
  return profile;
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

function sumPrivateBalancesWei(profile: WalletProfileRecord): bigint {
  return Object.values(profile.privateBalances).reduce(
    (sum, privateBalance) => privateBalance.status === "available"
      ? sum + BigInt(privateBalance.balanceWei)
      : sum,
    0n,
  );
}

function hasUnresolvedPrivateBalanceActivity(
  state: StateDocument,
  privateBalanceId: string,
): boolean {
  if (Object.values(state.requests).some(
    (request) => request.privateBalanceId === privateBalanceId &&
      isUnresolved(request.phase),
  )) return true;
  if (Object.values(state.recoveryRequests).some(
    (request) => request.privateBalanceId === privateBalanceId &&
      isUnresolved(request.phase),
  )) return true;
  if (Object.values(state.regularRequests).some(
    (request) => request.sourcePrivateBalance?.privateBalanceId ===
        privateBalanceId && isUnresolved(request.phase),
  )) return true;
  return Object.values(state.privateBalanceFundingRequests).some((request) =>
    isUnresolved(request.phase) &&
    (request.targetPrivateBalance.privateBalanceId === privateBalanceId ||
      request.sourcePrivateBalance?.privateBalanceId === privateBalanceId)
  );
}

function restorePrivateBalanceDebit(
  state: StateDocument,
  request: RecoveryTransferRequest,
  restoredAt: string,
): void {
  if (request.privateBalanceRestoredAt || !request.privateBalanceDebitedAt ||
    !request.privateBalanceId || !request.privateBalanceDebitWei) {
    return;
  }
  const profile = state.wallet?.profiles[request.wallet.walletId];
  const privateBalance = profile?.privateBalances[request.privateBalanceId];
  if (!profile || !privateBalance) {
    throw new Error("PRIVATE_BALANCE_RESTORE_TARGET_MISSING");
  }
  privateBalance.balanceWei = (
    BigInt(privateBalance.balanceWei) + BigInt(request.privateBalanceDebitWei)
  ).toString();
  privateBalance.revision += 1;
  privateBalance.updatedAt = restoredAt;
  const onboarding = state.wallet?.activeWalletId === profile.walletId
    ? state.onboarding
    : profile.onboarding;
  if (onboarding) {
    onboarding.privateBalanceWei = sumPrivateBalancesWei(profile).toString();
    onboarding.revision += 1;
    onboarding.updatedAt = restoredAt;
  }
  request.privateBalanceRestoredAt = restoredAt;
}

function sameSelection(
  left: WalletSelectionBinding | undefined,
  right: WalletSelectionBinding | undefined,
): boolean {
  return left !== undefined && right !== undefined && left.walletId === right.walletId &&
    left.walletName === right.walletName && left.selectionEpoch === right.selectionEpoch;
}

function isUnresolved(phase: string): boolean {
  return phase === "executing" || phase === "submitted" || phase === "indeterminate";
}
