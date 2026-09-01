import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
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
