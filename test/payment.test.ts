import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChainClient, WalletAdapter } from "../src/contracts.js";
import { PaymentController } from "../src/payment.js";
import { StateStore } from "../src/state/store.js";

class PaymentWallet implements WalletAdapter {
  calls = 0;
  privateBalance = 100_000_000_000_000_000n;
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
  async executePrivatePayment(): Promise<{
    transactionHash: string;
    confirmed: boolean;
  }> {
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
  assert.ok(laterPlan.blockers.includes("DELEGATION_ALREADY_USED"));
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

test("private payment confirms delivery from the recipient balance delta", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  wallet.executePrivatePayment = async () => {
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

  assert.equal(request.phase, "confirmed");
  assert.equal(networkAssertions, 2);
});

test("restart marks an interrupted payment indeterminate without restoring authority", async () => {
  const store = await readyStore();
  await store.update((draft) => {
    draft.requests.req_interrupted = {
      version: 1,
      requestId: "req_interrupted",
      clientRequestId: "hermes:wd_interrupted",
      decisionId: "wd_interrupted",
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei: "20000000000000000",
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
  assert.equal(request.phase, "indeterminate");
  assert.equal(request.error?.code, "EXECUTION_INTERRUPTED");
  const plan = await controller.plan({
    recipient: "0x3333333333333333333333333333333333333333",
    amountWei: "10000000000000000",
  });
  assert.equal(plan.decision, "deny");
  assert.ok(plan.blockers.includes("DELEGATION_ALREADY_USED"));
});

test("an adapter error after authority handoff remains indeterminate", async () => {
  const store = await readyStore();
  const wallet = new PaymentWallet();
  wallet.executePrivatePayment = async () => {
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
  wallet.executePrivatePayment = async () => {
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
      mutate: async (store: StateStore, wallet: PaymentWallet) => {
        void wallet;
        await store.update((draft) => {
          if (draft.onboarding) {
            draft.onboarding.delegation.expiresAt = new Date(1_500).toISOString();
          }
        });
      },
      expected: /DELEGATION_EXPIRED/,
    },
    {
      name: "expired decision after live refresh",
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
      mutate: async (_store: StateStore, wallet: PaymentWallet) => {
        wallet.privateBalance = 1n;
      },
      expected: /INSUFFICIENT_PRIVATE_BALANCE/,
    },
  ];

  for (const scenario of scenarios) {
    const store = await readyStore();
    const wallet = new PaymentWallet();
    nowMs = 1_000;
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
