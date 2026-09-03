import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WalletPolicyController } from "../src/policy.js";
import { StateStore } from "../src/state/store.js";

async function policyStore(options: {
  expired?: boolean;
  maxPayments?: number;
  spentWei?: string;
} = {}): Promise<StateStore> {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-policy-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.update((draft) => {
    draft.onboarding = {
      version: 1,
      setupId: "setup-policy",
      revision: 1,
      phase: "private_ready",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      address: "0x1111111111111111111111111111111111111111",
      publicBalanceWei: "0",
      privateBalanceWei: "10000000000000000000",
      requiredFundingWei: "200000000000000000",
      shieldAmountWei: "100000000000000000",
      delegation: {
        mode: "testnet_delegated",
        chainId: 11_155_111,
        perPaymentLimitWei: "50000000000000000",
        lifetimeLimitWei: "50000000000000000",
        spentWei: options.spentWei ?? "0",
        maxPayments: options.maxPayments ?? 1,
        expiresAt: new Date(options.expired ? 500 : 86_400_000).toISOString(),
        enabled: true,
      },
    };
  });
  return store;
}

test("wallet policy changes are previewed, confirmed, atomic, and idempotent", async () => {
  const store = await policyStore();
  const controller = new WalletPolicyController({
    store,
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: { now: () => new Date(1_000) },
  });

  const plan = await controller.plan({
    perPaymentLimitWei: "1000000000000000000",
    maxPayments: 10,
  });
  assert.equal(plan.decision, "allow");
  assert.equal(plan.proposed.perPaymentLimitWei, "1000000000000000000");
  assert.equal(plan.proposed.lifetimeLimitWei, "10000000000000000000");
  assert.equal(plan.proposed.maxPayments, 10);
  assert.equal(plan.proposed.paymentsRemaining, 10);

  await assert.rejects(
    controller.apply({ decisionId: plan.decisionId, userConfirmed: false }),
    /must confirm/,
  );
  const first = await controller.apply({
    decisionId: plan.decisionId,
    userConfirmed: true,
  });
  const second = await controller.apply({
    decisionId: plan.decisionId,
    userConfirmed: true,
  });
  assert.deepEqual(second, first);
  assert.equal((await controller.get()).maxPayments, 10);
});

test("an expired permission renews when its limits change", async () => {
  const controller = new WalletPolicyController({
    store: await policyStore({ expired: true }),
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ maxPayments: 10 });
  assert.equal(plan.decision, "allow");
  assert.equal(
    plan.proposed.expiresAt,
    new Date(1_000 + 7 * 24 * 60 * 60_000).toISOString(),
  );
});

test("policy updates cannot erase used authority or exceed testnet bounds", async () => {
  const store = await policyStore({
    maxPayments: 10,
    spentWei: "1000000000000000000",
  });
  await store.update((draft) => {
    draft.requests.req_used = {
      version: 1,
      requestId: "req_used",
      clientRequestId: "hermes:used-payment",
      decisionId: "wd_used",
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei: "1000000000000000000",
      phase: "confirmed",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  });
  const controller = new WalletPolicyController({
    store,
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: { now: () => new Date(1_000) },
  });
  const tooSmall = await controller.plan({
    maxPayments: 1,
    lifetimeLimitWei: "1",
  });
  assert.equal(tooSmall.decision, "deny");
  assert.ok(tooSmall.blockers.includes("LIFETIME_BELOW_SPENT"));

  const tooLarge = await controller.plan({ maxPayments: 101 });
  assert.equal(tooLarge.decision, "deny");
  assert.ok(tooLarge.blockers.includes("HARD_MAX_PAYMENTS"));
});

test("applying a stale policy preview fails closed", async () => {
  const store = await policyStore({ maxPayments: 10 });
  const controller = new WalletPolicyController({
    store,
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ maxPayments: 9 });
  await store.update((draft) => {
    draft.requests.req_new = {
      version: 1,
      requestId: "req_new",
      clientRequestId: "hermes:new-payment",
      decisionId: "wd_new",
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei: "1",
      phase: "indeterminate",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  });
  await assert.rejects(
    controller.apply({ decisionId: plan.decisionId, userConfirmed: true }),
    /POLICY_CHANGED_REFRESH_PLAN/,
  );
});

