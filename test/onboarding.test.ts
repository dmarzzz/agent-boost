import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import type { ChainClient, WalletAdapter } from "../src/contracts.js";
import { OnboardingController, type OnboardingClock } from "../src/onboarding.js";
import { StateStore } from "../src/state/store.js";

class FakeWallet implements WalletAdapter {
  shielded = false;
  async ensureWallet(): Promise<void> {}
  async nextFreshAddress(): Promise<string> {
    return "0x1111111111111111111111111111111111111111";
  }
  async prewarmPrivacy(): Promise<void> {}
  async shieldWei(): Promise<Record<string, never>> {
    this.shielded = true;
    return {};
  }
  async getPrivateBalanceWei(): Promise<bigint> {
    return this.shielded ? 100_000_000_000_000_000n : 0n;
  }
  async executePrivatePayment(): Promise<Record<string, never>> {
    return {};
  }
}

class ImmediateClock implements OnboardingClock {
  #time = 0;
  now(): Date {
    return new Date(this.#time);
  }
  async sleep(ms: number): Promise<void> {
    this.#time += ms;
  }
}

test("onboarding reaches private_ready after funding and one shield", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-onboarding-"));
  const store = new StateStore(root);
  await store.initialize();
  const wallet = new FakeWallet();
  let networkAssertions = 0;
  const chain: ChainClient = {
    async assertSepolia() {
      networkAssertions += 1;
    },
    async getBalanceWei() {
      return 200_000_000_000_000_000n;
    },
  };
  const config = loadConfig(
    {
      AGENT_BOOST_STATE_DIR: root,
      AGENT_BOOST_FUNDING_POLL_MS: "1",
      AGENT_BOOST_PRIVATE_POLL_MS: "1",
      AGENT_BOOST_SETUP_TIMEOUT_MS: "1000",
    },
    root,
  );
  const controller = new OnboardingController({
    store,
    wallet,
    chain,
    config,
    clock: new ImmediateClock(),
  });

  const started = await controller.start();
  assert.equal(started.address, "0x1111111111111111111111111111111111111111");

  let state = started;
  for (let index = 0; index < 20; index += 1) {
    state = await controller.status({
      setupId: started.setupId,
      sinceRevision: state.revision,
      waitMs: 100,
    });
    if (state.phase === "private_ready") {
      assert.equal(state.privateBalanceWei, "100000000000000000");
      assert.equal(wallet.shielded, true);
      assert.equal(networkAssertions, 2);
      return;
    }
  }
  assert.fail(`onboarding did not become ready: ${(await controller.getRecord()).phase}`);
});

test("awaiting-funding polling does not emit unchanged revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-onboarding-stable-"));
  const store = new StateStore(root);
  await store.initialize();
  const controller = new OnboardingController({
    store,
    wallet: new FakeWallet(),
    chain: {
      async assertSepolia() {},
      async getBalanceWei() {
        return 0n;
      },
    },
    config: loadConfig(
      {
        AGENT_BOOST_STATE_DIR: root,
        AGENT_BOOST_FUNDING_POLL_MS: "50",
        AGENT_BOOST_SETUP_TIMEOUT_MS: "1000",
      },
      root,
    ),
  });

  const started = await controller.start();
  await new Promise((resolve) => setTimeout(resolve, 130));
  const unchanged = await controller.getRecord();
  assert.equal(unchanged.phase, "awaiting_funding");
  assert.equal(unchanged.revision, started.revision);
  await controller.stop();
});
