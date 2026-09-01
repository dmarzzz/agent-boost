import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import type { ChainClient, WalletAdapter } from "../src/contracts.js";
import { createLocalRuntime, readLocalStatus } from "../src/service.js";
import type { RpcFetch } from "../src/rpc/sepolia.js";
import type {
  TorRpcProxyPort,
  TorRpcRoutePort,
  TorRouteStatus,
} from "../src/tor/index.js";

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

class RecoverableRoute implements TorRpcRoutePort {
  status: TorRouteStatus = "starting";
  readyCalls = 0;
  readyFailures = 0;
  readonly fetchRpc: RpcFetch = async () => Response.json({});

  async ready(): Promise<void> {
    this.readyCalls += 1;
    if (this.readyFailures > 0) {
      this.readyFailures -= 1;
      this.status = "failed";
      throw new Error("Tor bootstrap failed");
    }
    this.status = "ready";
  }

  async verifyTor(): Promise<void> {}

  async close(): Promise<void> {
    this.status = "closed";
  }
}

class ObservedProxy implements TorRpcProxyPort {
  readonly url = "http://127.0.0.1:9185/test";
  startCalls = 0;
  stopCalls = 0;

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
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
    const agentCard = Buffer.from(started.qrPngBase64, "base64");
    assert.equal(agentCard.readUInt32BE(16), 720);
    assert.equal(agentCard.readUInt32BE(20), 800);
    const caps = await runtime.capabilities();
    assert.equal((caps.readiness as { wallet_ready: boolean }).wallet_ready, false);
    const status = await readLocalStatus(config);
    assert.equal(
      (status.onboarding as { setupId: string }).setupId,
      started.record.setupId,
    );
  } finally {
    await runtime.shutdown();
  }
});

test("local runtime rebuilds Tor and retries a transient cold-start chain read", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-runtime-recovery-"));
  const route = new RecoverableRoute();
  let assertions = 0;
  const chain: ChainClient = {
    async assertSepolia() {
      assertions += 1;
      if (assertions === 1) {
        route.status = "failed";
        throw new Error("Sepolia RPC request failed");
      }
    },
    async getBalanceWei() {
      return 0n;
    },
  };
  const runtime = await createLocalRuntime(
    {
      ...loadConfig({ AGENT_BOOST_STATE_DIR: root }, root),
      uiPort: 0,
    },
    {
      wallet: new SetupWallet(),
      chain,
      rpcRoute: route,
      openBrowser: async () => false,
    },
  );
  try {
    assert.equal(assertions, 2);
    assert.equal(route.readyCalls, 2);
    assert.equal(route.status, "ready");
  } finally {
    await runtime.shutdown();
  }
});

test("local runtime retries a transient first Tor bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-runtime-bootstrap-"));
  const route = new RecoverableRoute();
  route.readyFailures = 1;
  let assertions = 0;
  const runtime = await createLocalRuntime(
    loadConfig({ AGENT_BOOST_STATE_DIR: root }, root),
    {
      wallet: new SetupWallet(),
      chain: {
        async assertSepolia() {
          assertions += 1;
        },
        async getBalanceWei() {
          return 0n;
        },
      },
      rpcRoute: route,
    },
  );
  try {
    assert.equal(route.readyCalls, 2);
    assert.equal(assertions, 1);
    assert.equal(route.status, "ready");
  } finally {
    await runtime.shutdown();
  }
});

test("local runtime never retries a Sepolia chain mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-runtime-mismatch-"));
  const route = new RecoverableRoute();
  let assertions = 0;
  await assert.rejects(
    createLocalRuntime(loadConfig({ AGENT_BOOST_STATE_DIR: root }, root), {
      wallet: new SetupWallet(),
      chain: {
        async assertSepolia() {
          assertions += 1;
          throw new Error(
            "RPC chain mismatch: expected Sepolia 11155111, received 1",
          );
        },
        async getBalanceWei() {
          return 0n;
        },
      },
      rpcRoute: route,
    }),
    /chain mismatch/,
  );
  assert.equal(assertions, 1);
});

test("exhausted Tor bootstrap retries fail closed before proxy start and release the lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-runtime-exhausted-"));
  const config = loadConfig({ AGENT_BOOST_STATE_DIR: root }, root);
  const route = new RecoverableRoute();
  route.readyFailures = 3;
  const proxy = new ObservedProxy();
  await assert.rejects(
    createLocalRuntime(config, {
      wallet: new SetupWallet(),
      chain: {
        async assertSepolia() {},
        async getBalanceWei() {
          return 0n;
        },
      },
      rpcRoute: route,
      rpcProxy: proxy,
    }),
    /Tor bootstrap failed/,
  );
  assert.equal(route.readyCalls, 3);
  assert.equal(route.status, "closed");
  assert.equal(proxy.startCalls, 0);
  assert.equal(proxy.stopCalls, 1);

  const replacement = await createLocalRuntime(config, {
    wallet: new SetupWallet(),
    chain: {
      async assertSepolia() {},
      async getBalanceWei() {
        return 0n;
      },
    },
  });
  await replacement.shutdown();
});
