import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChainClient, WalletAdapter } from "../src/contracts.js";
import { PaymentController } from "../src/payment.js";
import { RegularTransferController } from "../src/regular-transfer.js";
import { StateStore } from "../src/state/store.js";

const MAIN = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"ab".repeat(32)}`;

class RegularWallet implements WalletAdapter {
  calls = 0;
  async ensureWallet(): Promise<void> {}
  async nextFreshAddress(): Promise<string> { return MAIN; }
  async prewarmPrivacy(): Promise<void> {}
  async shieldWei(): Promise<Record<string, never>> { return {}; }
  async getPrivateBalanceWei(): Promise<bigint> { return 100_000_000_000_000_000n; }
  async executePrivatePayment(): Promise<Record<string, never>> { return {}; }
  async executeRegularTransfer(_input: {
    recipient: string;
    amountWei: bigint;
  }): Promise<{ transactionHash: string; confirmed: boolean }> {
    this.calls += 1;
    return { transactionHash: TX_HASH, confirmed: true };
  }
}

class RegularChain implements ChainClient {
  readonly balances = new Map<string, bigint>([
    [MAIN, 70_000_000_000_000_000_000n],
    [RECIPIENT, 0n],
  ]);
  getTransactionReceiptStatus?: (
    transactionHash: string,
  ) => Promise<"pending" | "success" | "reverted">;
  async assertSepolia(): Promise<void> {}
  async getBalanceWei(address: string): Promise<bigint> {
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
        lifetimeLimitWei: "1000000000000000000000",
        spentWei: "0",
        maxPayments,
        expiresAt: new Date(86_400_000).toISOString(),
        enabled: true,
      },
    };
  });
  return store;
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

test("regular transfer confirms from recipient balance movement", async () => {
  const store = await readyStore();
  const wallet = new RegularWallet();
  const chain = new RegularChain();
  wallet.executeRegularTransfer = async ({ amountWei }) => {
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
  assert.equal(request.phase, "confirmed");
  assert.equal(request.confirmation?.method, "recipient_balance_delta");
  assert.equal(wallet.calls, 1);
});

test("regular transfer reconciles a pending hash without rebroadcasting", async () => {
  const store = await readyStore();
  const wallet = new RegularWallet();
  wallet.executeRegularTransfer = async () => {
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

test("a reverted regular transfer stays failed and still consumes authority", async () => {
  const store = await readyStore(1);
  const wallet = new RegularWallet();
  wallet.executeRegularTransfer = async () => {
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
  assert.equal(wallet.calls, 1);

  const later = await controller.plan({
    recipient: "0x3333333333333333333333333333333333333333",
    amountWei: "1",
  });
  assert.equal(later.decision, "deny");
  assert.ok(later.blockers.includes("PAYMENT_COUNT_LIMIT"));
});

test("restart makes an interrupted regular transfer indeterminate without retrying", async () => {
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
    draft.regularRequests.rreq_interrupted = {
      version: 1,
      requestId: "rreq_interrupted",
      clientRequestId: "hermes:rwd_interrupted",
      decisionId: plan.decisionId,
      recipient: RECIPIENT,
      amountWei: plan.amountWei,
      gasReserveWei: plan.gasReserveWei,
      authorization: plan.authorization,
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
  assert.equal(request.phase, "indeterminate");
  assert.equal(request.error?.code, "EXECUTION_INTERRUPTED");
  assert.equal(wallet.calls, 0);
  const later = await restarted.plan({
    recipient: "0x3333333333333333333333333333333333333333",
    amountWei: "1",
  });
  assert.equal(later.decision, "deny");
  assert.ok(later.blockers.includes("PAYMENT_COUNT_LIMIT"));
});

test("an adapter error leaves the regular transfer indeterminate and idempotent", async () => {
  const store = await readyStore();
  const wallet = new RegularWallet();
  wallet.executeRegularTransfer = async () => {
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
