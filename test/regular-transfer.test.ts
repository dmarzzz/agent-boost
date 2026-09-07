import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ChainClient,
  DelegationPolicy,
  PaymentPlan,
  PaymentRequest,
  PrivateBalanceRecord,
  PrivateBalanceFundingPlan,
  PrivateBalanceFundingRequest,
  RawTransactionBroadcastCheckpoint,
  WalletAdapter,
} from "../src/contracts.js";
import { WalletExecutionError } from "../src/errors.js";
import { PaymentController } from "../src/payment.js";
import { RegularTransferController } from "../src/regular-transfer.js";
import { StateStore } from "../src/state/store.js";

const MAIN = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const CHANGE_A = "0x3333333333333333333333333333333333333333";
const CHANGE_B = "0x4444444444444444444444444444444444444444";
const POCKET_ID = "private_regular_source";
const POCKET_NAME = "travel";
const POCKET_BACKEND = "abpb-regular-source";
const TX_HASH = `0x${"ab".repeat(32)}`;

function rawCheckpoint(input: {
  requestId: string;
  from: string;
  to: string;
  valueWei: string;
  data?: string;
}): RawTransactionBroadcastCheckpoint {
  return {
    version: 1,
    requestId: input.requestId,
    transactionHash: TX_HASH,
    from: input.from.toLowerCase(),
    to: input.to.toLowerCase(),
    valueWei: input.valueWei,
    data: input.data ?? "0x",
    chainId: 11_155_111,
    nonce: "7",
    gas: "21000",
    transactionType: "eip1559",
    journaledAt: new Date(1_000).toISOString(),
  };
}

class RegularWallet implements WalletAdapter {
  calls = 0;
  rawCheckpoint?: RawTransactionBroadcastCheckpoint;
  readonly namedCalls: Array<{
    walletName: string;
    sourceAddress: string;
    recipient: string;
    amountWei: bigint;
  }> = [];
  async ensureWallet(): Promise<void> {}
  async nextFreshAddress(): Promise<string> { return MAIN; }
  async prewarmPrivacy(): Promise<void> {}
  async shieldWei(): Promise<Record<string, never>> { return {}; }
  async getPrivateBalanceWei(): Promise<bigint> { return 100_000_000_000_000_000n; }
  async executePrivatePayment(input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<Record<string, never>> {
    assert.match(input.broadcastRequestId, /^req_/u);
    return {};
  }
  async executeRegularTransfer(input: {
    sourceAddress: string;
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash: string; confirmed: boolean }> {
    assert.equal(input.sourceAddress, MAIN);
    await input.beforeBroadcast();
    this.calls += 1;
    return { transactionHash: TX_HASH, confirmed: true };
  }
  async executeRegularTransferFromWallet(walletName: string, input: {
    sourceAddress: string;
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash: string; confirmed: boolean }> {
    await input.beforeBroadcast();
    this.namedCalls.push({
      walletName,
      sourceAddress: input.sourceAddress,
      recipient: input.recipient,
      amountWei: input.amountWei,
    });
    return { transactionHash: TX_HASH, confirmed: true };
  }
  async getRawTransactionBroadcastCheckpoint(
    requestId: string,
  ): Promise<RawTransactionBroadcastCheckpoint | undefined> {
    return this.rawCheckpoint?.requestId === requestId
      ? this.rawCheckpoint
      : undefined;
  }
}

class RegularChain implements ChainClient {
  readonly balances = new Map<string, bigint>([
    [MAIN, 70_000_000_000_000_000_000n],
    [RECIPIENT, 0n],
  ]);
  readonly unavailableBalances = new Set<string>();
  getTransactionReceiptStatus?: (
    transactionHash: string,
  ) => Promise<"pending" | "success" | "reverted">;
  async assertSepolia(): Promise<void> {}
  async getBalanceWei(address: string): Promise<bigint> {
    if (this.unavailableBalances.has(address.toLowerCase())) {
      throw new Error("balance RPC unavailable");
    }
    return this.balances.get(address) ?? 0n;
  }
}

async function readyStore(maxPayments = 10): Promise<StateStore> {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-regular-transfer-"));
  const store = new StateStore(root);
  await store.initialize();
  const now = new Date(0).toISOString();
  await store.update((draft) => {
    draft.onboarding = {
      version: 1,
      setupId: "setup-ready",
      revision: 1,
      phase: "private_ready",
      createdAt: now,
      updatedAt: now,
      address: MAIN,
      publicBalanceWei: "70000000000000000000",
      privateBalanceWei: "100000000000000000",
      requiredFundingWei: "200000000000000000",
      shieldAmountWei: "100000000000000000",
      delegation: {
        mode: "testnet_delegated",
        chainId: 11_155_111,
        perPaymentLimitWei: "100000000000000000000",
        lifetimeLimitWei: (
          100_000_000_000_000_000_000n * BigInt(maxPayments)
        ).toString(),
        spentWei: "0",
        maxPayments,
        expiresAt: new Date(86_400_000).toISOString(),
        enabled: true,
      },
    };
  });
  return store;
}

interface PocketFixture {
  store: StateStore;
  privateBalance: PrivateBalanceRecord;
  baselineSpentWei: bigint;
}

async function readyPocketStore(options: {
  accounts: Array<{ address: string; balanceWei: bigint }>;
  parentPolicy?: Partial<DelegationPolicy>;
  pocketPolicy?: Partial<DelegationPolicy>;
  pocketStatus?: PrivateBalanceRecord["status"];
}): Promise<PocketFixture> {
  const store = await readyStore();
  const initial = await store.read();
  const profile = initial.wallet!.profiles[initial.wallet!.activeWalletId]!;
  const authorization = {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
    authorizationId: profile.authorizationId!,
  };
  const now = new Date(0).toISOString();
  const baselineSpentWei = BigInt(options.accounts.length);
  const basePolicy: DelegationPolicy = {
    ...initial.onboarding!.delegation,
    spentWei: baselineSpentWei.toString(),
  };
  const pocketPolicy: DelegationPolicy = {
    ...basePolicy,
    ...options.pocketPolicy,
  };
  if ((options.pocketPolicy?.perPaymentLimitWei !== undefined ||
      options.pocketPolicy?.maxPayments !== undefined) &&
    options.pocketPolicy?.lifetimeLimitWei === undefined) {
    pocketPolicy.lifetimeLimitWei = (
      BigInt(pocketPolicy.perPaymentLimitWei) * BigInt(pocketPolicy.maxPayments)
    ).toString();
  }
  const privateBalance: PrivateBalanceRecord = {
    version: 1,
    privateBalanceId: POCKET_ID,
    name: POCKET_NAME,
    backendWalletName: POCKET_BACKEND,
    status: options.pocketStatus ?? "available",
    balanceWei: "0",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    delegation: pocketPolicy,
    publicChangeAccounts: {},
  };
  const plans: PaymentPlan[] = [];
  const requests: PaymentRequest[] = [];
  for (const [index, account] of options.accounts.entries()) {
    const suffix = `public-change-${index}`;
    const decisionId = `pay-plan-${suffix}`;
    const requestId = `pay-request-${suffix}`;
    const plan: PaymentPlan = {
      version: 1,
      decisionId,
      recipient: RECIPIENT,
      amountWei: "1",
      authorization,
      privateBalanceId: privateBalance.privateBalanceId,
      privateBalanceRevision: privateBalance.revision,
      privateBalanceDebitWei: "100000000000000000",
      intentDigest: `sha256:${String(index + 1).repeat(64)}`,
      createdAt: now,
      expiresAt: new Date(86_400_000).toISOString(),
      decision: "allow",
      blockers: [],
      approval: { action: "confirm", userConfirmationRequired: true },
    };
    const request: PaymentRequest = {
      version: 1,
      requestId,
      clientRequestId: `client:${suffix}`,
      decisionId,
      recipient: plan.recipient,
      amountWei: plan.amountWei,
      authorization,
      privateBalanceId: privateBalance.privateBalanceId,
      privateBalanceRevision: privateBalance.revision,
      privateBalanceDebitWei: "100000000000000000",
      privateBalanceDebitedAt: now,
      publicChangeWei: account.balanceWei.toString(),
      phase: "confirmed",
      createdAt: now,
      updatedAt: now,
    };
    privateBalance.publicChangeAccounts![account.address.toLowerCase()] = {
      version: 1,
      address: account.address,
      balanceWei: account.balanceWei.toString(),
      sourceRequestId: requestId,
      createdAt: now,
      updatedAt: now,
    };
    plans.push(plan);
    requests.push(request);
  }
  await store.update((draft) => {
    const parentPolicy: DelegationPolicy = {
      ...draft.onboarding!.delegation,
      spentWei: baselineSpentWei.toString(),
      ...options.parentPolicy,
    };
    if ((options.parentPolicy?.perPaymentLimitWei !== undefined ||
        options.parentPolicy?.maxPayments !== undefined) &&
      options.parentPolicy?.lifetimeLimitWei === undefined) {
      parentPolicy.lifetimeLimitWei = (
        BigInt(parentPolicy.perPaymentLimitWei) * BigInt(parentPolicy.maxPayments)
      ).toString();
    }
    draft.onboarding!.delegation = parentPolicy;
    const active = draft.wallet!.profiles[draft.wallet!.activeWalletId]!;
    active.privateBalances[privateBalance.privateBalanceId] = privateBalance;
    for (const plan of plans) draft.plans[plan.decisionId] = plan;
    for (const request of requests) draft.requests[request.requestId] = request;
  });
  const saved = await store.read();
  const savedProfile = saved.wallet!.profiles[saved.wallet!.activeWalletId]!;
  return {
    store,
    privateBalance: savedProfile.privateBalances[privateBalance.privateBalanceId]!,
    baselineSpentWei,
  };
}

test("regular transfer is distinct, confirmation-gated, and idempotent", async () => {
  const store = await readyStore();
  const wallet = new RegularWallet();
  const chain = new RegularChain();
  const controller = new RegularTransferController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: RECIPIENT,
    amountWei: "66000000000000000000",
  });
  assert.equal(plan.decision, "allow");
  assert.equal(plan.gasReserveWei, "1000000000000000");
  assert.deepEqual(plan.approval, {
    action: "confirm",
    userConfirmationRequired: true,
  });

  await assert.rejects(controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "regular-message-1",
    userConfirmed: false,
  }), /confirm/);

  const first = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "regular-message-1",
    userConfirmed: true,
  });
  const second = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "regular-message-1",
    userConfirmed: true,
  });
  assert.equal(first.phase, "confirmed");
  assert.equal(second.requestId, first.requestId);
  assert.equal(wallet.calls, 1);
  const state = await store.read();
  assert.equal(Object.keys(state.requests).length, 0);
  assert.equal(Object.keys(state.regularRequests).length, 1);
  assert.equal(state.onboarding?.delegation.spentWei, "66000000000000000000");
});

test("regular transfer reserves gas and never falls back to private payment", async () => {
  const store = await readyStore();
  const wallet = new RegularWallet();
  let privateCalls = 0;
  wallet.executePrivatePayment = async () => {
    privateCalls += 1;
    return {};
  };
  const controller = new RegularTransferController({
    store,
    wallet,
    chain: new RegularChain(),
    clock: { now: () => new Date(1_000) },
  });
  const denied = await controller.plan({
    recipient: RECIPIENT,
    amountWei: "70000000000000000000",
  });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.blockers.includes("INSUFFICIENT_MAIN_BALANCE_WITH_GAS_RESERVE"));
  await assert.rejects(controller.execute({
    decisionId: denied.decisionId,
    clientRequestId: "regular-message-2",
    userConfirmed: true,
  }), /DENIED/);
  assert.equal(wallet.calls, 0);
  assert.equal(privateCalls, 0);
});

test("regular and private transfers share the delegated payment count", async () => {
  const store = await readyStore(1);
  const wallet = new RegularWallet();
  const chain = new RegularChain();
  const regular = new RegularTransferController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await regular.plan({ recipient: RECIPIENT, amountWei: "10000000000000000" });
  chain.balances.set(RECIPIENT, 10_000_000_000_000_000n);
  await regular.execute({
    decisionId: plan.decisionId,
    clientRequestId: "regular-message-3",
    userConfirmed: true,
  });

  const privateController = new PaymentController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const privatePlan = await privateController.plan({
    recipient: "0x3333333333333333333333333333333333333333",
    amountWei: "1",
  });
  assert.equal(privatePlan.decision, "deny");
  assert.ok(privatePlan.blockers.includes("PAYMENT_COUNT_LIMIT"));
});

test("wallet switching cannot reset a regular-transfer authorization quota", async () => {
  const store = await readyStore(1);
  const originalProfile = await store.activeWalletProfile();
  const originalAuthorizationId = originalProfile.authorizationId;
  const wallet = new RegularWallet();
  const chain = new RegularChain();
  const firstController = new RegularTransferController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const firstPlan = await firstController.plan({
    recipient: RECIPIENT,
    amountWei: "10000000000000000",
  });
  assert.equal(firstPlan.decision, "allow");
  const first = await firstController.execute({
    decisionId: firstPlan.decisionId,
    clientRequestId: "regular-before-wallet-switch",
    userConfirmed: true,
  });
  assert.equal(first.phase, "confirmed");

  const otherProfile = await store.registerManagedWallet("wallet-b", "adopted");
  await store.activateWalletProfile(otherProfile.walletId);
  const reloaded = await store.activateWalletProfile(originalProfile.walletId);
  assert.equal(reloaded.profile.selectionEpoch, originalProfile.selectionEpoch + 1);
  assert.equal(reloaded.profile.authorizationId, originalAuthorizationId);

  const reloadedController = new RegularTransferController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(2_000) },
  });
  const exhausted = await reloadedController.plan({
    recipient: CHANGE_A,
    amountWei: "1",
  });
  assert.equal(exhausted.decision, "deny");
  assert.ok(exhausted.blockers.includes("PAYMENT_COUNT_LIMIT"));
  assert.equal(wallet.calls, 1);
});

test("a pending main transfer blocks another main-transfer preview", async () => {
  const store = await readyStore();
  const wallet = new RegularWallet();
  wallet.executeRegularTransfer = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    return { transactionHash: TX_HASH, confirmed: false };
  };
  const chain = new RegularChain();
  chain.getTransactionReceiptStatus = async () => "pending";
  const controller = new RegularTransferController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const firstPlan = await controller.plan({
    recipient: RECIPIENT,
    amountWei: "10000000000000000",
  });
  const submitted = await controller.execute({
    decisionId: firstPlan.decisionId,
    clientRequestId: "first-unresolved-main-transfer",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");

  const blocked = await controller.plan({
    recipient: CHANGE_A,
    amountWei: "1",
  });
  assert.equal(blocked.decision, "deny");
  assert.ok(blocked.blockers.includes("MAIN_ACCOUNT_OPERATION_UNRESOLVED"));
  assert.equal(wallet.calls, 1);
});

test("a pending main-to-private deposit blocks a main-transfer preview", async () => {
  const fixture = await readyPocketStore({ accounts: [] });
  const state = await fixture.store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  const sourceWallet = {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
  };
  const targetPrivateBalance = {
    ...sourceWallet,
    privateBalanceId: fixture.privateBalance.privateBalanceId,
    privateBalanceName: fixture.privateBalance.name,
    backendWalletName: fixture.privateBalance.backendWalletName,
    privateBalanceRevision: fixture.privateBalance.revision,
  };
  const createdAt = new Date(0).toISOString();
  const decisionId = "pbfd_unresolved_main_source";
  const requestId = "pbfr_unresolved_main_source";
  const preparedDepositCall = {
    to: CHANGE_B,
    data: "0x12",
    valueWei: "100000000000000000",
  };
  const fundingPlan: PrivateBalanceFundingPlan = {
    version: 1,
    decisionId,
    sourceWallet,
    targetWallet: sourceWallet,
    route: "shield_from_main",
    targetPrivateBalance,
    amountWei: preparedDepositCall.valueWei,
    mainBalanceSnapshotWei: state.onboarding!.publicBalanceWei,
    gasReserveWei: "1000000000000000",
    shieldDenominationWei: preparedDepositCall.valueWei,
    aggregatePrivateBalanceSnapshotWei: "0",
    targetPrivateBalanceSnapshotWei: "0",
    sourceExecutorAddress: MAIN,
    targetCommitment: "commitment_unresolved_main_source",
    preparedDepositCall,
    intentDigest: `sha256:${"12".repeat(32)}`,
    createdAt,
    expiresAt: new Date(86_400_000).toISOString(),
    decision: "allow",
    blockers: [],
    approval: { action: "confirm", userConfirmationRequired: true },
    consumedByRequestId: requestId,
  };
  const fundingRequest: PrivateBalanceFundingRequest = {
    version: 1,
    requestId,
    clientRequestId: "unresolved-main-funding-request",
    decisionId,
    sourceWallet,
    targetWallet: sourceWallet,
    route: "shield_from_main",
    targetPrivateBalance,
    amountWei: fundingPlan.amountWei,
    aggregatePrivateBalanceBeforeWei: "0",
    targetPrivateBalanceBeforeWei: "0",
    targetCommitment: fundingPlan.targetCommitment,
    preparedDepositCall,
    phase: "submitted",
    createdAt,
    updatedAt: createdAt,
    broadcastStartedAt: createdAt,
    transactionHash: TX_HASH,
  };
  await fixture.store.update((draft) => {
    draft.privateBalanceFundingPlans[decisionId] = fundingPlan;
    draft.privateBalanceFundingRequests[requestId] = fundingRequest;
  });

  const wallet = new RegularWallet();
  const blocked = await new RegularTransferController({
    store: fixture.store,
    wallet,
    chain: new RegularChain(),
    clock: { now: () => new Date(1_000) },
  }).plan({ recipient: RECIPIENT, amountWei: "1" });
  assert.equal(blocked.decision, "deny");
  assert.ok(blocked.blockers.includes("MAIN_ACCOUNT_OPERATION_UNRESOLVED"));
  assert.equal(wallet.calls, 0);
});

test("regular transfer local approval modes allow or deny without weakening limits", async () => {
  const allowStore = await readyStore();
  const allowWallet = new RegularWallet();
  const allowController = new RegularTransferController({
    store: allowStore,
    wallet: allowWallet,
    chain: new RegularChain(),
    clock: { now: () => new Date(1_000) },
    paymentApproval: "allow",
  });
  const allowed = await allowController.plan({
    recipient: RECIPIENT,
    amountWei: "10000000000000000",
  });
  assert.deepEqual(allowed.approval, {
    action: "allow",
    userConfirmationRequired: false,
  });
  const request = await allowController.execute({
    decisionId: allowed.decisionId,
    clientRequestId: "automatic-regular-transfer",
    userConfirmed: false,
  });
  assert.equal(request.phase, "confirmed");
  assert.equal(allowWallet.calls, 1);

  const denyWallet = new RegularWallet();
  const denyController = new RegularTransferController({
    store: await readyStore(),
    wallet: denyWallet,
    chain: new RegularChain(),
    clock: { now: () => new Date(1_000) },
    paymentApproval: "deny",
  });
  const denied = await denyController.plan({
    recipient: RECIPIENT,
    amountWei: "10000000000000000",
  });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.blockers.includes("SECURITY_POLICY_DENIED"));
  assert.equal(denyWallet.calls, 0);
});

test("recipient balance movement alone does not confirm a regular transfer", async () => {
  const store = await readyStore();
  const wallet = new RegularWallet();
  const chain = new RegularChain();
  wallet.executeRegularTransfer = async ({ amountWei, beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    chain.balances.set(RECIPIENT, (chain.balances.get(RECIPIENT) ?? 0n) + amountWei);
    return { transactionHash: `0x${"cd".repeat(32)}`, confirmed: false };
  };
  const controller = new RegularTransferController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: RECIPIENT,
    amountWei: "20000000000000000",
  });
  const request = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "regular-balance-delta",
    userConfirmed: true,
  });
  assert.equal(request.phase, "submitted");
  const deltaOnly = await controller.getRequest(request.requestId);
  assert.equal(deltaOnly.phase, "submitted");
  assert.equal(deltaOnly.confirmation, undefined);
  assert.equal(wallet.calls, 1);
});

test("regular transfer reconciles a pending hash without rebroadcasting", async () => {
  const store = await readyStore();
  const wallet = new RegularWallet();
  wallet.executeRegularTransfer = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    return { transactionHash: TX_HASH, confirmed: false };
  };
  let receipt: "pending" | "success" | "reverted" = "pending";
  const chain = new RegularChain();
  chain.getTransactionReceiptStatus = async () => receipt;
  const controller = new RegularTransferController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: RECIPIENT,
    amountWei: "20000000000000000",
  });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "regular-receipt-reconciliation",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");

  receipt = "success";
  const confirmed = await controller.getRequest(submitted.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.confirmation?.method, "transaction_receipt");
  assert.equal(wallet.calls, 1);
});

test("restart hydrates the exact journaled main transfer hash without rebroadcasting", async () => {
  const store = await readyStore();
  const wallet = new RegularWallet();
  wallet.executeRegularTransfer = async (input) => {
    await input.beforeBroadcast();
    wallet.calls += 1;
    wallet.rawCheckpoint = rawCheckpoint({
      requestId: input.broadcastRequestId,
      from: MAIN,
      to: input.recipient,
      valueWei: input.amountWei.toString(),
    });
    throw new Error("provider response vanished after network handoff");
  };
  const chain = new RegularChain();
  chain.getTransactionReceiptStatus = async (transactionHash) => {
    assert.equal(transactionHash, TX_HASH);
    return "success";
  };
  const initial = new RegularTransferController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await initial.plan({ recipient: RECIPIENT, amountWei: "3" });
  const unresolved = await initial.execute({
    decisionId: plan.decisionId,
    clientRequestId: "regular-journal-crash-main",
    userConfirmed: true,
  });
  assert.equal(unresolved.phase, "indeterminate");
  assert.equal(unresolved.transactionHash, undefined);

  const restarted = new RegularTransferController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(2_000) },
  });
  await restarted.recoverInterruptedRequests();
  const confirmed = await restarted.getRequest(unresolved.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.transactionHash, TX_HASH);
  assert.equal(confirmed.confirmation?.method, "transaction_receipt");
  assert.equal(wallet.calls, 1);
});

test("a reverted regular transfer restores policy authority exactly once", async () => {
  const store = await readyStore(1);
  const wallet = new RegularWallet();
  wallet.executeRegularTransfer = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    return { transactionHash: TX_HASH, confirmed: false };
  };
  let receipt: "pending" | "success" | "reverted" = "pending";
  const chain = new RegularChain();
  chain.getTransactionReceiptStatus = async () => receipt;
  const controller = new RegularTransferController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ recipient: RECIPIENT, amountWei: "1" });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "regular-reverted-reconciliation",
    userConfirmed: true,
  });
  receipt = "reverted";
  const failed = await controller.getRequest(submitted.requestId);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error?.code, "TRANSACTION_REVERTED");
  assert.ok(failed.policySpendRestoredAt);
  const restoredAt = failed.policySpendRestoredAt;
  const repeated = await controller.getRequest(submitted.requestId);
  assert.equal(repeated.policySpendRestoredAt, restoredAt);
  assert.equal(wallet.calls, 1);
  assert.equal((await store.read()).onboarding?.delegation.spentWei, "0");

  const later = await controller.plan({
    recipient: "0x3333333333333333333333333333333333333333",
    amountWei: "1",
  });
  assert.equal(later.decision, "allow");
  assert.doesNotMatch(later.blockers.join(" "), /PAYMENT_COUNT_LIMIT/u);
});

test("restart fails fresh v3 regular work without a broadcast checkpoint", async () => {
  const store = await readyStore(1);
  const wallet = new RegularWallet();
  const chain = new RegularChain();
  const initial = new RegularTransferController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await initial.plan({ recipient: RECIPIENT, amountWei: "1" });
  await store.update((draft) => {
    draft.onboarding!.delegation.spentWei = plan.amountWei;
    draft.onboarding!.revision += 1;
    draft.onboarding!.updatedAt = new Date(1_000).toISOString();
    draft.regularRequests.rreq_interrupted = {
      version: 1,
      requestId: "rreq_interrupted",
      clientRequestId: "hermes:rwd_interrupted",
      decisionId: plan.decisionId,
      recipient: RECIPIENT,
      amountWei: plan.amountWei,
      gasReserveWei: plan.gasReserveWei,
      authorization: plan.authorization,
      policySpendDebitedAt: new Date(1_000).toISOString(),
      phase: "executing",
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(1_000).toISOString(),
    };
  });
  const restarted = new RegularTransferController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(2_000) },
  });
  await restarted.recoverInterruptedRequests();

  const request = await restarted.getRequest("rreq_interrupted");
  assert.equal(request.phase, "failed");
  assert.equal(request.error?.code, "EXECUTION_INTERRUPTED_BEFORE_BROADCAST");
  assert.equal(wallet.calls, 0);
  const later = await restarted.plan({
    recipient: "0x3333333333333333333333333333333333333333",
    amountWei: "1",
  });
  assert.equal(later.decision, "allow");
  assert.doesNotMatch(later.blockers.join(" "), /PAYMENT_COUNT_LIMIT/u);
});

test("an adapter error leaves the regular transfer indeterminate and idempotent", async () => {
  const store = await readyStore();
  const wallet = new RegularWallet();
  wallet.executeRegularTransfer = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    throw new Error("transport disappeared after possible broadcast");
  };
  const controller = new RegularTransferController({
    store,
    wallet,
    chain: new RegularChain(),
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ recipient: RECIPIENT, amountWei: "1" });
  const first = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "regular-adapter-error",
    userConfirmed: true,
  });
  const second = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "regular-adapter-error",
    userConfirmed: true,
  });
  assert.equal(first.phase, "indeterminate");
  assert.equal(first.error?.code, "REGULAR_TRANSFER_UNRESOLVED");
  assert.equal(second.requestId, first.requestId);
  assert.equal(wallet.calls, 1);
});

test("regular execution rechecks chain, expiry, live balance, and the kill switch", async () => {
  let nowMs = 1_000;
  const scenarios = [
    {
      name: "wrong chain",
      mutate: async (_store: StateStore, _chain: RegularChain) => {},
      configure: (chain: RegularChain) => {
        chain.assertSepolia = async () => {
          throw new Error("CHAIN_NOT_SEPOLIA");
        };
      },
      expected: /CHAIN_NOT_SEPOLIA/,
    },
    {
      name: "expired delegation",
      mutate: async (store: StateStore, _chain: RegularChain) => {
        await store.update((draft) => {
          if (draft.onboarding) {
            draft.onboarding.delegation.expiresAt = new Date(1_500).toISOString();
          }
        });
        nowMs = 2_000;
      },
      configure: (_chain: RegularChain) => {},
      expected: /DELEGATION_EXPIRED/,
    },
    {
      name: "expired decision",
      mutate: async (_store: StateStore, _chain: RegularChain) => {
        nowMs = 400_000;
      },
      configure: (_chain: RegularChain) => {},
      expected: /REGULAR_TRANSFER_DECISION_EXPIRED/,
    },
    {
      name: "insufficient live main balance",
      mutate: async (_store: StateStore, chain: RegularChain) => {
        chain.balances.set(MAIN, 1n);
      },
      configure: (_chain: RegularChain) => {},
      expected: /INSUFFICIENT_MAIN_BALANCE_WITH_GAS_RESERVE/,
    },
  ];

  for (const scenario of scenarios) {
    const store = await readyStore();
    const wallet = new RegularWallet();
    const chain = new RegularChain();
    nowMs = 1_000;
    const controller = new RegularTransferController({
      store,
      wallet,
      chain,
      clock: { now: () => new Date(nowMs) },
    });
    const plan = await controller.plan({ recipient: RECIPIENT, amountWei: "1" });
    assert.equal(plan.decision, "allow", scenario.name);
    scenario.configure(chain);
    await scenario.mutate(store, chain);
    await assert.rejects(controller.execute({
      decisionId: plan.decisionId,
      clientRequestId: `regular-recheck-${scenario.name.replaceAll(" ", "-")}`,
      userConfirmed: true,
    }), scenario.expected, scenario.name);
    assert.equal(wallet.calls, 0, scenario.name);
    assert.equal(Object.keys((await store.read()).regularRequests).length, 0, scenario.name);
  }

  const disabledStore = await readyStore();
  const disabledWallet = new RegularWallet();
  const enabled = new RegularTransferController({
    store: disabledStore,
    wallet: disabledWallet,
    chain: new RegularChain(),
    clock: { now: () => new Date(1_000) },
  });
  const staleAllow = await enabled.plan({ recipient: RECIPIENT, amountWei: "1" });
  const disabled = new RegularTransferController({
    store: disabledStore,
    wallet: disabledWallet,
    chain: new RegularChain(),
    executeEnabled: false,
    clock: { now: () => new Date(1_000) },
  });
  const denied = await disabled.plan({ recipient: RECIPIENT, amountWei: "1" });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.blockers.includes("EXECUTION_DISABLED"));
  await assert.rejects(disabled.execute({
    decisionId: staleAllow.decisionId,
    clientRequestId: "regular-disabled-stale-allow",
    userConfirmed: true,
  }), /EXECUTION_DISABLED/);
  assert.equal(disabledWallet.calls, 0);
});

test("pocket public change binds the smallest sufficient account and sends to its parent main", async () => {
  const amountWei = 2_000_000_000_000_000n;
  const fixture = await readyPocketStore({
    accounts: [
      { address: CHANGE_A, balanceWei: 6_000_000_000_000_000n },
      { address: CHANGE_B, balanceWei: 4_000_000_000_000_000n },
    ],
  });
  const wallet = new RegularWallet();
  const chain = new RegularChain();
  chain.balances.set(CHANGE_A, 6_000_000_000_000_000n);
  chain.balances.set(CHANGE_B, 4_000_000_000_000_000n);
  const controller = new RegularTransferController({
    store: fixture.store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });

  const plan = await controller.plan({
    recipient: MAIN,
    amountWei: amountWei.toString(),
    sourcePrivateBalanceId: fixture.privateBalance.privateBalanceId,
  });
  assert.equal(plan.decision, "allow");
  assert.equal(plan.sourcePrivateBalance?.privateBalanceId, POCKET_ID);
  assert.equal(plan.sourcePrivateBalance?.privateBalanceName, POCKET_NAME);
  assert.equal(plan.sourcePrivateBalance?.backendWalletName, POCKET_BACKEND);
  assert.equal(plan.sourcePublicAddress, CHANGE_B);
  assert.equal(plan.mainBalanceSnapshotWei, "4000000000000000");

  const request = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "pocket-regular-to-parent-main",
    userConfirmed: true,
  });
  assert.equal(request.phase, "confirmed");
  assert.equal(wallet.calls, 0);
  assert.deepEqual(wallet.namedCalls, [{
    walletName: POCKET_BACKEND,
    sourceAddress: CHANGE_B,
    recipient: MAIN,
    amountWei,
  }]);
  assert.equal(request.sourcePrivateBalance?.privateBalanceId, POCKET_ID);
  assert.equal(request.sourcePublicAddress, CHANGE_B);
  assert.equal(request.sourcePublicBalanceBeforeWei, "4000000000000000");

  const state = await fixture.store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  assert.equal(
    state.onboarding!.delegation.spentWei,
    (fixture.baselineSpentWei + amountWei).toString(),
  );
  assert.equal(
    profile.privateBalances[POCKET_ID]!.delegation.spentWei,
    (fixture.baselineSpentWei + amountWei).toString(),
  );
});

test("pocket public change rejects a self-send to the exact selected source", async () => {
  const fixture = await readyPocketStore({
    accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
  });
  const wallet = new RegularWallet();
  const chain = new RegularChain();
  chain.balances.set(CHANGE_A, 5_000_000_000_000_000n);
  const controller = new RegularTransferController({
    store: fixture.store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });

  const plan = await controller.plan({
    recipient: CHANGE_A,
    amountWei: "1000000000000000",
    sourcePrivateBalanceId: POCKET_ID,
  });
  assert.equal(plan.decision, "deny");
  assert.ok(plan.blockers.includes("REGULAR_TRANSFER_SELF_SEND_BLOCKED"));
  await assert.rejects(controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "pocket-public-change-self-send",
    userConfirmed: true,
  }), /DENIED/u);
  assert.equal(wallet.calls, 0);
  assert.equal(wallet.namedCalls.length, 0);
});

test("pocket public change reports fragmented, insufficient, unavailable, and missing-adapter blockers precisely", async () => {
  const amountWei = "2000000000000000";
  const scenarios: Array<{
    name: string;
    accounts: Array<{ address: string; balanceWei: bigint }>;
    unavailable?: string;
    removeAdapter?: boolean;
    expected: string;
    unexpected?: string;
  }> = [
    {
      name: "fragmented",
      accounts: [
        { address: CHANGE_A, balanceWei: 1_500_000_000_000_000n },
        { address: CHANGE_B, balanceWei: 1_500_000_000_000_000n },
      ],
      expected: "PRIVATE_BALANCE_PUBLIC_CHANGE_FRAGMENTED",
      unexpected: "INSUFFICIENT_PRIVATE_BALANCE_PUBLIC_CHANGE_WITH_GAS_RESERVE",
    },
    {
      name: "insufficient",
      accounts: [{ address: CHANGE_A, balanceWei: 2_000_000_000_000_000n }],
      expected: "INSUFFICIENT_PRIVATE_BALANCE_PUBLIC_CHANGE_WITH_GAS_RESERVE",
    },
    {
      name: "unavailable",
      accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
      unavailable: CHANGE_A,
      expected: "PRIVATE_BALANCE_PUBLIC_CHANGE_UNAVAILABLE",
      unexpected: "INSUFFICIENT_PRIVATE_BALANCE_PUBLIC_CHANGE_WITH_GAS_RESERVE",
    },
    {
      name: "missing named adapter",
      accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
      removeAdapter: true,
      expected: "PRIVATE_BALANCE_PUBLIC_CHANGE_TRANSFER_UNAVAILABLE",
    },
  ];

  for (const scenario of scenarios) {
    const fixture = await readyPocketStore({ accounts: scenario.accounts });
    const wallet = new RegularWallet();
    if (scenario.removeAdapter) {
      Object.defineProperty(wallet, "executeRegularTransferFromWallet", {
        value: undefined,
      });
    }
    const chain = new RegularChain();
    for (const account of scenario.accounts) {
      chain.balances.set(account.address, account.balanceWei);
    }
    if (scenario.unavailable) {
      chain.unavailableBalances.add(scenario.unavailable.toLowerCase());
    }
    const controller = new RegularTransferController({
      store: fixture.store,
      wallet,
      chain,
      clock: { now: () => new Date(1_000) },
    });
    const plan = await controller.plan({
      recipient: MAIN,
      amountWei,
      sourcePrivateBalanceId: POCKET_ID,
    });
    assert.equal(plan.decision, "deny", scenario.name);
    assert.ok(plan.blockers.includes(scenario.expected), scenario.name);
    if (scenario.unexpected) {
      assert.ok(!plan.blockers.includes(scenario.unexpected), scenario.name);
    }
    assert.equal(wallet.namedCalls.length, 0, scenario.name);
  }
});

test("pocket public change rejects execution if the selected account balance changed after preview", async () => {
  const fixture = await readyPocketStore({
    accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
  });
  const wallet = new RegularWallet();
  const chain = new RegularChain();
  chain.balances.set(CHANGE_A, 5_000_000_000_000_000n);
  const controller = new RegularTransferController({
    store: fixture.store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: MAIN,
    amountWei: "1000000000000000",
    sourcePrivateBalanceId: POCKET_ID,
  });
  assert.equal(plan.decision, "allow");
  chain.balances.set(CHANGE_A, 4_999_999_999_999_999n);

  await assert.rejects(controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "pocket-public-change-balance-drift",
    userConfirmed: true,
  }), /PRIVATE_BALANCE_PUBLIC_CHANGE_BALANCE_CHANGED/u);
  assert.equal(wallet.namedCalls.length, 0);
  assert.equal(Object.keys((await fixture.store.read()).regularRequests).length, 0);
});

test("pocket public change rechecks its immutable pocket binding before execution", async () => {
  const fixture = await readyPocketStore({
    accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
  });
  const wallet = new RegularWallet();
  const chain = new RegularChain();
  chain.balances.set(CHANGE_A, 5_000_000_000_000_000n);
  const controller = new RegularTransferController({
    store: fixture.store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: MAIN,
    amountWei: "1000000000000000",
    sourcePrivateBalanceId: POCKET_ID,
  });
  assert.equal(plan.decision, "allow");
  await fixture.store.update((draft) => {
    const profile = draft.wallet!.profiles[draft.wallet!.activeWalletId]!;
    const pocket = profile.privateBalances[POCKET_ID]!;
    pocket.delegation.enabled = false;
    pocket.revision += 1;
    pocket.updatedAt = new Date(2_000).toISOString();
  });

  await assert.rejects(controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "pocket-public-change-stale-binding",
    userConfirmed: true,
  }), /PRIVATE_BALANCE_PUBLIC_CHANGE_BINDING_CHANGED/u);
  assert.equal(wallet.namedCalls.length, 0);
});

test("pocket public change enforces both aggregate and pocket policy", async () => {
  const amountWei = "2000000000000000";
  const pocketDenied = await readyPocketStore({
    accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
    pocketPolicy: { perPaymentLimitWei: "1999999999999999" },
  });
  const pocketChain = new RegularChain();
  pocketChain.balances.set(CHANGE_A, 5_000_000_000_000_000n);
  const pocketPlan = await new RegularTransferController({
    store: pocketDenied.store,
    wallet: new RegularWallet(),
    chain: pocketChain,
    clock: { now: () => new Date(1_000) },
  }).plan({ recipient: MAIN, amountWei, sourcePrivateBalanceId: POCKET_ID });
  assert.equal(pocketPlan.decision, "deny");
  assert.ok(pocketPlan.blockers.includes("PRIVATE_BALANCE_PER_PAYMENT_LIMIT"));
  assert.ok(!pocketPlan.blockers.includes("PER_PAYMENT_LIMIT"));

  const bothDenied = await readyPocketStore({
    accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
    parentPolicy: { perPaymentLimitWei: "1999999999999999" },
    pocketPolicy: { perPaymentLimitWei: "1999999999999999" },
  });
  const aggregateChain = new RegularChain();
  aggregateChain.balances.set(CHANGE_A, 5_000_000_000_000_000n);
  const bothPlan = await new RegularTransferController({
    store: bothDenied.store,
    wallet: new RegularWallet(),
    chain: aggregateChain,
    clock: { now: () => new Date(1_000) },
  }).plan({ recipient: MAIN, amountWei, sourcePrivateBalanceId: POCKET_ID });
  assert.equal(bothPlan.decision, "deny");
  assert.ok(bothPlan.blockers.includes("PER_PAYMENT_LIMIT"));
  assert.ok(bothPlan.blockers.includes("PRIVATE_BALANCE_PER_PAYMENT_LIMIT"));
});

test("a reverted pocket-public-change transfer restores both policy debits exactly once", async () => {
  const amountWei = 2_000_000_000_000_000n;
  const fixture = await readyPocketStore({
    accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
  });
  const wallet = new RegularWallet();
  wallet.executeRegularTransferFromWallet = async (walletName, input) => {
    await input.beforeBroadcast();
    wallet.namedCalls.push({
      walletName,
      sourceAddress: input.sourceAddress,
      recipient: input.recipient,
      amountWei: input.amountWei,
    });
    return { transactionHash: TX_HASH, confirmed: false };
  };
  let receipt: "pending" | "success" | "reverted" = "pending";
  const chain = new RegularChain();
  chain.balances.set(CHANGE_A, 5_000_000_000_000_000n);
  chain.getTransactionReceiptStatus = async () => receipt;
  const controller = new RegularTransferController({
    store: fixture.store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: MAIN,
    amountWei: amountWei.toString(),
    sourcePrivateBalanceId: POCKET_ID,
  });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "pocket-public-change-reverted",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");

  let state = await fixture.store.read();
  let profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  assert.equal(
    state.onboarding!.delegation.spentWei,
    (fixture.baselineSpentWei + amountWei).toString(),
  );
  assert.equal(
    profile.privateBalances[POCKET_ID]!.delegation.spentWei,
    (fixture.baselineSpentWei + amountWei).toString(),
  );

  receipt = "reverted";
  const failed = await controller.getRequest(submitted.requestId);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error?.code, "TRANSACTION_REVERTED");
  assert.ok(failed.policySpendRestoredAt);
  assert.ok(failed.privatePolicySpendRestoredAt);
  const aggregateRestoredAt = failed.policySpendRestoredAt;
  const pocketRestoredAt = failed.privatePolicySpendRestoredAt;
  const repeated = await controller.getRequest(submitted.requestId);
  assert.equal(repeated.policySpendRestoredAt, aggregateRestoredAt);
  assert.equal(repeated.privatePolicySpendRestoredAt, pocketRestoredAt);
  assert.equal(wallet.namedCalls.length, 1);

  state = await fixture.store.read();
  profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  assert.equal(state.onboarding!.delegation.spentWei, fixture.baselineSpentWei.toString());
  assert.equal(
    profile.privateBalances[POCKET_ID]!.delegation.spentWei,
    fixture.baselineSpentWei.toString(),
  );
});

test("pocket public change refreshes the tracked account on submit and confirms by exact receipt", async () => {
  const initialBalance = 5_000_000_000_000_000n;
  const observedAfter = 2_000_000_000_000_000n;
  const fixture = await readyPocketStore({
    accounts: [{ address: CHANGE_A, balanceWei: initialBalance }],
  });
  const wallet = new RegularWallet();
  const chain = new RegularChain();
  chain.balances.set(CHANGE_A, initialBalance);
  wallet.executeRegularTransferFromWallet = async (walletName, input) => {
    await input.beforeBroadcast();
    wallet.namedCalls.push({
      walletName,
      sourceAddress: input.sourceAddress,
      recipient: input.recipient,
      amountWei: input.amountWei,
    });
    chain.balances.set(CHANGE_A, observedAfter);
    return { transactionHash: TX_HASH, confirmed: false };
  };
  let receipt: "pending" | "success" | "reverted" = "pending";
  chain.getTransactionReceiptStatus = async (hash) => {
    assert.equal(hash, TX_HASH);
    return receipt;
  };
  const controller = new RegularTransferController({
    store: fixture.store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: MAIN,
    amountWei: "2000000000000000",
    sourcePrivateBalanceId: POCKET_ID,
  });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "pocket-public-change-exact-receipt",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");
  assert.equal(submitted.sourcePublicBalanceAfterWei, observedAfter.toString());
  let state = await fixture.store.read();
  let profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  assert.equal(
    profile.privateBalances[POCKET_ID]!.publicChangeAccounts![CHANGE_A]!.balanceWei,
    observedAfter.toString(),
  );

  receipt = "success";
  const confirmed = await controller.getRequest(submitted.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.confirmation?.method, "transaction_receipt");
  assert.equal(wallet.namedCalls.length, 1);
  state = await fixture.store.read();
  profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  assert.equal(
    profile.privateBalances[POCKET_ID]!.publicChangeAccounts![CHANGE_A]!.balanceWei,
    observedAfter.toString(),
  );
});

test("a definite pocket adapter rejection restores both policies before broadcast", async () => {
  const amountWei = 2_000_000_000_000_000n;
  const fixture = await readyPocketStore({
    accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
  });
  const wallet = new RegularWallet();
  let attempts = 0;
  wallet.executeRegularTransferFromWallet = async () => {
    attempts += 1;
    throw new WalletExecutionError(
      "KOHAKU_EXECUTION_FAILED",
      "dry-run rejected before broadcast",
      { mayHaveBroadcast: false },
    );
  };
  const chain = new RegularChain();
  chain.balances.set(CHANGE_A, 5_000_000_000_000_000n);
  const controller = new RegularTransferController({
    store: fixture.store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: MAIN,
    amountWei: amountWei.toString(),
    sourcePrivateBalanceId: POCKET_ID,
  });
  const failed = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "pocket-public-change-prebroadcast-reject",
    userConfirmed: true,
  });
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error?.code, "REGULAR_TRANSFER_REJECTED_BEFORE_BROADCAST");
  assert.equal(failed.broadcastStartedAt, undefined);
  assert.ok(failed.policySpendRestoredAt);
  assert.ok(failed.privatePolicySpendRestoredAt);
  assert.equal(attempts, 1);
  const state = await fixture.store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  assert.equal(state.onboarding!.delegation.spentWei, fixture.baselineSpentWei.toString());
  assert.equal(
    profile.privateBalances[POCKET_ID]!.delegation.spentWei,
    fixture.baselineSpentWei.toString(),
  );
});

test("an uncertain pocket adapter failure remains reserved and idempotent", async () => {
  const amountWei = 2_000_000_000_000_000n;
  const fixture = await readyPocketStore({
    accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
  });
  const wallet = new RegularWallet();
  wallet.executeRegularTransferFromWallet = async (walletName, input) => {
    await input.beforeBroadcast();
    wallet.namedCalls.push({
      walletName,
      sourceAddress: input.sourceAddress,
      recipient: input.recipient,
      amountWei: input.amountWei,
    });
    throw new Error("transport vanished after possible broadcast");
  };
  const chain = new RegularChain();
  chain.balances.set(CHANGE_A, 5_000_000_000_000_000n);
  const controller = new RegularTransferController({
    store: fixture.store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: MAIN,
    amountWei: amountWei.toString(),
    sourcePrivateBalanceId: POCKET_ID,
  });
  const first = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "pocket-public-change-uncertain",
    userConfirmed: true,
  });
  const repeated = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "pocket-public-change-uncertain",
    userConfirmed: true,
  });
  assert.equal(first.phase, "indeterminate");
  assert.equal(first.error?.code, "REGULAR_TRANSFER_UNRESOLVED");
  assert.ok(first.broadcastStartedAt);
  assert.equal(repeated.requestId, first.requestId);
  assert.equal(wallet.namedCalls.length, 1);
  const state = await fixture.store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  assert.equal(
    state.onboarding!.delegation.spentWei,
    (fixture.baselineSpentWei + amountWei).toString(),
  );
  assert.equal(
    profile.privateBalances[POCKET_ID]!.delegation.spentWei,
    (fixture.baselineSpentWei + amountWei).toString(),
  );
});

test("pocket public-change reconciliation hydrates its request-bound raw hash", async () => {
  const amountWei = 2_000_000_000_000_000n;
  const fixture = await readyPocketStore({
    accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
  });
  const wallet = new RegularWallet();
  wallet.executeRegularTransferFromWallet = async (walletName, input) => {
    await input.beforeBroadcast();
    wallet.namedCalls.push({
      walletName,
      sourceAddress: input.sourceAddress,
      recipient: input.recipient,
      amountWei: input.amountWei,
    });
    wallet.rawCheckpoint = rawCheckpoint({
      requestId: input.broadcastRequestId,
      from: input.sourceAddress,
      to: input.recipient,
      valueWei: input.amountWei.toString(),
    });
    throw new Error("provider response vanished after pocket send");
  };
  const chain = new RegularChain();
  chain.balances.set(CHANGE_A, 5_000_000_000_000_000n);
  chain.getTransactionReceiptStatus = async (transactionHash) => {
    assert.equal(transactionHash, TX_HASH);
    return "success";
  };
  const initial = new RegularTransferController({
    store: fixture.store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await initial.plan({
    recipient: MAIN,
    amountWei: amountWei.toString(),
    sourcePrivateBalanceId: POCKET_ID,
  });
  const unresolved = await initial.execute({
    decisionId: plan.decisionId,
    clientRequestId: "pocket-public-change-journal-crash",
    userConfirmed: true,
  });
  assert.equal(unresolved.phase, "indeterminate");

  const restarted = new RegularTransferController({
    store: fixture.store,
    wallet,
    chain,
    clock: { now: () => new Date(2_000) },
  });
  await restarted.recoverInterruptedRequests();
  const confirmed = await restarted.getRequest(unresolved.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.transactionHash, TX_HASH);
  assert.equal(wallet.namedCalls.length, 1);
});

test("unknown, archived, and unresolved pocket sources cannot authorize a transfer", async () => {
  const available = await readyPocketStore({
    accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
  });
  const unknownChain = new RegularChain();
  unknownChain.balances.set(CHANGE_A, 5_000_000_000_000_000n);
  await assert.rejects(new RegularTransferController({
    store: available.store,
    wallet: new RegularWallet(),
    chain: unknownChain,
    clock: { now: () => new Date(1_000) },
  }).plan({
    recipient: MAIN,
    amountWei: "1000000000000000",
    sourcePrivateBalanceId: "private_does_not_exist",
  }), /PRIVATE_BALANCE_NOT_FOUND/u);

  const archived = await readyPocketStore({
    accounts: [{ address: CHANGE_A, balanceWei: 5_000_000_000_000_000n }],
    pocketStatus: "archived",
  });
  const archivedChain = new RegularChain();
  archivedChain.balances.set(CHANGE_A, 5_000_000_000_000_000n);
  const archivedPlan = await new RegularTransferController({
    store: archived.store,
    wallet: new RegularWallet(),
    chain: archivedChain,
    clock: { now: () => new Date(1_000) },
  }).plan({
    recipient: MAIN,
    amountWei: "1000000000000000",
    sourcePrivateBalanceId: POCKET_ID,
  });
  assert.equal(archivedPlan.decision, "deny");
  assert.ok(archivedPlan.blockers.includes("PRIVATE_BALANCE_ARCHIVED"));

  const unresolvedWallet = new RegularWallet();
  unresolvedWallet.executeRegularTransferFromWallet = async (walletName, input) => {
    await input.beforeBroadcast();
    unresolvedWallet.namedCalls.push({
      walletName,
      sourceAddress: input.sourceAddress,
      recipient: input.recipient,
      amountWei: input.amountWei,
    });
    return { transactionHash: TX_HASH, confirmed: false };
  };
  let receipt: "pending" | "success" | "reverted" = "pending";
  unknownChain.getTransactionReceiptStatus = async () => receipt;
  const unresolvedController = new RegularTransferController({
    store: available.store,
    wallet: unresolvedWallet,
    chain: unknownChain,
    clock: { now: () => new Date(1_000) },
  });
  const firstPlan = await unresolvedController.plan({
    recipient: MAIN,
    amountWei: "1000000000000000",
    sourcePrivateBalanceId: POCKET_ID,
  });
  const submitted = await unresolvedController.execute({
    decisionId: firstPlan.decisionId,
    clientRequestId: "pocket-public-change-unresolved-first",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");
  const conflictingPlan = await unresolvedController.plan({
    recipient: RECIPIENT,
    amountWei: "1000000000000000",
    sourcePrivateBalanceId: POCKET_ID,
  });
  assert.equal(conflictingPlan.decision, "deny");
  assert.ok(conflictingPlan.blockers.includes("PRIVATE_BALANCE_OPERATION_UNRESOLVED"));
  assert.equal(unresolvedWallet.namedCalls.length, 1);
});
