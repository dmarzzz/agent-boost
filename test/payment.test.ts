import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ChainClient,
  PrivateBroadcastCheckpoint,
  WalletAdapter,
} from "../src/contracts.js";
import { WalletExecutionError } from "../src/errors.js";
import { PaymentController } from "../src/payment.js";
import { PrivateBalancePolicyController } from "../src/private-balance-policy.js";
import { RecoveryTransferController } from "../src/recovery.js";
import { StateStore } from "../src/state/store.js";
import { seedRegularRequestFixture } from "./helpers/private-regular-fixture.js";

const PRIVATE_CHANGE_SENDER = "0x3333333333333333333333333333333333333333";
const OTHER_PRIVATE_CHANGE_SENDER = "0x4444444444444444444444444444444444444444";
const ENTRY_POINT_V08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";

function privateCheckpoint(
  requestId: string,
  userOperationHash: string,
  sender = PRIVATE_CHANGE_SENDER,
): PrivateBroadcastCheckpoint {
  return {
    version: 1,
    requestId,
    userOperationHash,
    sender,
    entryPointAddress: ENTRY_POINT_V08,
    journaledAt: new Date(1_000).toISOString(),
  };
}

class PaymentWallet implements WalletAdapter {
  calls = 0;
  privateBalance = 100_000_000_000_000_000n;
  checkpoint?: PrivateBroadcastCheckpoint;
  changeAccountCalls: Array<{ walletName: string; expectedAddress: string }> = [];
  failChangeAccountRecovery = false;
  async ensureWallet(): Promise<void> {}
  async nextFreshAddress(): Promise<string> {
    return "0x1111111111111111111111111111111111111111";
  }
  async prewarmPrivacy(): Promise<void> {}
  async shieldWei(): Promise<Record<string, never>> {
    return {};
  }
  async getPrivateBalanceWei(): Promise<bigint> {
    return this.privateBalance;
  }
  async getPrivateBroadcastCheckpoint(
    _requestId: string,
  ): Promise<PrivateBroadcastCheckpoint | undefined> {
    return this.checkpoint;
  }
  async ensurePrivateChangeAccount(
    walletName: string,
    expectedAddress: string,
  ): Promise<void> {
    this.changeAccountCalls.push({ walletName, expectedAddress });
    if (this.failChangeAccountRecovery) {
      throw new Error("private change account recovery failed");
    }
  }
  async executePrivatePayment(input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash?: string;
    userOperationHash?: string;
    confirmed?: boolean;
  }> {
    assert.match(input.broadcastRequestId, /^req_/u);
    await input.beforeBroadcast();
    this.calls += 1;
    this.privateBalance = 0n;
    return { transactionHash: `0x${"ab".repeat(32)}`, confirmed: true };
  }
}

async function readyStore(): Promise<StateStore> {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-payment-"));
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
      address: "0x1111111111111111111111111111111111111111",
      publicBalanceWei: "100000000000000000",
      privateBalanceWei: "100000000000000000",
      requiredFundingWei: "200000000000000000",
      shieldAmountWei: "100000000000000000",
      delegation: {
        mode: "testnet_delegated",
        chainId: 11_155_111,
        perPaymentLimitWei: "100000000000000000",
        lifetimeLimitWei: "100000000000000000",
        spentWei: "0",
        maxPayments: 1,
        expiresAt: new Date(86_400_000).toISOString(),
        enabled: true,
      },
    };
  });
  return store;
}

test("private payment is bounded, confirmation-gated, and idempotent", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  const controller = new PaymentController({
    store,
    wallet,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  assert.equal(plan.decision, "allow");
  assert.deepEqual(plan.approval, {
    action: "confirm",
    userConfirmationRequired: true,
  });

  await assert.rejects(
    controller.execute({
      decisionId: plan.decisionId,
      clientRequestId: "message-1-payment",
      userConfirmed: false,
    }),
    /confirm/,
  );

  const first = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "message-1-payment",
    userConfirmed: true,
  });
  const second = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "message-1-payment",
    userConfirmed: true,
  });
  assert.equal(first.phase, "confirmed");
  assert.equal(second.requestId, first.requestId);
  assert.equal(wallet.calls, 1);

  const laterPlan = await controller.plan({
    recipient: "0x3333333333333333333333333333333333333333",
    amountWei: "10000000000000000",
  });
  assert.equal(laterPlan.decision, "deny");
  assert.ok(laterPlan.blockers.includes("PAYMENT_COUNT_LIMIT"));
  assert.ok(laterPlan.blockers.includes("INSUFFICIENT_PRIVATE_BALANCE"));
});

test("local security policy can allow or deny bounded execution", async () => {
  const allowStore = await readyStore();
  const allowWallet = new PaymentWallet();
  const allowController = new PaymentController({
    store: allowStore,
    wallet: allowWallet,
    clock: { now: () => new Date(1_000) },
    paymentApproval: "allow",
  });
  const allowed = await allowController.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "10000000000000000",
  });
  assert.deepEqual(allowed.approval, {
    action: "allow",
    userConfirmationRequired: false,
  });
  const executed = await allowController.execute({
    decisionId: allowed.decisionId,
    clientRequestId: "automatic-payment",
    userConfirmed: false,
  });
  assert.equal(executed.phase, "confirmed");

  const denyController = new PaymentController({
    store: await readyStore(),
    wallet: new PaymentWallet(),
    clock: { now: () => new Date(1_000) },
    paymentApproval: "deny",
  });
  const denied = await denyController.plan({
    recipient: "0x3333333333333333333333333333333333333333",
    amountWei: "10000000000000000",
  });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.blockers.includes("SECURITY_POLICY_DENIED"));
});

test("private payment planning denies an amount above the delegated limit", async () => {
  const store = await readyStore();
  const controller = new PaymentController({
    store,
    wallet: new PaymentWallet(),
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "100000000000000001",
  });
  assert.equal(plan.decision, "deny");
  assert.ok(plan.blockers.includes("PER_PAYMENT_LIMIT"));
});

test("an exhausted historical-spend policy denies every positive payment", async () => {
  const store = await readyStore();
  await store.update((draft) => {
    assert.ok(draft.onboarding);
    const profile = draft.wallet!.profiles[draft.wallet!.activeWalletId]!;
    const pocket = profile.privateBalances[profile.defaultPrivateBalanceId]!;
    for (const policy of [draft.onboarding.delegation, pocket.delegation]) {
      policy.perPaymentLimitWei = "1";
      policy.lifetimeLimitWei = "20";
      policy.spentWei = "20";
      policy.maxPayments = 1;
    }
  });
  const controller = new PaymentController({
    store,
    wallet: new PaymentWallet(),
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "1",
  });
  assert.equal(plan.decision, "deny");
  assert.ok(plan.blockers.includes("LIFETIME_LIMIT"));
  assert.ok(plan.blockers.includes("PRIVATE_BALANCE_LIFETIME_LIMIT"));
});

test("a configurable delegation permits multiple bounded payments", async () => {
  const store = await readyStore();
  await store.update((draft) => {
    if (!draft.onboarding) return;
    draft.onboarding.delegation.maxPayments = 2;
    draft.onboarding.delegation.lifetimeLimitWei = "40000000000000000";
    const profile = draft.wallet?.profiles[draft.wallet.activeWalletId];
    const pocket = profile?.privateBalances[profile.defaultPrivateBalanceId];
    if (pocket) {
      pocket.delegation.maxPayments = 2;
      pocket.delegation.lifetimeLimitWei = "40000000000000000";
    }
  });
  const wallet = new PaymentWallet();
  wallet.privateBalance = 200_000_000_000_000_000n;
  wallet.executePrivatePayment = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    wallet.privateBalance -= 100_000_000_000_000_000n;
    return { transactionHash: `0x${wallet.calls.toString().padStart(64, "0")}`, confirmed: true };
  };
  const controller = new PaymentController({
    store,
    wallet,
    clock: { now: () => new Date(1_000) },
  });

  for (const [index, recipient] of [
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ].entries()) {
    const plan = await controller.plan({ recipient, amountWei: "20000000000000000" });
    assert.equal(plan.decision, "allow");
    const request = await controller.execute({
      decisionId: plan.decisionId,
      clientRequestId: `multi-payment-${index}`,
      userConfirmed: true,
    });
    assert.equal(request.phase, "confirmed");
  }
  const third = await controller.plan({
    recipient: "0x4444444444444444444444444444444444444444",
    amountWei: "1",
  });
  assert.equal(third.decision, "deny");
  assert.ok(third.blockers.includes("PAYMENT_COUNT_LIMIT"));
});

test("a recipient balance delta alone does not confirm a private payment", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  wallet.executePrivatePayment = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    wallet.privateBalance = 0n;
    return { transactionHash: `0x${"cd".repeat(32)}`, confirmed: false };
  };
  const observations = [10n, 20_000_000_000_000_010n];
  let networkAssertions = 0;
  const chain: ChainClient = {
    async assertSepolia() {
      networkAssertions += 1;
    },
    async getBalanceWei() {
      return observations.shift() ?? observations.at(-1) ?? 0n;
    },
  };
  const controller = new PaymentController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });

  const request = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "message-2-payment",
    userConfirmed: true,
  });

  assert.equal(request.phase, "submitted");
  const deltaOnly = await controller.getRequest(request.requestId);
  assert.equal(deltaOnly.phase, "submitted");
  assert.equal(deltaOnly.confirmation, undefined);
  assert.equal(networkAssertions, 2);
});

test("an unresolved user operation needs its exact event receipt and never rebroadcasts", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  const userOperationHash = `0x${"12".repeat(32)}`;
  wallet.executePrivatePayment = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    return { userOperationHash, confirmed: false };
  };
  let recipientBalance = 7n;
  let outerReceiptReads = 0;
  let userOperationReceipt:
    | { status: "pending" }
    | { status: "success"; transactionHash: string } = { status: "pending" };
  const transactionHash = `0x${"13".repeat(32)}`;
  const chain: ChainClient = {
    async assertSepolia() {},
    async getBalanceWei() {
      return recipientBalance;
    },
    async getUserOperationReceiptStatus(hash) {
      assert.equal(hash, userOperationHash);
      return userOperationReceipt;
    },
    async getTransactionReceiptStatus() {
      outerReceiptReads += 1;
      return "success";
    },
  };
  const controller = new PaymentController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "user-operation-payment",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");
  assert.equal(submitted.userOperationHash, userOperationHash);
  assert.equal(submitted.transactionHash, undefined);

  recipientBalance += 20_000_000_000_000_000n;
  const deltaOnly = await controller.getRequest(submitted.requestId);
  assert.equal(deltaOnly.phase, "submitted");
  assert.equal(outerReceiptReads, 0);
  userOperationReceipt = { status: "success", transactionHash };
  const confirmed = await controller.getRequest(submitted.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.transactionHash, transactionHash);
  assert.equal(confirmed.confirmation?.method, "user_operation_receipt");
  assert.equal(outerReceiptReads, 0);
  assert.equal(wallet.calls, 1);
});

test("pocket regular sends count against that pocket and block overlapping private activity", async () => {
  const countedStore = await readyStore();
  await countedStore.update((draft) => {
    assert.ok(draft.onboarding);
    draft.onboarding.delegation.maxPayments = 10;
    const profile = draft.wallet!.profiles[draft.wallet!.activeWalletId]!;
    const pocket = profile.privateBalances[profile.defaultPrivateBalanceId]!;
    pocket.delegation.maxPayments = 2;
  });
  const countedProfile = await countedStore.activeWalletProfile();
  const privateBalanceId = countedProfile.defaultPrivateBalanceId;
  const fixture = await seedRegularRequestFixture(countedStore, {
    suffix: "pocket_count",
    phase: "confirmed",
    privateBalanceId,
  });
  assert.equal(fixture.provenancePaymentCount, 1);

  const pocketPolicy = new PrivateBalancePolicyController({
    store: countedStore,
    defaultTtlMs: 86_400_000,
    clock: { now: () => new Date(2_000) },
  });
  assert.equal((await pocketPolicy.get({ privateBalanceId })).policy.paymentsUsed, 2);
  const countedPlan = await new PaymentController({
    store: countedStore,
    wallet: new PaymentWallet(),
    clock: { now: () => new Date(2_000) },
  }).plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "10000000000000000",
    privateBalanceId,
  });
  assert.equal(countedPlan.decision, "deny");
  assert.ok(countedPlan.blockers.includes("PRIVATE_BALANCE_PAYMENT_COUNT_LIMIT"));
  assert.equal(countedPlan.blockers.includes("PAYMENT_COUNT_LIMIT"), false);

  const unresolvedStore = await readyStore();
  await unresolvedStore.update((draft) => {
    assert.ok(draft.onboarding);
    draft.onboarding.delegation.maxPayments = 10;
    const profile = draft.wallet!.profiles[draft.wallet!.activeWalletId]!;
    profile.privateBalances[profile.defaultPrivateBalanceId]!.delegation.maxPayments = 10;
  });
  const unresolvedProfile = await unresolvedStore.activeWalletProfile();
  await seedRegularRequestFixture(unresolvedStore, {
    suffix: "pocket_unresolved",
    phase: "submitted",
    privateBalanceId: unresolvedProfile.defaultPrivateBalanceId,
  });
  const paymentPlan = await new PaymentController({
    store: unresolvedStore,
    wallet: new PaymentWallet(),
    clock: { now: () => new Date(2_000) },
  }).plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "10000000000000000",
    privateBalanceId: unresolvedProfile.defaultPrivateBalanceId,
  });
  assert.equal(paymentPlan.decision, "deny");
  assert.ok(paymentPlan.blockers.includes("PRIVATE_BALANCE_OPERATION_UNRESOLVED"));

  const recoveryPlan = await new RecoveryTransferController({
    store: unresolvedStore,
    wallet: new PaymentWallet(),
    chain: {
      async assertSepolia() {},
      async getBalanceWei() { return 0n; },
    },
    clock: { now: () => new Date(2_000) },
  }).plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "90000000000000000",
    privateBalanceId: unresolvedProfile.defaultPrivateBalanceId,
  });
  assert.equal(recoveryPlan.decision, "deny");
  assert.ok(recoveryPlan.blockers.includes("PRIVATE_BALANCE_OPERATION_UNRESOLVED"));
});

test("failed private and pocket-public sends do not consume pocket policy count", async () => {
  const store = await readyStore();
  await store.update((draft) => {
    assert.ok(draft.onboarding);
    draft.onboarding.delegation.maxPayments = 10;
    const profile = draft.wallet!.profiles[draft.wallet!.activeWalletId]!;
    profile.privateBalances[profile.defaultPrivateBalanceId]!.delegation.maxPayments = 10;
  });
  const profile = await store.activeWalletProfile();
  const privateBalanceId = profile.defaultPrivateBalanceId;
  const wallet = new PaymentWallet();
  wallet.executePrivatePayment = async () => {
    throw new WalletExecutionError(
      "TEST_PREFLIGHT_REJECTED",
      "test preflight rejected",
      { mayHaveBroadcast: false },
    );
  };
  const payments = new PaymentController({
    store,
    wallet,
    clock: { now: () => new Date(2_000) },
  });
  const failedPlan = await payments.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "1",
    privateBalanceId,
  });
  const failedPrivate = await payments.execute({
    decisionId: failedPlan.decisionId,
    clientRequestId: "failed-pocket-private",
    userConfirmed: true,
  });
  assert.equal(failedPrivate.phase, "failed");

  const failedPublic = await seedRegularRequestFixture(store, {
    suffix: "failed_pocket_public",
    phase: "failed",
    privateBalanceId,
  });
  assert.equal(failedPublic.provenancePaymentCount, 1);

  const policy = await new PrivateBalancePolicyController({
    store,
    defaultTtlMs: 86_400_000,
    clock: { now: () => new Date(3_000) },
  }).get({ privateBalanceId });
  assert.equal(policy.policy.paymentsUsed, 1);
  assert.equal(policy.policy.paymentsRemaining, 9);
});

test("adapter-confirmed private payment with a journal waits for exact receipt and change recovery", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  const userOperationHash = `0x${"71".repeat(32)}`;
  const transactionHash = `0x${"72".repeat(32)}`;
  wallet.executePrivatePayment = async ({ broadcastRequestId, beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    wallet.checkpoint = privateCheckpoint(broadcastRequestId, userOperationHash);
    return { transactionHash, userOperationHash, confirmed: true };
  };
  let receipt:
    | { status: "pending" }
    | { status: "success"; transactionHash: string } = { status: "pending" };
  const chain: ChainClient = {
    async assertSepolia() {},
    async getBalanceWei(address) {
      return address.toLowerCase() === PRIVATE_CHANGE_SENDER.toLowerCase() ? 91n : 0n;
    },
    async getUserOperationReceiptStatus(hash, expectedSender) {
      assert.equal(hash, userOperationHash);
      assert.equal(expectedSender, PRIVATE_CHANGE_SENDER);
      return receipt;
    },
    async getTransactionReceiptStatus() {
      throw new Error("outer transaction receipt must not confirm a journaled UserOperation");
    },
  };
  const controller = new PaymentController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "adapter-confirmed-journaled-payment",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");
  assert.equal(submitted.confirmation, undefined);
  assert.equal(submitted.publicChangeWei, undefined);
  assert.equal(wallet.changeAccountCalls.length, 0);
  assert.equal((await controller.getRequest(submitted.requestId)).phase, "submitted");

  receipt = { status: "success", transactionHash };
  const confirmed = await controller.getRequest(submitted.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.confirmation?.method, "user_operation_receipt");
  assert.equal(confirmed.publicChangeWei, "91");
  assert.deepEqual(wallet.changeAccountCalls, [{
    walletName: "agent-boost",
    expectedAddress: PRIVATE_CHANGE_SENDER,
  }]);
  const state = await store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  assert.equal(
    profile.privateBalances[confirmed.privateBalanceId!]!.publicChangeAccounts?.[
      PRIVATE_CHANGE_SENDER.toLowerCase()
    ]?.sourceRequestId,
    submitted.requestId,
  );
});

test("a crash journal hydrates a pending payment and exact success records public change", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  const userOperationHash = `0x${"61".repeat(32)}`;
  const transactionHash = `0x${"62".repeat(32)}`;
  wallet.executePrivatePayment = async ({ broadcastRequestId, beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    wallet.checkpoint = privateCheckpoint(broadcastRequestId, userOperationHash);
    return {};
  };
  let receipt:
    | { status: "pending" }
    | { status: "success"; transactionHash: string } = { status: "pending" };
  let outerReceiptReads = 0;
  const chain: ChainClient = {
    async assertSepolia() {},
    async getBalanceWei(address) {
      return address.toLowerCase() === PRIVATE_CHANGE_SENDER.toLowerCase() ? 77n : 0n;
    },
    async getTransactionReceiptStatus() {
      outerReceiptReads += 1;
      return "success";
    },
    async getUserOperationReceiptStatus(hash, expectedSender) {
      assert.equal(hash, userOperationHash);
      assert.equal(expectedSender, PRIVATE_CHANGE_SENDER);
      return receipt;
    },
  };
  const controller = new PaymentController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  const interrupted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "journaled-pending-payment",
    userConfirmed: true,
  });
  assert.equal(interrupted.phase, "indeterminate");
  assert.equal(interrupted.userOperationHash, undefined);

  const restarted = new PaymentController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(2_000) },
  });
  await restarted.recoverInterruptedRequests();
  const pending = await restarted.getRequest(interrupted.requestId);
  assert.equal(pending.phase, "indeterminate");
  assert.equal(pending.userOperationHash, userOperationHash);
  assert.equal(pending.transactionHash, undefined);
  assert.equal(wallet.changeAccountCalls.length, 0);

  receipt = { status: "success", transactionHash };
  const confirmed = await restarted.getRequest(interrupted.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.userOperationHash, userOperationHash);
  assert.equal(confirmed.transactionHash, transactionHash);
  assert.equal(confirmed.confirmation?.method, "user_operation_receipt");
  assert.equal(confirmed.publicChangeWei, "77");
  assert.deepEqual(wallet.changeAccountCalls, [{
    walletName: "agent-boost",
    expectedAddress: PRIVATE_CHANGE_SENDER,
  }]);
  const state = await store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  const pocket = profile.privateBalances[confirmed.privateBalanceId!]!;
  assert.equal(
    pocket.publicChangeAccounts?.[PRIVATE_CHANGE_SENDER.toLowerCase()]?.balanceWei,
    "77",
  );
  assert.equal(
    pocket.publicChangeAccounts?.[PRIVATE_CHANGE_SENDER.toLowerCase()]?.sourceRequestId,
    interrupted.requestId,
  );
  assert.equal(outerReceiptReads, 0);
  assert.equal(wallet.calls, 1);
});

test("a reverted crash-journal payment restores reservations exactly once", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  const userOperationHash = `0x${"63".repeat(32)}`;
  const transactionHash = `0x${"64".repeat(32)}`;
  wallet.executePrivatePayment = async ({ broadcastRequestId, beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    wallet.checkpoint = privateCheckpoint(broadcastRequestId, userOperationHash);
    return {};
  };
  const controller = new PaymentController({
    store,
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei() { return 0n; },
      async getUserOperationReceiptStatus(hash, expectedSender) {
        assert.equal(hash, userOperationHash);
        assert.equal(expectedSender, PRIVATE_CHANGE_SENDER);
        return { status: "reverted", transactionHash };
      },
    },
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  const interrupted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "journaled-reverted-payment",
    userConfirmed: true,
  });
  const failed = await controller.getRequest(interrupted.requestId);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.userOperationHash, userOperationHash);
  assert.equal(failed.transactionHash, transactionHash);
  assert.ok(failed.privateBalanceRestoredAt);
  const restoredAt = failed.privateBalanceRestoredAt;
  assert.equal(
    (await controller.getRequest(interrupted.requestId)).privateBalanceRestoredAt,
    restoredAt,
  );
  const state = await store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  assert.equal(
    profile.privateBalances[profile.defaultPrivateBalanceId]?.balanceWei,
    "100000000000000000",
  );
  assert.equal(wallet.changeAccountCalls.length, 0);
  assert.equal(wallet.calls, 1);
});

test("checkpoint hash and sender mismatches never confirm a payment", async (t) => {
  await t.test("stored and journaled UserOperation hashes must match", async () => {
    const store = await readyStore();
    const wallet = new PaymentWallet();
    const storedHash = `0x${"65".repeat(32)}`;
    const journaledHash = `0x${"66".repeat(32)}`;
    let receiptReads = 0;
    wallet.executePrivatePayment = async ({ broadcastRequestId, beforeBroadcast }) => {
      await beforeBroadcast();
      wallet.calls += 1;
      wallet.checkpoint = privateCheckpoint(broadcastRequestId, journaledHash);
      return { userOperationHash: storedHash, confirmed: false };
    };
    const controller = new PaymentController({
      store,
      wallet,
      chain: {
        async assertSepolia() {},
        async getBalanceWei() { return 0n; },
        async getUserOperationReceiptStatus() {
          receiptReads += 1;
          return { status: "success", transactionHash: `0x${"67".repeat(32)}` };
        },
      },
      clock: { now: () => new Date(1_000) },
    });
    const plan = await controller.plan({
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei: "20000000000000000",
    });
    const submitted = await controller.execute({
      decisionId: plan.decisionId,
      clientRequestId: "journaled-hash-mismatch",
      userConfirmed: true,
    });
    const unresolved = await controller.getRequest(submitted.requestId);
    assert.equal(unresolved.phase, "submitted");
    assert.equal(unresolved.confirmation, undefined);
    assert.equal(unresolved.error?.code, "PRIVATE_BROADCAST_CHECKPOINT_MISMATCH");
    assert.equal(receiptReads, 0);
  });

  await t.test("an exact event lookup rejects a different sender", async () => {
    const store = await readyStore();
    const wallet = new PaymentWallet();
    const userOperationHash = `0x${"68".repeat(32)}`;
    let receiptReads = 0;
    wallet.executePrivatePayment = async ({ broadcastRequestId, beforeBroadcast }) => {
      await beforeBroadcast();
      wallet.calls += 1;
      wallet.checkpoint = privateCheckpoint(broadcastRequestId, userOperationHash);
      return {};
    };
    const controller = new PaymentController({
      store,
      wallet,
      chain: {
        async assertSepolia() {},
        async getBalanceWei() { return 0n; },
        async getUserOperationReceiptStatus(hash, expectedSender) {
          receiptReads += 1;
          assert.equal(hash, userOperationHash);
          assert.equal(expectedSender, PRIVATE_CHANGE_SENDER);
          assert.notEqual(expectedSender, OTHER_PRIVATE_CHANGE_SENDER);
          throw new Error("UserOperation event sender mismatch");
        },
      },
      clock: { now: () => new Date(1_000) },
    });
    const plan = await controller.plan({
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei: "20000000000000000",
    });
    const interrupted = await controller.execute({
      decisionId: plan.decisionId,
      clientRequestId: "journaled-sender-mismatch",
      userConfirmed: true,
    });
    const unresolved = await controller.getRequest(interrupted.requestId);
    assert.equal(unresolved.phase, "indeterminate");
    assert.equal(unresolved.userOperationHash, userOperationHash);
    assert.equal(unresolved.confirmation, undefined);
    assert.equal(unresolved.transactionHash, undefined);
    assert.equal(receiptReads, 1);
  });
});

test("failed private change-account recovery leaves exact payment success unresolved", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  wallet.failChangeAccountRecovery = true;
  const userOperationHash = `0x${"69".repeat(32)}`;
  const transactionHash = `0x${"6a".repeat(32)}`;
  let receiptReads = 0;
  wallet.executePrivatePayment = async ({ broadcastRequestId, beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    wallet.checkpoint = privateCheckpoint(broadcastRequestId, userOperationHash);
    return {};
  };
  const controller = new PaymentController({
    store,
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei(address) {
        return address.toLowerCase() === PRIVATE_CHANGE_SENDER.toLowerCase() ? 88n : 0n;
      },
      async getUserOperationReceiptStatus(hash, expectedSender) {
        receiptReads += 1;
        assert.equal(hash, userOperationHash);
        assert.equal(expectedSender, PRIVATE_CHANGE_SENDER);
        return { status: "success", transactionHash };
      },
    },
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  const interrupted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "journaled-change-recovery-failure",
    userConfirmed: true,
  });
  const unresolved = await controller.getRequest(interrupted.requestId);
  assert.equal(unresolved.phase, "indeterminate");
  assert.equal(unresolved.userOperationHash, userOperationHash);
  assert.equal(unresolved.transactionHash, transactionHash);
  assert.equal(unresolved.confirmation, undefined);
  assert.equal(unresolved.error?.code, "PUBLIC_CHANGE_TRACKING_PENDING");
  assert.deepEqual(unresolved.userOperationReceiptEvidence, {
    version: 1,
    status: "success",
    userOperationHash,
    transactionHash,
    observedAt: new Date(1_000).toISOString(),
  });
  assert.equal(wallet.changeAccountCalls.length, 1);
  assert.equal(receiptReads, 1);

  wallet.failChangeAccountRecovery = false;
  const restartedStore = new StateStore(join(store.path, ".."));
  await restartedStore.initialize();
  const restarted = new PaymentController({
    store: restartedStore,
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei(address) {
        return address.toLowerCase() === PRIVATE_CHANGE_SENDER.toLowerCase() ? 88n : 0n;
      },
      async getUserOperationReceiptStatus() {
        receiptReads += 1;
        throw new Error("receipt provider unavailable after restart");
      },
    },
    clock: { now: () => new Date(2_000) },
  });
  const recovered = await restarted.getRequest(interrupted.requestId);
  assert.equal(recovered.phase, "confirmed");
  assert.equal(recovered.publicChangeWei, "88");
  assert.equal(recovered.confirmation?.method, "user_operation_receipt");
  const stable = await restarted.getRequest(interrupted.requestId);
  assert.deepEqual(stable, recovered);
  assert.equal(receiptReads, 1);
  assert.equal(wallet.calls, 1);
  const state = await store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  const pocket = profile.privateBalances[recovered.privateBalanceId!]!;
  assert.equal(pocket.balanceWei, "0");
  assert.equal(Object.keys(pocket.publicChangeAccounts ?? {}).length, 1);
});

test("a mismatched UserOperation transaction stays unresolved and ignores the outer receipt", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  const userOperationHash = `0x${"21".repeat(32)}`;
  const adapterTransactionHash = `0x${"22".repeat(32)}`;
  const eventTransactionHash = `0x${"23".repeat(32)}`;
  wallet.executePrivatePayment = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    return {
      userOperationHash,
      transactionHash: adapterTransactionHash,
      confirmed: false,
    };
  };
  let outerReceiptReads = 0;
  const controller = new PaymentController({
    store,
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei() { return 0n; },
      async getTransactionReceiptStatus() {
        outerReceiptReads += 1;
        return "success";
      },
      async getUserOperationReceiptStatus(hash) {
        assert.equal(hash, userOperationHash);
        return { status: "success", transactionHash: eventTransactionHash };
      },
    },
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "mismatched-user-operation",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");
  const unresolved = await controller.getRequest(submitted.requestId);
  assert.equal(unresolved.phase, "submitted");
  assert.equal(unresolved.confirmation, undefined);
  assert.equal(unresolved.transactionHash, adapterTransactionHash);
  assert.equal(outerReceiptReads, 0);
  assert.equal(wallet.calls, 1);
});

test("a reverted UserOperation restores private balance and policy reservations once", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  const userOperationHash = `0x${"31".repeat(32)}`;
  const transactionHash = `0x${"32".repeat(32)}`;
  wallet.executePrivatePayment = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    return { userOperationHash, confirmed: false };
  };
  const controller = new PaymentController({
    store,
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei() { return 0n; },
      async getUserOperationReceiptStatus(hash) {
        assert.equal(hash, userOperationHash);
        return { status: "reverted", transactionHash };
      },
    },
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "reverted-user-operation",
    userConfirmed: true,
  });
  const failed = await controller.getRequest(submitted.requestId);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error?.code, "TRANSACTION_REVERTED");
  assert.equal(failed.transactionHash, transactionHash);
  assert.ok(failed.privateBalanceRestoredAt);
  const restoredAt = failed.privateBalanceRestoredAt;
  const repeated = await controller.getRequest(submitted.requestId);
  assert.equal(repeated.privateBalanceRestoredAt, restoredAt);
  const state = await store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  const pocket = profile.privateBalances[profile.defaultPrivateBalanceId]!;
  assert.equal(pocket.balanceWei, "100000000000000000");
  assert.equal(pocket.delegation.spentWei, "0");
  assert.equal(state.onboarding?.delegation.spentWei, "0");
  assert.equal(wallet.calls, 1);
});

test("reconciliation uses a transaction receipt and never rebroadcasts", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  const transactionHash = `0x${"34".repeat(32)}`;
  wallet.executePrivatePayment = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    return { transactionHash, confirmed: false };
  };
  let receipt: "pending" | "success" | "reverted" = "pending";
  const chain: ChainClient = {
    async assertSepolia() {},
    async getBalanceWei() {
      return 0n;
    },
    async getTransactionReceiptStatus() {
      return receipt;
    },
  };
  const controller = new PaymentController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "receipt-reconciliation-payment",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");

  receipt = "success";
  const confirmed = await controller.getRequest(submitted.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.confirmation?.method, "transaction_receipt");
  assert.equal(wallet.calls, 1);
});

test("a reverted transaction receipt restores private balance and policy reservations once", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  const transactionHash = `0x${"56".repeat(32)}`;
  wallet.executePrivatePayment = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    return { transactionHash, confirmed: false };
  };
  let receipt: "pending" | "success" | "reverted" = "pending";
  const chain: ChainClient = {
    async assertSepolia() {},
    async getBalanceWei() {
      return receipt === "reverted" ? 20_000_000_000_000_000n : 0n;
    },
    async getTransactionReceiptStatus() {
      return receipt;
    },
  };
  const controller = new PaymentController({
    store,
    wallet,
    chain,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "reverted-reconciliation-payment",
    userConfirmed: true,
  });
  receipt = "reverted";
  const failed = await controller.getRequest(submitted.requestId);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error?.code, "TRANSACTION_REVERTED");
  assert.ok(failed.privateBalanceRestoredAt);
  const restoredAt = failed.privateBalanceRestoredAt;
  const repeated = await controller.getRequest(submitted.requestId);
  assert.equal(repeated.privateBalanceRestoredAt, restoredAt);
  assert.equal(wallet.calls, 1);
  const state = await store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  const pocket = profile.privateBalances[profile.defaultPrivateBalanceId]!;
  assert.equal(pocket.balanceWei, "100000000000000000");
  assert.equal(pocket.delegation.spentWei, "0");
  assert.equal(state.onboarding?.delegation.spentWei, "0");
  const laterPlan = await controller.plan({
    recipient: "0x3333333333333333333333333333333333333333",
    amountWei: "10000000000000000",
  });
  assert.equal(laterPlan.decision, "allow");
  assert.doesNotMatch(laterPlan.blockers.join(" "), /PAYMENT_COUNT_LIMIT/u);
});

test("restart fails fresh v3 work without a broadcast checkpoint and restores authority", async () => {
  const store = await readyStore();
  const interruptedPlan = await new PaymentController({
    store,
    wallet: new PaymentWallet(),
    clock: { now: () => new Date(1_000) },
  }).plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  await store.update((draft) => {
    const profile = draft.wallet!.profiles[interruptedPlan.authorization.walletId]!;
    const pocket = profile.privateBalances[interruptedPlan.privateBalanceId!]!;
    pocket.balanceWei = (
      BigInt(pocket.balanceWei) - BigInt(interruptedPlan.privateBalanceDebitWei!)
    ).toString();
    pocket.delegation.spentWei = (
      BigInt(pocket.delegation.spentWei) + BigInt(interruptedPlan.amountWei)
    ).toString();
    pocket.revision += 1;
    pocket.updatedAt = new Date(1_000).toISOString();
    draft.onboarding!.privateBalanceWei = pocket.balanceWei;
    draft.onboarding!.delegation.spentWei = interruptedPlan.amountWei;
    draft.onboarding!.revision += 1;
    draft.onboarding!.updatedAt = new Date(1_000).toISOString();
    draft.requests.req_interrupted = {
      version: 1,
      requestId: "req_interrupted",
      clientRequestId: "hermes:wd_interrupted",
      decisionId: interruptedPlan.decisionId,
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei: "20000000000000000",
      authorization: interruptedPlan.authorization,
      privateBalanceId: interruptedPlan.privateBalanceId!,
      privateBalanceRevision: interruptedPlan.privateBalanceRevision!,
      privateBalanceDebitWei: interruptedPlan.privateBalanceDebitWei!,
      privateBalanceDebitedAt: new Date(1_000).toISOString(),
      phase: "executing",
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(1_000).toISOString(),
    };
  });
  const controller = new PaymentController({
    store,
    wallet: new PaymentWallet(),
    clock: { now: () => new Date(2_000) },
  });

  await controller.recoverInterruptedRequests();

  const request = await controller.getRequest("req_interrupted");
  assert.equal(request.phase, "failed");
  assert.equal(request.error?.code, "EXECUTION_INTERRUPTED_BEFORE_BROADCAST");
  const plan = await controller.plan({
    recipient: "0x3333333333333333333333333333333333333333",
    amountWei: "10000000000000000",
  });
  assert.equal(plan.decision, "allow");
  assert.doesNotMatch(plan.blockers.join(" "), /PAYMENT_COUNT_LIMIT/u);
});

test("an adapter error after authority handoff remains indeterminate", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  wallet.executePrivatePayment = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    throw new Error("transport disappeared after possible broadcast");
  };
  const controller = new PaymentController({
    store,
    wallet,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  const request = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "adapter-error-payment",
    userConfirmed: true,
  });
  assert.equal(request.phase, "indeterminate");
  assert.equal(request.error?.code, "PRIVATE_PAYMENT_UNRESOLVED");
});

test("stop refuses new execution and drains an active payment", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  let release!: () => void;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const canFinish = new Promise<void>((resolve) => { release = resolve; });
  wallet.executePrivatePayment = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.calls += 1;
    started();
    await canFinish;
    return { transactionHash: `0x${"ef".repeat(32)}`, confirmed: true };
  };
  const controller = new PaymentController({
    store,
    wallet,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  const execution = controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "drained-active-payment",
    userConfirmed: true,
  });
  await didStart;
  let stopped = false;
  const stopping = controller.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([execution, stopping]);
  assert.equal(stopped, true);
  await assert.rejects(
    controller.execute({
      decisionId: plan.decisionId,
      clientRequestId: "another-payment-after-stop",
      userConfirmed: true,
    }),
    /PAYMENT_RUNTIME_STOPPING/,
  );
});

test("stop wins while execution is waiting on its initial state read", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  const controller = new PaymentController({
    store,
    wallet,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });

  const originalRead = store.read.bind(store);
  let releaseRead!: () => void;
  let signalReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => { signalReadStarted = resolve; });
  const continueRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  store.read = async () => {
    signalReadStarted();
    await continueRead;
    return originalRead();
  };

  const execution = controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "stopped-during-state-read",
    userConfirmed: true,
  });
  await readStarted;
  await controller.stop();
  releaseRead();

  await assert.rejects(execution, /PAYMENT_RUNTIME_STOPPING/);
  assert.equal(wallet.calls, 0);
});

test("execution rechecks Sepolia, delegation expiry, and the live private balance", async () => {
  let nowMs = 1_000;
  const scenarios = [
    {
      name: "expired delegation",
      prepare: async (store: StateStore, wallet: PaymentWallet) => {
        void wallet;
        await store.update((draft) => {
          if (draft.onboarding) {
            draft.onboarding.delegation.expiresAt = new Date(1_500).toISOString();
          }
          const profile = draft.wallet?.profiles[draft.wallet.activeWalletId];
          const pocket = profile?.privateBalances[profile.defaultPrivateBalanceId];
          if (pocket) {
            pocket.delegation.expiresAt = new Date(1_500).toISOString();
          }
        });
      },
      mutate: async () => {},
      expected: /DELEGATION_EXPIRED/,
    },
    {
      name: "expired decision after live refresh",
      prepare: async () => {},
      mutate: async (_store: StateStore, wallet: PaymentWallet) => {
        const original = wallet.getPrivateBalanceWei.bind(wallet);
        wallet.getPrivateBalanceWei = async () => {
          nowMs = 400_000;
          return original();
        };
      },
      expected: /DECISION_EXPIRED/,
    },
    {
      name: "insufficient live private balance",
      prepare: async () => {},
      mutate: async (_store: StateStore, wallet: PaymentWallet) => {
        wallet.privateBalance = 1n;
      },
      expected: /INSUFFICIENT_SELECTED_PRIVATE_BALANCE/,
    },
  ];

  for (const scenario of scenarios) {
    const store = await readyStore();
    const wallet = new PaymentWallet();
    nowMs = 1_000;
    await scenario.prepare(store, wallet);
    let networkAssertions = 0;
    const controller = new PaymentController({
      store,
      wallet,
      chain: {
        async assertSepolia() {
          networkAssertions += 1;
        },
        async getBalanceWei() {
          return 0n;
        },
      },
      clock: { now: () => new Date(nowMs) },
    });
    const plan = await controller.plan({
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei: "20000000000000000",
    });
    assert.equal(plan.decision, "allow", scenario.name);
    await scenario.mutate(store, wallet);
    if (scenario.name !== "expired decision after live refresh") nowMs = 2_000;

    await assert.rejects(
      controller.execute({
        decisionId: plan.decisionId,
        clientRequestId: `recheck-${scenario.name.replaceAll(" ", "-")}`,
        userConfirmed: true,
      }),
      scenario.expected,
    );
    assert.equal(networkAssertions, 1, scenario.name);
    assert.equal(wallet.calls, 0, scenario.name);
    assert.equal(Object.keys((await store.read()).requests).length, 0, scenario.name);
  }
});

test("execution kill switch blocks planning and stale allow decisions", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  const enabled = new PaymentController({
    store,
    wallet,
    clock: { now: () => new Date(1_000) },
  });
  const staleAllow = await enabled.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });

  const disabled = new PaymentController({
    store,
    wallet,
    executeEnabled: false,
    clock: { now: () => new Date(1_000) },
  });
  const denied = await disabled.plan({
    recipient: "0x2222222222222222222222222222222222222222",
    amountWei: "20000000000000000",
  });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.blockers.includes("EXECUTION_DISABLED"));
  await assert.rejects(
    disabled.execute({
      decisionId: staleAllow.decisionId,
      clientRequestId: "disabled-stale-allow",
      userConfirmed: true,
    }),
    /EXECUTION_DISABLED/,
  );
  assert.equal(wallet.calls, 0);
});
