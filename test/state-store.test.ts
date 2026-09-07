import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  DelegationPolicy,
  OnboardingRecord,
  PrivateBalanceRecord,
} from "../src/contracts.js";
import { StateStore } from "../src/state/store.js";

const CREATED_AT = new Date(0).toISOString();
const UPDATED_AT = new Date(1_000).toISOString();
const EXPIRES_AT = new Date("2100-01-01T00:00:00.000Z").toISOString();

function delegation(overrides: Partial<DelegationPolicy> = {}): DelegationPolicy {
  return {
    mode: "testnet_delegated",
    chainId: 11_155_111,
    perPaymentLimitWei: "100",
    lifetimeLimitWei: "1000",
    spentWei: "0",
    maxPayments: 10,
    expiresAt: EXPIRES_AT,
    enabled: true,
    ...overrides,
  };
}

function onboarding(overrides: Partial<OnboardingRecord> = {}): OnboardingRecord {
  return {
    version: 1,
    setupId: "setup-test",
    revision: 1,
    phase: "private_ready",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    publicBalanceWei: "1000",
    privateBalanceWei: "100",
    requiredFundingWei: "200",
    shieldAmountWei: "100",
    delegation: delegation(),
    ...overrides,
  };
}

test("onboarding shield preparation and broadcast checkpoints are append-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-onboarding-checkpoint-"));
  const store = new StateStore(root);
  await store.initialize();
  const preparedDepositCall = {
    to: "0x8c4a04d872a6c1be37964a21ba3a138525dff50b",
    data: `0xb214faa5${"12".repeat(32)}`,
    valueWei: "100",
  };
  await store.update((draft) => {
    draft.onboarding = onboarding({
      phase: "shielding",
      shieldPreparedDepositCall: preparedDepositCall,
      shieldBroadcastStartedAt: UPDATED_AT,
      shieldTransactionHash: `0x${"ab".repeat(32)}`,
    });
  });

  const mutations: Array<(record: OnboardingRecord) => void> = [
    (record) => {
      record.shieldPreparedDepositCall = {
        ...preparedDepositCall,
        data: `0xb214faa5${"34".repeat(32)}`,
      };
    },
    (record) => {
      record.shieldBroadcastStartedAt = new Date(2_000).toISOString();
    },
    (record) => {
      record.shieldTransactionHash = `0x${"cd".repeat(32)}`;
    },
  ];
  for (const mutate of mutations) {
    await assert.rejects(
      store.update((draft) => mutate(draft.onboarding!)),
      /Onboarding shield checkpoint .* cannot be removed or changed/u,
    );
  }

  const unchanged = (await store.read()).onboarding!;
  assert.deepEqual(unchanged.shieldPreparedDepositCall, preparedDepositCall);
  assert.equal(unchanged.shieldBroadcastStartedAt, UPDATED_AT);
  assert.equal(unchanged.shieldTransactionHash, `0x${"ab".repeat(32)}`);
});

function isolatedPocket(input: {
  privateBalanceId: string;
  name: string;
  backendWalletName: string;
  balanceWei?: string;
}): PrivateBalanceRecord {
  return {
    version: 1,
    privateBalanceId: input.privateBalanceId,
    name: input.name,
    backendWalletName: input.backendWalletName,
    status: "available",
    balanceWei: input.balanceWei ?? "0",
    revision: 0,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    delegation: delegation({
      perPaymentLimitWei: "0",
      lifetimeLimitWei: "0",
      enabled: false,
    }),
  };
}

test("StateStore writes atomically with private permissions and wakes waiters", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-"));
  const store = new StateStore(root);
  await store.initialize();

  const waiter = store.waitForOnboardingRevision(0, 1_000);
  await store.update((draft) => {
    draft.onboarding = {
      version: 1,
      setupId: "setup-test",
      revision: 1,
      phase: "creating_wallet",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      publicBalanceWei: "0",
      privateBalanceWei: "0",
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

  assert.equal((await waiter)?.revision, 1);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(store.path, "utf8")).version, 3);
});

test("StateStore archives a complete demo before starting fresh state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-archive-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("agent-boost");
  const profile = await store.activeWalletProfile();
  const authorization = {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
    authorizationId: profile.authorizationId!,
  };
  const privateBalance = Object.values(profile.privateBalances)[0]!;
  await store.update((draft) => {
    draft.plans.wd_unresolved = {
      version: 1,
      decisionId: "wd_unresolved",
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei: "1",
      authorization,
      intentDigest: `sha256:${"0".repeat(64)}`,
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
      decision: "deny",
      blockers: ["STATE_MIGRATION_REPLAN_REQUIRED"],
      approval: { action: "deny", userConfirmationRequired: false },
    };
    draft.requests.req_unresolved = {
      version: 1,
      requestId: "req_unresolved",
      clientRequestId: "hermes:wd_unresolved",
      decisionId: "wd_unresolved",
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei: "1",
      authorization,
      privateBalanceId: privateBalance.privateBalanceId,
      privateBalanceRevision: privateBalance.revision,
      privateBalanceDebitWei: "1",
      privateBalanceDebitedAt: new Date(0).toISOString(),
      phase: "indeterminate",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  });

  const reset = await store.archiveAndReset("agent-boost-new");
  assert.equal(reset.previous.requests.req_unresolved?.phase, "indeterminate");
  assert.equal(reset.current.version, 3);
  assert.equal(reset.current.wallet?.activeName, "agent-boost-new");
  assert.deepEqual(reset.current.policyPlans, {});
  assert.deepEqual(reset.current.recoveryPlans, {});
  assert.deepEqual(reset.current.recoveryRequests, {});
  assert.deepEqual(reset.current.reauthorizationPlans, {});
  const newProfile = Object.values(reset.current.wallet?.profiles ?? {}).find(
    (profile) => profile.name === "agent-boost-new",
  );
  assert.equal(newProfile?.selectionEpoch, 1);
  assert.equal(newProfile?.authorizationId, undefined);
  const archivePath = join(root, "archives", reset.archiveId, "state.json");
  const archived = JSON.parse(await readFile(archivePath, "utf8")) as {
    requests: Record<string, { phase: string }>;
  };
  assert.equal(archived.requests.req_unresolved?.phase, "indeterminate");
  assert.equal((await stat(archivePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "archives", reset.archiveId))).mode & 0o777, 0o700);
});

test("StateStore conservatively migrates pre-policy-editor wallets", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-legacy-"));
  const store = new StateStore(root);
  await store.initialize();
  await writeFile(store.path, `${JSON.stringify({
    version: 1,
    wallet: { activeName: "agent-boost" },
    onboarding: {
      version: 1,
      setupId: "setup-legacy",
      revision: 1,
      phase: "private_ready",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      publicBalanceWei: "0",
      privateBalanceWei: "0",
      requiredFundingWei: "1",
      shieldAmountWei: "1",
      delegation: {
        mode: "testnet_delegated",
        chainId: 11_155_111,
        perPaymentLimitWei: "50000000000000000",
        lifetimeLimitWei: "50000000000000000",
        spentWei: "0",
        expiresAt: new Date(86_400_000).toISOString(),
        enabled: true,
      },
    },
    plans: {
      wd_legacy: {
        version: 1,
        decisionId: "wd_legacy",
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "1",
        intentDigest: `sha256:${"0".repeat(64)}`,
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(1).toISOString(),
        decision: "allow",
        blockers: [],
      },
    },
    requests: {
      req_legacy: {
        version: 1,
        requestId: "req_legacy",
        clientRequestId: "hermes:wd_legacy",
        decisionId: "wd_legacy",
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "1",
        phase: "indeterminate",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    },
  }, null, 2)}\n`, "utf8");

  await store.initialize();

  const migrated = await store.read();
  assert.equal(migrated.onboarding?.delegation.maxPayments, 1);
  assert.equal(migrated.plans.wd_legacy?.decision, "deny");
  assert.deepEqual(migrated.plans.wd_legacy?.approval, {
    action: "deny",
    userConfirmationRequired: false,
  });
  assert.ok(migrated.plans.wd_legacy?.authorization.authorizationId.startsWith("auth_"));
  assert.equal(
    migrated.requests.req_legacy?.authorization.authorizationId,
    migrated.plans.wd_legacy?.authorization.authorizationId,
  );
  assert.deepEqual(migrated.plans.wd_legacy?.blockers, [
    "STATE_MIGRATION_REPLAN_REQUIRED",
  ]);
  assert.deepEqual(migrated.policyPlans, {});
  const profile = migrated.wallet?.profiles[migrated.wallet.activeWalletId];
  const pocket = profile?.privateBalances[profile.defaultPrivateBalanceId];
  assert.equal(pocket?.name, "private");
  assert.equal(pocket?.backendWalletName, "agent-boost");
  assert.equal(pocket?.balanceWei, "0");
  assert.equal(migrated.plans.wd_legacy?.privateBalanceId, pocket?.privateBalanceId);
  assert.equal(migrated.plans.wd_legacy?.privateBalanceRevision, pocket?.revision);
  assert.equal(migrated.plans.wd_legacy?.privateBalanceDebitWei, "1");
  assert.equal(
    migrated.requests.req_legacy?.privateBalanceDebitWei,
    migrated.plans.wd_legacy?.privateBalanceDebitWei,
  );
});

test("StateStore atomically migrates v2 profiles to deterministic physical pockets", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-v2-"));
  const store = new StateStore(root);
  await store.initialize();
  const aggregate = onboarding({
    setupId: "setup-v2",
    revision: 7,
    privateBalanceWei: "300",
    delegation: delegation({ spentWei: "20" }),
  });
  await writeFile(store.path, `${JSON.stringify({
    version: 2,
    wallet: {
      activeWalletId: "wallet_existing",
      activeName: "primary",
      profiles: {
        wallet_existing: {
          version: 1,
          walletId: "wallet_existing",
          name: "primary",
          origin: "adopted",
          status: "available",
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          lastSelectedAt: UPDATED_AT,
          selectionEpoch: 3,
          authorizationId: "auth_existing",
          archiveIds: [],
          onboarding: aggregate,
        },
      },
    },
    onboarding: aggregate,
    plans: {
      payment_tx_v2: {
        version: 1,
        decisionId: "payment_tx_v2",
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "10",
        authorization: {
          walletId: "wallet_existing",
          walletName: "primary",
          selectionEpoch: 3,
          authorizationId: "auth_existing",
        },
        intentDigest: `sha256:${"6".repeat(64)}`,
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        decision: "allow",
        blockers: [],
        approval: { action: "confirm", userConfirmationRequired: true },
      },
    },
    policyPlans: {},
    requests: {
      payment_request_tx_v2: {
        version: 1,
        requestId: "payment_request_tx_v2",
        clientRequestId: "client:payment:tx:v2",
        decisionId: "payment_tx_v2",
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "10",
        authorization: {
          walletId: "wallet_existing",
          walletName: "primary",
          selectionEpoch: 3,
          authorizationId: "auth_existing",
        },
        phase: "submitted",
        transactionHash: `0x${"a".repeat(64)}`,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
    },
    regularPlans: {
      regular_hashless_v2: {
        version: 1,
        decisionId: "regular_hashless_v2",
        recipient: "0x3333333333333333333333333333333333333333",
        amountWei: "10",
        mainBalanceSnapshotWei: "1000",
        gasReserveWei: "1",
        authorization: {
          walletId: "wallet_existing",
          walletName: "primary",
          selectionEpoch: 3,
          authorizationId: "auth_existing",
        },
        intentDigest: `sha256:${"7".repeat(64)}`,
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        decision: "allow",
        blockers: [],
        approval: { action: "confirm", userConfirmationRequired: true },
      },
    },
    regularRequests: {
      regular_request_hashless_v2: {
        version: 1,
        requestId: "regular_request_hashless_v2",
        clientRequestId: "client:regular:hashless:v2",
        decisionId: "regular_hashless_v2",
        recipient: "0x3333333333333333333333333333333333333333",
        amountWei: "10",
        gasReserveWei: "1",
        authorization: {
          walletId: "wallet_existing",
          walletName: "primary",
          selectionEpoch: 3,
          authorizationId: "auth_existing",
        },
        phase: "executing",
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
    },
    recoveryPlans: {
      recovery_v2: {
        version: 1,
        decisionId: "recovery_v2",
        wallet: {
          walletId: "wallet_existing",
          walletName: "primary",
          selectionEpoch: 3,
        },
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "90",
        withdrawalAmountWei: "100",
        feeReserveWei: "10",
        maxRecipientAmountWei: "90",
        privateBalanceSnapshotWei: "300",
        remainingPrivateBalanceEstimateWei: "200",
        balanceRevision: 7,
        scope: "single_tornado_denomination",
        feeModel: "reserved_from_wallet_controlled_remainder",
        intentDigest: `sha256:${"5".repeat(64)}`,
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        decision: "allow",
        blockers: [],
        approval: { action: "confirm", userConfirmationRequired: true },
        consumedByRequestId: "recovery_request_v2",
      },
    },
    recoveryRequests: {
      recovery_request_v2: {
        version: 1,
        requestId: "recovery_request_v2",
        clientRequestId: "client:recovery:v2",
        decisionId: "recovery_v2",
        wallet: {
          walletId: "wallet_existing",
          walletName: "primary",
          selectionEpoch: 3,
        },
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "90",
        withdrawalAmountWei: "100",
        feeReserveWei: "10",
        remainingPrivateBalanceEstimateWei: "200",
        scope: "single_tornado_denomination",
        feeModel: "reserved_from_wallet_controlled_remainder",
        phase: "submitted",
        userOperationHash: `0x${"b".repeat(64)}`,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
    },
    reauthorizationPlans: {},
  }, null, 2)}\n`, "utf8");

  await store.initialize();
  const migrated = await store.read();
  const profile = migrated.wallet?.profiles.wallet_existing;
  assert.equal(migrated.version, 3);
  assert.equal(profile?.defaultPrivateBalanceId, "private_wallet_existing");
  assert.deepEqual(profile?.privateBalances.private_wallet_existing, {
    version: 1,
    privateBalanceId: "private_wallet_existing",
    name: "private",
    backendWalletName: "primary",
    status: "available",
    balanceWei: "300",
    revision: 7,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    delegation: aggregate.delegation,
  });
  assert.equal(JSON.parse(await readFile(store.path, "utf8")).version, 3);
  assert.equal(
    migrated.recoveryPlans.recovery_v2?.privateBalanceId,
    "private_wallet_existing",
  );
  assert.equal(migrated.recoveryPlans.recovery_v2?.privateBalanceRevision, 7);
  assert.equal(migrated.recoveryPlans.recovery_v2?.privateBalanceDebitWei, "100");
  assert.equal(
    migrated.recoveryRequests.recovery_request_v2?.privateBalanceDebitWei,
    "100",
  );
  for (const request of [
    migrated.requests.payment_request_tx_v2,
    migrated.regularRequests.regular_request_hashless_v2,
    migrated.recoveryRequests.recovery_request_v2,
  ]) {
    assert.equal(request?.broadcastStartedAt, UPDATED_AT);
    assert.ok(
      request?.phase === "executing" || request?.phase === "submitted" ||
        request?.phase === "indeterminate",
    );
    assert.equal("userOperationReceiptEvidence" in (request ?? {}), false);
  }

  const restarted = new StateStore(root);
  await restarted.initialize();
  assert.deepEqual(await restarted.read(), migrated);
});

test("wallet selection preserves authorization, policy, and pockets across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-switch-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("alpha");
  const alpha = await store.activeWalletProfile();
  const alphaAuthorizationId = alpha.authorizationId!;
  const alphaOnboarding = onboarding({ setupId: "setup-alpha" });
  await store.update((draft) => {
    draft.onboarding = structuredClone(alphaOnboarding);
  });

  const beta = await store.registerManagedWallet("beta", "adopted");
  const betaAuthorizationId = "auth_beta";
  const betaOnboarding = onboarding({
    setupId: "setup-beta",
    delegation: delegation({ perPaymentLimitWei: "50", lifetimeLimitWei: "500" }),
  });
  await store.update((draft) => {
    const profile = draft.wallet!.profiles[beta.walletId]!;
    profile.authorizationId = betaAuthorizationId;
    profile.onboarding = structuredClone(betaOnboarding);
  });

  const selectedBeta = await store.activateWalletProfile(beta.walletId);
  assert.equal(selectedBeta.profile.selectionEpoch, 1);
  assert.equal(selectedBeta.profile.authorizationId, betaAuthorizationId);
  assert.deepEqual(selectedBeta.profile.onboarding?.delegation, betaOnboarding.delegation);

  const selectedAlpha = await store.activateWalletProfile(alpha.walletId);
  assert.equal(selectedAlpha.profile.selectionEpoch, 2);
  assert.equal(selectedAlpha.profile.authorizationId, alphaAuthorizationId);
  assert.deepEqual(selectedAlpha.profile.onboarding?.delegation, alphaOnboarding.delegation);

  const selectedBetaAgain = await store.activateWalletProfile(beta.walletId);
  assert.equal(selectedBetaAgain.profile.selectionEpoch, 2);
  assert.equal(selectedBetaAgain.profile.authorizationId, betaAuthorizationId);
  assert.deepEqual(selectedBetaAgain.profile.onboarding?.delegation, betaOnboarding.delegation);

  const restarted = new StateStore(root);
  await restarted.initialize();
  const afterRestart = await restarted.read();
  assert.equal(afterRestart.wallet?.activeWalletId, beta.walletId);
  assert.equal(afterRestart.wallet?.profiles[alpha.walletId]?.authorizationId, alphaAuthorizationId);
  assert.equal(afterRestart.wallet?.profiles[beta.walletId]?.authorizationId, betaAuthorizationId);
  assert.deepEqual(
    afterRestart.wallet?.profiles[alpha.walletId]?.onboarding?.delegation,
    alphaOnboarding.delegation,
  );
  assert.deepEqual(
    afterRestart.wallet?.profiles[beta.walletId]?.onboarding?.delegation,
    betaOnboarding.delegation,
  );
});

test("physical pocket invariants reject alias and backend collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-pockets-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("alpha");
  await store.update((draft) => {
    draft.onboarding = onboarding({ setupId: "setup-alpha" });
  });
  const alpha = await store.activeWalletProfile();
  await store.update((draft) => {
    draft.wallet!.profiles[alpha.walletId]!.privateBalances.pb_travel = isolatedPocket({
      privateBalanceId: "pb_travel",
      name: "travel",
      backendWalletName: "internal-alpha-travel",
    });
  });

  await assert.rejects(
    store.update((draft) => {
      draft.wallet!.profiles[alpha.walletId]!.privateBalances.pb_duplicate = isolatedPocket({
        privateBalanceId: "pb_duplicate",
        name: "TRAVEL",
        backendWalletName: "internal-alpha-duplicate",
      });
    }),
    /names must be unique/i,
  );
  await assert.rejects(
    store.update((draft) => {
      draft.wallet!.profiles[alpha.walletId]!.privateBalances.pb_parent = isolatedPocket({
        privateBalanceId: "pb_parent",
        name: "parent-backend",
        backendWalletName: "alpha",
      });
    }),
    /Only the default private balance/i,
  );
  await assert.rejects(
    store.update((draft) => {
      const pocket = draft.wallet!.profiles[alpha.walletId]!.privateBalances.pb_travel!;
      pocket.delegation.enabled = true;
      pocket.delegation.perPaymentLimitWei = "101";
    }),
    /expands wallet-wide authority/i,
  );

  const beta = await store.registerManagedWallet("beta");
  await assert.rejects(
    store.update((draft) => {
      draft.wallet!.profiles[beta.walletId]!.privateBalances.pb_collision = isolatedPocket({
        privateBalanceId: "pb_collision",
        name: "collision",
        backendWalletName: "internal-alpha-travel",
      });
    }),
    /globally unique/i,
  );
});

test("live wallet and private policies accept only canonical or exhausted envelopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-policy-envelope-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("alpha");
  await store.update((draft) => {
    draft.onboarding = onboarding({
      delegation: delegation({ spentWei: "20" }),
    });
  });

  await assert.rejects(
    store.update((draft) => {
      draft.onboarding!.delegation.lifetimeLimitWei = "1001";
    }),
    /Wallet policy lifetime exceeds its payment envelope/u,
  );
  await assert.rejects(
    store.update((draft) => {
      const profile = draft.wallet!.profiles[draft.wallet!.activeWalletId]!;
      const pocket = profile.privateBalances[profile.defaultPrivateBalanceId]!;
      pocket.delegation.perPaymentLimitWei = "50";
      pocket.delegation.lifetimeLimitWei = "600";
    }),
    /Private balance policy lifetime exceeds its payment envelope/u,
  );
  await assert.rejects(
    store.update((draft) => {
      draft.onboarding!.delegation.lifetimeLimitWei = "19";
    }),
    /Wallet policy spent amount exceeds its lifetime limit/u,
  );

  await store.update((draft) => {
    const profile = draft.wallet!.profiles[draft.wallet!.activeWalletId]!;
    const managed = isolatedPocket({
      privateBalanceId: "pb_managed_envelope",
      name: "managed-envelope",
      backendWalletName: "internal-alpha-managed-envelope",
    });
    managed.delegation = delegation({
      perPaymentLimitWei: "80",
      lifetimeLimitWei: "640",
      spentWei: "20",
      maxPayments: 8,
    });
    profile.privateBalances.pb_managed_envelope = managed;
  });
  await store.update((draft) => {
    const policy = draft.onboarding!.delegation;
    policy.perPaymentLimitWei = "40";
    policy.lifetimeLimitWei = "400";
  });
  const tightened = await store.read();
  const tightenedProfile = tightened.wallet!.profiles[tightened.wallet!.activeWalletId]!;
  assert.deepEqual(
    tightenedProfile.privateBalances.pb_managed_envelope!.delegation,
    delegation({
      perPaymentLimitWei: "40",
      lifetimeLimitWei: "320",
      spentWei: "20",
      maxPayments: 8,
    }),
  );

  await store.update((draft) => {
    const profile = draft.wallet!.profiles[draft.wallet!.activeWalletId]!;
    const pocket = profile.privateBalances[profile.defaultPrivateBalanceId]!;
    for (const policy of [draft.onboarding!.delegation, pocket.delegation]) {
      policy.perPaymentLimitWei = "10";
      policy.lifetimeLimitWei = "20";
      policy.spentWei = "20";
      policy.maxPayments = 1;
    }
  });
  const exhausted = await store.read();
  assert.equal(exhausted.onboarding!.delegation.lifetimeLimitWei, "20");
  assert.equal(exhausted.onboarding!.delegation.spentWei, "20");
  const exhaustedProfile = exhausted.wallet!.profiles[exhausted.wallet!.activeWalletId]!;
  assert.equal(
    exhaustedProfile.privateBalances.pb_managed_envelope!.delegation.spentWei,
    "20",
  );
});

test("funding state binds an immutable prepared call and one unresolved target", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-funding-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("alpha");
  await store.update((draft) => {
    draft.onboarding = onboarding({ setupId: "setup-alpha" });
  });
  const alpha = await store.activeWalletProfile();
  await store.update((draft) => {
    draft.wallet!.profiles[alpha.walletId]!.privateBalances.pb_target = isolatedPocket({
      privateBalanceId: "pb_target",
      name: "savings",
      backendWalletName: "internal-alpha-savings",
    });
  });
  const state = await store.read();
  const profile = state.wallet!.profiles[alpha.walletId]!;
  const target = profile.privateBalances.pb_target!;
  const wallet = {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
  };
  const targetBinding = {
    ...wallet,
    privateBalanceId: target.privateBalanceId,
    privateBalanceName: target.name,
    backendWalletName: target.backendWalletName,
    privateBalanceRevision: target.revision,
  };
  const fundingPlan = {
    version: 1 as const,
    decisionId: "pbf_one",
    sourceWallet: wallet,
    targetWallet: wallet,
    route: "shield_from_main" as const,
    targetPrivateBalance: targetBinding,
    amountWei: "100",
    mainBalanceSnapshotWei: "1000",
    gasReserveWei: "1",
    shieldDenominationWei: "100",
    aggregatePrivateBalanceSnapshotWei: "100",
    targetPrivateBalanceSnapshotWei: "0",
    sourceExecutorAddress: "0x1111111111111111111111111111111111111111",
    targetCommitment: "commitment-one",
    preparedDepositCall: {
      to: "0x2222222222222222222222222222222222222222",
      data: "0x1234",
      valueWei: "100",
    },
    intentDigest: `sha256:${"1".repeat(64)}`,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    decision: "allow" as const,
    blockers: [],
    approval: { action: "confirm" as const, userConfirmationRequired: true as const },
  };
  await store.update((draft) => {
    draft.privateBalanceFundingPlans[fundingPlan.decisionId] = fundingPlan;
  });

  await store.update((draft) => {
    draft.privateBalanceFundingPlans.pbf_two = {
      ...structuredClone(fundingPlan),
      decisionId: "pbf_two",
      intentDigest: `sha256:${"2".repeat(64)}`,
    };
  });
  await assert.rejects(
    store.update((draft) => {
      draft.privateBalanceFundingPlans.pbf_one!.preparedDepositCall.data = "0xabcd";
    }),
    /execution target is immutable/i,
  );

  await store.update((draft) => {
    draft.privateBalanceFundingPlans.pbf_one!.consumedByRequestId = "pbfr_one";
    draft.privateBalanceFundingRequests.pbfr_one = {
      version: 1,
      requestId: "pbfr_one",
      clientRequestId: "client:funding:one",
      decisionId: "pbf_one",
      sourceWallet: wallet,
      targetWallet: wallet,
      route: "shield_from_main",
      targetPrivateBalance: targetBinding,
      amountWei: "100",
      aggregatePrivateBalanceBeforeWei: "100",
      targetPrivateBalanceBeforeWei: "0",
      targetCommitment: "commitment-one",
      preparedDepositCall: structuredClone(fundingPlan.preparedDepositCall),
      phase: "executing",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    };
  });
  await assert.rejects(
    store.update((draft) => {
      draft.privateBalanceFundingPlans.pbf_two!.consumedByRequestId = "pbfr_two";
      draft.privateBalanceFundingRequests.pbfr_two = {
        ...structuredClone(draft.privateBalanceFundingRequests.pbfr_one!),
        requestId: "pbfr_two",
        clientRequestId: "client:funding:two",
        decisionId: "pbf_two",
      };
    }),
    /unresolved funding/i,
  );
  const restarted = new StateStore(root);
  await restarted.initialize();
  assert.equal(
    (await restarted.read()).privateBalanceFundingRequests.pbfr_one?.targetCommitment,
    "commitment-one",
  );
});

test("creation and pocket-policy workflows persist exact bindings through restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-pocket-workflows-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("alpha");
  await store.update((draft) => {
    draft.onboarding = onboarding({ setupId: "setup-alpha" });
  });
  const initial = await store.read();
  const profile = initial.wallet!.profiles[initial.wallet!.activeWalletId]!;
  const wallet = {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
  };
  const initialPolicy = delegation({ spentWei: "0" });

  await store.update((draft) => {
    draft.privateBalanceCreationPlans.pbc_savings = {
      version: 1,
      decisionId: "pbc_savings",
      wallet,
      walletOnboardingRevision: draft.onboarding!.revision,
      privateBalanceId: "pb_savings",
      privateBalanceName: "savings",
      backendWalletName: "internal-alpha-savings",
      initialPolicy,
      intentDigest: `sha256:${"3".repeat(64)}`,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      decision: "allow",
      blockers: [],
      approval: { action: "confirm", userConfirmationRequired: true },
    };
  });
  await store.update((draft) => {
    draft.privateBalanceCreationPlans.pbc_savings!.consumedByRequestId = "pbcr_savings";
    draft.privateBalanceCreationRequests.pbcr_savings = {
      version: 1,
      requestId: "pbcr_savings",
      clientRequestId: "client:create:savings",
      decisionId: "pbc_savings",
      privateBalance: {
        ...wallet,
        privateBalanceId: "pb_savings",
        privateBalanceName: "savings",
        backendWalletName: "internal-alpha-savings",
        privateBalanceRevision: 0,
      },
      phase: "creating",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    };
  });
  await store.update((draft) => {
    const record: PrivateBalanceRecord = {
      version: 1,
      privateBalanceId: "pb_savings",
      name: "savings",
      backendWalletName: "internal-alpha-savings",
      status: "available",
      balanceWei: "0",
      revision: 1,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      delegation: structuredClone(initialPolicy),
    };
    draft.wallet!.profiles[profile.walletId]!.privateBalances.pb_savings = record;
    const request = draft.privateBalanceCreationRequests.pbcr_savings!;
    request.privateBalance.privateBalanceRevision = 1;
    request.phase = "created";
    request.appliedAt = UPDATED_AT;
    request.updatedAt = UPDATED_AT;
    draft.privateBalanceCreationPlans.pbc_savings!.appliedAt = UPDATED_AT;
  });

  const created = await store.read();
  const record = created.wallet!.profiles[profile.walletId]!.privateBalances.pb_savings!;
  const pocketBinding = {
    ...wallet,
    privateBalanceId: record.privateBalanceId,
    privateBalanceName: record.name,
    backendWalletName: record.backendWalletName,
    privateBalanceRevision: record.revision,
  };
  const current = {
    ...record.delegation,
    paymentsUsed: 0,
    paymentsRemaining: record.delegation.maxPayments,
  };
  const proposed = {
    ...current,
    perPaymentLimitWei: "50",
    lifetimeLimitWei: "250",
    maxPayments: 5,
    paymentsRemaining: 5,
  };
  await store.update((draft) => {
    draft.privateBalancePolicyUpdatePlans.pbpu_savings = {
      version: 1,
      decisionId: "pbpu_savings",
      privateBalance: pocketBinding,
      current,
      proposed,
      intentDigest: `sha256:${"4".repeat(64)}`,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      decision: "allow",
      blockers: [],
      approval: { action: "confirm", userConfirmationRequired: true },
    };
  });
  await store.update((draft) => {
    const plan = draft.privateBalancePolicyUpdatePlans.pbpu_savings!;
    const pocket = draft.wallet!.profiles[profile.walletId]!.privateBalances.pb_savings!;
    pocket.delegation = {
      mode: proposed.mode,
      chainId: proposed.chainId,
      perPaymentLimitWei: proposed.perPaymentLimitWei,
      lifetimeLimitWei: proposed.lifetimeLimitWei,
      spentWei: proposed.spentWei,
      maxPayments: proposed.maxPayments,
      expiresAt: proposed.expiresAt,
      enabled: proposed.enabled,
    };
    pocket.revision += 1;
    plan.consumedByRequestId = "pbpur_savings";
    plan.appliedAt = UPDATED_AT;
    plan.appliedPolicy = proposed;
    draft.privateBalancePolicyUpdateRequests.pbpur_savings = {
      version: 1,
      requestId: "pbpur_savings",
      clientRequestId: "client:policy:savings",
      decisionId: plan.decisionId,
      privateBalance: pocketBinding,
      phase: "applied",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      appliedAt: UPDATED_AT,
      policy: proposed,
    };
  });

  const restarted = new StateStore(root);
  await restarted.initialize();
  const durable = await restarted.read();
  assert.equal(durable.privateBalanceCreationRequests.pbcr_savings?.phase, "created");
  assert.equal(durable.privateBalancePolicyUpdateRequests.pbpur_savings?.phase, "applied");
  assert.equal(
    durable.wallet?.profiles[profile.walletId]?.privateBalances.pb_savings?.delegation
      .perPaymentLimitWei,
    "50",
  );
});

test("reauthorization renews unmanaged pockets and preserves explicit child policy history", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-pocket-renewal-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("alpha");

  const expiredAt = new Date(0).toISOString();
  const expiredAggregate = delegation({
    spentWei: "30",
    expiresAt: expiredAt,
  });
  await store.update((draft) => {
    draft.onboarding = onboarding({
      delegation: expiredAggregate,
    });
  });

  const initialized = await store.read();
  const profile = initialized.wallet!.profiles[initialized.wallet!.activeWalletId]!;
  const wallet = {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
  };
  const unmanagedPolicy = delegation({
    spentWei: "10",
    expiresAt: expiredAt,
  });
  const managedPolicy = delegation({
    perPaymentLimitWei: "40",
    lifetimeLimitWei: "160",
    spentWei: "20",
    maxPayments: 4,
    expiresAt: expiredAt,
    enabled: false,
  });
  await store.update((draft) => {
    const active = draft.wallet!.profiles[profile.walletId]!;
    active.privateBalances.pb_unmanaged = {
      version: 1,
      privateBalanceId: "pb_unmanaged",
      name: "unmanaged",
      backendWalletName: "abpb-alpha-unmanaged",
      status: "available",
      balanceWei: "100",
      revision: 1,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      delegation: unmanagedPolicy,
    };
    active.privateBalances.pb_managed = {
      version: 1,
      privateBalanceId: "pb_managed",
      name: "managed",
      backendWalletName: "abpb-alpha-managed",
      status: "available",
      balanceWei: "100",
      revision: 1,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      delegation: managedPolicy,
    };
    const managedBinding = {
      ...wallet,
      privateBalanceId: "pb_managed",
      privateBalanceName: "managed",
      backendWalletName: "abpb-alpha-managed",
      privateBalanceRevision: 1,
    };
    const managedSnapshot = {
      ...managedPolicy,
      paymentsUsed: 2,
      paymentsRemaining: 2,
    };
    draft.privateBalancePolicyUpdatePlans.pbpu_managed = {
      version: 1,
      decisionId: "pbpu_managed",
      privateBalance: managedBinding,
      current: managedSnapshot,
      proposed: managedSnapshot,
      intentDigest: `sha256:${"7".repeat(64)}`,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      decision: "allow",
      blockers: [],
      approval: { action: "confirm", userConfirmationRequired: true },
      consumedByRequestId: "pbpur_managed",
      appliedAt: UPDATED_AT,
      appliedPolicy: managedSnapshot,
    };
    draft.privateBalancePolicyUpdateRequests.pbpur_managed = {
      version: 1,
      requestId: "pbpur_managed",
      clientRequestId: "client:policy:managed",
      decisionId: "pbpu_managed",
      privateBalance: managedBinding,
      phase: "applied",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      appliedAt: UPDATED_AT,
      policy: managedSnapshot,
    };
  });

  const beforeRenewal = await store.read();
  const beforeProfile = beforeRenewal.wallet!.profiles[profile.walletId]!;
  const priorAuthorizationId = beforeProfile.authorizationId;
  assert.ok(priorAuthorizationId);
  const renewedDelegation = delegation({
    perPaymentLimitWei: "80",
    lifetimeLimitWei: "640",
    spentWei: "0",
    maxPayments: 8,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const createdAt = new Date().toISOString();
  await store.storeReauthorizationPlan({
    version: 1,
    decisionId: "reauthorize_alpha",
    wallet,
    priorAuthorizationId,
    currentPolicy: {
      ...expiredAggregate,
      paymentsUsed: 0,
      paymentsRemaining: expiredAggregate.maxPayments,
    },
    proposedPolicy: {
      ...renewedDelegation,
      paymentsUsed: 0,
      paymentsRemaining: renewedDelegation.maxPayments,
    },
    authorizationEffect: "replace",
    counterEffect: "reset_spend_and_payment_count",
    intentDigest: `sha256:${"8".repeat(64)}`,
    createdAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    decision: "allow",
    blockers: [],
    approval: { action: "confirm", userConfirmationRequired: true },
  });
  await store.applyReauthorizationPlan("reauthorize_alpha");

  const renewed = await store.read();
  const renewedProfile = renewed.wallet!.profiles[profile.walletId]!;
  assert.notEqual(renewedProfile.authorizationId, priorAuthorizationId);
  assert.deepEqual(
    renewedProfile.privateBalances[renewedProfile.defaultPrivateBalanceId]!.delegation,
    renewedDelegation,
  );
  assert.deepEqual(
    renewedProfile.privateBalances.pb_unmanaged!.delegation,
    renewedDelegation,
  );
  assert.deepEqual(renewedProfile.privateBalances.pb_managed!.delegation, {
    ...managedPolicy,
    lifetimeLimitWei: "160",
    spentWei: "0",
  });
  assert.equal(
    renewed.privateBalancePolicyUpdateRequests.pbpur_managed!.policy!.spentWei,
    "20",
  );
  assert.equal(
    renewed.reauthorizationPlans.reauthorize_alpha!.appliedAuthorizationId,
    renewedProfile.authorizationId,
  );
});

test("a reauthorization decision that was never planned is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-reauth-forged-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("alpha");
  await store.update((draft) => {
    draft.onboarding = onboarding();
  });

  await assert.rejects(
    () => store.applyReauthorizationPlan("wra_never_planned"),
    /REAUTHORIZATION_DECISION_NOT_FOUND/u,
    "a decision id the store never issued must not renew authority",
  );
});

test("an applied reauthorization decision replays without minting a second renewal", async () => {
  // Reauthorization resets the spend and payment counters by design, under a
  // confirmed plan. Replaying the same decision must therefore be idempotent:
  // if it renewed twice, one confirmation would buy two fresh envelopes.
  const root = await mkdtemp(join(tmpdir(), "agent-boost-state-reauth-replay-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("alpha");

  const expiredAt = new Date(0).toISOString();
  const expired = delegation({ spentWei: "30", expiresAt: expiredAt });
  await store.update((draft) => {
    draft.onboarding = onboarding({ delegation: expired });
  });

  const initialized = await store.read();
  const profile = initialized.wallet!.profiles[initialized.wallet!.activeWalletId]!;
  const renewed = delegation({
    spentWei: "0",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await store.storeReauthorizationPlan({
    version: 1,
    decisionId: "wra_replay",
    wallet: {
      walletId: profile.walletId,
      walletName: profile.name,
      selectionEpoch: profile.selectionEpoch,
    },
    ...(profile.authorizationId
      ? { priorAuthorizationId: profile.authorizationId }
      : {}),
    currentPolicy: {
      ...expired,
      paymentsUsed: 0,
      paymentsRemaining: expired.maxPayments,
    },
    proposedPolicy: {
      ...renewed,
      paymentsUsed: 0,
      paymentsRemaining: renewed.maxPayments,
    },
    authorizationEffect: "replace",
    counterEffect: "reset_spend_and_payment_count",
    intentDigest: `sha256:${"9".repeat(64)}`,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    decision: "allow",
    blockers: [],
    approval: { action: "confirm", userConfirmationRequired: true },
  });

  const first = await store.applyReauthorizationPlan("wra_replay");
  const firstAuthorization = first.profile.authorizationId;
  assert.ok(firstAuthorization, "the first apply must issue an authorization");

  const second = await store.applyReauthorizationPlan("wra_replay");
  assert.equal(
    second.profile.authorizationId,
    firstAuthorization,
    "a replayed decision must not mint a second authorization",
  );
  const after = await store.read();
  assert.equal(
    after.reauthorizationPlans.wra_replay!.appliedAuthorizationId,
    firstAuthorization,
    "the receipt must stay bound to the single authorization it produced",
  );
});
