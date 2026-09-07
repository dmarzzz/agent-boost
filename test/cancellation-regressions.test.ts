import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ChainClient,
  PrivateBroadcastCheckpoint,
  WalletAdapter,
  WalletReauthorizationPlan,
} from "../src/contracts.js";
import { PaymentController } from "../src/payment.js";
import { WalletPolicyController } from "../src/policy.js";
import { RecoveryTransferController } from "../src/recovery.js";
import { RegularTransferController } from "../src/regular-transfer.js";
import { StateStore } from "../src/state/store.js";

const MAIN = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const CHANGE_SENDER = "0x3333333333333333333333333333333333333333";
const ENTRY_POINT_V08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";

class CancellationWallet implements WalletAdapter {
  privateCalls = 0;
  regularCalls = 0;
  recoveryCalls = 0;
  checkpoint?: PrivateBroadcastCheckpoint;
  changeAccountCalls: Array<{ walletName: string; expectedAddress: string }> = [];
  failChangeAccountRecovery = false;

  async ensureWallet(): Promise<void> {}
  async nextFreshAddress(): Promise<string> { return MAIN; }
  async prewarmPrivacy(): Promise<void> {}
  async shieldWei(): Promise<Record<string, never>> { return {}; }
  async getPrivateBalanceWei(): Promise<bigint> { return 100n; }
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
  }): Promise<{ confirmed: boolean }> {
    assert.match(input.broadcastRequestId, /^req_/u);
    await input.beforeBroadcast();
    this.privateCalls += 1;
    return { confirmed: true };
  }

  async executeRegularTransfer(input: {
    recipient: string;
    amountWei: bigint;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ confirmed: boolean }> {
    await input.beforeBroadcast();
    this.regularCalls += 1;
    return { confirmed: true };
  }

  async executeRecoveryTransfer(input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ confirmed: boolean }> {
    assert.match(input.broadcastRequestId, /^wrr_/u);
    await input.beforeBroadcast();
    this.recoveryCalls += 1;
    return { confirmed: true };
  }
}

class CancellationChain implements ChainClient {
  async assertSepolia(): Promise<void> {}
  async getBalanceWei(address: string): Promise<bigint> {
    return address === MAIN ? 1_000n : 0n;
  }
}

async function readyStore(): Promise<StateStore> {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-cancellation-"));
  const store = new StateStore(root);
  await store.initialize();
  const now = new Date(0).toISOString();
  await store.update((draft) => {
    draft.onboarding = {
      version: 1,
      setupId: "setup-cancellation",
      revision: 1,
      phase: "private_ready",
      createdAt: now,
      updatedAt: now,
      address: MAIN,
      publicBalanceWei: "1000",
      privateBalanceWei: "100",
      requiredFundingWei: "200",
      shieldAmountWei: "100",
      delegation: {
        mode: "testnet_delegated",
        chainId: 11_155_111,
        perPaymentLimitWei: "1000",
        lifetimeLimitWei: "10000",
        spentWei: "0",
        maxPayments: 10,
        expiresAt: new Date(86_400_000).toISOString(),
        enabled: true,
      },
    };
  });
  await store.ensureWalletProfile("agent-boost");
  return store;
}

test("a declined private-payment plan stays cancelled across a later approval", async () => {
  const store = await readyStore();
  const wallet = new CancellationWallet();
  const controller = new PaymentController({
    store,
    wallet,
    withdrawalAmountWei: 100n,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ recipient: RECIPIENT, amountWei: "10" });

  const cancelled = await controller.cancel(plan.decisionId);
  assert.equal(cancelled.decision, "deny");
  assert.ok(cancelled.blockers.includes("USER_CANCELLED"));
  const cancelledAgain = await controller.cancel(plan.decisionId);
  assert.equal(
    cancelledAgain.blockers.filter((blocker) => blocker === "USER_CANCELLED").length,
    1,
  );
  await assert.rejects(
    controller.execute({
      decisionId: plan.decisionId,
      clientRequestId: "cancelled-private-payment",
      userConfirmed: true,
    }),
    /DECISION_CANCELLED/,
  );
  assert.equal(wallet.privateCalls, 0);
  assert.equal(Object.keys((await store.read()).requests).length, 0);
});

test("a declined regular-transfer plan stays cancelled across a later approval", async () => {
  const store = await readyStore();
  const wallet = new CancellationWallet();
  const controller = new RegularTransferController({
    store,
    wallet,
    chain: new CancellationChain(),
    gasReserveWei: 1n,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ recipient: RECIPIENT, amountWei: "66" });

  const cancelled = await controller.cancel(plan.decisionId);
  assert.equal(cancelled.decision, "deny");
  assert.ok(cancelled.blockers.includes("USER_CANCELLED"));
  await assert.rejects(
    controller.execute({
      decisionId: plan.decisionId,
      clientRequestId: "cancelled-regular-transfer",
      userConfirmed: true,
    }),
    /REGULAR_TRANSFER_DECISION_CANCELLED/,
  );
  assert.equal(wallet.regularCalls, 0);
  assert.equal(Object.keys((await store.read()).regularRequests).length, 0);
});

test("a declined recovery plan stays cancelled across a later approval", async () => {
  const store = await readyStore();
  const wallet = new CancellationWallet();
  const controller = new RecoveryTransferController({
    store,
    wallet,
    chain: new CancellationChain(),
    withdrawalAmountWei: 100n,
    feeReserveWei: 10n,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ recipient: RECIPIENT, amountWei: "90" });

  const cancelled = await controller.cancel(plan.decisionId);
  assert.equal(cancelled.decision, "deny");
  assert.ok(cancelled.blockers.includes("USER_CANCELLED"));
  await assert.rejects(
    controller.execute({
      decisionId: plan.decisionId,
      clientRequestId: "cancelled-recovery-transfer",
      userConfirmed: true,
    }),
    /RECOVERY_DECISION_CANCELLED/,
  );
  assert.equal(wallet.recoveryCalls, 0);
  assert.equal(Object.keys((await store.read()).recoveryRequests).length, 0);
});

test("recovery confirms only from its exact UserOperation event receipt", async () => {
  const store = await readyStore();
  const wallet = new CancellationWallet();
  const userOperationHash = `0x${"41".repeat(32)}`;
  const transactionHash = `0x${"42".repeat(32)}`;
  wallet.executeRecoveryTransfer = async ({ beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.recoveryCalls += 1;
    return { userOperationHash, confirmed: false };
  };
  let receipt:
    | { status: "pending" }
    | { status: "success"; transactionHash: string } = { status: "pending" };
  const controller = new RecoveryTransferController({
    store,
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei(address) { return address === MAIN ? 1_000n : 90n; },
      async getUserOperationReceiptStatus(hash) {
        assert.equal(hash, userOperationHash);
        return receipt;
      },
    },
    withdrawalAmountWei: 100n,
    feeReserveWei: 10n,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ recipient: RECIPIENT, amountWei: "90" });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "recovery-user-operation",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");
  assert.equal((await controller.getRequest(submitted.requestId)).phase, "submitted");
  receipt = { status: "success", transactionHash };
  const confirmed = await controller.getRequest(submitted.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.transactionHash, transactionHash);
  assert.equal(confirmed.confirmation?.method, "user_operation_receipt");
  assert.equal(wallet.recoveryCalls, 1);
});

test("adapter-confirmed recovery with a journal waits for exact receipt and change recovery", async () => {
  const store = await readyStore();
  const wallet = new CancellationWallet();
  const userOperationHash = `0x${"45".repeat(32)}`;
  const transactionHash = `0x${"46".repeat(32)}`;
  wallet.executeRecoveryTransfer = async ({ broadcastRequestId, beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.recoveryCalls += 1;
    wallet.checkpoint = {
      version: 1,
      requestId: broadcastRequestId,
      userOperationHash,
      sender: CHANGE_SENDER,
      entryPointAddress: ENTRY_POINT_V08,
      journaledAt: new Date(1_000).toISOString(),
    };
    return { transactionHash, userOperationHash, confirmed: true };
  };
  let receipt:
    | { status: "pending" }
    | { status: "success"; transactionHash: string } = { status: "pending" };
  const controller = new RecoveryTransferController({
    store,
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei(address) {
        if (address.toLowerCase() === CHANGE_SENDER.toLowerCase()) return 17n;
        return address === MAIN ? 1_000n : 90n;
      },
      async getUserOperationReceiptStatus(hash, expectedSender) {
        assert.equal(hash, userOperationHash);
        assert.equal(expectedSender, CHANGE_SENDER);
        return receipt;
      },
      async getTransactionReceiptStatus() {
        throw new Error("outer transaction receipt must not confirm a journaled UserOperation");
      },
    },
    withdrawalAmountWei: 100n,
    feeReserveWei: 10n,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ recipient: RECIPIENT, amountWei: "90" });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "adapter-confirmed-journaled-recovery",
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
  assert.equal(confirmed.publicChangeWei, "17");
  assert.deepEqual(wallet.changeAccountCalls, [{
    walletName: "agent-boost",
    expectedAddress: CHANGE_SENDER,
  }]);
  const state = await store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  assert.equal(
    profile.privateBalances[confirmed.privateBalanceId!]!.publicChangeAccounts?.[
      CHANGE_SENDER.toLowerCase()
    ]?.sourceRequestId,
    submitted.requestId,
  );
});

test("recovery reuses durable success evidence after change recovery and receipt RPC fail", async () => {
  const store = await readyStore();
  const wallet = new CancellationWallet();
  const userOperationHash = `0x${"47".repeat(32)}`;
  const transactionHash = `0x${"48".repeat(32)}`;
  let receiptReads = 0;
  wallet.executeRecoveryTransfer = async ({ broadcastRequestId, beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.recoveryCalls += 1;
    wallet.checkpoint = {
      version: 1,
      requestId: broadcastRequestId,
      userOperationHash,
      sender: CHANGE_SENDER,
      entryPointAddress: ENTRY_POINT_V08,
      journaledAt: new Date(1_000).toISOString(),
    };
    return { userOperationHash, confirmed: false };
  };
  const chain: ChainClient = {
    async assertSepolia() {},
    async getBalanceWei(address) {
      if (address.toLowerCase() === CHANGE_SENDER.toLowerCase()) return 19n;
      return address === MAIN ? 1_000n : 90n;
    },
    async getUserOperationReceiptStatus(hash, expectedSender) {
      receiptReads += 1;
      assert.equal(hash, userOperationHash);
      assert.equal(expectedSender, CHANGE_SENDER);
      return { status: "success", transactionHash };
    },
  };
  const controller = new RecoveryTransferController({
    store,
    wallet,
    chain,
    withdrawalAmountWei: 100n,
    feeReserveWei: 10n,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ recipient: RECIPIENT, amountWei: "90" });
  const submitted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "recovery-evidence-retry",
    userConfirmed: true,
  });
  wallet.failChangeAccountRecovery = true;
  const waitingForChange = await controller.getRequest(submitted.requestId);
  assert.equal(waitingForChange.phase, "submitted");
  assert.equal(waitingForChange.error?.code, "PUBLIC_CHANGE_TRACKING_PENDING");
  assert.deepEqual(waitingForChange.userOperationReceiptEvidence, {
    version: 1,
    status: "success",
    userOperationHash,
    transactionHash,
    observedAt: new Date(1_000).toISOString(),
  });
  assert.equal(receiptReads, 1);

  wallet.failChangeAccountRecovery = false;
  const restartedStore = new StateStore(join(store.path, ".."));
  await restartedStore.initialize();
  const restarted = new RecoveryTransferController({
    store: restartedStore,
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei(address) {
        if (address.toLowerCase() === CHANGE_SENDER.toLowerCase()) return 19n;
        return address === MAIN ? 1_000n : 90n;
      },
      async getUserOperationReceiptStatus() {
        receiptReads += 1;
        throw new Error("receipt provider unavailable after restart");
      },
    },
    withdrawalAmountWei: 100n,
    feeReserveWei: 10n,
    clock: { now: () => new Date(2_000) },
  });
  const confirmed = await restarted.getRequest(submitted.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.publicChangeWei, "19");
  assert.equal(confirmed.confirmation?.method, "user_operation_receipt");
  assert.equal(receiptReads, 1);
  assert.equal(wallet.recoveryCalls, 1);
  assert.deepEqual(await restarted.getRequest(submitted.requestId), confirmed);
  const state = await store.read();
  const profile = state.wallet!.profiles[state.wallet!.activeWalletId]!;
  const pocket = profile.privateBalances[confirmed.privateBalanceId!]!;
  assert.equal(pocket.balanceWei, "0");
  assert.equal(Object.keys(pocket.publicChangeAccounts ?? {}).length, 1);
});

test("recovery hydrates a crash-journal hash and restores a reverted reservation once", async () => {
  const store = await readyStore();
  const wallet = new CancellationWallet();
  const userOperationHash = `0x${"43".repeat(32)}`;
  const transactionHash = `0x${"44".repeat(32)}`;
  wallet.executeRecoveryTransfer = async ({ broadcastRequestId, beforeBroadcast }) => {
    await beforeBroadcast();
    wallet.recoveryCalls += 1;
    wallet.checkpoint = {
      version: 1,
      requestId: broadcastRequestId,
      userOperationHash,
      sender: CHANGE_SENDER,
      entryPointAddress: ENTRY_POINT_V08,
      journaledAt: new Date(1_000).toISOString(),
    };
    return { confirmed: false };
  };
  const controller = new RecoveryTransferController({
    store,
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei(address) { return address === MAIN ? 1_000n : 0n; },
      async getUserOperationReceiptStatus(hash, expectedSender) {
        assert.equal(hash, userOperationHash);
        assert.equal(expectedSender, CHANGE_SENDER);
        return { status: "reverted", transactionHash };
      },
    },
    withdrawalAmountWei: 100n,
    feeReserveWei: 10n,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ recipient: RECIPIENT, amountWei: "90" });
  const interrupted = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "journaled-reverted-recovery",
    userConfirmed: true,
  });
  assert.equal(interrupted.phase, "indeterminate");
  assert.equal(interrupted.userOperationHash, undefined);

  const failed = await controller.getRequest(interrupted.requestId);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.userOperationHash, userOperationHash);
  assert.equal(failed.transactionHash, transactionHash);
  assert.deepEqual(failed.userOperationReceiptEvidence, {
    version: 1,
    status: "reverted",
    userOperationHash,
    transactionHash,
    observedAt: new Date(1_000).toISOString(),
  });
  assert.equal(failed.error?.code, "RECOVERY_TRANSACTION_REVERTED");
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
    "100",
  );
  assert.equal(wallet.recoveryCalls, 1);
});

test("a newer policy preview supersedes the old exact decision", async () => {
  const store = await readyStore();
  let now = 1_000;
  const controller = new WalletPolicyController({
    store,
    defaultTtlMs: 86_400_000,
    clock: { now: () => new Date(now) },
  });
  const first = await controller.plan({ maxPayments: 9 });
  now += 1_000;
  const second = await controller.plan({ maxPayments: 8 });

  const superseded = await controller.getPlan(first.decisionId);
  assert.equal(superseded.decision, "deny");
  assert.ok(superseded.blockers.includes("SUPERSEDED_BY_NEW_PREVIEW"));
  assert.equal((await controller.getLatestPlan()).decisionId, second.decisionId);
  await assert.rejects(
    controller.apply({ decisionId: first.decisionId, userConfirmed: true }),
    /POLICY_DECISION_DENIED/,
  );
  const receipt = await controller.apply({
    decisionId: second.decisionId,
    userConfirmed: true,
  });
  assert.equal(receipt.decisionId, second.decisionId);
  assert.equal(receipt.policy.maxPayments, 8);
});

test("an explicitly cancelled policy preview cannot later be applied", async () => {
  const controller = new WalletPolicyController({
    store: await readyStore(),
    defaultTtlMs: 86_400_000,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ maxPayments: 9 });

  const cancelled = await controller.cancel(plan.decisionId);
  assert.equal(cancelled.decision, "deny");
  assert.ok(cancelled.blockers.includes("USER_CANCELLED"));
  await assert.rejects(
    controller.apply({ decisionId: plan.decisionId, userConfirmed: true }),
    /POLICY_DECISION_CANCELLED/,
  );
  await assert.rejects(controller.getLatestPlan(), /POLICY_DECISION_NOT_FOUND/);
});

test("a cancelled reauthorization plan cannot later mint authority", async () => {
  const store = await readyStore();
  const state = await store.read();
  const profile = await store.activeWalletProfile();
  assert.ok(profile.authorizationId);
  assert.ok(state.onboarding);
  const currentPolicy = {
    ...state.onboarding.delegation,
    paymentsUsed: 0,
    paymentsRemaining: state.onboarding.delegation.maxPayments,
  };
  const now = new Date();
  const plan: WalletReauthorizationPlan = {
    version: 1,
    decisionId: "wra_cancelled_plan",
    wallet: {
      walletId: profile.walletId,
      walletName: profile.name,
      selectionEpoch: profile.selectionEpoch,
    },
    priorAuthorizationId: profile.authorizationId,
    currentPolicy,
    proposedPolicy: currentPolicy,
    authorizationEffect: "replace",
    counterEffect: "reset_spend_and_payment_count",
    intentDigest: `sha256:${"a".repeat(64)}`,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    decision: "allow",
    blockers: [],
    approval: { action: "confirm", userConfirmationRequired: true },
  };
  await store.storeReauthorizationPlan(plan);

  const cancelled = await store.cancelReauthorizationPlan(plan.decisionId);
  assert.equal(cancelled.decision, "deny");
  assert.ok(cancelled.blockers.includes("USER_CANCELLED"));
  await assert.rejects(
    store.applyReauthorizationPlan(plan.decisionId),
    /REAUTHORIZATION_DECISION_CANCELLED/,
  );
  assert.equal((await store.activeWalletProfile()).authorizationId, profile.authorizationId);
});

test("a private-payment decision is single-use across client request IDs", async () => {
  const store = await readyStore();
  const wallet = new CancellationWallet();
  const controller = new PaymentController({
    store,
    wallet,
    withdrawalAmountWei: 100n,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ recipient: RECIPIENT, amountWei: "10" });
  const first = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "private-replay-same",
    userConfirmed: true,
  });
  const sameRequest = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "private-replay-same",
    userConfirmed: true,
  });

  assert.equal(sameRequest.requestId, first.requestId);
  await assert.rejects(
    controller.execute({
      decisionId: plan.decisionId,
      clientRequestId: "private-replay-different",
      userConfirmed: true,
    }),
    /DECISION_ALREADY_CONSUMED/,
  );
  assert.equal(wallet.privateCalls, 1);
  assert.equal(Object.keys((await store.read()).requests).length, 1);
});

test("a regular-transfer decision is single-use across client request IDs", async () => {
  const store = await readyStore();
  const wallet = new CancellationWallet();
  const controller = new RegularTransferController({
    store,
    wallet,
    chain: new CancellationChain(),
    gasReserveWei: 1n,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ recipient: RECIPIENT, amountWei: "66" });
  const first = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "regular-replay-same",
    userConfirmed: true,
  });
  const sameRequest = await controller.execute({
    decisionId: plan.decisionId,
    clientRequestId: "regular-replay-same",
    userConfirmed: true,
  });

  assert.equal(sameRequest.requestId, first.requestId);
  await assert.rejects(
    controller.execute({
      decisionId: plan.decisionId,
      clientRequestId: "regular-replay-different",
      userConfirmed: true,
    }),
    /REGULAR_TRANSFER_DECISION_ALREADY_CONSUMED/,
  );
  assert.equal(wallet.regularCalls, 1);
  assert.equal(Object.keys((await store.read()).regularRequests).length, 1);
});
