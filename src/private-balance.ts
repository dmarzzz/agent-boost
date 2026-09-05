import { createHash, randomUUID } from "node:crypto";

import type {
  ChainClient,
  DelegationPolicy,
  PrivateBalanceBinding,
  PrivateBalanceCreationPlan,
  PrivateBalanceCreationRequest,
  PrivateBalanceFundingPlan,
  PrivateBalanceFundingRequest,
  PrivateBalanceRecord,
  WalletAdapter,
  WalletProfileRecord,
  WalletSelectionBinding,
} from "./contracts.js";
import { TORNADO_DEPOSIT_GAS_RESERVE_WEI } from "./contracts.js";
import { WalletExecutionError } from "./errors.js";
import {
  matchingPrivateBroadcastCheckpoint,
  matchingRawTransactionBroadcastCheckpoint,
  observeConfirmedPublicChange,
  recordPublicChangeAccount,
} from "./public-change.js";
import { StateStore, type StateDocument } from "./state/store.js";
import {
  assertUserOperationReceiptEvidenceMatches,
  sameUserOperationTerminalResult,
  terminalUserOperationReceiptEvidence,
} from "./user-operation-receipt.js";

const ATOMIC_PATTERN = /^(0|[1-9][0-9]*)$/;
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const PRIVATE_BALANCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const CALLDATA_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const DEFAULT_DECISION_TTL_MS = 5 * 60_000;

const UNRESOLVED_FUNDING_PHASES = new Set<PrivateBalanceFundingRequest["phase"]>([
  "executing",
  "submitted",
  "indeterminate",
]);

export interface PrivateBalanceClock {
  now(): Date;
}

const SYSTEM_CLOCK: PrivateBalanceClock = { now: () => new Date() };

export type PrivateBalanceFundingSourceInput =
  | { kind: "main" }
  | { kind: "private_balance"; privateBalance: string };

export interface PrivateBalanceFundingPreviewInput {
  source: PrivateBalanceFundingSourceInput;
  targetPrivateBalance: string;
  amountWei: string;
}

type PreparedDepositCall = PrivateBalanceFundingPlan["preparedDepositCall"];

/** Physical, named-wallet operations required for isolated private balances. */
interface IsolatedPrivateBalanceAdapter extends WalletAdapter {
  ensureBackendWallet?(walletName: string): Promise<void>;
  syncBackendWallet?(walletName: string): Promise<bigint>;
  getPrivateBalanceWeiForWallet?(walletName: string): Promise<bigint>;
  peekNextFreshAddressForWallet?(walletName: string): Promise<string>;
  prepareTornadoEthDeposit?(input: {
    targetWalletName: string;
    executorAddress: string;
    amountWei: bigint;
  }): Promise<{
    targetCommitment: string;
    preparedDepositCall: PreparedDepositCall;
  }>;
  executePreparedMainDeposit?(input: {
    sourceWalletName: string;
    sourceExecutorAddress: string;
    preparedDepositCall: PreparedDepositCall;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash?: string; confirmed?: boolean }>;
  executePrivateRebalance?(input: {
    sourceWalletName: string;
    sourceExecutorAddress: string;
    withdrawalAmountWei: bigint;
    preparedDepositCall: PreparedDepositCall;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash?: string;
    userOperationHash?: string;
    confirmed?: boolean;
  }>;
}

interface FundingObservations {
  sourcePrivateBalanceWei?: bigint;
  targetPrivateBalanceWei?: bigint;
}

/**
 * Durable controller for physically isolated, named private balances.
 *
 * Every named balance has its own hidden Kohaku wallet. Main funding executes a
 * target-wallet-prepared Tornado deposit from the top-level wallet. Private
 * rebalancing consumes whole source notes and makes that same prepared deposit
 * the unshield tail call. No backing wallet name, executor, commitment, or call
 * should be serialized into an MCP response by callers of this internal API.
 */
export class PrivateBalanceController {
  readonly #store: StateStore;
  readonly #wallet: IsolatedPrivateBalanceAdapter;
  readonly #chain: ChainClient;
  readonly #clock: PrivateBalanceClock;
  readonly #shieldDenominationWei: bigint;
  readonly #gasReserveWei: bigint;
  readonly #decisionTtlMs: number;
  readonly #executeEnabled: boolean;
  #creationExecution: Promise<PrivateBalanceCreationRequest> | undefined;
  #fundingExecution: Promise<PrivateBalanceFundingRequest> | undefined;
  #acceptingExecutions = true;

  constructor(options: {
    store: StateStore;
    wallet: WalletAdapter;
    chain: ChainClient;
    shieldDenominationWei: bigint;
    gasReserveWei?: bigint;
    decisionTtlMs?: number;
    executeEnabled?: boolean;
    clock?: PrivateBalanceClock;
  }) {
    this.#store = options.store;
    this.#wallet = options.wallet;
    this.#chain = options.chain;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#shieldDenominationWei = options.shieldDenominationWei;
    this.#gasReserveWei = options.gasReserveWei ?? TORNADO_DEPOSIT_GAS_RESERVE_WEI;
    this.#decisionTtlMs = options.decisionTtlMs ?? DEFAULT_DECISION_TTL_MS;
    this.#executeEnabled = options.executeEnabled ?? true;
    if (this.#shieldDenominationWei <= 0n) {
      throw new Error("shieldDenominationWei must be positive");
    }
    if (this.#gasReserveWei < 0n) throw new Error("gasReserveWei cannot be negative");
    if (!Number.isSafeInteger(this.#decisionTtlMs) || this.#decisionTtlMs <= 0) {
      throw new Error("decisionTtlMs must be a positive safe integer");
    }
  }

  async previewCreation(input: { name: string }): Promise<PrivateBalanceCreationPlan> {
    const name = canonicalPrivateBalanceName(input.name);
    await this.#store.ensureWalletProfile("agent-boost");
    const state = await this.#store.read();
    const { profile, wallet, onboarding } = activeWalletContext(state);
    const blockers: string[] = [];
    if (name.toLowerCase() === "main") blockers.push("PRIVATE_BALANCE_NAME_RESERVED");
    if (findPrivateBalance(profile.privateBalances, name)) {
      blockers.push("PRIVATE_BALANCE_NAME_TAKEN");
    }
    if (!onboarding) blockers.push("WALLET_SETUP_NOT_STARTED");
    if (!this.#wallet.ensureBackendWallet || !this.#wallet.syncBackendWallet) {
      blockers.push("ISOLATED_PRIVATE_BALANCE_UNAVAILABLE");
    }

    const privateBalanceId = `pb_${randomUUID()}`;
    const backendWalletName = hiddenBackendWalletName(wallet.walletId, privateBalanceId);
    if (Object.values(profile.privateBalances).some(
      (balance) => balance.backendWalletName === backendWalletName,
    )) {
      blockers.push("PRIVATE_BALANCE_BACKEND_COLLISION");
    }
    const initialPolicy = copyInitialPolicy(onboarding?.delegation);
    const walletOnboardingRevision = onboarding?.revision ?? 0;
    const now = this.#clock.now();
    const digestInput = {
      wallet,
      walletOnboardingRevision,
      privateBalanceId,
      privateBalanceName: name,
      backendWalletName,
      initialPolicy,
    };
    const plan: PrivateBalanceCreationPlan = {
      version: 1,
      decisionId: `pbc_${randomUUID()}`,
      ...digestInput,
      intentDigest: creationIntentDigest(digestInput),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#decisionTtlMs).toISOString(),
      decision: blockers.length === 0 ? "allow" : "deny",
      blockers,
      approval: { action: "confirm", userConfirmationRequired: true },
    };
    await this.#store.update((draft) => {
      draft.privateBalanceCreationPlans[plan.decisionId] = plan;
    });
    return plan;
  }

  async getCreation(decisionId: string): Promise<PrivateBalanceCreationPlan> {
    const plan = (await this.#store.read()).privateBalanceCreationPlans[decisionId];
    if (!plan) throw new Error("PRIVATE_BALANCE_CREATION_DECISION_NOT_FOUND");
    return plan;
  }

  async cancelCreation(decisionId: string): Promise<PrivateBalanceCreationPlan> {
    const state = await this.#store.update((draft) => {
      const plan = draft.privateBalanceCreationPlans[decisionId];
      if (!plan) throw new Error("PRIVATE_BALANCE_CREATION_DECISION_NOT_FOUND");
      if (plan.consumedByRequestId || plan.appliedAt) {
        throw new Error("PRIVATE_BALANCE_CREATION_DECISION_ALREADY_CONSUMED");
      }
      if (!plan.blockers.includes("USER_CANCELLED")) {
        plan.decision = "deny";
        plan.blockers.push("USER_CANCELLED");
        plan.cancelledAt = this.#clock.now().toISOString();
      }
    });
    return state.privateBalanceCreationPlans[decisionId]!;
  }

  async applyCreation(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<PrivateBalanceCreationRequest> {
    if (!this.#acceptingExecutions) throw new Error("PRIVATE_BALANCE_RUNTIME_STOPPING");
    requireUserConfirmation(input.userConfirmed, "private balance creation");
    validateClientRequestId(input.clientRequestId);
    const state = await this.#store.read();
    const existing = Object.values(state.privateBalanceCreationRequests).find(
      (request) => request.clientRequestId === input.clientRequestId,
    );
    if (existing) {
      if (existing.decisionId !== input.decisionId) throw new Error("IDEMPOTENCY_CONFLICT");
      return existing;
    }
    if (Object.values(state.privateBalanceCreationRequests).some(
      (request) => request.decisionId === input.decisionId,
    )) {
      throw new Error("PRIVATE_BALANCE_CREATION_DECISION_ALREADY_CONSUMED");
    }
    if (this.#creationExecution) throw new Error("PRIVATE_BALANCE_CREATION_ALREADY_EXECUTING");
    const plan = state.privateBalanceCreationPlans[input.decisionId];
    assertCreationPlanExecutable(plan, this.#clock.now());
    if (!this.#acceptingExecutions) throw new Error("PRIVATE_BALANCE_RUNTIME_STOPPING");

    this.#creationExecution = this.#applyCreationPlan(plan, input.clientRequestId);
    try {
      return await this.#creationExecution;
    } finally {
      this.#creationExecution = undefined;
    }
  }

  async creationStatus(requestId: string): Promise<PrivateBalanceCreationRequest> {
    const request = (await this.#store.read()).privateBalanceCreationRequests[requestId];
    if (!request) throw new Error("PRIVATE_BALANCE_CREATION_REQUEST_NOT_FOUND");
    if (request.phase === "creating" || request.phase === "indeterminate") {
      return this.#reconcileCreation(requestId);
    }
    return request;
  }

  async previewFunding(
    input: PrivateBalanceFundingPreviewInput,
  ): Promise<PrivateBalanceFundingPlan> {
    const amountWei = canonicalPositiveAmount(input.amountWei);
    if (BigInt(amountWei) !== this.#shieldDenominationWei) {
      throw new Error("PRIVATE_BALANCE_FUNDING_REQUIRES_ONE_DENOMINATION");
    }
    const adapter = requireFundingPreparationAdapter(this.#wallet);
    await this.#store.ensureWalletProfile("agent-boost");
    let state = await this.#store.read();
    const initial = activeWalletContext(state);
    const targetAtStart = resolveAvailablePrivateBalance(
      initial.profile.privateBalances,
      input.targetPrivateBalance,
    );
    const sourceAtStart = input.source.kind === "private_balance"
      ? resolveAvailablePrivateBalance(
          initial.profile.privateBalances,
          input.source.privateBalance,
        )
      : undefined;
    if (sourceAtStart?.privateBalanceId === targetAtStart.privateBalanceId) {
      throw new Error("SOURCE_AND_TARGET_MUST_DIFFER");
    }
    const initialRoute: PrivateBalanceFundingPlan["route"] = sourceAtStart
      ? "rebalance_private"
      : "shield_from_main";
    const initialSourceBinding = sourceAtStart
      ? privateBalanceBinding(initial.wallet, sourceAtStart)
      : undefined;
    if (hasConflictingUnresolvedFunding(state, {
      sourceWallet: initial.wallet,
      route: initialRoute,
      ...(initialSourceBinding ? { sourcePrivateBalance: initialSourceBinding } : {}),
      targetPrivateBalance: privateBalanceBinding(initial.wallet, targetAtStart),
    })) {
      throw new Error("PRIVATE_BALANCE_FUNDING_CONFLICT_UNRESOLVED");
    }

    const [targetLive, sourceLive] = await Promise.all([
      adapter.getPrivateBalanceWeiForWallet(targetAtStart.backendWalletName),
      sourceAtStart
        ? adapter.getPrivateBalanceWeiForWallet(sourceAtStart.backendWalletName)
        : Promise.resolve(undefined),
    ]);
    state = await this.#store.update((draft) => {
      const current = activeWalletContext(draft);
      if (!sameWalletBinding(current.wallet, initial.wallet)) {
        throw new Error("WALLET_SELECTION_CHANGED");
      }
      refreshPrivateBalanceRecord(
        current.profile,
        targetAtStart.privateBalanceId,
        targetAtStart.revision,
        targetLive,
        this.#clock.now().toISOString(),
      );
      if (sourceAtStart && sourceLive !== undefined) {
        refreshPrivateBalanceRecord(
          current.profile,
          sourceAtStart.privateBalanceId,
          sourceAtStart.revision,
          sourceLive,
          this.#clock.now().toISOString(),
        );
      }
      syncDefaultPrivateBalance(draft, current.profile, this.#clock.now().toISOString());
    });

    const context = activeWalletContext(state);
    const target = resolveAvailablePrivateBalance(
      context.profile.privateBalances,
      targetAtStart.privateBalanceId,
    );
    const source = sourceAtStart
      ? resolveAvailablePrivateBalance(
          context.profile.privateBalances,
          sourceAtStart.privateBalanceId,
        )
      : undefined;
    const route: PrivateBalanceFundingPlan["route"] = source
      ? "rebalance_private"
      : "shield_from_main";
    const sourcePrivateBalance = source
      ? privateBalanceBinding(context.wallet, source)
      : undefined;
    const targetPrivateBalance = privateBalanceBinding(context.wallet, target);
    if (hasConflictingUnresolvedFunding(state, {
      sourceWallet: context.wallet,
      route,
      ...(sourcePrivateBalance ? { sourcePrivateBalance } : {}),
      targetPrivateBalance,
    })) {
      throw new Error("PRIVATE_BALANCE_FUNDING_CONFLICT_UNRESOLVED");
    }

    let mainBalanceSnapshotWei = "0";
    let sourceExecutorAddress: string;
    let withdrawalAmountWei: string | undefined;
    const blockers: string[] = [];
    if (!this.#executeEnabled) blockers.push("EXECUTION_DISABLED");
    if (route === "shield_from_main") {
      sourceExecutorAddress = context.onboarding?.address ?? "";
      if (!ADDRESS_PATTERN.test(sourceExecutorAddress)) {
        throw new Error("MAIN_ACCOUNT_NOT_READY");
      }
      await this.#chain.assertSepolia();
      const mainBalance = await this.#chain.getBalanceWei(sourceExecutorAddress);
      mainBalanceSnapshotWei = mainBalance.toString();
      if (BigInt(amountWei) + this.#gasReserveWei > mainBalance) {
        blockers.push("INSUFFICIENT_MAIN_BALANCE_WITH_GAS_RESERVE");
      }
    } else {
      sourceExecutorAddress = await adapter.peekNextFreshAddressForWallet(
        source!.backendWalletName,
      );
      if (!ADDRESS_PATTERN.test(sourceExecutorAddress)) {
        throw new Error("PRIVATE_BALANCE_EXECUTOR_INVALID");
      }
      const withdrawal = roundUpToMultiple(
        BigInt(amountWei) + this.#gasReserveWei,
        this.#shieldDenominationWei,
      );
      withdrawalAmountWei = withdrawal.toString();
      if (BigInt(source!.balanceWei) < withdrawal) {
        blockers.push("INSUFFICIENT_SOURCE_PRIVATE_BALANCE_WITH_FEE_RESERVE");
      }
    }

    const prepared = await adapter.prepareTornadoEthDeposit({
      targetWalletName: target.backendWalletName,
      executorAddress: sourceExecutorAddress,
      amountWei: BigInt(amountWei),
    });
    validatePreparedDeposit(prepared, amountWei);
    const aggregatePrivateBalanceSnapshotWei = sumPrivateBalances(
      context.profile.privateBalances,
    ).toString();
    const digestInput = {
      sourceWallet: context.wallet,
      targetWallet: context.wallet,
      route,
      ...(sourcePrivateBalance ? { sourcePrivateBalance } : {}),
      targetPrivateBalance,
      amountWei,
      mainBalanceSnapshotWei,
      gasReserveWei: this.#gasReserveWei.toString(),
      shieldDenominationWei: this.#shieldDenominationWei.toString(),
      ...(withdrawalAmountWei ? { withdrawalAmountWei } : {}),
      aggregatePrivateBalanceSnapshotWei,
      ...(source
        ? { sourcePrivateBalanceSnapshotWei: source.balanceWei }
        : {}),
      targetPrivateBalanceSnapshotWei: target.balanceWei,
      sourceExecutorAddress,
      targetCommitment: prepared.targetCommitment,
      preparedDepositCall: prepared.preparedDepositCall,
    };
    const now = this.#clock.now();
    const plan: PrivateBalanceFundingPlan = {
      version: 1,
      decisionId: `pbf_${randomUUID()}`,
      ...digestInput,
      intentDigest: fundingIntentDigest(digestInput),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#decisionTtlMs).toISOString(),
      decision: blockers.length === 0 ? "allow" : "deny",
      blockers,
      approval: { action: "confirm", userConfirmationRequired: true },
    };
    await this.#store.update((draft) => {
      const current = activeWalletContext(draft);
      assertFundingBindings(current, plan);
      if (hasConflictingUnresolvedFunding(draft, plan)) {
        throw new Error("PRIVATE_BALANCE_FUNDING_CONFLICT_UNRESOLVED");
      }
      draft.privateBalanceFundingPlans[plan.decisionId] = plan;
    });
    return plan;
  }

  async getFunding(decisionId: string): Promise<PrivateBalanceFundingPlan> {
    const plan = (await this.#store.read()).privateBalanceFundingPlans[decisionId];
    if (!plan) throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_NOT_FOUND");
    return plan;
  }

  async cancelFunding(decisionId: string): Promise<PrivateBalanceFundingPlan> {
    const state = await this.#store.update((draft) => {
      const plan = draft.privateBalanceFundingPlans[decisionId];
      if (!plan) throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_NOT_FOUND");
      if (plan.consumedByRequestId || plan.appliedAt) {
        throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_ALREADY_CONSUMED");
      }
      if (!plan.blockers.includes("USER_CANCELLED")) {
        plan.decision = "deny";
        plan.blockers.push("USER_CANCELLED");
        plan.cancelledAt = this.#clock.now().toISOString();
      }
    });
    return state.privateBalanceFundingPlans[decisionId]!;
  }

  async executeFunding(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<PrivateBalanceFundingRequest> {
    if (!this.#acceptingExecutions) throw new Error("PRIVATE_BALANCE_RUNTIME_STOPPING");
    requireUserConfirmation(input.userConfirmed, "private balance funding");
    validateClientRequestId(input.clientRequestId);
    const state = await this.#store.read();
    const existing = Object.values(state.privateBalanceFundingRequests).find(
      (request) => request.clientRequestId === input.clientRequestId,
    );
    if (existing) {
      if (existing.decisionId !== input.decisionId) throw new Error("IDEMPOTENCY_CONFLICT");
      return existing;
    }
    if (Object.values(state.privateBalanceFundingRequests).some(
      (request) => request.decisionId === input.decisionId,
    )) {
      throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_ALREADY_CONSUMED");
    }
    if (this.#fundingExecution) throw new Error("PRIVATE_BALANCE_FUNDING_ALREADY_EXECUTING");
    const plan = state.privateBalanceFundingPlans[input.decisionId];
    assertFundingPlanExecutable(plan, this.#clock.now());
    if (!this.#acceptingExecutions) throw new Error("PRIVATE_BALANCE_RUNTIME_STOPPING");

    this.#fundingExecution = this.#executeFundingPlan(plan, input.clientRequestId);
    try {
      return await this.#fundingExecution;
    } finally {
      this.#fundingExecution = undefined;
    }
  }

  async fundingStatus(requestId: string): Promise<PrivateBalanceFundingRequest> {
    const request = (await this.#store.read()).privateBalanceFundingRequests[requestId];
    if (!request) throw new Error("PRIVATE_BALANCE_FUNDING_REQUEST_NOT_FOUND");
    if (UNRESOLVED_FUNDING_PHASES.has(request.phase)) {
      return this.reconcileFunding(requestId);
    }
    return request;
  }

  async reconcileFunding(requestId: string): Promise<PrivateBalanceFundingRequest> {
    const state = await this.#store.read();
    const request = state.privateBalanceFundingRequests[requestId];
    if (!request) throw new Error("PRIVATE_BALANCE_FUNDING_REQUEST_NOT_FOUND");
    if (!UNRESOLVED_FUNDING_PHASES.has(request.phase)) return request;
    const plan = state.privateBalanceFundingPlans[request.decisionId];
    if (!plan) throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_NOT_FOUND");

    let receiptStatus: "pending" | "success" | "reverted" | undefined;
    let receiptTransactionHash: string | undefined;
    let receiptMethod: "transaction_receipt" | "user_operation_receipt" | undefined;
    let receiptEvidence = request.userOperationReceiptEvidence;
    let newReceiptEvidence: typeof receiptEvidence;
    let checkpoint: Awaited<ReturnType<typeof matchingPrivateBroadcastCheckpoint>>;
    let rawCheckpoint: Awaited<ReturnType<
      typeof matchingRawTransactionBroadcastCheckpoint
    >>;
    let reconciliationError:
      | "PRIVATE_BROADCAST_CHECKPOINT_MISMATCH"
      | "RAW_TRANSACTION_BROADCAST_CHECKPOINT_MISMATCH"
      | "PUBLIC_CHANGE_TRACKING_PENDING"
      | undefined;
    if (request.route === "rebalance_private") {
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
    } else {
      try {
        rawCheckpoint = await matchingRawTransactionBroadcastCheckpoint({
          wallet: this.#wallet,
          requestId,
          expectedFrom: plan.sourceExecutorAddress,
          expectedTo: request.preparedDepositCall.to,
          expectedValueWei: request.preparedDepositCall.valueWei,
          expectedData: request.preparedDepositCall.data,
          ...(request.transactionHash === undefined
            ? {}
            : { storedTransactionHash: request.transactionHash }),
        });
      } catch {
        reconciliationError = "RAW_TRANSACTION_BROADCAST_CHECKPOINT_MISMATCH";
      }
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
          // Read-only reconciliation remains best effort.
          receiptStatus = undefined;
          receiptTransactionHash = undefined;
          receiptMethod = undefined;
        }
      }
    } else if (!request.userOperationHash && !checkpoint && !reconciliationError &&
      (request.transactionHash || rawCheckpoint) &&
      this.#chain.getTransactionReceiptStatus) {
      try {
        receiptStatus = await this.#chain.getTransactionReceiptStatus(
          request.transactionHash ?? rawCheckpoint!.transactionHash,
        );
        receiptMethod = "transaction_receipt";
      } catch {
        // Read-only reconciliation remains best effort.
      }
    }
    if (newReceiptEvidence && checkpoint) {
      const evidenceState = await this.#store.update((draft) => {
        const current = draft.privateBalanceFundingRequests[requestId];
        if (!current) throw new Error("PRIVATE_BALANCE_FUNDING_REQUEST_NOT_FOUND");
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
      receiptEvidence = evidenceState.privateBalanceFundingRequests[requestId]
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
    let sourcePublicChangeWei: bigint | undefined;
    if (receiptStatus === "success" && checkpoint && request.sourcePrivateBalance) {
      try {
        sourcePublicChangeWei = await observeConfirmedPublicChange({
          wallet: this.#wallet,
          chain: this.#chain,
          backendWalletName: request.sourcePrivateBalance.backendWalletName,
          checkpoint,
        });
      } catch {
        reconciliationError = "PUBLIC_CHANGE_TRACKING_PENDING";
        receiptStatus = undefined;
      }
    }
    const observations = await this.#observeFundingBalances(request);
    const checkedAt = this.#clock.now().toISOString();
    const updated = await this.#store.update((draft) => {
      const current = draft.privateBalanceFundingRequests[requestId];
      if (!current || !UNRESOLVED_FUNDING_PHASES.has(current.phase)) return;
      current.reconciliation = {
        attempts: (current.reconciliation?.attempts ?? 0) + 1,
        checkedAt,
      };
      if (!current.userOperationHash && checkpoint) {
        current.userOperationHash = checkpoint.userOperationHash;
      }
      if (!current.transactionHash && rawCheckpoint) {
        current.transactionHash = rawCheckpoint.transactionHash;
      }
      storeFundingObservations(current, observations);
      if (receiptTransactionHash) current.transactionHash = receiptTransactionHash;
      if (receiptStatus === "reverted") {
        applyRevertedFunding(draft, current, plan, observations, checkedAt);
      } else if (receiptStatus === "success") {
        applyConfirmedFunding(
          draft,
          current,
          plan,
          observations,
          checkedAt,
          receiptMethod ?? "transaction_receipt",
        );
        if (checkpoint && sourcePublicChangeWei !== undefined &&
          current.sourcePrivateBalance) {
          const profile = draft.wallet?.profiles[current.sourceWallet.walletId];
          if (!profile) throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_TARGET_MISSING");
          recordPublicChangeAccount({
            profile,
            privateBalanceId: current.sourcePrivateBalance.privateBalanceId,
            sourceRequestId: current.requestId,
            address: checkpoint.sender,
            balanceWei: sourcePublicChangeWei,
            observedAt: checkedAt,
          });
          current.sourcePublicChangeWei = sourcePublicChangeWei.toString();
        }
      } else if (!current.broadcastStartedAt) {
        applyRejectedBeforeBroadcast(draft, current, plan, observations, checkedAt);
      } else if (reconciliationError) {
        current.phase = "indeterminate";
        current.updatedAt = checkedAt;
        current.error = {
          code: reconciliationError,
          message: reconciliationError === "PUBLIC_CHANGE_TRACKING_PENDING"
            ? "The funding operation is on-chain, but its source pocket's public change is still being recovered before completion is reported."
            : "The durable broadcast checkpoint does not match this funding request. It was not retried.",
        };
      }
    });
    return updated.privateBalanceFundingRequests[requestId]!;
  }

  async recoverInterruptedRequests(): Promise<void> {
    const state = await this.#store.update((draft) => {
      const now = this.#clock.now().toISOString();
      for (const request of Object.values(draft.privateBalanceCreationRequests)) {
        if (request.phase !== "creating") continue;
        request.phase = "indeterminate";
        request.updatedAt = now;
        request.error = {
          code: "CREATION_INTERRUPTED",
          message:
            "Agent Boost restarted during private balance creation; recovery will idempotently ensure and inspect the reserved backend wallet.",
        };
      }
      for (const request of Object.values(draft.privateBalanceFundingRequests)) {
        if (request.phase !== "executing" || !request.broadcastStartedAt) continue;
        request.phase = "indeterminate";
        request.updatedAt = now;
        request.error = {
          code: "EXECUTION_INTERRUPTED",
          message:
            "Agent Boost restarted during private balance funding; do not create or execute a replacement request.",
        };
      }
    });
    for (const request of Object.values(state.privateBalanceCreationRequests)) {
      if (request.phase === "creating" || request.phase === "indeterminate") {
        await this.#reconcileCreation(request.requestId);
      }
    }
    for (const request of Object.values(state.privateBalanceFundingRequests)) {
      if (UNRESOLVED_FUNDING_PHASES.has(request.phase)) {
        await this.reconcileFunding(request.requestId);
      }
    }
  }

  async stop(): Promise<void> {
    this.#acceptingExecutions = false;
    await Promise.all([
      this.#creationExecution?.catch(() => undefined),
      this.#fundingExecution?.catch(() => undefined),
    ]);
  }

  resetForWalletSelection(): void {
    if (this.#creationExecution || this.#fundingExecution) {
      throw new Error("PRIVATE_BALANCE_OPERATION_ALREADY_EXECUTING");
    }
    this.#acceptingExecutions = true;
  }

  async #applyCreationPlan(
    plan: PrivateBalanceCreationPlan,
    clientRequestId: string,
  ): Promise<PrivateBalanceCreationRequest> {
    const ensureBackendWallet = this.#wallet.ensureBackendWallet;
    const syncBackendWallet = this.#wallet.syncBackendWallet;
    if (!ensureBackendWallet || !syncBackendWallet) {
      throw new Error("ISOLATED_PRIVATE_BALANCE_UNAVAILABLE");
    }
    const now = this.#clock.now().toISOString();
    const requestId = `pbcr_${randomUUID()}`;
    const request: PrivateBalanceCreationRequest = {
      version: 1,
      requestId,
      clientRequestId,
      decisionId: plan.decisionId,
      privateBalance: {
        ...plan.wallet,
        privateBalanceId: plan.privateBalanceId,
        privateBalanceName: plan.privateBalanceName,
        backendWalletName: plan.backendWalletName,
        privateBalanceRevision: 0,
      },
      phase: "creating",
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.update((draft) => {
      const storedPlan = draft.privateBalanceCreationPlans[plan.decisionId];
      assertCreationPlanExecutable(storedPlan, this.#clock.now());
      assertCreationDecisionUnused(draft, storedPlan.decisionId, clientRequestId);
      assertCreationPlanIntegrity(storedPlan);
      const context = activeWalletContext(draft);
      if (!sameWalletBinding(context.wallet, storedPlan.wallet)) {
        throw new Error("WALLET_SELECTION_CHANGED");
      }
      if (!context.onboarding ||
        context.onboarding.revision !== storedPlan.walletOnboardingRevision) {
        throw new Error("WALLET_ONBOARDING_CHANGED");
      }
      if (context.profile.privateBalances[storedPlan.privateBalanceId] ||
        findPrivateBalance(context.profile.privateBalances, storedPlan.privateBalanceName)) {
        throw new Error("PRIVATE_BALANCE_NAME_TAKEN");
      }
      if (Object.values(context.profile.privateBalances).some(
        (balance) => balance.backendWalletName === storedPlan.backendWalletName,
      )) {
        throw new Error("PRIVATE_BALANCE_BACKEND_COLLISION");
      }
      storedPlan.consumedByRequestId = requestId;
      draft.privateBalanceCreationRequests[requestId] = request;
    });

    try {
      await ensureBackendWallet.call(this.#wallet, plan.backendWalletName);
      const balanceWei = await syncBackendWallet.call(this.#wallet, plan.backendWalletName);
      return await this.#finishCreation(requestId, balanceWei);
    } catch {
      const updated = await this.#store.update((draft) => {
        const current = draft.privateBalanceCreationRequests[requestId];
        if (!current || current.phase === "created") return;
        current.phase = "indeterminate";
        current.updatedAt = this.#clock.now().toISOString();
        current.error = {
          code: "PRIVATE_BALANCE_CREATION_UNRESOLVED",
          message:
            "The isolated private balance may have been created. Do not retry with a new client request ID.",
        };
      });
      return updated.privateBalanceCreationRequests[requestId]!;
    }
  }

  async #reconcileCreation(requestId: string): Promise<PrivateBalanceCreationRequest> {
    const state = await this.#store.read();
    const request = state.privateBalanceCreationRequests[requestId];
    if (!request) throw new Error("PRIVATE_BALANCE_CREATION_REQUEST_NOT_FOUND");
    if (request.phase === "created" || request.phase === "failed") return request;
    const ensureBackendWallet = this.#wallet.ensureBackendWallet;
    const syncBackendWallet = this.#wallet.syncBackendWallet;
    if (!ensureBackendWallet || !syncBackendWallet) return request;
    try {
      await ensureBackendWallet.call(
        this.#wallet,
        request.privateBalance.backendWalletName,
      );
      const balanceWei = await syncBackendWallet.call(
        this.#wallet,
        request.privateBalance.backendWalletName,
      );
      return await this.#finishCreation(requestId, balanceWei);
    } catch {
      return request;
    }
  }

  async #finishCreation(
    requestId: string,
    balanceWei: bigint,
  ): Promise<PrivateBalanceCreationRequest> {
    if (balanceWei < 0n) throw new Error("PRIVATE_BALANCE_BACKEND_RETURNED_NEGATIVE_BALANCE");
    const now = this.#clock.now().toISOString();
    const updated = await this.#store.update((draft) => {
      const request = draft.privateBalanceCreationRequests[requestId];
      if (!request) throw new Error("PRIVATE_BALANCE_CREATION_REQUEST_NOT_FOUND");
      if (request.phase === "created") return;
      const plan = draft.privateBalanceCreationPlans[request.decisionId];
      if (!plan || plan.consumedByRequestId !== requestId) {
        throw new Error("PRIVATE_BALANCE_CREATION_DECISION_CHANGED");
      }
      assertCreationPlanIntegrity(plan);
      const profile = draft.wallet?.profiles[plan.wallet.walletId];
      if (!profile || profile.name !== plan.wallet.walletName) {
        throw new Error("PRIVATE_BALANCE_PARENT_WALLET_MISSING");
      }
      let record = profile.privateBalances[plan.privateBalanceId];
      if (!record) {
        const collision = findPrivateBalance(profile.privateBalances, plan.privateBalanceName);
        if (collision) throw new Error("PRIVATE_BALANCE_NAME_TAKEN");
        record = {
          version: 1,
          privateBalanceId: plan.privateBalanceId,
          name: plan.privateBalanceName,
          backendWalletName: plan.backendWalletName,
          status: "available",
          balanceWei: balanceWei.toString(),
          revision: 1,
          createdAt: now,
          updatedAt: now,
          delegation: structuredClone(plan.initialPolicy),
          publicChangeAccounts: {},
        };
        profile.privateBalances[record.privateBalanceId] = record;
        profile.updatedAt = now;
      } else if (record.backendWalletName !== plan.backendWalletName) {
        throw new Error("PRIVATE_BALANCE_BACKEND_COLLISION");
      }
      request.privateBalance = privateBalanceBinding(plan.wallet, record);
      request.phase = "created";
      request.updatedAt = now;
      request.appliedAt = now;
      delete request.error;
      plan.appliedAt = now;
    });
    return updated.privateBalanceCreationRequests[requestId]!;
  }

  async #executeFundingPlan(
    plan: PrivateBalanceFundingPlan,
    clientRequestId: string,
  ): Promise<PrivateBalanceFundingRequest> {
    if (!this.#executeEnabled) throw new Error("EXECUTION_DISABLED");
    const adapter = requireFundingExecutionAdapter(this.#wallet, plan.route);
    await this.#chain.assertSepolia();
    const before = await this.#store.read();
    const context = activeWalletContext(before);
    assertFundingBindings(context, plan);
    assertFundingPlanIntegrity(plan);
    if (hasConflictingUnresolvedFunding(before, plan)) {
      throw new Error("PRIVATE_BALANCE_FUNDING_CONFLICT_UNRESOLVED");
    }

    const observationsBefore = await this.#observePlanBalances(plan);
    if (observationsBefore.targetPrivateBalanceWei?.toString() !==
      plan.targetPrivateBalanceSnapshotWei) {
      throw new Error("TARGET_PRIVATE_BALANCE_CHANGED");
    }
    if (plan.route === "rebalance_private" &&
      observationsBefore.sourcePrivateBalanceWei?.toString() !==
        plan.sourcePrivateBalanceSnapshotWei) {
      throw new Error("SOURCE_PRIVATE_BALANCE_CHANGED");
    }
    if (plan.route === "shield_from_main") {
      const address = context.onboarding?.address;
      if (!address || address.toLowerCase() !== plan.sourceExecutorAddress.toLowerCase()) {
        throw new Error("MAIN_ACCOUNT_CHANGED");
      }
      const mainBalance = await this.#chain.getBalanceWei(address);
      if (BigInt(plan.amountWei) + BigInt(plan.gasReserveWei) > mainBalance) {
        throw new Error("INSUFFICIENT_MAIN_BALANCE_WITH_GAS_RESERVE");
      }
    } else {
      const peek = await adapter.peekNextFreshAddressForWallet(
        plan.sourcePrivateBalance!.backendWalletName,
      );
      if (peek.toLowerCase() !== plan.sourceExecutorAddress.toLowerCase()) {
        throw new Error("PRIVATE_BALANCE_EXECUTOR_CHANGED");
      }
      if (BigInt(plan.sourcePrivateBalanceSnapshotWei!) < BigInt(plan.withdrawalAmountWei!)) {
        throw new Error("INSUFFICIENT_SOURCE_PRIVATE_BALANCE_WITH_FEE_RESERVE");
      }
    }

    const now = this.#clock.now().toISOString();
    const requestId = `pbfr_${randomUUID()}`;
    const request: PrivateBalanceFundingRequest = {
      version: 1,
      requestId,
      clientRequestId,
      decisionId: plan.decisionId,
      sourceWallet: plan.sourceWallet,
      targetWallet: plan.targetWallet,
      route: plan.route,
      ...(plan.sourcePrivateBalance
        ? { sourcePrivateBalance: plan.sourcePrivateBalance }
        : {}),
      targetPrivateBalance: plan.targetPrivateBalance,
      amountWei: plan.amountWei,
      aggregatePrivateBalanceBeforeWei: plan.aggregatePrivateBalanceSnapshotWei,
      ...(plan.sourcePrivateBalanceSnapshotWei
        ? { sourcePrivateBalanceBeforeWei: plan.sourcePrivateBalanceSnapshotWei }
        : {}),
      targetPrivateBalanceBeforeWei: plan.targetPrivateBalanceSnapshotWei,
      targetCommitment: plan.targetCommitment,
      preparedDepositCall: plan.preparedDepositCall,
      phase: "executing",
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.update((draft) => {
      const storedPlan = draft.privateBalanceFundingPlans[plan.decisionId];
      assertFundingPlanExecutable(storedPlan, this.#clock.now());
      assertFundingDecisionUnused(draft, storedPlan.decisionId, clientRequestId);
      assertFundingPlanIntegrity(storedPlan);
      const current = activeWalletContext(draft);
      assertFundingBindings(current, storedPlan);
      if (hasConflictingUnresolvedFunding(draft, storedPlan)) {
        throw new Error("PRIVATE_BALANCE_FUNDING_CONFLICT_UNRESOLVED");
      }
      if (storedPlan.route === "rebalance_private") {
        reservePrivateRebalanceSource(draft, storedPlan, now);
      }
      storedPlan.consumedByRequestId = requestId;
      draft.privateBalanceFundingRequests[requestId] = request;
    });

    let result:
      | { transactionHash?: string; confirmed?: boolean }
      | {
          transactionHash?: string;
          userOperationHash?: string;
          confirmed?: boolean;
        };
    try {
      result = plan.route === "shield_from_main"
        ? await adapter.executePreparedMainDeposit({
            sourceWalletName: plan.sourceWallet.walletName,
            sourceExecutorAddress: plan.sourceExecutorAddress,
            preparedDepositCall: plan.preparedDepositCall,
            broadcastRequestId: requestId,
            beforeBroadcast: () => this.#markFundingBroadcastStarted(requestId),
          })
        : await adapter.executePrivateRebalance({
            sourceWalletName: plan.sourcePrivateBalance!.backendWalletName,
            sourceExecutorAddress: plan.sourceExecutorAddress,
            withdrawalAmountWei: BigInt(plan.withdrawalAmountWei!),
            preparedDepositCall: plan.preparedDepositCall,
            broadcastRequestId: requestId,
            beforeBroadcast: () => this.#markFundingBroadcastStarted(requestId),
          });
    } catch (error) {
      return this.#settleFundingExecutionError(requestId, plan, error);
    }

    let executionCheckpoint: Awaited<ReturnType<
      typeof matchingPrivateBroadcastCheckpoint
    >>;
    let checkpointMismatch = false;
    if (plan.route === "rebalance_private" && result.confirmed) {
      const returnedUserOperationHash = "userOperationHash" in result &&
          typeof result.userOperationHash === "string"
        ? result.userOperationHash
        : undefined;
      try {
        executionCheckpoint = await matchingPrivateBroadcastCheckpoint({
          wallet: this.#wallet,
          requestId,
          ...(returnedUserOperationHash === undefined
            ? {}
            : { storedUserOperationHash: returnedUserOperationHash }),
        });
      } catch {
        checkpointMismatch = true;
        // Exact receipt reconciliation owns checkpoint mismatch handling.
      }
    }
    const observationsAfter = await this.#observePlanBalances(plan);
    const transactionHash = typeof result.transactionHash === "string"
      ? result.transactionHash
      : undefined;
    const returnedUserOperationHash = "userOperationHash" in result &&
        typeof result.userOperationHash === "string"
      ? result.userOperationHash
      : undefined;
    const userOperationHash = returnedUserOperationHash ??
      executionCheckpoint?.userOperationHash;
    const updated = await this.#store.update((draft) => {
      const current = draft.privateBalanceFundingRequests[requestId];
      if (!current) throw new Error("PRIVATE_BALANCE_FUNDING_REQUEST_NOT_FOUND");
      const checkedAt = this.#clock.now().toISOString();
      if (transactionHash) current.transactionHash = transactionHash;
      if (userOperationHash) current.userOperationHash = userOperationHash;
      storeFundingObservations(current, observationsAfter);
      if (result.confirmed && !userOperationHash && !checkpointMismatch) {
        applyConfirmedFunding(
          draft,
          current,
          plan,
          observationsAfter,
          checkedAt,
          "adapter",
        );
      } else {
        current.phase = checkpointMismatch
          ? "indeterminate"
          : transactionHash || userOperationHash
            ? "submitted"
            : "indeterminate";
        current.updatedAt = checkedAt;
        if (current.phase === "indeterminate") {
          current.error = checkpointMismatch
            ? {
                code: "PRIVATE_BROADCAST_CHECKPOINT_MISMATCH",
                message:
                  "The durable private broadcast checkpoint does not match this funding request. It was not retried.",
              }
            : unresolvedFundingError();
        }
      }
    });
    return updated.privateBalanceFundingRequests[requestId]!;
  }

  async #settleFundingExecutionError(
    requestId: string,
    plan: PrivateBalanceFundingPlan,
    error: unknown,
  ): Promise<PrivateBalanceFundingRequest> {
    const observationsAfter = await this.#observePlanBalances(plan);
    const definitelyNotBroadcast = error instanceof WalletExecutionError &&
      !error.mayHaveBroadcast;
    const updated = await this.#store.update((draft) => {
      const current = draft.privateBalanceFundingRequests[requestId];
      if (!current) throw new Error("PRIVATE_BALANCE_FUNDING_REQUEST_NOT_FOUND");
      const checkedAt = this.#clock.now().toISOString();
      storeFundingObservations(current, observationsAfter);
      if (definitelyNotBroadcast) {
        applyRejectedBeforeBroadcast(draft, current, plan, observationsAfter, checkedAt);
      } else {
        current.phase = "indeterminate";
        current.updatedAt = checkedAt;
        current.error = unresolvedFundingError();
      }
    });
    return updated.privateBalanceFundingRequests[requestId]!;
  }

  async #observePlanBalances(plan: PrivateBalanceFundingPlan): Promise<FundingObservations> {
    const adapter = requireNamedBalanceAdapter(this.#wallet);
    const [targetPrivateBalanceWei, sourcePrivateBalanceWei] = await Promise.all([
      readNamedBalanceBestEffort(
        adapter,
        plan.targetPrivateBalance.backendWalletName,
      ),
      plan.sourcePrivateBalance
        ? readNamedBalanceBestEffort(
            adapter,
            plan.sourcePrivateBalance.backendWalletName,
          )
        : Promise.resolve(undefined),
    ]);
    return {
      ...(sourcePrivateBalanceWei !== undefined ? { sourcePrivateBalanceWei } : {}),
      ...(targetPrivateBalanceWei !== undefined ? { targetPrivateBalanceWei } : {}),
    };
  }

  async #markFundingBroadcastStarted(requestId: string): Promise<void> {
    await this.#store.update((draft) => {
      const request = draft.privateBalanceFundingRequests[requestId];
      if (!request || request.phase !== "executing" || request.broadcastStartedAt) {
        throw new Error("PRIVATE_BALANCE_FUNDING_REQUEST_NOT_EXECUTABLE");
      }
      request.broadcastStartedAt = this.#clock.now().toISOString();
      request.updatedAt = request.broadcastStartedAt;
    });
  }

  async #observeFundingBalances(
    request: PrivateBalanceFundingRequest,
  ): Promise<FundingObservations> {
    const adapter = requireNamedBalanceAdapter(this.#wallet);
    const [targetPrivateBalanceWei, sourcePrivateBalanceWei] = await Promise.all([
      readNamedBalanceBestEffort(
        adapter,
        request.targetPrivateBalance.backendWalletName,
      ),
      request.sourcePrivateBalance
        ? readNamedBalanceBestEffort(
            adapter,
            request.sourcePrivateBalance.backendWalletName,
          )
        : Promise.resolve(undefined),
    ]);
    return {
      ...(sourcePrivateBalanceWei !== undefined ? { sourcePrivateBalanceWei } : {}),
      ...(targetPrivateBalanceWei !== undefined ? { targetPrivateBalanceWei } : {}),
    };
  }
}

function activeWalletContext(state: StateDocument): {
  profile: WalletProfileRecord;
  wallet: WalletSelectionBinding;
  onboarding: StateDocument["onboarding"];
} {
  const registry = state.wallet;
  const profile = registry?.profiles[registry.activeWalletId];
  if (!registry || !profile || profile.status !== "available" || profile.selectionEpoch < 1) {
    throw new Error("ACTIVE_WALLET_PROFILE_MISSING");
  }
  return {
    profile,
    wallet: {
      walletId: profile.walletId,
      walletName: profile.name,
      selectionEpoch: profile.selectionEpoch,
    },
    onboarding: state.onboarding,
  };
}

function canonicalPrivateBalanceName(value: string): string {
  const name = value.trim();
  if (!PRIVATE_BALANCE_NAME_PATTERN.test(name)) {
    throw new Error(
      "private_balance_name must be 1-64 letters, numbers, dots, underscores, or hyphens",
    );
  }
  return name;
}

function canonicalPositiveAmount(value: string): string {
  if (!ATOMIC_PATTERN.test(value) || BigInt(value) <= 0n) {
    throw new Error("amount_atomic must be a positive canonical integer string");
  }
  return value;
}

function validateClientRequestId(value: string): void {
  if (!CLIENT_REQUEST_ID_PATTERN.test(value)) {
    throw new Error("client_request_id must be a stable 8-200 character identifier");
  }
}

function requireUserConfirmation(confirmed: boolean, operation: string): void {
  if (!confirmed) throw new Error(`The user must confirm the exact ${operation}`);
}

function copyInitialPolicy(policy: DelegationPolicy | undefined): DelegationPolicy {
  if (!policy) {
    return {
      mode: "testnet_delegated",
      chainId: 11_155_111,
      perPaymentLimitWei: "0",
      lifetimeLimitWei: "0",
      spentWei: "0",
      maxPayments: 1,
      expiresAt: new Date(0).toISOString(),
      enabled: false,
    };
  }
  return { ...structuredClone(policy), spentWei: "0" };
}

function hiddenBackendWalletName(walletId: string, privateBalanceId: string): string {
  const suffix = createHash("sha256")
    .update(`${walletId}:${privateBalanceId}`)
    .digest("hex")
    .slice(0, 40);
  return `abpb-${suffix}`;
}

function findPrivateBalance(
  balances: Record<string, PrivateBalanceRecord>,
  reference: string,
): PrivateBalanceRecord | undefined {
  const direct = balances[reference];
  if (direct) return direct;
  const normalized = reference.trim().toLowerCase();
  return Object.values(balances).find(
    (balance) => balance.name.toLowerCase() === normalized,
  );
}

function resolveAvailablePrivateBalance(
  balances: Record<string, PrivateBalanceRecord>,
  reference: string,
): PrivateBalanceRecord {
  const balance = findPrivateBalance(balances, reference);
  if (!balance) throw new Error("PRIVATE_BALANCE_NOT_FOUND");
  if (balance.status !== "available") throw new Error("PRIVATE_BALANCE_ARCHIVED");
  return balance;
}

function privateBalanceBinding(
  wallet: WalletSelectionBinding,
  balance: PrivateBalanceRecord,
): PrivateBalanceBinding {
  return {
    ...wallet,
    privateBalanceId: balance.privateBalanceId,
    privateBalanceName: balance.name,
    backendWalletName: balance.backendWalletName,
    privateBalanceRevision: balance.revision,
  };
}

function sameWalletBinding(
  left: WalletSelectionBinding,
  right: WalletSelectionBinding,
): boolean {
  return left.walletId === right.walletId && left.walletName === right.walletName &&
    left.selectionEpoch === right.selectionEpoch;
}

function samePrivateBalanceBinding(
  record: PrivateBalanceRecord | undefined,
  binding: PrivateBalanceBinding,
): boolean {
  return record !== undefined && record.privateBalanceId === binding.privateBalanceId &&
    record.name === binding.privateBalanceName &&
    record.backendWalletName === binding.backendWalletName &&
    record.revision === binding.privateBalanceRevision;
}

function refreshPrivateBalanceRecord(
  profile: WalletProfileRecord,
  privateBalanceId: string,
  expectedRevision: number,
  liveBalanceWei: bigint,
  now: string,
): void {
  if (liveBalanceWei < 0n) throw new Error("PRIVATE_BALANCE_BACKEND_RETURNED_NEGATIVE_BALANCE");
  const record = profile.privateBalances[privateBalanceId];
  if (!record || record.revision !== expectedRevision) {
    throw new Error("PRIVATE_BALANCE_CHANGED");
  }
  if (record.balanceWei === liveBalanceWei.toString()) return;
  record.balanceWei = liveBalanceWei.toString();
  record.revision += 1;
  record.updatedAt = now;
  profile.updatedAt = now;
}

function assertCreationPlanExecutable(
  plan: PrivateBalanceCreationPlan | undefined,
  now: Date,
): asserts plan is PrivateBalanceCreationPlan {
  if (!plan) throw new Error("PRIVATE_BALANCE_CREATION_DECISION_NOT_FOUND");
  if (plan.cancelledAt || plan.blockers.includes("USER_CANCELLED")) {
    throw new Error("PRIVATE_BALANCE_CREATION_DECISION_CANCELLED");
  }
  if (plan.consumedByRequestId || plan.appliedAt) {
    throw new Error("PRIVATE_BALANCE_CREATION_DECISION_ALREADY_CONSUMED");
  }
  if (plan.decision !== "allow") throw new Error("PRIVATE_BALANCE_CREATION_DECISION_DENIED");
  if (new Date(plan.expiresAt).getTime() <= now.getTime()) {
    throw new Error("PRIVATE_BALANCE_CREATION_DECISION_EXPIRED");
  }
}

function assertFundingPlanExecutable(
  plan: PrivateBalanceFundingPlan | undefined,
  now: Date,
): asserts plan is PrivateBalanceFundingPlan {
  if (!plan) throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_NOT_FOUND");
  if (plan.cancelledAt || plan.blockers.includes("USER_CANCELLED")) {
    throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_CANCELLED");
  }
  if (plan.consumedByRequestId || plan.appliedAt) {
    throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_ALREADY_CONSUMED");
  }
  if (plan.decision !== "allow") throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_DENIED");
  if (new Date(plan.expiresAt).getTime() <= now.getTime()) {
    throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_EXPIRED");
  }
}

function assertCreationDecisionUnused(
  state: StateDocument,
  decisionId: string,
  clientRequestId: string,
): void {
  const sameClient = Object.values(state.privateBalanceCreationRequests).find(
    (request) => request.clientRequestId === clientRequestId,
  );
  if (sameClient) {
    if (sameClient.decisionId !== decisionId) throw new Error("IDEMPOTENCY_CONFLICT");
    throw new Error("PRIVATE_BALANCE_CREATION_DECISION_ALREADY_CONSUMED");
  }
  if (Object.values(state.privateBalanceCreationRequests).some(
    (request) => request.decisionId === decisionId,
  )) {
    throw new Error("PRIVATE_BALANCE_CREATION_DECISION_ALREADY_CONSUMED");
  }
}

function assertFundingDecisionUnused(
  state: StateDocument,
  decisionId: string,
  clientRequestId: string,
): void {
  const sameClient = Object.values(state.privateBalanceFundingRequests).find(
    (request) => request.clientRequestId === clientRequestId,
  );
  if (sameClient) {
    if (sameClient.decisionId !== decisionId) throw new Error("IDEMPOTENCY_CONFLICT");
    throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_ALREADY_CONSUMED");
  }
  if (Object.values(state.privateBalanceFundingRequests).some(
    (request) => request.decisionId === decisionId,
  )) {
    throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_ALREADY_CONSUMED");
  }
}

function assertCreationPlanIntegrity(plan: PrivateBalanceCreationPlan): void {
  if (plan.intentDigest !== creationIntentDigest(plan)) {
    throw new Error("PRIVATE_BALANCE_CREATION_DECISION_CHANGED");
  }
}

function assertFundingPlanIntegrity(plan: PrivateBalanceFundingPlan): void {
  if (plan.amountWei !== plan.shieldDenominationWei) {
    throw new Error("PRIVATE_BALANCE_FUNDING_REQUIRES_ONE_DENOMINATION");
  }
  if (plan.intentDigest !== fundingIntentDigest(plan)) {
    throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_CHANGED");
  }
  validatePreparedDeposit(
    {
      targetCommitment: plan.targetCommitment,
      preparedDepositCall: plan.preparedDepositCall,
    },
    plan.amountWei,
  );
}

function assertFundingBindings(
  context: ReturnType<typeof activeWalletContext>,
  plan: PrivateBalanceFundingPlan,
): void {
  if (!sameWalletBinding(context.wallet, plan.sourceWallet) ||
    !sameWalletBinding(context.wallet, plan.targetWallet)) {
    throw new Error("WALLET_SELECTION_CHANGED");
  }
  if (!samePrivateBalanceBinding(
    context.profile.privateBalances[plan.targetPrivateBalance.privateBalanceId],
    plan.targetPrivateBalance,
  )) {
    throw new Error("TARGET_PRIVATE_BALANCE_CHANGED");
  }
  if (plan.sourcePrivateBalance && !samePrivateBalanceBinding(
    context.profile.privateBalances[plan.sourcePrivateBalance.privateBalanceId],
    plan.sourcePrivateBalance,
  )) {
    throw new Error("SOURCE_PRIVATE_BALANCE_CHANGED");
  }
}

function reservePrivateRebalanceSource(
  state: StateDocument,
  plan: PrivateBalanceFundingPlan,
  now: string,
): void {
  if (!plan.sourcePrivateBalance || !plan.withdrawalAmountWei ||
    !plan.sourcePrivateBalanceSnapshotWei) {
    throw new Error("PRIVATE_BALANCE_REBALANCE_BINDING_MISSING");
  }
  const profile = state.wallet?.profiles[plan.sourceWallet.walletId];
  const source = profile?.privateBalances[plan.sourcePrivateBalance.privateBalanceId];
  if (!profile || !source || source.balanceWei !== plan.sourcePrivateBalanceSnapshotWei) {
    throw new Error("SOURCE_PRIVATE_BALANCE_CHANGED");
  }
  const withdrawal = BigInt(plan.withdrawalAmountWei);
  if (BigInt(source.balanceWei) < withdrawal) {
    throw new Error("INSUFFICIENT_SOURCE_PRIVATE_BALANCE_WITH_FEE_RESERVE");
  }
  source.balanceWei = (BigInt(source.balanceWei) - withdrawal).toString();
  source.revision += 1;
  source.updatedAt = now;
  profile.updatedAt = now;
  syncDefaultPrivateBalance(state, profile, now);
}

function applyConfirmedFunding(
  state: StateDocument,
  request: PrivateBalanceFundingRequest,
  plan: PrivateBalanceFundingPlan,
  observations: FundingObservations,
  checkedAt: string,
  method: "adapter" | "transaction_receipt" | "user_operation_receipt",
): void {
  if (request.appliedAt) {
    request.phase = "confirmed";
    request.updatedAt = checkedAt;
    return;
  }
  const profile = state.wallet?.profiles[request.targetWallet.walletId];
  const target = profile?.privateBalances[request.targetPrivateBalance.privateBalanceId];
  if (!profile || !target ||
    target.backendWalletName !== request.targetPrivateBalance.backendWalletName) {
    throw new Error("PRIVATE_BALANCE_FUNDING_BINDING_MISSING");
  }
  const expectedTargetAfter = BigInt(request.targetPrivateBalanceBeforeWei) +
    BigInt(request.amountWei);
  const targetAfter = observations.targetPrivateBalanceWei === undefined ||
      observations.targetPrivateBalanceWei < expectedTargetAfter
    ? expectedTargetAfter
    : observations.targetPrivateBalanceWei;
  setPrivateBalanceRecord(target, targetAfter, checkedAt);

  if (request.sourcePrivateBalance) {
    const source = profile.privateBalances[request.sourcePrivateBalance.privateBalanceId];
    if (!source || source.backendWalletName !== request.sourcePrivateBalance.backendWalletName ||
      !request.sourcePrivateBalanceBeforeWei || !plan.withdrawalAmountWei) {
      throw new Error("PRIVATE_BALANCE_FUNDING_BINDING_MISSING");
    }
    const expectedSourceAfter = BigInt(request.sourcePrivateBalanceBeforeWei) -
      BigInt(plan.withdrawalAmountWei);
    const sourceAfter = observations.sourcePrivateBalanceWei === undefined ||
        observations.sourcePrivateBalanceWei > expectedSourceAfter
      ? expectedSourceAfter
      : observations.sourcePrivateBalanceWei;
    setPrivateBalanceRecord(source, sourceAfter, checkedAt);
    request.sourcePrivateBalanceAfterWei = sourceAfter.toString();
  }
  request.targetPrivateBalanceAfterWei = targetAfter.toString();
  request.aggregatePrivateBalanceAfterWei = sumPrivateBalances(
    profile.privateBalances,
  ).toString();
  request.phase = "confirmed";
  request.updatedAt = checkedAt;
  request.appliedAt = checkedAt;
  request.confirmation = { method, checkedAt };
  delete request.error;
  const storedPlan = state.privateBalanceFundingPlans[request.decisionId];
  if (!storedPlan) throw new Error("PRIVATE_BALANCE_FUNDING_DECISION_NOT_FOUND");
  storedPlan.appliedAt = checkedAt;
  profile.updatedAt = checkedAt;
  syncDefaultPrivateBalance(state, profile, checkedAt);
}

function applyRevertedFunding(
  state: StateDocument,
  request: PrivateBalanceFundingRequest,
  plan: PrivateBalanceFundingPlan,
  observations: FundingObservations,
  checkedAt: string,
): void {
  const profile = state.wallet?.profiles[request.sourceWallet.walletId];
  if (!profile) throw new Error("PRIVATE_BALANCE_PARENT_WALLET_MISSING");
  if (request.sourcePrivateBalance && request.sourcePrivateBalanceBeforeWei &&
    plan.withdrawalAmountWei) {
    const source = profile.privateBalances[request.sourcePrivateBalance.privateBalanceId];
    if (!source) throw new Error("PRIVATE_BALANCE_FUNDING_BINDING_MISSING");
    const sourceAfter = observations.sourcePrivateBalanceWei ??
      BigInt(source.balanceWei) + BigInt(plan.withdrawalAmountWei);
    setPrivateBalanceRecord(source, sourceAfter, checkedAt);
    request.sourcePrivateBalanceAfterWei = sourceAfter.toString();
  }
  if (observations.targetPrivateBalanceWei !== undefined) {
    const target = profile.privateBalances[request.targetPrivateBalance.privateBalanceId];
    if (target) {
      setPrivateBalanceRecord(target, observations.targetPrivateBalanceWei, checkedAt);
      request.targetPrivateBalanceAfterWei = observations.targetPrivateBalanceWei.toString();
    }
  }
  request.aggregatePrivateBalanceAfterWei = sumPrivateBalances(
    profile.privateBalances,
  ).toString();
  request.phase = "failed";
  request.updatedAt = checkedAt;
  request.error = {
    code: "PRIVATE_BALANCE_FUNDING_REVERTED",
    message: "The private balance funding transaction was included but reverted.",
  };
  profile.updatedAt = checkedAt;
  syncDefaultPrivateBalance(state, profile, checkedAt);
}

function applyRejectedBeforeBroadcast(
  state: StateDocument,
  request: PrivateBalanceFundingRequest,
  plan: PrivateBalanceFundingPlan,
  observations: FundingObservations,
  checkedAt: string,
): void {
  const profile = state.wallet?.profiles[request.sourceWallet.walletId];
  if (!profile) throw new Error("PRIVATE_BALANCE_PARENT_WALLET_MISSING");
  if (request.sourcePrivateBalance && request.sourcePrivateBalanceBeforeWei &&
    plan.withdrawalAmountWei) {
    const source = profile.privateBalances[request.sourcePrivateBalance.privateBalanceId];
    if (!source) throw new Error("PRIVATE_BALANCE_FUNDING_BINDING_MISSING");
    const restored = observations.sourcePrivateBalanceWei ??
      BigInt(source.balanceWei) + BigInt(plan.withdrawalAmountWei);
    setPrivateBalanceRecord(source, restored, checkedAt);
    request.sourcePrivateBalanceAfterWei = restored.toString();
  }
  if (observations.targetPrivateBalanceWei !== undefined) {
    const target = profile.privateBalances[request.targetPrivateBalance.privateBalanceId];
    if (target) {
      setPrivateBalanceRecord(target, observations.targetPrivateBalanceWei, checkedAt);
      request.targetPrivateBalanceAfterWei = observations.targetPrivateBalanceWei.toString();
    }
  }
  request.aggregatePrivateBalanceAfterWei = sumPrivateBalances(
    profile.privateBalances,
  ).toString();
  request.phase = "failed";
  request.updatedAt = checkedAt;
  request.error = {
    code: "PRIVATE_BALANCE_FUNDING_REJECTED_BEFORE_BROADCAST",
    message: "Private balance funding failed before any broadcast was attempted.",
  };
  profile.updatedAt = checkedAt;
  syncDefaultPrivateBalance(state, profile, checkedAt);
}

function setPrivateBalanceRecord(
  record: PrivateBalanceRecord,
  balanceWei: bigint,
  now: string,
): void {
  if (balanceWei < 0n) throw new Error("PRIVATE_BALANCE_BACKEND_RETURNED_NEGATIVE_BALANCE");
  if (record.balanceWei === balanceWei.toString()) return;
  record.balanceWei = balanceWei.toString();
  record.revision += 1;
  record.updatedAt = now;
}

function syncDefaultPrivateBalance(
  state: StateDocument,
  profile: WalletProfileRecord,
  now: string,
): void {
  if (!profile.onboarding) return;
  const aggregateBalanceWei = sumPrivateBalances(profile.privateBalances).toString();
  if (profile.onboarding.privateBalanceWei === aggregateBalanceWei) return;
  profile.onboarding.privateBalanceWei = aggregateBalanceWei;
  profile.onboarding.revision += 1;
  profile.onboarding.updatedAt = now;
  if (state.wallet?.activeWalletId === profile.walletId && state.onboarding) {
    state.onboarding = structuredClone(profile.onboarding);
  }
}

function storeFundingObservations(
  request: PrivateBalanceFundingRequest,
  observations: FundingObservations,
): void {
  if (observations.sourcePrivateBalanceWei !== undefined) {
    request.sourcePrivateBalanceAfterWei = observations.sourcePrivateBalanceWei.toString();
  }
  if (observations.targetPrivateBalanceWei !== undefined) {
    request.targetPrivateBalanceAfterWei = observations.targetPrivateBalanceWei.toString();
  }
}

function sumPrivateBalances(balances: Record<string, PrivateBalanceRecord>): bigint {
  return Object.values(balances).reduce(
    (total, balance) => total + BigInt(balance.balanceWei),
    0n,
  );
}

function roundUpToMultiple(value: bigint, denomination: bigint): bigint {
  return ((value + denomination - 1n) / denomination) * denomination;
}

function validatePreparedDeposit(
  prepared: { targetCommitment: string; preparedDepositCall: PreparedDepositCall },
  amountWei: string,
): void {
  if (!prepared.targetCommitment || prepared.targetCommitment.length > 300) {
    throw new Error("PREPARED_PRIVATE_DEPOSIT_INVALID");
  }
  if (!ADDRESS_PATTERN.test(prepared.preparedDepositCall.to) ||
    !CALLDATA_PATTERN.test(prepared.preparedDepositCall.data) ||
    !ATOMIC_PATTERN.test(prepared.preparedDepositCall.valueWei) ||
    prepared.preparedDepositCall.valueWei !== amountWei) {
    throw new Error("PREPARED_PRIVATE_DEPOSIT_INVALID");
  }
}

function unresolvedFundingError(): NonNullable<PrivateBalanceFundingRequest["error"]> {
  return {
    code: "PRIVATE_BALANCE_FUNDING_UNRESOLVED",
    message:
      "The prepared private balance funding operation may have been submitted. Do not retry with a new client request ID.",
  };
}

function hasConflictingUnresolvedFunding(
  state: StateDocument,
  candidate: Pick<
    PrivateBalanceFundingPlan,
    "sourceWallet" | "route" | "sourcePrivateBalance" | "targetPrivateBalance"
  >,
): boolean {
  const candidateResources = fundingResourceKeys(candidate);
  if (Object.values(state.privateBalanceFundingRequests).some((request) => {
    if (!UNRESOLVED_FUNDING_PHASES.has(request.phase)) return false;
    const existingResources = fundingResourceKeys(request);
    return [...candidateResources].some((resource) => existingResources.has(resource));
  })) return true;
  if (Object.values(state.regularRequests).some((request) => {
    if (!isUnresolvedPhase(request.phase)) return false;
    const resource = request.sourcePrivateBalance
      ? `private:${request.sourcePrivateBalance.privateBalanceId}`
      : `main:${request.authorization.walletId}`;
    return candidateResources.has(resource);
  })) return true;
  for (const resource of candidateResources) {
    if (!resource.startsWith("private:")) continue;
    const privateBalanceId = resource.slice("private:".length);
    if (Object.values(state.requests).some(
      (request) => request.privateBalanceId === privateBalanceId &&
        isUnresolvedPhase(request.phase),
    ) || Object.values(state.recoveryRequests).some(
      (request) => request.privateBalanceId === privateBalanceId &&
        isUnresolvedPhase(request.phase),
    )) return true;
  }
  return false;
}

function isUnresolvedPhase(phase: string): boolean {
  return phase === "executing" || phase === "submitted" || phase === "indeterminate";
}

function fundingResourceKeys(input: Pick<
  PrivateBalanceFundingPlan | PrivateBalanceFundingRequest,
  "sourceWallet" | "route" | "sourcePrivateBalance" | "targetPrivateBalance"
>): Set<string> {
  const resources = new Set<string>([
    `private:${input.targetPrivateBalance.privateBalanceId}`,
  ]);
  if (input.route === "shield_from_main") {
    resources.add(`main:${input.sourceWallet.walletId}`);
  } else if (input.sourcePrivateBalance) {
    resources.add(`private:${input.sourcePrivateBalance.privateBalanceId}`);
  }
  return resources;
}

function requireNamedBalanceAdapter(
  wallet: IsolatedPrivateBalanceAdapter,
): IsolatedPrivateBalanceAdapter & Required<Pick<
  IsolatedPrivateBalanceAdapter,
  "getPrivateBalanceWeiForWallet"
>> {
  if (!wallet.getPrivateBalanceWeiForWallet) {
    throw new Error("ISOLATED_PRIVATE_BALANCE_UNAVAILABLE");
  }
  return wallet as IsolatedPrivateBalanceAdapter & Required<Pick<
    IsolatedPrivateBalanceAdapter,
    "getPrivateBalanceWeiForWallet"
  >>;
}

function requireFundingPreparationAdapter(
  wallet: IsolatedPrivateBalanceAdapter,
): IsolatedPrivateBalanceAdapter & Required<Pick<
  IsolatedPrivateBalanceAdapter,
  | "getPrivateBalanceWeiForWallet"
  | "peekNextFreshAddressForWallet"
  | "prepareTornadoEthDeposit"
>> {
  if (!wallet.getPrivateBalanceWeiForWallet ||
    !wallet.peekNextFreshAddressForWallet ||
    !wallet.prepareTornadoEthDeposit) {
    throw new Error("ISOLATED_PRIVATE_BALANCE_UNAVAILABLE");
  }
  return wallet as IsolatedPrivateBalanceAdapter & Required<Pick<
    IsolatedPrivateBalanceAdapter,
    | "getPrivateBalanceWeiForWallet"
    | "peekNextFreshAddressForWallet"
    | "prepareTornadoEthDeposit"
  >>;
}

function requireFundingExecutionAdapter(
  wallet: IsolatedPrivateBalanceAdapter,
  route: PrivateBalanceFundingPlan["route"],
): IsolatedPrivateBalanceAdapter & Required<Pick<
  IsolatedPrivateBalanceAdapter,
  | "getPrivateBalanceWeiForWallet"
  | "peekNextFreshAddressForWallet"
  | "executePreparedMainDeposit"
  | "executePrivateRebalance"
>> {
  if (!wallet.getPrivateBalanceWeiForWallet ||
    !wallet.peekNextFreshAddressForWallet ||
    (route === "shield_from_main" && !wallet.executePreparedMainDeposit) ||
    (route === "rebalance_private" && !wallet.executePrivateRebalance)) {
    throw new Error("ISOLATED_PRIVATE_BALANCE_UNAVAILABLE");
  }
  return wallet as IsolatedPrivateBalanceAdapter & Required<Pick<
    IsolatedPrivateBalanceAdapter,
    | "getPrivateBalanceWeiForWallet"
    | "peekNextFreshAddressForWallet"
    | "executePreparedMainDeposit"
    | "executePrivateRebalance"
  >>;
}

async function readNamedBalanceBestEffort(
  adapter: Pick<IsolatedPrivateBalanceAdapter, "getPrivateBalanceWeiForWallet"> & {
    getPrivateBalanceWeiForWallet: NonNullable<
      IsolatedPrivateBalanceAdapter["getPrivateBalanceWeiForWallet"]
    >;
  },
  walletName: string,
): Promise<bigint | undefined> {
  try {
    return await adapter.getPrivateBalanceWeiForWallet(walletName);
  } catch {
    return undefined;
  }
}

function creationIntentDigest(input: {
  wallet: WalletSelectionBinding;
  walletOnboardingRevision: number;
  privateBalanceId: string;
  privateBalanceName: string;
  backendWalletName: string;
  initialPolicy: DelegationPolicy;
}): string {
  return sha256({
    operation: "create_isolated_private_balance",
    chain_id: "eip155:11155111",
    wallet_id: input.wallet.walletId,
    wallet_name: input.wallet.walletName,
    selection_epoch: input.wallet.selectionEpoch,
    wallet_onboarding_revision: input.walletOnboardingRevision,
    private_balance_id: input.privateBalanceId,
    private_balance_name: input.privateBalanceName,
    backend_wallet_name: input.backendWalletName,
    initial_policy: input.initialPolicy,
  });
}

function fundingIntentDigest(input: {
  sourceWallet: WalletSelectionBinding;
  targetWallet: WalletSelectionBinding;
  route: PrivateBalanceFundingPlan["route"];
  sourcePrivateBalance?: PrivateBalanceBinding;
  targetPrivateBalance: PrivateBalanceBinding;
  amountWei: string;
  mainBalanceSnapshotWei: string;
  gasReserveWei: string;
  shieldDenominationWei: string;
  withdrawalAmountWei?: string;
  aggregatePrivateBalanceSnapshotWei: string;
  sourcePrivateBalanceSnapshotWei?: string;
  targetPrivateBalanceSnapshotWei: string;
  sourceExecutorAddress: string;
  targetCommitment: string;
  preparedDepositCall: PreparedDepositCall;
}): string {
  return sha256({
    operation: input.route,
    chain_id: "eip155:11155111",
    source_wallet: input.sourceWallet,
    target_wallet: input.targetWallet,
    source_private_balance: input.sourcePrivateBalance ?? null,
    target_private_balance: input.targetPrivateBalance,
    amount_atomic: input.amountWei,
    main_balance_snapshot_atomic: input.mainBalanceSnapshotWei,
    gas_reserve_atomic: input.gasReserveWei,
    shield_denomination_atomic: input.shieldDenominationWei,
    withdrawal_amount_atomic: input.withdrawalAmountWei ?? null,
    aggregate_private_balance_snapshot_atomic: input.aggregatePrivateBalanceSnapshotWei,
    source_private_balance_snapshot_atomic: input.sourcePrivateBalanceSnapshotWei ?? null,
    target_private_balance_snapshot_atomic: input.targetPrivateBalanceSnapshotWei,
    source_executor_address: input.sourceExecutorAddress.toLowerCase(),
    target_commitment: input.targetCommitment,
    prepared_deposit_call: {
      to: input.preparedDepositCall.to.toLowerCase(),
      data: input.preparedDepositCall.data.toLowerCase(),
      value_atomic: input.preparedDepositCall.valueWei,
    },
  });
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
