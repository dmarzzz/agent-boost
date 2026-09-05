import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "../src/config.js";
import {
  type PrivateBroadcastCheckpoint,
  type RawTransactionBroadcastCheckpoint,
  REGULAR_TRANSFER_GAS_RESERVE_WEI,
  TORNADO_DEPOSIT_GAS_RESERVE_WEI,
  type ChainClient,
  type WalletAdapter,
  type WalletInventoryItem,
} from "../src/contracts.js";
import { AgentBoostRequestError } from "../src/errors.js";
import { createMcpServer } from "../src/mcp.js";
import { createLocalRuntime, type LocalAgentBoostRuntime } from "../src/service.js";
import { StateStore, type StateDocument } from "../src/state/store.js";

const DENOMINATION = 100_000_000_000_000_000n;
const MAIN_ONE = "0x1111111111111111111111111111111111111111";
const MAIN_TWO = "0x2222222222222222222222222222222222222222";
const PRIVATE_EXECUTOR = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x5555555555555555555555555555555555555555";
const PRIVATE_CHANGE = "0x6666666666666666666666666666666666666666";
const DEFAULT_PRIVATE_CHANGE = "0x7777777777777777777777777777777777777777";
const POOL = "0x4444444444444444444444444444444444444444";
const ONBOARDING_POOL = "0x8c4a04d872a6c1be37964a21ba3a138525dff50b";
const ONBOARDING_DEPOSIT_DATA = `0xb214faa5${"12".repeat(32)}`;
const ENTRY_POINT_V08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
const INTERNAL_MARKERS = [
  "backendWalletName",
  "sourceExecutorAddress",
  "targetCommitment",
  "preparedDepositCall",
] as const;

class LifecycleChain implements ChainClient {
  readonly balances = new Map<string, bigint>();
  readonly userOperationTransactions = new Map<string, string>();

  async assertSepolia(): Promise<void> {}

  async getBalanceWei(address: string): Promise<bigint> {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }

  async getTransactionReceiptStatus(): Promise<"success"> {
    return "success";
  }

  async getUserOperationReceiptStatus(userOperationHash: string): Promise<
    | { status: "pending" }
    | { status: "success"; transactionHash: string }
  > {
    const transactionHash = this.userOperationTransactions.get(userOperationHash);
    return transactionHash
      ? { status: "success", transactionHash }
      : { status: "pending" };
  }

  add(address: string, amountWei: bigint): void {
    const key = address.toLowerCase();
    this.balances.set(key, (this.balances.get(key) ?? 0n) + amountWei);
  }
}

class LifecycleWallet implements WalletAdapter {
  activeWallet = "vault-one";
  readonly selectionCalls: string[] = [];
  readonly inventory = new Set(["vault-one"]);
  readonly privateBalances = new Map<string, bigint>([["vault-one", DENOMINATION]]);
  readonly prepared = new Map<string, {
    targetWalletName: string;
    amountWei: bigint;
  }>();
  readonly addresses = new Map<string, string>([
    ["vault-one", MAIN_ONE],
    ["vault-two", MAIN_TWO],
  ]);
  readonly privateBroadcasts = new Map<string, PrivateBroadcastCheckpoint>();
  readonly rawBroadcasts = new Map<string, RawTransactionBroadcastCheckpoint>();
  readonly privateChangeAccountCalls: Array<{
    walletName: string;
    expectedAddress: string;
  }> = [];
  readonly namedRegularTransferCalls: Array<{
    walletName: string;
    sourceAddress: string;
    recipient: string;
    amountWei: bigint;
  }> = [];
  nextPrivateChangeAddress: string | undefined;
  ensureBackendCalls = 0;
  mainFundingCalls = 0;
  rebalanceCalls = 0;
  privatePaymentCalls = 0;
  regularTransferCalls = 0;
  prepareCalls = 0;
  transactionCounter = 0;

  constructor(readonly chain: LifecycleChain) {}

  selectWallet(walletName: string): void {
    this.selectionCalls.push(walletName);
    this.activeWallet = walletName;
  }

  async listWallets(): Promise<WalletInventoryItem[]> {
    return [...this.inventory].map((name) => ({ name, network: "sepolia" }));
  }

  async ensureWallet(): Promise<void> {
    this.inventory.add(this.activeWallet);
    this.privateBalances.set(
      this.activeWallet,
      this.privateBalances.get(this.activeWallet) ?? 0n,
    );
  }

  async nextFreshAddress(): Promise<string> {
    const address = this.addresses.get(this.activeWallet);
    if (!address) throw new Error(`missing main address for ${this.activeWallet}`);
    return address;
  }

  async prewarmPrivacy(): Promise<void> {}

  async shieldWei(amountWei: bigint, input: {
    sourceAddress: string;
    preparedDepositCall?: { to: string; data: string; valueWei: string };
    broadcastRequestId: string;
    beforeBroadcast: (
      preparedDepositCall: { to: string; data: string; valueWei: string },
    ) => Promise<void>;
  }): Promise<{
    transactionHash: string;
    confirmed: true;
  }> {
    const source = this.addresses.get(this.activeWallet);
    if (!source) throw new Error(`missing main address for ${this.activeWallet}`);
    assert.equal(input.sourceAddress.toLowerCase(), source.toLowerCase());
    const sourceBalance = await this.chain.getBalanceWei(source);
    assert.ok(sourceBalance >= amountWei + REGULAR_TRANSFER_GAS_RESERVE_WEI);
    const preparedDepositCall = input.preparedDepositCall ?? {
      to: ONBOARDING_POOL,
      data: ONBOARDING_DEPOSIT_DATA,
      valueWei: amountWei.toString(),
    };
    await input.beforeBroadcast(preparedDepositCall);
    const transactionHash = this.nextTransactionHash();
    this.rawBroadcasts.set(input.broadcastRequestId, {
      version: 1,
      requestId: input.broadcastRequestId,
      transactionHash,
      from: source.toLowerCase(),
      to: preparedDepositCall.to.toLowerCase(),
      valueWei: preparedDepositCall.valueWei,
      data: preparedDepositCall.data.toLowerCase(),
      chainId: 11_155_111,
      nonce: "0",
      gas: "1000000",
      transactionType: "eip1559",
      journaledAt: new Date(0).toISOString(),
    });
    this.chain.add(source, -(amountWei + REGULAR_TRANSFER_GAS_RESERVE_WEI));
    this.privateBalances.set(
      this.activeWallet,
      (this.privateBalances.get(this.activeWallet) ?? 0n) + amountWei,
    );
    return { transactionHash, confirmed: true };
  }

  async getRawTransactionBroadcastCheckpoint(
    requestId: string,
  ): Promise<RawTransactionBroadcastCheckpoint | undefined> {
    const checkpoint = this.rawBroadcasts.get(requestId);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  async getPrivateBalanceWei(): Promise<bigint> {
    return this.privateBalances.get(this.activeWallet) ?? 0n;
  }

  async getPrivateBalanceWeiForWallet(walletName: string): Promise<bigint> {
    const balance = this.privateBalances.get(walletName);
    if (balance === undefined) throw new Error("private backend is missing");
    return balance;
  }

  async getBalanceSnapshotForWallet(walletName: string): Promise<{
    publicBalanceWei: bigint;
    privateBalanceWei: bigint;
  }> {
    const address = this.addresses.get(walletName);
    return {
      publicBalanceWei: address ? await this.chain.getBalanceWei(address) : 0n,
      privateBalanceWei: await this.getPrivateBalanceWeiForWallet(walletName),
    };
  }

  async executePrivatePayment(input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash: string;
    userOperationHash?: string;
    confirmed: true;
  }> {
    return this.executePrivatePaymentFromWallet(this.activeWallet, input);
  }

  async executePrivatePaymentFromWallet(walletName: string, input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash: string;
    userOperationHash?: string;
    confirmed: true;
  }> {
    assert.match(input.broadcastRequestId, /^req_/u);
    const balance = this.privateBalances.get(walletName) ?? 0n;
    if (balance < DENOMINATION) throw new Error("private note is unavailable");
    await input.beforeBroadcast();
    this.privatePaymentCalls += 1;
    this.privateBalances.set(walletName, balance - DENOMINATION);
    this.chain.add(input.recipient, input.amountWei);
    const transactionHash = this.nextTransactionHash();
    const privateChangeAddress = this.nextPrivateChangeAddress;
    if (!privateChangeAddress) {
      return { transactionHash, confirmed: true };
    }
    this.nextPrivateChangeAddress = undefined;
    const userOperationHash = this.nextTransactionHash();
    const publicChangeWei = DENOMINATION - input.amountWei -
      REGULAR_TRANSFER_GAS_RESERVE_WEI;
    assert.ok(publicChangeWei > 0n);
    this.chain.add(privateChangeAddress, publicChangeWei);
    this.chain.userOperationTransactions.set(userOperationHash, transactionHash);
    this.privateBroadcasts.set(input.broadcastRequestId, {
      version: 1,
      requestId: input.broadcastRequestId,
      userOperationHash,
      sender: privateChangeAddress,
      entryPointAddress: ENTRY_POINT_V08,
      journaledAt: new Date().toISOString(),
    });
    return { transactionHash, userOperationHash, confirmed: true };
  }

  async executeRegularTransfer(input: {
    recipient: string;
    amountWei: bigint;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash: string; confirmed: true }> {
    const source = this.addresses.get(this.activeWallet);
    if (!source) throw new Error(`missing main address for ${this.activeWallet}`);
    const sourceBalance = await this.chain.getBalanceWei(source);
    assert.ok(
      sourceBalance >= input.amountWei + REGULAR_TRANSFER_GAS_RESERVE_WEI,
    );
    await input.beforeBroadcast();
    this.regularTransferCalls += 1;
    this.chain.add(
      source,
      -(input.amountWei + REGULAR_TRANSFER_GAS_RESERVE_WEI),
    );
    this.chain.add(input.recipient, input.amountWei);
    return { transactionHash: this.nextTransactionHash(), confirmed: true };
  }

  async executeRegularTransferFromWallet(walletName: string, input: {
    sourceAddress: string;
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash: string; confirmed: true }> {
    assert.ok(this.inventory.has(walletName));
    assert.match(input.broadcastRequestId, /^rreq_/u);
    const sourceBalance = await this.chain.getBalanceWei(input.sourceAddress);
    assert.ok(
      sourceBalance >= input.amountWei + REGULAR_TRANSFER_GAS_RESERVE_WEI,
    );
    await input.beforeBroadcast();
    this.regularTransferCalls += 1;
    this.namedRegularTransferCalls.push({
      walletName,
      sourceAddress: input.sourceAddress,
      recipient: input.recipient,
      amountWei: input.amountWei,
    });
    this.chain.add(
      input.sourceAddress,
      -(input.amountWei + REGULAR_TRANSFER_GAS_RESERVE_WEI),
    );
    this.chain.add(input.recipient, input.amountWei);
    return { transactionHash: this.nextTransactionHash(), confirmed: true };
  }

  async getPrivateBroadcastCheckpoint(
    requestId: string,
  ): Promise<PrivateBroadcastCheckpoint | undefined> {
    return this.privateBroadcasts.get(requestId);
  }

  async ensurePrivateChangeAccount(
    walletName: string,
    expectedAddress: string,
  ): Promise<void> {
    assert.ok(this.inventory.has(walletName));
    assert.match(expectedAddress, /^0x[0-9a-f]{40}$/iu);
    this.privateChangeAccountCalls.push({ walletName, expectedAddress });
  }

  async ensureBackendWallet(walletName: string): Promise<void> {
    this.ensureBackendCalls += 1;
    this.inventory.add(walletName);
    this.privateBalances.set(walletName, this.privateBalances.get(walletName) ?? 0n);
  }

  async syncBackendWallet(walletName: string): Promise<bigint> {
    return this.getPrivateBalanceWeiForWallet(walletName);
  }

  async peekNextFreshAddressForWallet(): Promise<string> {
    return PRIVATE_EXECUTOR;
  }

  async prepareTornadoEthDeposit(input: {
    targetWalletName: string;
    executorAddress: string;
    amountWei: bigint;
  }): Promise<{
    targetCommitment: string;
    preparedDepositCall: { to: string; data: string; valueWei: string };
  }> {
    assert.match(input.executorAddress, /^0x[0-9a-f]{40}$/iu);
    this.prepareCalls += 1;
    const data = `0x${this.prepareCalls.toString(16).padStart(8, "0")}`;
    this.prepared.set(data, {
      targetWalletName: input.targetWalletName,
      amountWei: input.amountWei,
    });
    return {
      targetCommitment: `secret-target-commitment-${this.prepareCalls}`,
      preparedDepositCall: {
        to: POOL,
        data,
        valueWei: input.amountWei.toString(),
      },
    };
  }

  async executePreparedMainDeposit(input: {
    sourceWalletName: string;
    sourceExecutorAddress: string;
    preparedDepositCall: { to: string; data: string; valueWei: string };
    beforeBroadcast: () => Promise<void>;
  }): Promise<{ transactionHash: string; confirmed: true }> {
    assert.equal(
      input.sourceExecutorAddress.toLowerCase(),
      this.addresses.get(input.sourceWalletName)?.toLowerCase(),
    );
    const prepared = this.requirePrepared(input.preparedDepositCall.data);
    const sourceBalance = await this.chain.getBalanceWei(
      input.sourceExecutorAddress,
    );
    assert.ok(
      sourceBalance >= prepared.amountWei + TORNADO_DEPOSIT_GAS_RESERVE_WEI,
    );
    await input.beforeBroadcast();
    this.mainFundingCalls += 1;
    this.chain.add(
      input.sourceExecutorAddress,
      -(prepared.amountWei + TORNADO_DEPOSIT_GAS_RESERVE_WEI),
    );
    this.credit(prepared.targetWalletName, prepared.amountWei);
    return { transactionHash: this.nextTransactionHash(), confirmed: true };
  }

  async executePrivateRebalance(input: {
    sourceWalletName: string;
    sourceExecutorAddress: string;
    withdrawalAmountWei: bigint;
    preparedDepositCall: { to: string; data: string; valueWei: string };
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash: string;
    userOperationHash: string;
    confirmed: true;
  }> {
    assert.match(input.broadcastRequestId, /^pbfr_/u);
    assert.equal(input.sourceExecutorAddress, PRIVATE_EXECUTOR);
    const prepared = this.requirePrepared(input.preparedDepositCall.data);
    const sourceBalance = this.privateBalances.get(input.sourceWalletName) ?? 0n;
    assert.ok(sourceBalance >= input.withdrawalAmountWei);
    await input.beforeBroadcast();
    this.rebalanceCalls += 1;
    this.privateBalances.set(
      input.sourceWalletName,
      sourceBalance - input.withdrawalAmountWei,
    );
    this.credit(prepared.targetWalletName, prepared.amountWei);
    const transactionHash = this.nextTransactionHash();
    const userOperationHash = this.nextTransactionHash();
    this.chain.userOperationTransactions.set(userOperationHash, transactionHash);
    return {
      transactionHash,
      userOperationHash,
      confirmed: true,
    };
  }

  private requirePrepared(data: string): {
    targetWalletName: string;
    amountWei: bigint;
  } {
    const prepared = this.prepared.get(data);
    if (!prepared) throw new Error("prepared deposit is missing");
    return prepared;
  }

  private credit(walletName: string, amountWei: bigint): void {
    this.privateBalances.set(
      walletName,
      (this.privateBalances.get(walletName) ?? 0n) + amountWei,
    );
  }

  private nextTransactionHash(): string {
    this.transactionCounter += 1;
    return `0x${this.transactionCounter.toString(16).padStart(64, "0")}`;
  }
}

interface Harness {
  root: string;
  store: StateStore;
  wallet: LifecycleWallet;
  chain: LifecycleChain;
  runtime: LocalAgentBoostRuntime;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-private-service-"));
  const store = new StateStore(root, "vault-one");
  await store.initialize();
  await store.ensureWalletProfile("vault-one");
  const now = new Date();
  await store.update((draft) => {
    draft.onboarding = {
      version: 1,
      setupId: "setup_vault_one",
      revision: 1,
      phase: "private_ready",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      address: MAIN_ONE,
      publicBalanceWei: (10n * DENOMINATION).toString(),
      privateBalanceWei: DENOMINATION.toString(),
      requiredFundingWei: (2n * DENOMINATION).toString(),
      shieldAmountWei: DENOMINATION.toString(),
      delegation: {
        mode: "testnet_delegated",
        chainId: 11_155_111,
        perPaymentLimitWei: (DENOMINATION / 2n).toString(),
        lifetimeLimitWei: (10n * DENOMINATION).toString(),
        spentWei: "0",
        maxPayments: 20,
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        enabled: true,
      },
    };
  });
  const chain = new LifecycleChain();
  chain.add(MAIN_ONE, 10n * DENOMINATION);
  const wallet = new LifecycleWallet(chain);
  const config = {
    ...loadConfig({
      AGENT_BOOST_STATE_DIR: root,
      AGENT_BOOST_KOHAKU_WALLET: "vault-one",
      AGENT_BOOST_SHADE_TREE_ENABLED: "false",
      AGENT_BOOST_FUNDING_POLL_MS: "1",
      AGENT_BOOST_PRIVATE_POLL_MS: "1",
      AGENT_BOOST_SETUP_TIMEOUT_MS: "5000",
      AGENT_BOOST_PAYMENT_LIMIT_WEI: (DENOMINATION / 2n).toString(),
      AGENT_BOOST_LIFETIME_LIMIT_WEI: (10n * DENOMINATION).toString(),
      AGENT_BOOST_MAX_PAYMENTS: "20",
    }, root),
    uiPort: 0,
  };
  const runtime = await createLocalRuntime(config, {
    wallet,
    chain,
    openBrowser: async () => false,
  });
  return { root, store, wallet, chain, runtime };
}

async function createPocket(
  runtime: LocalAgentBoostRuntime,
  name: string,
  requestSuffix: string,
): Promise<{ decisionId: string; requestId: string }> {
  const plan = await runtime.previewPrivateBalanceCreation({ name });
  assert.equal(plan.decision, "allow");
  const request = await runtime.applyPrivateBalanceCreation({
    decisionId: String(plan.decisionId),
    clientRequestId: `create-${requestSuffix}`,
    userConfirmed: true,
  });
  assert.equal(request.phase, "created");
  return {
    decisionId: String(plan.decisionId),
    requestId: String(request.requestId),
  };
}

async function fundPocket(
  runtime: LocalAgentBoostRuntime,
  targetPrivateBalanceName: string,
  requestSuffix: string,
  sourcePrivateBalanceName?: string,
): Promise<Record<string, unknown>> {
  const plan = await runtime.previewPrivateBalanceFunding({
    ...(sourcePrivateBalanceName === undefined
      ? {}
      : { sourcePrivateBalanceName }),
    targetPrivateBalanceName,
    amountWei: DENOMINATION.toString(),
  });
  assert.equal(plan.decision, "allow", JSON.stringify(plan));
  const request = await runtime.applyPrivateBalanceFunding({
    decisionId: String(plan.decisionId),
    clientRequestId: `fund-${requestSuffix}`,
    userConfirmed: true,
  });
  const settled = request.phase === "confirmed"
    ? request
    : await runtime.getPrivateBalanceFundingRequest(String(request.requestId));
  assert.equal(settled.phase, "confirmed", JSON.stringify(settled));
  return settled;
}

async function waitForPrivateReady(store: StateStore): Promise<StateDocument> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await store.read();
    if (state.onboarding?.phase === "private_ready") return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const state = await store.read();
  assert.fail(`wallet did not become private-ready: ${state.onboarding?.phase}`);
}

function activeProfile(state: StateDocument) {
  assert.ok(state.wallet);
  const profile = state.wallet.profiles[state.wallet.activeWalletId];
  assert.ok(profile);
  return profile;
}

function publicSerialization(value: unknown): string {
  return JSON.stringify(value);
}

function assertInternalFieldsRedacted(value: unknown): void {
  const serialized = publicSerialization(value);
  for (const marker of INTERNAL_MARKERS) {
    assert.doesNotMatch(serialized, new RegExp(marker, "u"));
  }
  assert.doesNotMatch(serialized, /abpb-[0-9a-f]{40}/u);
  assert.doesNotMatch(serialized, /secret-target-commitment/u);
  assert.doesNotMatch(serialized, new RegExp(PRIVATE_EXECUTOR, "iu"));
  assert.doesNotMatch(serialized, new RegExp(POOL, "iu"));
}

test("default runtime reserves the Tornado deposit fee for main-to-private funding", async () => {
  const harness = await createHarness();
  try {
    await createPocket(harness.runtime, "fee-boundary", "fee-boundary");
    const requiredBalance = DENOMINATION + TORNADO_DEPOSIT_GAS_RESERVE_WEI;
    harness.chain.balances.set(
      MAIN_ONE.toLowerCase(),
      requiredBalance - 1n,
    );

    const blockedPlan = await harness.runtime.previewPrivateBalanceFunding({
      targetPrivateBalanceName: "fee-boundary",
      amountWei: DENOMINATION.toString(),
    }) as {
      decision: string;
      blockers: string[];
      gasReserveWei: string;
      mainBalanceSnapshotWei: string;
    };
    assert.equal(
      blockedPlan.gasReserveWei,
      TORNADO_DEPOSIT_GAS_RESERVE_WEI.toString(),
    );
    assert.equal(blockedPlan.mainBalanceSnapshotWei, (requiredBalance - 1n).toString());
    assert.equal(blockedPlan.decision, "deny");
    assert.deepEqual(blockedPlan.blockers, [
      "INSUFFICIENT_MAIN_BALANCE_WITH_GAS_RESERVE",
    ]);

    harness.chain.balances.set(MAIN_ONE.toLowerCase(), requiredBalance);
    const allowedPlan = await harness.runtime.previewPrivateBalanceFunding({
      targetPrivateBalanceName: "fee-boundary",
      amountWei: DENOMINATION.toString(),
    }) as {
      decisionId: string;
      decision: string;
      blockers: string[];
      gasReserveWei: string;
      mainBalanceSnapshotWei: string;
    };
    assert.equal(allowedPlan.decision, "allow");
    assert.deepEqual(allowedPlan.blockers, []);
    assert.equal(
      allowedPlan.gasReserveWei,
      TORNADO_DEPOSIT_GAS_RESERVE_WEI.toString(),
    );
    assert.equal(allowedPlan.mainBalanceSnapshotWei, requiredBalance.toString());

    harness.chain.balances.set(MAIN_ONE.toLowerCase(), requiredBalance - 1n);
    await assert.rejects(
      harness.runtime.applyPrivateBalanceFunding({
        decisionId: allowedPlan.decisionId,
        clientRequestId: "fund-fee-boundary",
        userConfirmed: true,
      }),
      /INSUFFICIENT_MAIN_BALANCE_WITH_GAS_RESERVE/u,
    );
    assert.equal(harness.wallet.mainFundingCalls, 0);

    harness.chain.balances.set(MAIN_ONE.toLowerCase(), requiredBalance);
    const funded = await harness.runtime.applyPrivateBalanceFunding({
      decisionId: allowedPlan.decisionId,
      clientRequestId: "fund-fee-boundary",
      userConfirmed: true,
    });
    assert.equal(funded.phase, "confirmed", JSON.stringify(funded));
    assert.equal(harness.wallet.mainFundingCalls, 1);
    assert.equal(await harness.chain.getBalanceWei(MAIN_ONE), 0n);
  } finally {
    await harness.runtime.shutdown().catch(() => undefined);
  }
});

type TestMcpClient = Omit<Client, "callTool"> & {
  callTool(input: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult>;
};

test("multi-wallet private balances persist, isolate policy, rebalance, and send by name", async () => {
  const harness = await createHarness();
  let runtime = harness.runtime;
  try {
    const originalAuthorizationId = activeProfile(await harness.store.read())
      .authorizationId;
    assert.ok(originalAuthorizationId);

    const cancelledPlan = await runtime.previewPrivateBalanceCreation({
      name: "cancelled-pocket",
    });
    const cancelled = await runtime.applyPrivateBalanceCreation({
      decisionId: String(cancelledPlan.decisionId),
      clientRequestId: "cancel-pocket-request",
      userConfirmed: false,
    });
    assert.equal(cancelled.decision, "deny");
    assert.deepEqual(cancelled.blockers, ["USER_CANCELLED"]);
    assert.equal(harness.wallet.ensureBackendCalls, 0);

    const cash = await createPocket(runtime, "cash", "cash-request");
    const cashAgain = await runtime.applyPrivateBalanceCreation({
      decisionId: cash.decisionId,
      clientRequestId: "create-cash-request",
      userConfirmed: true,
    });
    assert.equal(cashAgain.requestId, cash.requestId);
    assert.equal(harness.wallet.ensureBackendCalls, 1);
    const cashStatus = await runtime.getPrivateBalanceCreationRequest(cash.requestId);
    assert.equal(cashStatus.phase, "created");
    assert.equal(
      (await runtime.getPrivateBalanceCreationRequest(cash.decisionId)).requestId,
      cash.requestId,
    );

    await createPocket(runtime, "reserve", "reserve-request");
    await fundPocket(runtime, "cash", "cash-one");
    await fundPocket(runtime, "cash", "cash-two");
    const rebalance = await fundPocket(runtime, "reserve", "reserve-from-cash", "cash");
    assert.equal(
      (await runtime.getPrivateBalanceFundingRequest(String(rebalance.decisionId))).requestId,
      rebalance.requestId,
    );
    await fundPocket(runtime, "reserve", "reserve-from-main");
    assert.equal(rebalance.route, "rebalance_private");
    assert.equal(harness.wallet.mainFundingCalls, 3);
    assert.equal(harness.wallet.rebalanceCalls, 1);

    const beforePolicyCash = await runtime.privateBalancePolicy({
      privateBalanceName: "cash",
    }) as { policy: { enabled: boolean } };
    const beforePolicyReserve = await runtime.privateBalancePolicy({
      privateBalanceName: "reserve",
    }) as { policy: { enabled: boolean } };
    assert.equal(beforePolicyCash.policy.enabled, true);
    assert.equal(beforePolicyReserve.policy.enabled, true);

    const disableCash = await runtime.planPrivateBalancePolicyUpdate({
      privateBalanceName: "cash",
      enabled: false,
    });
    assert.equal(disableCash.decision, "allow");
    const disabled = await runtime.applyPrivateBalancePolicyUpdate({
      decisionId: String(disableCash.decisionId),
      clientRequestId: "disable-cash-policy",
      userConfirmed: true,
    });
    assert.equal(disabled.phase, "applied");
    assert.equal(
      (await runtime.getPrivateBalancePolicyUpdateRequest(String(disableCash.decisionId))).requestId,
      disabled.requestId,
    );
    assert.equal(
      ((await runtime.privateBalancePolicy({ privateBalanceName: "cash" })) as {
        policy: { enabled: boolean };
      }).policy.enabled,
      false,
    );
    assert.equal(
      ((await runtime.privateBalancePolicy({ privateBalanceName: "reserve" })) as {
        policy: { enabled: boolean };
      }).policy.enabled,
      true,
    );

    const blockedCashSend = await runtime.planPrivatePayment({
      recipient: RECIPIENT,
      sourcePrivateBalanceName: "cash",
      amountWei: (DENOMINATION / 10n).toString(),
    });
    assert.equal(blockedCashSend.decision, "deny");
    assert.ok(blockedCashSend.blockers.includes("PRIVATE_BALANCE_POLICY_DISABLED"));

    const reserveSend = await runtime.planPrivatePayment({
      recipient: RECIPIENT,
      sourcePrivateBalanceName: "reserve",
      amountWei: (DENOMINATION / 10n).toString(),
    });
    assert.equal(reserveSend.decision, "allow", JSON.stringify(reserveSend));
    harness.wallet.nextPrivateChangeAddress = PRIVATE_CHANGE;
    const submittedReserveSend = await runtime.executePrivatePayment({
      decisionId: reserveSend.decisionId,
      clientRequestId: "send-from-reserve",
      userConfirmed: true,
    });
    assert.equal(submittedReserveSend.phase, "submitted");
    const sent = await runtime.getRequest(submittedReserveSend.requestId);
    assert.equal(sent.phase, "confirmed");
    assert.equal(
      (await runtime.getRequest(reserveSend.decisionId)).requestId,
      submittedReserveSend.requestId,
    );
    assert.equal(
      sent.publicChangeWei,
      (DENOMINATION - DENOMINATION / 10n - REGULAR_TRANSFER_GAS_RESERVE_WEI)
        .toString(),
    );
    assert.equal(harness.wallet.privateChangeAccountCalls.length, 1);
    assert.equal(harness.wallet.privatePaymentCalls, 1);
    assert.equal(await harness.chain.getBalanceWei(RECIPIENT), DENOMINATION / 10n);

    const beforeCreate = await runtime.listWallets() as {
      wallets: Array<{ name: string; active: boolean; selection_epoch: number }>;
    };
    const selected = beforeCreate.wallets.find((wallet) => wallet.active);
    assert.ok(selected);
    const createdWallet = await runtime.createWallet({
      name: "vault-two",
      userConfirmed: true,
      expectedActiveWalletName: selected.name,
      expectedActiveSelectionEpoch: selected.selection_epoch,
    }) as { wallet: { wallet_id: string; name: string }; setup_phase: string };
    assert.equal(createdWallet.wallet.name, "vault-two");
    assert.ok(["awaiting_funding", "funding_pending"].includes(createdWallet.setup_phase));

    // Fund the second wallet through the same named regular-transfer flow a
    // user invokes in chat. Six bounded sends provide 0.3 Sepolia ETH: enough
    // for onboarding's private shield, realistic gas, and one child deposit.
    for (let transfer = 1; transfer <= 6; transfer += 1) {
      const fundingPlan = await runtime.planRegularTransfer({
        sourceWalletName: "vault-one",
        recipientWalletName: "vault-two",
        amountWei: (DENOMINATION / 2n).toString(),
      });
      assert.equal(fundingPlan.decision, "allow", JSON.stringify(fundingPlan));
      const fundingReceipt = await runtime.executeRegularTransfer({
        decisionId: fundingPlan.decisionId,
        clientRequestId: `fund-vault-two-${transfer}`,
        userConfirmed: true,
      });
      assert.equal(fundingReceipt.phase, "confirmed", JSON.stringify(fundingReceipt));
      assert.equal(
        (await runtime.getRegularTransferRequest(fundingPlan.decisionId)).requestId,
        fundingReceipt.requestId,
      );
    }
    assert.equal(harness.wallet.regularTransferCalls, 6);
    assert.equal(await harness.chain.getBalanceWei(MAIN_TWO), 3n * DENOMINATION);

    const loadedSecond = await runtime.selectWallet({
      walletId: createdWallet.wallet.wallet_id,
      userConfirmed: true,
    }) as { wallet: { name: string }; setup_phase: string };
    assert.equal(loadedSecond.wallet.name, "vault-two");
    await waitForPrivateReady(harness.store);
    const reauthorization = await runtime.planWalletReauthorization();
    assert.equal(reauthorization.decision, "allow", JSON.stringify(reauthorization));
    await runtime.reauthorizeWallet({
      decisionId: reauthorization.decisionId,
      userConfirmed: true,
    });
    assert.equal(
      ((await runtime.privateBalancePolicy({
        privateBalanceName: "private",
      })) as { policy: { enabled: boolean } }).policy.enabled,
      true,
    );
    const defaultPocketSend = await runtime.planPrivatePayment({
      recipient: RECIPIENT,
      sourcePrivateBalanceName: "private",
      amountWei: (DENOMINATION / 10n).toString(),
    });
    assert.equal(defaultPocketSend.decision, "allow", JSON.stringify(defaultPocketSend));
    const defaultPocketSent = await runtime.executePrivatePayment({
      decisionId: defaultPocketSend.decisionId,
      clientRequestId: "send-from-vault-two-default",
      userConfirmed: true,
    });
    assert.equal(defaultPocketSent.phase, "confirmed");

    await createPocket(runtime, "business", "business-request");
    await fundPocket(runtime, "business", "business-main");
    const businessPolicyPlan = await runtime.planPrivateBalancePolicyUpdate({
      privateBalanceName: "business",
      perPaymentLimitWei: (DENOMINATION / 5n).toString(),
      lifetimeLimitWei: (DENOMINATION / 5n).toString(),
      maxPayments: 1,
    });
    assert.equal(businessPolicyPlan.decision, "allow", JSON.stringify(businessPolicyPlan));
    await runtime.applyPrivateBalancePolicyUpdate({
      decisionId: String(businessPolicyPlan.decisionId),
      clientRequestId: "business-policy-update",
      userConfirmed: true,
    });
    const businessSend = await runtime.planPrivatePayment({
      recipient: RECIPIENT,
      sourcePrivateBalanceName: "business",
      amountWei: (DENOMINATION / 10n).toString(),
    });
    assert.equal(businessSend.decision, "allow", JSON.stringify(businessSend));
    const businessSent = await runtime.executePrivatePayment({
      decisionId: businessSend.decisionId,
      clientRequestId: "send-from-business",
      userConfirmed: true,
    });
    assert.equal(businessSent.phase, "confirmed");
    assert.equal(harness.wallet.privatePaymentCalls, 3);
    assert.equal(
      await harness.chain.getBalanceWei(RECIPIENT),
      3n * (DENOMINATION / 10n),
    );

    const stateWithTwoWallets = await harness.store.read();
    const firstProfile = Object.values(stateWithTwoWallets.wallet!.profiles)
      .find((profile) => profile.name === "vault-one");
    const secondProfile = Object.values(stateWithTwoWallets.wallet!.profiles)
      .find((profile) => profile.name === "vault-two");
    assert.ok(firstProfile);
    assert.ok(secondProfile);
    assert.equal(firstProfile.authorizationId, originalAuthorizationId);
    assert.ok(secondProfile.authorizationId);
    assert.deepEqual(
      Object.values(secondProfile.privateBalances).map(({ name }) => name).sort(),
      ["business", "private"],
    );

    const beforeInactivePolicyRead = await harness.store.read();
    const beforeInactivePolicyEpochs = Object.fromEntries(
      Object.values(beforeInactivePolicyRead.wallet!.profiles).map((profile) => [
        profile.name,
        profile.selectionEpoch,
      ]),
    );
    const selectionCallsBeforeInactivePolicy = harness.wallet.selectionCalls.length;
    const inactiveReservePolicy = await runtime.privateBalancePolicy({
      walletName: "vault-one",
      privateBalanceName: "reserve",
    });
    assert.equal(
      (inactiveReservePolicy as { wallet_name: string }).wallet_name,
      "vault-one",
    );
    const afterInactivePolicyRead = await harness.store.read();
    assert.equal(activeProfile(afterInactivePolicyRead).name, "vault-two");
    assert.equal(harness.wallet.activeWallet, "vault-two");
    assert.equal(
      harness.wallet.selectionCalls.length,
      selectionCallsBeforeInactivePolicy,
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.values(afterInactivePolicyRead.wallet!.profiles).map((profile) => [
          profile.name,
          profile.selectionEpoch,
        ]),
      ),
      beforeInactivePolicyEpochs,
    );

    const vaultOneProfile = Object.values(afterInactivePolicyRead.wallet!.profiles)
      .find((profile) => profile.name === "vault-one");
    assert.ok(vaultOneProfile);
    await runtime.selectWallet({
      walletId: vaultOneProfile.walletId,
      userConfirmed: true,
    });
    const explicitlyLoaded = await harness.store.read();
    assert.equal(activeProfile(explicitlyLoaded).name, "vault-one");
    assert.equal(activeProfile(explicitlyLoaded).authorizationId, originalAuthorizationId);
    assert.equal(explicitlyLoaded.onboarding?.delegation.enabled, true);

    const aggregatePolicyPlan = await runtime.planPolicyUpdate({
      ttlMs: 2 * 24 * 60 * 60_000,
    });
    assert.equal(aggregatePolicyPlan.decision, "allow", JSON.stringify(aggregatePolicyPlan));
    const aggregatePolicyReceipt = await runtime.applyPolicyUpdate({
      decisionId: aggregatePolicyPlan.decisionId,
      userConfirmed: true,
    });
    assert.equal(
      (await runtime.walletPolicy()).expiresAt,
      aggregatePolicyReceipt.policy.expiresAt,
    );

    const tree = await runtime.walletTree();
    const firstTree = tree.profiles.find((profile) => profile.shortName === "vault-one");
    const secondTree = tree.profiles.find((profile) => profile.shortName === "vault-two");
    assert.ok(firstTree);
    assert.ok(secondTree);
    assert.deepEqual(
      firstTree.subwallets.map(({ shortName }) => shortName).sort(),
      ["cash", "private", "reserve"],
    );
    assert.deepEqual(
      secondTree.subwallets.map(({ shortName }) => shortName).sort(),
      ["business", "private"],
    );
    assert.equal(firstTree.active, true);
    assert.equal(secondTree.active, false);
    assert.ok(secondTree.subwallets.every(({ freshness }) => freshness === "last_known"));

    const inventory = await runtime.listWallets() as {
      wallets: Array<{ name: string }>;
      unregistered_local_wallets: Array<{ name: string }>;
    };
    assert.deepEqual(inventory.wallets.map(({ name }) => name).sort(), [
      "vault-one",
      "vault-two",
    ]);
    assert.equal(
      inventory.unregistered_local_wallets.some(({ name }) => name.startsWith("abpb-")),
      false,
    );

    await runtime.shutdown();
    runtime = await createLocalRuntime(
      {
        ...loadConfig({
          AGENT_BOOST_STATE_DIR: harness.root,
          AGENT_BOOST_KOHAKU_WALLET: "vault-one",
          AGENT_BOOST_SHADE_TREE_ENABLED: "false",
          AGENT_BOOST_FUNDING_POLL_MS: "1",
          AGENT_BOOST_PRIVATE_POLL_MS: "1",
          AGENT_BOOST_SETUP_TIMEOUT_MS: "5000",
          AGENT_BOOST_PAYMENT_LIMIT_WEI: (DENOMINATION / 2n).toString(),
          AGENT_BOOST_LIFETIME_LIMIT_WEI: (10n * DENOMINATION).toString(),
          AGENT_BOOST_MAX_PAYMENTS: "20",
        }, harness.root),
        uiPort: 0,
      },
      {
        wallet: harness.wallet,
        chain: harness.chain,
        openBrowser: async () => false,
      },
    );
    const afterRestart = await runtime.walletTree();
    assert.deepEqual(
      afterRestart.profiles.map(({ shortName }) => shortName).sort(),
      ["vault-one", "vault-two"],
    );
    assert.deepEqual(
      afterRestart.profiles.find(({ shortName }) => shortName === "vault-one")!
        .subwallets.map(({ shortName }) => shortName).sort(),
      ["cash", "private", "reserve"],
    );
    assert.equal(
      (await runtime.walletPolicy()).expiresAt,
      aggregatePolicyReceipt.policy.expiresAt,
    );
    assert.equal(
      ((await runtime.privateBalancePolicy({
        privateBalanceName: "cash",
      })) as { policy: { enabled: boolean } }).policy.enabled,
      false,
    );
    const persistedBusinessPolicy = (await runtime.privateBalancePolicy({
      walletName: "vault-two",
      privateBalanceName: "business",
    })) as {
      wallet_name: string;
      private_balance_name: string;
      policy: {
        enabled: boolean;
        perPaymentLimitWei: string;
        lifetimeLimitWei: string;
        maxPayments: number;
        spentWei: string;
      };
    };
    assert.equal(persistedBusinessPolicy.wallet_name, "vault-two");
    assert.equal(persistedBusinessPolicy.private_balance_name, "business");
    assert.equal(persistedBusinessPolicy.policy.enabled, true);
    assert.equal(
      persistedBusinessPolicy.policy.perPaymentLimitWei,
      (DENOMINATION / 5n).toString(),
    );
    assert.equal(
      persistedBusinessPolicy.policy.lifetimeLimitWei,
      (DENOMINATION / 5n).toString(),
    );
    assert.equal(persistedBusinessPolicy.policy.maxPayments, 1);
    assert.equal(
      persistedBusinessPolicy.policy.spentWei,
      (DENOMINATION / 10n).toString(),
    );
    assert.equal(activeProfile(await harness.store.read()).name, "vault-one");
    assert.equal(harness.wallet.activeWallet, "vault-one");

    const beforeInactivePolicyChanges = await harness.store.read();
    const beforeInactivePolicyChangeEpochs = Object.fromEntries(
      Object.values(beforeInactivePolicyChanges.wallet!.profiles).map((profile) => [
        profile.name,
        profile.selectionEpoch,
      ]),
    );
    const selectionCallsBeforeInactiveChanges = harness.wallet.selectionCalls.length;
    const cancelledBusinessPolicy = await runtime.planPrivateBalancePolicyUpdate({
      walletName: "vault-two",
      privateBalanceName: "business",
      enabled: false,
    });
    assert.equal(cancelledBusinessPolicy.decision, "allow");
    const cancelledBusinessResult = await runtime.applyPrivateBalancePolicyUpdate({
      decisionId: String(cancelledBusinessPolicy.decisionId),
      clientRequestId: "cancel-inactive-business-policy",
      userConfirmed: false,
    });
    assert.equal(cancelledBusinessResult.decision, "deny");
    assert.deepEqual(cancelledBusinessResult.blockers, ["USER_CANCELLED"]);
    assert.equal(
      ((await runtime.privateBalancePolicy({
        walletName: "vault-two",
        privateBalanceName: "business",
      })) as { policy: { enabled: boolean } }).policy.enabled,
      true,
    );

    const durableBusinessPolicy = await runtime.planPrivateBalancePolicyUpdate({
      walletName: "vault-two",
      privateBalanceName: "business",
      maxPayments: 2,
    });
    assert.equal(durableBusinessPolicy.decision, "allow");
    assert.equal(activeProfile(await harness.store.read()).name, "vault-one");
    assert.equal(harness.wallet.activeWallet, "vault-one");
    assert.equal(
      harness.wallet.selectionCalls.length,
      selectionCallsBeforeInactiveChanges,
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.values((await harness.store.read()).wallet!.profiles).map((profile) => [
          profile.name,
          profile.selectionEpoch,
        ]),
      ),
      beforeInactivePolicyChangeEpochs,
    );

    await runtime.shutdown();
    runtime = await createLocalRuntime(
      {
        ...loadConfig({
          AGENT_BOOST_STATE_DIR: harness.root,
          AGENT_BOOST_KOHAKU_WALLET: "vault-one",
          AGENT_BOOST_SHADE_TREE_ENABLED: "false",
          AGENT_BOOST_FUNDING_POLL_MS: "1",
          AGENT_BOOST_PRIVATE_POLL_MS: "1",
          AGENT_BOOST_SETUP_TIMEOUT_MS: "5000",
          AGENT_BOOST_PAYMENT_LIMIT_WEI: (DENOMINATION / 2n).toString(),
          AGENT_BOOST_LIFETIME_LIMIT_WEI: (10n * DENOMINATION).toString(),
          AGENT_BOOST_MAX_PAYMENTS: "20",
        }, harness.root),
        uiPort: 0,
      },
      {
        wallet: harness.wallet,
        chain: harness.chain,
        openBrowser: async () => false,
      },
    );
    const selectionCallsAfterPolicyRestart = harness.wallet.selectionCalls.length;
    const appliedBusinessPolicy = await runtime.applyPrivateBalancePolicyUpdate({
      decisionId: String(durableBusinessPolicy.decisionId),
      clientRequestId: "apply-inactive-business-policy-after-restart",
      userConfirmed: true,
    });
    assert.equal(appliedBusinessPolicy.phase, "applied");
    const businessAfterInactiveApply = await runtime.privateBalancePolicy({
      walletName: "vault-two",
      privateBalanceName: "business",
    }) as { policy: { maxPayments: number; lifetimeLimitWei: string } };
    assert.equal(businessAfterInactiveApply.policy.maxPayments, 2);
    assert.equal(
      businessAfterInactiveApply.policy.lifetimeLimitWei,
      (2n * (DENOMINATION / 5n)).toString(),
    );
    assert.equal(activeProfile(await harness.store.read()).name, "vault-one");
    assert.equal(harness.wallet.activeWallet, "vault-one");
    assert.equal(
      harness.wallet.selectionCalls.length,
      selectionCallsAfterPolicyRestart,
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.values((await harness.store.read()).wallet!.profiles).map((profile) => [
          profile.name,
          profile.selectionEpoch,
        ]),
      ),
      beforeInactivePolicyChangeEpochs,
    );

    const staleBusinessPolicy = await runtime.planPrivateBalancePolicyUpdate({
      walletName: "vault-two",
      privateBalanceName: "business",
      enabled: false,
    });
    assert.equal(staleBusinessPolicy.decision, "allow");
    const inactiveParentPolicy = await runtime.planPolicyUpdate({
      walletName: "vault-two",
      perPaymentLimitWei: (DENOMINATION / 10n).toString(),
    });
    assert.equal(inactiveParentPolicy.decision, "allow", JSON.stringify(inactiveParentPolicy));
    await runtime.applyPolicyUpdate({
      decisionId: inactiveParentPolicy.decisionId,
      userConfirmed: true,
    });
    const clampedBusinessPolicy = await runtime.privateBalancePolicy({
      walletName: "vault-two",
      privateBalanceName: "business",
    }) as {
      policy: {
        perPaymentLimitWei: string;
        lifetimeLimitWei: string;
        spentWei: string;
        maxPayments: number;
      };
    };
    assert.equal(
      clampedBusinessPolicy.policy.perPaymentLimitWei,
      (DENOMINATION / 10n).toString(),
    );
    assert.equal(
      clampedBusinessPolicy.policy.lifetimeLimitWei,
      (DENOMINATION / 5n).toString(),
    );
    assert.equal(
      clampedBusinessPolicy.policy.spentWei,
      (DENOMINATION / 10n).toString(),
    );
    assert.equal(clampedBusinessPolicy.policy.maxPayments, 2);
    await assert.rejects(
      runtime.applyPrivateBalancePolicyUpdate({
        decisionId: String(staleBusinessPolicy.decisionId),
        clientRequestId: "stale-inactive-business-policy",
        userConfirmed: true,
      }),
      /PRIVATE_BALANCE_CHANGED_REFRESH_PLAN/u,
    );
    assert.equal(activeProfile(await harness.store.read()).name, "vault-one");
    assert.equal(harness.wallet.activeWallet, "vault-one");
    assert.equal(
      harness.wallet.selectionCalls.length,
      selectionCallsAfterPolicyRestart,
    );

    const childChangedPolicy = await runtime.planPrivateBalancePolicyUpdate({
      walletName: "vault-two",
      privateBalanceName: "business",
      enabled: false,
    });
    assert.equal(
      childChangedPolicy.decision,
      "allow",
      JSON.stringify(childChangedPolicy),
    );
    await harness.store.update((draft) => {
      const profile = Object.values(draft.wallet!.profiles)
        .find((candidate) => candidate.name === "vault-two");
      const privateBalance = Object.values(profile!.privateBalances)
        .find((candidate) => candidate.name === "business");
      assert.ok(privateBalance);
      privateBalance.revision += 1;
      privateBalance.updatedAt = new Date().toISOString();
    });
    await assert.rejects(
      runtime.applyPrivateBalancePolicyUpdate({
        decisionId: String(childChangedPolicy.decisionId),
        clientRequestId: "child-changed-inactive-business-policy",
        userConfirmed: true,
      }),
      /PRIVATE_BALANCE_CHANGED_REFRESH_PLAN/u,
    );

    const selectionChangedPolicy = await runtime.planPrivateBalancePolicyUpdate({
      walletName: "vault-two",
      privateBalanceName: "business",
      enabled: false,
    });
    assert.equal(selectionChangedPolicy.decision, "allow");
    const beforeSelectionChange = await harness.store.read();
    const vaultTwo = Object.values(beforeSelectionChange.wallet!.profiles)
      .find((profile) => profile.name === "vault-two");
    const activeVaultOne = activeProfile(beforeSelectionChange);
    assert.ok(vaultTwo);
    await runtime.selectWallet({
      walletId: vaultTwo.walletId,
      userConfirmed: true,
    });
    await runtime.selectWallet({
      walletId: activeVaultOne.walletId,
      userConfirmed: true,
    });
    await assert.rejects(
      runtime.applyPrivateBalancePolicyUpdate({
        decisionId: String(selectionChangedPolicy.decisionId),
        clientRequestId: "selection-changed-inactive-business-policy",
        userConfirmed: true,
      }),
      /PRIVATE_BALANCE_CHANGED_REFRESH_PLAN/u,
    );
    assert.equal(activeProfile(await harness.store.read()).name, "vault-one");
    assert.equal(harness.wallet.activeWallet, "vault-one");

    const beforeChangeSpend = await harness.store.read();
    const vaultOne = Object.values(beforeChangeSpend.wallet!.profiles)
      .find((profile) => profile.name === "vault-one");
    const reserve = Object.values(vaultOne!.privateBalances)
      .find((privateBalance) => privateBalance.name === "reserve");
    assert.ok(reserve);
    const trackedChange = reserve.publicChangeAccounts?.[
      PRIVATE_CHANGE.toLowerCase()
    ];
    assert.ok(trackedChange);
    const changeSpendAmount = DENOMINATION / 100n;
    const changeBalanceBefore = BigInt(trackedChange.balanceWei);
    const changeSpendPlan = await runtime.planRegularTransfer({
      sourceWalletName: "vault-one",
      sourcePrivateBalanceName: "reserve",
      recipientWalletName: "vault-two",
      amountWei: changeSpendAmount.toString(),
    });
    assert.equal(changeSpendPlan.decision, "allow", JSON.stringify(changeSpendPlan));
    const changeSpend = await runtime.executeRegularTransfer({
      decisionId: changeSpendPlan.decisionId,
      clientRequestId: "send-reserve-change-after-restart",
      userConfirmed: true,
    });
    assert.equal(changeSpend.phase, "confirmed", JSON.stringify(changeSpend));
    assert.deepEqual(harness.wallet.namedRegularTransferCalls, [{
      walletName: reserve.backendWalletName,
      sourceAddress: PRIVATE_CHANGE,
      recipient: MAIN_TWO,
      amountWei: changeSpendAmount,
    }]);
    const changeBalanceAfter = changeBalanceBefore - changeSpendAmount -
      REGULAR_TRANSFER_GAS_RESERVE_WEI;
    assert.equal(await harness.chain.getBalanceWei(PRIVATE_CHANGE), changeBalanceAfter);
    const afterChangeSpend = await harness.store.read();
    const activeReserve = Object.values(activeProfile(afterChangeSpend).privateBalances)
      .find((privateBalance) => privateBalance.name === "reserve");
    assert.equal(
      activeReserve?.publicChangeAccounts?.[PRIVATE_CHANGE.toLowerCase()]?.balanceWei,
      changeBalanceAfter.toString(),
    );

    // Expire an existing authorization without removing its durable identity.
    // Reauthorization must renew inherited/default pocket policy while an
    // explicitly managed disabled pocket keeps its independent constraint.
    await runtime.privateBalancePolicy({
      walletName: "vault-one",
      privateBalanceName: "cash",
    });
    await harness.store.update((draft) => {
      assert.ok(draft.wallet);
      assert.ok(draft.onboarding);
      const profile = draft.wallet.profiles[draft.wallet.activeWalletId];
      assert.ok(profile);
      assert.equal(profile.authorizationId, originalAuthorizationId);
      draft.onboarding.delegation.expiresAt = new Date(0).toISOString();
      draft.onboarding.revision += 1;
      draft.onboarding.updatedAt = new Date().toISOString();
    });
    const renewed = await runtime.planWalletReauthorization();
    assert.equal(renewed.decision, "allow", JSON.stringify(renewed));
    await runtime.reauthorizeWallet({
      decisionId: renewed.decisionId,
      userConfirmed: true,
    });
    assert.equal(
      ((await runtime.privateBalancePolicy({
        privateBalanceName: "cash",
      })) as { policy: { enabled: boolean } }).policy.enabled,
      false,
    );
    assert.equal(
      ((await runtime.privateBalancePolicy({
        privateBalanceName: "reserve",
      })) as { policy: { enabled: boolean } }).policy.enabled,
      true,
    );
    const renewedPolicy = await runtime.walletPolicy();
    assert.equal(renewedPolicy.enabled, true);
    assert.equal(renewedPolicy.paymentsUsed, 0);
    const renewedDefault = (await runtime.privateBalancePolicy({
      privateBalanceName: "private",
    })) as { policy: { enabled: boolean; expiresAt: string } };
    const renewedReserve = (await runtime.privateBalancePolicy({
      privateBalanceName: "reserve",
    })) as { policy: { enabled: boolean; expiresAt: string } };
    assert.equal(renewedDefault.policy.enabled, true);
    assert.equal(renewedReserve.policy.enabled, true);
    assert.equal(renewedDefault.policy.expiresAt, renewedPolicy.expiresAt);
    assert.equal(renewedReserve.policy.expiresAt, renewedPolicy.expiresAt);

    const defaultPrivatePlan = await runtime.planPrivatePayment({
      recipient: RECIPIENT,
      sourcePrivateBalanceName: "private",
      amountWei: (DENOMINATION / 10n).toString(),
    });
    assert.equal(defaultPrivatePlan.decision, "allow", JSON.stringify(defaultPrivatePlan));
    harness.wallet.nextPrivateChangeAddress = DEFAULT_PRIVATE_CHANGE;
    const defaultPrivateSubmitted = await runtime.executePrivatePayment({
      decisionId: defaultPrivatePlan.decisionId,
      clientRequestId: "send-default-after-reauthorization",
      userConfirmed: true,
    });
    assert.equal(defaultPrivateSubmitted.phase, "submitted");
    assert.equal(
      (await runtime.getRequest(defaultPrivateSubmitted.requestId)).phase,
      "confirmed",
    );

    const reservePrivatePlan = await runtime.planPrivatePayment({
      recipient: RECIPIENT,
      sourcePrivateBalanceName: "reserve",
      amountWei: (DENOMINATION / 10n).toString(),
    });
    assert.equal(reservePrivatePlan.decision, "allow", JSON.stringify(reservePrivatePlan));
    assert.equal(
      (await runtime.executePrivatePayment({
        decisionId: reservePrivatePlan.decisionId,
        clientRequestId: "send-reserve-after-reauthorization",
        userConfirmed: true,
      })).phase,
      "confirmed",
    );

    for (const [pocket, requestId] of ([
      ["private", "send-default-change-after-reauthorization"],
      ["reserve", "send-reserve-change-after-reauthorization"],
    ] as const)) {
      const publicChangePlan = await runtime.planRegularTransfer({
        sourceWalletName: "vault-one",
        sourcePrivateBalanceName: pocket,
        recipientWalletName: "vault-two",
        amountWei: (DENOMINATION / 100n).toString(),
      });
      assert.equal(publicChangePlan.decision, "allow", JSON.stringify(publicChangePlan));
      assert.equal(
        (await runtime.executeRegularTransfer({
          decisionId: publicChangePlan.decisionId,
          clientRequestId: requestId,
          userConfirmed: true,
        })).phase,
        "confirmed",
      );
    }
    assert.equal((await runtime.walletPolicy()).paymentsUsed, 4);

    const archivedChildPolicy = await runtime.planPrivateBalancePolicyUpdate({
      walletName: "vault-one",
      privateBalanceName: "cash",
      maxPayments: 2,
    });
    assert.equal(archivedChildPolicy.decision, "allow");
    await harness.store.update((draft) => {
      const profile = draft.wallet!.profiles[draft.wallet!.activeWalletId]!;
      const cash = Object.values(profile.privateBalances)
        .find((privateBalance) => privateBalance.name === "cash");
      assert.ok(cash);
      cash.status = "archived";
      cash.revision += 1;
      cash.updatedAt = new Date().toISOString();
    });
    await assert.rejects(
      runtime.privateBalancePolicy({ privateBalanceName: "cash" }),
      /PRIVATE_BALANCE_ARCHIVED/u,
    );
    await assert.rejects(
      runtime.applyPrivateBalancePolicyUpdate({
        decisionId: String(archivedChildPolicy.decisionId),
        clientRequestId: "archived-child-policy-apply",
        userConfirmed: true,
      }),
      /PRIVATE_BALANCE_NOT_FOUND/u,
    );
    await assert.rejects(
      runtime.privateBalancePolicy({ privateBalanceName: "missing-pocket" }),
      /PRIVATE_BALANCE_NOT_FOUND/u,
    );

    const archivedParentPolicy = await runtime.planPrivateBalancePolicyUpdate({
      walletName: "vault-two",
      privateBalanceName: "business",
      enabled: false,
    });
    assert.equal(archivedParentPolicy.decision, "allow");
    const beforeArchive = await harness.store.read();
    const archivedParent = Object.values(beforeArchive.wallet!.profiles)
      .find((profile) => profile.name === "vault-two");
    assert.ok(archivedParent);
    const selectionCallsBeforeInvalidReferences = harness.wallet.selectionCalls.length;
    await runtime.archiveWallet({
      walletId: archivedParent.walletId,
      userConfirmed: true,
    });
    await assert.rejects(
      runtime.privateBalancePolicy({
        walletName: "vault-two",
        privateBalanceName: "business",
      }),
      (error: unknown) => error instanceof AgentBoostRequestError &&
        error.code === "SOURCE_WALLET_ARCHIVED",
    );
    await assert.rejects(
      runtime.applyPrivateBalancePolicyUpdate({
        decisionId: String(archivedParentPolicy.decisionId),
        clientRequestId: "archived-parent-policy-apply",
        userConfirmed: true,
      }),
      /WALLET_NOT_FOUND/u,
    );
    await assert.rejects(
      runtime.privateBalancePolicy({
        walletName: "missing-wallet",
        privateBalanceName: "private",
      }),
      (error: unknown) => error instanceof AgentBoostRequestError &&
        error.code === "SOURCE_WALLET_NOT_FOUND",
    );
    await harness.store.registerManagedWallet("vault_one_wallet");
    await assert.rejects(
      runtime.privateBalancePolicy({
        walletName: "vault one",
        privateBalanceName: "private",
      }),
      (error: unknown) => error instanceof AgentBoostRequestError &&
        error.code === "SOURCE_WALLET_AMBIGUOUS",
    );
    assert.equal(activeProfile(await harness.store.read()).name, "vault-one");
    assert.equal(harness.wallet.activeWallet, "vault-one");
    assert.equal(
      harness.wallet.selectionCalls.length,
      selectionCallsBeforeInvalidReferences,
    );
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
});

test("private-balance MCP previews enforce a later-turn boundary and redact physical internals", async () => {
  const harness = await createHarness();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(harness.runtime);
  const client = new Client({ name: "private-balance-mcp-test", version: "1.0.0" }) as
    TestMcpClient;
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const createPreview = await client.callTool({
      name: "wallet_preview_private_balance_create",
      arguments: { private_balance_name: "mcp-pocket" },
    });
    const createStructured = createPreview.structuredContent as {
      code: string;
      data: { plan: { decisionId: string } };
    };
    assert.equal(createStructured.code, "PRIVATE_BALANCE_CREATE_PLANNED");
    assertInternalFieldsRedacted(createPreview);
    assert.deepEqual(createPreview._meta?.["org.agentboost/turn-control"], {
      schema_version: 1,
      boundary: "new_user_turn",
      continuation: {
        tool: "wallet_apply_private_balance_create",
        binding: { decision_id: createStructured.data.plan.decisionId },
      },
    });
    assert.equal(harness.wallet.ensureBackendCalls, 0);

    const missingConfirmation = await client.callTool({
      name: "wallet_apply_private_balance_create",
      arguments: { decision_id: createStructured.data.plan.decisionId },
    });
    assert.equal(
      (missingConfirmation.structuredContent as { code: string }).code,
      "PRIVATE_BALANCE_CREATE_CONFIRMATION_REQUIRED",
    );
    assert.equal(harness.wallet.ensureBackendCalls, 0);
    assertInternalFieldsRedacted(missingConfirmation);

    const created = await client.callTool({
      name: "wallet_apply_private_balance_create",
      arguments: {
        decision_id: createStructured.data.plan.decisionId,
        client_request_id: "mcp-create-request",
        user_confirmed: true,
      },
    });
    const createdRequest = (created.structuredContent as {
      data: { request: { requestId: string } };
    }).data.request;
    assert.match(createdRequest.requestId, /^pbcr_/u);
    assert.equal(harness.wallet.ensureBackendCalls, 1);
    assertInternalFieldsRedacted(created);

    const createdAgain = await client.callTool({
      name: "wallet_apply_private_balance_create",
      arguments: {
        decision_id: createStructured.data.plan.decisionId,
        client_request_id: "mcp-create-request",
        user_confirmed: true,
      },
    });
    assert.equal(
      (createdAgain.structuredContent as {
        data: { request: { requestId: string } };
      }).data.request.requestId,
      createdRequest.requestId,
    );
    assert.equal(harness.wallet.ensureBackendCalls, 1);

    const createStatus = await client.callTool({
      name: "wallet_get_private_balance_operation",
      arguments: { request_id: createdRequest.requestId },
    });
    assert.equal(
      (createStatus.structuredContent as { outcome: string }).outcome,
      "confirmed",
    );
    assertInternalFieldsRedacted(createStatus);

    const cancelledPreview = await client.callTool({
      name: "wallet_preview_private_balance_create",
      arguments: { private_balance_name: "never-created" },
    });
    const cancelledDecision = (cancelledPreview.structuredContent as {
      data: { plan: { decisionId: string } };
    }).data.plan.decisionId;
    const cancelled = await client.callTool({
      name: "wallet_apply_private_balance_create",
      arguments: {
        decision_id: cancelledDecision,
        user_confirmed: false,
      },
    });
    assert.equal(
      (cancelled.structuredContent as { code: string }).code,
      "PRIVATE_BALANCE_CREATE_CANCELLED",
    );
    assert.equal(harness.wallet.ensureBackendCalls, 1);

    const fundPreview = await client.callTool({
      name: "wallet_preview_private_balance_fund",
      arguments: {
        source: "$main",
        target_private_balance_name: "mcp-pocket",
        amount_native: "0.1",
      },
    });
    const fundStructured = fundPreview.structuredContent as {
      code: string;
      data: { plan: { decisionId: string } };
    };
    assert.equal(fundStructured.code, "PRIVATE_BALANCE_FUNDING_PLANNED");
    assert.equal(harness.wallet.mainFundingCalls, 0);
    assertInternalFieldsRedacted(fundPreview);
    assert.deepEqual(fundPreview._meta?.["org.agentboost/turn-control"], {
      schema_version: 1,
      boundary: "new_user_turn",
      continuation: {
        tool: "wallet_apply_private_balance_fund",
        binding: { decision_id: fundStructured.data.plan.decisionId },
      },
    });

    const fundMissingConfirmation = await client.callTool({
      name: "wallet_apply_private_balance_fund",
      arguments: { decision_id: fundStructured.data.plan.decisionId },
    });
    assert.equal(
      (fundMissingConfirmation.structuredContent as { code: string }).code,
      "PRIVATE_BALANCE_FUNDING_CONFIRMATION_REQUIRED",
    );
    assert.equal(harness.wallet.mainFundingCalls, 0);
    assertInternalFieldsRedacted(fundMissingConfirmation);

    const funded = await client.callTool({
      name: "wallet_apply_private_balance_fund",
      arguments: {
        decision_id: fundStructured.data.plan.decisionId,
        client_request_id: "mcp-funding-request",
        user_confirmed: true,
      },
    });
    const fundedRequest = (funded.structuredContent as {
      data: { request: { requestId: string } };
    }).data.request;
    assert.match(fundedRequest.requestId, /^pbfr_/u);
    assert.equal(harness.wallet.mainFundingCalls, 1);
    assertInternalFieldsRedacted(funded);

    const fundedAgain = await client.callTool({
      name: "wallet_apply_private_balance_fund",
      arguments: {
        decision_id: fundStructured.data.plan.decisionId,
        client_request_id: "mcp-funding-request",
        user_confirmed: true,
      },
    });
    assert.equal(
      (fundedAgain.structuredContent as {
        data: { request: { requestId: string } };
      }).data.request.requestId,
      fundedRequest.requestId,
    );
    assert.equal(harness.wallet.mainFundingCalls, 1);
    assertInternalFieldsRedacted(fundedAgain);

    const fundingStatus = await client.callTool({
      name: "wallet_get_private_balance_operation",
      arguments: { request_id: fundedRequest.requestId },
    });
    assert.equal(
      (fundingStatus.structuredContent as { outcome: string }).outcome,
      "confirmed",
    );
    assertInternalFieldsRedacted(fundingStatus);

    const policyPreview = await client.callTool({
      name: "wallet_preview_private_balance_policy_update",
      arguments: {
        private_balance_name: "mcp-pocket",
        enabled: false,
      },
    });
    const policyDecision = (policyPreview.structuredContent as {
      data: { plan: { decisionId: string } };
    }).data.plan.decisionId;
    const policyMissingConfirmation = await client.callTool({
      name: "wallet_apply_private_balance_policy_update",
      arguments: { decision_id: policyDecision },
    });
    assert.equal(
      (policyMissingConfirmation.structuredContent as { code: string }).code,
      "PRIVATE_BALANCE_POLICY_UPDATE_CONFIRMATION_REQUIRED",
    );
    assert.equal(
      ((await harness.runtime.privateBalancePolicy({
        privateBalanceName: "mcp-pocket",
      })) as { policy: { enabled: boolean } }).policy.enabled,
      true,
    );
    const policyApplied = await client.callTool({
      name: "wallet_apply_private_balance_policy_update",
      arguments: {
        decision_id: policyDecision,
        client_request_id: "mcp-policy-request",
        user_confirmed: true,
      },
    });
    assert.equal(
      (policyApplied.structuredContent as { code: string }).code,
      "PRIVATE_BALANCE_POLICY_UPDATED",
    );
    assert.equal(
      ((await harness.runtime.privateBalancePolicy({
        privateBalanceName: "mcp-pocket",
      })) as { policy: { enabled: boolean } }).policy.enabled,
      false,
    );
    assertInternalFieldsRedacted(policyPreview);
    assertInternalFieldsRedacted(policyMissingConfirmation);
    assertInternalFieldsRedacted(policyApplied);
  } finally {
    await client.close();
    await server.close();
    await harness.runtime.shutdown();
  }
});
