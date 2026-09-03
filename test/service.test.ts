import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import type {
  ChainClient,
  OnboardingPhase,
  OnboardingRecord,
  WalletAdapter,
} from "../src/contracts.js";
import { createLocalRuntime, readLocalStatus } from "../src/service.js";
import type { RpcFetch } from "../src/rpc/sepolia.js";
import { StateStore } from "../src/state/store.js";
import type {
  TorRpcProxyPort,
  TorRpcRoutePort,
  TorRouteStatus,
} from "../src/tor/index.js";

class SetupWallet implements WalletAdapter {
  activeWallet = "agent-boost";
  readonly ensuredWallets: string[] = [];
  selectWallet(walletName: string): void {
    this.activeWallet = walletName;
  }
  async ensureWallet(): Promise<void> {
    this.ensuredWallets.push(this.activeWallet);
  }
  async nextFreshAddress(): Promise<string> {
    return this.activeWallet === "agent-boost"
      ? "0x1111111111111111111111111111111111111111"
      : "0x2222222222222222222222222222222222222222";
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

class SnapshotWallet extends SetupWallet {
  snapshotReads = 0;
  privateReads = 0;

  constructor(
    readonly publicBalanceWei: bigint,
    readonly privateBalanceWei: bigint,
  ) {
    super();
  }

  override async getPrivateBalanceWei(): Promise<bigint> {
    this.privateReads += 1;
    return this.privateBalanceWei;
  }

  async getBalanceSnapshot(): Promise<{
    publicBalanceWei: bigint;
    privateBalanceWei: bigint;
  }> {
    this.snapshotReads += 1;
    return {
      publicBalanceWei: this.publicBalanceWei,
      privateBalanceWei: this.privateBalanceWei,
    };
  }
}

async function seedOnboarding(
  stateDir: string,
  phase: OnboardingPhase,
  publicBalanceWei: bigint,
  privateBalanceWei: bigint,
): Promise<void> {
  const now = new Date(0).toISOString();
  const record: OnboardingRecord = {
    version: 1,
    setupId: "setup_balance_test",
    revision: 1,
    phase,
    createdAt: now,
    updatedAt: now,
    address: "0x1111111111111111111111111111111111111111",
    publicBalanceWei: publicBalanceWei.toString(),
    privateBalanceWei: privateBalanceWei.toString(),
    requiredFundingWei: "200000000000000000",
    shieldAmountWei: "100000000000000000",
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
  const store = new StateStore(stateDir);
  await store.initialize();
  await store.update((draft) => {
    draft.onboarding = record;
  });
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

test("new demo confirmation archives old state and opens a fresh funding flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-runtime-reset-"));
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
  const wallet = new SetupWallet();
  const runtime = await createLocalRuntime(config, {
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei() {
        return 0n;
      },
    },
    openBrowser: async () => false,
  });
  try {
    const first = await runtime.startOnboarding();
    await assert.rejects(
      runtime.startNewDemo({ userConfirmed: false }),
      /must confirm archiving/,
    );
    const reset = await runtime.startNewDemo({ userConfirmed: true });
    assert.equal(reset.previousSetupId, first.record.setupId);
    assert.equal(reset.previousRequestCount, 0);
    assert.notEqual(reset.record.setupId, first.record.setupId);
    assert.equal(reset.record.address, "0x2222222222222222222222222222222222222222");
    assert.ok(reset.qrPngBase64);
    assert.notEqual(wallet.activeWallet, "agent-boost");
    const archived = JSON.parse(
      await readFile(join(root, "archives", reset.archiveId, "state.json"), "utf8"),
    ) as { onboarding: { setupId: string }; wallet: { activeName: string } };
    assert.equal(archived.onboarding.setupId, first.record.setupId);
    assert.equal(archived.wallet.activeName, "agent-boost");
    const status = await readLocalStatus(config);
    assert.equal(
      (status.onboarding as { setupId: string }).setupId,
      reset.record.setupId,
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

test("wallet context reports only the live balance of its displayed address", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-balance-context-"));
  const config = {
    ...loadConfig({
      AGENT_BOOST_STATE_DIR: root,
      AGENT_BOOST_FUNDING_POLL_MS: "1",
    }, root),
    uiPort: 0,
  };
  await seedOnboarding(
    root,
    "private_ready",
    1n,
    100_000_000_000_000_000n,
  );
  const wallet = new SnapshotWallet(999n, 999n);
  const runtime = await createLocalRuntime(config, {
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei() {
        return 200_000_000_000_000_000n;
      },
    },
  });
  try {
    const context = await runtime.walletContext() as {
      account_role: string;
      controls_subaccounts: boolean;
      address: string;
      balance_atomic: string;
      balances?: unknown;
    };
    assert.equal(context.account_role, "main_funding_source");
    assert.equal(context.controls_subaccounts, false);
    assert.equal(context.address, "0x1111111111111111111111111111111111111111");
    assert.equal(context.balance_atomic, "200000000000000000");
    assert.equal(context.balances, undefined);
    assert.equal(wallet.snapshotReads, 0);
  } finally {
    await runtime.shutdown();
  }
});

test("wallet tree refreshes main and private balances without returning an address", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-wallet-tree-"));
  const config = {
    ...loadConfig({
      AGENT_BOOST_STATE_DIR: root,
      AGENT_BOOST_FUNDING_POLL_MS: "1",
    }, root),
    uiPort: 0,
  };
  await seedOnboarding(
    root,
    "private_ready",
    1n,
    1n,
  );
  const seededStore = new StateStore(root);
  await seededStore.initialize();
  const inactiveProfile = await seededStore.registerManagedWallet("travel", "adopted");
  await seededStore.update((draft) => {
    const profile = draft.wallet?.profiles[inactiveProfile.walletId];
    if (!profile || !draft.onboarding) throw new Error("test wallet profile missing");
    profile.onboarding = {
      ...structuredClone(draft.onboarding),
      setupId: "setup_inactive_wallet",
      address: "0x2222222222222222222222222222222222222222",
      publicBalanceWei: "2",
      privateBalanceWei: "100000000000000000",
    };
  });
  const wallet = new SnapshotWallet(
    999n,
    250_000_000_000_000_000n,
  );
  let publicReadsFail = false;
  const runtime = await createLocalRuntime(config, {
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei(address) {
        if (publicReadsFail) throw new Error("temporary RPC failure");
        return address === "0x2222222222222222222222222222222222222222"
          ? 750_000_000_000_000_000n
          : 1_500_000_000_000_000_000n;
      },
    },
  });
  try {
    const readsBefore = wallet.privateReads;
    const tree = await runtime.walletTree();
    assert.equal(tree.profiles[0]?.shortName, "agent-boost");
    assert.equal(tree.profiles[0]?.active, true);
    assert.equal(tree.profiles[0]?.main.shortName, "main");
    assert.equal(tree.profiles[0]?.main.balanceWei, "1500000000000000000");
    assert.equal(tree.profiles[0]?.main.freshness, "live");
    assert.equal(tree.profiles[0]?.subwallets[0]?.shortName, "private");
    assert.equal(tree.profiles[0]?.subwallets[0]?.balanceWei, "250000000000000000");
    assert.equal(tree.profiles[0]?.subwallets[0]?.freshness, "live");
    assert.equal(tree.profiles[1]?.shortName, "travel");
    assert.equal(tree.profiles[1]?.active, false);
    assert.equal(tree.profiles[1]?.main.balanceWei, "750000000000000000");
    assert.equal(tree.profiles[1]?.main.freshness, "live");
    assert.equal(tree.profiles[1]?.subwallets[0]?.balanceWei, "100000000000000000");
    assert.equal(tree.profiles[1]?.subwallets[0]?.freshness, "last_known");
    assert.equal(tree.relationship.impliesControl, false);
    assert.equal(wallet.privateReads, readsBefore + 1);
    assert.doesNotMatch(
      JSON.stringify(tree),
      /0x1111111111111111111111111111111111111111/u,
    );

    publicReadsFail = true;
    const degraded = await runtime.walletTree();
    assert.equal(degraded.profiles[0]?.main.status, "unavailable");
    assert.equal(degraded.profiles[0]?.main.balanceWei, undefined);
    assert.equal(degraded.profiles[1]?.main.status, "unavailable");
    assert.equal(degraded.profiles[1]?.main.balanceWei, undefined);
    assert.equal(degraded.profiles[1]?.subwallets[0]?.freshness, "last_known");
  } finally {
    await runtime.shutdown();
  }
});
