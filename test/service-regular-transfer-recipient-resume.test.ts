import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
import { createLocalRuntime } from "../src/service.js";
import { StateStore } from "../src/state/store.js";

const SOURCE_WALLET = "agent-boost";
const TARGET_WALLET = "wallet-b";
const THIRD_WALLET = "wallet-c";
const SOURCE_ADDRESS = "0x1111111111111111111111111111111111111111";
const TARGET_ADDRESS = "0x2222222222222222222222222222222222222222";
const THIRD_ADDRESS = "0x3333333333333333333333333333333333333333";
const TRANSFER_AMOUNT_WEI = 200_000_000_000_000_000n;
const SOURCE_BALANCE_WEI = 2_000_000_000_000_000_000n;
const TRANSACTION_HASH = `0x${"ab".repeat(32)}`;

class FundingChain implements ChainClient {
  readonly balances = new Map<string, bigint>();
  receipt: "pending" | "success" | "reverted" = "pending";

  async assertSepolia(): Promise<void> {}

  async getBalanceWei(address: string): Promise<bigint> {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }

  async getTransactionReceiptStatus(): Promise<
    "pending" | "success" | "reverted"
  > {
    return this.receipt;
  }
}

class FundingWallet implements WalletAdapter {
  activeWallet = TARGET_WALLET;
  readonly inventory = new Set([SOURCE_WALLET, TARGET_WALLET, THIRD_WALLET]);
  readonly broadcastRequestIds: string[] = [];

  constructor(
    readonly chain: FundingChain,
    readonly adapterConfirms: boolean,
  ) {}

  selectWallet(walletName: string): void {
    this.activeWallet = walletName;
  }

  async listWallets(): Promise<WalletInventoryItem[]> {
    return [...this.inventory].map((name) => ({ name, network: "sepolia" }));
  }

  async ensureWallet(): Promise<void> {}

  async nextFreshAddress(): Promise<string> {
    if (this.activeWallet === SOURCE_WALLET) return SOURCE_ADDRESS;
    if (this.activeWallet === TARGET_WALLET) return TARGET_ADDRESS;
    return THIRD_ADDRESS;
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

  async executeRegularTransfer(input: {
    sourceAddress: string;
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash: string; confirmed: boolean }> {
    await input.beforeBroadcast();
    this.broadcastRequestIds.push(input.broadcastRequestId);
    const source = input.sourceAddress.toLowerCase();
    const recipient = input.recipient.toLowerCase();
    this.chain.balances.set(
      source,
      (this.chain.balances.get(source) ?? 0n) - input.amountWei,
    );
    this.chain.balances.set(
      recipient,
      (this.chain.balances.get(recipient) ?? 0n) + input.amountWei,
    );
    return {
      transactionHash: TRANSACTION_HASH,
      confirmed: this.adapterConfirms,
    };
  }
}

function onboardingRecord(input: {
  setupId: string;
  phase: OnboardingPhase;
  address: string;
  publicBalanceWei: bigint;
  authorized: boolean;
}): OnboardingRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    setupId: input.setupId,
    revision: 1,
    phase: input.phase,
    createdAt: now,
    updatedAt: now,
    address: input.address,
    publicBalanceWei: input.publicBalanceWei.toString(),
    privateBalanceWei: input.phase === "private_ready"
      ? "100000000000000000"
      : "0",
    requiredFundingWei: TRANSFER_AMOUNT_WEI.toString(),
    shieldAmountWei: "100000000000000000",
    delegation: {
      mode: "testnet_delegated",
      chainId: 11_155_111,
      perPaymentLimitWei: "1000000000000000000",
      lifetimeLimitWei: "10000000000000000000",
      spentWei: "0",
      maxPayments: 10,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      enabled: input.authorized,
    },
  };
}

async function seedFundingScenario(
  root: string,
  includeThirdWallet = false,
): Promise<{
  store: StateStore;
  sourceWalletId: string;
  targetWalletId: string;
  thirdWalletId?: string;
  targetSetupId: string;
}> {
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile(SOURCE_WALLET);
  const source = await store.activeWalletProfile();
  const target = await store.registerManagedWallet(TARGET_WALLET, "created");
  const third = includeThirdWallet
    ? await store.registerManagedWallet(THIRD_WALLET, "created")
    : undefined;
  const targetSetupId = "setup_wallet_b_funding";
  await store.update((draft) => {
    draft.onboarding = onboardingRecord({
      setupId: "setup_wallet_a_ready",
      phase: "private_ready",
      address: SOURCE_ADDRESS,
      publicBalanceWei: SOURCE_BALANCE_WEI,
      authorized: true,
    });
    draft.wallet!.profiles[target.walletId]!.onboarding = onboardingRecord({
      setupId: targetSetupId,
      phase: "awaiting_funding",
      address: TARGET_ADDRESS,
      publicBalanceWei: 0n,
      authorized: false,
    });
    if (third) {
      draft.wallet!.profiles[third.walletId]!.onboarding = onboardingRecord({
        setupId: "setup_wallet_c_ready",
        phase: "private_ready",
        address: THIRD_ADDRESS,
        publicBalanceWei: 0n,
        authorized: false,
      });
    }
  });
  await store.activateWalletProfile(target.walletId);
  return {
    store,
    sourceWalletId: source.walletId,
    targetWalletId: target.walletId,
    ...(third ? { thirdWalletId: third.walletId } : {}),
    targetSetupId,
  };
}

function runtimeConfig(root: string) {
  return {
    ...loadConfig({
      AGENT_BOOST_STATE_DIR: root,
      AGENT_BOOST_AUTO_SHIELD: "false",
      AGENT_BOOST_FUNDING_WEI: TRANSFER_AMOUNT_WEI.toString(),
      AGENT_BOOST_FUNDING_POLL_MS: "1",
      AGENT_BOOST_SETUP_TIMEOUT_MS: "10000",
    }, root),
    uiPort: 0,
  };
}

async function waitForTargetFunding(
  store: StateStore,
  targetWalletId: string,
  targetSetupId: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await store.read();
    if (
      state.wallet?.activeWalletId === targetWalletId &&
      state.onboarding?.setupId === targetSetupId &&
      state.onboarding.phase === "funded_public"
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const state = await store.read();
  assert.fail(`target onboarding did not resume: ${JSON.stringify({
    activeWalletId: state.wallet?.activeWalletId,
    setupId: state.onboarding?.setupId,
    phase: state.onboarding?.phase,
  })}`);
}

async function planFundingTransfer(runtime: Awaited<
  ReturnType<typeof createLocalRuntime>
>) {
  const plan = await runtime.planRegularTransfer({
    sourceWalletName: SOURCE_WALLET,
    recipientWalletName: TARGET_WALLET,
    amountWei: TRANSFER_AMOUNT_WEI.toString(),
  });
  assert.equal(plan.decision, "allow", JSON.stringify(plan.blockers));
  assert.equal(plan.authorization.walletName, SOURCE_WALLET);
  assert.equal(plan.recipient, TARGET_ADDRESS);
  return plan;
}

test("confirmed named-source transfer returns to and resumes recipient onboarding", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-recipient-resume-"));
  const seeded = await seedFundingScenario(root);
  const chain = new FundingChain();
  chain.balances.set(SOURCE_ADDRESS, SOURCE_BALANCE_WEI);
  const wallet = new FundingWallet(chain, true);
  const runtime = await createLocalRuntime(runtimeConfig(root), {
    wallet,
    chain,
    openBrowser: async () => false,
  });
  try {
    const plan = await planFundingTransfer(runtime);
    assert.equal((await seeded.store.read()).wallet?.activeName, SOURCE_WALLET);

    const request = await runtime.executeRegularTransfer({
      decisionId: plan.decisionId,
      clientRequestId: "fund-wallet-b-confirmed",
      userConfirmed: true,
    });
    assert.equal(request.phase, "confirmed");
    assert.equal((await seeded.store.read()).wallet?.activeWalletId, seeded.targetWalletId);
    await waitForTargetFunding(
      seeded.store,
      seeded.targetWalletId,
      seeded.targetSetupId,
    );

    const replay = await runtime.executeRegularTransfer({
      decisionId: plan.decisionId,
      clientRequestId: "fund-wallet-b-confirmed",
      userConfirmed: true,
    });
    assert.equal(replay.requestId, request.requestId);
    assert.deepEqual(wallet.broadcastRequestIds, [request.requestId]);
    assert.equal(wallet.activeWallet, TARGET_WALLET);
  } finally {
    await runtime.shutdown();
  }
});

test("receipt reconciliation resumes a named recipient only after confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-recipient-reconcile-"));
  const seeded = await seedFundingScenario(root);
  const chain = new FundingChain();
  chain.balances.set(SOURCE_ADDRESS, SOURCE_BALANCE_WEI);
  const wallet = new FundingWallet(chain, false);
  const runtime = await createLocalRuntime(runtimeConfig(root), {
    wallet,
    chain,
    openBrowser: async () => false,
  });
  try {
    const plan = await planFundingTransfer(runtime);
    const submitted = await runtime.executeRegularTransfer({
      decisionId: plan.decisionId,
      clientRequestId: "fund-wallet-b-submitted",
      userConfirmed: true,
    });
    assert.equal(submitted.phase, "submitted");
    assert.equal((await seeded.store.read()).wallet?.activeName, SOURCE_WALLET);

    chain.receipt = "success";
    const confirmed = await runtime.getRegularTransferRequest(submitted.requestId);
    assert.equal(confirmed.phase, "confirmed");
    await waitForTargetFunding(
      seeded.store,
      seeded.targetWalletId,
      seeded.targetSetupId,
    );
    assert.deepEqual(wallet.broadcastRequestIds, [submitted.requestId]);
    assert.equal(wallet.activeWallet, TARGET_WALLET);
  } finally {
    await runtime.shutdown();
  }
});

test("restart reconciliation resumes recipient onboarding without rebroadcast", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-recipient-restart-"));
  const seeded = await seedFundingScenario(root);
  const chain = new FundingChain();
  chain.balances.set(SOURCE_ADDRESS, SOURCE_BALANCE_WEI);
  const wallet = new FundingWallet(chain, false);
  let runtime = await createLocalRuntime(runtimeConfig(root), {
    wallet,
    chain,
    openBrowser: async () => false,
  });
  let requestId: string;
  try {
    const plan = await planFundingTransfer(runtime);
    const submitted = await runtime.executeRegularTransfer({
      decisionId: plan.decisionId,
      clientRequestId: "fund-wallet-b-restart",
      userConfirmed: true,
    });
    assert.equal(submitted.phase, "submitted");
    requestId = submitted.requestId;
  } finally {
    await runtime.shutdown();
  }

  chain.receipt = "success";
  runtime = await createLocalRuntime(runtimeConfig(root), {
    wallet,
    chain,
    openBrowser: async () => false,
  });
  try {
    await waitForTargetFunding(
      seeded.store,
      seeded.targetWalletId,
      seeded.targetSetupId,
    );
    const recovered = await runtime.getRegularTransferRequest(requestId!);
    assert.equal(recovered.phase, "confirmed");
    assert.deepEqual(wallet.broadcastRequestIds, [requestId!]);
    assert.equal(wallet.activeWallet, TARGET_WALLET);
  } finally {
    await runtime.shutdown();
  }
});

test("a newer user selection epoch supersedes automatic recipient resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-recipient-override-"));
  const seeded = await seedFundingScenario(root, true);
  assert.ok(seeded.thirdWalletId);
  const chain = new FundingChain();
  chain.balances.set(SOURCE_ADDRESS, SOURCE_BALANCE_WEI);
  const wallet = new FundingWallet(chain, false);
  const runtime = await createLocalRuntime(runtimeConfig(root), {
    wallet,
    chain,
    openBrowser: async () => false,
  });
  try {
    const plan = await planFundingTransfer(runtime);
    const submitted = await runtime.executeRegularTransfer({
      decisionId: plan.decisionId,
      clientRequestId: "fund-wallet-b-user-override",
      userConfirmed: true,
    });
    assert.equal(submitted.phase, "submitted");

    await runtime.selectWallet({
      walletId: seeded.thirdWalletId!,
      userConfirmed: true,
    });
    await runtime.selectWallet({
      walletId: seeded.sourceWalletId,
      userConfirmed: true,
    });
    const reselected = await seeded.store.read();
    assert.equal(reselected.wallet?.activeName, SOURCE_WALLET);
    assert.ok(
      reselected.wallet!.profiles[seeded.sourceWalletId]!.selectionEpoch >
        submitted.authorization.selectionEpoch,
    );

    chain.receipt = "success";
    const confirmed = await runtime.getRegularTransferRequest(submitted.requestId);
    assert.equal(confirmed.phase, "confirmed");
    assert.equal((await seeded.store.read()).wallet?.activeName, SOURCE_WALLET);
    assert.equal(wallet.activeWallet, SOURCE_WALLET);
    assert.deepEqual(wallet.broadcastRequestIds, [submitted.requestId]);
  } finally {
    await runtime.shutdown();
  }
});
