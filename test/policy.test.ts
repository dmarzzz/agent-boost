import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { PrivateBalancePolicyController } from "../src/private-balance-policy.js";
import { WalletPolicyController } from "../src/policy.js";
import { StateStore } from "../src/state/store.js";
import { seedRegularRequestFixture } from "./helpers/private-regular-fixture.js";

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
        lifetimeLimitWei: options.spentWei === undefined
          ? "50000000000000000"
          : "1000000000000000000",
        spentWei: options.spentWei ?? "0",
        maxPayments: options.maxPayments ?? 1,
        expiresAt: new Date(options.expired ? 500 : 86_400_000).toISOString(),
        enabled: true,
      },
    };
  });
  return store;
}

async function addHistoricalRequest(
  store: StateStore,
  input: {
    requestId: string;
    decisionId: string;
    clientRequestId: string;
    phase: "confirmed" | "failed" | "indeterminate";
  },
): Promise<void> {
  const profile = await store.activeWalletProfile();
  const authorization = {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
    authorizationId: profile.authorizationId!,
  };
  const privateBalance = Object.values(profile.privateBalances)[0]!;
  const amountWei = input.phase === "confirmed" ? "1000000000000000000" : "1";
  await store.update((draft) => {
    draft.plans[input.decisionId] = {
      version: 1,
      decisionId: input.decisionId,
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei,
      authorization,
      privateBalanceId: privateBalance.privateBalanceId,
      privateBalanceRevision: privateBalance.revision,
      privateBalanceDebitWei: amountWei,
      intentDigest: `sha256:${"0".repeat(64)}`,
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(86_400_000).toISOString(),
      decision: "allow",
      blockers: [],
      approval: { action: "confirm", userConfirmationRequired: true },
    };
    draft.requests[input.requestId] = {
      version: 1,
      requestId: input.requestId,
      clientRequestId: input.clientRequestId,
      decisionId: input.decisionId,
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei,
      authorization,
      privateBalanceId: privateBalance.privateBalanceId,
      privateBalanceRevision: privateBalance.revision,
      privateBalanceDebitWei: amountWei,
      ...(input.phase === "indeterminate"
        ? {
            privateBalanceDebitedAt: new Date(0).toISOString(),
          }
        : {}),
      phase: input.phase,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  });
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

test("a denied newer preview supersedes the prior allowed preview", async () => {
  let now = 1_000;
  const controller = new WalletPolicyController({
    store: await policyStore({ maxPayments: 10 }),
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: { now: () => new Date(now) },
  });
  const allowed = await controller.plan({ maxPayments: 9 });
  now += 1_000;
  const denied = await controller.plan({ maxPayments: 101 });

  await assert.rejects(controller.getLatestPlan(), /POLICY_DECISION_NOT_FOUND/);
  const superseded = await controller.getPlan(allowed.decisionId);
  assert.equal(superseded.decision, "deny");
  assert.ok(superseded.blockers.includes("SUPERSEDED_BY_NEW_PREVIEW"));
  assert.equal((await controller.getPlan(denied.decisionId)).decision, "deny");
  await assert.rejects(
    controller.apply({
      decisionId: denied.decisionId,
      userConfirmed: true,
    }),
    /POLICY_DECISION_DENIED/,
  );
  assert.notEqual(allowed.decisionId, denied.decisionId);
});

test("policy updates cannot erase used authority or exceed testnet bounds", async () => {
  const store = await policyStore({
    maxPayments: 10,
    spentWei: "1000000000000000000",
  });
  await addHistoricalRequest(store, {
    requestId: "req_used",
    clientRequestId: "hermes:used-payment",
    decisionId: "wd_used",
    phase: "confirmed",
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

test("failed private and regular transfers do not consume policy payment count", async () => {
  const store = await policyStore({ maxPayments: 10 });
  await addHistoricalRequest(store, {
    requestId: "req_failed_private",
    clientRequestId: "hermes:failed-private",
    decisionId: "wd_failed_private",
    phase: "failed",
  });
  await seedRegularRequestFixture(store, {
    suffix: "failed_regular",
    phase: "failed",
  });

  const controller = new WalletPolicyController({
    store,
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: { now: () => new Date(1_000) },
  });
  const current = await controller.get();
  assert.equal(current.paymentsUsed, 0);
  assert.equal(current.paymentsRemaining, 10);

  const plan = await controller.plan({ maxPayments: 1 });
  assert.equal(plan.decision, "allow");
  assert.equal(plan.proposed.paymentsUsed, 0);
  assert.equal(plan.proposed.paymentsRemaining, 1);
});

test("applying a stale policy preview fails closed", async () => {
  const store = await policyStore({ maxPayments: 10 });
  const controller = new WalletPolicyController({
    store,
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({ maxPayments: 9 });
  await addHistoricalRequest(store, {
    requestId: "req_new",
    clientRequestId: "hermes:new-payment",
    decisionId: "wd_new",
    phase: "indeterminate",
  });
  await assert.rejects(
    controller.apply({ decisionId: plan.decisionId, userConfirmed: true }),
    /POLICY_CHANGED_REFRESH_PLAN/,
  );
});

test("an inactive wallet policy clamp preserves spent history and remains editable", async () => {
  const store = await policyStore({ maxPayments: 10 });
  const walletB = await store.registerManagedWallet("wallet-b", "created");
  const createdAt = new Date(0).toISOString();
  const expiresAt = new Date(86_400_000).toISOString();
  const aggregate = {
    mode: "testnet_delegated" as const,
    chainId: 11_155_111 as const,
    perPaymentLimitWei: "1000",
    lifetimeLimitWei: "10000",
    spentWei: "5000",
    maxPayments: 10,
    expiresAt,
    enabled: true,
  };
  const managed = {
    ...aggregate,
    perPaymentLimitWei: "800",
    lifetimeLimitWei: "6400",
    maxPayments: 8,
  };
  await store.update((draft) => {
    const profile = draft.wallet!.profiles[walletB.walletId]!;
    profile.selectionEpoch = 1;
    profile.lastSelectedAt = createdAt;
    profile.authorizationId = "auth_wallet-b";
    profile.onboarding = {
      ...structuredClone(draft.onboarding!),
      setupId: "setup_wallet-b",
      revision: 1,
      address: "0x2222222222222222222222222222222222222222",
      delegation: aggregate,
    };
    profile.privateBalances.pb_managed_b = {
      version: 1,
      privateBalanceId: "pb_managed_b",
      name: "managed",
      backendWalletName: "abpb-wallet-b-managed",
      status: "available",
      balanceWei: "1000",
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      delegation: managed,
      publicChangeAccounts: {},
    };
    const binding = {
      walletId: profile.walletId,
      walletName: profile.name,
      selectionEpoch: profile.selectionEpoch,
      privateBalanceId: "pb_managed_b",
      privateBalanceName: "managed",
      backendWalletName: "abpb-wallet-b-managed",
      privateBalanceRevision: 1,
    };
    const authorization = {
      walletId: profile.walletId,
      walletName: profile.name,
      selectionEpoch: profile.selectionEpoch,
      authorizationId: profile.authorizationId,
    };
    draft.plans.wd_managed_spend_b = {
      version: 1,
      decisionId: "wd_managed_spend_b",
      recipient: "0x3333333333333333333333333333333333333333",
      amountWei: "5000",
      authorization,
      privateBalanceId: binding.privateBalanceId,
      privateBalanceRevision: binding.privateBalanceRevision,
      privateBalanceDebitWei: "5000",
      intentDigest: `sha256:${"6".repeat(64)}`,
      createdAt,
      expiresAt,
      decision: "allow",
      blockers: [],
      approval: { action: "confirm", userConfirmationRequired: true },
    };
    draft.requests.req_managed_spend_b = {
      version: 1,
      requestId: "req_managed_spend_b",
      clientRequestId: "client:managed-spend-b",
      decisionId: "wd_managed_spend_b",
      recipient: "0x3333333333333333333333333333333333333333",
      amountWei: "5000",
      authorization,
      privateBalanceId: binding.privateBalanceId,
      privateBalanceRevision: binding.privateBalanceRevision,
      privateBalanceDebitWei: "5000",
      phase: "confirmed",
      createdAt,
      updatedAt: createdAt,
    };
    const managedSnapshot = {
      ...managed,
      paymentsUsed: 1,
      paymentsRemaining: managed.maxPayments - 1,
    };
    draft.privateBalancePolicyUpdatePlans.pbpu_managed_b = {
      version: 1,
      decisionId: "pbpu_managed_b",
      privateBalance: binding,
      current: managedSnapshot,
      proposed: managedSnapshot,
      intentDigest: `sha256:${"7".repeat(64)}`,
      createdAt,
      expiresAt,
      decision: "allow",
      blockers: [],
      approval: { action: "confirm", userConfirmationRequired: true },
      consumedByRequestId: "pbpur_managed_b",
      appliedAt: createdAt,
      appliedPolicy: managedSnapshot,
    };
    draft.privateBalancePolicyUpdateRequests.pbpur_managed_b = {
      version: 1,
      requestId: "pbpur_managed_b",
      clientRequestId: "client:managed-b-policy",
      decisionId: "pbpu_managed_b",
      privateBalance: binding,
      phase: "applied",
      createdAt,
      updatedAt: createdAt,
      appliedAt: createdAt,
      policy: managedSnapshot,
    };
  });

  const before = await store.read();
  const activeWalletId = before.wallet!.activeWalletId;
  const activeProfile = structuredClone(before.wallet!.profiles[activeWalletId]);
  const managedHistory = structuredClone({
    plan: before.privateBalancePolicyUpdatePlans.pbpu_managed_b,
    request: before.privateBalancePolicyUpdateRequests.pbpur_managed_b,
  });
  const childController = new PrivateBalancePolicyController({
    store,
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: { now: () => new Date(1_000) },
  });
  const staleChildPlan = await childController.plan({
    walletId: walletB.walletId,
    privateBalanceId: "pb_managed_b",
    enabled: false,
  });
  assert.equal(staleChildPlan.decision, "allow", JSON.stringify(staleChildPlan.blockers));
  const controller = new WalletPolicyController({
    store,
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: { now: () => new Date(1_000) },
  });
  const plan = await controller.plan({
    walletId: walletB.walletId,
    perPaymentLimitWei: "400",
  });
  assert.equal(plan.wallet.walletId, walletB.walletId);
  assert.equal(plan.wallet.walletName, "wallet-b");
  assert.equal(plan.decision, "allow", JSON.stringify(plan.blockers));
  assert.equal(plan.proposed.lifetimeLimitWei, "5000");
  assert.equal(plan.proposed.spentWei, "5000");
  const receipt = await controller.apply({
    decisionId: plan.decisionId,
    userConfirmed: true,
  });
  assert.deepEqual(receipt.wallet, plan.wallet);

  const after = await store.read();
  assert.equal(after.wallet!.activeWalletId, activeWalletId);
  assert.deepEqual(after.wallet!.profiles[activeWalletId], activeProfile);
  const updatedB = after.wallet!.profiles[walletB.walletId]!;
  const expectedAggregate = {
    ...aggregate,
    perPaymentLimitWei: "400",
    lifetimeLimitWei: "5000",
  };
  assert.deepEqual(updatedB.onboarding!.delegation, expectedAggregate);
  assert.deepEqual(
    updatedB.privateBalances[updatedB.defaultPrivateBalanceId]!.delegation,
    expectedAggregate,
  );
  assert.deepEqual(updatedB.privateBalances.pb_managed_b!.delegation, {
    ...managed,
    perPaymentLimitWei: "400",
    lifetimeLimitWei: "5000",
  });
  assert.deepEqual({
    plan: after.privateBalancePolicyUpdatePlans.pbpu_managed_b,
    request: after.privateBalancePolicyUpdateRequests.pbpur_managed_b,
  }, managedHistory);

  await assert.rejects(
    childController.apply({
      decisionId: staleChildPlan.decisionId,
      clientRequestId: "client:stale-managed-b",
      userConfirmed: true,
    }),
    /PRIVATE_BALANCE_CHANGED_REFRESH_PLAN/u,
  );

  const restartedStore = new StateStore(dirname(store.path));
  await restartedStore.initialize();
  const restartedWalletController = new WalletPolicyController({
    store: restartedStore,
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: { now: () => new Date(1_000) },
  });
  const exhaustedWalletPolicy = await restartedWalletController.get(walletB.walletId);
  assert.equal(exhaustedWalletPolicy.perPaymentLimitWei, "400");
  assert.equal(exhaustedWalletPolicy.lifetimeLimitWei, "5000");
  assert.equal(exhaustedWalletPolicy.spentWei, "5000");
  assert.equal(exhaustedWalletPolicy.paymentsUsed, 1);
  const laterParentTtlEdit = await restartedWalletController.plan({
    walletId: walletB.walletId,
    ttlMs: 20_000,
  });
  assert.equal(
    laterParentTtlEdit.decision,
    "allow",
    JSON.stringify(laterParentTtlEdit.blockers),
  );
  await restartedWalletController.apply({
    decisionId: laterParentTtlEdit.decisionId,
    userConfirmed: true,
  });
  const aboveParentHistoricalFloor = await restartedWalletController.plan({
    walletId: walletB.walletId,
    lifetimeLimitWei: "5001",
  });
  assert.equal(aboveParentHistoricalFloor.decision, "deny");
  assert.ok(
    aboveParentHistoricalFloor.blockers.includes("LIFETIME_EXCEEDS_PAYMENT_ENVELOPE"),
  );
  const restartedController = new PrivateBalancePolicyController({
    store: restartedStore,
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: { now: () => new Date(1_000) },
  });
  const ordinaryChildEdit = await restartedController.plan({
    walletId: walletB.walletId,
    privateBalanceId: "pb_managed_b",
    enabled: false,
  });
  assert.equal(
    ordinaryChildEdit.decision,
    "allow",
    JSON.stringify(ordinaryChildEdit.blockers),
  );
  assert.equal(ordinaryChildEdit.current.lifetimeLimitWei, "5000");
  assert.equal(ordinaryChildEdit.current.spentWei, "5000");
  assert.equal(ordinaryChildEdit.current.paymentsUsed, 1);
  assert.equal(ordinaryChildEdit.current.paymentsRemaining, 7);
  assert.equal(ordinaryChildEdit.proposed.lifetimeLimitWei, "5000");
  await restartedController.apply({
    decisionId: ordinaryChildEdit.decisionId,
    clientRequestId: "client:disable-managed-b",
    userConfirmed: true,
  });
  const directChildTightening = await restartedController.plan({
    walletId: walletB.walletId,
    privateBalanceId: "pb_managed_b",
    perPaymentLimitWei: "300",
  });
  assert.equal(
    directChildTightening.decision,
    "allow",
    JSON.stringify(directChildTightening.blockers),
  );
  assert.equal(directChildTightening.proposed.lifetimeLimitWei, "5000");
  assert.equal(directChildTightening.proposed.spentWei, "5000");
  await restartedController.apply({
    decisionId: directChildTightening.decisionId,
    clientRequestId: "client:tighten-managed-b",
    userConfirmed: true,
  });
  const exhaustedPolicy = await restartedController.get({
    walletId: walletB.walletId,
    privateBalanceId: "pb_managed_b",
  });
  assert.equal(exhaustedPolicy.policy.perPaymentLimitWei, "300");
  assert.equal(exhaustedPolicy.policy.lifetimeLimitWei, "5000");
  assert.equal(exhaustedPolicy.policy.spentWei, "5000");
  assert.equal(exhaustedPolicy.policy.paymentsUsed, 1);
  const laterTtlEdit = await restartedController.plan({
    walletId: walletB.walletId,
    privateBalanceId: "pb_managed_b",
    ttlMs: 10_000,
  });
  assert.equal(laterTtlEdit.decision, "allow", JSON.stringify(laterTtlEdit.blockers));
  await restartedController.apply({
    decisionId: laterTtlEdit.decisionId,
    clientRequestId: "client:renew-managed-b",
    userConfirmed: true,
  });
  const aboveHistoricalFloor = await restartedController.plan({
    walletId: walletB.walletId,
    privateBalanceId: "pb_managed_b",
    lifetimeLimitWei: "5001",
  });
  assert.equal(aboveHistoricalFloor.decision, "deny");
  assert.ok(
    aboveHistoricalFloor.blockers.includes("LIFETIME_EXCEEDS_PAYMENT_ENVELOPE"),
  );
  const durable = await restartedStore.read();
  assert.equal(durable.wallet!.activeWalletId, activeWalletId);
  assert.deepEqual(durable.wallet!.profiles[activeWalletId], activeProfile);
  assert.deepEqual(
    durable.wallet!.profiles[walletB.walletId]!.privateBalances.pb_managed_b!.delegation,
    {
      ...managed,
      perPaymentLimitWei: "300",
      lifetimeLimitWei: "5000",
      expiresAt: new Date(11_000).toISOString(),
      enabled: false,
    },
  );
});

test("reauthorization atomically invalidates only that wallet's pending child-policy previews", async () => {
  const store = await policyStore({ maxPayments: 10 });
  const walletA = await store.activeWalletProfile();
  const walletB = await store.registerManagedWallet("wallet-b", "created");
  const policyClock = { now: () => new Date(1_000) };
  await store.update((draft) => {
    const profile = draft.wallet!.profiles[walletB.walletId]!;
    profile.selectionEpoch = 1;
    profile.lastSelectedAt = new Date(0).toISOString();
    profile.authorizationId = "auth_wallet-b";
    profile.onboarding = {
      ...structuredClone(draft.onboarding!),
      setupId: "setup_wallet-b",
      revision: 1,
      address: "0x2222222222222222222222222222222222222222",
    };
  });

  const childController = new PrivateBalancePolicyController({
    store,
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: policyClock,
  });
  const makeManaged = async (walletId: string, privateBalanceId: string, suffix: string) => {
    const plan = await childController.plan({
      walletId,
      privateBalanceId,
      maxPayments: 5,
      lifetimeLimitWei: "50000000000000000",
    });
    assert.equal(plan.decision, "allow", JSON.stringify(plan.blockers));
    await childController.apply({
      decisionId: plan.decisionId,
      clientRequestId: `client:manage-${suffix}`,
      userConfirmed: true,
    });
  };
  const initialized = await store.read();
  const initializedA = initialized.wallet!.profiles[walletA.walletId]!;
  const initializedB = initialized.wallet!.profiles[walletB.walletId]!;
  await makeManaged(
    initializedA.walletId,
    initializedA.defaultPrivateBalanceId,
    "wallet-a",
  );
  await makeManaged(
    initializedB.walletId,
    initializedB.defaultPrivateBalanceId,
    "wallet-b",
  );

  const pendingA = await childController.plan({
    walletId: initializedA.walletId,
    privateBalanceId: initializedA.defaultPrivateBalanceId,
    enabled: false,
  });
  const pendingB = await childController.plan({
    walletId: initializedB.walletId,
    privateBalanceId: initializedB.defaultPrivateBalanceId,
    enabled: false,
  });
  assert.equal(pendingA.decision, "allow");
  assert.equal(pendingB.decision, "allow");

  const beforeReauthorization = await store.read();
  const active = beforeReauthorization.wallet!.profiles[walletA.walletId]!;
  const priorAuthorizationId = active.authorizationId;
  assert.ok(priorAuthorizationId);
  const childRevision = active.privateBalances[active.defaultPrivateBalanceId]!.revision;
  const currentPolicy = {
    ...beforeReauthorization.onboarding!.delegation,
    paymentsUsed: 0,
    paymentsRemaining: beforeReauthorization.onboarding!.delegation.maxPayments,
  };
  const now = new Date();
  const proposedPolicy = {
    ...currentPolicy,
    spentWei: "0",
    paymentsUsed: 0,
    paymentsRemaining: currentPolicy.maxPayments,
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  };
  await store.storeReauthorizationPlan({
    version: 1,
    decisionId: "reauthorize_wallet_a_with_pending_child_plan",
    wallet: {
      walletId: active.walletId,
      walletName: active.name,
      selectionEpoch: active.selectionEpoch,
    },
    priorAuthorizationId,
    currentPolicy,
    proposedPolicy,
    authorizationEffect: "replace",
    counterEffect: "reset_spend_and_payment_count",
    intentDigest: `sha256:${"8".repeat(64)}`,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    decision: "allow",
    blockers: [],
    approval: { action: "confirm", userConfirmationRequired: true },
  });

  let releaseStaleRead!: () => void;
  let staleReadCaptured!: () => void;
  const staleReadGate = new Promise<void>((resolve) => {
    releaseStaleRead = resolve;
  });
  const staleReadObserved = new Promise<void>((resolve) => {
    staleReadCaptured = resolve;
  });
  const originalRead = store.read.bind(store);
  let pauseNextRead = true;
  Object.defineProperty(store, "read", {
    configurable: true,
    writable: true,
    value: async () => {
      const snapshot = await originalRead();
      if (pauseNextRead) {
        pauseNextRead = false;
        staleReadCaptured();
        await staleReadGate;
      }
      return snapshot;
    },
  });
  const racingPlan = childController.plan({
    walletId: initializedA.walletId,
    privateBalanceId: initializedA.defaultPrivateBalanceId,
    ttlMs: 20_000,
  });
  await staleReadObserved;
  await store.applyReauthorizationPlan(
    "reauthorize_wallet_a_with_pending_child_plan",
  );
  releaseStaleRead();
  await assert.rejects(racingPlan, /WALLET_REAUTHORIZED_REFRESH_PLAN/u);
  Object.defineProperty(store, "read", {
    configurable: true,
    writable: true,
    value: originalRead,
  });

  const afterReauthorization = await store.read();
  const reauthorizedA = afterReauthorization.wallet!.profiles[walletA.walletId]!;
  assert.notEqual(reauthorizedA.authorizationId, priorAuthorizationId);
  assert.equal(
    reauthorizedA.privateBalances[reauthorizedA.defaultPrivateBalanceId]!.revision,
    childRevision,
    "the regression requires an otherwise unchanged managed child",
  );
  assert.ok(
    Date.parse(
      reauthorizedA.privateBalances[reauthorizedA.defaultPrivateBalanceId]!
        .delegation.expiresAt,
    ) < Date.parse(reauthorizedA.onboarding!.delegation.expiresAt),
    "the managed child's earlier expiry must remain unchanged",
  );
  const invalidatedA = afterReauthorization.privateBalancePolicyUpdatePlans[
    pendingA.decisionId
  ]!;
  assert.equal(invalidatedA.decision, "deny");
  assert.ok(invalidatedA.blockers.includes("WALLET_REAUTHORIZED_REFRESH_PLAN"));
  const untouchedB = afterReauthorization.privateBalancePolicyUpdatePlans[
    pendingB.decisionId
  ]!;
  assert.equal(untouchedB.decision, "allow");
  assert.equal(untouchedB.blockers.includes("WALLET_REAUTHORIZED_REFRESH_PLAN"), false);
  await assert.rejects(
    childController.apply({
      decisionId: pendingA.decisionId,
      clientRequestId: "client:stale-after-reauthorization",
      userConfirmed: true,
    }),
    /PRIVATE_BALANCE_POLICY_DECISION_DENIED/u,
  );

  const restartedStore = new StateStore(dirname(store.path));
  await restartedStore.initialize();
  const restarted = await restartedStore.read();
  assert.ok(
    restarted.privateBalancePolicyUpdatePlans[pendingA.decisionId]!
      .blockers.includes("WALLET_REAUTHORIZED_REFRESH_PLAN"),
  );
  assert.equal(
    restarted.privateBalancePolicyUpdatePlans[pendingB.decisionId]!.decision,
    "allow",
  );
  const restartedController = new PrivateBalancePolicyController({
    store: restartedStore,
    defaultTtlMs: 7 * 24 * 60 * 60_000,
    clock: policyClock,
  });
  const appliedB = await restartedController.apply({
    decisionId: pendingB.decisionId,
    clientRequestId: "client:other-wallet-remains-valid",
    userConfirmed: true,
  });
  assert.equal(appliedB.phase, "applied");
});
