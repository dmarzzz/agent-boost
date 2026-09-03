import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ChainClient,
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

class CancellationWallet implements WalletAdapter {
  privateCalls = 0;
  regularCalls = 0;
  recoveryCalls = 0;

  async ensureWallet(): Promise<void> {}
  async nextFreshAddress(): Promise<string> { return MAIN; }
  async prewarmPrivacy(): Promise<void> {}
  async shieldWei(): Promise<Record<string, never>> { return {}; }
  async getPrivateBalanceWei(): Promise<bigint> { return 100n; }

  async executePrivatePayment(): Promise<{ confirmed: boolean }> {
    this.privateCalls += 1;
    return { confirmed: true };
  }

  async executeRegularTransfer(): Promise<{ confirmed: boolean }> {
    this.regularCalls += 1;
    return { confirmed: true };
  }

  async executeRecoveryTransfer(): Promise<{ confirmed: boolean }> {
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
