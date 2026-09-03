import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
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
  await store.update((draft) => {
    draft.requests.req_unresolved = {
      version: 1,
      requestId: "req_unresolved",
      clientRequestId: "hermes:wd_unresolved",
      decisionId: "wd_unresolved",
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei: "1",
      phase: "indeterminate",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  });

  const reset = await store.archiveAndReset("agent-boost-new");
  assert.equal(reset.previous.requests.req_unresolved?.phase, "indeterminate");
  assert.deepEqual(reset.current, {
    version: 1,
    wallet: { activeName: "agent-boost-new" },
    plans: {},
    policyPlans: {},
    requests: {},
  });
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
  await store.update((draft) => {
    draft.onboarding = {
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
        maxPayments: 1,
        expiresAt: new Date(86_400_000).toISOString(),
        enabled: true,
      },
    };
    delete (draft.onboarding.delegation as Partial<
      typeof draft.onboarding.delegation
    >).maxPayments;
    delete (draft as Partial<typeof draft>).policyPlans;
  });

  const migrated = await store.read();
  assert.equal(migrated.onboarding?.delegation.maxPayments, 1);
  assert.deepEqual(migrated.policyPlans, {});
});
