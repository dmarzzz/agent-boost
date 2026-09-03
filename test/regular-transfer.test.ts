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
  async executeRegularTransfer(): Promise<{ transactionHash: string; confirmed: boolean }> {
    this.calls += 1;
    return { transactionHash: TX_HASH, confirmed: true };
  }
}

class RegularChain implements ChainClient {
  readonly balances = new Map<string, bigint>([
    [MAIN, 70_000_000_000_000_000_000n],
    [RECIPIENT, 0n],
  ]);
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
