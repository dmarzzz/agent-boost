import { createHash, randomUUID } from "node:crypto";

import type {
  ChainClient,
  PaymentApproval,
  PrivateBalanceBinding,
  PrivateBalanceRecord,
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
import { WalletExecutionError } from "./errors.js";
import {
  matchingRawTransactionBroadcastCheckpoint,
  refreshPublicChangeAccount,
} from "./public-change.js";
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
  sourcePrivateBalance?: PrivateBalanceBinding,
  sourcePublicAddress?: string,
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
    source_kind: sourcePrivateBalance ? "private_balance_public_change" : "main",
    source_private_balance_id: sourcePrivateBalance?.privateBalanceId ?? null,
    source_private_balance_revision:
      sourcePrivateBalance?.privateBalanceRevision ?? null,
    source_public_address: sourcePublicAddress?.toLowerCase() ?? null,
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
        const now = this.#clock.now().toISOString();
        request.updatedAt = now;
        if (request.broadcastStartedAt) {
          request.phase = "indeterminate";
          request.error = {
            code: "EXECUTION_INTERRUPTED",
            message:
              "Agent Boost restarted after regular-transfer broadcast began; do not create or execute a replacement transfer.",
          };
        } else {
          request.phase = "failed";
          request.error = {
            code: "EXECUTION_INTERRUPTED_BEFORE_BROADCAST",
            message: "Agent Boost restarted before regular-transfer broadcast began; policy spend was restored.",
          };
          restorePolicySpend(draft, request, now);
        }
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

  async plan(input: {
    recipient: string;
    amountWei: string;
    sourcePrivateBalanceId?: string;
  }): Promise<RegularTransferPlan> {
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
    const amount = BigInt(input.amountWei);
    const requiredBalance = amount + this.#gasReserveWei;
    let sourceBalance = BigInt(onboarding?.publicBalanceWei ?? "0");
    let sourcePrivateBalance: PrivateBalanceRecord | undefined;
    let sourcePrivateBalanceBinding: PrivateBalanceBinding | undefined;
    let sourcePublicAddress: string | undefined;
    if (input.sourcePrivateBalanceId === undefined) {
      if (hasUnresolvedMainAccountActivity(state, authorization.walletId)) {
        blockers.push("MAIN_ACCOUNT_OPERATION_UNRESOLVED");
      }
      if (!onboarding?.address) {
        blockers.push("MAIN_ACCOUNT_NOT_READY");
      } else {
        try {
          await this.#chain.assertSepolia();
          sourceBalance = await this.#chain.getBalanceWei(onboarding.address);
          state = await this.#store.update((draft) => {
            if (!draft.onboarding || draft.onboarding.address !== onboarding.address) return;
            if (draft.onboarding.publicBalanceWei === sourceBalance.toString()) return;
            draft.onboarding.publicBalanceWei = sourceBalance.toString();
            draft.onboarding.revision += 1;
            draft.onboarding.updatedAt = this.#clock.now().toISOString();
          });
        } catch {
          blockers.push("MAIN_BALANCE_UNAVAILABLE");
        }
      }
    } else {
      sourceBalance = 0n;
      sourcePrivateBalance = activePrivateBalance(
        state,
        input.sourcePrivateBalanceId,
      );
      if (sourcePrivateBalance.status !== "available") {
        blockers.push("PRIVATE_BALANCE_ARCHIVED");
      }
      if (hasUnresolvedPrivateBalanceActivity(
        state,
        sourcePrivateBalance.privateBalanceId,
      )) {
        blockers.push("PRIVATE_BALANCE_OPERATION_UNRESOLVED");
      }
      const liveBalances = new Map<string, bigint>();
      let balanceReadFailed = false;
      try {
        await this.#chain.assertSepolia();
        await Promise.all(Object.values(
          sourcePrivateBalance.publicChangeAccounts ?? {},
        ).map(async (account) => {
          try {
            liveBalances.set(
              account.address.toLowerCase(),
              await this.#chain.getBalanceWei(account.address),
            );
          } catch {
            balanceReadFailed = true;
          }
        }));
        state = await this.#store.update((draft) => {
          const profile = activeWalletProfile(draft);
          const pocket = profile.privateBalances[input.sourcePrivateBalanceId!];
          if (!pocket) throw new Error("PRIVATE_BALANCE_NOT_FOUND");
          const observedAt = this.#clock.now().toISOString();
          for (const [address, balanceWei] of liveBalances) {
            if (!pocket.publicChangeAccounts?.[address] ||
              pocket.publicChangeAccounts[address]!.balanceWei === balanceWei.toString()) {
              continue;
            }
            refreshPublicChangeAccount({
              profile,
              privateBalanceId: pocket.privateBalanceId,
              address,
              balanceWei,
              observedAt,
            });
          }
        });
      } catch {
        balanceReadFailed = true;
      }
      sourcePrivateBalance = activePrivateBalance(
        state,
        input.sourcePrivateBalanceId,
      );
      const candidates = Object.values(
        sourcePrivateBalance.publicChangeAccounts ?? {},
      ).filter((account) =>
        (liveBalances.get(account.address.toLowerCase()) ?? -1n) >= requiredBalance
      ).sort((left, right) => {
        const leftBalance = liveBalances.get(left.address.toLowerCase())!;
        const rightBalance = liveBalances.get(right.address.toLowerCase())!;
        if (leftBalance !== rightBalance) return leftBalance < rightBalance ? -1 : 1;
        return left.address.localeCompare(right.address);
      });
      const selectedAccount = candidates[0];
      if (selectedAccount) {
        sourcePublicAddress = selectedAccount.address;
        sourceBalance = liveBalances.get(selectedAccount.address.toLowerCase())!;
        if (input.recipient.toLowerCase() === sourcePublicAddress.toLowerCase()) {
          blockers.push("REGULAR_TRANSFER_SELF_SEND_BLOCKED");
        }
      } else {
        const aggregate = [...liveBalances.values()].reduce(
          (sum, balance) => sum + balance,
          0n,
        );
        if (balanceReadFailed) {
          blockers.push("PRIVATE_BALANCE_PUBLIC_CHANGE_UNAVAILABLE");
        } else if (aggregate >= requiredBalance) {
          blockers.push("PRIVATE_BALANCE_PUBLIC_CHANGE_FRAGMENTED");
        } else {
          blockers.push("INSUFFICIENT_PRIVATE_BALANCE_PUBLIC_CHANGE_WITH_GAS_RESERVE");
        }
      }
      sourcePrivateBalanceBinding = privateBalanceBinding(
        authorization,
        sourcePrivateBalance,
      );
    }

    const current = state.onboarding;
    if (sourcePrivateBalanceBinding) {
      if (!this.#wallet.executeRegularTransferFromWallet) {
        blockers.push("PRIVATE_BALANCE_PUBLIC_CHANGE_TRANSFER_UNAVAILABLE");
      }
    } else if (!this.#wallet.executeRegularTransfer) {
      blockers.push("REGULAR_TRANSFER_UNAVAILABLE");
    }
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
    if (sourcePrivateBalance) {
      const policy = sourcePrivateBalance.delegation;
      if (!policy.enabled) blockers.push("PRIVATE_BALANCE_POLICY_DISABLED");
      if (new Date(policy.expiresAt).getTime() <= this.#clock.now().getTime()) {
        blockers.push("PRIVATE_BALANCE_POLICY_EXPIRED");
      }
      if (policy.maxPayments > MAX_POLICY_PAYMENTS ||
        BigInt(policy.perPaymentLimitWei) > MAX_POLICY_PAYMENT_LIMIT_WEI ||
        BigInt(policy.lifetimeLimitWei) > MAX_POLICY_LIFETIME_LIMIT_WEI) {
        blockers.push("PRIVATE_BALANCE_POLICY_OUTSIDE_HARD_BOUNDS");
      }
      if (privateBalancePaymentCount(
        state,
        sourcePrivateBalance.privateBalanceId,
        authorization.authorizationId,
      ) >= policy.maxPayments) {
        blockers.push("PRIVATE_BALANCE_PAYMENT_COUNT_LIMIT");
      }
      if (amount > BigInt(policy.perPaymentLimitWei)) {
        blockers.push("PRIVATE_BALANCE_PER_PAYMENT_LIMIT");
      }
      if (BigInt(policy.spentWei) + amount > BigInt(policy.lifetimeLimitWei)) {
        blockers.push("PRIVATE_BALANCE_LIFETIME_LIMIT");
      }
    }
    if (this.#executionLimitWei !== undefined && amount > this.#executionLimitWei) {
      blockers.push("EXECUTION_LIMIT");
    }
    if (requiredBalance > sourceBalance) {
      const balanceBlocker = sourcePrivateBalance
        ? "INSUFFICIENT_PRIVATE_BALANCE_PUBLIC_CHANGE_WITH_GAS_RESERVE"
        : "INSUFFICIENT_MAIN_BALANCE_WITH_GAS_RESERVE";
      const sourceResolutionAlreadyExplained = sourcePrivateBalance && (
        blockers.includes("PRIVATE_BALANCE_PUBLIC_CHANGE_UNAVAILABLE") ||
        blockers.includes("PRIVATE_BALANCE_PUBLIC_CHANGE_FRAGMENTED")
      );
      if (!sourceResolutionAlreadyExplained && !blockers.includes(balanceBlocker)) {
        blockers.push(balanceBlocker);
      }
    }

    const now = this.#clock.now();
    const plan: RegularTransferPlan = {
      version: 1,
      decisionId: `rwd_${randomUUID()}`,
      recipient: input.recipient,
      amountWei: input.amountWei,
      mainBalanceSnapshotWei: sourceBalance.toString(),
      gasReserveWei: this.#gasReserveWei.toString(),
      authorization,
      ...(sourcePrivateBalanceBinding && sourcePublicAddress ? {
        sourcePrivateBalance: sourcePrivateBalanceBinding,
        sourcePublicAddress,
      } : {}),
      intentDigest: digestIntent(
        input.recipient,
        input.amountWei,
        this.#gasReserveWei.toString(),
        authorization,
        sourcePrivateBalanceBinding,
        sourcePublicAddress,
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
    if (Object.values(state.regularRequests).some(
      (request) => request.decisionId === input.decisionId,
    )) {
      throw new Error("REGULAR_TRANSFER_DECISION_ALREADY_CONSUMED");
    }
    if (this.#execution) throw new Error("REGULAR_TRANSFER_ALREADY_EXECUTING");
    const plan = state.regularPlans[input.decisionId];
    if (!plan) throw new Error("REGULAR_TRANSFER_DECISION_NOT_FOUND");
    if (plan.blockers.includes("USER_CANCELLED")) {
      throw new Error("REGULAR_TRANSFER_DECISION_CANCELLED");
    }
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

  async cancel(decisionId: string): Promise<RegularTransferPlan> {
    const state = await this.#store.update((draft) => {
      const plan = draft.regularPlans[decisionId];
      if (!plan) throw new Error("REGULAR_TRANSFER_DECISION_NOT_FOUND");
      if (Object.values(draft.regularRequests).some(
        (request) => request.decisionId === decisionId,
      )) {
        throw new Error("REGULAR_TRANSFER_DECISION_ALREADY_CONSUMED");
      }
      plan.decision = "deny";
      if (!plan.blockers.includes("USER_CANCELLED")) plan.blockers.push("USER_CANCELLED");
    });
    return state.regularPlans[decisionId]!;
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
    const initialState = await this.#store.read();
    const request = initialState.regularRequests[requestId];
    if (!request) throw new Error("REGULAR_TRANSFER_REQUEST_NOT_FOUND");
    if (
      request.phase !== "executing" &&
      request.phase !== "submitted" &&
      request.phase !== "indeterminate"
    ) {
      return request;
    }

    const expectedSourceAddress = request.sourcePublicAddress ??
      initialState.wallet?.profiles[request.authorization.walletId]
        ?.onboarding?.address;
    let checkpoint: Awaited<ReturnType<
      typeof matchingRawTransactionBroadcastCheckpoint
    >>;
    let checkpointMismatch = false;
    if (request.broadcastStartedAt && expectedSourceAddress) {
      try {
        checkpoint = await matchingRawTransactionBroadcastCheckpoint({
          wallet: this.#wallet,
          requestId,
          expectedFrom: expectedSourceAddress,
          expectedTo: request.recipient,
          expectedValueWei: request.amountWei,
          expectedData: "0x",
          ...(request.transactionHash === undefined
            ? {}
            : { storedTransactionHash: request.transactionHash }),
        });
      } catch {
        checkpointMismatch = true;
      }
    } else if (
      request.broadcastStartedAt &&
      this.#wallet.getRawTransactionBroadcastCheckpoint
    ) {
      checkpointMismatch = true;
    }
    const transactionHash = checkpointMismatch
      ? undefined
      : request.transactionHash ?? checkpoint?.transactionHash;
    let receiptStatus: "pending" | "success" | "reverted" | undefined;
    if (transactionHash && this.#chain.getTransactionReceiptStatus) {
      try {
        receiptStatus = await this.#chain.getTransactionReceiptStatus(transactionHash);
      } catch {
        // Reconciliation is read-only and best-effort.
      }
    }
    let sourceBalanceAfter: bigint | undefined;
    if ((receiptStatus === "success" || receiptStatus === "reverted") &&
      request.sourcePublicAddress) {
      try {
        sourceBalanceAfter = await this.#chain.getBalanceWei(
          request.sourcePublicAddress,
        );
      } catch {
        // The transaction receipt remains authoritative. A later wallet-tree
        // read can refresh the public-change amount.
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
      if (!current.transactionHash && checkpoint) {
        current.transactionHash = checkpoint.transactionHash;
      }
      if (sourceBalanceAfter !== undefined && current.sourcePrivateBalance &&
        current.sourcePublicAddress) {
        const profile = draft.wallet?.profiles[current.authorization.walletId];
        if (!profile) throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_TARGET_MISSING");
        refreshPublicChangeAccount({
          profile,
          privateBalanceId: current.sourcePrivateBalance.privateBalanceId,
          address: current.sourcePublicAddress,
          balanceWei: sourceBalanceAfter,
          observedAt: checkedAt,
        });
        current.sourcePublicBalanceAfterWei = sourceBalanceAfter.toString();
      }
      if (!current.broadcastStartedAt) {
        current.phase = "failed";
        current.updatedAt = checkedAt;
        current.error = {
          code: "REGULAR_TRANSFER_NOT_BROADCAST",
          message: "The regular transfer stopped before broadcast; policy spend was restored.",
        };
        restorePolicySpend(draft, current, checkedAt);
      } else if (checkpointMismatch) {
        current.phase = "indeterminate";
        current.updatedAt = checkedAt;
        current.error = {
          code: "RAW_TRANSACTION_BROADCAST_CHECKPOINT_MISMATCH",
          message:
            "The durable regular-transfer checkpoint does not match this request. It was not retried.",
        };
      } else if (receiptStatus === "reverted") {
        current.phase = "failed";
        current.updatedAt = checkedAt;
        current.error = {
          code: "TRANSACTION_REVERTED",
          message: "The regular transfer transaction was included but reverted.",
        };
        restorePolicySpend(draft, current, checkedAt);
      } else if (receiptStatus === "success") {
        current.phase = "confirmed";
        current.updatedAt = checkedAt;
        current.confirmation = {
          method: "transaction_receipt",
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
    const pocketSource = plan.sourcePrivateBalance !== undefined ||
      plan.sourcePublicAddress !== undefined;
    if (pocketSource && (!plan.sourcePrivateBalance || !plan.sourcePublicAddress)) {
      throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_BINDING_MISSING");
    }
    if (pocketSource) {
      if (!this.#wallet.executeRegularTransferFromWallet) {
        throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_TRANSFER_UNAVAILABLE");
      }
    } else if (!this.#wallet.executeRegularTransfer) {
      throw new Error("REGULAR_TRANSFER_UNAVAILABLE");
    }
    await this.#chain.assertSepolia();
    const before = await this.#store.read();
    const mainAddress = before.onboarding?.address;
    const sourceAddress = pocketSource ? plan.sourcePublicAddress! : mainAddress;
    if (!sourceAddress) throw new Error("MAIN_ACCOUNT_NOT_READY");
    const liveSourceBalance = await this.#chain.getBalanceWei(sourceAddress);
    if (pocketSource && liveSourceBalance.toString() !== plan.mainBalanceSnapshotWei) {
      throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_BALANCE_CHANGED");
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
      ...(pocketSource ? {
        sourcePrivateBalance: plan.sourcePrivateBalance!,
        sourcePublicAddress: plan.sourcePublicAddress!,
        sourcePublicBalanceBeforeWei: liveSourceBalance.toString(),
        privatePolicySpendDebitedAt: now,
      } : {}),
      policySpendDebitedAt: now,
      phase: "executing",
      createdAt: now,
      updatedAt: now,
    };

    await this.#store.update((draft) => {
      const onboarding = draft.onboarding;
      const storedPlan = draft.regularPlans[plan.decisionId];
      const active = activeAuthorization(draft);
      if (Object.values(draft.regularRequests).some(
        (existing) => existing.decisionId === plan.decisionId,
      )) {
        throw new Error("REGULAR_TRANSFER_DECISION_ALREADY_CONSUMED");
      }
      if (!storedPlan ||
        storedPlan.decision !== "allow" ||
        storedPlan.intentDigest !== plan.intentDigest ||
        storedPlan.recipient !== plan.recipient || storedPlan.amountWei !== plan.amountWei ||
        storedPlan.gasReserveWei !== plan.gasReserveWei ||
        !sameOptionalPrivateBalanceBinding(
          storedPlan.sourcePrivateBalance,
          plan.sourcePrivateBalance,
        ) ||
        storedPlan.sourcePublicAddress?.toLowerCase() !==
          plan.sourcePublicAddress?.toLowerCase() ||
        !sameAuthorization(storedPlan.authorization, plan.authorization) ||
        !sameAuthorization(active, plan.authorization)) {
        throw new Error("REGULAR_TRANSFER_DECISION_CHANGED");
      }
      if (!onboarding) throw new Error("WALLET_SETUP_NOT_STARTED");
      if (!pocketSource && hasUnresolvedMainAccountActivity(
        draft,
        plan.authorization.walletId,
      )) {
        throw new Error("MAIN_ACCOUNT_OPERATION_UNRESOLVED");
      }
      if (!pocketSource && (!onboarding.address || onboarding.address !== mainAddress)) {
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
      if (amount + BigInt(plan.gasReserveWei) > liveSourceBalance) {
        throw new Error(pocketSource
          ? "INSUFFICIENT_PRIVATE_BALANCE_PUBLIC_CHANGE_WITH_GAS_RESERVE"
          : "INSUFFICIENT_MAIN_BALANCE_WITH_GAS_RESERVE");
      }
      if (pocketSource) {
        const binding = plan.sourcePrivateBalance!;
        const pocket = draft.wallet?.profiles[binding.walletId]
          ?.privateBalances[binding.privateBalanceId];
        const account = pocket?.publicChangeAccounts?.[
          plan.sourcePublicAddress!.toLowerCase()
        ];
        if (!pocket || !account || pocket.status !== "available" ||
          !samePrivateBalanceBinding(binding, plan.authorization, pocket)) {
          throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_BINDING_CHANGED");
        }
        if (hasUnresolvedPrivateBalanceActivity(
          draft,
          pocket.privateBalanceId,
        )) {
          throw new Error("PRIVATE_BALANCE_OPERATION_UNRESOLVED");
        }
        const policy = pocket.delegation;
        if (!policy.enabled) throw new Error("PRIVATE_BALANCE_POLICY_DISABLED");
        if (new Date(policy.expiresAt).getTime() <= nowMs) {
          throw new Error("PRIVATE_BALANCE_POLICY_EXPIRED");
        }
        if (policy.maxPayments > MAX_POLICY_PAYMENTS ||
          BigInt(policy.perPaymentLimitWei) > MAX_POLICY_PAYMENT_LIMIT_WEI ||
          BigInt(policy.lifetimeLimitWei) > MAX_POLICY_LIFETIME_LIMIT_WEI) {
          throw new Error("PRIVATE_BALANCE_POLICY_OUTSIDE_HARD_BOUNDS");
        }
        if (privateBalancePaymentCount(
          draft,
          pocket.privateBalanceId,
          plan.authorization.authorizationId,
        ) >= policy.maxPayments) {
          throw new Error("PRIVATE_BALANCE_PAYMENT_COUNT_LIMIT");
        }
        if (amount > BigInt(policy.perPaymentLimitWei)) {
          throw new Error("PRIVATE_BALANCE_PER_PAYMENT_LIMIT");
        }
        const privateSpent = BigInt(policy.spentWei);
        if (privateSpent + amount > BigInt(policy.lifetimeLimitWei)) {
          throw new Error("PRIVATE_BALANCE_LIFETIME_LIMIT");
        }
        if (account.balanceWei !== liveSourceBalance.toString()) {
          refreshPublicChangeAccount({
            profile: draft.wallet!.profiles[binding.walletId]!,
            privateBalanceId: pocket.privateBalanceId,
            address: account.address,
            balanceWei: liveSourceBalance,
            observedAt: now,
          });
        }
        pocket.delegation.spentWei = (privateSpent + amount).toString();
        pocket.revision += 1;
        pocket.updatedAt = now;
      }
      if (!pocketSource) onboarding.publicBalanceWei = liveSourceBalance.toString();
      onboarding.delegation.spentWei = (spent + amount).toString();
      onboarding.revision += 1;
      onboarding.updatedAt = this.#clock.now().toISOString();
      draft.regularRequests[request.requestId] = request;
    });

    try {
      await this.#chain.assertSepolia();
      const executionInput = {
        recipient: plan.recipient,
        amountWei: BigInt(plan.amountWei),
        broadcastRequestId: request.requestId,
        beforeBroadcast: () => this.#markBroadcastStarted(request.requestId),
      };
      const result = pocketSource
        ? await this.#wallet.executeRegularTransferFromWallet!(
            plan.sourcePrivateBalance!.backendWalletName,
            {
              sourceAddress: plan.sourcePublicAddress!,
              ...executionInput,
            },
          )
        : await this.#wallet.executeRegularTransfer!({
            sourceAddress,
            ...executionInput,
          });
      let sourceBalanceAfter: bigint | undefined;
      try {
        sourceBalanceAfter = await this.#chain.getBalanceWei(sourceAddress);
      } catch {
        // Preserve the last live pre-submit balance until a future read.
      }
      const updated = await this.#store.update((draft) => {
        const current = draft.regularRequests[request.requestId];
        if (!current) throw new Error("REGULAR_TRANSFER_REQUEST_NOT_FOUND");
        current.phase = result.confirmed
          ? "confirmed"
          : result.transactionHash
            ? "submitted"
            : "indeterminate";
        current.updatedAt = this.#clock.now().toISOString();
        if (result.transactionHash) current.transactionHash = result.transactionHash;
        if (result.confirmed) {
          current.confirmation = {
            method: "adapter",
            checkedAt: current.updatedAt,
          };
          delete current.error;
        }
        if (sourceBalanceAfter !== undefined) {
          if (pocketSource && current.sourcePrivateBalance &&
            current.sourcePublicAddress) {
            const profile = draft.wallet?.profiles[current.authorization.walletId];
            if (!profile) throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_TARGET_MISSING");
            refreshPublicChangeAccount({
              profile,
              privateBalanceId: current.sourcePrivateBalance.privateBalanceId,
              address: current.sourcePublicAddress,
              balanceWei: sourceBalanceAfter,
              observedAt: current.updatedAt,
            });
            current.sourcePublicBalanceAfterWei = sourceBalanceAfter.toString();
          } else if (draft.onboarding) {
            draft.onboarding.publicBalanceWei = sourceBalanceAfter.toString();
            draft.onboarding.revision += 1;
            draft.onboarding.updatedAt = current.updatedAt;
          }
        }
      });
      return updated.regularRequests[request.requestId] as RegularTransferRequest;
    } catch (error) {
      const definitelyNotBroadcast = error instanceof WalletExecutionError &&
        !error.mayHaveBroadcast;
      const updated = await this.#store.update((draft) => {
        const current = draft.regularRequests[request.requestId];
        if (!current) return;
        current.updatedAt = this.#clock.now().toISOString();
        if (definitelyNotBroadcast) {
          current.phase = "failed";
          current.error = {
            code: "REGULAR_TRANSFER_REJECTED_BEFORE_BROADCAST",
            message: "The regular transfer failed before broadcast; policy spend was restored.",
          };
          restorePolicySpend(draft, current, current.updatedAt);
        } else {
          current.phase = "indeterminate";
          current.error = {
            code: "REGULAR_TRANSFER_UNRESOLVED",
            message:
              "The regular transfer may have been submitted. Do not retry with a new client request ID.",
          };
        }
      });
      return updated.regularRequests[request.requestId] as RegularTransferRequest;
    }
  }

  async #markBroadcastStarted(requestId: string): Promise<void> {
    await this.#store.update((draft) => {
      const request = draft.regularRequests[requestId];
      if (!request || request.phase !== "executing" || request.broadcastStartedAt) {
        throw new Error("REGULAR_TRANSFER_REQUEST_NOT_EXECUTABLE");
      }
      request.broadcastStartedAt = this.#clock.now().toISOString();
      request.updatedAt = request.broadcastStartedAt;
    });
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

function activeWalletProfile(state: StateDocument) {
  const profile = state.wallet?.profiles[state.wallet.activeWalletId];
  if (!profile) throw new Error("ACTIVE_WALLET_PROFILE_MISSING");
  return profile;
}

function activePrivateBalance(
  state: StateDocument,
  privateBalanceId: string,
): PrivateBalanceRecord {
  const privateBalance = activeWalletProfile(state).privateBalances[privateBalanceId];
  if (!privateBalance) throw new Error("PRIVATE_BALANCE_NOT_FOUND");
  return privateBalance;
}

function privateBalanceBinding(
  authorization: WalletAuthorizationBinding,
  privateBalance: PrivateBalanceRecord,
): PrivateBalanceBinding {
  return {
    walletId: authorization.walletId,
    walletName: authorization.walletName,
    selectionEpoch: authorization.selectionEpoch,
    privateBalanceId: privateBalance.privateBalanceId,
    privateBalanceName: privateBalance.name,
    backendWalletName: privateBalance.backendWalletName,
    privateBalanceRevision: privateBalance.revision,
  };
}

function sameOptionalPrivateBalanceBinding(
  left: PrivateBalanceBinding | undefined,
  right: PrivateBalanceBinding | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.walletId === right.walletId &&
    left.walletName === right.walletName &&
    left.selectionEpoch === right.selectionEpoch &&
    left.privateBalanceId === right.privateBalanceId &&
    left.privateBalanceName === right.privateBalanceName &&
    left.backendWalletName === right.backendWalletName &&
    left.privateBalanceRevision === right.privateBalanceRevision;
}

function samePrivateBalanceBinding(
  binding: PrivateBalanceBinding,
  authorization: WalletAuthorizationBinding,
  privateBalance: PrivateBalanceRecord,
): boolean {
  return binding.walletId === authorization.walletId &&
    binding.walletName === authorization.walletName &&
    binding.selectionEpoch === authorization.selectionEpoch &&
    binding.privateBalanceId === privateBalance.privateBalanceId &&
    binding.privateBalanceName === privateBalance.name &&
    binding.backendWalletName === privateBalance.backendWalletName &&
    binding.privateBalanceRevision === privateBalance.revision;
}

function paymentCount(state: StateDocument, authorization: WalletAuthorizationBinding): number {
  return Object.values(state.requests).filter(
    (request) => request.phase !== "failed" &&
      request.authorization.authorizationId === authorization.authorizationId,
  ).length + Object.values(state.regularRequests).filter(
    (request) => request.phase !== "failed" &&
      request.authorization.authorizationId === authorization.authorizationId,
  ).length;
}

function privateBalancePaymentCount(
  state: StateDocument,
  privateBalanceId: string,
  authorizationId: string,
): number {
  return Object.values(state.requests).filter(
    (request) => request.phase !== "failed" &&
      request.privateBalanceId === privateBalanceId &&
      request.authorization.authorizationId === authorizationId,
  ).length + Object.values(state.regularRequests).filter(
    (request) => request.phase !== "failed" &&
      request.sourcePrivateBalance?.privateBalanceId === privateBalanceId &&
      request.authorization.authorizationId === authorizationId,
  ).length;
}

function hasUnresolvedPrivateBalanceActivity(
  state: StateDocument,
  privateBalanceId: string,
): boolean {
  const unresolved = (phase: string): boolean =>
    phase === "executing" || phase === "submitted" || phase === "indeterminate";
  if (Object.values(state.requests).some(
    (request) => request.privateBalanceId === privateBalanceId && unresolved(request.phase),
  )) return true;
  if (Object.values(state.recoveryRequests).some(
    (request) => request.privateBalanceId === privateBalanceId && unresolved(request.phase),
  )) return true;
  if (Object.values(state.regularRequests).some(
    (request) => request.sourcePrivateBalance?.privateBalanceId === privateBalanceId &&
      unresolved(request.phase),
  )) return true;
  return Object.values(state.privateBalanceFundingRequests).some(
    (request) => unresolved(request.phase) &&
      (request.targetPrivateBalance.privateBalanceId === privateBalanceId ||
        request.sourcePrivateBalance?.privateBalanceId === privateBalanceId),
  );
}

function hasUnresolvedMainAccountActivity(
  state: StateDocument,
  walletId: string,
): boolean {
  const unresolved = (phase: string): boolean =>
    phase === "executing" || phase === "submitted" || phase === "indeterminate";
  if (Object.values(state.regularRequests).some(
    (request) => request.authorization.walletId === walletId &&
      request.sourcePrivateBalance === undefined && unresolved(request.phase),
  )) return true;
  return Object.values(state.privateBalanceFundingRequests).some(
    (request) => request.sourceWallet.walletId === walletId &&
      request.route === "shield_from_main" && unresolved(request.phase),
  );
}

function restorePolicySpend(
  state: StateDocument,
  request: RegularTransferRequest,
  restoredAt: string,
): void {
  const profile = state.wallet?.profiles[request.authorization.walletId];
  const onboarding = state.wallet?.activeWalletId === request.authorization.walletId
    ? state.onboarding
    : profile?.onboarding;
  if (!profile || !onboarding) throw new Error("REGULAR_TRANSFER_POLICY_RESTORE_TARGET_MISSING");
  const amount = BigInt(request.amountWei);
  if (!request.policySpendRestoredAt && request.policySpendDebitedAt) {
    const spent = BigInt(onboarding.delegation.spentWei);
    onboarding.delegation.spentWei = (spent > amount ? spent - amount : 0n).toString();
    onboarding.revision += 1;
    onboarding.updatedAt = restoredAt;
    request.policySpendRestoredAt = restoredAt;
  }
  if (!request.privatePolicySpendRestoredAt && request.privatePolicySpendDebitedAt &&
    request.sourcePrivateBalance) {
    const pocket = profile.privateBalances[
      request.sourcePrivateBalance.privateBalanceId
    ];
    if (!pocket || pocket.backendWalletName !==
      request.sourcePrivateBalance.backendWalletName) {
      throw new Error("REGULAR_TRANSFER_PRIVATE_POLICY_RESTORE_TARGET_MISSING");
    }
    const spent = BigInt(pocket.delegation.spentWei);
    pocket.delegation.spentWei = (spent > amount ? spent - amount : 0n).toString();
    pocket.revision += 1;
    pocket.updatedAt = restoredAt;
    profile.updatedAt = restoredAt;
    request.privatePolicySpendRestoredAt = restoredAt;
  }
}
