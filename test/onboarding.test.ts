import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import type {
  ChainClient,
  RawTransactionBroadcastCheckpoint,
  WalletAdapter,
} from "../src/contracts.js";
import { OnboardingController, type OnboardingClock } from "../src/onboarding.js";
import { StateStore } from "../src/state/store.js";

const MAIN_ADDRESS = "0x1111111111111111111111111111111111111111";
const TORNADO_POOL = "0x8c4a04d872a6c1be37964a21ba3a138525dff50b";
const COMMITMENT = `0x${"12".repeat(32)}`;
const DEPOSIT_DATA = `0xb214faa5${COMMITMENT.slice(2)}`;
const SHIELD_AMOUNT_WEI = 100_000_000_000_000_000n;
const SHIELD_TRANSACTION_HASH = `0x${"ab".repeat(32)}`;

class FakeWallet implements WalletAdapter {
  shielded = false;
  shieldAttempts: Array<{ requestId: string; sourceAddress: string }> = [];
  checkpointLookups: string[] = [];
  checkpoint: RawTransactionBroadcastCheckpoint | undefined;
  failBeforeCheckpoint = false;
  failAfterCheckpoint = false;
  privateBalanceReadsBeforeReady = 0;
  async ensureWallet(): Promise<void> {}
  async nextFreshAddress(): Promise<string> {
    return MAIN_ADDRESS;
  }
  async prewarmPrivacy(): Promise<void> {}
  async shieldWei(amountWei: bigint, input: {
    sourceAddress: string;
    preparedDepositCall?: { to: string; data: string; valueWei: string };
    broadcastRequestId: string;
    beforeBroadcast: (
      preparedDepositCall: { to: string; data: string; valueWei: string },
    ) => Promise<void>;
  }): Promise<{ transactionHash: string }> {
    assert.equal(amountWei, SHIELD_AMOUNT_WEI);
    this.shieldAttempts.push({
      requestId: input.broadcastRequestId,
      sourceAddress: input.sourceAddress,
    });
    await input.beforeBroadcast(input.preparedDepositCall ?? {
      to: TORNADO_POOL,
      data: DEPOSIT_DATA,
      valueWei: amountWei.toString(),
    });
    if (this.failBeforeCheckpoint) {
      throw new Error("failed before network handoff");
    }
    this.checkpoint = {
      version: 1,
      requestId: input.broadcastRequestId,
      transactionHash: SHIELD_TRANSACTION_HASH,
      from: input.sourceAddress.toLowerCase(),
      to: TORNADO_POOL,
      valueWei: amountWei.toString(),
      data: DEPOSIT_DATA,
      chainId: 11_155_111,
      nonce: "0",
      gas: "1000000",
      transactionType: "eip1559",
      journaledAt: new Date(0).toISOString(),
    };
    if (this.failAfterCheckpoint) {
      throw new Error("provider timed out after network handoff");
    }
    this.shielded = true;
    return { transactionHash: SHIELD_TRANSACTION_HASH };
  }
  async getRawTransactionBroadcastCheckpoint(
    requestId: string,
  ): Promise<RawTransactionBroadcastCheckpoint | undefined> {
    this.checkpointLookups.push(requestId);
    return this.checkpoint?.requestId === requestId
      ? structuredClone(this.checkpoint)
      : undefined;
  }
  async getPrivateBalanceWei(): Promise<bigint> {
    if (this.shielded && this.privateBalanceReadsBeforeReady > 0) {
      this.privateBalanceReadsBeforeReady -= 1;
      return 0n;
    }
    return this.shielded ? SHIELD_AMOUNT_WEI : 0n;
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

class ImmediateClock implements OnboardingClock {
  #time = 0;
  now(): Date {
    return new Date(this.#time);
  }
  async sleep(ms: number): Promise<void> {
    this.#time += ms;
  }
}

async function waitForPhase(
  controller: OnboardingController,
  phase: "failed" | "private_ready",
): Promise<Awaited<ReturnType<OnboardingController["getRecord"]>>> {
  let record = await controller.getRecord();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (record.phase === phase) return record;
    record = await controller.status({
      setupId: record.setupId,
      sinceRevision: record.revision,
      waitMs: 250,
    });
  }
  assert.fail(`onboarding did not reach ${phase}; current phase is ${record.phase}`);
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
  assert.equal(started.address, MAIN_ADDRESS);
  assert.equal(
    started.delegation.expiresAt,
    new Date(7 * 24 * 60 * 60_000).toISOString(),
  );

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
      assert.equal(wallet.shieldAttempts.length, 1);
      assert.equal(wallet.shieldAttempts[0]?.sourceAddress, MAIN_ADDRESS);
      assert.match(
        wallet.shieldAttempts[0]?.requestId ?? "",
        /^onboarding-shield:[0-9a-f]{64}$/u,
      );
      assert.deepEqual(state.shieldPreparedDepositCall, {
        to: TORNADO_POOL,
        data: DEPOSIT_DATA,
        valueWei: SHIELD_AMOUNT_WEI.toString(),
      });
      assert.equal(state.shieldTransactionHash, SHIELD_TRANSACTION_HASH);
      const publicSnapshot = await controller.getPublicSnapshot();
      assert.equal("shieldPreparedDepositCall" in publicSnapshot, false);
      assert.equal("shieldTransactionHash" in publicSnapshot, false);
      assert.equal(networkAssertions, 2);
      return;
    }
  }
  assert.fail(`onboarding did not become ready: ${(await controller.getRecord()).phase}`);
});

test("onboarding rechecks live funding immediately before its first shield", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-onboarding-recheck-"));
  const store = new StateStore(root);
  await store.initialize();
  const wallet = new FakeWallet();
  let balanceReads = 0;
  let liveBalance = 109_999_999_999_999_999n;
  const controller = new OnboardingController({
    store,
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei() {
        balanceReads += 1;
        return balanceReads === 1
          ? 200_000_000_000_000_000n
          : liveBalance;
      },
    },
    config: loadConfig(
      {
        AGENT_BOOST_STATE_DIR: root,
        AGENT_BOOST_FUNDING_POLL_MS: "1",
        AGENT_BOOST_PRIVATE_POLL_MS: "1",
        AGENT_BOOST_SETUP_TIMEOUT_MS: "1000",
      },
      root,
    ),
    clock: new ImmediateClock(),
  });

  await controller.start();
  let record = await controller.getRecord();
  for (let attempt = 0; attempt < 20 && record.phase !== "funding_pending"; attempt += 1) {
    record = await controller.status({
      setupId: record.setupId,
      sinceRevision: record.revision,
      waitMs: 100,
    });
  }
  assert.equal(record.phase, "funding_pending");
  assert.equal(record.publicBalanceWei, liveBalance.toString());
  assert.equal(wallet.shieldAttempts.length, 0);

  liveBalance = 200_000_000_000_000_000n;
  await controller.resume();
  const ready = await waitForPhase(controller, "private_ready");
  await controller.stop();
  assert.equal(ready.phase, "private_ready");
  assert.equal(wallet.shieldAttempts.length, 1);
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

test("awaiting-funding survives transient balance-read failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-onboarding-rpc-recovery-"));
  const store = new StateStore(root);
  await store.initialize();
  let balanceReads = 0;
  const controller = new OnboardingController({
    store,
    wallet: new FakeWallet(),
    chain: {
      async assertSepolia() {},
      async getBalanceWei() {
        balanceReads += 1;
        if (balanceReads < 3) throw new Error("Sepolia RPC request failed");
        return 0n;
      },
    },
    config: loadConfig(
      {
        AGENT_BOOST_STATE_DIR: root,
        AGENT_BOOST_FUNDING_POLL_MS: "5",
        AGENT_BOOST_SETUP_TIMEOUT_MS: "1000",
      },
      root,
    ),
  });

  const started = await controller.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const recovered = await controller.getRecord();
  assert.equal(recovered.setupId, started.setupId);
  assert.equal(recovered.phase, "awaiting_funding");
  assert.equal(recovered.error, undefined);
  assert.ok(balanceReads >= 3);
  await controller.stop();
});

test("restart resumes a retryable funding failure with the same setup and address", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-onboarding-retry-"));
  const store = new StateStore(root);
  await store.initialize();
  const setupId = "setup_existing";
  const address = "0x2222222222222222222222222222222222222222";
  await store.update((draft) => {
    draft.onboarding = {
      version: 1,
      setupId,
      revision: 5,
      phase: "failed",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(1).toISOString(),
      address,
      publicBalanceWei: "0",
      privateBalanceWei: "0",
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
      error: {
        code: "FUNDING_OR_SHIELD_FAILED",
        message: "Funding verification did not complete.",
        retryable: true,
      },
    };
  });

  let freshAddressCalls = 0;
  const wallet = new FakeWallet();
  wallet.nextFreshAddress = async () => {
    freshAddressCalls += 1;
    return "0x3333333333333333333333333333333333333333";
  };
  const controller = new OnboardingController({
    store,
    wallet,
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

  await controller.resume();
  const resumed = await controller.getRecord();
  assert.equal(resumed.setupId, setupId);
  assert.equal(resumed.address, address);
  assert.equal(resumed.phase, "awaiting_funding");
  assert.equal(resumed.error, undefined);
  assert.equal(freshAddressCalls, 0);
  await controller.stop();
});

test("restart reconciles an exact shield checkpoint without rebroadcasting", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-onboarding-journal-restart-"));
  const store = new StateStore(root);
  await store.initialize();
  const wallet = new FakeWallet();
  wallet.failAfterCheckpoint = true;
  const config = loadConfig(
    {
      AGENT_BOOST_STATE_DIR: root,
      AGENT_BOOST_FUNDING_POLL_MS: "1",
      AGENT_BOOST_PRIVATE_POLL_MS: "1",
      AGENT_BOOST_SETUP_TIMEOUT_MS: "5",
    },
    root,
  );
  const chain: ChainClient = {
    async assertSepolia() {},
    async getBalanceWei() {
      return 200_000_000_000_000_000n;
    },
  };
  const first = new OnboardingController({
    store,
    wallet,
    chain,
    config,
    clock: new ImmediateClock(),
  });

  await first.start();
  const timedOut = await waitForPhase(first, "failed");
  await first.stop();
  assert.equal(timedOut.phase, "failed");
  assert.equal(timedOut.error?.code, "PRIVATE_BALANCE_TIMEOUT");
  assert.equal(timedOut.shieldTransactionHash, SHIELD_TRANSACTION_HASH);
  assert.equal(wallet.shieldAttempts.length, 1);
  const stableRequestId = wallet.shieldAttempts[0]!.requestId;

  wallet.failAfterCheckpoint = false;
  wallet.shielded = true;
  wallet.privateBalanceReadsBeforeReady = 1;
  const restarted = new OnboardingController({
    store: new StateStore(root),
    wallet,
    chain,
    config,
    clock: new ImmediateClock(),
  });
  await restarted.resume();
  const recovered = await waitForPhase(restarted, "private_ready");
  await restarted.stop();

  assert.equal(recovered.phase, "private_ready");
  assert.equal(recovered.shieldTransactionHash, SHIELD_TRANSACTION_HASH);
  assert.equal(wallet.shieldAttempts.length, 1);
  assert.ok(wallet.checkpointLookups.includes(stableRequestId));
  assert.equal(new Set(wallet.checkpointLookups).size, 1);
});

test("a pre-network shield failure can safely retry the same setup request", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-onboarding-safe-retry-"));
  const store = new StateStore(root);
  await store.initialize();
  const wallet = new FakeWallet();
  wallet.failBeforeCheckpoint = true;
  const config = loadConfig(
    {
      AGENT_BOOST_STATE_DIR: root,
      AGENT_BOOST_FUNDING_POLL_MS: "1",
      AGENT_BOOST_PRIVATE_POLL_MS: "1",
      AGENT_BOOST_SETUP_TIMEOUT_MS: "5",
    },
    root,
  );
  const chain: ChainClient = {
    async assertSepolia() {},
    async getBalanceWei() {
      return 200_000_000_000_000_000n;
    },
  };
  const first = new OnboardingController({
    store,
    wallet,
    chain,
    config,
    clock: new ImmediateClock(),
  });
  await first.start();
  await waitForPhase(first, "failed");
  await first.stop();
  assert.equal((await first.getRecord()).phase, "failed");
  assert.equal(wallet.shieldAttempts.length, 1);
  assert.equal(wallet.checkpoint, undefined);

  wallet.failBeforeCheckpoint = false;
  const restarted = new OnboardingController({
    store: new StateStore(root),
    wallet,
    chain,
    config,
    clock: new ImmediateClock(),
  });
  await restarted.resume();
  await waitForPhase(restarted, "private_ready");
  await restarted.stop();

  assert.equal((await restarted.getRecord()).phase, "private_ready");
  assert.equal(wallet.shieldAttempts.length, 2);
  assert.equal(
    wallet.shieldAttempts[0]?.requestId,
    wallet.shieldAttempts[1]?.requestId,
  );
  const finalCheckpoint = wallet.checkpoint as
    | RawTransactionBroadcastCheckpoint
    | undefined;
  assert.equal(finalCheckpoint?.requestId, wallet.shieldAttempts[0]?.requestId);
});

test("a reverted exact shield checkpoint fails terminally without rebroadcast", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-onboarding-reverted-"));
  const store = new StateStore(root);
  await store.initialize();
  const wallet = new FakeWallet();
  wallet.failAfterCheckpoint = true;
  const receiptLookups: string[] = [];
  const controller = new OnboardingController({
    store,
    wallet,
    chain: {
      async assertSepolia() {},
      async getBalanceWei() {
        return 200_000_000_000_000_000n;
      },
      async getTransactionReceiptStatus(transactionHash) {
        receiptLookups.push(transactionHash);
        return "reverted";
      },
    },
    config: loadConfig(
      {
        AGENT_BOOST_STATE_DIR: root,
        AGENT_BOOST_FUNDING_POLL_MS: "1",
        AGENT_BOOST_PRIVATE_POLL_MS: "1",
        AGENT_BOOST_SETUP_TIMEOUT_MS: "100",
      },
      root,
    ),
    clock: new ImmediateClock(),
  });

  await controller.start();
  await waitForPhase(controller, "failed");
  await controller.stop();
  const failed = await controller.getRecord();
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error?.code, "SHIELD_TRANSACTION_REVERTED");
  assert.equal(failed.error?.retryable, false);
  assert.deepEqual(receiptLookups, [SHIELD_TRANSACTION_HASH]);
  assert.equal(wallet.shieldAttempts.length, 1);

  await controller.start();
  assert.equal(wallet.shieldAttempts.length, 1);
  assert.equal((await controller.getRecord()).error?.retryable, false);
});
