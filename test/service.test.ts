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
  WalletInventoryItem,
} from "../src/contracts.js";
import { AgentBoostRequestError } from "../src/errors.js";
import { OnboardingController } from "../src/onboarding.js";
import { createLocalRuntime, readLocalStatus } from "../src/service.js";
import type { RpcFetch } from "../src/rpc/sepolia.js";
import { StateStore } from "../src/state/store.js";
import type {
  TorRpcProxyPort,
  TorRpcRoutePort,
  TorRouteStatus,
} from "../src/tor/index.js";
import { seedRegularRequestFixture } from "./helpers/private-regular-fixture.js";

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
  async executePrivatePayment(input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<Record<string, never>> {
    assert.match(input.broadcastRequestId, /^req_/u);
    await input.beforeBroadcast();
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

class ManagedWallet extends SetupWallet {
  readonly inventory = new Map<string, WalletInventoryItem["network"]>([
    ["agent-boost", "sepolia"],
  ]);
  failInventory = false;

  override async ensureWallet(): Promise<void> {
    await super.ensureWallet();
    this.inventory.set(this.activeWallet, "sepolia");
  }

  async listWallets(): Promise<WalletInventoryItem[]> {
    if (this.failInventory) throw new Error("temporary Kohaku inventory failure");
    return [...this.inventory].map(([name, network]) => ({ name, network }));
  }

  async executeRegularTransfer(input: {
    recipient: string;
    amountWei: bigint;
    beforeBroadcast: () => Promise<void>;
  }): Promise<Record<string, never>> {
    await input.beforeBroadcast();
    return {};
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
    const reset = await runtime.startNewDemo({
      userConfirmed: true,
      expectedActiveWalletName: "agent-boost",
      expectedActiveSelectionEpoch: 1,
    });
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

test("wallet listing discovers adoptable local wallets without losing registered profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-wallet-list-"));
  const wallet = new ManagedWallet();
  wallet.inventory.set("imported-sepolia", "sepolia");
  wallet.inventory.set("mainnet-wallet", "mainnet");
  const runtime = await createLocalRuntime(
    { ...loadConfig({ AGENT_BOOST_STATE_DIR: root }, root), uiPort: 0 },
    {
      wallet,
      chain: {
        async assertSepolia() {},
        async getBalanceWei() {
          return 0n;
        },
      },
      openBrowser: async () => false,
    },
  );
  try {
    const listed = await runtime.listWallets() as {
      wallets: Array<{ name: string; active: boolean }>;
      unregistered_local_wallets: Array<{
        name: string;
        network: string;
        adoptable: boolean;
      }>;
      local_inventory_status: string;
      counts: { registered: number; adoptable_local: number };
    };
    assert.deepEqual(listed.wallets.map(({ name }) => name), ["agent-boost"]);
    assert.equal(listed.wallets[0]?.active, true);
    assert.equal(listed.local_inventory_status, "ready");
    assert.deepEqual(listed.unregistered_local_wallets, [
      { name: "imported-sepolia", network: "sepolia", adoptable: true },
      { name: "mainnet-wallet", network: "mainnet", adoptable: false },
    ]);
    assert.equal(listed.counts.registered, 1);
    assert.equal(listed.counts.adoptable_local, 1);

    wallet.failInventory = true;
    const degraded = await runtime.listWallets() as {
      wallets: Array<{ name: string }>;
      unregistered_local_wallets: unknown[];
      local_inventory_status: string;
    };
    assert.deepEqual(degraded.wallets.map(({ name }) => name), ["agent-boost"]);
    assert.deepEqual(degraded.unregistered_local_wallets, []);
    assert.equal(degraded.local_inventory_status, "unavailable");
  } finally {
    await runtime.shutdown();
  }
});

test("create, adopt, and reset validate active-wallet previews atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-wallet-lifecycle-binding-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("agent-boost");
  const alternate = await store.registerManagedWallet("alternate-wallet", "created");
  const wallet = new ManagedWallet();
  wallet.inventory.set("imported-wallet", "sepolia");
  const runtime = await createLocalRuntime(
    {
      ...loadConfig({ AGENT_BOOST_STATE_DIR: root }, root),
      uiPort: 0,
    },
    {
      wallet,
      chain: {
        async assertSepolia() {},
        async getBalanceWei() {
          return 0n;
        },
      },
      openBrowser: async () => false,
    },
  );
  const activeBinding = async (): Promise<{
    expectedActiveWalletName: string;
    expectedActiveSelectionEpoch: number;
  }> => {
    const listing = await runtime.listWallets() as {
      wallets: Array<{ name: string; active: boolean; selection_epoch: number }>;
    };
    const active = listing.wallets.find((profile) => profile.active);
    assert.ok(active);
    return {
      expectedActiveWalletName: active.name,
      expectedActiveSelectionEpoch: active.selection_epoch,
    };
  };
  const assertLifecycleRejections = (
    results: PromiseSettledResult<unknown>[],
    code: "WALLET_LIFECYCLE_BINDING_REQUIRED" | "WALLET_LIFECYCLE_PREVIEW_STALE",
  ): void => {
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") {
        assert.equal(result.reason instanceof AgentBoostRequestError, true);
        assert.equal((result.reason as AgentBoostRequestError).code, code);
      }
    }
  };

  try {
    const initialBinding = await activeBinding();
    assertLifecycleRejections(await Promise.allSettled([
      runtime.createWallet({ name: "missing-create", userConfirmed: true }),
      runtime.adoptWallet({ name: "imported-wallet", userConfirmed: true }),
      runtime.startNewDemo({ userConfirmed: true }),
    ]), "WALLET_LIFECYCLE_BINDING_REQUIRED");

    const raced = await Promise.allSettled([
      runtime.selectWallet({
        walletId: alternate.walletId,
        userConfirmed: true,
      }),
      runtime.createWallet({
        name: "stale-create",
        userConfirmed: true,
        ...initialBinding,
      }),
      runtime.adoptWallet({
        name: "imported-wallet",
        userConfirmed: true,
        ...initialBinding,
      }),
      runtime.startNewDemo({
        userConfirmed: true,
        ...initialBinding,
      }),
    ]);
    assert.equal(raced[0]?.status, "fulfilled");
    assertLifecycleRejections(raced.slice(1), "WALLET_LIFECYCLE_PREVIEW_STALE");
    const afterRace = await runtime.listWallets() as {
      wallets: Array<{ name: string; active: boolean }>;
    };
    assert.equal(afterRace.wallets.find((profile) => profile.active)?.name, "alternate-wallet");
    assert.equal(afterRace.wallets.some((profile) => profile.name === "stale-create"), false);
    assert.equal(wallet.inventory.has("stale-create"), false);

    const created = await runtime.createWallet({
      name: "created-wallet",
      userConfirmed: true,
      ...(await activeBinding()),
    }) as {
      wallet: { name: string };
      setup_phase: string;
      setup: { setupId: string; revision: number; phase: string };
    };
    assert.equal(created.wallet.name, "created-wallet");
    assert.deepEqual(created.setup, {
      setupId: created.setup.setupId,
      revision: created.setup.revision,
      phase: created.setup_phase,
    });
    assert.match(created.setup.setupId, /^setup_/u);
    assert.ok(Number.isSafeInteger(created.setup.revision));

    const adopted = await runtime.adoptWallet({
      name: "imported-wallet",
      userConfirmed: true,
      ...(await activeBinding()),
    }) as {
      wallet: { wallet_id: string; name: string };
      setup_phase: string;
      setup: { setupId: string; revision: number; phase: string };
    };
    assert.equal(adopted.wallet.name, "imported-wallet");
    assert.equal(adopted.setup.phase, adopted.setup_phase);
    assert.match(adopted.setup.setupId, /^setup_/u);
    assert.ok(Number.isSafeInteger(adopted.setup.revision));

    const selectedAgain = await runtime.selectWallet({
      walletId: adopted.wallet.wallet_id,
      userConfirmed: false,
    }) as {
      changed: boolean;
      setup_phase: string;
      setup: { setupId: string; revision: number; phase: string };
    };
    assert.equal(selectedAgain.changed, false);
    assert.equal(selectedAgain.setup.phase, selectedAgain.setup_phase);
    assert.equal(selectedAgain.setup.setupId, adopted.setup.setupId);
    assert.ok(selectedAgain.setup.revision >= adopted.setup.revision);

    const reset = await runtime.startNewDemo({
      userConfirmed: true,
      ...(await activeBinding()),
    });
    assert.ok(reset.archiveId.length > 0);
    const afterReset = await runtime.listWallets() as {
      wallets: Array<{ name: string; active: boolean }>;
    };
    assert.match(afterReset.wallets.find((profile) => profile.active)?.name ?? "", /^agent-boost-/u);
  } finally {
    await runtime.shutdown();
  }
});

test("committed wallet activations survive setup-continuation failures truthfully", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-wallet-post-commit-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("agent-boost");
  const saved = await store.registerManagedWallet("saved-wallet", "created");
  await store.update((draft) => {
    const profile = draft.wallet?.profiles[saved.walletId];
    assert.ok(profile);
    profile.onboarding = {
      version: 1,
      setupId: "setup_saved_wallet",
      revision: 1,
      phase: "private_ready",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      address: "0x3333333333333333333333333333333333333333",
      publicBalanceWei: "0",
      privateBalanceWei: "100000000000000000",
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
        enabled: false,
      },
    };
  });
  const wallet = new ManagedWallet();
  wallet.inventory.set("imported-wallet", "sepolia");
  const runtime = await createLocalRuntime(
    { ...loadConfig({ AGENT_BOOST_STATE_DIR: root }, root), uiPort: 0 },
    {
      wallet,
      chain: {
        async assertSepolia() {},
        async getBalanceWei() {
          return 0n;
        },
      },
      openBrowser: async () => false,
    },
  );
  const originalStart = OnboardingController.prototype.start;
  const originalResume = OnboardingController.prototype.resume;
  const activeBinding = async (): Promise<{
    expectedActiveWalletName: string;
    expectedActiveSelectionEpoch: number;
  }> => {
    const listing = await runtime.listWallets() as {
      wallets: Array<{ name: string; active: boolean; selection_epoch: number }>;
    };
    const active = listing.wallets.find((profile) => profile.active);
    assert.ok(active);
    return {
      expectedActiveWalletName: active.name,
      expectedActiveSelectionEpoch: active.selection_epoch,
    };
  };
  const assertCommitted = async (
    operation: Promise<Record<string, unknown>>,
    expectedName: string,
    expectedPhase = "not_started",
  ): Promise<void> => {
    const response = await operation as {
      wallet: { name: string; active: boolean };
      setup_phase: string;
      setup?: unknown;
      setup_continuation_status: string;
    };
    assert.equal(response.wallet.name, expectedName);
    assert.equal(response.wallet.active, true);
    assert.equal(response.setup_phase, expectedPhase);
    assert.equal(response.setup_continuation_status, "unavailable");
    assert.equal(response.setup, undefined);
    assert.equal(wallet.activeWallet, expectedName);
    const state = await store.read();
    assert.equal(state.wallet?.activeName, expectedName);
  };

  try {
    OnboardingController.prototype.start = async () => {
      throw new Error("forced post-commit setup failure");
    };
    OnboardingController.prototype.resume = async () => {
      throw new Error("forced post-commit resume failure");
    };

    await assertCommitted(runtime.createWallet({
      name: "created-wallet",
      userConfirmed: true,
      ...(await activeBinding()),
    }), "created-wallet");
    await assertCommitted(runtime.adoptWallet({
      name: "imported-wallet",
      userConfirmed: true,
      ...(await activeBinding()),
    }), "imported-wallet");
    await assertCommitted(runtime.selectWallet({
      walletId: saved.walletId,
      userConfirmed: true,
      ...(await activeBinding()),
    }), "saved-wallet", "private_ready");
  } finally {
    OnboardingController.prototype.start = originalStart;
    OnboardingController.prototype.resume = originalResume;
    await runtime.shutdown();
  }
});

test("a previous wallet preserves its expired authority, renews it, and becomes usable again", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-wallet-restore-"));
  await seedOnboarding(
    root,
    "private_ready",
    2_000_000_000_000_000_000n,
    100_000_000_000_000_000n,
  );
  const wallet = new ManagedWallet();
  const runtime = await createLocalRuntime(
    {
      ...loadConfig({
        AGENT_BOOST_STATE_DIR: root,
        AGENT_BOOST_FUNDING_POLL_MS: "1",
      }, root),
      uiPort: 0,
    },
    {
      wallet,
      chain: {
        async assertSepolia() {},
        async getBalanceWei(address) {
          return address === "0x1111111111111111111111111111111111111111"
            ? 2_000_000_000_000_000_000n
            : 0n;
        },
      },
      openBrowser: async () => false,
    },
  );
  try {
    const before = await runtime.listWallets() as {
      wallets: Array<{
        wallet_id: string;
        name: string;
        selection_epoch: number;
        setup_phase: string;
        authorization_status: string;
      }>;
    };
    const original = before.wallets.find(({ name }) => name === "agent-boost");
    assert.ok(original);
    assert.equal(original.setup_phase, "private_ready");
    assert.equal(original.authorization_status, "expired");

    const created = await runtime.createWallet({
      name: "second-wallet",
      userConfirmed: true,
      expectedActiveWalletName: original.name,
      expectedActiveSelectionEpoch: original.selection_epoch,
    }) as { wallet: { name: string }; authorization_required: boolean };
    assert.equal(created.wallet.name, "second-wallet");
    assert.equal(created.authorization_required, true);
    assert.equal(wallet.activeWallet, "second-wallet");

    const restored = await runtime.selectWallet({
      walletId: original.wallet_id,
      userConfirmed: true,
    }) as {
      wallet: { name: string; authorization_status: string };
      setup_phase: string;
      setup?: unknown;
      authorization_required: boolean;
    };
    assert.equal(restored.wallet.name, "agent-boost");
    assert.equal(restored.wallet.authorization_status, "expired");
    assert.equal(restored.setup_phase, "private_ready");
    assert.equal(restored.setup, undefined);
    assert.equal(restored.authorization_required, true);
    assert.equal(wallet.activeWallet, "agent-boost");

    const context = await runtime.walletContext();
    assert.equal(context.setup_phase, "private_ready");
    assert.equal(context.address, "0x1111111111111111111111111111111111111111");
    assert.equal(context.balance_atomic, "2000000000000000000");

    const reauthorization = await runtime.planWalletReauthorization();
    assert.equal(reauthorization.decision, "allow");
    assert.deepEqual(reauthorization.blockers, []);
    await runtime.reauthorizeWallet({
      decisionId: reauthorization.decisionId,
      userConfirmed: true,
    });

    const alreadySelected = await runtime.selectWallet({
      walletId: original.wallet_id,
      userConfirmed: false,
    }) as {
      changed: boolean;
      setup_phase: string;
      setup?: unknown;
      authorization_required: boolean;
      authorization_status: string;
    };
    assert.equal(alreadySelected.changed, false);
    assert.equal(alreadySelected.setup_phase, "private_ready");
    assert.equal(alreadySelected.setup, undefined);
    assert.equal(alreadySelected.authorization_required, false);
    assert.equal(alreadySelected.authorization_status, "active");

    const transfer = await runtime.planRegularTransfer({
      recipient: "0x2222222222222222222222222222222222222222",
      amountWei: "10000000000000000",
    });
    assert.equal(transfer.decision, "allow", JSON.stringify(transfer.blockers));
    assert.deepEqual(transfer.blockers, []);

    const after = await runtime.listWallets() as {
      wallets: Array<{
        wallet_id: string;
        name: string;
        active: boolean;
        authorization_status: string;
      }>;
    };
    assert.deepEqual(after.wallets.map(({ name }) => name), [
      "agent-boost",
      "second-wallet",
    ]);
    assert.equal(after.wallets[0]?.active, true);
    assert.equal(after.wallets[0]?.authorization_status, "active");
    const second = after.wallets.find(({ name }) => name === "second-wallet");
    assert.ok(second);
    await runtime.archiveWallet({ walletId: second.wallet_id, userConfirmed: true });
    const archived = await runtime.listWallets() as {
      wallets: Array<{ name: string; status: string }>;
    };
    assert.equal(
      archived.wallets.find(({ name }) => name === "second-wallet")?.status,
      "archived",
    );

    const reopened = await runtime.selectWallet({
      walletId: second.wallet_id,
      userConfirmed: true,
    }) as {
      wallet: { name: string; status: string; authorization_status: string };
      setup_phase: string;
      setup: { setupId: string; revision: number; phase: string };
    };
    assert.equal(reopened.wallet.name, "second-wallet");
    assert.equal(reopened.wallet.status, "available");
    assert.equal(reopened.wallet.authorization_status, "missing");
    assert.equal(reopened.setup_phase, "awaiting_funding");
    assert.equal(reopened.setup.phase, reopened.setup_phase);
    assert.match(reopened.setup.setupId, /^setup_/u);
    assert.ok(Number.isSafeInteger(reopened.setup.revision));
  } finally {
    await runtime.shutdown();
  }
});

test("named wallet policy read, preview, cancel, and apply never switch the active wallet", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-named-wallet-policy-"));
  await seedOnboarding(
    root,
    "private_ready",
    2_000_000_000_000_000_000n,
    100_000_000_000_000_000n,
  );
  const store = new StateStore(root);
  await store.initialize();
  const walletA = await store.activeWalletProfile();
  const walletB = await store.registerManagedWallet("wallet-b", "created");
  const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  await store.update((draft) => {
    const profile = draft.wallet!.profiles[walletB.walletId]!;
    profile.authorizationId = "auth_wallet-b";
    profile.onboarding = {
      ...structuredClone(draft.onboarding!),
      setupId: "setup_wallet-b-policy",
      revision: 1,
      address: "0x2222222222222222222222222222222222222222",
      delegation: {
        mode: "testnet_delegated",
        chainId: 11_155_111,
        perPaymentLimitWei: "1000",
        lifetimeLimitWei: "4000",
        spentWei: "0",
        maxPayments: 4,
        expiresAt: futureExpiry,
        enabled: true,
      },
    };
  });
  await store.activateWalletProfile(walletB.walletId);
  await store.activateWalletProfile(walletA.walletId);

  const wallet = new ManagedWallet();
  wallet.inventory.set("wallet-b", "sepolia");
  let runtime = await createLocalRuntime(
    {
      ...loadConfig({ AGENT_BOOST_STATE_DIR: root }, root),
      uiPort: 0,
    },
    {
      wallet,
      chain: {
        async assertSepolia() {},
        async getBalanceWei() {
          return 2_000_000_000_000_000_000n;
        },
      },
      openBrowser: async () => false,
    },
  );
  try {
    const before = await store.read();
    const activeBefore = before.wallet!.profiles[before.wallet!.activeWalletId]!;
    assert.equal(activeBefore.name, "agent-boost");
    const activeBinding = {
      walletId: activeBefore.walletId,
      walletName: activeBefore.name,
      selectionEpoch: activeBefore.selectionEpoch,
    };
    const activeProfileBefore = structuredClone(activeBefore);
    const activeOnboardingBefore = structuredClone(before.onboarding);
    const walletBBefore = structuredClone(before.wallet!.profiles[walletB.walletId]!);
    const assertStillActiveA = async (): Promise<void> => {
      const state = await store.read();
      const active = state.wallet!.profiles[state.wallet!.activeWalletId]!;
      assert.deepEqual({
        walletId: active.walletId,
        walletName: active.name,
        selectionEpoch: active.selectionEpoch,
      }, activeBinding);
      assert.deepEqual(active, activeProfileBefore);
      assert.deepEqual(state.onboarding, activeOnboardingBefore);
      assert.equal(wallet.activeWallet, "agent-boost");
    };

    const readB = await runtime.walletPolicy({ walletName: "the wallet b wallet" });
    assert.deepEqual(readB.wallet, {
      walletId: walletB.walletId,
      walletName: "wallet-b",
      selectionEpoch: walletBBefore.selectionEpoch,
    });
    assert.equal(readB.maxPayments, 4);
    assert.equal(readB.perPaymentLimitWei, "1000");
    await assertStillActiveA();

    const cancelledPreview = await runtime.planPolicyUpdate({
      walletName: "wallet b",
      maxPayments: 3,
    });
    assert.equal(cancelledPreview.wallet.walletId, walletB.walletId);
    assert.equal(cancelledPreview.wallet.walletName, "wallet-b");
    assert.equal(cancelledPreview.decision, "allow", JSON.stringify(cancelledPreview));
    await assertStillActiveA();
    const cancelled = await runtime.cancelPolicyUpdatePlan(
      cancelledPreview.decisionId,
    );
    assert.ok(cancelled.blockers.includes("USER_CANCELLED"));
    await assertStillActiveA();
    assert.deepEqual(
      (await store.read()).wallet!.profiles[walletB.walletId]!.onboarding,
      walletBBefore.onboarding,
    );

    const plan = await runtime.planPolicyUpdate({
      walletName: "wallet-b",
      enabled: false,
    });
    assert.equal(plan.wallet.walletId, walletB.walletId);
    assert.equal(plan.wallet.walletName, "wallet-b");
    assert.equal(plan.current.enabled, true);
    assert.equal(plan.proposed.enabled, false);
    assert.equal(plan.proposed.perPaymentLimitWei, plan.current.perPaymentLimitWei);
    assert.equal(plan.proposed.lifetimeLimitWei, plan.current.lifetimeLimitWei);
    assert.equal(plan.proposed.maxPayments, plan.current.maxPayments);
    assert.equal(plan.proposed.expiresAt, plan.current.expiresAt);
    await assertStillActiveA();

    const receipt = await runtime.applyPolicyUpdate({
      decisionId: plan.decisionId,
      userConfirmed: true,
    });
    assert.deepEqual(receipt.wallet, plan.wallet);
    assert.equal(receipt.policy.enabled, false);
    await assertStillActiveA();
    const after = await store.read();
    const updatedB = after.wallet!.profiles[walletB.walletId]!;
    assert.equal(updatedB.onboarding!.delegation.enabled, false);
    assert.deepEqual(
      updatedB.privateBalances[updatedB.defaultPrivateBalanceId]!.delegation,
      updatedB.onboarding!.delegation,
    );

    await runtime.shutdown();
    runtime = await createLocalRuntime(
      {
        ...loadConfig({ AGENT_BOOST_STATE_DIR: root }, root),
        uiPort: 0,
      },
      {
        wallet,
        chain: {
          async assertSepolia() {},
          async getBalanceWei() {
            return 2_000_000_000_000_000_000n;
          },
        },
        openBrowser: async () => false,
      },
    );
    const restartedRead = await runtime.walletPolicy({ walletName: "wallet-b" });
    const { wallet: restartedBinding, ...restartedPolicy } = restartedRead;
    assert.deepEqual(restartedBinding, receipt.wallet);
    assert.deepEqual(restartedPolicy, receipt.policy);
    const restartedStore = new StateStore(root);
    await restartedStore.initialize();
    const restartedState = await restartedStore.read();
    assert.equal(restartedState.wallet!.activeWalletId, activeBinding.walletId);
    assert.equal(restartedState.wallet!.activeName, activeBinding.walletName);
    assert.deepEqual(
      restartedState.wallet!.profiles[activeBinding.walletId],
      activeProfileBefore,
    );
    assert.deepEqual(restartedState.onboarding, activeOnboardingBefore);
    assert.equal(wallet.activeWallet, "agent-boost");
  } finally {
    await runtime.shutdown();
  }
});

test("transfer planning resolves unique saved-wallet names without exposing inventory addresses", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-wallet-recipient-"));
  await seedOnboarding(
    root,
    "private_ready",
    2_000_000_000_000_000_000n,
    100_000_000_000_000_000n,
  );
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("agent-boost");
  const target = await store.registerManagedWallet("new_private_wallet", "adopted");
  const ambiguousOne = await store.registerManagedWallet("spare-wallet", "adopted");
  const ambiguousTwo = await store.registerManagedWallet("spare_wallet", "adopted");
  const addressless = await store.registerManagedWallet("not-ready", "adopted");
  await store.update((draft) => {
    assert.ok(draft.onboarding);
    draft.onboarding.delegation.expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const recipientSetup: OnboardingRecord = {
      ...structuredClone(draft.onboarding),
      setupId: "setup_named_recipient",
      address: "0x2222222222222222222222222222222222222222",
      publicBalanceWei: "0",
      privateBalanceWei: "0",
    };
    draft.wallet!.profiles[target.walletId]!.authorizationId = "auth_named-source";
    draft.wallet!.profiles[target.walletId]!.onboarding = recipientSetup;
    draft.wallet!.profiles[ambiguousOne.walletId]!.onboarding = {
      ...recipientSetup,
      setupId: "setup_ambiguous_one",
      address: "0x3333333333333333333333333333333333333333",
    };
    draft.wallet!.profiles[ambiguousTwo.walletId]!.onboarding = {
      ...recipientSetup,
      setupId: "setup_ambiguous_two",
      address: "0x4444444444444444444444444444444444444444",
    };
    draft.wallet!.profiles[addressless.walletId]!.onboarding = {
      ...recipientSetup,
      setupId: "setup_addressless",
      phase: "not_started",
      address: undefined,
    } as unknown as OnboardingRecord;
  });

  const runtime = await createLocalRuntime(
    {
      ...loadConfig({ AGENT_BOOST_STATE_DIR: root }, root),
      uiPort: 0,
    },
    {
      wallet: new ManagedWallet(),
      chain: {
        async assertSepolia() {},
        async getBalanceWei(address) {
          return address === "0x1111111111111111111111111111111111111111" ||
              address === "0x2222222222222222222222222222222222222222"
            ? 2_000_000_000_000_000_000n
            : 0n;
        },
      },
      openBrowser: async () => false,
    },
  );
  try {
    const inventory = await runtime.listWallets() as { wallets: Record<string, unknown>[] };
    assert.equal(JSON.stringify(inventory).includes("0x2222222222222222222222222222222222222222"), false);
    const previewedActive = inventory.wallets.find((wallet) => wallet.active === true);
    assert.equal(previewedActive?.name, "agent-boost");
    assert.equal(previewedActive?.selection_epoch, 1);

    const named = await runtime.planRegularTransfer({
      sourceWalletName: "the agent boost wallet",
      recipientWalletName: "my new private wallet",
      amountWei: "10000000000000000",
    });
    assert.equal(named.decision, "allow", JSON.stringify(named.blockers));
    assert.equal(named.authorization.walletName, "agent-boost");
    assert.equal(named.recipient, "0x2222222222222222222222222222222222222222");
    assert.equal(named.recipientWalletName, "new_private_wallet");

    const shortenedName = await runtime.planRegularTransfer({
      recipientWalletName: "new private",
      amountWei: "10000000000000000",
    });
    assert.equal(shortenedName.recipientWalletName, "new_private_wallet");
    assert.equal(
      shortenedName.recipient,
      "0x2222222222222222222222222222222222222222",
    );

    // Friendly labels are presentation-only. Keeping the durable version-2
    // plan byte-compatible means a pre-upgrade strict reader can still load
    // state written by this release after a rollback.
    const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8")) as {
      regularPlans: Record<string, Record<string, unknown>>;
    };
    assert.equal(
      "recipientWalletName" in persisted.regularPlans[named.decisionId]!,
      false,
    );
    const rollbackReader = new StateStore(root);
    await rollbackReader.initialize();
    assert.equal(
      (await rollbackReader.read()).regularPlans[named.decisionId]?.recipient,
      "0x2222222222222222222222222222222222222222",
    );

    const namedRequest = await runtime.executeRegularTransfer({
      decisionId: named.decisionId,
      clientRequestId: "named-wallet-rollback-compatibility",
      userConfirmed: true,
    });
    assert.equal(namedRequest.recipientWalletName, "new_private_wallet");
    const persistedAfterExecution = JSON.parse(
      await readFile(join(root, "state.json"), "utf8"),
    ) as {
      regularPlans: Record<string, Record<string, unknown>>;
      regularRequests: Record<string, Record<string, unknown>>;
    };
    for (const record of [
      persistedAfterExecution.regularPlans[named.decisionId]!,
      persistedAfterExecution.regularRequests[namedRequest.requestId]!,
    ]) {
      assert.equal("recipientWalletName" in record, false);
      assert.equal("sourceWalletName" in record, false);
    }
    assert.equal(
      (await rollbackReader.read()).regularRequests[namedRequest.requestId]?.recipient,
      "0x2222222222222222222222222222222222222222",
    );

    const rawAddress = await runtime.planRegularTransfer({
      recipient: "0x5555555555555555555555555555555555555555",
      amountWei: "10000000000000000",
    });
    assert.equal(rawAddress.recipientWalletName, undefined);

    await assert.rejects(
      runtime.planRegularTransfer({
        sourceWalletName: "my new private wallet",
        recipientWalletName: "new private wallet",
        amountWei: "10000000000000000",
      }),
      (error: unknown) => error instanceof AgentBoostRequestError &&
        error.code === "REGULAR_TRANSFER_SELF_SEND_BLOCKED",
    );
    const namedSource = await runtime.planRegularTransfer({
      sourceWalletName: "my new private wallet",
      recipient: "0x5555555555555555555555555555555555555555",
      amountWei: "10000000000000000",
    });
    assert.equal(namedSource.decision, "allow", JSON.stringify(namedSource.blockers));
    assert.equal(namedSource.authorization.walletName, "new_private_wallet");
    assert.equal(namedSource.authorization.authorizationId, "auth_named-source");
    const afterNamedSource = await store.read();
    assert.equal(afterNamedSource.wallet?.activeName, "new_private_wallet");
    assert.equal(
      afterNamedSource.wallet?.profiles[target.walletId]?.authorizationId,
      "auth_named-source",
    );
    await runtime.selectWallet({
      walletId: String(previewedActive?.wallet_id),
      userConfirmed: true,
    });
    await assert.rejects(
      runtime.planRegularTransfer({
        recipientWalletName: "spare wallet",
        amountWei: "10000000000000000",
      }),
      (error: unknown) => error instanceof AgentBoostRequestError &&
        error.code === "RECIPIENT_WALLET_AMBIGUOUS",
    );
    await assert.rejects(
      runtime.planRegularTransfer({
        recipientWalletName: "not ready",
        amountWei: "10000000000000000",
      }),
      (error: unknown) => error instanceof AgentBoostRequestError &&
        error.code === "RECIPIENT_WALLET_MAIN_ADDRESS_UNAVAILABLE",
    );
    await assert.rejects(
      runtime.planRegularTransfer({
        recipientWalletName: "private",
        amountWei: "10000000000000000",
      }),
      (error: unknown) => error instanceof AgentBoostRequestError &&
        error.code === "RECIPIENT_PRIVATE_ACCOUNT_UNSUPPORTED",
    );
    await assert.rejects(
      runtime.planRegularTransfer({
        recipientWalletName: "agent boost",
        amountWei: "10000000000000000",
      }),
      (error: unknown) => error instanceof AgentBoostRequestError &&
        error.code === "REGULAR_TRANSFER_SELF_SEND_BLOCKED",
    );
    await assert.rejects(
      runtime.planPrivatePayment({
        recipientWalletName: "agent boost wallet",
        amountWei: "10000000000000000",
      }),
      (error: unknown) => error instanceof AgentBoostRequestError &&
        error.code === "USE_RECOVERY_TRANSFER",
    );
    const recovery = await runtime.planRecoveryTransfer({
      recipientWalletName: "agent boost wallet",
      amountWei: "10000000000000000",
    });
    assert.equal(recovery.recipientWalletName, "agent-boost");
    assert.equal(recovery.recipient, "0x1111111111111111111111111111111111111111");

    await assert.rejects(
      runtime.selectWallet({
        walletId: target.walletId,
        userConfirmed: true,
        expectedActiveWalletName: "agent-boost",
      }),
      (error: unknown) => error instanceof AgentBoostRequestError &&
        error.code === "WALLET_SWITCH_BINDING_REQUIRED",
    );

    // A later approval is bound to the active profile shown in its preview.
    // Even when another operation switches away and the original target is
    // still available, the stale approval must not perform a second switch.
    await runtime.selectWallet({
      walletId: ambiguousOne.walletId,
      userConfirmed: true,
    });
    await assert.rejects(
      runtime.selectWallet({
        walletId: target.walletId,
        userConfirmed: true,
        expectedActiveWalletName: previewedActive!.name as string,
        expectedActiveSelectionEpoch: previewedActive!.selection_epoch as number,
      }),
      (error: unknown) => error instanceof AgentBoostRequestError &&
        error.code === "WALLET_SWITCH_PREVIEW_STALE" &&
        error.details.active_wallet_name === "spare-wallet",
    );
    const afterStaleApproval = await runtime.listWallets() as {
      wallets: Array<{ name: string; active: boolean }>;
    };
    assert.equal(
      afterStaleApproval.wallets.find((wallet) => wallet.active)?.name,
      "spare-wallet",
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
    assert.equal(tree.profiles[0]?.policy?.freshness, "current");
    assert.equal(tree.profiles[0]?.policy?.maxPayments, 1);
    assert.equal(tree.profiles[0]?.policy?.paymentsUsed, 0);
    assert.equal(tree.profiles[0]?.policy?.paymentsRemaining, 1);
    assert.equal(tree.profiles[0]?.subwallets[0]?.shortName, "private");
    assert.equal(tree.profiles[0]?.subwallets[0]?.balanceWei, "250000000000000000");
    assert.equal(tree.profiles[0]?.subwallets[0]?.freshness, "live");
    assert.equal(tree.profiles[0]?.subwallets[0]?.policy.freshness, "current");
    assert.equal(tree.profiles[0]?.subwallets[0]?.policy.maxPayments, 1);
    assert.equal(tree.profiles[0]?.subwallets[0]?.policy.paymentsUsed, 0);
    assert.equal(tree.profiles[1]?.shortName, "travel");
    assert.equal(tree.profiles[1]?.active, false);
    assert.equal(tree.profiles[1]?.main.balanceWei, "750000000000000000");
    assert.equal(tree.profiles[1]?.main.freshness, "live");
    assert.equal(tree.profiles[1]?.subwallets[0]?.balanceWei, "100000000000000000");
    assert.equal(tree.profiles[1]?.subwallets[0]?.freshness, "last_known");
    assert.equal(tree.profiles[1]?.policy?.freshness, "last_known");
    assert.equal(tree.profiles[1]?.subwallets[0]?.policy.freshness, "last_known");
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

test("wallet tree preserves a pocket snapshot while its regular send is unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-wallet-tree-regular-reservation-"));
  const config = {
    ...loadConfig({
      AGENT_BOOST_STATE_DIR: root,
      AGENT_BOOST_FUNDING_POLL_MS: "1",
    }, root),
    uiPort: 0,
  };
  await seedOnboarding(root, "private_ready", 1_000n, 1n);
  const store = new StateStore(root);
  await store.initialize();
  const profile = await store.activeWalletProfile();
  await store.update((draft) => {
    assert.ok(draft.onboarding);
    draft.onboarding.delegation.maxPayments = 10;
    draft.wallet!.profiles[profile.walletId]!
      .privateBalances[profile.defaultPrivateBalanceId]!.delegation.maxPayments = 10;
  });
  await seedRegularRequestFixture(store, {
    suffix: "tree_reserved_pocket",
    phase: "submitted",
    privateBalanceId: profile.defaultPrivateBalanceId,
  });
  const wallet = new SnapshotWallet(999n, 250n);
  let publicChangeReads = 0;
  const runtime = await createLocalRuntime(config, {
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei(address) {
        if (address !== "0x1111111111111111111111111111111111111111") {
          publicChangeReads += 1;
        }
        return 1_000n;
      },
    },
  });
  try {
    const privateReadsBefore = wallet.privateReads;
    const tree = await runtime.walletTree();
    const pocket = tree.profiles[0]?.subwallets[0];
    assert.ok(pocket);
    assert.equal(wallet.privateReads, privateReadsBefore);
    assert.equal(publicChangeReads, 0);
    assert.equal(pocket.balanceWei, "1");
    assert.equal(pocket.freshness, "last_known");
    assert.equal(pocket.publicChangeWei, "100");
    assert.equal(pocket.publicChangeFreshness, "last_known");
    assert.equal(tree.profiles[0]?.policy?.paymentsUsed, 2);
    assert.equal(tree.profiles[0]?.policy?.paymentsRemaining, 8);
    assert.equal(pocket.policy.paymentsUsed, 2);
    assert.equal(pocket.policy.paymentsRemaining, 8);
  } finally {
    await runtime.shutdown();
  }
});
