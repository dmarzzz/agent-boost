import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  PaymentPlan,
  PaymentRequest,
  PrivateBalanceBinding,
  PrivateBalanceFundingPlan,
  PrivateBalanceFundingRequest,
  RegularTransferPlan,
  RegularTransferRequest,
  RecoveryTransferPlan,
  RecoveryTransferRequest,
  WalletAuthorizationBinding,
  WalletSelectionBinding,
} from "../src/contracts.js";
import { StateStore } from "../src/state/store.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const UPDATED_AT = "2026-01-01T00:01:00.000Z";
const LATER_AT = "2026-01-01T00:02:00.000Z";
const EXPIRES_AT = "2100-01-01T00:00:00.000Z";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const SECOND_RECIPIENT = "0x3333333333333333333333333333333333333333";
const MAIN_ADDRESS = "0x1111111111111111111111111111111111111111";
const POOL_ADDRESS = "0x4444444444444444444444444444444444444444";
const CHANGE_ADDRESS = "0x5555555555555555555555555555555555555555";

interface ReadyContext {
  store: StateStore;
  wallet: WalletSelectionBinding;
  authorization: WalletAuthorizationBinding;
  pocket: PrivateBalanceBinding;
}

async function readyStore(): Promise<ReadyContext> {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-audit-"));
  const store = new StateStore(root, "alpha");
  await store.initialize();
  await store.ensureWalletProfile("alpha");
  await store.update((draft) => {
    draft.onboarding = {
      version: 1,
      setupId: "setup-audit",
      revision: 1,
      phase: "private_ready",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      address: MAIN_ADDRESS,
      publicBalanceWei: "1000",
      privateBalanceWei: "100",
      requiredFundingWei: "200",
      shieldAmountWei: "100",
      delegation: {
        mode: "testnet_delegated",
        chainId: 11_155_111,
        perPaymentLimitWei: "100",
        lifetimeLimitWei: "1000",
        spentWei: "0",
        maxPayments: 10,
        expiresAt: EXPIRES_AT,
        enabled: true,
      },
    };
  });
  const state = await store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  const privateBalance = profile.privateBalances[profile.defaultPrivateBalanceId]!;
  const wallet: WalletSelectionBinding = {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
  };
  return {
    store,
    wallet,
    authorization: {
      ...wallet,
      authorizationId: profile.authorizationId!,
    },
    pocket: {
      ...wallet,
      privateBalanceId: privateBalance.privateBalanceId,
      privateBalanceName: privateBalance.name,
      backendWalletName: privateBalance.backendWalletName,
      privateBalanceRevision: privateBalance.revision,
    },
  };
}

function paymentRecords(
  context: ReadyContext,
  suffix: string,
  phase: PaymentRequest["phase"] = "executing",
): { plan: PaymentPlan; request: PaymentRequest } {
  const decisionId = `payment_${suffix}`;
  const requestId = `payment_request_${suffix}`;
  const plan: PaymentPlan = {
    version: 1,
    decisionId,
    recipient: RECIPIENT,
    amountWei: "10",
    authorization: context.authorization,
    privateBalanceId: context.pocket.privateBalanceId,
    privateBalanceRevision: context.pocket.privateBalanceRevision,
    privateBalanceDebitWei: "100",
    intentDigest: `sha256:${"1".repeat(64)}`,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    decision: "allow",
    blockers: [],
    approval: { action: "confirm", userConfirmationRequired: true },
  };
  const request: PaymentRequest = {
    version: 1,
    requestId,
    clientRequestId: `client:payment:${suffix}`,
    decisionId,
    recipient: plan.recipient,
    amountWei: plan.amountWei,
    authorization: context.authorization,
    privateBalanceId: context.pocket.privateBalanceId,
    privateBalanceRevision: context.pocket.privateBalanceRevision,
    privateBalanceDebitWei: "100",
    privateBalanceDebitedAt: CREATED_AT,
    phase,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
  return { plan, request };
}

function recoveryRecords(
  context: ReadyContext,
  suffix: string,
): { plan: RecoveryTransferPlan; request: RecoveryTransferRequest } {
  const decisionId = `recovery_${suffix}`;
  const requestId = `recovery_request_${suffix}`;
  const plan: RecoveryTransferPlan = {
    version: 1,
    decisionId,
    wallet: context.wallet,
    privateBalanceId: context.pocket.privateBalanceId,
    privateBalanceRevision: context.pocket.privateBalanceRevision,
    privateBalanceDebitWei: "100",
    recipient: SECOND_RECIPIENT,
    amountWei: "90",
    withdrawalAmountWei: "100",
    feeReserveWei: "10",
    maxRecipientAmountWei: "90",
    privateBalanceSnapshotWei: "100",
    remainingPrivateBalanceEstimateWei: "0",
    balanceRevision: context.pocket.privateBalanceRevision,
    scope: "single_tornado_denomination",
    feeModel: "reserved_from_wallet_controlled_remainder",
    intentDigest: `sha256:${"2".repeat(64)}`,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    decision: "allow",
    blockers: [],
    approval: { action: "confirm", userConfirmationRequired: true },
    consumedByRequestId: requestId,
  };
  const request: RecoveryTransferRequest = {
    version: 1,
    requestId,
    clientRequestId: `client:recovery:${suffix}`,
    decisionId,
    wallet: context.wallet,
    privateBalanceId: context.pocket.privateBalanceId,
    privateBalanceRevision: context.pocket.privateBalanceRevision,
    privateBalanceDebitWei: "100",
    privateBalanceDebitedAt: CREATED_AT,
    recipient: plan.recipient,
    amountWei: plan.amountWei,
    withdrawalAmountWei: plan.withdrawalAmountWei,
    feeReserveWei: plan.feeReserveWei,
    remainingPrivateBalanceEstimateWei: plan.remainingPrivateBalanceEstimateWei,
    scope: plan.scope,
    feeModel: plan.feeModel,
    phase: "executing",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
  return { plan, request };
}

function regularRecords(
  context: ReadyContext,
  suffix: string,
): { plan: RegularTransferPlan; request: RegularTransferRequest } {
  const decisionId = `regular_${suffix}`;
  const requestId = `regular_request_${suffix}`;
  const plan: RegularTransferPlan = {
    version: 1,
    decisionId,
    recipient: RECIPIENT,
    amountWei: "10",
    mainBalanceSnapshotWei: "1000",
    gasReserveWei: "1",
    authorization: context.authorization,
    intentDigest: `sha256:${"3".repeat(64)}`,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    decision: "allow",
    blockers: [],
    approval: { action: "confirm", userConfirmationRequired: true },
  };
  const request: RegularTransferRequest = {
    version: 1,
    requestId,
    clientRequestId: `client:regular:${suffix}`,
    decisionId,
    recipient: plan.recipient,
    amountWei: plan.amountWei,
    gasReserveWei: plan.gasReserveWei,
    authorization: context.authorization,
    policySpendDebitedAt: CREATED_AT,
    phase: "executing",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
  return { plan, request };
}

function pocketRegularRecords(
  context: ReadyContext,
  suffix: string,
): { plan: RegularTransferPlan; request: RegularTransferRequest } {
  const records = regularRecords(context, suffix);
  records.plan.mainBalanceSnapshotWei = "89";
  records.plan.sourcePrivateBalance = context.pocket;
  records.plan.sourcePublicAddress = CHANGE_ADDRESS;
  records.request.sourcePrivateBalance = context.pocket;
  records.request.sourcePublicAddress = CHANGE_ADDRESS;
  records.request.sourcePublicBalanceBeforeWei = "89";
  records.request.privatePolicySpendDebitedAt = CREATED_AT;
  return records;
}

function mainFundingRecords(
  context: ReadyContext,
  suffix: string,
): { plan: PrivateBalanceFundingPlan; request: PrivateBalanceFundingRequest } {
  const decisionId = `funding_${suffix}`;
  const requestId = `funding_request_${suffix}`;
  const plan: PrivateBalanceFundingPlan = {
    version: 1,
    decisionId,
    sourceWallet: context.wallet,
    targetWallet: context.wallet,
    route: "shield_from_main",
    targetPrivateBalance: context.pocket,
    amountWei: "100",
    mainBalanceSnapshotWei: "1000",
    gasReserveWei: "1",
    shieldDenominationWei: "100",
    aggregatePrivateBalanceSnapshotWei: "100",
    targetPrivateBalanceSnapshotWei: "100",
    sourceExecutorAddress: MAIN_ADDRESS,
    targetCommitment: `commitment-${suffix}`,
    preparedDepositCall: {
      to: POOL_ADDRESS,
      data: "0x1234",
      valueWei: "100",
    },
    intentDigest: `sha256:${"4".repeat(64)}`,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    decision: "allow",
    blockers: [],
    approval: { action: "confirm", userConfirmationRequired: true },
    consumedByRequestId: requestId,
  };
  const request: PrivateBalanceFundingRequest = {
    version: 1,
    requestId,
    clientRequestId: `client:funding:${suffix}`,
    decisionId,
    sourceWallet: context.wallet,
    targetWallet: context.wallet,
    route: "shield_from_main",
    targetPrivateBalance: context.pocket,
    amountWei: "100",
    aggregatePrivateBalanceBeforeWei: "100",
    targetPrivateBalanceBeforeWei: "100",
    targetCommitment: plan.targetCommitment,
    preparedDepositCall: plan.preparedDepositCall,
    phase: "executing",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
  return { plan, request };
}

test("unresolved payment and recovery cannot reserve the same private pocket", async () => {
  const context = await readyStore();
  const payment = paymentRecords(context, "one");
  await context.store.update((draft) => {
    draft.plans[payment.plan.decisionId] = payment.plan;
    draft.requests[payment.request.requestId] = payment.request;
  });

  const recovery = recoveryRecords(context, "same-pocket");
  await assert.rejects(
    context.store.update((draft) => {
      draft.recoveryPlans[recovery.plan.decisionId] = recovery.plan;
      draft.recoveryRequests[recovery.request.requestId] = recovery.request;
    }),
    /conflicting unresolved requests/i,
  );

  const funding = mainFundingRecords(context, "same-pocket-target");
  await assert.rejects(
    context.store.update((draft) => {
      draft.privateBalanceFundingPlans[funding.plan.decisionId] = funding.plan;
      draft.privateBalanceFundingRequests[funding.request.requestId] = funding.request;
    }),
    /conflicting unresolved requests/i,
  );
});

test("unresolved regular transfer and main funding cannot reserve the same main", async () => {
  const context = await readyStore();
  const regular = regularRecords(context, "one");
  await context.store.update((draft) => {
    draft.regularPlans[regular.plan.decisionId] = regular.plan;
    draft.regularRequests[regular.request.requestId] = regular.request;
  });

  const funding = mainFundingRecords(context, "same-main");
  await assert.rejects(
    context.store.update((draft) => {
      draft.privateBalanceFundingPlans[funding.plan.decisionId] = funding.plan;
      draft.privateBalanceFundingRequests[funding.request.requestId] = funding.request;
    }),
    /conflicting unresolved requests/i,
  );
});

test("pocket-sourced regular transfer reserves its pocket and exact public account", async () => {
  const context = await readyStore();
  const source = paymentRecords(context, "public-source", "confirmed");
  source.request.publicChangeWei = "89";
  await context.store.update((draft) => {
    draft.plans[source.plan.decisionId] = source.plan;
    draft.requests[source.request.requestId] = source.request;
    const pocket = draft.wallet!.profiles[context.wallet.walletId]!
      .privateBalances[context.pocket.privateBalanceId]!;
    pocket.publicChangeAccounts ??= {};
    pocket.publicChangeAccounts[CHANGE_ADDRESS] = {
      version: 1,
      address: CHANGE_ADDRESS,
      balanceWei: "89",
      sourceRequestId: source.request.requestId,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    };
  });

  const first = pocketRegularRecords(context, "pocket-one");
  await context.store.update((draft) => {
    draft.regularPlans[first.plan.decisionId] = first.plan;
    draft.regularRequests[first.request.requestId] = first.request;
  });
  const second = pocketRegularRecords(context, "pocket-two");
  await assert.rejects(
    context.store.update((draft) => {
      draft.regularPlans[second.plan.decisionId] = second.plan;
      draft.regularRequests[second.request.requestId] = second.request;
    }),
    /conflicting unresolved requests/i,
  );
  await assert.rejects(
    context.store.update((draft) => {
      draft.regularPlans.another_account = {
        ...structuredClone(second.plan),
        decisionId: "another_account",
        sourcePublicAddress: SECOND_RECIPIENT,
      };
    }),
    /not tracked/i,
  );
});

test("terminal phases, durable evidence, and core request bindings are append-only", async () => {
  const context = await readyStore();
  const payment = paymentRecords(context, "terminal", "confirmed");
  payment.request.broadcastStartedAt = CREATED_AT;
  payment.request.transactionHash = `0x${"a".repeat(64)}`;
  payment.request.confirmation = { method: "adapter", checkedAt: UPDATED_AT };
  await context.store.update((draft) => {
    draft.plans[payment.plan.decisionId] = payment.plan;
    draft.requests[payment.request.requestId] = payment.request;
  });

  await assert.rejects(
    context.store.update((draft) => {
      draft.requests[payment.request.requestId]!.phase = "submitted";
    }),
    /terminal phase cannot regress/i,
  );
  await assert.rejects(
    context.store.update((draft) => {
      draft.requests[payment.request.requestId]!.transactionHash = `0x${"b".repeat(64)}`;
    }),
    /transactionHash cannot be removed or changed/i,
  );
  await assert.rejects(
    context.store.update((draft) => {
      delete draft.requests[payment.request.requestId]!.broadcastStartedAt;
    }),
    /broadcastStartedAt cannot be removed or changed/i,
  );
  await assert.rejects(
    context.store.update((draft) => {
      draft.requests[payment.request.requestId]!.privateBalanceRestoredAt = LATER_AT;
    }),
    /only be restored for a failed request/i,
  );
  await assert.rejects(
    context.store.update((draft) => {
      draft.requests[payment.request.requestId]!.clientRequestId = "client:rewritten";
    }),
    /core binding is immutable/i,
  );
  await assert.rejects(
    context.store.update((draft) => {
      draft.plans[payment.plan.decisionId]!.recipient = SECOND_RECIPIENT;
      draft.requests[payment.request.requestId]!.recipient = SECOND_RECIPIENT;
    }),
    /plan core binding is immutable/i,
  );
});

test("funding consumption receipt cannot be removed or rebound", async () => {
  const context = await readyStore();
  const funding = mainFundingRecords(context, "consumed");
  funding.request.phase = "confirmed";
  funding.request.appliedAt = UPDATED_AT;
  funding.request.confirmation = { method: "adapter", checkedAt: UPDATED_AT };
  funding.plan.appliedAt = UPDATED_AT;
  await context.store.update((draft) => {
    draft.privateBalanceFundingPlans[funding.plan.decisionId] = funding.plan;
    draft.privateBalanceFundingRequests[funding.request.requestId] = funding.request;
  });

  await assert.rejects(
    context.store.update((draft) => {
      delete draft.privateBalanceFundingPlans[funding.plan.decisionId]!.consumedByRequestId;
    }),
    /plan reference is invalid|receipt is invalid|consumedByRequestId cannot be removed or changed/i,
  );

  const cancelled = mainFundingRecords(context, "cancelled").plan;
  delete cancelled.consumedByRequestId;
  cancelled.decision = "deny";
  cancelled.blockers.push("USER_CANCELLED");
  cancelled.cancelledAt = CREATED_AT;
  await context.store.update((draft) => {
    draft.privateBalanceFundingPlans[cancelled.decisionId] = cancelled;
  });
  await assert.rejects(
    context.store.update((draft) => {
      delete draft.privateBalanceFundingPlans[cancelled.decisionId]!.cancelledAt;
    }),
    /cancelledAt cannot be removed or changed/i,
  );
});

test("public change records bind to their source request and preserve identity", async () => {
  const context = await readyStore();
  const payment = paymentRecords(context, "change", "confirmed");
  payment.request.publicChangeWei = "89";
  await context.store.update((draft) => {
    draft.plans[payment.plan.decisionId] = payment.plan;
    draft.requests[payment.request.requestId] = payment.request;
    const pocket = draft.wallet!.profiles[context.wallet.walletId]!
      .privateBalances[context.pocket.privateBalanceId]!;
    pocket.publicChangeAccounts ??= {};
    pocket.publicChangeAccounts[CHANGE_ADDRESS] = {
      version: 1,
      address: CHANGE_ADDRESS,
      balanceWei: "89",
      sourceRequestId: payment.request.requestId,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    };
  });

  await assert.rejects(
    context.store.update((draft) => {
      draft.requests[payment.request.requestId]!.publicChangeWei = "90";
    }),
    /publicChangeWei cannot be removed or changed/i,
  );

  await context.store.update((draft) => {
    const account = draft.wallet!.profiles[context.wallet.walletId]!
      .privateBalances[context.pocket.privateBalanceId]!
      .publicChangeAccounts![CHANGE_ADDRESS]!;
    account.balanceWei = "40";
    account.updatedAt = LATER_AT;
  });
  await assert.rejects(
    context.store.update((draft) => {
      const account = draft.wallet!.profiles[context.wallet.walletId]!
        .privateBalances[context.pocket.privateBalanceId]!
        .publicChangeAccounts![CHANGE_ADDRESS]!;
      account.createdAt = UPDATED_AT;
    }),
    /identity is immutable/i,
  );
  await assert.rejects(
    context.store.update((draft) => {
      delete draft.wallet!.profiles[context.wallet.walletId]!
        .privateBalances[context.pocket.privateBalanceId]!
        .publicChangeAccounts![CHANGE_ADDRESS];
    }),
    /no tracked account|cannot be deleted/i,
  );
});

test("public change cannot become spendable before its source is confirmed", async () => {
  const context = await readyStore();
  const payment = paymentRecords(context, "pending-change");
  payment.request.publicChangeWei = "89";
  await assert.rejects(
    context.store.update((draft) => {
      draft.plans[payment.plan.decisionId] = payment.plan;
      draft.requests[payment.request.requestId] = payment.request;
      const pocket = draft.wallet!.profiles[context.wallet.walletId]!
        .privateBalances[context.pocket.privateBalanceId]!;
      pocket.publicChangeAccounts ??= {};
      pocket.publicChangeAccounts[CHANGE_ADDRESS] = {
        version: 1,
        address: CHANGE_ADDRESS,
        balanceWei: "89",
        sourceRequestId: payment.request.requestId,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      };
    }),
    /source request binding is invalid/i,
  );
});

test("legacy balance-delta confirmation values remain readable after restart", async () => {
  const context = await readyStore();
  const payment = paymentRecords(context, "legacy-delta", "confirmed");
  payment.request.confirmation = {
    method: "recipient_balance_delta",
    checkedAt: UPDATED_AT,
  };
  await context.store.update((draft) => {
    draft.plans[payment.plan.decisionId] = payment.plan;
    draft.requests[payment.request.requestId] = payment.request;
  });

  const restarted = new StateStore(join(context.store.path, ".."), "alpha");
  await restarted.initialize();
  assert.equal(
    (await restarted.read()).requests[payment.request.requestId]?.confirmation?.method,
    "recipient_balance_delta",
  );
});
