import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ChainClient,
  PrivateBroadcastCheckpoint,
  RawTransactionBroadcastCheckpoint,
  WalletAdapter,
  WalletProfileRecord,
} from "../src/contracts.js";
import { WalletExecutionError } from "../src/errors.js";
import { PrivateBalanceController } from "../src/private-balance.js";
import { StateStore } from "../src/state/store.js";
import { seedRegularRequestFixture } from "./helpers/private-regular-fixture.js";

const MAIN = "0x1111111111111111111111111111111111111111";
const EXECUTOR = "0x2222222222222222222222222222222222222222";
const OTHER_EXECUTOR = "0x3333333333333333333333333333333333333333";
const POOL = "0x4444444444444444444444444444444444444444";
const ENTRY_POINT_V08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
const TX_HASH = `0x${"ab".repeat(32)}`;
const USER_OP_HASH = `0x${"cd".repeat(32)}`;
const DENOMINATION = 100_000_000_000_000_000n;
const GAS_RESERVE = 1_000_000_000_000_000n;

type ExecutionMode =
  | "deliver"
  | "confirmed_without_observation"
  | "submitted"
  | "reject_prebroadcast"
  | "fail_after_broadcast"
  | "unknown_failure";

class PhysicalWallet implements WalletAdapter {
  readonly balances = new Map<string, bigint>([["agent-boost", 0n]]);
  readonly nextExecutors = new Map<string, string>();
  readonly prepared = new Map<string, { targetWalletName: string; amountWei: bigint }>();
  ensureCalls = 0;
  syncCalls = 0;
  prepareCalls = 0;
  mainCalls = 0;
  rebalanceCalls = 0;
  shieldCalls = 0;
  mode: ExecutionMode = "deliver";
  ensureCreatesThenThrows = false;
  beforeMainExecution?: () => Promise<void> | void;
  beforeRebalanceExecution?: () => Promise<void> | void;
  checkpoint?: PrivateBroadcastCheckpoint;
  rawCheckpoint?: RawTransactionBroadcastCheckpoint;
  changeAccountCalls: Array<{ walletName: string; expectedAddress: string }> = [];
  failChangeAccountRecovery = false;

  selectWallet(_walletName: string): void {}
  async listWallets(): Promise<Array<{ name: string; network: "sepolia" }>> {
    return [...this.balances.keys()].map((name) => ({ name, network: "sepolia" }));
  }
  async ensureWallet(): Promise<void> {}
  async nextFreshAddress(): Promise<string> { return MAIN; }
  async prewarmPrivacy(): Promise<void> {}
  async shieldWei(): Promise<Record<string, never>> {
    this.shieldCalls += 1;
    return {};
  }
  async getPrivateBalanceWei(): Promise<bigint> {
    return this.balances.get("agent-boost") ?? 0n;
  }
  async executePrivatePayment(input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<Record<string, never>> {
    assert.match(input.broadcastRequestId, /^req_/u);
    return {};
  }

  async ensureBackendWallet(walletName: string): Promise<void> {
    this.ensureCalls += 1;
    this.balances.set(walletName, this.balances.get(walletName) ?? 0n);
    this.nextExecutors.set(walletName, this.nextExecutors.get(walletName) ?? EXECUTOR);
    if (this.ensureCreatesThenThrows) {
      throw new Error("connection vanished after the wallet was created");
    }
  }

  async syncBackendWallet(walletName: string): Promise<bigint> {
    this.syncCalls += 1;
    const balance = this.balances.get(walletName);
    if (balance === undefined) throw new Error("backend wallet not found");
    return balance;
  }

  async getPrivateBalanceWeiForWallet(walletName: string): Promise<bigint> {
    const balance = this.balances.get(walletName);
    if (balance === undefined) throw new Error("backend wallet not found");
    return balance;
  }

  async getPrivateBroadcastCheckpoint(
    _requestId: string,
  ): Promise<PrivateBroadcastCheckpoint | undefined> {
    return this.checkpoint;
  }

  async getRawTransactionBroadcastCheckpoint(
    requestId: string,
  ): Promise<RawTransactionBroadcastCheckpoint | undefined> {
    return this.rawCheckpoint?.requestId === requestId
      ? this.rawCheckpoint
      : undefined;
  }

  async ensurePrivateChangeAccount(
    walletName: string,
    expectedAddress: string,
  ): Promise<void> {
    this.changeAccountCalls.push({ walletName, expectedAddress });
    if (this.failChangeAccountRecovery) {
      throw new Error("private change account recovery failed");
    }
  }

  async peekNextFreshAddressForWallet(walletName: string): Promise<string> {
    return this.nextExecutors.get(walletName) ?? EXECUTOR;
  }

  async prepareTornadoEthDeposit(input: {
    targetWalletName: string;
    executorAddress: string;
    amountWei: bigint;
  }): Promise<{
    targetCommitment: string;
    preparedDepositCall: { to: string; data: string; valueWei: string };
  }> {
    assert.match(input.executorAddress, /^0x[0-9a-f]{40}$/i);
    this.prepareCalls += 1;
    const data = `0x${this.prepareCalls.toString(16).padStart(8, "0")}`;
    this.prepared.set(data, {
      targetWalletName: input.targetWalletName,
      amountWei: input.amountWei,
    });
    return {
      targetCommitment: `commitment-${this.prepareCalls}`,
      preparedDepositCall: { to: POOL, data, valueWei: input.amountWei.toString() },
    };
  }

  async executePreparedMainDeposit(input: {
    sourceWalletName: string;
    sourceExecutorAddress: string;
    preparedDepositCall: { to: string; data: string; valueWei: string };
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash?: string; confirmed?: boolean }> {
    this.mainCalls += 1;
    await this.beforeMainExecution?.();
    assert.equal(input.sourceWalletName, "agent-boost");
    assert.equal(input.sourceExecutorAddress, MAIN);
    const prepared = this.requiredPrepared(input.preparedDepositCall.data);
    if (this.mode === "reject_prebroadcast") throw boundaryError(false);
    await input.beforeBroadcast();
    if (this.mode === "fail_after_broadcast") throw boundaryError(true);
    if (this.mode === "unknown_failure") throw new Error("untyped transport failure");
    if (this.mode === "deliver") {
      this.credit(prepared.targetWalletName, prepared.amountWei);
      return { transactionHash: TX_HASH, confirmed: false };
    }
    if (this.mode === "confirmed_without_observation") {
      return { transactionHash: TX_HASH, confirmed: true };
    }
    return { transactionHash: TX_HASH, confirmed: false };
  }

  async executePrivateRebalance(input: {
    sourceWalletName: string;
    sourceExecutorAddress: string;
    withdrawalAmountWei: bigint;
    preparedDepositCall: { to: string; data: string; valueWei: string };
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash?: string;
    userOperationHash?: string;
    confirmed?: boolean;
  }> {
    this.rebalanceCalls += 1;
    assert.match(input.broadcastRequestId, /^pbfr_/u);
    await this.beforeRebalanceExecution?.();
    assert.equal(
      input.sourceExecutorAddress,
      this.nextExecutors.get(input.sourceWalletName) ?? EXECUTOR,
    );
    const prepared = this.requiredPrepared(input.preparedDepositCall.data);
    if (this.mode === "reject_prebroadcast") throw boundaryError(false);
    await input.beforeBroadcast();
    if (this.mode === "fail_after_broadcast") throw boundaryError(true);
    if (this.mode === "unknown_failure") throw new Error("untyped transport failure");
    if (this.mode === "deliver") {
      const source = this.balances.get(input.sourceWalletName) ?? 0n;
      assert.ok(source >= input.withdrawalAmountWei);
      this.balances.set(input.sourceWalletName, source - input.withdrawalAmountWei);
      this.credit(prepared.targetWalletName, prepared.amountWei);
      return {
        transactionHash: TX_HASH,
        userOperationHash: USER_OP_HASH,
        confirmed: false,
      };
    }
    if (this.mode === "confirmed_without_observation") {
      return { transactionHash: TX_HASH, userOperationHash: USER_OP_HASH, confirmed: true };
    }
    return { transactionHash: TX_HASH, userOperationHash: USER_OP_HASH, confirmed: false };
  }

  private requiredPrepared(data: string): { targetWalletName: string; amountWei: bigint } {
    const prepared = this.prepared.get(data);
    if (!prepared) throw new Error("prepared call not recognized");
    return prepared;
  }

  private credit(walletName: string, amountWei: bigint): void {
    this.balances.set(walletName, (this.balances.get(walletName) ?? 0n) + amountWei);
  }
}

class TestChain implements ChainClient {
  readonly balances = new Map<string, bigint>([[MAIN, 10n * DENOMINATION]]);
  receipt: "pending" | "success" | "reverted" = "pending";
  userOperationTransactionHash = TX_HASH;
  assertions = 0;
  transactionReceiptReads = 0;
  userOperationReceiptReads = 0;
  async assertSepolia(): Promise<void> { this.assertions += 1; }
  async getBalanceWei(address: string): Promise<bigint> {
    return this.balances.get(address) ?? 0n;
  }
  async getTransactionReceiptStatus(): Promise<"pending" | "success" | "reverted"> {
    this.transactionReceiptReads += 1;
    return this.receipt;
  }
  async getUserOperationReceiptStatus(hash: string, expectedSender?: string): Promise<
    | { status: "pending" }
    | { status: "success" | "reverted"; transactionHash: string }
  > {
    assert.equal(hash, USER_OP_HASH);
    if (expectedSender !== undefined) assert.equal(expectedSender, EXECUTOR);
    this.userOperationReceiptReads += 1;
    return this.receipt === "pending"
      ? { status: "pending" }
      : { status: this.receipt, transactionHash: this.userOperationTransactionHash };
  }
}

function boundaryError(mayHaveBroadcast: boolean): WalletExecutionError {
  return new WalletExecutionError(
    "KOHAKU_EXECUTION_FAILED",
    mayHaveBroadcast ? "broadcast transport failed" : "dry-run fee preflight rejected",
    { mayHaveBroadcast },
  );
}

function rawFundingCheckpoint(input: {
  requestId: string;
  to: string;
  valueWei: string;
  data: string;
}): RawTransactionBroadcastCheckpoint {
  return {
    version: 1,
    requestId: input.requestId,
    transactionHash: TX_HASH,
    from: MAIN,
    to: input.to.toLowerCase(),
    valueWei: input.valueWei,
    data: input.data.toLowerCase(),
    chainId: 11_155_111,
    nonce: "4",
    gas: "1000000",
    transactionType: "eip1559",
    journaledAt: new Date(1_000).toISOString(),
  };
}

async function readyStore(defaultPrivateBalanceWei = 0n): Promise<StateStore> {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-private-balance-"));
  const store = new StateStore(root);
  await store.initialize();
  await store.ensureWalletProfile("agent-boost");
  const now = new Date(0).toISOString();
  await store.update((draft) => {
    draft.onboarding = {
      version: 1,
      setupId: "setup-ready",
      revision: 1,
      phase: "private_ready",
      createdAt: now,
      updatedAt: now,
      address: MAIN,
      publicBalanceWei: (10n * DENOMINATION).toString(),
      privateBalanceWei: defaultPrivateBalanceWei.toString(),
      requiredFundingWei: (2n * DENOMINATION).toString(),
      shieldAmountWei: DENOMINATION.toString(),
      delegation: {
        mode: "testnet_delegated",
        chainId: 11_155_111,
        perPaymentLimitWei: DENOMINATION.toString(),
        lifetimeLimitWei: (10n * DENOMINATION).toString(),
        spentWei: "50000000000000000",
        maxPayments: 10,
        expiresAt: new Date(86_400_000).toISOString(),
        enabled: true,
      },
    };
  });
  return store;
}

function controller(
  store: StateStore,
  wallet: PhysicalWallet,
  chain: ChainClient = new TestChain(),
  now = 1_000,
): PrivateBalanceController {
  return new PrivateBalanceController({
    store,
    wallet,
    chain,
    shieldDenominationWei: DENOMINATION,
    gasReserveWei: GAS_RESERVE,
    clock: { now: () => new Date(now) },
  });
}

async function createPocket(
  runtime: PrivateBalanceController,
  name: string,
  suffix: string,
): Promise<WalletProfileRecord["privateBalances"][string]> {
  const plan = await runtime.previewCreation({ name });
  assert.equal(plan.decision, "allow");
  const request = await runtime.applyCreation({
    decisionId: plan.decisionId,
    clientRequestId: `create-pocket-${suffix}`,
    userConfirmed: true,
  });
  assert.equal(request.phase, "created");
  return {
    version: 1,
    privateBalanceId: request.privateBalance.privateBalanceId,
    name: request.privateBalance.privateBalanceName,
    backendWalletName: request.privateBalance.backendWalletName,
    status: "available",
    balanceWei: "0",
    revision: request.privateBalance.privateBalanceRevision,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    delegation: {
      mode: "testnet_delegated",
      chainId: 11_155_111,
      perPaymentLimitWei: DENOMINATION.toString(),
      lifetimeLimitWei: (10n * DENOMINATION).toString(),
      spentWei: "0",
      maxPayments: 10,
      expiresAt: new Date(86_400_000).toISOString(),
      enabled: true,
    },
  };
}

async function activeProfile(store: StateStore): Promise<WalletProfileRecord> {
  const state = await store.read();
  return state.wallet!.profiles[state.wallet!.activeWalletId]!;
}

test("creation is confirmation-gated, physically created, idempotent, and durable", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const runtime = controller(store, wallet);
  const plan = await runtime.previewCreation({ name: "savings" });
  assert.equal(plan.decision, "allow");
  assert.match(plan.backendWalletName, /^abpb-[0-9a-f]{40}$/);
  assert.equal(plan.initialPolicy.spentWei, "0");
  assert.equal(plan.initialPolicy.perPaymentLimitWei, DENOMINATION.toString());
  assert.match(plan.intentDigest, /^sha256:[0-9a-f]{64}$/);

  await assert.rejects(runtime.applyCreation({
    decisionId: plan.decisionId,
    clientRequestId: "create-savings-request",
    userConfirmed: false,
  }), /confirm/);
  assert.equal(wallet.ensureCalls, 0);

  const first = await runtime.applyCreation({
    decisionId: plan.decisionId,
    clientRequestId: "create-savings-request",
    userConfirmed: true,
  });
  const repeat = await runtime.applyCreation({
    decisionId: plan.decisionId,
    clientRequestId: "create-savings-request",
    userConfirmed: true,
  });
  assert.equal(first.phase, "created");
  assert.equal(repeat.requestId, first.requestId);
  assert.equal(wallet.ensureCalls, 1);
  assert.equal(wallet.syncCalls, 1);
  const profile = await activeProfile(store);
  const saved = profile.privateBalances[first.privateBalance.privateBalanceId];
  assert.equal(saved?.backendWalletName, plan.backendWalletName);
  assert.equal(saved?.balanceWei, "0");
  assert.equal(saved?.delegation.spentWei, "0");
  assert.equal((await runtime.creationStatus(first.requestId)).phase, "created");

  const restarted = controller(store, wallet);
  const afterRestart = await restarted.creationStatus(first.requestId);
  assert.equal(afterRestart.phase, "created");
  assert.equal(wallet.ensureCalls, 1);
});

test("creation cancellation, expiry, stale wallet binding, and interrupted recovery are safe", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const runtime = controller(store, wallet);

  const cancelled = await runtime.previewCreation({ name: "cancelled" });
  const cancelledOnce = await runtime.cancelCreation(cancelled.decisionId);
  const cancelledTwice = await runtime.cancelCreation(cancelled.decisionId);
  assert.equal(cancelledOnce.cancelledAt, cancelledTwice.cancelledAt);
  await assert.rejects(runtime.applyCreation({
    decisionId: cancelled.decisionId,
    clientRequestId: "cancelled-create-request",
    userConfirmed: true,
  }), /CANCELLED/);

  const expiring = controller(store, wallet, new TestChain(), 1_000);
  const expiredPlan = await expiring.previewCreation({ name: "expired" });
  const afterExpiry = controller(store, wallet, new TestChain(), 400_001);
  await assert.rejects(afterExpiry.applyCreation({
    decisionId: expiredPlan.decisionId,
    clientRequestId: "expired-create-request",
    userConfirmed: true,
  }), /EXPIRED/);

  const stalePlan = await runtime.previewCreation({ name: "stale-wallet" });
  const other = await store.registerManagedWallet("other-wallet");
  await store.activateWalletProfile(other.walletId);
  await assert.rejects(runtime.applyCreation({
    decisionId: stalePlan.decisionId,
    clientRequestId: "stale-wallet-create",
    userConfirmed: true,
  }), /WALLET_SELECTION_CHANGED/);
  assert.equal(wallet.ensureCalls, 0);

  const recoveryStore = await readyStore();
  const recoveryWallet = new PhysicalWallet();
  recoveryWallet.ensureCreatesThenThrows = true;
  const initial = controller(recoveryStore, recoveryWallet);
  const recoveryPlan = await initial.previewCreation({ name: "recoverable" });
  const unresolved = await initial.applyCreation({
    decisionId: recoveryPlan.decisionId,
    clientRequestId: "recoverable-create-request",
    userConfirmed: true,
  });
  assert.equal(unresolved.phase, "indeterminate");
  recoveryWallet.ensureCreatesThenThrows = false;
  const recoveredRuntime = controller(recoveryStore, recoveryWallet, new TestChain(), 2_000);
  await recoveredRuntime.recoverInterruptedRequests();
  const recovered = await recoveredRuntime.creationStatus(unresolved.requestId);
  assert.equal(recovered.phase, "created");
  assert.equal(
    recoveryWallet.ensureCalls,
    2,
    "recovery must repeat the idempotent ensure before inspecting",
  );
});

test("main funding persists before broadcast, waits for an exact receipt, and is idempotent", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const chain = new TestChain();
  const runtime = controller(store, wallet, chain);
  const pocket = await createPocket(runtime, "travel", "travel-main");
  let sawDurableExecutingRequest = false;
  wallet.beforeMainExecution = async () => {
    const state = await store.read();
    sawDurableExecutingRequest = Object.values(state.privateBalanceFundingRequests).some(
      (request) => request.phase === "executing",
    );
  };

  const plan = await runtime.previewFunding({
    source: { kind: "main" },
    targetPrivateBalance: pocket.privateBalanceId,
    amountWei: DENOMINATION.toString(),
  });
  assert.equal(plan.decision, "allow");
  assert.equal(plan.route, "shield_from_main");
  assert.equal(plan.sourceExecutorAddress, MAIN);
  assert.equal(plan.preparedDepositCall.valueWei, DENOMINATION.toString());
  assert.equal(plan.targetPrivateBalanceSnapshotWei, "0");

  await assert.rejects(runtime.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "fund-travel-from-main",
    userConfirmed: false,
  }), /confirm/);
  const first = await runtime.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "fund-travel-from-main",
    userConfirmed: true,
  });
  const repeat = await runtime.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "fund-travel-from-main",
    userConfirmed: true,
  });
  assert.equal(sawDurableExecutingRequest, true);
  assert.equal(first.phase, "submitted");
  assert.equal(repeat.requestId, first.requestId);
  assert.equal(wallet.mainCalls, 1);
  assert.equal(wallet.shieldCalls, 0, "prepared cross-wallet deposit must not use generic shield");
  assert.equal(
    (await activeProfile(store)).privateBalances[pocket.privateBalanceId]?.balanceWei,
    "0",
    "a target delta alone must not confirm the request",
  );
  chain.receipt = "success";
  const confirmed = await runtime.fundingStatus(first.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.confirmation?.method, "transaction_receipt");
  assert.ok((await store.read()).privateBalanceFundingPlans[plan.decisionId]?.appliedAt);
  const saved = (await activeProfile(store)).privateBalances[pocket.privateBalanceId];
  assert.equal(saved?.balanceWei, DENOMINATION.toString());
  assert.equal((await runtime.fundingStatus(first.requestId)).phase, "confirmed");
  assert.equal(wallet.mainCalls, 1);
});

test("restart recovers a main-to-pocket deposit from its exact raw transaction journal", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const chain = new TestChain();
  const initial = controller(store, wallet, chain);
  const pocket = await createPocket(initial, "journaled", "journaled-main");
  wallet.executePreparedMainDeposit = async (input) => {
    wallet.mainCalls += 1;
    await input.beforeBroadcast();
    wallet.rawCheckpoint = rawFundingCheckpoint({
      requestId: input.broadcastRequestId,
      to: input.preparedDepositCall.to,
      valueWei: input.preparedDepositCall.valueWei,
      data: input.preparedDepositCall.data,
    });
    throw new Error("provider response vanished after network handoff");
  };
  const plan = await initial.previewFunding({
    source: { kind: "main" },
    targetPrivateBalance: pocket.privateBalanceId,
    amountWei: DENOMINATION.toString(),
  });
  const unresolved = await initial.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "journaled-main-funding-crash",
    userConfirmed: true,
  });
  assert.equal(unresolved.phase, "indeterminate");
  assert.equal(unresolved.transactionHash, undefined);

  chain.receipt = "success";
  const restarted = controller(store, wallet, chain, 2_000);
  await restarted.recoverInterruptedRequests();
  const confirmed = await restarted.fundingStatus(unresolved.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.transactionHash, TX_HASH);
  assert.equal(confirmed.confirmation?.method, "transaction_receipt");
  assert.equal(wallet.mainCalls, 1);
  assert.equal(
    (await activeProfile(store)).privateBalances[pocket.privateBalanceId]
      ?.balanceWei,
    DENOMINATION.toString(),
  );
});

test("main funding enforces denomination, gas reserve, immutable target, and unresolved serialization", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const chain = new TestChain();
  const runtime = controller(store, wallet, chain);
  const firstPocket = await createPocket(runtime, "first", "first-main");
  const secondPocket = await createPocket(runtime, "second", "second-main");

  await assert.rejects(runtime.previewFunding({
    source: { kind: "main" },
    targetPrivateBalance: firstPocket.name,
    amountWei: (DENOMINATION + 1n).toString(),
  }), /REQUIRES_ONE_DENOMINATION/);
  await assert.rejects(runtime.previewFunding({
    source: { kind: "main" },
    targetPrivateBalance: firstPocket.name,
    amountWei: (2n * DENOMINATION).toString(),
  }), /REQUIRES_ONE_DENOMINATION/);

  chain.balances.set(MAIN, DENOMINATION + GAS_RESERVE - 1n);
  const denied = await runtime.previewFunding({
    source: { kind: "main" },
    targetPrivateBalance: firstPocket.name,
    amountWei: DENOMINATION.toString(),
  });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.blockers.includes("INSUFFICIENT_MAIN_BALANCE_WITH_GAS_RESERVE"));
  await assert.rejects(runtime.executeFunding({
    decisionId: denied.decisionId,
    clientRequestId: "denied-main-funding",
    userConfirmed: true,
  }), /DENIED/);

  chain.balances.set(MAIN, 10n * DENOMINATION);
  wallet.mode = "submitted";
  const pendingPlan = await runtime.previewFunding({
    source: { kind: "main" },
    targetPrivateBalance: firstPocket.name,
    amountWei: DENOMINATION.toString(),
  });
  const pending = await runtime.executeFunding({
    decisionId: pendingPlan.decisionId,
    clientRequestId: "pending-main-funding",
    userConfirmed: true,
  });
  assert.equal(pending.phase, "submitted");
  await assert.rejects(runtime.previewFunding({
    source: { kind: "main" },
    targetPrivateBalance: secondPocket.name,
    amountWei: DENOMINATION.toString(),
  }), /CONFLICT_UNRESOLVED/);

  wallet.balances.set(firstPocket.backendWalletName, DENOMINATION);
  const deltaOnly = await runtime.fundingStatus(pending.requestId);
  assert.equal(deltaOnly.phase, "submitted");
  chain.receipt = "success";
  const reconciled = await runtime.fundingStatus(pending.requestId);
  assert.equal(reconciled.phase, "confirmed");
  assert.equal(reconciled.confirmation?.method, "transaction_receipt");
  assert.equal(wallet.mainCalls, 1);

  const stalePlan = await runtime.previewFunding({
    source: { kind: "main" },
    targetPrivateBalance: secondPocket.name,
    amountWei: DENOMINATION.toString(),
  });
  wallet.balances.set(secondPocket.backendWalletName, DENOMINATION);
  await assert.rejects(runtime.executeFunding({
    decisionId: stalePlan.decisionId,
    clientRequestId: "stale-target-funding",
    userConfirmed: true,
  }), /TARGET_PRIVATE_BALANCE_CHANGED/);
  assert.equal(wallet.mainCalls, 1);
});

test("unresolved regular sends reserve main and pocket sources against private funding", async () => {
  const mainStore = await readyStore();
  const mainWallet = new PhysicalWallet();
  const mainRuntime = controller(mainStore, mainWallet);
  const mainTarget = await createPocket(mainRuntime, "target", "main-regular-conflict");
  await seedRegularRequestFixture(mainStore, {
    suffix: "main_funding_conflict",
    phase: "submitted",
  });
  await assert.rejects(
    mainRuntime.previewFunding({
      source: { kind: "main" },
      targetPrivateBalance: mainTarget.name,
      amountWei: DENOMINATION.toString(),
    }),
    /PRIVATE_BALANCE_FUNDING_CONFLICT_UNRESOLVED/,
  );
  assert.equal(mainWallet.prepareCalls, 0);

  const privateStore = await readyStore();
  const privateWallet = new PhysicalWallet();
  const privateRuntime = controller(privateStore, privateWallet);
  const source = await createPocket(
    privateRuntime,
    "source",
    "private-regular-conflict-source",
  );
  const target = await createPocket(
    privateRuntime,
    "target",
    "private-regular-conflict-target",
  );
  privateWallet.balances.set(source.backendWalletName, 3n * DENOMINATION);
  await seedRegularRequestFixture(privateStore, {
    suffix: "private_funding_conflict",
    phase: "submitted",
    privateBalanceId: source.privateBalanceId,
  });
  await assert.rejects(
    privateRuntime.previewFunding({
      source: { kind: "private_balance", privateBalance: source.name },
      targetPrivateBalance: target.name,
      amountWei: DENOMINATION.toString(),
    }),
    /PRIVATE_BALANCE_FUNDING_CONFLICT_UNRESOLVED/,
  );
  assert.equal(privateWallet.prepareCalls, 0);
});

test("private rebalance is physical, consumes whole notes plus fee reserve, and never ledger-only", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const chain = new TestChain();
  const runtime = controller(store, wallet, chain);
  const source = await createPocket(runtime, "source", "source-private");
  const target = await createPocket(runtime, "target", "target-private");
  wallet.balances.set(source.backendWalletName, 3n * DENOMINATION);
  wallet.balances.set(target.backendWalletName, 0n);
  wallet.nextExecutors.set(source.backendWalletName, EXECUTOR);
  let sawReservation = false;
  wallet.beforeRebalanceExecution = async () => {
    const saved = (await activeProfile(store)).privateBalances[source.privateBalanceId];
    sawReservation = saved?.balanceWei === DENOMINATION.toString();
  };

  const plan = await runtime.previewFunding({
    source: { kind: "private_balance", privateBalance: source.name },
    targetPrivateBalance: target.name,
    amountWei: DENOMINATION.toString(),
  });
  assert.equal(plan.route, "rebalance_private");
  assert.equal(plan.withdrawalAmountWei, (2n * DENOMINATION).toString());
  assert.equal(plan.sourceExecutorAddress, EXECUTOR);
  const request = await runtime.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "physical-private-rebalance",
    userConfirmed: true,
  });
  assert.equal(sawReservation, true);
  assert.equal(request.phase, "submitted");
  assert.equal(request.userOperationHash, USER_OP_HASH);
  assert.equal(wallet.rebalanceCalls, 1);
  assert.equal(wallet.mainCalls, 0);
  assert.equal(wallet.shieldCalls, 0);
  const deltaOnly = await runtime.fundingStatus(request.requestId);
  assert.equal(deltaOnly.phase, "submitted");
  chain.receipt = "success";
  const confirmed = await runtime.fundingStatus(request.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.confirmation?.method, "user_operation_receipt");
  assert.equal(chain.transactionReceiptReads, 0);
  assert.equal(chain.userOperationReceiptReads, 2);
  const saved = await activeProfile(store);
  assert.equal(saved.privateBalances[source.privateBalanceId]?.balanceWei, DENOMINATION.toString());
  assert.equal(saved.privateBalances[target.privateBalanceId]?.balanceWei, DENOMINATION.toString());
  assert.equal(confirmed.aggregatePrivateBalanceAfterWei, (2n * DENOMINATION).toString());
});

test("private funding hydrates its crash journal and tracks exact public change", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const chain = new TestChain();
  const runtime = controller(store, wallet, chain);
  const source = await createPocket(runtime, "source", "source-journal");
  const target = await createPocket(runtime, "target", "target-journal");
  wallet.balances.set(source.backendWalletName, 3n * DENOMINATION);
  wallet.balances.set(target.backendWalletName, 0n);
  wallet.nextExecutors.set(source.backendWalletName, EXECUTOR);
  chain.balances.set(EXECUTOR, 123n);
  wallet.executePrivateRebalance = async (input) => {
    assert.match(input.broadcastRequestId, /^pbfr_/u);
    assert.equal(input.sourceWalletName, source.backendWalletName);
    await input.beforeBroadcast();
    wallet.rebalanceCalls += 1;
    wallet.checkpoint = {
      version: 1,
      requestId: input.broadcastRequestId,
      userOperationHash: USER_OP_HASH,
      sender: EXECUTOR,
      entryPointAddress: ENTRY_POINT_V08,
      journaledAt: new Date(1_000).toISOString(),
    };
    return {};
  };

  const plan = await runtime.previewFunding({
    source: { kind: "private_balance", privateBalance: source.name },
    targetPrivateBalance: target.name,
    amountWei: DENOMINATION.toString(),
  });
  const interrupted = await runtime.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "journaled-private-rebalance",
    userConfirmed: true,
  });
  assert.equal(interrupted.phase, "indeterminate");
  assert.equal(interrupted.userOperationHash, undefined);

  const pending = await runtime.fundingStatus(interrupted.requestId);
  assert.equal(pending.phase, "indeterminate");
  assert.equal(pending.userOperationHash, USER_OP_HASH);
  assert.equal(pending.transactionHash, undefined);
  assert.equal(wallet.changeAccountCalls.length, 0);

  chain.receipt = "success";
  const confirmed = await runtime.fundingStatus(interrupted.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.userOperationHash, USER_OP_HASH);
  assert.equal(confirmed.transactionHash, TX_HASH);
  assert.equal(confirmed.confirmation?.method, "user_operation_receipt");
  assert.equal(confirmed.sourcePublicChangeWei, "123");
  assert.deepEqual(wallet.changeAccountCalls, [{
    walletName: source.backendWalletName,
    expectedAddress: EXECUTOR,
  }]);
  const saved = await activeProfile(store);
  assert.equal(
    saved.privateBalances[source.privateBalanceId]?.publicChangeAccounts?.[
      EXECUTOR.toLowerCase()
    ]?.balanceWei,
    "123",
  );
  assert.equal(
    saved.privateBalances[source.privateBalanceId]?.publicChangeAccounts?.[
      EXECUTOR.toLowerCase()
    ]?.sourceRequestId,
    interrupted.requestId,
  );
  assert.equal(chain.transactionReceiptReads, 0);
  assert.equal(wallet.rebalanceCalls, 1);
});

test("private funding reuses durable success evidence after receipt RPC failure", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const chain = new TestChain();
  const runtime = controller(store, wallet, chain);
  const source = await createPocket(runtime, "source", "source-evidence-retry");
  const target = await createPocket(runtime, "target", "target-evidence-retry");
  wallet.balances.set(source.backendWalletName, 3n * DENOMINATION);
  wallet.balances.set(target.backendWalletName, 0n);
  wallet.nextExecutors.set(source.backendWalletName, EXECUTOR);
  chain.balances.set(EXECUTOR, 321n);
  wallet.executePrivateRebalance = async (input) => {
    await input.beforeBroadcast();
    wallet.rebalanceCalls += 1;
    wallet.checkpoint = {
      version: 1,
      requestId: input.broadcastRequestId,
      userOperationHash: USER_OP_HASH,
      sender: EXECUTOR,
      entryPointAddress: ENTRY_POINT_V08,
      journaledAt: new Date(1_000).toISOString(),
    };
    wallet.balances.set(source.backendWalletName, DENOMINATION);
    wallet.balances.set(target.backendWalletName, DENOMINATION);
    return { userOperationHash: USER_OP_HASH, confirmed: false };
  };

  const plan = await runtime.previewFunding({
    source: { kind: "private_balance", privateBalance: source.name },
    targetPrivateBalance: target.name,
    amountWei: DENOMINATION.toString(),
  });
  const submitted = await runtime.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "private-funding-evidence-retry",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");

  chain.receipt = "success";
  wallet.failChangeAccountRecovery = true;
  const waitingForChange = await runtime.fundingStatus(submitted.requestId);
  assert.equal(waitingForChange.phase, "indeterminate");
  assert.equal(waitingForChange.error?.code, "PUBLIC_CHANGE_TRACKING_PENDING");
  assert.deepEqual(waitingForChange.userOperationReceiptEvidence, {
    version: 1,
    status: "success",
    userOperationHash: USER_OP_HASH,
    transactionHash: TX_HASH,
    observedAt: new Date(1_000).toISOString(),
  });
  assert.equal(chain.userOperationReceiptReads, 1);

  wallet.failChangeAccountRecovery = false;
  let unavailableReceiptReads = 0;
  const unavailableReceiptChain: ChainClient = {
    async assertSepolia() {},
    async getBalanceWei(address) {
      return chain.balances.get(address) ?? 0n;
    },
    async getUserOperationReceiptStatus() {
      unavailableReceiptReads += 1;
      throw new Error("UserOperation receipt provider unavailable after restart");
    },
  };
  const restartedStore = new StateStore(join(store.path, ".."));
  await restartedStore.initialize();
  const restarted = controller(restartedStore, wallet, unavailableReceiptChain, 2_000);
  const confirmed = await restarted.fundingStatus(submitted.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.sourcePublicChangeWei, "321");
  assert.equal(confirmed.confirmation?.method, "user_operation_receipt");
  assert.ok(confirmed.appliedAt);
  assert.equal(chain.userOperationReceiptReads, 1);
  assert.equal(unavailableReceiptReads, 0);
  assert.equal(wallet.rebalanceCalls, 1);

  const stable = await restarted.fundingStatus(submitted.requestId);
  assert.deepEqual(stable, confirmed);
  const saved = await activeProfile(store);
  assert.equal(saved.privateBalances[source.privateBalanceId]?.balanceWei, DENOMINATION.toString());
  assert.equal(saved.privateBalances[target.privateBalanceId]?.balanceWei, DENOMINATION.toString());
  assert.equal(
    Object.keys(saved.privateBalances[source.privateBalanceId]?.publicChangeAccounts ?? {}).length,
    1,
  );
  assert.equal((await store.read()).privateBalanceFundingPlans[plan.decisionId]?.appliedAt,
    confirmed.appliedAt);
});

test("adapter-confirmed private rebalance with a journal waits for exact receipt and change recovery", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const chain = new TestChain();
  const runtime = controller(store, wallet, chain);
  const source = await createPocket(runtime, "source", "source-adapter-confirmed");
  const target = await createPocket(runtime, "target", "target-adapter-confirmed");
  wallet.balances.set(source.backendWalletName, 3n * DENOMINATION);
  wallet.balances.set(target.backendWalletName, 0n);
  wallet.nextExecutors.set(source.backendWalletName, EXECUTOR);
  chain.balances.set(EXECUTOR, 456n);
  wallet.executePrivateRebalance = async (input) => {
    assert.match(input.broadcastRequestId, /^pbfr_/u);
    assert.equal(input.sourceWalletName, source.backendWalletName);
    await input.beforeBroadcast();
    wallet.rebalanceCalls += 1;
    wallet.checkpoint = {
      version: 1,
      requestId: input.broadcastRequestId,
      userOperationHash: USER_OP_HASH,
      sender: EXECUTOR,
      entryPointAddress: ENTRY_POINT_V08,
      journaledAt: new Date(1_000).toISOString(),
    };
    return {
      transactionHash: TX_HASH,
      userOperationHash: USER_OP_HASH,
      confirmed: true,
    };
  };

  const plan = await runtime.previewFunding({
    source: { kind: "private_balance", privateBalance: source.name },
    targetPrivateBalance: target.name,
    amountWei: DENOMINATION.toString(),
  });
  const submitted = await runtime.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "adapter-confirmed-private-rebalance",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");
  assert.equal(submitted.confirmation, undefined);
  assert.equal(submitted.sourcePublicChangeWei, undefined);
  assert.equal(wallet.changeAccountCalls.length, 0);
  assert.equal((await runtime.fundingStatus(submitted.requestId)).phase, "submitted");
  assert.equal(chain.transactionReceiptReads, 0);

  chain.receipt = "success";
  const confirmed = await runtime.fundingStatus(submitted.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.confirmation?.method, "user_operation_receipt");
  assert.equal(confirmed.sourcePublicChangeWei, "456");
  assert.deepEqual(wallet.changeAccountCalls, [{
    walletName: source.backendWalletName,
    expectedAddress: EXECUTOR,
  }]);
  const saved = await activeProfile(store);
  assert.equal(
    saved.privateBalances[source.privateBalanceId]?.publicChangeAccounts?.[
      EXECUTOR.toLowerCase()
    ]?.sourceRequestId,
    submitted.requestId,
  );
  assert.equal(
    saved.privateBalances[target.privateBalanceId]?.balanceWei,
    DENOMINATION.toString(),
  );
  assert.equal(chain.transactionReceiptReads, 0);
  assert.equal(wallet.rebalanceCalls, 1);
});

test("private rebalance rejects self, insufficient whole-note funding, and a stale executor", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const runtime = controller(store, wallet);
  const source = await createPocket(runtime, "source", "source-guards");
  const target = await createPocket(runtime, "target", "target-guards");
  wallet.balances.set(source.backendWalletName, DENOMINATION);

  await assert.rejects(runtime.previewFunding({
    source: { kind: "private_balance", privateBalance: source.name },
    targetPrivateBalance: source.name,
    amountWei: DENOMINATION.toString(),
  }), /MUST_DIFFER/);
  const denied = await runtime.previewFunding({
    source: { kind: "private_balance", privateBalance: source.name },
    targetPrivateBalance: target.name,
    amountWei: DENOMINATION.toString(),
  });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.blockers.includes(
    "INSUFFICIENT_SOURCE_PRIVATE_BALANCE_WITH_FEE_RESERVE",
  ));

  wallet.balances.set(source.backendWalletName, 3n * DENOMINATION);
  const stale = await runtime.previewFunding({
    source: { kind: "private_balance", privateBalance: source.name },
    targetPrivateBalance: target.name,
    amountWei: DENOMINATION.toString(),
  });
  wallet.nextExecutors.set(source.backendWalletName, OTHER_EXECUTOR);
  await assert.rejects(runtime.executeFunding({
    decisionId: stale.decisionId,
    clientRequestId: "stale-executor-rebalance",
    userConfirmed: true,
  }), /EXECUTOR_CHANGED/);
  assert.equal(wallet.rebalanceCalls, 0);
  assert.equal(Object.keys((await store.read()).privateBalanceFundingRequests).length, 0);
});

test("typed pre-broadcast failure releases a private reservation exactly once", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const runtime = controller(store, wallet);
  const source = await createPocket(runtime, "source", "source-release");
  const target = await createPocket(runtime, "target", "target-release");
  wallet.balances.set(source.backendWalletName, 3n * DENOMINATION);
  wallet.mode = "reject_prebroadcast";
  const plan = await runtime.previewFunding({
    source: { kind: "private_balance", privateBalance: source.name },
    targetPrivateBalance: target.name,
    amountWei: DENOMINATION.toString(),
  });
  const failed = await runtime.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "prebroadcast-rejection",
    userConfirmed: true,
  });
  assert.equal(failed.phase, "failed");
  assert.equal(
    failed.error?.code,
    "PRIVATE_BALANCE_FUNDING_REJECTED_BEFORE_BROADCAST",
  );
  assert.equal(
    (await activeProfile(store)).privateBalances[source.privateBalanceId]?.balanceWei,
    (3n * DENOMINATION).toString(),
  );
  const repeat = await runtime.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "prebroadcast-rejection",
    userConfirmed: true,
  });
  assert.equal(repeat.requestId, failed.requestId);
  assert.equal(wallet.rebalanceCalls, 1);
});

test("post-broadcast and unknown failures stay reserved, survive restart, and never rebroadcast", async () => {
  for (const mode of ["fail_after_broadcast", "unknown_failure"] as const) {
    const store = await readyStore();
    const wallet = new PhysicalWallet();
    const runtime = controller(store, wallet);
    const source = await createPocket(runtime, "source", `source-${mode}`);
    const target = await createPocket(runtime, "target", `target-${mode}`);
    wallet.balances.set(source.backendWalletName, 3n * DENOMINATION);
    wallet.mode = mode;
    const plan = await runtime.previewFunding({
      source: { kind: "private_balance", privateBalance: source.name },
      targetPrivateBalance: target.name,
      amountWei: DENOMINATION.toString(),
    });
    const unresolved = await runtime.executeFunding({
      decisionId: plan.decisionId,
      clientRequestId: `unresolved-${mode}`,
      userConfirmed: true,
    });
    assert.equal(unresolved.phase, "indeterminate");
    assert.equal(
      (await activeProfile(store)).privateBalances[source.privateBalanceId]?.balanceWei,
      DENOMINATION.toString(),
      mode,
    );

    const restarted = controller(store, wallet, new TestChain(), 2_000);
    await restarted.recoverInterruptedRequests();
    assert.equal((await restarted.fundingStatus(unresolved.requestId)).phase, "indeterminate");
    assert.equal(wallet.rebalanceCalls, 1, mode);

    wallet.balances.set(source.backendWalletName, DENOMINATION);
    wallet.balances.set(target.backendWalletName, DENOMINATION);
    const deltaOnly = await restarted.fundingStatus(unresolved.requestId);
    assert.equal(deltaOnly.phase, "indeterminate");
    assert.equal(wallet.rebalanceCalls, 1, mode);
  }
});

test("exact receipts settle funding while a reverted receipt releases reservation", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const chain = new TestChain();
  const runtime = controller(store, wallet, chain);
  const source = await createPocket(runtime, "source", "source-receipt");
  const target = await createPocket(runtime, "target", "target-receipt");
  wallet.balances.set(source.backendWalletName, 3n * DENOMINATION);
  wallet.mode = "submitted";
  const plan = await runtime.previewFunding({
    source: { kind: "private_balance", privateBalance: source.name },
    targetPrivateBalance: target.name,
    amountWei: DENOMINATION.toString(),
  });
  const submitted = await runtime.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "receipt-private-rebalance",
    userConfirmed: true,
  });
  assert.equal(submitted.phase, "submitted");

  chain.receipt = "success";
  const confirmed = await runtime.fundingStatus(submitted.requestId);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.confirmation?.method, "user_operation_receipt");
  assert.equal(chain.transactionReceiptReads, 0);
  assert.equal(
    (await activeProfile(store)).privateBalances[source.privateBalanceId]?.balanceWei,
    DENOMINATION.toString(),
  );
  assert.equal(wallet.rebalanceCalls, 1);

  const revertedStore = await readyStore();
  const revertedWallet = new PhysicalWallet();
  const revertedChain = new TestChain();
  const revertedRuntime = controller(revertedStore, revertedWallet, revertedChain);
  const revertedSource = await createPocket(
    revertedRuntime,
    "source",
    "source-reverted-receipt",
  );
  const revertedTarget = await createPocket(
    revertedRuntime,
    "target",
    "target-reverted-receipt",
  );
  revertedWallet.balances.set(revertedSource.backendWalletName, 3n * DENOMINATION);
  revertedWallet.mode = "submitted";
  const revertedPlan = await revertedRuntime.previewFunding({
    source: { kind: "private_balance", privateBalance: revertedSource.name },
    targetPrivateBalance: revertedTarget.name,
    amountWei: DENOMINATION.toString(),
  });
  const awaitingReceipt = await revertedRuntime.executeFunding({
    decisionId: revertedPlan.decisionId,
    clientRequestId: "reverted-private-rebalance",
    userConfirmed: true,
  });
  assert.equal(awaitingReceipt.phase, "submitted");
  revertedChain.receipt = "reverted";
  const failed = await revertedRuntime.fundingStatus(awaitingReceipt.requestId);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error?.code, "PRIVATE_BALANCE_FUNDING_REVERTED");
  assert.equal(
    (await activeProfile(revertedStore)).privateBalances[revertedSource.privateBalanceId]
      ?.balanceWei,
    (3n * DENOMINATION).toString(),
  );
  assert.equal(revertedWallet.rebalanceCalls, 1);
});

test("a mismatched private-funding UserOperation transaction stays submitted", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const chain = new TestChain();
  const runtime = controller(store, wallet, chain);
  const source = await createPocket(runtime, "source", "source-mismatched-userop");
  const target = await createPocket(runtime, "target", "target-mismatched-userop");
  wallet.balances.set(source.backendWalletName, 3n * DENOMINATION);
  wallet.mode = "submitted";
  const plan = await runtime.previewFunding({
    source: { kind: "private_balance", privateBalance: source.name },
    targetPrivateBalance: target.name,
    amountWei: DENOMINATION.toString(),
  });
  const submitted = await runtime.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "mismatched-userop-funding",
    userConfirmed: true,
  });
  chain.receipt = "success";
  chain.userOperationTransactionHash = `0x${"ef".repeat(32)}`;
  const unresolved = await runtime.fundingStatus(submitted.requestId);
  assert.equal(unresolved.phase, "submitted");
  assert.equal(unresolved.confirmation, undefined);
  assert.equal(unresolved.transactionHash, TX_HASH);
  assert.equal(chain.transactionReceiptReads, 0);
  assert.equal(chain.userOperationReceiptReads, 1);
  assert.equal(wallet.rebalanceCalls, 1);
});

test("adapter confirmation credits once even before target sync", async () => {
  const store = await readyStore();
  const wallet = new PhysicalWallet();
  const runtime = controller(store, wallet);
  const target = await createPocket(runtime, "target", "adapter-confirm");
  wallet.mode = "confirmed_without_observation";
  const plan = await runtime.previewFunding({
    source: { kind: "main" },
    targetPrivateBalance: target.name,
    amountWei: DENOMINATION.toString(),
  });
  const confirmed = await runtime.executeFunding({
    decisionId: plan.decisionId,
    clientRequestId: "adapter-confirmed-main",
    userConfirmed: true,
  });
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.confirmation?.method, "adapter");
  assert.equal(
    (await activeProfile(store)).privateBalances[target.privateBalanceId]?.balanceWei,
    DENOMINATION.toString(),
  );
  assert.equal((await runtime.fundingStatus(confirmed.requestId)).phase, "confirmed");
  assert.equal(wallet.mainCalls, 1);
});
