import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import type { ChainClient, WalletAdapter } from "../src/contracts.js";
import { createLocalRuntime } from "../src/service.js";

class SetupWallet implements WalletAdapter {
  async ensureWallet(): Promise<void> {}
  async nextFreshAddress(): Promise<string> {
    return "0x1111111111111111111111111111111111111111";
  }
  async prewarmPrivacy(): Promise<void> {}
  async shieldWei(): Promise<Record<string, never>> {
    return {};
  }
  async getPrivateBalanceWei(): Promise<bigint> {
    return 0n;
  }
  async executePrivatePayment(): Promise<Record<string, never>> {
    return {};
  }
}

test("local runtime returns a QR fallback when the wallet awaits funding", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-runtime-"));
  const config = {
    ...loadConfig(
      {
        AGENT_BOOST_STATE_DIR: root,
        AGENT_BOOST_FUNDING_POLL_MS: "1",
        AGENT_BOOST_SETUP_TIMEOUT_MS: "10000",
      },
      root,
    ),
    uiPort: 0,
  };
  const chain: ChainClient = {
    async assertSepolia() {},
    async getBalanceWei() {
      return 0n;
    },
  };
  const runtime = await createLocalRuntime(config, {
    wallet: new SetupWallet(),
    chain,
    openBrowser: async () => false,
  });
  try {
    const started = await runtime.startOnboarding();
    assert.equal(started.record.phase, "awaiting_funding");
    assert.equal(started.uiOpened, false);
    assert.ok(started.qrPngBase64 && started.qrPngBase64.length > 100);
    const caps = await runtime.capabilities();
    assert.equal((caps.readiness as { wallet_ready: boolean }).wallet_ready, false);
  } finally {
    await runtime.shutdown();
  }
});
