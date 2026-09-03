import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { StateStore } from "../src/state/store.js";

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
      phase: "indeterminate",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  });

  const reset = await store.archiveAndReset("agent-boost-new");
  assert.equal(reset.previous.requests.req_unresolved?.phase, "indeterminate");
  assert.equal(reset.current.version, 2);
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
    plans: {},
    requests: {},
  }, null, 2)}\n`, "utf8");

  await store.initialize();

  const migrated = await store.read();
  assert.equal(migrated.onboarding?.delegation.maxPayments, 1);
  assert.deepEqual(migrated.policyPlans, {});
});
