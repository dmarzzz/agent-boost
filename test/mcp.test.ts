import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "../src/config.js";
import type {
  ChainClient,
  PolicyUpdatePlan,
  PolicyUpdateReceipt,
  RecoveryTransferPlan,
  RecoveryTransferRequest,
  WalletAdapter,
} from "../src/contracts.js";
import { AgentBoostRequestError } from "../src/errors.js";
import { handleHermesTurnGatePayload } from "../src/hermes/turn-gate.js";
import type { AgentBoostRuntime } from "../src/mcp.js";
import { createMcpServer, runMcpTransport } from "../src/mcp.js";
import { LocalAgentBoostRuntime } from "../src/service.js";
import { StateStore } from "../src/state/store.js";

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";
const HERMES_MODEL_CONTEXT_KEY = "org.agentboost/model-context";
const HERMES_TURN_CONTROL_KEY = "org.agentboost/turn-control";
const HERMES_USER_FACING_OUTPUT_KEY = "org.agentboost/user-facing-output";
const FORBIDDEN_CONFIRMATION_SURFACE_VOCABULARY =
  /\b(?:native|external|another|system)\b[^\n]{0,40}\b(?:approval|confirmation|interface|prompt|surface|ui)\b|\b(?:button|popup|notification)\b/iu;
const CONFIRMATION_ACTION_TOOL_PATTERN =
  /wallet_(?:create|adopt_existing|switch_saved_profile|archive|apply_reauthorization|apply_policy_update|execute_regular_transfer|execute_private_payment|execute_recovery_transfer|start_new_demo)/u;
const AUTHORIZATION = {
  walletId: "wallet_12345678",
  walletName: "agent-boost",
  selectionEpoch: 1,
  authorizationId: "auth_12345678",
};
const WALLET_SELECTION = {
  walletId: AUTHORIZATION.walletId,
  walletName: AUTHORIZATION.walletName,
  selectionEpoch: AUTHORIZATION.selectionEpoch,
};

type TestMcpClient = Omit<Client, "callTool"> & {
  callTool(input: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult>;
};

function testMcpClient(client: Client): TestMcpClient {
  return client as unknown as TestMcpClient;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function simulateHermesContentArbitration(result: CallToolResult): {
  result: string;
  _meta?: Record<string, unknown>;
} {
  const rendered = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .filter((text) => text.trim().length > 0)
    .join("\n");
  return {
    result: rendered,
    ...(result._meta ? { _meta: result._meta } : {}),
  };
}

function visibleToolSurface(result: CallToolResult): string {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const presentation = (result.structuredContent as {
    presentation?: Record<string, unknown>;
  } | undefined)?.presentation;
  return `${text}\n${presentation ? JSON.stringify(presentation) : ""}`;
}

function authoritativeOutput(result: CallToolResult): string | undefined {
  const contract = result._meta?.[HERMES_USER_FACING_OUTPUT_KEY] as {
    schema_version?: unknown;
    mode?: unknown;
    rendered_response?: unknown;
  } | undefined;
  assert.equal(contract?.schema_version, 1);
  assert.equal(contract.mode, "replace");
  return typeof contract.rendered_response === "string"
    ? contract.rendered_response
    : undefined;
}

function assertCompactTerminalReceipt(
  result: CallToolResult,
  expected: readonly RegExp[],
  maxLines = 3,
): string {
  const output = authoritativeOutput(result) ?? "";
  for (const pattern of expected) assert.match(output, pattern);
  assert.ok(
    output.split("\n").filter((line) => line.trim().length > 0).length <= maxLines,
    `authoritative receipt exceeds ${maxLines} visible lines: ${output}`,
  );
  assert.doesNotMatch(
    output,
    /\b(?:pending|approve|confirmation required|reply to continue)\b/iu,
  );
  return output;
}

function assertNoVisibleInternalIds(result: CallToolResult): void {
  assert.doesNotMatch(
    visibleToolSurface(result),
    /\b(?:wra|wr|wrr|rwd|rreq|wd|wpd|req)_[A-Za-z0-9][A-Za-z0-9._:-]*\b|\bwallet_(?:[0-9a-f]{8}|saved_|eval_|[0-9])[A-Za-z0-9._:-]*\b/iu,
  );
}

function fakeRuntime(): AgentBoostRuntime {
  const setup = {
    version: 1 as const,
    setupId: "setup_12345678",
    revision: 3,
    phase: "awaiting_funding" as const,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    address: WALLET_ADDRESS,
    publicBalanceWei: "50000000000000000",
    privateBalanceWei: "0",
    requiredFundingWei: "200000000000000000",
    shieldAmountWei: "100000000000000000",
    uiUrl: "http://127.0.0.1:9183",
    uiOpened: true,
    delegation: {
      mode: "testnet_delegated" as const,
      chainId: 11_155_111 as const,
      perPaymentLimitWei: "100000000000000000",
      lifetimeLimitWei: "100000000000000000",
      spentWei: "0",
      maxPayments: 10,
      expiresAt: new Date(86_400_000).toISOString(),
      enabled: true,
    },
  };
  const privateBalanceBinding = {
    walletId: AUTHORIZATION.walletId,
    walletName: AUTHORIZATION.walletName,
    selectionEpoch: AUTHORIZATION.selectionEpoch,
    privateBalanceId: "pb_12345678",
    privateBalanceName: "savings",
    privateBalanceRevision: 1,
  };
  const privateBalancePolicy = {
    ...setup.delegation,
    paymentsUsed: 0,
    paymentsRemaining: setup.delegation.maxPayments,
  };
  const privateBalanceCreationPlan = {
    version: 1,
    decisionId: "pbc_12345678",
    wallet: WALLET_SELECTION,
    walletOnboardingRevision: 3,
    privateBalanceId: privateBalanceBinding.privateBalanceId,
    privateBalanceName: privateBalanceBinding.privateBalanceName,
    initialPolicy: privateBalancePolicy,
    intentDigest: `sha256:${"6".repeat(64)}`,
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(300_000).toISOString(),
    decision: "allow",
    blockers: [] as string[],
    approval: { action: "confirm", userConfirmationRequired: true },
  };
  const privateBalanceCreationRequest = {
    version: 1,
    requestId: "pbcr_12345678",
    clientRequestId: "hermes:pbc_12345678",
    decisionId: privateBalanceCreationPlan.decisionId,
    privateBalance: privateBalanceBinding,
    phase: "created",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(1_000).toISOString(),
    appliedAt: new Date(1_000).toISOString(),
  };
  const privateBalanceFundingPlan = {
    version: 1,
    decisionId: "pbf_12345678",
    sourceWallet: WALLET_SELECTION,
    targetWallet: WALLET_SELECTION,
    route: "shield_from_main",
    targetPrivateBalance: privateBalanceBinding,
    amountWei: "100000000000000000",
    mainBalanceSnapshotWei: "1500000000000000000",
    gasReserveWei: "1000000000000000",
    shieldDenominationWei: "100000000000000000",
    aggregatePrivateBalanceSnapshotWei: "250000000000000000",
    targetPrivateBalanceSnapshotWei: "0",
    intentDigest: `sha256:${"7".repeat(64)}`,
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(300_000).toISOString(),
    decision: "allow",
    blockers: [] as string[],
    approval: { action: "confirm", userConfirmationRequired: true },
  };
  const privateBalanceFundingRequest = {
    version: 1,
    requestId: "pbfr_12345678",
    clientRequestId: "hermes:pbf_12345678",
    decisionId: privateBalanceFundingPlan.decisionId,
    sourceWallet: WALLET_SELECTION,
    targetWallet: WALLET_SELECTION,
    route: "shield_from_main",
    targetPrivateBalance: privateBalanceBinding,
    amountWei: "100000000000000000",
    aggregatePrivateBalanceBeforeWei: "250000000000000000",
    aggregatePrivateBalanceAfterWei: "350000000000000000",
    targetPrivateBalanceBeforeWei: "0",
    targetPrivateBalanceAfterWei: "100000000000000000",
    phase: "confirmed",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(1_000).toISOString(),
    appliedAt: new Date(1_000).toISOString(),
  };
  const privateBalancePolicyPlan = {
    version: 1,
    decisionId: "pbp_12345678",
    privateBalance: privateBalanceBinding,
    current: privateBalancePolicy,
    proposed: {
      ...privateBalancePolicy,
      maxPayments: 2,
      paymentsRemaining: 2,
    },
    intentDigest: `sha256:${"8".repeat(64)}`,
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(300_000).toISOString(),
    decision: "allow",
    blockers: [] as string[],
    approval: { action: "confirm", userConfirmationRequired: true },
  };
  return {
    async capabilities() {
      return { chain_id: "eip155:11155111", egress_privacy: false };
    },
    async startOnboarding() {
      return {
        record: setup,
        snapshot: setup,
        uiOpened: true,
        qrPngBase64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      };
    },
    async onboardingStatus() {
      return setup;
    },
    async walletContext() {
      return {
        chain_id: "eip155:11155111",
        account_role: "main_funding_source",
        controls_subaccounts: false,
        account_id: `eip155:11155111:${setup.address}`,
        setup_phase: "private_ready",
        address: setup.address,
        balance_atomic: "1500000000000000000",
      };
    },
    async walletTree() {
      return {
        version: 1,
        chainId: 11_155_111,
        network: "Sepolia",
        observedAt: new Date(0).toISOString(),
        profiles: [
          {
            shortName: "agent-boost",
            active: true,
            setupPhase: "private_ready",
            policy: { ...privateBalancePolicy, freshness: "current" },
            main: {
              shortName: "main",
              role: "main_funding_source",
              balanceWei: "68899000000000000100",
              status: "ready",
              freshness: "live",
            },
            subwallets: [{
              shortName: "private",
              role: "private_payment_pocket",
              balanceWei: "250000000000000000",
              status: "ready",
              freshness: "live",
              policy: { ...privateBalancePolicy, freshness: "current" },
            }],
          },
          {
            shortName: "travel",
            active: false,
            setupPhase: "private_ready",
            policy: { ...privateBalancePolicy, freshness: "last_known" },
            main: {
              shortName: "main",
              role: "main_funding_source",
              balanceWei: "750000000000000000",
              status: "ready",
              freshness: "live",
            },
            subwallets: [{
              shortName: "private",
              role: "private_payment_pocket",
              balanceWei: "100000000000000000",
              status: "ready",
              freshness: "last_known",
              policy: { ...privateBalancePolicy, freshness: "last_known" },
            }],
          },
        ],
        archivedProfiles: 1,
        relationship: { type: "profile_container", impliesControl: false },
      };
    },
    async previewPrivateBalanceCreation(input) {
      return {
        ...privateBalanceCreationPlan,
        privateBalanceName: input.name,
      };
    },
    async getPrivateBalanceCreation() {
      return privateBalanceCreationPlan;
    },
    async applyPrivateBalanceCreation(input) {
      return input.userConfirmed
        ? { ...privateBalanceCreationRequest, clientRequestId: input.clientRequestId }
        : {
            ...privateBalanceCreationPlan,
            decision: "deny",
            blockers: ["USER_CANCELLED"],
          };
    },
    async getPrivateBalanceCreationRequest() {
      return privateBalanceCreationRequest;
    },
    async previewPrivateBalanceFunding(input) {
      return {
        ...privateBalanceFundingPlan,
        amountWei: input.amountWei,
        route: input.sourcePrivateBalanceName === undefined
          ? "shield_from_main"
          : "rebalance_private",
        ...(input.sourcePrivateBalanceName === undefined
          ? {}
          : {
              sourcePrivateBalance: {
                ...privateBalanceBinding,
                privateBalanceId: "pb_source_12345678",
                privateBalanceName: input.sourcePrivateBalanceName,
              },
              withdrawalAmountWei: "200000000000000000",
            }),
        targetPrivateBalance: {
          ...privateBalanceBinding,
          privateBalanceName: input.targetPrivateBalanceName,
        },
      };
    },
    async getPrivateBalanceFunding() {
      return privateBalanceFundingPlan;
    },
    async applyPrivateBalanceFunding(input) {
      return input.userConfirmed
        ? { ...privateBalanceFundingRequest, clientRequestId: input.clientRequestId }
        : {
            ...privateBalanceFundingPlan,
            decision: "deny",
            blockers: ["USER_CANCELLED"],
          };
    },
    async getPrivateBalanceFundingRequest() {
      return privateBalanceFundingRequest;
    },
    async privateBalancePolicy(input) {
      return {
        private_balance_name: input.privateBalanceName ?? "savings",
        policy: privateBalancePolicy,
      };
    },
    async planPrivateBalancePolicyUpdate(input) {
      return {
        ...privateBalancePolicyPlan,
        proposed: {
          ...privateBalancePolicyPlan.proposed,
          ...(input.maxPayments === undefined
            ? {}
            : {
                maxPayments: input.maxPayments,
                paymentsRemaining: input.maxPayments,
              }),
        },
      };
    },
    async getPrivateBalancePolicyUpdate() {
      return privateBalancePolicyPlan;
    },
    async applyPrivateBalancePolicyUpdate(input) {
      return input.userConfirmed
        ? {
            version: 1,
            requestId: "pbpr_12345678",
            clientRequestId: input.clientRequestId,
            decisionId: input.decisionId,
            privateBalance: privateBalanceBinding,
            phase: "applied",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(1_000).toISOString(),
            appliedAt: new Date(1_000).toISOString(),
            policy: privateBalancePolicyPlan.proposed,
          }
        : {
            ...privateBalancePolicyPlan,
            decision: "deny",
            blockers: ["USER_CANCELLED"],
          };
    },
    async getPrivateBalancePolicyUpdateRequest() {
      return {
        version: 1,
        requestId: "pbpr_12345678",
        clientRequestId: "hermes:pbp_12345678",
        decisionId: privateBalancePolicyPlan.decisionId,
        privateBalance: privateBalanceBinding,
        phase: "applied",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(1_000).toISOString(),
        appliedAt: new Date(1_000).toISOString(),
        policy: privateBalancePolicyPlan.proposed,
      };
    },
    async walletPolicy() {
      return {
        ...setup.delegation,
        paymentsUsed: 0,
        paymentsRemaining: 10,
      };
    },
    async planPolicyUpdate(input) {
      const current = {
        ...setup.delegation,
        paymentsUsed: 0,
        paymentsRemaining: 10,
      };
      const proposed = {
        ...current,
        perPaymentLimitWei:
          input.perPaymentLimitWei ?? current.perPaymentLimitWei,
        lifetimeLimitWei:
          input.lifetimeLimitWei ?? "10000000000000000000",
        maxPayments: input.maxPayments ?? current.maxPayments,
        paymentsRemaining: input.maxPayments ?? current.maxPayments,
        enabled: input.enabled ?? current.enabled,
      };
      return {
        version: 1,
        decisionId: "wpd_12345678",
        wallet: WALLET_SELECTION,
        authorizationId: AUTHORIZATION.authorizationId,
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(300_000).toISOString(),
        current,
        proposed,
        decision: "allow",
        blockers: [],
        approval: { action: "confirm", userConfirmationRequired: true },
      };
    },
    async getPolicyUpdatePlan() {
      const current = {
        ...setup.delegation,
        paymentsUsed: 0,
        paymentsRemaining: 10,
      };
      return {
        version: 1,
        decisionId: "wpd_12345678",
        wallet: WALLET_SELECTION,
        authorizationId: AUTHORIZATION.authorizationId,
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(300_000).toISOString(),
        current,
        proposed: {
          ...current,
          perPaymentLimitWei: "1000000000000000000",
          lifetimeLimitWei: "10000000000000000000",
          maxPayments: 10,
          paymentsRemaining: 10,
        },
        decision: "allow",
        blockers: [],
        approval: { action: "confirm", userConfirmationRequired: true },
      };
    },
    async getLatestPolicyUpdatePlan() {
      return this.getPolicyUpdatePlan("wpd_12345678");
    },
    async cancelPolicyUpdatePlan() {
      const plan = await this.getPolicyUpdatePlan("wpd_12345678");
      return {
        ...plan,
        decision: "deny" as const,
        blockers: [...plan.blockers, "USER_CANCELLED"],
      };
    },
    async applyPolicyUpdate(input) {
      assert.equal(input.decisionId, "wpd_12345678");
      assert.equal(input.userConfirmed, true);
      return {
        version: 1,
        decisionId: input.decisionId,
        wallet: WALLET_SELECTION,
        appliedAt: new Date(1_000).toISOString(),
        policy: {
          ...setup.delegation,
          perPaymentLimitWei: "1000000000000000000",
          lifetimeLimitWei: "10000000000000000000",
          maxPayments: 10,
          paymentsUsed: 0,
          paymentsRemaining: 10,
        },
        authorizationEffect: "preserved" as const,
        counterEffect: "preserved" as const,
      };
    },
    async listWallets() {
      return {
        active_wallet_id: AUTHORIZATION.walletId,
        wallets: [
          {
            wallet_id: AUTHORIZATION.walletId,
            name: "agent-boost",
            status: "available",
            active: true,
            selection_epoch: 1,
            authorization_status: "active",
          },
          {
            wallet_id: "wallet_87654321",
            name: "saved-wallet",
            status: "available",
            active: false,
            selection_epoch: 1,
            authorization_status: "inactive",
          },
        ],
        unregistered_local_wallets: [],
        local_inventory_status: "ready",
        counts: {
          registered: 2,
          available: 2,
          archived: 0,
          unregistered_local: 0,
          adoptable_local: 0,
        },
      };
    },
    async createWallet(input) {
      return { wallet: { name: input.name }, authorization_required: true };
    },
    async adoptWallet(input) {
      return { wallet: { name: input.name }, authorization_required: true };
    },
    async selectWallet() {
      return { wallet: { name: "saved-wallet" }, authorization_required: true };
    },
    async archiveWallet() {
      return { wallet: { name: "saved-wallet" } };
    },
    async planWalletReauthorization() {
      const currentPolicy = {
        ...setup.delegation,
        paymentsUsed: 0,
        paymentsRemaining: 10,
      };
      return {
        version: 1,
        decisionId: "wra_12345678",
        wallet: WALLET_SELECTION,
        priorAuthorizationId: AUTHORIZATION.authorizationId,
        currentPolicy,
        proposedPolicy: {
          ...currentPolicy,
          spentWei: "0",
          paymentsUsed: 0,
          paymentsRemaining: 10,
          expiresAt: new Date(86_400_000).toISOString(),
          enabled: true,
        },
        authorizationEffect: "replace",
        counterEffect: "reset_spend_and_payment_count",
        intentDigest: `sha256:${"2".repeat(64)}`,
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(300_000).toISOString(),
        decision: "allow",
        blockers: [],
        approval: { action: "confirm", userConfirmationRequired: true },
      };
    },
    async getWalletReauthorizationPlan() {
      return this.planWalletReauthorization();
    },
    async cancelWalletReauthorizationPlan() {
      const plan = await this.planWalletReauthorization();
      return {
        ...plan,
        decision: "deny" as const,
        blockers: [...plan.blockers, "USER_CANCELLED"],
      };
    },
    async reauthorizeWallet() {
      return { wallet: { name: "agent-boost" } };
    },
    async planRegularTransfer(input) {
      return {
        version: 1,
        decisionId: "rwd_12345678",
        recipient: input.recipient ?? "0x2222222222222222222222222222222222222222",
        ...(input.recipientWalletName === undefined
          ? {}
          : { recipientWalletName: input.recipientWalletName }),
        amountWei: input.amountWei,
        mainBalanceSnapshotWei: "1500000000000000000",
        gasReserveWei: "1000000000000000",
        authorization: AUTHORIZATION,
        intentDigest: `sha256:${"3".repeat(64)}`,
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(300_000).toISOString(),
        decision: "allow",
        blockers: [],
        approval: { action: "confirm" as const, userConfirmationRequired: true },
      };
    },
    async getRegularTransferPlan() {
      return this.planRegularTransfer({
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "1000000000000000000",
      });
    },
    async cancelRegularTransferPlan() {
      const plan = await this.getRegularTransferPlan("rwd_12345678");
      return {
        ...plan,
        decision: "deny" as const,
        blockers: [...plan.blockers, "USER_CANCELLED"],
      };
    },
    async executeRegularTransfer(input) {
      return {
        version: 1,
        requestId: "rreq_12345678",
        clientRequestId: input.clientRequestId,
        decisionId: input.decisionId,
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "1000000000000000000",
        gasReserveWei: "1000000000000000",
        authorization: AUTHORIZATION,
        phase: "submitted" as const,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        recipientBalanceBeforeWei: "123",
        reconciliation: { attempts: 1, checkedAt: new Date(0).toISOString() },
      };
    },
    async getRegularTransferRequest() {
      return {
        version: 1,
        requestId: "rreq_12345678",
        clientRequestId: "hermes:rwd_12345678",
        decisionId: "rwd_12345678",
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "1000000000000000000",
        gasReserveWei: "1000000000000000",
        authorization: AUTHORIZATION,
        phase: "submitted" as const,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        recipientBalanceBeforeWei: "123",
        reconciliation: { attempts: 1, checkedAt: new Date(0).toISOString() },
      };
    },
    async planPrivatePayment(input) {
      return {
        version: 1,
        decisionId: "wd_12345678",
        recipient: input.recipient ?? "0x2222222222222222222222222222222222222222",
        ...(input.recipientWalletName === undefined
          ? {}
          : { recipientWalletName: input.recipientWalletName }),
        amountWei: input.amountWei,
        authorization: AUTHORIZATION,
        intentDigest: `sha256:${"0".repeat(64)}`,
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(300_000).toISOString(),
        decision: "allow",
        blockers: [],
        approval: {
          action: "confirm" as const,
          userConfirmationRequired: true,
        },
      };
    },
    async getPaymentPlan() {
      return {
        version: 1,
        decisionId: "wd_12345678",
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "20000000000000000",
        authorization: AUTHORIZATION,
        intentDigest: `sha256:${"0".repeat(64)}`,
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(300_000).toISOString(),
        decision: "allow",
        blockers: [],
        approval: {
          action: "confirm" as const,
          userConfirmationRequired: true,
        },
      };
    },
    async cancelPrivatePaymentPlan() {
      const plan = await this.getPaymentPlan("wd_12345678");
      return {
        ...plan,
        decision: "deny" as const,
        blockers: [...plan.blockers, "USER_CANCELLED"],
      };
    },
    async executePrivatePayment(input) {
      return {
        version: 1,
        requestId: "req_12345678",
        clientRequestId: input.clientRequestId,
        decisionId: input.decisionId,
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "20000000000000000",
        authorization: AUTHORIZATION,
        phase: "submitted",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        recipientBalanceBeforeWei: "123",
        reconciliation: {
          attempts: 2,
          checkedAt: new Date(0).toISOString(),
        },
        userOperationReceiptEvidence: {
          version: 1 as const,
          status: "success" as const,
          userOperationHash: `0x${"a".repeat(64)}`,
          transactionHash: `0x${"b".repeat(64)}`,
          observedAt: new Date(0).toISOString(),
        },
      };
    },
    async getRequest() {
      return {
        version: 1,
        requestId: "req_12345678",
        clientRequestId: "hermes:wd_12345678",
        decisionId: "wd_12345678",
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "20000000000000000",
        authorization: AUTHORIZATION,
        phase: "submitted" as const,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        recipientBalanceBeforeWei: "123",
        reconciliation: { attempts: 2, checkedAt: new Date(0).toISOString() },
        userOperationReceiptEvidence: {
          version: 1 as const,
          status: "success" as const,
          userOperationHash: `0x${"a".repeat(64)}`,
          transactionHash: `0x${"b".repeat(64)}`,
          observedAt: new Date(0).toISOString(),
        },
      };
    },
    async planRecoveryTransfer(input) {
      return {
        version: 1,
        decisionId: "wr_12345678",
        wallet: WALLET_SELECTION,
        recipient: input.recipient ?? "0x2222222222222222222222222222222222222222",
        ...(input.recipientWalletName === undefined
          ? {}
          : { recipientWalletName: input.recipientWalletName }),
        amountWei: "100000000000000000",
        withdrawalAmountWei: "110000000000000000",
        feeReserveWei: "10000000000000000",
        maxRecipientAmountWei: "100000000000000000",
        privateBalanceSnapshotWei: "100000000000000000",
        remainingPrivateBalanceEstimateWei: "0",
        balanceRevision: 4,
        scope: "single_tornado_denomination" as const,
        feeModel: "reserved_from_wallet_controlled_remainder" as const,
        intentDigest: `sha256:${"1".repeat(64)}`,
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(300_000).toISOString(),
        decision: "allow",
        blockers: [],
        approval: { action: "confirm", userConfirmationRequired: true },
      };
    },
    async getRecoveryPlan() {
      return this.planRecoveryTransfer({
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "100000000000000000",
      });
    },
    async cancelRecoveryPlan() {
      const plan = await this.getRecoveryPlan("wr_12345678");
      return {
        ...plan,
        decision: "deny" as const,
        blockers: [...plan.blockers, "USER_CANCELLED"],
      };
    },
    async executeRecoveryTransfer(input) {
      return {
        version: 1,
        requestId: "wrr_12345678",
        clientRequestId: input.clientRequestId,
        decisionId: input.decisionId,
        wallet: WALLET_SELECTION,
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "100000000000000000",
        withdrawalAmountWei: "110000000000000000",
        feeReserveWei: "10000000000000000",
        remainingPrivateBalanceEstimateWei: "0",
        scope: "single_tornado_denomination" as const,
        feeModel: "reserved_from_wallet_controlled_remainder" as const,
        phase: "submitted",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
    async getRecoveryRequest() {
      return {
        version: 1,
        requestId: "wrr_12345678",
        clientRequestId: "hermes:wr_12345678",
        decisionId: "wr_12345678",
        wallet: WALLET_SELECTION,
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "100000000000000000",
        withdrawalAmountWei: "110000000000000000",
        feeReserveWei: "10000000000000000",
        remainingPrivateBalanceEstimateWei: "0",
        scope: "single_tornado_denomination" as const,
        feeModel: "reserved_from_wallet_controlled_remainder" as const,
        phase: "submitted" as const,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
    async egressCapabilities() {
      return {
        contract: "org.agentboost.egress/0.1",
        mode: "explicit_fetch",
        policy: { direct_fallback: false },
      };
    },
    async egressStatus() {
      return {
        status: "ready",
        code: "SHADE_TREE_READY",
        detail: "Covered HTTPS egress is ready",
        direct_fallback: false,
      };
    },
    async egressFetch(input) {
      return {
        status: 200,
        finalUrl: input.url,
        contentType: "application/json",
        body: '{"hello":"world"}',
        bytes: 17,
        redirects: 0,
        route: "shade-tree" as const,
      };
    },
    async startNewDemo() {
      return {
        archiveId: "archive_12345678",
        previousSetupId: "setup_old1234",
        previousRequestCount: 1,
        record: setup,
        snapshot: setup,
        uiOpened: true,
      };
    },
  };
}

test("MCP discovery precedes runtime readiness while every handler stays gated", async () => {
  const runtime = fakeRuntime();
  const readiness = deferred<void>();
  let capabilityCalls = 0;
  let egressCapabilityCalls = 0;
  let policyReadCalls = 0;
  let reauthorizationPlanCalls = 0;
  let reauthorizationApplyCalls = 0;
  const originalCapabilities = runtime.capabilities.bind(runtime);
  const originalEgressCapabilities = runtime.egressCapabilities.bind(runtime);
  const originalWalletPolicy = runtime.walletPolicy.bind(runtime);
  const originalReauthorizationPlan = runtime.getWalletReauthorizationPlan.bind(
    runtime,
  );
  const originalReauthorizationApply = runtime.reauthorizeWallet.bind(runtime);
  runtime.capabilities = async () => {
    capabilityCalls += 1;
    return originalCapabilities();
  };
  runtime.egressCapabilities = async () => {
    egressCapabilityCalls += 1;
    return originalEgressCapabilities();
  };
  runtime.walletPolicy = async (input) => {
    policyReadCalls += 1;
    return originalWalletPolicy(input);
  };
  runtime.getWalletReauthorizationPlan = async (decisionId) => {
    reauthorizationPlanCalls += 1;
    return originalReauthorizationPlan(decisionId);
  };
  runtime.reauthorizeWallet = async (input) => {
    reauthorizationApplyCalls += 1;
    return originalReauthorizationApply(input);
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime, {
    runtimeReady: readiness.promise,
  });
  const client = testMcpClient(new Client({
    name: "registration-first-test",
    version: "1.0.0",
  }));
  const pendingCalls: Array<Promise<unknown>> = [];
  try {
    await within(
      Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]),
      500,
      "MCP connect before runtime readiness",
    );
    const tools = await within(
      client.listTools(),
      500,
      "MCP tool discovery before runtime readiness",
    );
    const resources = await within(
      client.listResources(),
      500,
      "MCP resource discovery before runtime readiness",
    );
    assert.equal(tools.tools.length, 54);
    assert.equal(resources.resources.length, 2);
    assert.ok(
      tools.tools.some((tool) => tool.name === "wallet_apply_reauthorization"),
    );
    assert.equal(capabilityCalls, 0);
    assert.equal(egressCapabilityCalls, 0);

    let settledCalls = 0;
    const track = <T>(promise: Promise<T>): Promise<T> => {
      const tracked = promise.finally(() => {
        settledCalls += 1;
      });
      pendingCalls.push(tracked);
      return tracked;
    };
    const mutation = track(client.callTool({
      name: "wallet_apply_reauthorization",
      arguments: {
        decision_id: "wra_12345678",
        user_confirmed: true,
      },
    }));
    const read = track(client.callTool({
      name: "wallet_get_policy",
      arguments: {},
    }));
    const resource = track(client.readResource({
      uri: "agent-boost://capabilities/wallet/v1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settledCalls, 0);
    assert.equal(policyReadCalls, 0);
    assert.equal(reauthorizationPlanCalls, 0);
    assert.equal(reauthorizationApplyCalls, 0);
    assert.equal(capabilityCalls, 0);

    readiness.resolve(undefined);
    const [mutationResult, readResult, resourceResult] = await Promise.all([
      mutation,
      read,
      resource,
    ]);
    assert.equal(
      (mutationResult.structuredContent as { code: string }).code,
      "WALLET_REAUTHORIZED",
    );
    assert.equal(
      (readResult.structuredContent as { code: string }).code,
      "WALLET_POLICY",
    );
    assert.equal(resourceResult.contents.length, 1);
    const resourcePayload = JSON.parse(
      "text" in resourceResult.contents[0]!
        ? resourceResult.contents[0]!.text
        : "{}",
    ) as { manifest_digest?: string };
    const { readiness: _readiness, ...expectedManifest } = await originalCapabilities();
    const expectedDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify(expectedManifest))
      .digest("hex")}`;
    assert.equal(resourcePayload.manifest_digest, expectedDigest);
    assert.equal(settledCalls, 3);
    assert.equal(policyReadCalls, 1);
    assert.equal(reauthorizationPlanCalls, 1);
    assert.equal(reauthorizationApplyCalls, 1);
    assert.equal(capabilityCalls, 2);
    assert.equal(egressCapabilityCalls, 1);
  } finally {
    readiness.resolve(undefined);
    await Promise.allSettled(pendingCalls);
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test("rejected MCP runtime readiness cannot enter a registered handler", async () => {
  const runtime = fakeRuntime();
  const readiness = deferred<void>();
  let policyReadCalls = 0;
  const originalWalletPolicy = runtime.walletPolicy.bind(runtime);
  runtime.walletPolicy = async (input) => {
    policyReadCalls += 1;
    return originalWalletPolicy(input);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime, {
    runtimeReady: readiness.promise,
  });
  const client = testMcpClient(new Client({
    name: "registration-failure-test",
    version: "1.0.0",
  }));
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "wallet_get_policy"));
    const call = client.callTool({
      name: "wallet_get_policy",
      arguments: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(policyReadCalls, 0);
    readiness.reject(new Error("controlled runtime startup failure"));
    const outcome = await call.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    assert.ok(
      outcome.error !== undefined || outcome.value?.isError === true,
      "a rejected readiness barrier must fail the pending MCP call",
    );
    assert.equal(policyReadCalls, 0);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test("MCP transport connects before its deferred runtime initializer completes", async () => {
  const runtime = fakeRuntime();
  const initialization = deferred<void>();
  let initializerCalls = 0;
  let capabilityCalls = 0;
  let egressCapabilityCalls = 0;
  let policyReadCalls = 0;
  const originalCapabilities = runtime.capabilities.bind(runtime);
  const originalEgressCapabilities = runtime.egressCapabilities.bind(runtime);
  const originalWalletPolicy = runtime.walletPolicy.bind(runtime);
  runtime.capabilities = async () => {
    capabilityCalls += 1;
    return originalCapabilities();
  };
  runtime.egressCapabilities = async () => {
    egressCapabilityCalls += 1;
    return originalEgressCapabilities();
  };
  runtime.walletPolicy = async (input) => {
    policyReadCalls += 1;
    return originalWalletPolicy(input);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = testMcpClient(new Client({
    name: "transport-registration-first-test",
    version: "1.0.0",
  }));
  const running = runMcpTransport(runtime, serverTransport, async () => {
    initializerCalls += 1;
    await initialization.promise;
  });
  try {
    await within(
      client.connect(clientTransport),
      500,
      "MCP client connect before runtime initialization",
    );
    assert.equal(initializerCalls, 1);
    const tools = await within(
      client.listTools(),
      500,
      "MCP discovery during runtime initialization",
    );
    assert.ok(tools.tools.some((tool) => tool.name === "wallet_get_policy"));
    assert.equal(capabilityCalls, 0);
    assert.equal(egressCapabilityCalls, 0);

    const policyRead = client.callTool({
      name: "wallet_get_policy",
      arguments: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(policyReadCalls, 0);

    initialization.resolve(undefined);
    const policyResult = await within(
      policyRead,
      500,
      "MCP handler after runtime initialization",
    );
    assert.equal(
      (policyResult.structuredContent as { code: string }).code,
      "WALLET_POLICY",
    );
    assert.match(
      (policyResult.structuredContent as { manifest_digest?: string })
        .manifest_digest ?? "",
      /^sha256:[0-9a-f]{64}$/u,
    );
    assert.equal(initializerCalls, 1);
    assert.equal(capabilityCalls, 1);
    assert.equal(egressCapabilityCalls, 1);
    assert.equal(policyReadCalls, 1);

    await client.close();
    await within(running, 500, "MCP runner shutdown after client close");
  } finally {
    initialization.resolve(undefined);
    await client.close().catch(() => undefined);
    await running.catch(() => undefined);
  }
});

test("MCP runner rejects startup and closes without entering pending handlers", async () => {
  const runtime = fakeRuntime();
  const initialization = deferred<void>();
  const startupError = new Error("controlled runtime startup failure");
  let policyReadCalls = 0;
  const originalWalletPolicy = runtime.walletPolicy.bind(runtime);
  runtime.walletPolicy = async (input) => {
    policyReadCalls += 1;
    return originalWalletPolicy(input);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = testMcpClient(new Client({
    name: "transport-startup-failure-test",
    version: "1.0.0",
  }));
  const running = runMcpTransport(runtime, serverTransport, async () => {
    await initialization.promise;
  });
  const runnerFailure = assert.rejects(
    running,
    (error: unknown) => error === startupError,
  );
  try {
    await within(
      client.connect(clientTransport),
      500,
      "MCP client connect before rejected runtime initialization",
    );
    const tools = await within(
      client.listTools(),
      500,
      "MCP discovery before rejected runtime initialization",
    );
    assert.ok(tools.tools.some((tool) => tool.name === "wallet_get_policy"));

    const pendingPolicyRead = client.callTool({
      name: "wallet_get_policy",
      arguments: {},
    });
    const pendingOutcome = pendingPolicyRead.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(policyReadCalls, 0);

    initialization.reject(startupError);
    await within(runnerFailure, 500, "MCP runner startup rejection");
    const outcome = await within(
      pendingOutcome,
      500,
      "pending MCP handler startup rejection",
    );
    assert.ok(
      outcome.error !== undefined || outcome.value?.isError === true,
      "the pending handler must fail when runtime startup rejects",
    );
    assert.equal(policyReadCalls, 0);
    await assert.rejects(client.listTools());
    await assert.rejects(clientTransport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }));
  } finally {
    initialization.reject(startupError);
    await client.close().catch(() => undefined);
    await running.catch(() => undefined);
  }
});

test("MCP disconnect during startup cancels queued mutations before safe shutdown", async () => {
  const runtime = fakeRuntime();
  const initialization = deferred<void>();
  let reauthorizationPlanCalls = 0;
  let reauthorizationApplyCalls = 0;
  const originalReauthorizationPlan = runtime.getWalletReauthorizationPlan.bind(
    runtime,
  );
  const originalReauthorizationApply = runtime.reauthorizeWallet.bind(runtime);
  runtime.getWalletReauthorizationPlan = async (decisionId) => {
    reauthorizationPlanCalls += 1;
    return originalReauthorizationPlan(decisionId);
  };
  runtime.reauthorizeWallet = async (input) => {
    reauthorizationApplyCalls += 1;
    return originalReauthorizationApply(input);
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = testMcpClient(new Client({
    name: "transport-startup-disconnect-test",
    version: "1.0.0",
  }));
  const running = runMcpTransport(runtime, serverTransport, async () => {
    await initialization.promise;
  });
  let runnerSettled = false;
  const observedRunning = running.finally(() => {
    runnerSettled = true;
  });
  try {
    await within(
      client.connect(clientTransport),
      500,
      "MCP client connect before startup disconnect",
    );
    const tools = await within(
      client.listTools(),
      500,
      "MCP discovery before startup disconnect",
    );
    assert.ok(
      tools.tools.some((tool) => tool.name === "wallet_apply_reauthorization"),
    );

    const mutation = client.callTool({
      name: "wallet_apply_reauthorization",
      arguments: {
        decision_id: "wra_12345678",
        user_confirmed: true,
      },
    });
    const mutationOutcome = mutation.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reauthorizationPlanCalls, 0);
    assert.equal(reauthorizationApplyCalls, 0);

    await client.close();
    const outcome = await within(
      mutationOutcome,
      500,
      "queued MCP mutation rejection after startup disconnect",
    );
    assert.ok(
      outcome.error !== undefined || outcome.value?.isError === true,
      "the disconnected client must not receive a successful mutation result",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runnerSettled, false, "startup must settle before runtime shutdown");
    assert.equal(reauthorizationPlanCalls, 0);
    assert.equal(reauthorizationApplyCalls, 0);

    initialization.resolve(undefined);
    await within(observedRunning, 500, "MCP runner after disconnected startup settles");
    assert.equal(reauthorizationPlanCalls, 0);
    assert.equal(reauthorizationApplyCalls, 0);
  } finally {
    initialization.resolve(undefined);
    await client.close().catch(() => undefined);
    await observedRunning.catch(() => undefined);
  }
});

test("MCP abort during manifest loading never enters the queued mutation", async () => {
  const runtime = fakeRuntime();
  const digestStarted = deferred<void>();
  const releaseDigest = deferred<void>();
  let capabilityCalls = 0;
  let reauthorizationPlanCalls = 0;
  let reauthorizationApplyCalls = 0;
  const originalCapabilities = runtime.capabilities.bind(runtime);
  const originalReauthorizationPlan = runtime.getWalletReauthorizationPlan.bind(
    runtime,
  );
  const originalReauthorizationApply = runtime.reauthorizeWallet.bind(runtime);
  runtime.capabilities = async () => {
    capabilityCalls += 1;
    digestStarted.resolve(undefined);
    await releaseDigest.promise;
    return originalCapabilities();
  };
  runtime.getWalletReauthorizationPlan = async (decisionId) => {
    reauthorizationPlanCalls += 1;
    return originalReauthorizationPlan(decisionId);
  };
  runtime.reauthorizeWallet = async (input) => {
    reauthorizationApplyCalls += 1;
    return originalReauthorizationApply(input);
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = testMcpClient(new Client({
    name: "transport-manifest-abort-test",
    version: "1.0.0",
  }));
  const running = runMcpTransport(runtime, serverTransport, async () => undefined);
  let runnerSettled = false;
  const observedRunning = running.finally(() => {
    runnerSettled = true;
  });
  try {
    await within(client.connect(clientTransport), 500, "MCP client connect");
    await within(
      digestStarted.promise,
      500,
      "manifest loading after runtime initialization",
    );
    const mutation = client.callTool({
      name: "wallet_apply_reauthorization",
      arguments: {
        decision_id: "wra_12345678",
        user_confirmed: true,
      },
    });
    const mutationOutcome = mutation.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(capabilityCalls, 1);
    assert.equal(reauthorizationPlanCalls, 0);
    assert.equal(reauthorizationApplyCalls, 0);

    await client.close();
    const outcome = await within(
      mutationOutcome,
      500,
      "queued MCP mutation rejection during manifest loading",
    );
    assert.ok(
      outcome.error !== undefined || outcome.value?.isError === true,
      "an aborted queued mutation must not report success",
    );
    assert.equal(runnerSettled, false, "manifest reads must settle before shutdown");

    releaseDigest.resolve(undefined);
    await within(observedRunning, 500, "MCP runner after manifest loading settles");
    assert.equal(capabilityCalls, 1);
    assert.equal(reauthorizationPlanCalls, 0);
    assert.equal(reauthorizationApplyCalls, 0);
  } finally {
    releaseDigest.resolve(undefined);
    await client.close().catch(() => undefined);
    await observedRunning.catch(() => undefined);
  }
});

test("wallet discovery separates live trees from saved-profile management", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(fakeRuntime());
  const client = testMcpClient(new Client(
    { name: "wallet-routing-contract-test", version: "1.0.0" },
  ));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = await client.listTools();
    const treeDescription = tools.tools.find(
      (tool) => tool.name === "wallet_get_tree",
    )?.description ?? "";
    const savedDescription = tools.tools.find(
      (tool) => tool.name === "wallet_list_saved_profiles",
    )?.description ?? "";

    assert.ok(treeDescription.length <= 400);
    assert.match(treeDescription, /overview, map, hierarchy/u);
    assert.match(treeDescription, /not for any send, transfer/u);
    assert.match(treeDescription, /One successful call completes the request/u);
    assert.doesNotMatch(
      treeDescription,
      /load|switch|select|adopt|archive|authorization/iu,
    );

    assert.ok(savedDescription.length <= 400);
    assert.match(savedDescription, /explicit inventory/u);
    assert.match(savedDescription, /Any standalone load request/u);
    assert.match(savedDescription, /Never call before or during a transfer/u);
    assert.doesNotMatch(savedDescription, /balance|tree|overview|subwallet/iu);

    const tree = await client.callTool({ name: "wallet_get_tree", arguments: {} });
    const modelContext = tree._meta?.[HERMES_MODEL_CONTEXT_KEY] as {
      instruction: string;
    };
    assert.match(modelContext.instruction, /SUCCESS — STOP TOOL USE/iu);
    assert.match(modelContext.instruction, /never call or retry another tool/iu);
    assert.deepEqual(tree._meta?.["org.agentboost/turn-control"], {
      schema_version: 1,
      boundary: "new_user_turn",
      rendered_response: (tree.structuredContent as { data: { rendered: string } }).data.rendered,
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP exposes wallet-first tools and structured onboarding", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(fakeRuntime());
  const client = testMcpClient(new Client({ name: "test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "capabilities",
      "egress_capabilities",
      "egress_fetch",
      "egress_status",
      "onboarding_start",
      "onboarding_status",
      "trade_capabilities",
      "trade_execute",
      "trade_get_request",
      "trade_plan",
      "wallet_adopt_existing",
      "wallet_apply_policy_update",
      "wallet_apply_private_balance_create",
      "wallet_apply_private_balance_fund",
      "wallet_apply_private_balance_policy_update",
      "wallet_apply_reauthorization",
      "wallet_apply_saved_profile_load",
      "wallet_archive",
      "wallet_create",
      "wallet_execute_private_payment",
      "wallet_execute_private_transfer",
      "wallet_execute_recovery_transfer",
      "wallet_execute_regular_transfer",
      "wallet_get_context",
      "wallet_get_main_balance",
      "wallet_get_policy",
      "wallet_get_private_balance_operation",
      "wallet_get_private_balance_policy",
      "wallet_get_private_payment_request",
      "wallet_get_private_transfer_request",
      "wallet_get_recovery_request",
      "wallet_get_regular_transfer_request",
      "wallet_get_request",
      "wallet_get_saved_profiles",
      "wallet_get_tree",
      "wallet_list",
      "wallet_list_saved_profiles",
      "wallet_manage_profiles",
      "wallet_plan_policy_update",
      "wallet_plan_private_payment",
      "wallet_plan_reauthorization",
      "wallet_plan_recovery_transfer",
      "wallet_plan_regular_transfer",
      "wallet_preview_private_balance_create",
      "wallet_preview_private_balance_fund",
      "wallet_preview_private_balance_policy_update",
      "wallet_preview_private_transfer",
      "wallet_preview_recovery_transfer",
      "wallet_preview_regular_transfer",
      "wallet_preview_saved_profile_load",
      "wallet_reauthorize",
      "wallet_select",
      "wallet_start_new_demo",
      "wallet_switch_saved_profile",
    ],
  );
  const statefulNonDestructiveTools = [
    "wallet_get_main_balance",
    "wallet_get_context",
    "wallet_get_tree",
    "wallet_preview_private_balance_create",
    "wallet_preview_private_balance_fund",
    "wallet_get_private_balance_operation",
    "wallet_preview_private_balance_policy_update",
    "wallet_plan_reauthorization",
    "wallet_preview_regular_transfer",
    "wallet_plan_regular_transfer",
    "wallet_get_regular_transfer_request",
    "wallet_preview_private_transfer",
    "wallet_plan_private_payment",
    "wallet_get_private_transfer_request",
    "wallet_get_private_payment_request",
    "wallet_get_request",
    "wallet_preview_recovery_transfer",
    "wallet_plan_recovery_transfer",
    "wallet_get_recovery_request",
  ];
  for (const name of statefulNonDestructiveTools) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is present`);
    assert.equal(
      tool.annotations?.readOnlyHint,
      false,
      `${name} never advertises durable planning, profile loading, balance refresh, or receipt reconciliation as read-only`,
    );
    assert.equal(
      tool.annotations?.destructiveHint,
      false,
      `${name} truthfully remains non-destructive`,
    );
  }
  for (const name of [
    "capabilities",
    "trade_execute",
    "wallet_list_saved_profiles",
    "wallet_preview_saved_profile_load",
    "wallet_get_policy",
    "wallet_get_private_balance_policy",
  ]) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is present`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${name} stays read-only`);
  }
  for (const name of [
    "wallet_adopt_existing",
    "wallet_apply_saved_profile_load",
    "wallet_switch_saved_profile",
    "wallet_select",
  ]) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is present`);
    assert.equal(
      tool.annotations?.openWorldHint,
      true,
      `${name} advertises that an approved load can resume Sepolia onboarding`,
    );
  }
  for (const name of [
    "onboarding_start",
    "wallet_create",
    "wallet_apply_private_balance_create",
    "wallet_apply_private_balance_fund",
    "wallet_get_private_balance_operation",
  ]) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is present`);
    assert.equal(
      tool.annotations?.openWorldHint,
      true,
      `${name} advertises its possible wallet, RPC, or reconciliation interaction`,
    );
  }
  assert.equal(
    tools.tools.find((candidate) =>
      candidate.name === "wallet_apply_private_balance_policy_update"
    )?.annotations?.openWorldHint,
    false,
    "applying a private-balance policy remains a local state update",
  );
  assert.equal(
    tools.tools.find((candidate) =>
      candidate.name === "wallet_get_private_balance_policy"
    )?.annotations?.openWorldHint,
    false,
    "reading an exact private-balance policy remains local and selection-free",
  );
  assert.equal(
    tools.tools.find((candidate) => candidate.name === "trade_execute")
      ?.annotations?.destructiveHint ?? false,
    false,
    "the unconfigured trade execution placeholder is not destructive",
  );
  assert.equal(
    tools.tools.find((candidate) => candidate.name === "wallet_preview_saved_profile_load")
      ?.annotations?.openWorldHint,
    false,
    "the standalone saved-profile preview remains local-only",
  );
  const catalogPrefixes = new Map([
    ["wallet_get_main_balance", "Read the selected main account's live"],
    ["wallet_list_saved_profiles", "List saved Agent Boost profiles only for"],
    ["wallet_get_tree", "Show every Agent Boost wallet, balance, and exact policy as a tree"],
    ["wallet_preview_private_balance_create", "Start creation of one named, persistent private balance"],
    ["wallet_apply_private_balance_create", "Apply or cancel exactly one wallet_preview_private_balance_create"],
    ["wallet_preview_private_balance_fund", "Start funding one named private balance"],
    ["wallet_apply_private_balance_fund", "Apply or cancel exactly one wallet_preview_private_balance_fund"],
    ["wallet_get_private_balance_operation", "Read the authoritative status of a known private-balance creation"],
    ["wallet_get_private_balance_policy", "Read the current send policy and remaining allowance"],
    ["wallet_preview_private_balance_policy_update", "Preview a policy change for exactly one named private balance"],
    ["wallet_apply_private_balance_policy_update", "Apply or cancel exactly one wallet_preview_private_balance_policy_update"],
    ["wallet_create", "Use only when the user explicitly asks to create a new wallet"],
    ["wallet_adopt_existing", "Adopt one safe local Kohaku wallet discovered"],
    ["wallet_preview_saved_profile_load", "Start a standalone request to load a saved wallet"],
    ["wallet_apply_saved_profile_load", "Use only after a later user turn approves or rejects"],
    ["wallet_archive", "Archive one inactive saved profile"],
    ["wallet_plan_reauthorization", "Fallback/manual preview for fresh transfer authority"],
    ["wallet_apply_reauthorization", "Approve or cancel the exact wallet reauthorization"],
    ["wallet_get_policy", "Read one parent wallet's regular/private transfer permission"],
    ["wallet_plan_policy_update", "Preview a new parent-wallet permission change"],
    ["wallet_apply_policy_update", "Approve, reject, or cancel the exact wallet permission preview"],
    ["wallet_start_new_demo", "Start-over tool for an explicitly requested fresh demo wallet"],
    ["wallet_preview_regular_transfer", "Start an explicit regular/public transfer"],
    ["wallet_plan_regular_transfer", "Compatibility alias for a regular/public transfer"],
    ["wallet_execute_regular_transfer", "Apply or cancel the exact regular-transfer preview"],
    ["wallet_preview_private_transfer", "Start one explicitly private/shielded transfer"],
    ["wallet_execute_private_transfer", "Apply or cancel the exact private-transfer preview"],
    ["wallet_get_private_transfer_request", "Read a known private transfer request's current status"],
    ["wallet_preview_recovery_transfer", "Start one explicit recovery/unshield transfer"],
    ["wallet_execute_recovery_transfer", "Apply or cancel the exact recovery-transfer preview"],
  ]);
  for (const [name, prefix] of catalogPrefixes) {
    const description = tools.tools.find((tool) => tool.name === name)?.description ?? "";
    assert.match(description, new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
    assert.doesNotMatch(
      description.slice(0, 60),
      /^(?:REQUEST-TURN TOOL|CONFIRMATION-TURN TOOL|WALLET OVERVIEW FAST PATH|SAVED-PROFILE MANAGEMENT)/u,
      `${name} has a discriminative 60-character catalog stub`,
    );
  }
  for (const tool of tools.tools) {
    assert.doesNotMatch(
      tool.description ?? "",
      FORBIDDEN_CONFIRMATION_SURFACE_VOCABULARY,
      `${tool.name} avoids confirmation-surface negative priming`,
    );
  }
  const walletContextTool = tools.tools.find(
    (tool) => tool.name === "wallet_get_main_balance",
  );
  assert.match(walletContextTool?.description ?? "", /same turn/u);
  assert.match(walletContextTool?.description ?? "", /Wallet overviews belong to wallet_get_tree/u);
  assert.match(
    walletContextTool?.description ?? "",
    /Transfer planners refresh spendability themselves/u,
  );
  assert.match(
    walletContextTool?.description ?? "",
    /without converting balance_atomic/u,
  );
  assert.match(walletContextTool?.description ?? "", /pass amount_native/u);
  const legacyWalletContextTool = tools.tools.find(
    (tool) => tool.name === "wallet_get_context",
  );
  assert.match(legacyWalletContextTool?.description ?? "", /Compatibility alias/u);
  assert.match(legacyWalletContextTool?.description ?? "", /wallet_get_main_balance/u);
  const privateRequestStatusTool = tools.tools.find(
    (tool) => tool.name === "wallet_get_private_transfer_request",
  );
  assert.match(privateRequestStatusTool?.description ?? "", /private transfer/u);
  assert.match(privateRequestStatusTool?.description ?? "", /wallet_execute_private_transfer/u);
  const legacyPrivateRequestStatusName = tools.tools.find(
    (tool) => tool.name === "wallet_get_private_payment_request",
  );
  assert.match(
    legacyPrivateRequestStatusName?.description ?? "",
    /Compatibility alias[\s\S]*wallet_get_private_transfer_request/u,
  );
  const legacyPrivateRequestStatusTool = tools.tools.find(
    (tool) => tool.name === "wallet_get_request",
  );
  assert.match(legacyPrivateRequestStatusTool?.description ?? "", /Compatibility alias/u);
  assert.match(
    legacyPrivateRequestStatusTool?.description ?? "",
    /wallet_get_private_transfer_request/u,
  );
  const walletTreeTool = tools.tools.find(
    (tool) => tool.name === "wallet_get_tree",
  );
  const walletTreeDescription = walletTreeTool?.description ?? "";
  const walletTreeSearchDescription = walletTreeDescription.slice(0, 400);
  assert.match(
    walletTreeDescription,
    /^Show every Agent Boost wallet, balance, and exact policy as a tree\./u,
  );
  assert.match(walletTreeDescription, /overview, map, hierarchy/u);
  assert.match(walletTreeDescription, /One successful call completes the request/u);
  assert.match(walletTreeDescription, /end the turn/u);
  assert.ok(walletTreeDescription.length <= 400, "tree routing contract fits Hermes search excerpt");
  assert.doesNotMatch(walletTreeDescription, /load|switch|select|adopt|archive|authorization/iu);
  assert.match(walletTreeTool?.description ?? "", /copy the returned text byte-for-byte/u);
  const walletManagementTool = tools.tools.find(
    (tool) => tool.name === "wallet_list_saved_profiles",
  );
  assert.match(walletManagementTool?.description ?? "", /^List saved Agent Boost profiles only for/u);
  assert.match(walletManagementTool?.description ?? "", /Any standalone load request/u);
  assert.match(walletManagementTool?.description ?? "", /matching transfer preview/u);
  assert.ok(
    (walletManagementTool?.description ?? "").length <= 400,
    "saved-profile routing contract fits Hermes search excerpt",
  );
  assert.doesNotMatch(
    walletManagementTool?.description ?? "",
    /balance|tree|overview|subwallet/iu,
  );
  const legacyWalletManagementTool = tools.tools.find(
    (tool) => tool.name === "wallet_manage_profiles",
  );
  assert.match(legacyWalletManagementTool?.description ?? "", /Compatibility alias/u);
  assert.match(legacyWalletManagementTool?.description ?? "", /wallet_list_saved_profiles/u);
  const legacyWalletListTool = tools.tools.find(
    (tool) => tool.name === "wallet_list",
  );
  assert.match(legacyWalletListTool?.description ?? "", /Compatibility alias/u);
  assert.match(legacyWalletListTool?.description ?? "", /wallet_list_saved_profiles/u);
  const walletSwitchTool = tools.tools.find(
    (tool) => tool.name === "wallet_preview_saved_profile_load",
  );
  assert.match(
    walletSwitchTool?.description ?? "",
    /^Start a standalone request to load a saved wallet/u,
  );
  assert.ok(
    (walletSwitchTool?.description ?? "").length <= 600,
    "saved-profile switch routing contract fits Hermes search excerpt",
  );
  assert.match(walletSwitchTool?.description ?? "", /later user message/u);
  assert.match(
    walletSwitchTool?.description ?? "",
    /wallet_apply_saved_profile_load/u,
  );
  assert.match(
    walletSwitchTool?.description ?? "",
    /user's wording in wallet_name[\s\S]*lists and resolves/iu,
  );
  assert.match(walletSwitchTool?.description ?? "", /my old wallet/u);
  assert.match(walletSwitchTool?.description ?? "", /Never call before or during a transfer/u);
  const legacyWalletSwitchTool = tools.tools.find(
    (tool) => tool.name === "wallet_switch_saved_profile",
  );
  assert.match(legacyWalletSwitchTool?.description ?? "", /Compatibility alias/u);
  assert.match(legacyWalletSwitchTool?.description ?? "", /wallet_preview_saved_profile_load/u);
  assert.match(legacyWalletSwitchTool?.description ?? "", /wallet_apply_saved_profile_load/u);
  const legacyWalletSelectTool = tools.tools.find(
    (tool) => tool.name === "wallet_select",
  );
  assert.match(legacyWalletSelectTool?.description ?? "", /Compatibility alias/u);
  assert.match(legacyWalletSelectTool?.description ?? "", /wallet_preview_saved_profile_load/u);
  assert.match(legacyWalletSelectTool?.description ?? "", /wallet_apply_saved_profile_load/u);
  const walletApplyReauthorizationTool = tools.tools.find(
    (tool) => tool.name === "wallet_apply_reauthorization",
  );
  assert.match(
    walletApplyReauthorizationTool?.description ?? "",
    /^Approve or cancel the exact wallet reauthorization preview/u,
  );
  assert.match(
    walletApplyReauthorizationTool?.description ?? "",
    /wallet_plan_reauthorization/u,
  );
  assert.ok(
    (walletApplyReauthorizationTool?.description ?? "").length <= 400,
    "reauthorization apply routing contract fits Hermes search excerpt",
  );
  const legacyWalletReauthorizationTool = tools.tools.find(
    (tool) => tool.name === "wallet_reauthorize",
  );
  assert.match(legacyWalletReauthorizationTool?.description ?? "", /Compatibility alias/u);
  assert.match(
    legacyWalletReauthorizationTool?.description ?? "",
    /wallet_apply_reauthorization/u,
  );
  const egressStatus = await client.callTool({ name: "egress_status", arguments: {} });
  assert.equal(
    (egressStatus.structuredContent as { data: { status: string } }).data.status,
    "ready",
  );
  assert.doesNotMatch(JSON.stringify(egressStatus), /token|member leaf|\.onion/iu);
  const fetched = await client.callTool({
    name: "egress_fetch",
    arguments: { url: "https://example.com/data.json" },
  });
  const fetchedData = (fetched.structuredContent as {
    data: Record<string, unknown>;
  }).data;
  assert.equal(fetchedData.route, "shade-tree");
  assert.equal(fetchedData.content_trust, "untrusted_external");
  assert.equal(fetchedData.direct_fallback, false);
  const started = await client.callTool({ name: "onboarding_start", arguments: {} });
  assert.equal(started.isError, undefined);
  assert.equal(
    (started.structuredContent as { outcome: string }).outcome,
    "awaiting_funding",
  );
  const startPayload = started.structuredContent as {
    data: {
      setup: Record<string, unknown>;
      public: Record<string, unknown>;
      funding: Record<string, unknown>;
      ui_opened: boolean;
    };
  };
  assert.deepEqual(startPayload.data.funding, {
    chain_id: "eip155:11155111",
    network: "Sepolia",
    asset: "Sepolia ETH",
    address: "0x1111111111111111111111111111111111111111",
    funding_uri:
      "ethereum:0x1111111111111111111111111111111111111111@11155111?value=150000000000000000",
    remaining_amount_wei: "150000000000000000",
    remaining_amount_eth: "0.15",
    qr_attached: true,
  });
  assert.equal(startPayload.data.ui_opened, true);
  assert.equal(startPayload.data.setup.uiUrl, undefined);
  assert.equal(startPayload.data.setup.uiOpened, undefined);
  assert.equal(startPayload.data.public.uiUrl, undefined);
  assert.equal(started.content.some((block) => block.type === "image"), true);
  const startText = started.content.find((block) => block.type === "text");
  assert.equal(startText?.type, "text");
  assert.match(startText?.type === "text" ? startText.text : "", /reply ✅ or say sent/u);
  assert.doesNotMatch(startText?.type === "text" ? startText.text : "", /manifest_digest|setupId/u);
  assert.doesNotMatch(JSON.stringify(started), /127\.0\.0\.1|uiUrl/u);

  const reset = await client.callTool({
    name: "wallet_start_new_demo",
    arguments: {
      expected_active_wallet_name: "agent-boost",
      expected_active_selection_epoch: 1,
      user_confirmed: true,
    },
  });
  const resetPayload = reset.structuredContent as {
    data: { archive_id: string; previous_request_count: number };
  };
  assert.equal(resetPayload.data.archive_id, "archive_12345678");
  assert.equal(resetPayload.data.previous_request_count, 1);

  const status = await client.callTool({
    name: "onboarding_status",
    arguments: { setup_id: "setup_12345678" },
  });
  const statusPayload = status.structuredContent as {
    data: { setup: Record<string, unknown>; funding: Record<string, unknown> };
  };
  assert.equal(statusPayload.data.setup.uiUrl, undefined);
  assert.equal(statusPayload.data.funding.remaining_amount_eth, "0.15");
  assert.equal(statusPayload.data.funding.qr_attached, false);
  assert.doesNotMatch(JSON.stringify(status), /127\.0\.0\.1|uiUrl/u);

  const walletContext = await client.callTool({
    name: "wallet_get_main_balance",
    arguments: {},
  });
  const legacyWalletContext = await client.callTool({
    name: "wallet_get_context",
    arguments: {},
  });
  assert.deepEqual(legacyWalletContext.structuredContent, walletContext.structuredContent);
  assert.deepEqual(legacyWalletContext.content, walletContext.content);
  const walletData = (walletContext.structuredContent as {
    data: {
      account_role: string;
      controls_subaccounts: boolean;
      address: string;
      balance_atomic: string;
    };
  }).data;
  assert.equal(walletData.account_role, "main_funding_source");
  assert.equal(walletData.controls_subaccounts, false);
  assert.equal(walletData.address, WALLET_ADDRESS);
  assert.equal(walletData.balance_atomic, "1500000000000000000");
  const walletText = walletContext.content.find((block) => block.type === "text");
  assert.match(
    walletText?.type === "text" ? walletText.text : "",
    /quote exactly: Main account balance: 1\.5 Sepolia ETH/iu,
  );
  assert.match(
    walletText?.type === "text" ? walletText.text : "",
    /wallets plural[\s\S]*call wallet_get_tree now/u,
  );
  assert.doesNotMatch(
    walletText?.type === "text" ? walletText.text : "",
    new RegExp(WALLET_ADDRESS, "u"),
  );
  assert.match(
    walletText?.type === "text" ? walletText.text : "",
    /Main.*funding source.*no control over subaccounts/u,
  );
  assert.doesNotMatch(
    walletText?.type === "text" ? walletText.text : "",
    /funding address|public \+|private balance|spendable total/u,
  );
  assert.match(
    walletText?.type === "text" ? walletText.text : "",
    /This read alone never authorizes a send/u,
  );
  assert.equal(
    authoritativeOutput(walletContext),
    "**Main account**\n- Balance: 1.5 Sepolia ETH",
  );

  const affordabilityContext = await client.callTool({
    name: "wallet_get_main_balance",
    arguments: { amount_native: "2" },
  });
  const affordabilityData = (affordabilityContext.structuredContent as {
    data: {
      affordability_check: {
        requested_amount_native: string;
        main_account_covers_requested: boolean;
        private_payment_spendability: string;
        can_send_private_payment: string;
      };
    };
  }).data.affordability_check;
  assert.deepEqual(affordabilityData, {
    requested_amount_native: "2",
    main_account_covers_requested: false,
    private_payment_spendability: "not_checked_requires_recipient_and_plan",
    can_send_private_payment: "unknown",
  });
  const affordabilityText = affordabilityContext.content.find(
    (block) => block.type === "text",
  );
  assert.match(
    affordabilityText?.type === "text" ? affordabilityText.text : "",
    /requested 2 Sepolia ETH exceeds the main account balance/u,
  );
  assert.match(
    authoritativeOutput(affordabilityContext) ?? "",
    /Balance: 1\.5 Sepolia ETH[\s\S]*2 Sepolia ETH exceeds/u,
  );

  const walletTree = await client.callTool({
    name: "wallet_get_tree",
    arguments: {},
  });
  const walletTreeData = (walletTree.structuredContent as {
    data: {
      rendered: string;
      addresses_included: boolean;
      raw_atomic_values_included: boolean;
      archived_profiles_hidden: number;
      profiles: Array<{
        short_name: string;
        active: boolean;
        policy: {
          status: string;
          freshness: string;
          max_payments?: number;
          payments_used?: number;
          payments_remaining?: number;
          per_payment_limit_native?: string;
          lifetime_limit_native?: string;
          spent_native?: string;
          expires_at?: string;
        };
        accounts: Array<{
          short_name: string;
          balance_native: string;
          freshness: string;
          policy?: {
            status: string;
            freshness: string;
            max_payments?: number;
            payments_used?: number;
            payments_remaining?: number;
            per_payment_limit_native?: string;
            lifetime_limit_native?: string;
            spent_native?: string;
            expires_at?: string;
          };
        }>;
      }>;
      relationship: { implies_control: boolean };
    };
  }).data;
  assert.equal(
    walletTreeData.rendered,
    [
      "🗂 wallets/",
      "├── 💼 agent-boost/ [active]",
      "│\u00a0\u00a0\u00a0├── 🔐 wallet policy — Enabled · 0 used · 10 remaining · 10 maximum · 0.1 Sepolia ETH/send · 0.1 Sepolia ETH total · 0 Sepolia ETH spent · expires Jan 2, 1970 at 00:00 UTC · current",
      "│\u00a0\u00a0\u00a0├── 🌐 main/ — ≈68.899 Sepolia ETH · live",
      "│\u00a0\u00a0\u00a0└── 🥷 private/ — 0.25 Sepolia ETH · live",
      "│\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0└── 🔐 policy — Enabled · 0 used · 10 remaining · 10 maximum · 0.1 Sepolia ETH/send · 0.1 Sepolia ETH total · 0 Sepolia ETH spent · expires Jan 2, 1970 at 00:00 UTC · current",
      "└── 💼 travel/",
      "\u00a0\u00a0\u00a0\u00a0├── 🔐 wallet policy — Enabled · 0 used · 10 remaining · 10 maximum · 0.1 Sepolia ETH/send · 0.1 Sepolia ETH total · 0 Sepolia ETH spent · expires Jan 2, 1970 at 00:00 UTC · last known",
      "\u00a0\u00a0\u00a0\u00a0├── 🌐 main/ — 0.75 Sepolia ETH · live",
      "\u00a0\u00a0\u00a0\u00a0└── 🥷 private/ — 0.1 Sepolia ETH · last known",
      "\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0└── 🔐 policy — Enabled · 0 used · 10 remaining · 10 maximum · 0.1 Sepolia ETH/send · 0.1 Sepolia ETH total · 0 Sepolia ETH spent · expires Jan 2, 1970 at 00:00 UTC · last known",
      "",
      "Folders organize wallet views; they do not imply custody or control.",
    ].join("\n"),
  );
  assert.doesNotMatch(walletTreeData.rendered, /`/u);
  assert.doesNotMatch(walletTreeData.rendered, /(?:^|\n) {4}/u);
  assert.equal(walletTreeData.addresses_included, false);
  assert.equal(walletTreeData.raw_atomic_values_included, false);
  assert.equal(walletTreeData.archived_profiles_hidden, 1);
  const walletTreeText = walletTree.content.find((block) => block.type === "text");
  assert.equal(walletTreeText?.type, "text");
  assert.equal(
    walletTreeText?.type === "text" ? walletTreeText.text : "",
    walletTreeData.rendered,
  );
  const walletTreePresentation = (walletTree.structuredContent as {
    presentation: { notice: { text: string } };
  }).presentation;
  assert.equal(walletTreePresentation.notice.text, walletTreeData.rendered);
  const walletTreeModelContext = walletTree._meta?.["org.agentboost/model-context"] as {
    rendered: string;
    instruction: string;
  };
  assert.equal(walletTreeModelContext.rendered, walletTreeData.rendered);
  assert.equal(authoritativeOutput(walletTree), walletTreeData.rendered);
  assert.match(walletTreeModelContext.instruction, /DIRECT OVERVIEW/iu);
  assert.match(walletTreeModelContext.instruction, /SUCCESS — STOP TOOL USE/iu);
  assert.match(walletTreeModelContext.instruction, /never call or retry another tool/iu);
  assert.match(walletTreeModelContext.instruction, /onboarding or another larger workflow/iu);
  assert.match(walletTreeModelContext.instruction, /Do not introduce, summarize, count, explain/iu);
  assert.equal(walletTreeData.relationship.implies_control, false);
  assert.deepEqual(walletTreeData.profiles.map((profile) => profile.policy), [
    {
      status: "enabled",
      freshness: "current",
      mode: "testnet_delegated",
      max_payments: 10,
      payments_used: 0,
      payments_remaining: 10,
      per_payment_limit_native: "0.1",
      lifetime_limit_native: "0.1",
      spent_native: "0",
      asset: "Sepolia ETH",
      expires_at: new Date(86_400_000).toISOString(),
    },
    {
      status: "enabled",
      freshness: "last_known",
      mode: "testnet_delegated",
      max_payments: 10,
      payments_used: 0,
      payments_remaining: 10,
      per_payment_limit_native: "0.1",
      lifetime_limit_native: "0.1",
      spent_native: "0",
      asset: "Sepolia ETH",
      expires_at: new Date(86_400_000).toISOString(),
    },
  ]);
  assert.deepEqual(
    walletTreeData.profiles.map((profile) => profile.accounts[1]?.policy),
    [
      {
        status: "enabled",
        freshness: "current",
        mode: "testnet_delegated",
        max_payments: 10,
        payments_used: 0,
        payments_remaining: 10,
        per_payment_limit_native: "0.1",
        lifetime_limit_native: "0.1",
        spent_native: "0",
        asset: "Sepolia ETH",
        expires_at: new Date(86_400_000).toISOString(),
      },
      {
        status: "enabled",
        freshness: "last_known",
        mode: "testnet_delegated",
        max_payments: 10,
        payments_used: 0,
        payments_remaining: 10,
        per_payment_limit_native: "0.1",
        lifetime_limit_native: "0.1",
        spent_native: "0",
        asset: "Sepolia ETH",
        expires_at: new Date(86_400_000).toISOString(),
      },
    ],
  );
  assert.deepEqual(
    walletTreeData.profiles.map((profile) => ({
      short_name: profile.short_name,
      active: profile.active,
      accounts: profile.accounts.map(({ short_name, balance_native, freshness }) => ({
        short_name,
        balance_native,
        freshness,
      })),
    })),
    [
      {
        short_name: "agent-boost",
        active: true,
        accounts: [
          { short_name: "main", balance_native: "68.8990000000000001", freshness: "live" },
          { short_name: "private", balance_native: "0.25", freshness: "live" },
        ],
      },
      {
        short_name: "travel",
        active: false,
        accounts: [
          { short_name: "main", balance_native: "0.75", freshness: "live" },
          { short_name: "private", balance_native: "0.1", freshness: "last_known" },
        ],
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(walletTree), new RegExp(WALLET_ADDRESS, "u"));
  assert.doesNotMatch(
    JSON.stringify(walletTree),
    /68899000000000000100|250000000000000000|750000000000000000|100000000000000000/u,
  );

  const policy = await client.callTool({ name: "wallet_get_policy", arguments: {} });
  const policyText = policy.content.find((block) => block.type === "text");
  assert.match(
    policyText?.type === "text" ? policyText.text : "",
    /up to 10 payments, 0\.1 Sepolia ETH each/u,
  );
  assert.match(
    policyText?.type === "text" ? policyText.text : "",
    /asked to change[\s\S]*create the wallet permission-change preview now[\s\S]*Do not ask the user to repeat/u,
  );
  assert.doesNotMatch(JSON.stringify(policy), new RegExp(WALLET_ADDRESS, "u"));
  const policyOutput = authoritativeOutput(policy) ?? "";
  assert.match(policyOutput, /^\*\*Current wallet permission\*\*/u);
  assert.match(policyOutput, /Status: Enabled[\s\S]*10 maximum[\s\S]*0\.1 Sepolia ETH/u);
  assert.doesNotMatch(policyOutput, /wallet_|auth_|wpd_/u);

  const policyReadTool = tools.tools.find(
    (tool) => tool.name === "wallet_get_policy",
  );
  const policyPlanTool = tools.tools.find(
    (tool) => tool.name === "wallet_plan_policy_update",
  );
  const policyApplyTool = tools.tools.find(
    (tool) => tool.name === "wallet_apply_policy_update",
  );
  assert.match(policyReadTool?.description ?? "", /^Read one parent wallet's regular\/private transfer permission without changing it or switching/u);
  assert.match(policyReadTool?.description ?? "", /call wallet_plan_policy_update instead/u);
  const policySearchDescription = (policyPlanTool?.description ?? "").slice(0, 400);
  assert.match(policySearchDescription.slice(0, 90), /^Preview a new parent-wallet permission change from natural values without switching/u);
  assert.match(policySearchDescription, /max_payments/u);
  assert.match(policySearchDescription, /per_payment_limit_native/u);
  assert.match(policySearchDescription, /END THIS TURN/u);
  assert.match(policyPlanTool?.description ?? "", /"max_payments":10/u);
  assert.doesNotMatch(policyPlanTool?.description ?? "", /wallet_apply_policy_update/u);
  assert.match(policyPlanTool?.description ?? "", /request-turn tool/u);
  assert.doesNotMatch(
    policyPlanTool?.description ?? "",
    /\b(?:yes|approv\w*|confirm\w*|reject\w*|cancel\w*)\b|[✅👍]/iu,
  );
  assert.match(policyApplyTool?.title ?? "", /Apply a confirmed wallet permission change/u);
  assert.match(
    policyApplyTool?.description?.slice(0, 80) ?? "",
    /^Approve, reject, or cancel the exact wallet permission preview/u,
  );
  assert.match(policyApplyTool?.description ?? "", /assistant text in the current response is not confirmation/u);
  const policyPlanProperties = (policyPlanTool?.inputSchema as {
    properties?: Record<string, unknown>;
  }).properties ?? {};
  assert.equal("wallet_name" in policyPlanProperties, true);
  assert.deepEqual(
    ["max_payments", "count", "per_payment_limit_native", "per_send_amount"].map(
      (field) => field in policyPlanProperties,
    ),
    [true, true, true, true],
  );
  for (const field of [
    "max_payments",
    "per_payment_limit_native",
    "lifetime_limit_native",
    "expires_in_hours",
    "enabled",
  ]) {
    assert.equal(
      typeof (policyPlanProperties[field] as { description?: unknown } | undefined)?.description,
      "string",
      `${field} has a model-visible description`,
    );
  }
  assert.equal(
    (policyPlanTool?.inputSchema as { additionalProperties?: unknown }).additionalProperties,
    false,
  );
  const policyApplyRequired = (policyApplyTool?.inputSchema as {
    required?: string[];
  }).required ?? [];
  assert.ok(policyApplyRequired.includes("decision_id"));

  const policyPlan = await client.callTool({
    name: "wallet_plan_policy_update",
    arguments: {
      max_payments: 10,
      per_payment_limit_native: "1",
    },
  });
  const plannedPolicy = (policyPlan.structuredContent as {
    data: { plan: { proposed: { perPaymentLimitWei: string } } };
  }).data.plan.proposed;
  assert.equal(plannedPolicy.perPaymentLimitWei, "1000000000000000000");
  const aliasPolicyPlan = await client.callTool({
    name: "wallet_plan_policy_update",
    arguments: { count: 10, per_send_amount: 1 },
  });
  assert.equal(aliasPolicyPlan.isError, undefined);
  const aliasProposedPolicy = (aliasPolicyPlan.structuredContent as {
    data: { plan: { proposed: { maxPayments: number; perPaymentLimitWei: string } } };
  }).data.plan.proposed;
  assert.equal(aliasProposedPolicy.maxPayments, 10);
  assert.equal(aliasProposedPolicy.perPaymentLimitWei, "1000000000000000000");
  const matchingDuplicatePolicyPlan = await client.callTool({
    name: "wallet_plan_policy_update",
    arguments: {
      max_payments: 10,
      count: 10,
      per_payment_limit_native: "1",
      per_send_amount: 1,
    },
  });
  assert.equal(matchingDuplicatePolicyPlan.isError, undefined);
  const conflictingPolicyPlan = await client.callTool({
    name: "wallet_plan_policy_update",
    arguments: { max_payments: 10, count: 9 },
  });
  assert.equal(conflictingPolicyPlan.isError, true);
  const unknownPolicyInput = await client.callTool({
    name: "wallet_plan_policy_update",
    arguments: { sends: 10 },
  });
  assert.equal(unknownPolicyInput.isError, true);
  assert.match(JSON.stringify(unknownPolicyInput), /unrecognized|sends/iu);
  const policyPlanText = policyPlan.content.find((block) => block.type === "text");
  const policyPlanEnvelope = policyPlan.structuredContent as {
    data: { applied: boolean; requires_new_user_confirmation: boolean };
    presentation: {
      kind: string;
      state: string;
      next_action: string;
      fields: Array<{ label: string; value: string }>;
    };
  };
  assert.equal(policyPlanEnvelope.data.applied, false);
  assert.equal(policyPlanEnvelope.data.requires_new_user_confirmation, true);
  assert.equal(policyPlanEnvelope.presentation.kind, "confirmation");
  assert.equal(policyPlanEnvelope.presentation.state, "pending");
  assert.match(policyPlanEnvelope.presentation.next_action, /^END THIS TURN\./u);
  assert.match(policyPlanEnvelope.presentation.next_action, /before making any further tool call/u);
  assert.doesNotMatch(policyPlanEnvelope.presentation.next_action, /wallet_apply_policy_update/u);
  assert.deepEqual(
    policyPlanEnvelope.presentation.fields.slice(0, 4),
    [
      { label: "Wallet", value: "agent-boost", format: "text" },
      { label: "Sends", value: "10", format: "text" },
      { label: "Per send", value: "1 Sepolia ETH", format: "amount" },
      { label: "Total", value: "10 Sepolia ETH", format: "amount" },
    ],
  );
  assert.deepEqual(
    policyPlanEnvelope.presentation.fields.find((field) => field.label === "Status"),
    { label: "Status", value: "Enabled", format: "text" },
  );
  assert.match(
    policyPlanText?.type === "text" ? policyPlanText.text : "",
    /^Status: Enabled$/mu,
  );
  assert.match(
    policyPlanText?.type === "text" ? policyPlanText.text : "",
    /permission only(?:—|-)it does not move funds/u,
  );
  assert.match(
    policyPlanText?.type === "text" ? policyPlanText.text : "",
    /PREVIEW ONLY (?:—|-) NOT APPLIED/u,
  );
  assert.doesNotMatch(
    policyPlanText?.type === "text" ? policyPlanText.text : "",
    /END THIS TURN|NEW USER MESSAGE/u,
  );
  assert.match(
    policyPlanText?.type === "text" ? policyPlanText.text : "",
    /Reply ✅ or say yes to approve\.$/u,
  );
  assert.doesNotMatch(
    policyPlanText?.type === "text" ? policyPlanText.text : "",
    /wallet_apply_policy_update|After confirmation, call/iu,
  );
  assert.doesNotMatch(
    policyPlanText?.type === "text" ? policyPlanText.text : "",
    /wpd_/u,
  );
  const hermesPolicyResult = simulateHermesContentArbitration(policyPlan);
  assert.doesNotMatch(hermesPolicyResult.result, /wpd_/u);
  const hermesPolicyContext = hermesPolicyResult._meta?.[HERMES_MODEL_CONTEXT_KEY] as {
    response_mode: string;
    instruction: string;
    data: { plan: { decisionId: string } };
  };
  assert.equal(hermesPolicyContext.response_mode, "preview_then_stop");
  assert.match(hermesPolicyContext.instruction, /^HARD TURN BOUNDARY:/u);
  assert.match(hermesPolicyContext.instruction, /Make no more tool calls in this assistant turn/u);
  assert.doesNotMatch(hermesPolicyContext.instruction, /wallet_apply_policy_update/u);
  assert.equal(hermesPolicyContext.data.plan.decisionId, "wpd_12345678");
  assert.deepEqual(hermesPolicyResult._meta?.[HERMES_TURN_CONTROL_KEY], {
    schema_version: 1,
    boundary: "new_user_turn",
    continuation: {
      tool: "wallet_apply_policy_update",
      binding: { decision_id: "wpd_12345678" },
    },
  });
  const policyPreviewOutput = authoritativeOutput(policyPlan) ?? "";
  assert.match(policyPreviewOutput, /^\*\*New wallet permission\*\*/u);
  assert.match(policyPreviewOutput, /Reply “approve” to continue or “cancel” to stop\.$/u);
  assert.doesNotMatch(policyPreviewOutput, /wpd_|decision_id|wallet_apply/u);

  const policyStillNeedsChatConfirmation = await client.callTool({
    name: "wallet_apply_policy_update",
    arguments: { decision_id: "wpd_12345678" },
  });
  assert.equal(
    (policyStillNeedsChatConfirmation.structuredContent as { code: string }).code,
    "POLICY_UPDATE_CONFIRMATION_REQUIRED",
  );
  const policyConfirmationText = policyStillNeedsChatConfirmation.content.find(
    (block) => block.type === "text",
  );
  assert.match(
    policyConfirmationText?.type === "text" ? policyConfirmationText.text : "",
    /new user message[\s\S]*do not plan again/iu,
  );

  const policyApplied = await client.callTool({
    name: "wallet_apply_policy_update",
    arguments: { decision_id: "wpd_12345678", user_confirmed: true },
  });
  assert.equal(
    (policyApplied.structuredContent as { code: string }).code,
    "POLICY_UPDATED",
  );
  const policyAppliedText = policyApplied.content.find((block) => block.type === "text");
  assert.match(
    policyAppliedText?.type === "text" ? policyAppliedText.text : "",
    /^Status: Enabled$/mu,
  );
  const policyAppliedPresentation = (policyApplied.structuredContent as {
    presentation: { fields: Array<{ label: string; value: string; format: string }> };
  }).presentation;
  assert.deepEqual(
    policyAppliedPresentation.fields.find((field) => field.label === "Status"),
    { label: "Status", value: "Enabled", format: "text" },
  );

  const regularPlan = await client.callTool({
    name: "wallet_preview_regular_transfer",
    arguments: {
      source: "$selected",
      destination: "0x2222222222222222222222222222222222222222",
      amount_native: "1",
    },
  });
  const regularPlanText = regularPlan.content.find((block) => block.type === "text");
  assert.match(
    regularPlanText?.type === "text" ? regularPlanText.text : "",
    /Regular public transfer ready for chat confirmation/u,
  );
  assert.doesNotMatch(
    regularPlanText?.type === "text" ? regularPlanText.text : "",
    /rwd_|amountWei|intentDigest/u,
  );
  const regularContext = simulateHermesContentArbitration(regularPlan)
    ._meta?.[HERMES_MODEL_CONTEXT_KEY] as {
      data: { plan: { decisionId: string; amountWei: string } };
    };
  assert.equal(regularContext.data.plan.decisionId, "rwd_12345678");
  assert.equal(regularContext.data.plan.amountWei, "1000000000000000000");
  const regularPlanTool = tools.tools.find(
    (tool) => tool.name === "wallet_preview_regular_transfer",
  );
  assert.deepEqual(
    (regularPlanTool?.inputSchema as { required?: string[] }).required,
    ["source", "destination", "amount_native"],
  );
  assert.deepEqual(
    Object.keys((regularPlanTool?.inputSchema as {
      properties?: Record<string, unknown>;
    }).properties ?? {}),
    ["source", "destination", "source_private_balance", "amount_native"],
  );
  assert.equal(
    (regularPlanTool?.inputSchema as { additionalProperties?: unknown }).additionalProperties,
    false,
  );
  assert.match(
    regularPlanTool?.description?.slice(0, 400) ?? "",
    /never fetch balance first/u,
  );
  const regularPresentation = (regularPlan.structuredContent as {
    presentation: { title: string; notice: { text: string } };
  }).presentation;
  assert.equal(regularPresentation.title, "Confirm regular testnet transfer");
  assert.match(
    regularPresentation.notice.text,
    /public Sepolia transfer from the main account/u,
  );

  const regularExecuted = await client.callTool({
    name: "wallet_execute_regular_transfer",
    arguments: { decision_id: "rwd_12345678", user_confirmed: true },
  });
  const regularExecutedPayload = regularExecuted.structuredContent as {
    code: string;
    data: { request: { clientRequestId: string } };
  };
  assert.equal(regularExecutedPayload.code, "REGULAR_TRANSFER_STATUS");
  assert.equal(
    regularExecutedPayload.data.request.clientRequestId,
    "hermes:rwd_12345678",
  );
  assert.doesNotMatch(
    JSON.stringify(regularExecutedPayload),
    /recipientBalanceBeforeWei|reconciliation/,
  );
  const regularExecutedText = regularExecuted.content.find((block) => block.type === "text");
  assert.match(
    regularExecutedText?.type === "text" ? regularExecutedText.text : "",
    /Regular public transfer status is submitted[\s\S]*Report this status as unresolved/u,
  );

  const plan = await client.callTool({
    name: "wallet_preview_private_transfer",
    arguments: {
      source: "$selected",
      destination: "0x2222222222222222222222222222222222222222",
      amount_native: "0.01",
    },
  });
  const planText = plan.content.find((block) => block.type === "text");
  assert.equal(planText?.type, "text");
  assert.match(planText?.type === "text" ? planText.text : "", /chat confirmation/u);
  assert.doesNotMatch(planText?.type === "text" ? planText.text : "", /wd_|amountWei|intentDigest/u);
  const hermesPaymentResult = simulateHermesContentArbitration(plan);
  const hermesPaymentContext = hermesPaymentResult._meta?.[HERMES_MODEL_CONTEXT_KEY] as {
    data: { plan: { decisionId: string; amountWei: string } };
  };
  assert.equal(hermesPaymentContext.data.plan.decisionId, "wd_12345678");
  assert.equal(hermesPaymentContext.data.plan.amountWei, "10000000000000000");
  const planPresentation = (plan.structuredContent as {
    presentation: {
      kind: string;
      title: string;
      interaction?: { transport: string };
      fields: Array<{ label: string; value: string }>;
    };
  }).presentation;
  assert.equal(planPresentation.kind, "confirmation");
  assert.equal(planPresentation.title, "Confirm private test payment");
  assert.equal(planPresentation.interaction, undefined);
  assert.deepEqual(
    planPresentation.fields.map((field) => field.label),
    ["Amount", "To", "Network"],
  );

  const executeTool = tools.tools.find(
    (tool) => tool.name === "wallet_execute_private_transfer",
  );
  const planTool = tools.tools.find(
    (tool) => tool.name === "wallet_preview_private_transfer",
  );
  const planProperties = (planTool?.inputSchema as {
    properties?: Record<string, unknown>;
  }).properties ?? {};
  assert.ok("amount_native" in planProperties);
  assert.ok(!("amount_atomic" in planProperties));
  assert.deepEqual(
    (planTool?.inputSchema as { required?: string[] }).required,
    ["source", "destination", "amount_native"],
  );
  assert.deepEqual(
    Object.keys(planProperties),
    ["source", "destination", "source_private_balance", "amount_native"],
  );
  assert.equal(
    (planTool?.inputSchema as { additionalProperties?: unknown }).additionalProperties,
    false,
  );
  assert.match(
    executeTool?.description ?? "",
    /^Apply or cancel the exact private-transfer preview after a later user chat reply\./u,
  );
  assert.match(
    planTool?.description ?? "",
    /never list, load, reauthorize, or fetch balances first/u,
  );
  const recoveryPreviewTool = tools.tools.find(
    (tool) => tool.name === "wallet_preview_recovery_transfer",
  );
  assert.deepEqual(
    (recoveryPreviewTool?.inputSchema as { required?: string[] }).required,
    ["source", "destination", "amount_native"],
  );
  assert.deepEqual(
    Object.keys((recoveryPreviewTool?.inputSchema as {
      properties?: Record<string, unknown>;
    }).properties ?? {}),
    ["source", "destination", "source_private_balance", "amount_native"],
  );
  assert.equal(
    (recoveryPreviewTool?.inputSchema as { additionalProperties?: unknown })
      .additionalProperties,
    false,
  );
  assert.match(
    recoveryPreviewTool?.description ?? "",
    /^Start one explicit recovery\/unshield transfer/u,
  );
  const legacyPrivatePlanTool = tools.tools.find(
    (tool) => tool.name === "wallet_plan_private_payment",
  );
  assert.match(legacyPrivatePlanTool?.description ?? "", /Compatibility alias/u);
  assert.match(
    legacyPrivatePlanTool?.description ?? "",
    /wallet_preview_private_transfer/u,
  );
  const legacyRecoveryPlanTool = tools.tools.find(
    (tool) => tool.name === "wallet_plan_recovery_transfer",
  );
  assert.match(legacyRecoveryPlanTool?.description ?? "", /Compatibility alias/u);
  assert.match(
    legacyRecoveryPlanTool?.description ?? "",
    /wallet_preview_recovery_transfer/u,
  );
  assert.match(
    executeTool?.description ?? "",
    /Keep IDs internal and tool syntax out of the reply/u,
  );
  assert.match(
    executeTool?.description ?? "",
    /executes once, performs exactly one internal status read[\s\S]*PAYMENT_STATUS/u,
  );
  const legacyPrivateExecuteTool = tools.tools.find(
    (tool) => tool.name === "wallet_execute_private_payment",
  );
  assert.match(
    legacyPrivateExecuteTool?.description ?? "",
    /Compatibility alias[\s\S]*wallet_execute_private_transfer/u,
  );

  const executed = await client.callTool({
    name: "wallet_execute_private_transfer",
    arguments: {
      decision_id: "wd_12345678",
      user_confirmed: true,
    },
  });
  const executedPayload = executed.structuredContent as {
    code: string;
    data: { request: { clientRequestId: string } };
  };
  assert.equal(executedPayload.code, "PAYMENT_STATUS");
  assert.equal(
    executedPayload.data.request.clientRequestId,
    "hermes:wd_12345678",
  );
  assert.doesNotMatch(
    JSON.stringify(executedPayload),
    /recipientBalanceBeforeWei|reconciliation|userOperationReceiptEvidence/,
  );
  const executedText = executed.content.find((block) => block.type === "text");
  assert.match(
    executedText?.type === "text" ? executedText.text : "",
    /Private transfer is not confirmed \(submitted\)[\s\S]*Report this status as unresolved/u,
  );
  const hermesRequestResult = simulateHermesContentArbitration(executed);
  const hermesRequestContext = hermesRequestResult._meta?.[HERMES_MODEL_CONTEXT_KEY] as {
    data: { request: { requestId: string } };
  };
  assert.equal(hermesRequestContext.data.request.requestId, "req_12345678");
  const privateRequestStatus = await client.callTool({
    name: "wallet_get_private_transfer_request",
    arguments: { request_id: "req_12345678" },
  });
  const legacyPrivateRequestStatus = await client.callTool({
    name: "wallet_get_request",
    arguments: { request_id: "req_12345678" },
  });
  assert.deepEqual(
    legacyPrivateRequestStatus.structuredContent,
    privateRequestStatus.structuredContent,
  );
  assert.deepEqual(legacyPrivateRequestStatus.content, privateRequestStatus.content);

  await client.close();
  await server.close();
});

test("canonical transfer execution performs one matching internal status read", async () => {
  const runtime = fakeRuntime();
  const executeCalls = { regular: 0, private: 0, recovery: 0 };
  const statusReads = {
    regular: [] as string[],
    private: [] as string[],
    recovery: [] as string[],
  };
  const executeRegular = runtime.executeRegularTransfer.bind(runtime);
  const executePrivate = runtime.executePrivatePayment.bind(runtime);
  const executeRecovery = runtime.executeRecoveryTransfer.bind(runtime);
  const readRegular = runtime.getRegularTransferRequest.bind(runtime);
  const readPrivate = runtime.getRequest.bind(runtime);
  const readRecovery = runtime.getRecoveryRequest.bind(runtime);
  runtime.executeRegularTransfer = async (input) => {
    executeCalls.regular += 1;
    return {
      ...(await executeRegular(input)),
      // A terminal execute result must still receive the one canonical read.
      phase: "confirmed" as const,
      confirmation: {
        method: "transaction_receipt" as const,
        checkedAt: new Date(1_000).toISOString(),
      },
    };
  };
  runtime.executePrivatePayment = async (input) => {
    executeCalls.private += 1;
    return executePrivate(input);
  };
  runtime.executeRecoveryTransfer = async (input) => {
    executeCalls.recovery += 1;
    return executeRecovery(input);
  };
  runtime.getRegularTransferRequest = async (requestId) => {
    statusReads.regular.push(requestId);
    return readRegular(requestId);
  };
  runtime.getRequest = async (requestId) => {
    statusReads.private.push(requestId);
    return readPrivate(requestId);
  };
  runtime.getRecoveryRequest = async (requestId) => {
    statusReads.recovery.push(requestId);
    return readRecovery(requestId);
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "execute-verify-test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const fixtures = [
      {
        name: "wallet_execute_regular_transfer",
        decisionId: "rwd_12345678",
        statusCode: "REGULAR_TRANSFER_STATUS",
        requestId: "rreq_12345678",
      },
      {
        name: "wallet_execute_private_transfer",
        decisionId: "wd_12345678",
        statusCode: "PAYMENT_STATUS",
        requestId: "req_12345678",
      },
      {
        name: "wallet_execute_recovery_transfer",
        decisionId: "wr_12345678",
        statusCode: "RECOVERY_STATUS",
        requestId: "wrr_12345678",
      },
    ] as const;
    for (const fixture of fixtures) {
      const response = await client.callTool({
        name: fixture.name,
        arguments: { decision_id: fixture.decisionId, user_confirmed: true },
      });
      const structured = response.structuredContent as {
        code: string;
        retry: { mode: string; safe_with_same_arguments: boolean };
        data: { request: { requestId: string }; verification_unavailable?: boolean };
      };
      assert.equal(structured.code, fixture.statusCode);
      assert.equal(structured.data.request.requestId, fixture.requestId);
      assert.equal(structured.data.verification_unavailable, undefined);
      assert.deepEqual(structured.retry, {
        mode: "never",
        safe_with_same_arguments: false,
      });
      const outputContract = response._meta?.[HERMES_USER_FACING_OUTPUT_KEY] as {
        complete_turn?: boolean;
      };
      assert.equal(outputContract.complete_turn, true);
    }
    assert.deepEqual(executeCalls, { regular: 1, private: 1, recovery: 1 });
    assert.deepEqual(statusReads, {
      regular: ["rreq_12345678"],
      private: ["req_12345678"],
      recovery: ["wrr_12345678"],
    });

    const legacy = await client.callTool({
      name: "wallet_execute_private_payment",
      arguments: { decision_id: "wd_12345678", user_confirmed: true },
    });
    assert.equal(
      (legacy.structuredContent as { code: string }).code,
      "PAYMENT_REQUEST",
    );
    assert.equal(executeCalls.private, 2);
    assert.deepEqual(statusReads.private, ["req_12345678"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("canonical transfer execution preserves its request when verification is unavailable", async () => {
  const runtime = fakeRuntime();
  const executeCalls = { regular: 0, private: 0, recovery: 0 };
  const statusReads = { regular: 0, private: 0, recovery: 0 };
  const executeRegular = runtime.executeRegularTransfer.bind(runtime);
  const executePrivate = runtime.executePrivatePayment.bind(runtime);
  const executeRecovery = runtime.executeRecoveryTransfer.bind(runtime);
  const readRegular = runtime.getRegularTransferRequest.bind(runtime);
  const readRecovery = runtime.getRecoveryRequest.bind(runtime);
  runtime.executeRegularTransfer = async (input) => {
    executeCalls.regular += 1;
    return executeRegular(input);
  };
  runtime.executePrivatePayment = async (input) => {
    executeCalls.private += 1;
    return executePrivate(input);
  };
  runtime.executeRecoveryTransfer = async (input) => {
    executeCalls.recovery += 1;
    return executeRecovery(input);
  };
  runtime.getRegularTransferRequest = async (requestId) => {
    statusReads.regular += 1;
    return { ...(await readRegular(requestId)), requestId: "rreq_mismatch" };
  };
  runtime.getRequest = async () => {
    statusReads.private += 1;
    throw new Error("status backend unavailable");
  };
  runtime.getRecoveryRequest = async (requestId) => {
    statusReads.recovery += 1;
    return { ...(await readRecovery(requestId)), decisionId: "wr_mismatch" };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "execute-verify-fallback-test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const fixtures = [
      {
        name: "wallet_execute_regular_transfer",
        decisionId: "rwd_12345678",
        requestCode: "REGULAR_TRANSFER_REQUEST",
        requestId: "rreq_12345678",
      },
      {
        name: "wallet_execute_private_transfer",
        decisionId: "wd_12345678",
        requestCode: "PAYMENT_REQUEST",
        requestId: "req_12345678",
      },
      {
        name: "wallet_execute_recovery_transfer",
        decisionId: "wr_12345678",
        requestCode: "RECOVERY_REQUEST",
        requestId: "wrr_12345678",
      },
    ] as const;
    for (const fixture of fixtures) {
      const response = await client.callTool({
        name: fixture.name,
        arguments: { decision_id: fixture.decisionId, user_confirmed: true },
      });
      const structured = response.structuredContent as {
        outcome: string;
        code: string;
        retry: { mode: string; safe_with_same_arguments: boolean };
        data: {
          request: { requestId: string; decisionId: string };
          verification_unavailable: boolean;
        };
      };
      assert.equal(structured.code, fixture.requestCode);
      assert.equal(structured.outcome, "submitted");
      assert.equal(structured.data.request.requestId, fixture.requestId);
      assert.equal(structured.data.request.decisionId, fixture.decisionId);
      assert.equal(structured.data.verification_unavailable, true);
      assert.deepEqual(structured.retry, {
        mode: "never",
        safe_with_same_arguments: false,
      });
      assert.match(authoritativeOutput(response) ?? "", /verification unavailable/iu);
      assert.match(authoritativeOutput(response) ?? "", /does not mean[\s\S]*failed/iu);
      assert.doesNotMatch(
        JSON.stringify(response),
        /rreq_mismatch|wr_mismatch|status backend unavailable/u,
      );
      assert.doesNotMatch(visibleToolSurface(response), /wallet_get_|DO NOT REPLY/u);
      const outputContract = response._meta?.[HERMES_USER_FACING_OUTPUT_KEY] as {
        complete_turn?: boolean;
      };
      assert.equal(outputContract.complete_turn, true);
    }
    assert.deepEqual(executeCalls, { regular: 1, private: 1, recovery: 1 });
    assert.deepEqual(statusReads, { regular: 1, private: 1, recovery: 1 });
  } finally {
    await client.close();
    await server.close();
  }
});

test("a post-broadcast recipient-label failure preserves regular-transfer idempotency", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-mcp-transfer-decoration-"));
  const store = new StateStore(root);
  await store.initialize();
  const now = new Date();
  await store.update((draft) => {
    draft.onboarding = {
      version: 1,
      setupId: "setup_mcp_transfer_decoration",
      revision: 1,
      phase: "private_ready",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      address: WALLET_ADDRESS,
      publicBalanceWei: "2000000000000000000",
      privateBalanceWei: "100000000000000000",
      requiredFundingWei: "200000000000000000",
      shieldAmountWei: "100000000000000000",
      delegation: {
        mode: "testnet_delegated",
        chainId: 11_155_111,
        perPaymentLimitWei: "100000000000000000",
        lifetimeLimitWei: "1000000000000000000",
        spentWei: "0",
        maxPayments: 10,
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        enabled: true,
      },
    };
  });

  const recipient = "0x2222222222222222222222222222222222222222";
  const transactionHash = `0x${"ab".repeat(32)}`;
  let broadcast = false;
  let broadcastCalls = 0;
  const wallet: WalletAdapter = {
    async ensureWallet() {},
    async nextFreshAddress() {
      return WALLET_ADDRESS;
    },
    async prewarmPrivacy() {},
    async shieldWei() {
      return {};
    },
    async getPrivateBalanceWei() {
      return 100_000_000_000_000_000n;
    },
    async executePrivatePayment(input) {
      assert.match(input.broadcastRequestId, /^req_/u);
      await input.beforeBroadcast();
      return {};
    },
    async executeRegularTransfer(input) {
      broadcastCalls += 1;
      await input.beforeBroadcast();
      broadcast = true;
      return { transactionHash, confirmed: false };
    },
  };
  const chain: ChainClient = {
    async assertSepolia() {},
    async getBalanceWei(address) {
      return address.toLowerCase() === WALLET_ADDRESS.toLowerCase()
        ? 2_000_000_000_000_000_000n
        : 0n;
    },
  };
  const runtime = new LocalAgentBoostRuntime(
    {
      ...loadConfig({
        AGENT_BOOST_STATE_DIR: root,
        AGENT_BOOST_SHADE_TREE_ENABLED: "false",
      }, root),
      uiPort: 0,
    },
    { wallet, chain, openBrowser: async () => false },
  );
  const plan = await runtime.planRegularTransfer({
    recipient,
    amountWei: "10000000000000000",
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({
    name: "post-broadcast-decoration-failure-test",
    version: "1.0.0",
  }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const originalRead = StateStore.prototype.read;
  let postBroadcastReads = 0;
  let injectedFailure = false;
  StateStore.prototype.read = async function () {
    if (broadcast) {
      postBroadcastReads += 1;
      if (postBroadcastReads === 2) {
        injectedFailure = true;
        throw new Error("forced post-execution label read failure");
      }
    }
    return originalRead.call(this);
  };

  try {
    const execute = async (): Promise<CallToolResult> => client.callTool({
      name: "wallet_execute_regular_transfer",
      arguments: { decision_id: plan.decisionId, user_confirmed: true },
    });
    const first = await execute();
    const firstPayload = first.structuredContent as {
      outcome: string;
      code: string;
      data: {
        request: {
          requestId: string;
          decisionId: string;
          transactionHash?: string;
          recipientWalletName?: string;
        };
        verification_unavailable?: boolean;
      };
    };
    assert.equal(injectedFailure, true);
    assert.equal(firstPayload.code, "REGULAR_TRANSFER_STATUS");
    assert.equal(firstPayload.outcome, "submitted");
    assert.match(firstPayload.data.request.requestId, /^rreq_/u);
    assert.equal(firstPayload.data.request.decisionId, plan.decisionId);
    assert.equal(firstPayload.data.request.transactionHash, transactionHash);
    assert.equal(firstPayload.data.request.recipientWalletName, undefined);
    assert.equal(firstPayload.data.verification_unavailable, undefined);
    assert.equal(broadcastCalls, 1);

    const retried = await execute();
    const retriedPayload = retried.structuredContent as {
      code: string;
      data: { request: { requestId: string; transactionHash?: string } };
    };
    assert.equal(retriedPayload.code, "REGULAR_TRANSFER_STATUS");
    assert.equal(
      retriedPayload.data.request.requestId,
      firstPayload.data.request.requestId,
    );
    assert.equal(retriedPayload.data.request.transactionHash, transactionHash);
    assert.equal(broadcastCalls, 1);

    const persisted = await store.read();
    assert.equal(Object.keys(persisted.regularRequests).length, 1);
    assert.equal(
      persisted.regularRequests[firstPayload.data.request.requestId]?.phase,
      "submitted",
    );
  } finally {
    StateStore.prototype.read = originalRead;
    await client.close();
    await server.close();
  }
});

test("policy previews and receipts state whether permission is Enabled or Disabled", async () => {
  const runtime = fakeRuntime();
  const originalPlan = await runtime.planPolicyUpdate({ enabled: false });
  const disabledPlan: PolicyUpdatePlan = {
    ...originalPlan,
    proposed: { ...originalPlan.proposed, enabled: false },
  };
  const originalApply = runtime.applyPolicyUpdate.bind(runtime);
  runtime.planPolicyUpdate = async () => disabledPlan;
  runtime.getPolicyUpdatePlan = async () => disabledPlan;
  runtime.applyPolicyUpdate = async (input): Promise<PolicyUpdateReceipt> => {
    const receipt = await originalApply(input);
    return { ...receipt, policy: { ...receipt.policy, enabled: false } };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "policy-status-test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const preview = await client.callTool({
      name: "wallet_plan_policy_update",
      arguments: { enabled: false },
    });
    const previewText = preview.content.find((block) => block.type === "text");
    assert.match(previewText?.type === "text" ? previewText.text : "", /^Status: Disabled$/mu);
    const previewFields = (preview.structuredContent as {
      presentation: { fields: Array<{ label: string; value: string; format: string }> };
    }).presentation.fields;
    assert.deepEqual(
      previewFields.find((field) => field.label === "Status"),
      { label: "Status", value: "Disabled", format: "text" },
    );

    const receipt = await client.callTool({
      name: "wallet_apply_policy_update",
      arguments: { decision_id: disabledPlan.decisionId, user_confirmed: true },
    });
    const receiptText = receipt.content.find((block) => block.type === "text");
    assert.match(receiptText?.type === "text" ? receiptText.text : "", /^Status: Disabled$/mu);
    const receiptFields = (receipt.structuredContent as {
      presentation: { fields: Array<{ label: string; value: string; format: string }> };
    }).presentation.fields;
    assert.deepEqual(
      receiptFields.find((field) => field.label === "Status"),
      { label: "Status", value: "Disabled", format: "text" },
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("wallet policy tools forward and visibly bind a named parent wallet", async () => {
  const runtime = fakeRuntime();
  const walletB = {
    walletId: "wallet_b_12345678",
    walletName: "wallet-b",
    selectionEpoch: 3,
  };
  let readWalletName: string | undefined;
  let plannedWalletName: string | undefined;
  let namedPlan: PolicyUpdatePlan | undefined;
  const originalRead = runtime.walletPolicy.bind(runtime);
  const originalPlan = runtime.planPolicyUpdate.bind(runtime);
  runtime.walletPolicy = async (input) => {
    readWalletName = input?.walletName;
    return { ...(await originalRead()), wallet: walletB };
  };
  runtime.planPolicyUpdate = async (input) => {
    plannedWalletName = input.walletName;
    namedPlan = {
      ...(await originalPlan(input)),
      wallet: walletB,
      authorizationId: "auth_wallet-b",
    };
    return namedPlan;
  };
  runtime.getPolicyUpdatePlan = async () => {
    assert.ok(namedPlan);
    return namedPlan;
  };
  runtime.applyPolicyUpdate = async (input): Promise<PolicyUpdateReceipt> => {
    assert.ok(namedPlan);
    return {
      version: 1,
      decisionId: input.decisionId,
      wallet: walletB,
      appliedAt: new Date(1_000).toISOString(),
      policy: namedPlan.proposed,
      authorizationEffect: "preserved",
      counterEffect: "preserved",
    };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "named-policy-test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    for (const toolName of ["wallet_get_policy", "wallet_plan_policy_update"]) {
      const tool = tools.tools.find(({ name }) => name === toolName);
      const properties = (tool?.inputSchema as {
        properties?: Record<string, unknown>;
      }).properties ?? {};
      assert.equal("wallet_name" in properties, true, `${toolName} accepts wallet_name`);
    }

    const read = await client.callTool({
      name: "wallet_get_policy",
      arguments: { wallet_name: "wallet-b" },
    });
    assert.equal(readWalletName, "wallet-b");
    const readData = (read.structuredContent as {
      data: { wallet: typeof walletB };
    }).data;
    assert.deepEqual(readData.wallet, walletB);
    assert.match(authoritativeOutput(read) ?? "", /^\*\*wallet-b wallet permission\*\*/u);

    const missingSetting = await client.callTool({
      name: "wallet_plan_policy_update",
      arguments: { wallet_name: "wallet-b" },
    });
    assert.equal(missingSetting.isError, true);

    const preview = await client.callTool({
      name: "wallet_plan_policy_update",
      arguments: { wallet_name: "wallet-b", enabled: false },
    });
    assert.equal(plannedWalletName, "wallet-b");
    const previewPlan = (preview.structuredContent as {
      data: { plan: PolicyUpdatePlan };
    }).data.plan;
    assert.deepEqual(previewPlan.wallet, walletB);
    assert.match(authoritativeOutput(preview) ?? "", /Wallet:\s+wallet-b/u);

    const applied = await client.callTool({
      name: "wallet_apply_policy_update",
      arguments: {
        decision_id: previewPlan.decisionId,
        user_confirmed: true,
      },
    });
    const receipt = (applied.structuredContent as {
      data: { receipt: PolicyUpdateReceipt };
    }).data.receipt;
    assert.deepEqual(receipt.wallet, walletB);
    assert.match(authoritativeOutput(applied) ?? "", /Wallet:\s+wallet-b/u);
  } finally {
    await client.close();
    await server.close();
  }
});

test("private-balance expiry denial explains the parent constraint without clamping or IDs", async () => {
  const runtime = fakeRuntime();
  const originalPlan = runtime.planPrivateBalancePolicyUpdate.bind(runtime);
  const requestedExpiry = "2030-01-08T00:00:00.000Z";
  let receivedTtlMs: number | undefined;
  runtime.planPrivateBalancePolicyUpdate = async (input) => {
    receivedTtlMs = input.ttlMs;
    const plan = await originalPlan(input);
    return {
      ...plan,
      privateBalance: {
        ...(plan.privateBalance as Record<string, unknown>),
        walletId: "wallet_internal_beta_12345678",
        walletName: "beta",
        privateBalanceId: "pb_internal_business_12345678",
        privateBalanceName: "business",
      },
      proposed: {
        ...(plan.proposed as Record<string, unknown>),
        expiresAt: requestedExpiry,
      },
      decision: "deny",
      blockers: ["EXCEEDS_WALLET_EXPIRY"],
    };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({
    name: "private-policy-denial-test",
    version: "1.0.0",
  }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const response = await client.callTool({
      name: "wallet_preview_private_balance_policy_update",
      arguments: {
        wallet_name: "beta",
        private_balance_name: "business",
        expires_in_hours: 168,
      },
    });
    assert.equal(receivedTtlMs, 168 * 60 * 60_000);
    const structured = response.structuredContent as {
      outcome: string;
      code: string;
      data: {
        plan: {
          proposed: { expiresAt: string };
          blockers: string[];
        };
      };
      presentation: {
        title: string;
        state: string;
        fields: Array<{ label: string; value: string }>;
        notice: { text: string };
        next_action: string;
      };
    };
    assert.equal(structured.outcome, "blocked");
    assert.equal(structured.code, "PRIVATE_BALANCE_POLICY_UPDATE_DENIED");
    assert.equal(
      structured.data.plan.proposed.expiresAt,
      requestedExpiry,
      "the rejected request must remain exact rather than being silently shortened",
    );
    assert.deepEqual(structured.data.plan.blockers, ["EXCEEDS_WALLET_EXPIRY"]);
    assert.equal(structured.presentation.title, "business permission blocked");
    assert.equal(structured.presentation.state, "attention");
    assert.deepEqual(
      structured.presentation.fields.slice(0, 2),
      [
        { label: "Wallet", value: "beta", format: "text" },
        { label: "Private balance", value: "business", format: "text" },
      ],
    );
    assert.match(
      structured.presentation.notice.text,
      /business.*outlast.*parent wallet permission.*beta/iu,
    );
    assert.match(structured.presentation.notice.text, /not changed.*no funds moved/iu);
    assert.match(structured.presentation.next_action, /shorter whole-hour child expiry/iu);
    assert.match(structured.presentation.next_action, /extend.*parent permission.*beta/iu);
    assert.match(structured.presentation.next_action, /fresh business permission preview/iu);
    assert.doesNotMatch(
      JSON.stringify(structured.presentation),
      /EXCEEDS_WALLET_EXPIRY|wallet_internal|pb_internal/iu,
    );

    const rendered = authoritativeOutput(response) ?? "";
    assert.match(rendered, /^\*\*! business permission blocked\*\*/u);
    assert.match(rendered, /business.*outlast.*parent wallet permission.*beta/iu);
    assert.match(rendered, /shorter whole-hour child expiry/iu);
    assert.match(rendered, /extend.*parent permission.*beta/iu);
    assert.match(rendered, /fresh business permission preview/iu);
    assert.match(rendered, /policy was not changed and no funds moved/iu);
    assert.doesNotMatch(
      rendered,
      /EXCEEDS_WALLET_EXPIRY|wallet_internal|pb_internal|clamp|adjusted/iu,
    );
    const compact = response.content.find((block) => block.type === "text");
    assert.match(compact?.type === "text" ? compact.text : "", /outlast.*parent/iu);
    assert.match(compact?.type === "text" ? compact.text : "", /shorter.*or extend/iu);
    assertNoVisibleInternalIds(response);
    assert.equal(
      (response._meta?.[HERMES_USER_FACING_OUTPUT_KEY] as {
        complete_turn?: boolean;
      } | undefined)?.complete_turn,
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("recovery consent and success disclose denomination, public remainder, fees, and private balance", async () => {
  const runtime = fakeRuntime();
  const recipient = "0x2222222222222222222222222222222222222222";
  const originalPlan = await runtime.planRecoveryTransfer({
    recipient,
    amountWei: "40000000000000000",
  });
  const partialPlan: RecoveryTransferPlan = {
    ...originalPlan,
    recipient,
    amountWei: "40000000000000000",
    withdrawalAmountWei: "100000000000000000",
    feeReserveWei: "10000000000000000",
    maxRecipientAmountWei: "90000000000000000",
    privateBalanceSnapshotWei: "200000000000000000",
    remainingPrivateBalanceEstimateWei: "100000000000000000",
  };
  const maximumPlan: RecoveryTransferPlan = {
    ...partialPlan,
    amountWei: "90000000000000000",
    privateBalanceSnapshotWei: "100000000000000000",
    remainingPrivateBalanceEstimateWei: "0",
  };
  const originalRequest = await runtime.executeRecoveryTransfer({
    decisionId: partialPlan.decisionId,
    clientRequestId: `hermes:${partialPlan.decisionId}`,
    userConfirmed: true,
  });
  const confirmedRequest: RecoveryTransferRequest = {
    ...originalRequest,
    recipient,
    amountWei: partialPlan.amountWei,
    withdrawalAmountWei: partialPlan.withdrawalAmountWei,
    feeReserveWei: partialPlan.feeReserveWei,
    remainingPrivateBalanceEstimateWei: partialPlan.remainingPrivateBalanceEstimateWei,
    phase: "confirmed",
  };
  runtime.planRecoveryTransfer = async (input) =>
    input.amountWei === maximumPlan.amountWei ? maximumPlan : partialPlan;
  runtime.getRecoveryPlan = async () => partialPlan;
  runtime.executeRecoveryTransfer = async () => confirmedRequest;
  runtime.getRecoveryRequest = async () => confirmedRequest;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "recovery-accounting-test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const assertAccounting = (
    response: CallToolResult,
    expected: {
      recipientAmount: string;
      publicRemainder: string;
      privateBalanceAfter: string;
    },
  ): void => {
    const fields = (response.structuredContent as {
      presentation: { fields: Array<{ label: string; value: string }> };
    }).presentation.fields;
    const byLabel = new Map(fields.map((field) => [field.label, field.value]));
    assert.equal(byLabel.get("Private denomination consumed"), "0.1 Sepolia ETH");
    assert.equal(byLabel.get("Recipient receives publicly"), expected.recipientAmount);
    assert.equal(byLabel.get("Public remainder before fees"), expected.publicRemainder);
    assert.equal(byLabel.get("Minimum fee reserve"), "0.01 Sepolia ETH");
    assert.equal(byLabel.get("Estimated private balance after"), expected.privateBalanceAfter);
  };

  try {
    const preview = await client.callTool({
      name: "wallet_preview_recovery_transfer",
      arguments: { source: "$selected", destination: recipient, amount_native: "0.04" },
    });
    assertAccounting(preview, {
      recipientAmount: "0.04 Sepolia ETH",
      publicRemainder: "0.06 Sepolia ETH",
      privateBalanceAfter: "0.1 Sepolia ETH",
    });
    const previewText = preview.content.find((block) => block.type === "text");
    const previewCopy = previewText?.type === "text" ? previewText.text : "";
    assert.match(previewCopy, /full 0\.1 Sepolia ETH private denomination will be consumed/u);
    assert.match(previewCopy, /Exactly 0\.04 Sepolia ETH will be sent publicly/u);
    assert.match(previewCopy, /0\.06 Sepolia ETH will become a wallet-controlled public remainder/u);
    assert.match(previewCopy, /0\.01 Sepolia ETH is the minimum fee reserve/u);
    assert.match(previewCopy, /Estimated private balance after recovery: 0\.1 Sepolia ETH/u);

    const confirmation = await client.callTool({
      name: "wallet_execute_recovery_transfer",
      arguments: { decision_id: partialPlan.decisionId },
    });
    assert.equal(
      (confirmation.structuredContent as { code: string }).code,
      "RECOVERY_CONFIRMATION_REQUIRED",
    );
    assertAccounting(confirmation, {
      recipientAmount: "0.04 Sepolia ETH",
      publicRemainder: "0.06 Sepolia ETH",
      privateBalanceAfter: "0.1 Sepolia ETH",
    });
    const confirmationText = confirmation.content.find((block) => block.type === "text");
    assert.match(
      confirmationText?.type === "text" ? confirmationText.text : "",
      /full 0\.1 Sepolia ETH private denomination[\s\S]*Exactly 0\.04 Sepolia ETH[\s\S]*0\.06 Sepolia ETH[\s\S]*0\.01 Sepolia ETH[\s\S]*private balance after recovery: 0\.1 Sepolia ETH/iu,
    );

    const success = await client.callTool({
      name: "wallet_execute_recovery_transfer",
      arguments: { decision_id: partialPlan.decisionId, user_confirmed: true },
    });
    assert.equal((success.structuredContent as { code: string }).code, "RECOVERY_STATUS");
    assertAccounting(success, {
      recipientAmount: "0.04 Sepolia ETH",
      publicRemainder: "0.06 Sepolia ETH",
      privateBalanceAfter: "0.1 Sepolia ETH",
    });
    const successText = success.content.find((block) => block.type === "text");
    assert.match(
      successText?.type === "text" ? successText.text : "",
      /full 0\.1 Sepolia ETH private denomination was consumed[\s\S]*Exactly 0\.04 Sepolia ETH was sent publicly[\s\S]*0\.06 Sepolia ETH became a wallet-controlled public remainder[\s\S]*0\.01 Sepolia ETH was the minimum fee reserve[\s\S]*private balance after recovery: 0\.1 Sepolia ETH/iu,
    );

    const status = await client.callTool({
      name: "wallet_get_recovery_request",
      arguments: { request_id: confirmedRequest.requestId },
    });
    assert.equal((status.structuredContent as { code: string }).code, "RECOVERY_STATUS");
    assertAccounting(status, {
      recipientAmount: "0.04 Sepolia ETH",
      publicRemainder: "0.06 Sepolia ETH",
      privateBalanceAfter: "0.1 Sepolia ETH",
    });
    const statusText = status.content.find((block) => block.type === "text");
    assert.match(
      statusText?.type === "text" ? statusText.text : "",
      /Recovery transfer confirmed[\s\S]*full 0\.1 Sepolia ETH private denomination was consumed[\s\S]*Exactly 0\.04 Sepolia ETH was sent publicly/iu,
    );

    const edgePreview = await client.callTool({
      name: "wallet_preview_recovery_transfer",
      arguments: { source: "$selected", destination: recipient, amount_native: "0.09" },
    });
    assertAccounting(edgePreview, {
      recipientAmount: "0.09 Sepolia ETH",
      publicRemainder: "0.01 Sepolia ETH",
      privateBalanceAfter: "0 Sepolia ETH",
    });
    const edgeFields = (edgePreview.structuredContent as {
      presentation: { fields: Array<{ label: string; value: string }> };
    }).presentation.fields;
    const edgeByLabel = new Map(edgeFields.map((field) => [field.label, field.value]));
    assert.equal(
      edgeByLabel.get("Public remainder before fees"),
      edgeByLabel.get("Minimum fee reserve"),
      "at the maximum recipient amount, the public remainder equals the fee reserve",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("transfer planners accept one raw address or one saved-wallet friendly name", async () => {
  const runtime = fakeRuntime();
  const originalRegularPlan = runtime.planRegularTransfer.bind(runtime);
  let observed: Parameters<AgentBoostRuntime["planRegularTransfer"]>[0] | undefined;
  runtime.planRegularTransfer = async (input) => {
    observed = input;
    return originalRegularPlan({
      ...input,
      ...(input.recipientWalletName === undefined
        ? {}
        : { recipientWalletName: "new_private_wallet" }),
    });
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "named-wallet-transfer-test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    for (const argumentsValue of [
      { source: "$selected", destination: "new_private_wallet" },
      { destination: "new_private_wallet", amount_native: "0.1" },
      { source: "$selected", amount_native: "0.1" },
      {
        source: "$selected",
        destination: "new_private_wallet",
        amount_native: "0.1",
        recipient_wallet_name: "escape-hatch",
      },
    ]) {
      const invalid = await client.callTool({
        name: "wallet_preview_regular_transfer",
        arguments: argumentsValue,
      });
      assert.equal(invalid.isError, true);
    }

    const canonicalNamed = await client.callTool({
      name: "wallet_preview_regular_transfer",
      arguments: {
        source: "agent boost wallet",
        destination: "my new private wallet",
        amount_native: "0.1",
      },
    });
    assert.equal(
      (canonicalNamed.structuredContent as { code: string }).code,
      "REGULAR_TRANSFER_PLANNED",
    );
    assert.deepEqual(observed, {
      sourceWalletName: "agent boost wallet",
      recipientWalletName: "my new private wallet",
      amountWei: "100000000000000000",
    });

    for (const argumentsValue of [
      { amount_native: "0.1" },
      {
        recipient: "0x2222222222222222222222222222222222222222",
        recipient_wallet_name: "new_private_wallet",
        amount_native: "0.1",
      },
      {
        recipient_wallet_name: "new_private_wallet",
        amount_native: "0.1",
        unexpected: true,
      },
    ]) {
      const invalid = await client.callTool({
        name: "wallet_plan_regular_transfer",
        arguments: argumentsValue,
      });
      assert.equal(invalid.isError, true);
    }

    const named = await client.callTool({
      name: "wallet_plan_regular_transfer",
      arguments: {
        source_wallet_name: "agent boost wallet",
        recipient_wallet_name: "my new private wallet",
        amount_native: "0.1",
      },
    });
    assert.equal((named.structuredContent as { code: string }).code, "REGULAR_TRANSFER_PLANNED");
    assert.deepEqual(observed, {
      sourceWalletName: "agent boost wallet",
      recipientWalletName: "my new private wallet",
      amountWei: "100000000000000000",
    });
    const namedPlan = (named.structuredContent as {
      data: { plan: { recipient: string; recipientWalletName: string } };
      presentation: { fields: Array<{ label: string; value: string; format: string }> };
    });
    assert.equal(namedPlan.data.plan.recipientWalletName, "new_private_wallet");
    assert.equal(
      namedPlan.presentation.fields.find((field) => field.label === "To")?.value,
      "new_private_wallet main/public receiving account",
    );
    assert.equal(
      namedPlan.presentation.fields.find((field) => field.label === "To")?.format,
      "text",
    );
    const namedText = named.content.find((block) => block.type === "text");
    assert.match(
      namedText?.type === "text" ? namedText.text : "",
      /new_private_wallet main\/public receiving account/u,
    );

    runtime.planRegularTransfer = async () => {
      throw new AgentBoostRequestError(
        "SOURCE_WALLET_SWITCH_REQUIRED",
        "Switch to saved wallet agent-boost before planning this transfer.",
        {
          source_wallet_name: "agent-boost",
          active_wallet_name: "new_private_wallet",
          expected_active_wallet_name: "new_private_wallet",
          expected_active_selection_epoch: 2,
          recipient_wallet_name: "new_private_wallet",
          resolved_recipient_account: "main",
          required_actions: [
            "switch_saved_profile",
            "reauthorize_if_required",
            "plan_transfer_again",
          ],
        },
      );
    };
    const switchRequired = await client.callTool({
      name: "wallet_plan_regular_transfer",
      arguments: {
        source_wallet_name: "agent boost wallet",
        recipient_wallet_name: "my new private wallet",
        amount_native: "0.1",
      },
    });
    const switchEnvelope = switchRequired.structuredContent as {
      code: string;
      data: {
        amount_native: string;
        plan_created: boolean;
        source_wallet_name: string;
        expected_active_wallet_name: string;
        expected_active_selection_epoch: number;
      };
      presentation: { title: string; next_action: string };
    };
    assert.equal(switchEnvelope.code, "REGULAR_TRANSFER_SOURCE_SWITCH_REQUIRED");
    assert.equal(switchEnvelope.data.amount_native, "0.1");
    assert.equal(switchEnvelope.data.plan_created, false);
    assert.equal(switchEnvelope.data.source_wallet_name, "agent-boost");
    assert.equal(switchEnvelope.data.expected_active_wallet_name, "new_private_wallet");
    assert.equal(switchEnvelope.data.expected_active_selection_epoch, 2);
    assert.equal(switchEnvelope.presentation.title, "Switch transfer source wallet");
    assert.match(switchEnvelope.presentation.next_action, /END THIS TURN/u);
    const switchText = switchRequired.content.find((block) => block.type === "text");
    assert.match(
      switchText?.type === "text" ? switchText.text : "",
      /workflow state will be archived[\s\S]*No transfer plan was created[\s\S]*END THIS TURN/u,
    );
    assert.doesNotMatch(visibleToolSurface(switchRequired), /wallet_switch_saved_profile/u);
    const switchContext = switchRequired._meta?.[HERMES_MODEL_CONTEXT_KEY] as {
      response_mode?: string;
    } | undefined;
    assert.equal(
      switchContext?.response_mode,
      "preview_then_stop",
    );
    assert.deepEqual(switchRequired._meta?.[HERMES_TURN_CONTROL_KEY], {
      schema_version: 1,
      boundary: "new_user_turn",
      continuation: {
        tool: "wallet_apply_saved_profile_load",
        binding: {
          wallet_name: "agent-boost",
          expected_active_wallet_name: "new_private_wallet",
          expected_active_selection_epoch: 2,
        },
      },
    });
    const switchOutput = authoritativeOutput(switchRequired) ?? "";
    assert.match(switchOutput, /^\*\*Confirm source-wallet switch\*\*/u);
    assert.match(switchOutput, /\*\*From:\*\* agent-boost/u);
    assert.match(switchOutput, /\*\*Transfer kept:\*\* regular/u);
    assert.match(switchOutput, /Transfer kept:.*new_private_wallet.*main\/public receiving account/u);
    assert.doesNotMatch(switchOutput, /wallet_|selection_epoch|decision_id/u);

    runtime.planPrivatePayment = async () => {
      throw new AgentBoostRequestError(
        "USE_RECOVERY_TRANSFER",
        "Moving private funds to agent-boost main is a recovery transfer, not a private payment.",
        {
          source_wallet_name: "agent-boost",
          recipient_wallet_name: "agent-boost",
          resolved_account: "main",
          required_action: "plan_recovery_transfer",
        },
      );
    };
    const useRecovery = await client.callTool({
      name: "wallet_preview_private_transfer",
      arguments: {
        source: "$selected",
        destination: "agent boost wallet",
        amount_native: "0.1",
      },
    });
    assert.equal((useRecovery.structuredContent as { code: string }).code, "USE_RECOVERY_TRANSFER");
    assert.match(
      visibleToolSurface(useRecovery),
      /recovery transfer[\s\S]*No private-payment plan was created/iu,
    );
    assert.match(
      visibleToolSurface(useRecovery),
      /wallet_preview_recovery_transfer/u,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("chat confirmation is primary across every confirm-mode tool", async () => {
  const runtime = fakeRuntime();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client(
    { name: "chat-confirmation-priority-test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  ));
  let elicitationCalls = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    elicitationCalls += 1;
    return { action: "decline" };
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = await client.listTools();
    for (const name of [
      "wallet_create",
      "wallet_adopt_existing",
      "wallet_apply_saved_profile_load",
      "wallet_archive",
      "wallet_apply_reauthorization",
      "wallet_apply_policy_update",
      "wallet_execute_regular_transfer",
      "wallet_execute_private_transfer",
      "wallet_execute_recovery_transfer",
      "wallet_start_new_demo",
    ]) {
      const description = tools.tools.find((tool) => tool.name === name)?.description ?? "";
      assert.match(
        description,
        /chat|conversation|(?:new|later) user (?:message|turn)/iu,
        `${name} must describe chat confirmation`,
      );
      assert.doesNotMatch(
        description,
        FORBIDDEN_CONFIRMATION_SURFACE_VOCABULARY,
        `${name} must not send the user to another interface`,
      );
    }
    const previewLoadSchema = tools.tools.find(
      (tool) => tool.name === "wallet_preview_saved_profile_load",
    )
      ?.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    assert.deepEqual(
      Object.keys(previewLoadSchema?.properties ?? {}),
      ["wallet_name"],
      "saved-profile load preview accepts only the friendly-reference field",
    );
    assert.deepEqual(previewLoadSchema?.required, ["wallet_name"]);
    const applyLoadSchema = tools.tools.find(
      (tool) => tool.name === "wallet_apply_saved_profile_load",
    )
      ?.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    assert.deepEqual(Object.keys(applyLoadSchema?.properties ?? {}), [
      "wallet_name",
      "expected_active_wallet_name",
      "expected_active_selection_epoch",
      "user_confirmed",
    ]);
    assert.deepEqual(applyLoadSchema?.required, [
      "wallet_name",
      "expected_active_wallet_name",
      "expected_active_selection_epoch",
      "user_confirmed",
    ]);
    const selectDescription = tools.tools.find(
      (tool) => tool.name === "wallet_apply_saved_profile_load",
    )?.description ?? "";
    assert.match(
      selectDescription,
      /only after a later user turn[\s\S]*preceding saved-profile or transfer-source load preview/iu,
    );
    assert.match(selectDescription, /Never call this as an initial transfer step/u);
    assert.match(selectDescription, /same result includes the exact reauthorization preview/u);
    const reauthorizationPlanDescription = tools.tools.find(
      (tool) => tool.name === "wallet_plan_reauthorization",
    )?.description ?? "";
    assert.match(reauthorizationPlanDescription, /standalone tool only/u);
    assert.match(reauthorizationPlanDescription, /END THIS TURN/u);

    const regularPlan = await client.callTool({
      name: "wallet_preview_regular_transfer",
      arguments: {
        source: "$selected",
        destination: "0x2222222222222222222222222222222222222222",
        amount_native: 66,
      },
    });
    assert.equal(
      (regularPlan.structuredContent as { code: string }).code,
      "REGULAR_TRANSFER_PLANNED",
    );
    assert.equal(
      (regularPlan.structuredContent as {
        data: { plan: { amountWei: string } };
      }).data.plan.amountWei,
      "66000000000000000000",
    );

    const privatePlan = await client.callTool({
      name: "wallet_preview_private_transfer",
      arguments: {
        source: "$selected",
        destination: "0x2222222222222222222222222222222222222222",
        amount_native: "0.02",
      },
    });
    const recoveryPlan = await client.callTool({
      name: "wallet_preview_recovery_transfer",
      arguments: {
        source: "$selected",
        destination: "0x2222222222222222222222222222222222222222",
        amount_native: "0.1",
      },
    });
    const reauthorizationPlan = await client.callTool({
      name: "wallet_plan_reauthorization",
      arguments: {},
    });
    const policyPlan = await client.callTool({
      name: "wallet_plan_policy_update",
      arguments: { max_payments: 10, per_payment_limit_native: "1" },
    });
    for (const planned of [
      regularPlan,
      privatePlan,
      recoveryPlan,
      reauthorizationPlan,
      policyPlan,
    ]) {
      assert.doesNotMatch(
        visibleToolSurface(planned),
        new RegExp(
          `${FORBIDDEN_CONFIRMATION_SURFACE_VOCABULARY.source}|mcp_elicitation`,
          "iu",
        ),
      );
      assertNoVisibleInternalIds(planned);
      const context = planned._meta?.[HERMES_MODEL_CONTEXT_KEY] as {
        response_mode?: string;
        instruction?: string;
      } | undefined;
      assert.equal(context?.response_mode, "preview_then_stop");
      assert.match(context?.instruction ?? "", /^HARD TURN BOUNDARY:/u);
      assert.doesNotMatch(
        `${visibleToolSurface(planned)}\n${JSON.stringify(context)}`,
        CONFIRMATION_ACTION_TOOL_PATTERN,
      );
    }

    const missingConfirmations: Array<{
      name: string;
      arguments: Record<string, unknown>;
      code: string;
      continuation: {
        tool: string;
        binding: Record<string, string | number>;
      };
    }> = [
      {
        name: "wallet_create",
        arguments: { name: "travel-wallet" },
        code: "WALLET_CREATE_CONFIRMATION_REQUIRED",
        continuation: {
          tool: "wallet_create",
          binding: {
            name: "travel-wallet",
            expected_active_wallet_name: "agent-boost",
            expected_active_selection_epoch: 1,
          },
        },
      },
      {
        name: "wallet_adopt_existing",
        arguments: { name: "imported-wallet" },
        code: "WALLET_ADOPT_CONFIRMATION_REQUIRED",
        continuation: {
          tool: "wallet_adopt_existing",
          binding: {
            name: "imported-wallet",
            expected_active_wallet_name: "agent-boost",
            expected_active_selection_epoch: 1,
          },
        },
      },
      {
        name: "wallet_preview_saved_profile_load",
        arguments: { wallet_name: "saved-wallet" },
        code: "WALLET_SELECT_CONFIRMATION_REQUIRED",
        continuation: {
          tool: "wallet_apply_saved_profile_load",
          binding: {
            wallet_name: "saved-wallet",
            expected_active_wallet_name: "agent-boost",
            expected_active_selection_epoch: 1,
          },
        },
      },
      {
        name: "wallet_archive",
        arguments: { wallet_name: "saved-wallet" },
        code: "WALLET_ARCHIVE_CONFIRMATION_REQUIRED",
        continuation: {
          tool: "wallet_archive",
          binding: { wallet_name: "saved-wallet" },
        },
      },
      {
        name: "wallet_apply_reauthorization",
        arguments: { decision_id: "wra_12345678" },
        code: "WALLET_REAUTHORIZATION_CONFIRMATION_REQUIRED",
        continuation: {
          tool: "wallet_apply_reauthorization",
          binding: { decision_id: "wra_12345678" },
        },
      },
      {
        name: "wallet_apply_policy_update",
        arguments: { decision_id: "wpd_12345678" },
        code: "POLICY_UPDATE_CONFIRMATION_REQUIRED",
        continuation: {
          tool: "wallet_apply_policy_update",
          binding: { decision_id: "wpd_12345678" },
        },
      },
      {
        name: "wallet_execute_regular_transfer",
        arguments: { decision_id: "rwd_12345678" },
        code: "REGULAR_TRANSFER_CONFIRMATION_REQUIRED",
        continuation: {
          tool: "wallet_execute_regular_transfer",
          binding: { decision_id: "rwd_12345678" },
        },
      },
      {
        name: "wallet_execute_private_transfer",
        arguments: { decision_id: "wd_12345678" },
        code: "PAYMENT_CONFIRMATION_REQUIRED",
        continuation: {
          tool: "wallet_execute_private_transfer",
          binding: { decision_id: "wd_12345678" },
        },
      },
      {
        name: "wallet_execute_recovery_transfer",
        arguments: { decision_id: "wr_12345678" },
        code: "RECOVERY_CONFIRMATION_REQUIRED",
        continuation: {
          tool: "wallet_execute_recovery_transfer",
          binding: { decision_id: "wr_12345678" },
        },
      },
      {
        name: "wallet_start_new_demo",
        arguments: {},
        code: "DEMO_RESET_CONFIRMATION_REQUIRED",
        continuation: {
          tool: "wallet_start_new_demo",
          binding: {
            expected_active_wallet_name: "agent-boost",
            expected_active_selection_epoch: 1,
          },
        },
      },
    ];

    for (const confirmation of missingConfirmations) {
      const response = await client.callTool({
        name: confirmation.name,
        arguments: confirmation.arguments,
      });
      const structured = response.structuredContent as {
        code: string;
        outcome: string;
        data: { confirmation_mode?: string; reason?: string };
      };
      assert.equal(structured.code, confirmation.code);
      assert.equal(structured.outcome, "blocked");
      assert.equal(structured.data.confirmation_mode, "chat");
      assert.equal(structured.data.reason, undefined);
      assertNoVisibleInternalIds(response);
      const context = response._meta?.[HERMES_MODEL_CONTEXT_KEY] as {
        response_mode?: string;
        instruction?: string;
      } | undefined;
      assert.equal(context?.response_mode, "preview_then_stop");
      assert.match(context?.instruction ?? "", /^HARD TURN BOUNDARY:/u);
      assert.deepEqual(response._meta?.[HERMES_TURN_CONTROL_KEY], {
        schema_version: 1,
        boundary: "new_user_turn",
        continuation: confirmation.continuation,
      });
      assert.doesNotMatch(
        `${visibleToolSurface(response)}\n${JSON.stringify(context)}`,
        CONFIRMATION_ACTION_TOOL_PATTERN,
      );
    }
    assert.equal(
      elicitationCalls,
      0,
      "missing chat confirmation must never open MCP elicitation",
    );

    const confirmations: Array<{
      name: string;
      arguments: Record<string, unknown>;
      code: string;
    }> = [
      {
        name: "wallet_create",
        arguments: {
          name: "travel-wallet",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
          user_confirmed: true,
        },
        code: "WALLET_CREATED",
      },
      {
        name: "wallet_adopt_existing",
        arguments: {
          name: "imported-wallet",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
          user_confirmed: true,
        },
        code: "WALLET_ADOPTED",
      },
      {
        name: "wallet_apply_saved_profile_load",
        arguments: {
          wallet_name: "saved-wallet",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
          user_confirmed: true,
        },
        code: "WALLET_SELECTED",
      },
      {
        name: "wallet_archive",
        arguments: { wallet_name: "saved-wallet", user_confirmed: true },
        code: "WALLET_ARCHIVED",
      },
      {
        name: "wallet_apply_reauthorization",
        arguments: { decision_id: "wra_12345678", user_confirmed: true },
        code: "WALLET_REAUTHORIZED",
      },
      {
        name: "wallet_apply_policy_update",
        arguments: { decision_id: "wpd_12345678", user_confirmed: true },
        code: "POLICY_UPDATED",
      },
      {
        name: "wallet_execute_regular_transfer",
        arguments: { decision_id: "rwd_12345678", user_confirmed: true },
        code: "REGULAR_TRANSFER_STATUS",
      },
      {
        name: "wallet_execute_private_transfer",
        arguments: { decision_id: "wd_12345678", user_confirmed: true },
        code: "PAYMENT_STATUS",
      },
      {
        name: "wallet_execute_recovery_transfer",
        arguments: { decision_id: "wr_12345678", user_confirmed: true },
        code: "RECOVERY_STATUS",
      },
      {
        name: "wallet_start_new_demo",
        arguments: {
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
          user_confirmed: true,
        },
        code: "DEMO_RESET_STARTED",
      },
    ];

    for (const confirmation of confirmations) {
      const response = await client.callTool({
        name: confirmation.name,
        arguments: confirmation.arguments,
      });
      assert.equal(
        (response.structuredContent as { code: string }).code,
        confirmation.code,
        `${confirmation.name} must honor the chat confirmation`,
      );
      if (
        confirmation.code === "WALLET_CREATED" ||
        confirmation.code === "WALLET_ADOPTED" ||
        confirmation.code === "WALLET_ARCHIVED" ||
        confirmation.code === "DEMO_RESET_STARTED"
      ) {
        assert.equal(
          (response._meta?.[HERMES_USER_FACING_OUTPUT_KEY] as {
            complete_turn?: boolean;
          } | undefined)?.complete_turn,
          true,
        );
      }
      assertNoVisibleInternalIds(response);
    }
    assert.equal(
      elicitationCalls,
      0,
      "user_confirmed:true must bypass an advertised MCP elicitation handler",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP chat payment confirmation executes, cancels, and never opens another surface", async (t) => {
  await t.test("explicit chat attestation executes the exact plan", async () => {
    const runtime = fakeRuntime();
    let executeCalls = 0;
    const execute = runtime.executePrivatePayment;
    runtime.executePrivatePayment = async (input) => {
      executeCalls += 1;
      assert.equal(input.userConfirmed, true);
      return execute(input);
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await createMcpServer(runtime);
    const client = testMcpClient(new Client(
      { name: "chat-confirmation-test", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    ));
    let elicitationCalls = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      elicitationCalls += 1;
      return { action: "accept", content: {} };
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "wallet_execute_private_transfer",
        arguments: { decision_id: "wd_12345678", user_confirmed: true },
      });
      assert.equal(
        (response.structuredContent as { code: string }).code,
        "PAYMENT_STATUS",
      );
      assert.equal(executeCalls, 1);
      assert.equal(elicitationCalls, 0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  await t.test("explicit chat decline never executes", async () => {
    const runtime = fakeRuntime();
    let executed = false;
    runtime.executePrivatePayment = async () => {
      executed = true;
      throw new Error("must not execute");
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await createMcpServer(runtime);
    const client = testMcpClient(new Client(
      { name: "chat-decline-test", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    ));
    let elicitationCalls = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      elicitationCalls += 1;
      return { action: "accept", content: {} };
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "wallet_execute_private_transfer",
        arguments: { decision_id: "wd_12345678", user_confirmed: false },
      });
      const structured = response.structuredContent as {
        code: string;
        outcome: string;
        presentation: { state: string; next_action: string };
      };
      assert.equal(structured.code, "PAYMENT_CANCELLED");
      assert.equal(structured.outcome, "blocked");
      assert.equal(structured.presentation.state, "cancelled");
      assertCompactTerminalReceipt(
        response,
        [/Payment cancelled/u, /Nothing was sent\.$/u],
        2,
      );
      assert.equal(executed, false);
      assert.equal(elicitationCalls, 0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  await t.test("missing attestation stays pending even when the client advertises elicitation", async () => {
    const runtime = fakeRuntime();
    let executed = false;
    runtime.executePrivatePayment = async () => {
      executed = true;
      throw new Error("must not execute");
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await createMcpServer(runtime);
    const client = testMcpClient(new Client(
      { name: "missing-chat-confirmation-test", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    ));
    let elicitationCalls = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      elicitationCalls += 1;
      return { action: "accept", content: {} };
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "wallet_execute_private_transfer",
        arguments: { decision_id: "wd_12345678" },
      });
      const structured = response.structuredContent as {
        code: string;
        outcome: string;
        data: { reason?: string; confirmation_mode: string };
        presentation: { state: string };
      };
      assert.equal(structured.code, "PAYMENT_CONFIRMATION_REQUIRED");
      assert.equal(structured.outcome, "blocked");
      assert.equal(structured.data.confirmation_mode, "chat");
      assert.equal(structured.data.reason, undefined);
      assert.equal(structured.presentation.state, "pending");
      assert.doesNotMatch(visibleToolSurface(response), /cancelled/iu);
      assert.equal(executed, false);
      assert.equal(elicitationCalls, 0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  await t.test("client without elicitation receives a text fallback contract", async () => {
    const runtime = fakeRuntime();
    let executed = false;
    runtime.executePrivatePayment = async () => {
      executed = true;
      throw new Error("must not execute");
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await createMcpServer(runtime);
    const client = testMcpClient(new Client({ name: "legacy-test", version: "1.0.0" }));
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "wallet_execute_private_transfer",
        arguments: { decision_id: "wd_12345678" },
      });
      const structured = response.structuredContent as {
        code: string;
        presentation: {
          kind: string;
          fields: Array<{ label: string; value: string }>;
          interaction?: unknown;
        };
      };
      assert.equal(structured.code, "PAYMENT_CONFIRMATION_REQUIRED");
      assert.equal(structured.presentation.kind, "confirmation");
      assert.equal(structured.presentation.interaction, undefined);
      assert.deepEqual(
        structured.presentation.fields.map((field) => field.label),
        ["Amount", "To", "Network"],
      );
      assert.equal(executed, false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("an explicit chat decline cancels allow-mode transfers instead of executing", async () => {
  const runtime = fakeRuntime();
  const regularPlan = runtime.getRegularTransferPlan.bind(runtime);
  const privatePlan = runtime.getPaymentPlan.bind(runtime);
  let regularState = {
    ...(await regularPlan("rwd_12345678")),
    approval: { action: "allow", userConfirmationRequired: false },
  } as const;
  let privateState = {
    ...(await privatePlan("wd_12345678")),
    approval: { action: "allow", userConfirmationRequired: false },
  } as const;
  runtime.getRegularTransferPlan = async () => regularState;
  runtime.getPaymentPlan = async () => privateState;
  const cancelled: string[] = [];
  runtime.cancelRegularTransferPlan = async (decisionId) => {
    cancelled.push(decisionId);
    regularState = {
      ...regularState,
      decision: "deny",
      blockers: [...regularState.blockers, "USER_CANCELLED"],
    };
    return regularState;
  };
  runtime.cancelPrivatePaymentPlan = async (decisionId) => {
    cancelled.push(decisionId);
    privateState = {
      ...privateState,
      decision: "deny",
      blockers: [...privateState.blockers, "USER_CANCELLED"],
    };
    return privateState;
  };
  let executionCalls = 0;
  runtime.executeRegularTransfer = async () => {
    executionCalls += 1;
    throw new Error("explicit false must not execute a regular transfer");
  };
  runtime.executePrivatePayment = async () => {
    executionCalls += 1;
    throw new Error("explicit false must not execute a private payment");
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client(
    { name: "allow-mode-chat-decline-test", version: "1.0.0" },
  ));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const regular = await client.callTool({
      name: "wallet_execute_regular_transfer",
      arguments: { decision_id: "rwd_12345678", user_confirmed: false },
    });
    const privatePayment = await client.callTool({
      name: "wallet_execute_private_transfer",
      arguments: { decision_id: "wd_12345678", user_confirmed: false },
    });
    const regularWithoutAttestation = await client.callTool({
      name: "wallet_execute_regular_transfer",
      arguments: { decision_id: "rwd_12345678" },
    });
    const regularRetriedApproval = await client.callTool({
      name: "wallet_execute_regular_transfer",
      arguments: { decision_id: "rwd_12345678", user_confirmed: true },
    });
    const privateWithoutAttestation = await client.callTool({
      name: "wallet_execute_private_transfer",
      arguments: { decision_id: "wd_12345678" },
    });
    const privateRetriedApproval = await client.callTool({
      name: "wallet_execute_private_transfer",
      arguments: { decision_id: "wd_12345678", user_confirmed: true },
    });

    for (const [index, response] of [
      regular,
      regularWithoutAttestation,
      regularRetriedApproval,
    ].entries()) {
      const structured = response.structuredContent as {
        code: string;
        data: { reason: string; plan: { decision: string; blockers: string[] } };
        presentation: { state: string; next_action: string };
      };
      assert.equal(structured.code, "REGULAR_TRANSFER_CANCELLED");
      assert.equal(structured.data.reason, index === 0 ? "decline" : "cancel");
      assert.equal(structured.data.plan.decision, "deny");
      assert.ok(structured.data.plan.blockers.includes("USER_CANCELLED"));
      assert.equal(structured.presentation.state, "cancelled");
      assert.match(structured.presentation.next_action, /no transfer is pending/iu);
      assertCompactTerminalReceipt(
        response,
        [/Regular transfer cancelled/u, /Nothing was sent\.$/u],
        2,
      );
    }
    for (const [index, response] of [
      privatePayment,
      privateWithoutAttestation,
      privateRetriedApproval,
    ].entries()) {
      const structured = response.structuredContent as {
        code: string;
        data: { reason: string; plan: { decision: string; blockers: string[] } };
        presentation: { state: string; next_action: string };
      };
      assert.equal(structured.code, "PAYMENT_CANCELLED");
      assert.equal(structured.data.reason, index === 0 ? "decline" : "cancel");
      assert.equal(structured.data.plan.decision, "deny");
      assert.ok(structured.data.plan.blockers.includes("USER_CANCELLED"));
      assert.equal(structured.presentation.state, "cancelled");
      assert.match(structured.presentation.next_action, /no payment is pending/iu);
      assertCompactTerminalReceipt(
        response,
        [/Payment cancelled/u, /Nothing was sent\.$/u],
        2,
      );
    }
    assert.deepEqual(cancelled, ["rwd_12345678", "wd_12345678"]);
    assert.equal(executionCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("native amount schemas accept exact strings and whole JSON numbers", async () => {
  const runtime = fakeRuntime();
  const plannedAmounts: string[] = [];
  const planRegularTransfer = runtime.planRegularTransfer.bind(runtime);
  runtime.planRegularTransfer = async (input) => {
    plannedAmounts.push(input.amountWei);
    return planRegularTransfer(input);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client(
    { name: "native-amount-precision-test", version: "1.0.0" },
  ));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const fractional = await client.callTool({
      name: "wallet_plan_regular_transfer",
      arguments: {
        recipient: "0x2222222222222222222222222222222222222222",
        amount_native: 0.1,
      },
    });
    assert.equal(fractional.isError, true);
    assert.equal(plannedAmounts.length, 0, "fractional JSON numbers must fail before planning");

    const fractionalString = await client.callTool({
      name: "wallet_plan_regular_transfer",
      arguments: {
        recipient: "0x2222222222222222222222222222222222222222",
        amount_native: "0.1",
      },
    });
    assert.equal(fractionalString.isError, undefined);
    assert.deepEqual(plannedAmounts, ["100000000000000000"]);

    const unsafeWhole = await client.callTool({
      name: "wallet_plan_regular_transfer",
      arguments: {
        recipient: "0x2222222222222222222222222222222222222222",
        amount_native: Number.MAX_SAFE_INTEGER + 1,
      },
    });
    assert.equal(unsafeWhole.isError, true);
    assert.equal(plannedAmounts.length, 1, "unsafe JSON integers must fail before planning");

    const whole = await client.callTool({
      name: "wallet_plan_regular_transfer",
      arguments: {
        recipient: "0x2222222222222222222222222222222222222222",
        amount_native: 66,
      },
    });
    assert.equal(whole.isError, undefined);
    assert.deepEqual(plannedAmounts, [
      "100000000000000000",
      "66000000000000000000",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP regular transfer confirmation stays on the public path", async () => {
  const runtime = fakeRuntime();
  let regularCalls = 0;
  let privateCalls = 0;
  const executeRegular = runtime.executeRegularTransfer;
  runtime.executeRegularTransfer = async (input) => {
    regularCalls += 1;
    assert.equal(input.userConfirmed, true);
    return executeRegular(input);
  };
  runtime.executePrivatePayment = async () => {
    privateCalls += 1;
    throw new Error("private path must not execute");
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client(
    { name: "regular-chat-confirmation-test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  ));
  let elicitationCalls = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    elicitationCalls += 1;
    return { action: "accept", content: {} };
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.callTool({
      name: "wallet_execute_regular_transfer",
      arguments: { decision_id: "rwd_12345678", user_confirmed: true },
    });
    assert.equal(
      (response.structuredContent as { code: string }).code,
      "REGULAR_TRANSFER_STATUS",
    );
    assert.equal(regularCalls, 1);
    assert.equal(privateCalls, 0);
    assert.equal(elicitationCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("wallet lifecycle cancellation receipts are specific, compact, and terminal", async () => {
  const runtime = fakeRuntime();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client(
    { name: "wallet-lifecycle-cancellation-receipts", version: "1.0.0" },
  ));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const fixtures: Array<{
      name: string;
      arguments: Record<string, unknown>;
      code: string;
      title: string;
      output: string;
    }> = [
      {
        name: "wallet_create",
        arguments: {
          name: "travel-wallet",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
          user_confirmed: false,
        },
        code: "WALLET_CREATE_CONFIRMATION_REQUIRED",
        title: "Wallet creation cancelled",
        output: "**✕ Wallet creation cancelled**\nNothing changed. No wallet state changed and no signing authority was granted.",
      },
      {
        name: "wallet_adopt_existing",
        arguments: {
          name: "imported-wallet",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
          user_confirmed: false,
        },
        code: "WALLET_ADOPT_CONFIRMATION_REQUIRED",
        title: "Wallet adoption cancelled",
        output: "**✕ Wallet adoption cancelled**\nNothing changed. No wallet state changed and no signing authority was granted.",
      },
      {
        name: "wallet_apply_saved_profile_load",
        arguments: {
          wallet_name: "saved-wallet",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
          user_confirmed: false,
        },
        code: "WALLET_SELECT_CONFIRMATION_REQUIRED",
        title: "Wallet switch cancelled",
        output: "**✕ Wallet switch cancelled**\nNothing changed. No wallet state changed and no signing authority was granted.",
      },
      {
        name: "wallet_archive",
        arguments: { wallet_name: "saved-wallet", user_confirmed: false },
        code: "WALLET_ARCHIVE_CONFIRMATION_REQUIRED",
        title: "Wallet archive cancelled",
        output: "**✕ Wallet archive cancelled**\nNothing changed. No wallet state changed and no signing authority was granted.",
      },
      {
        name: "wallet_start_new_demo",
        arguments: {
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
          user_confirmed: false,
        },
        code: "DEMO_RESET_CONFIRMATION_REQUIRED",
        title: "New demo cancelled",
        output: "**✕ New demo cancelled**\nYour current wallet and workflow are unchanged.",
      },
    ];

    for (const fixture of fixtures) {
      const response = await client.callTool({
        name: fixture.name,
        arguments: fixture.arguments,
      });
      const structured = response.structuredContent as {
        code: string;
        presentation: {
          kind: string;
          title: string;
          state: string;
          notice: { text: string };
          next_action: string;
        };
      };
      assert.equal(structured.code, fixture.code);
      assert.equal(structured.presentation.kind, "status");
      assert.equal(structured.presentation.title, fixture.title);
      assert.equal(structured.presentation.state, "cancelled");
      assert.match(structured.presentation.next_action, /no .+ pending/iu);
      assert.doesNotMatch(structured.presentation.notice.text, /\bwill\b/iu);
      assert.equal(authoritativeOutput(response), fixture.output);
      assertCompactTerminalReceipt(response, [/cancelled/iu, /(?:unchanged|Nothing changed)/u], 2);
      assertNoVisibleInternalIds(response);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("a committed wallet change reports setup continuation failure without inviting a retry", async () => {
  const runtime = fakeRuntime();
  runtime.createWallet = async () => ({
    wallet: {
      wallet_id: "wallet_created_12345678",
      name: "travel-wallet",
      active: true,
      selection_epoch: 2,
    },
    archive_id: "archive_created_12345678",
    setup_phase: "not_started",
    setup_continuation_status: "unavailable",
    authorization_required: true,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({
    name: "wallet-post-commit-setup-failure-test",
    version: "1.0.0",
  }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.callTool({
      name: "wallet_create",
      arguments: {
        name: "travel-wallet",
        expected_active_wallet_name: "agent-boost",
        expected_active_selection_epoch: 1,
        user_confirmed: true,
      },
    });
    const structured = response.structuredContent as {
      code: string;
      presentation: {
        state: string;
        notice: { text: string };
        next_action: string;
      };
    };
    assert.equal(structured.code, "WALLET_CREATED");
    assert.equal(structured.presentation.state, "attention");
    assert.match(structured.presentation.notice.text, /selection completed/iu);
    assert.match(structured.presentation.notice.text, /do not repeat/iu);
    assert.match(structured.presentation.next_action, /resume setup separately/iu);
    assert.equal(
      authoritativeOutput(response),
      [
        "**! Wallet selected; setup needs attention**",
        "**travel-wallet** is selected. The wallet change completed.",
        "Automatic setup could not continue. Do not repeat the wallet action; ask me to check setup.",
      ].join("\n"),
    );
    assert.equal(
      (response._meta?.["org.agentboost/user-facing-output"] as {
        complete_turn?: boolean;
      } | undefined)?.complete_turn,
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("wallet creation ends with a phase-correct setup or authorization handoff", async (t) => {
  const fixtures = [
    {
      name: "awaiting funding",
      setupPhase: "awaiting_funding",
      expectedOutput: [
        "**✓ Wallet created**",
        "**travel-wallet** is selected; your earlier wallets remain saved.",
        "**1/3 · Fund your test wallet**",
        "Send **0.15 Sepolia ETH**. Testnet only; it has no monetary value.",
        "A funding QR is attached to this message.",
        "**Next:** Reply **✅** or say **sent** after submitting the transfer.",
      ].join("\n"),
      expectedAction: /send 0\.15 Sepolia ETH.*attached QR/iu,
      forbiddenAction: /continue setup|authorize it/iu,
      expectedInstruction: /Funding needed now: 0\.15 Sepolia ETH/iu,
      safetyInstruction: /plan reauthorization until setup reports private_ready/iu,
    },
    {
      name: "private ready",
      setupPhase: "private_ready",
      expectedOutput: [
        "**✓ Wallet created**",
        "**travel-wallet** is selected; your earlier wallets remain saved.",
        "**Next:** Reply **authorize it** to preview bounded Sepolia transfer permission.",
      ].join("\n"),
      expectedAction: /authorize it/iu,
      forbiddenAction: /continue setup/iu,
      expectedInstruction: /reply "authorize it" in a new chat message/iu,
      safetyInstruction: /Do not create a wallet reauthorization preview in this assistant turn/iu,
    },
  ] as const;

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const runtime = fakeRuntime();
      const started = await runtime.startOnboarding();
      runtime.createWallet = async (input) => ({
        wallet: {
          wallet_id: "wallet_created_12345678",
          name: input.name,
          active: true,
          selection_epoch: 2,
        },
        setup_phase: fixture.setupPhase,
        setup: {
          setupId: "setup_wallet_created_12345678",
          revision: 4,
          phase: fixture.setupPhase,
        },
        ...(fixture.setupPhase === "awaiting_funding"
          ? {
              onboarding: {
                snapshot: {
                  ...started.snapshot,
                  setupId: "setup_wallet_created_12345678",
                  revision: 4,
                  phase: fixture.setupPhase,
                },
                uiOpened: started.uiOpened,
                ...(started.qrPngBase64
                  ? { qrPngBase64: started.qrPngBase64 }
                  : {}),
              },
            }
          : {}),
        authorization_required: true,
      });
      let reauthorizationPlanCalls = 0;
      runtime.planWalletReauthorization = async () => {
        reauthorizationPlanCalls += 1;
        throw new Error("wallet_create must not cross its complete-turn boundary");
      };
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = await createMcpServer(runtime);
      const client = testMcpClient(new Client({
        name: `wallet-created-${fixture.setupPhase}-handoff-test`,
        version: "1.0.0",
      }));
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const response = await client.callTool({
          name: "wallet_create",
          arguments: {
            name: "travel-wallet",
            expected_active_wallet_name: "agent-boost",
            expected_active_selection_epoch: 1,
            user_confirmed: true,
          },
        });
        const structured = response.structuredContent as {
          code: string;
          presentation: { next_action: string };
          data: {
            setup?: { setupId: string; revision: number; phase: string };
            public?: { setupId: string; revision: number; phase: string };
            funding?: {
              address?: string;
              remaining_amount_wei: string;
              remaining_amount_eth: string;
              qr_attached: boolean;
            };
            ui_opened?: boolean;
            onboarding?: unknown;
          };
        };
        assert.equal(structured.code, "WALLET_CREATED");
        if (fixture.setupPhase === "awaiting_funding") {
          assert.equal(structured.data.setup?.setupId, "setup_wallet_created_12345678");
          assert.equal(structured.data.setup?.revision, 4);
          assert.equal(structured.data.setup?.phase, "awaiting_funding");
          assert.deepEqual(structured.data.public, structured.data.setup);
          assert.equal(structured.data.funding?.address, WALLET_ADDRESS);
          assert.equal(
            structured.data.funding?.remaining_amount_wei,
            "150000000000000000",
          );
          assert.equal(structured.data.funding?.remaining_amount_eth, "0.15");
          assert.equal(structured.data.funding?.qr_attached, true);
          assert.equal(structured.data.ui_opened, true);
          assert.equal(
            response.content.some((block) => block.type === "image"),
            true,
          );
        } else {
          assert.equal(structured.data.setup, undefined);
        }
        assert.equal(structured.data.onboarding, undefined);
        assert.match(structured.presentation.next_action, fixture.expectedAction);
        assert.doesNotMatch(structured.presentation.next_action, fixture.forbiddenAction);
        assert.equal(authoritativeOutput(response), fixture.expectedOutput);
        assert.equal(
          (response._meta?.[HERMES_USER_FACING_OUTPUT_KEY] as {
            complete_turn?: boolean;
          } | undefined)?.complete_turn,
          true,
        );
        const text = response.content.find((block) => block.type === "text");
        assert.equal(text?.type, "text");
        assert.match(text.text, /END THIS TURN/iu);
        assert.match(text.text, fixture.expectedInstruction);
        assert.match(text.text, fixture.safetyInstruction);
        assert.doesNotMatch(visibleToolSurface(response), /setup_wallet_created_12345678/u);
        assert.equal(reauthorizationPlanCalls, 0);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});

test("standalone reauthorization validates a named wallet without silently switching it", async () => {
  const runtime = fakeRuntime();
  let listCalls = 0;
  let planCalls = 0;
  let selectCalls = 0;
  const originalList = runtime.listWallets.bind(runtime);
  const originalPlan = runtime.planWalletReauthorization.bind(runtime);
  runtime.listWallets = async () => {
    listCalls += 1;
    return originalList();
  };
  runtime.planWalletReauthorization = async () => {
    planCalls += 1;
    return originalPlan();
  };
  runtime.selectWallet = async (input) => {
    selectCalls += 1;
    return { wallet: { name: input.walletId }, authorization_required: true };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({
    name: "named-reauthorization-test",
    version: "1.0.0",
  }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const active = await client.callTool({
      name: "wallet_plan_reauthorization",
      arguments: { wallet_name: "agent-boost" },
    });
    assert.equal(
      (active.structuredContent as { code: string }).code,
      "WALLET_REAUTHORIZATION_PLANNED",
    );
    assert.match(authoritativeOutput(active) ?? "", /Authorize wallet transfers/iu);
    assert.equal(listCalls, 1);
    assert.equal(planCalls, 1);
    assert.equal(selectCalls, 0);

    const inactive = await client.callTool({
      name: "wallet_plan_reauthorization",
      arguments: { wallet_name: "saved-wallet" },
    });
    assert.equal(
      (inactive.structuredContent as { code: string }).code,
      "WALLET_REAUTHORIZATION_REQUIRES_ACTIVE_WALLET",
    );
    assert.equal(
      authoritativeOutput(inactive),
      [
        "**Select wallet first**",
        "**saved-wallet** is saved, but it is not the active wallet.",
        "Ask me to load it first; authorization is a separate confirmed step. Nothing changed.",
      ].join("\n"),
    );
    assert.equal(
      (inactive._meta?.["org.agentboost/user-facing-output"] as {
        complete_turn?: boolean;
      } | undefined)?.complete_turn,
      true,
    );
    assert.equal(listCalls, 2);
    assert.equal(planCalls, 1);
    assert.equal(selectCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("named reauthorization fails closed if the active wallet changes during planning", async () => {
  const runtime = fakeRuntime();
  let planCalls = 0;
  let cancelCalls = 0;
  let selectCalls = 0;
  const originalPlan = runtime.planWalletReauthorization.bind(runtime);
  runtime.planWalletReauthorization = async () => {
    planCalls += 1;
    return {
      ...(await originalPlan()),
      decisionId: "wra_concurrent-switch",
      wallet: {
        walletId: "wallet_87654321",
        walletName: "saved-wallet",
        selectionEpoch: 2,
      },
    };
  };
  runtime.cancelWalletReauthorizationPlan = async (decisionId) => {
    cancelCalls += 1;
    assert.equal(decisionId, "wra_concurrent-switch");
    throw new Error("simulated cancellation cleanup failure");
  };
  runtime.selectWallet = async (input) => {
    selectCalls += 1;
    return { wallet: { name: input.walletId }, authorization_required: true };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({
    name: "named-reauthorization-race-test",
    version: "1.0.0",
  }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.callTool({
      name: "wallet_plan_reauthorization",
      arguments: { wallet_name: "agent-boost" },
    });
    assert.equal(
      (response.structuredContent as { code: string }).code,
      "WALLET_REAUTHORIZATION_REQUIRES_ACTIVE_WALLET",
    );
    assert.equal(
      authoritativeOutput(response),
      [
        "**Select wallet first**",
        "**agent-boost** is saved, but it is not the active wallet.",
        "Ask me to load it first; authorization is a separate confirmed step. Nothing changed.",
      ].join("\n"),
    );
    assert.doesNotMatch(
      JSON.stringify(response.structuredContent),
      /wra_concurrent-switch|saved-wallet/u,
    );
    assert.equal(planCalls, 1);
    assert.equal(cancelCalls, 1);
    assert.equal(selectCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("wallet lifecycle results carry one validated unresolved setup status binding", async (t) => {
  const fixtures = [
    {
      label: "created wallet",
      tool: "wallet_create",
      arguments: {
        name: "travel-wallet",
        expected_active_wallet_name: "agent-boost",
        expected_active_selection_epoch: 1,
        user_confirmed: true,
      },
      code: "WALLET_CREATED",
      phase: "awaiting_funding",
      configure(runtime: AgentBoostRuntime, setup: Record<string, unknown>) {
        runtime.createWallet = async () => ({
          wallet: { name: "travel-wallet" },
          setup_phase: "awaiting_funding",
          setup,
          authorization_required: true,
        });
      },
    },
    {
      label: "adopted wallet",
      tool: "wallet_adopt_existing",
      arguments: {
        name: "imported-wallet",
        expected_active_wallet_name: "agent-boost",
        expected_active_selection_epoch: 1,
        user_confirmed: true,
      },
      code: "WALLET_ADOPTED",
      phase: "shielding",
      configure(runtime: AgentBoostRuntime, setup: Record<string, unknown>) {
        runtime.adoptWallet = async () => ({
          wallet: { name: "imported-wallet" },
          setup_phase: "shielding",
          setup,
          authorization_required: true,
        });
      },
    },
    {
      label: "selected wallet",
      tool: "wallet_apply_saved_profile_load",
      arguments: {
        wallet_name: "saved-wallet",
        expected_active_wallet_name: "agent-boost",
        expected_active_selection_epoch: 1,
        user_confirmed: true,
      },
      code: "WALLET_SELECTED",
      phase: "funding_pending",
      configure(runtime: AgentBoostRuntime, setup: Record<string, unknown>) {
        runtime.selectWallet = async () => ({
          wallet: { name: "saved-wallet" },
          setup_phase: "funding_pending",
          setup,
          authorization_required: true,
        });
      },
    },
  ] as const;

  for (const [index, fixture] of fixtures.entries()) {
    await t.test(fixture.label, async () => {
      const runtime = fakeRuntime();
      const setup = {
        setupId: `setup_lifecycle_${index}_12345678`,
        revision: index + 4,
        phase: fixture.phase,
      };
      fixture.configure(runtime, setup);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = await createMcpServer(runtime);
      const client = testMcpClient(new Client({
        name: `wallet-lifecycle-setup-${index}-test`,
        version: "1.0.0",
      }));
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const response = await client.callTool({
          name: fixture.tool,
          arguments: fixture.arguments,
        });
        const structured = response.structuredContent as {
          code: string;
          data: { setup?: Record<string, unknown> };
        };
        assert.equal(structured.code, fixture.code);
        assert.deepEqual(structured.data.setup, setup);
        const context = response._meta?.[HERMES_MODEL_CONTEXT_KEY] as {
          data?: { setup?: Record<string, unknown> };
        } | undefined;
        assert.deepEqual(context?.data?.setup, setup);
        assert.doesNotMatch(visibleToolSurface(response), new RegExp(setup.setupId, "u"));
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});

test("an actual wallet lifecycle envelope binds Check again to its exact setup", async (t) => {
  const runtime = fakeRuntime();
  const setup = {
    setupId: "setup_mcp_turn_gate_12345678",
    revision: 11,
    phase: "shielding",
  } as const;
  runtime.createWallet = async () => ({
    wallet: { name: "travel-wallet" },
    setup_phase: setup.phase,
    setup,
    authorization_required: true,
  });
  const stateDirectory = await mkdtemp(join(tmpdir(), "agent-boost-mcp-status-bridge-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({
    name: "wallet-lifecycle-status-bridge-test",
    version: "1.0.0",
  }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const arguments_ = {
      name: "travel-wallet",
      expected_active_wallet_name: "agent-boost",
      expected_active_selection_epoch: 1,
      user_confirmed: true,
    };
    await handleHermesTurnGatePayload({
      hook_event_name: "pre_llm_call",
      tool_name: null,
      tool_input: null,
      session_id: "mcp-lifecycle-status-bridge",
      extra: { turn_id: "turn-1", user_message: "Run the lifecycle status bridge fixture." },
    }, { stateDirectory });
    const { user_confirmed: _confirmed, ...dispatchBinding } = arguments_;
    assert.deepEqual(await handleHermesTurnGatePayload({
      hook_event_name: "pre_tool_call",
      tool_name: "mcp__agent_boost__wallet_create",
      tool_input: dispatchBinding,
      session_id: "mcp-lifecycle-status-bridge",
      extra: { turn_id: "turn-1", tool_call_id: "call-0" },
    }, { stateDirectory }), {});
    const response = await client.callTool({ name: "wallet_create", arguments: arguments_ });
    await handleHermesTurnGatePayload({
      hook_event_name: "post_tool_call",
      tool_name: "mcp__agent_boost__wallet_create",
      tool_input: arguments_,
      session_id: "mcp-lifecycle-status-bridge",
      extra: {
        turn_id: "turn-1",
        tool_call_id: "call-1",
        result: response,
      },
    }, { stateDirectory });

    const routed = await handleHermesTurnGatePayload({
      hook_event_name: "pre_llm_call",
      tool_name: null,
      tool_input: null,
      session_id: "mcp-lifecycle-status-bridge",
      extra: { turn_id: "turn-2", user_message: "Check again." },
    }, { stateDirectory });
    assert.ok("context" in routed);
    if ("context" in routed) {
      assert.match(routed.context, /call onboarding_status directly/u);
      assert.match(routed.context, new RegExp(setup.setupId, "u"));
      assert.match(routed.context, /"since_revision":11/u);
    }

    assert.deepEqual(await handleHermesTurnGatePayload({
      hook_event_name: "pre_tool_call",
      tool_name: "mcp__agent_boost__onboarding_status",
      tool_input: { setup_id: "setup_wrong_12345678" },
      session_id: "mcp-lifecycle-status-bridge",
      extra: { turn_id: "turn-2", tool_call_id: "call-2" },
    }, { stateDirectory }), {
      action: "modify",
      args: {
        setup_id: setup.setupId,
        since_revision: setup.revision,
        wait_ms: 30_000,
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("wallet lifecycle setup status bindings fail closed at the MCP envelope", async (t) => {
  const fixtures = [
    {
      label: "terminal setup",
      setupPhase: "private_ready",
      setup: {
        setupId: "setup_terminal_12345678",
        revision: 8,
        phase: "private_ready",
      },
    },
    {
      label: "phase mismatch",
      setupPhase: "awaiting_funding",
      setup: {
        setupId: "setup_mismatch_12345678",
        revision: 8,
        phase: "shielding",
      },
    },
    {
      label: "invalid revision",
      setupPhase: "shielding",
      setup: {
        setupId: "setup_revision_12345678",
        revision: -1,
        phase: "shielding",
      },
    },
  ] as const;

  for (const [index, fixture] of fixtures.entries()) {
    await t.test(fixture.label, async () => {
      const runtime = fakeRuntime();
      runtime.createWallet = async () => ({
        wallet: { name: "travel-wallet" },
        setup_phase: fixture.setupPhase,
        setup: fixture.setup,
        authorization_required: true,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = await createMcpServer(runtime);
      const client = testMcpClient(new Client({
        name: `wallet-lifecycle-invalid-setup-${index}-test`,
        version: "1.0.0",
      }));
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const response = await client.callTool({
          name: "wallet_create",
          arguments: {
            name: "travel-wallet",
            expected_active_wallet_name: "agent-boost",
            expected_active_selection_epoch: 1,
            user_confirmed: true,
          },
        });
        const structured = response.structuredContent as {
          data: { setup?: unknown };
        };
        assert.equal(structured.data.setup, undefined);
        const context = response._meta?.[HERMES_MODEL_CONTEXT_KEY] as {
          data?: { setup?: unknown };
        } | undefined;
        assert.equal(context?.data?.setup, undefined);
        assert.doesNotMatch(visibleToolSurface(response), /setup_(?:terminal|mismatch|revision)/u);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  await t.test("post-commit continuation failure", async () => {
    const runtime = fakeRuntime();
    runtime.createWallet = async () => ({
      wallet: { name: "travel-wallet" },
      setup_phase: "shielding",
      setup_continuation_status: "unavailable",
      setup: {
        setupId: "setup_unavailable_12345678",
        revision: 9,
        phase: "shielding",
      },
      authorization_required: true,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await createMcpServer(runtime);
    const client = testMcpClient(new Client({
      name: "wallet-lifecycle-unavailable-setup-test",
      version: "1.0.0",
    }));
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "wallet_create",
        arguments: {
          name: "travel-wallet",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
          user_confirmed: true,
        },
      });
      const structured = response.structuredContent as { data: { setup?: unknown } };
      assert.equal(structured.data.setup, undefined);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("wallet lifecycle confirmations use friendly names and keep internal IDs out of text", async () => {
  const runtime = fakeRuntime();
  const listWallets = runtime.listWallets.bind(runtime);
  runtime.listWallets = async () => {
    const listing = await listWallets();
    return {
      ...listing,
      unregistered_local_wallets: [{
        name: "local-savings",
        network: "sepolia",
        adoptable: true,
      }],
    };
  };
  const selectWallet = runtime.selectWallet.bind(runtime);
  let observedSwitchInput: Parameters<typeof runtime.selectWallet>[0] | undefined;
  runtime.selectWallet = async (input) => {
    observedSwitchInput = input;
    return {
      ...(await selectWallet(input)),
      wallet: {
        wallet_id: "wallet_87654321",
        name: "saved-wallet",
        selection_epoch: 2,
      },
      setup_phase: "private_ready",
    };
  };
  const planWalletReauthorization = runtime.planWalletReauthorization.bind(runtime);
  let automaticPlanCalls = 0;
  runtime.planWalletReauthorization = async () => {
    automaticPlanCalls += 1;
    return {
      ...(await planWalletReauthorization()),
      wallet: {
        walletId: "wallet_87654321",
        walletName: "saved-wallet",
        selectionEpoch: 2,
      },
    };
  };
  runtime.reauthorizeWallet = async () => ({
    wallet: { name: "saved-wallet" },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client(
    { name: "wallet-lifecycle-chat-test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  ));
  let elicitationCalls = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    elicitationCalls += 1;
    return { action: "accept", content: {} };
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.callTool({ name: "wallet_list_saved_profiles", arguments: {} });
    const listText = list.content.find((block) => block.type === "text");
    assert.equal(listText?.type, "text");
    assert.match(listText.text, /management inventory only/u);
    assert.match(listText.text, /show me my Agent Boost wallets/u);
    assert.match(listText.text, /perform the live wallet-tree read now/u);
    assert.match(listText.text, /saved-wallet/u);
    assert.doesNotMatch(listText.text, /wallet_[A-Za-z0-9-]+/u);
    const listOutput = authoritativeOutput(list) ?? "";
    assert.match(listOutput, /^\*\*Saved wallets\*\*/u);
    assert.match(listOutput, /agent-boost — active; authorization: active/u);
    assert.match(listOutput, /saved-wallet — inactive; authorization: inactive/u);
    assert.match(listOutput, /Ready to adopt:[\s\S]*local-savings — sepolia/u);
    assert.doesNotMatch(listOutput, /wallet_[A-Za-z0-9-]+|0x[0-9a-f]{40}/iu);
    const deprecatedInventoryAlias = await client.callTool({
      name: "wallet_get_saved_profiles",
      arguments: {},
    });
    const deprecatedManagementAlias = await client.callTool({
      name: "wallet_manage_profiles",
      arguments: {},
    });
    const legacyListAlias = await client.callTool({
      name: "wallet_list",
      arguments: {},
    });
    assert.deepEqual(deprecatedInventoryAlias.structuredContent, list.structuredContent);
    assert.deepEqual(deprecatedManagementAlias.structuredContent, list.structuredContent);
    assert.deepEqual(legacyListAlias.structuredContent, list.structuredContent);
    assert.deepEqual(deprecatedInventoryAlias.content, list.content);
    assert.deepEqual(deprecatedManagementAlias.content, list.content);
    assert.deepEqual(legacyListAlias.content, list.content);

    for (const invalidPreviewArguments of [
      {},
      { name: "saved-wallet" },
      { wallet_name: "saved-wallet", user_confirmed: true },
    ]) {
      const invalidPreview = await client.callTool({
        name: "wallet_preview_saved_profile_load",
        arguments: invalidPreviewArguments,
      });
      assert.equal(invalidPreview.isError, true);
    }
    const invalidApply = await client.callTool({
      name: "wallet_apply_saved_profile_load",
      arguments: { wallet_name: "saved-wallet", user_confirmed: true },
    });
    assert.equal(invalidApply.isError, true);

    const friendlySelectionPending = await client.callTool({
      name: "wallet_preview_saved_profile_load",
      arguments: { wallet_name: "my saved wallet" },
    });
    assert.equal(
      (friendlySelectionPending.structuredContent as { code: string }).code,
      "WALLET_SELECT_CONFIRMATION_REQUIRED",
    );
    assert.equal(
      (friendlySelectionPending.structuredContent as {
        data: { wallet_name: string };
      }).data.wallet_name,
      "saved-wallet",
    );
    assert.match(
      authoritativeOutput(friendlySelectionPending) ?? "",
      /saved-wallet/u,
    );

    const missingSelection = await client.callTool({
      name: "wallet_preview_saved_profile_load",
      arguments: { wallet_name: "my missing wallet" },
    });
    assert.equal(
      (missingSelection.structuredContent as { code: string }).code,
      "WALLET_PROFILE_NOT_FOUND",
    );
    assert.match(authoritativeOutput(missingSelection) ?? "", /Saved wallet not found/u);
    assert.match(authoritativeOutput(missingSelection) ?? "", /show your saved wallets/u);

    const selectionPending = await client.callTool({
      name: "wallet_preview_saved_profile_load",
      arguments: { wallet_name: "saved-wallet" },
    });
    assert.equal(
      (selectionPending.structuredContent as { code: string }).code,
      "WALLET_SELECT_CONFIRMATION_REQUIRED",
    );
    const selectionBinding = (selectionPending.structuredContent as {
      data: {
        expected_active_wallet_name: string;
        expected_active_selection_epoch: number;
      };
    }).data;
    assert.equal(selectionBinding.expected_active_wallet_name, "agent-boost");
    assert.equal(selectionBinding.expected_active_selection_epoch, 1);
    const selectionPendingText = selectionPending.content.find((block) => block.type === "text");
    assert.equal(selectionPendingText?.type, "text");
    assert.match(selectionPendingText.text, /saved-wallet/u);
    assert.match(selectionPendingText.text, /END THIS TURN/u);
    assert.match(selectionPendingText.text, /later user message/u);
    assert.match(selectionPendingText.text, /assistant text in the current response is not user confirmation/u);
    assert.doesNotMatch(selectionPendingText.text, /wallet_[A-Za-z0-9-]+/u);
    assert.deepEqual(selectionPending._meta?.[HERMES_TURN_CONTROL_KEY], {
      schema_version: 1,
      boundary: "new_user_turn",
      continuation: {
        tool: "wallet_apply_saved_profile_load",
        binding: {
          wallet_name: "saved-wallet",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
        },
      },
    });
    const deprecatedSelectionPending = await client.callTool({
      name: "wallet_switch_saved_profile",
      arguments: { wallet_id: "saved-wallet" },
    });
    const legacySelectionPending = await client.callTool({
      name: "wallet_select",
      arguments: { wallet_id: "saved-wallet" },
    });
    assert.deepEqual(deprecatedSelectionPending.structuredContent, selectionPending.structuredContent);
    assert.deepEqual(deprecatedSelectionPending.content, selectionPending.content);
    assert.deepEqual(legacySelectionPending.structuredContent, selectionPending.structuredContent);
    assert.deepEqual(legacySelectionPending.content, selectionPending.content);

    const selectionCancelled = await client.callTool({
      name: "wallet_apply_saved_profile_load",
      arguments: {
        wallet_name: "saved-wallet",
        expected_active_wallet_name: selectionBinding.expected_active_wallet_name,
        expected_active_selection_epoch: selectionBinding.expected_active_selection_epoch,
        user_confirmed: false,
      },
    });
    assert.equal(
      (selectionCancelled.structuredContent as { code: string }).code,
      "WALLET_SELECT_CONFIRMATION_REQUIRED",
    );
    assertCompactTerminalReceipt(
      selectionCancelled,
      [
        /Wallet switch cancelled/u,
        /Nothing changed/u,
        /No wallet state changed and no signing authority was granted\.$/u,
      ],
      2,
    );

    const selected = await client.callTool({
      name: "wallet_apply_saved_profile_load",
      arguments: {
        wallet_name: "saved-wallet",
        expected_active_wallet_name: selectionBinding.expected_active_wallet_name,
        expected_active_selection_epoch: selectionBinding.expected_active_selection_epoch,
        user_confirmed: true,
      },
    });
    assert.deepEqual(observedSwitchInput, {
      walletId: "wallet_87654321",
      expectedActiveWalletName: "agent-boost",
      expectedActiveSelectionEpoch: 1,
      userConfirmed: true,
    });
    const selectedText = selected.content.find((block) => block.type === "text");
    assert.equal(selectedText?.type, "text");
    assert.equal(
      (selected.structuredContent as { code: string }).code,
      "WALLET_REAUTHORIZATION_PLANNED",
    );
    assert.equal(automaticPlanCalls, 1);
    assert.match(selectedText.text, /Reauthorization is ready for separate approval/u);
    assert.match(selectedText.text, /saved-wallet/u);
    assert.match(selectedText.text, /END THIS TURN/u);
    assert.doesNotMatch(selectedText.text, /wallet_[A-Za-z0-9-]+/u);
    assert.deepEqual(selected._meta?.[HERMES_TURN_CONTROL_KEY], {
      schema_version: 1,
      boundary: "new_user_turn",
      continuation: {
        tool: "wallet_apply_reauthorization",
        binding: { decision_id: "wra_12345678" },
      },
    });
    const planOutput = authoritativeOutput(selected) ?? "";
    assert.match(planOutput, /Authorize wallet transfers/u);
    assert.match(planOutput, /\*\*Wallet:\*\* saved-wallet/u);
    assert.match(planOutput, /\*\*Permission:\*\* 10 regular or private sends/u);
    assert.match(planOutput, /\*\*Limits:\*\* 0\.1 Sepolia ETH each/u);
    assert.match(planOutput, /0\.1 Sepolia ETH total/u);
    const reauthorizationPending = await client.callTool({
      name: "wallet_apply_reauthorization",
      arguments: { decision_id: "wra_12345678" },
    });
    assert.equal(
      (reauthorizationPending.structuredContent as { code: string }).code,
      "WALLET_REAUTHORIZATION_CONFIRMATION_REQUIRED",
    );
    assertNoVisibleInternalIds(reauthorizationPending);
    const reauthorizationPendingText = reauthorizationPending.content.find(
      (block) => block.type === "text",
    );
    assert.equal(reauthorizationPendingText?.type, "text");
    assert.match(reauthorizationPendingText.text, /saved-wallet/u);
    assert.match(reauthorizationPendingText.text, /0\.1 Sepolia ETH each/u);
    assert.match(reauthorizationPendingText.text, /0\.1 Sepolia ETH total/u);
    assert.doesNotMatch(reauthorizationPendingText.text, /\bwei\b/u);
    const legacyReauthorizationPending = await client.callTool({
      name: "wallet_reauthorize",
      arguments: { decision_id: "wra_12345678" },
    });
    assert.deepEqual(
      legacyReauthorizationPending.structuredContent,
      reauthorizationPending.structuredContent,
    );
    assert.deepEqual(legacyReauthorizationPending.content, reauthorizationPending.content);

    const reauthorized = await client.callTool({
      name: "wallet_apply_reauthorization",
      arguments: { decision_id: "wra_12345678", user_confirmed: true },
    });
    assert.equal(
      (reauthorized.structuredContent as { code: string }).code,
      "WALLET_REAUTHORIZED",
    );
    const reauthorizedOutput = authoritativeOutput(reauthorized) ?? "";
    assert.match(reauthorizedOutput, /Wallet loaded and authorized/u);
    assert.match(reauthorizedOutput, /saved-wallet.*fresh bounded Sepolia transfer permission/u);
    assert.match(reauthorizedOutput, /No funds moved\.$/u);
    assert.ok(
      reauthorizedOutput.split("\n").filter((line) => line.trim().length > 0).length <= 3,
      `wallet authorization receipt exceeds 3 visible lines: ${reauthorizedOutput}`,
    );

    assert.equal(elicitationCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("canonical saved-wallet load safely composes the reauthorization preview", async () => {
  const cases = [
    {
      label: "allowed preview",
      tool: "wallet_apply_saved_profile_load",
      setupPhase: "private_ready",
      authorizationRequired: true,
      planMode: "allow",
      userConfirmed: true,
      expectedCode: "WALLET_REAUTHORIZATION_PLANNED",
      expectedOutcome: "ready",
      expectedPlanCalls: 1,
      expectedCancelCalls: 0,
    },
    {
      label: "denied preview",
      tool: "wallet_apply_saved_profile_load",
      setupPhase: "private_ready",
      authorizationRequired: true,
      planMode: "deny",
      userConfirmed: true,
      expectedCode: "WALLET_REAUTHORIZATION_DENIED",
      expectedOutcome: "blocked",
      expectedPlanCalls: 1,
      expectedCancelCalls: 0,
    },
    {
      label: "planning failure after committed switch",
      tool: "wallet_apply_saved_profile_load",
      setupPhase: "private_ready",
      authorizationRequired: true,
      planMode: "throw",
      userConfirmed: true,
      expectedCode: "WALLET_SELECTED",
      expectedOutcome: "ready",
      expectedPlanCalls: 1,
      expectedCancelCalls: 0,
    },
    {
      label: "mismatched plan binding",
      tool: "wallet_apply_saved_profile_load",
      setupPhase: "private_ready",
      authorizationRequired: true,
      planMode: "mismatch",
      userConfirmed: true,
      expectedCode: "WALLET_SELECTED",
      expectedOutcome: "ready",
      expectedPlanCalls: 1,
      expectedCancelCalls: 1,
    },
    {
      label: "setup incomplete",
      tool: "wallet_apply_saved_profile_load",
      setupPhase: "awaiting_funding",
      authorizationRequired: true,
      planMode: "allow",
      userConfirmed: true,
      expectedCode: "WALLET_SELECTED",
      expectedOutcome: "ready",
      expectedPlanCalls: 0,
      expectedCancelCalls: 0,
    },
    {
      label: "authorization still active",
      tool: "wallet_apply_saved_profile_load",
      setupPhase: "private_ready",
      authorizationRequired: false,
      planMode: "allow",
      userConfirmed: true,
      expectedCode: "WALLET_SELECTED",
      expectedOutcome: "ready",
      expectedPlanCalls: 0,
      expectedCancelCalls: 0,
    },
    {
      label: "explicit cancellation",
      tool: "wallet_apply_saved_profile_load",
      setupPhase: "private_ready",
      authorizationRequired: true,
      planMode: "allow",
      userConfirmed: false,
      expectedCode: "WALLET_SELECT_CONFIRMATION_REQUIRED",
      expectedOutcome: "blocked",
      expectedPlanCalls: 0,
      expectedCancelCalls: 0,
    },
    {
      label: "deprecated alias remains non-composite",
      tool: "wallet_switch_saved_profile",
      setupPhase: "private_ready",
      authorizationRequired: true,
      planMode: "allow",
      userConfirmed: true,
      expectedCode: "WALLET_SELECTED",
      expectedOutcome: "ready",
      expectedPlanCalls: 0,
      expectedCancelCalls: 0,
    },
  ] as const;

  for (const fixture of cases) {
    const runtime = fakeRuntime();
    const originalPlan = runtime.planWalletReauthorization.bind(runtime);
    let planCalls = 0;
    let cancelCalls = 0;
    let lastPlan: Awaited<ReturnType<typeof runtime.planWalletReauthorization>> | undefined;
    runtime.selectWallet = async () => ({
      wallet: {
        wallet_id: "wallet_87654321",
        name: "saved-wallet",
        selection_epoch: 2,
      },
      changed: true,
      setup_phase: fixture.setupPhase,
      authorization_required: fixture.authorizationRequired,
    });
    runtime.planWalletReauthorization = async () => {
      planCalls += 1;
      if (fixture.planMode === "throw") throw new Error("simulated planner failure");
      const base = await originalPlan();
      lastPlan = {
        ...base,
        wallet: fixture.planMode === "mismatch"
          ? {
              walletId: AUTHORIZATION.walletId,
              walletName: AUTHORIZATION.walletName,
              selectionEpoch: AUTHORIZATION.selectionEpoch,
            }
          : {
              walletId: "wallet_87654321",
              walletName: "saved-wallet",
              selectionEpoch: 2,
            },
        decision: fixture.planMode === "deny" ? "deny" : "allow",
        blockers: fixture.planMode === "deny" ? ["SECURITY_POLICY_DENIED"] : [],
      };
      return lastPlan;
    };
    runtime.cancelWalletReauthorizationPlan = async () => {
      cancelCalls += 1;
      assert.ok(lastPlan);
      return {
        ...lastPlan,
        decision: "deny",
        blockers: [...lastPlan.blockers, "USER_CANCELLED"],
      };
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await createMcpServer(runtime);
    const client = testMcpClient(new Client(
      { name: `wallet-load-composite-${fixture.label}`, version: "1.0.0" },
      { capabilities: {} },
    ));
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: fixture.tool,
        arguments: {
          wallet_name: "saved-wallet",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
          user_confirmed: fixture.userConfirmed,
        },
      });
      const structured = response.structuredContent as {
        code: string;
        outcome: string;
        data: Record<string, unknown>;
      };
      assert.equal(structured.code, fixture.expectedCode, fixture.label);
      assert.equal(structured.outcome, fixture.expectedOutcome, fixture.label);
      assert.equal(planCalls, fixture.expectedPlanCalls, fixture.label);
      assert.equal(cancelCalls, fixture.expectedCancelCalls, fixture.label);

      if (fixture.expectedCode === "WALLET_REAUTHORIZATION_PLANNED") {
        assert.deepEqual(response._meta?.[HERMES_TURN_CONTROL_KEY], {
          schema_version: 1,
          boundary: "new_user_turn",
          continuation: {
            tool: "wallet_apply_reauthorization",
            binding: { decision_id: "wra_12345678" },
          },
        });
        assert.match(authoritativeOutput(response) ?? "", /\*\*Wallet:\*\* saved-wallet/u);
      } else {
        assert.equal(response._meta?.[HERMES_TURN_CONTROL_KEY], undefined, fixture.label);
      }
      if (fixture.expectedCode === "WALLET_REAUTHORIZATION_DENIED") {
        assert.equal(
          (response._meta?.[HERMES_USER_FACING_OUTPUT_KEY] as {
            complete_turn?: boolean;
          } | undefined)?.complete_turn,
          true,
        );
      }
      if (fixture.planMode === "throw" || fixture.planMode === "mismatch") {
        assert.equal(structured.data.reauthorization_preview_status, "unavailable");
        assert.match(authoritativeOutput(response) ?? "", /Wallet selected/u);
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("saved-wallet load rejects ambiguous human wording with a friendly recovery", async () => {
  const runtime = fakeRuntime();
  const baseListWallets = runtime.listWallets.bind(runtime);
  runtime.listWallets = async () => {
    const listing = await baseListWallets();
    return {
      ...listing,
      wallets: [
        ...(Array.isArray(listing.wallets) ? listing.wallets : []),
        {
          wallet_id: "wallet_ambiguous_1234",
          name: "agent_boost",
          status: "available",
          active: false,
          selection_epoch: 1,
          authorization_status: "inactive",
        },
      ],
    };
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client(
    { name: "ambiguous-wallet-load-test", version: "1.0.0" },
  ));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.callTool({
      name: "wallet_preview_saved_profile_load",
      arguments: { wallet_name: "my agent boost wallet" },
    });
    assert.equal(
      (response.structuredContent as { code: string }).code,
      "WALLET_PROFILE_AMBIGUOUS",
    );
    assert.match(authoritativeOutput(response) ?? "", /Choose a saved wallet/u);
    assert.match(authoritativeOutput(response) ?? "", /exact friendly wallet name/u);
  } finally {
    await client.close();
    await server.close();
  }
});

test("saved-wallet names round-trip from list and tree with exact-match precedence", async (t) => {
  const runtime = fakeRuntime();
  const walletNames = [
    "current-wallet",
    "agent-boost",
    "agent-boost-eac63c72e6a7a0d2",
  ] as const;
  runtime.listWallets = async () => ({
    active_wallet_id: "wallet_current_1234",
    wallets: walletNames.map((name, index) => ({
      wallet_id: `wallet_round_trip_${index}`,
      name,
      status: "available",
      active: index === 0,
      selection_epoch: 1,
      authorization_status: index === 0 ? "active" : "inactive",
    })),
    unregistered_local_wallets: [],
    local_inventory_status: "ready",
    counts: {
      registered: walletNames.length,
      available: walletNames.length,
      archived: 0,
      unregistered_local: 0,
      adoptable_local: 0,
    },
  });
  const baseTree = await runtime.walletTree();
  const profileTemplate = baseTree.profiles[0]!;
  const profilePolicy = profileTemplate.policy!;
  runtime.walletTree = async () => ({
    ...baseTree,
    profiles: walletNames.map((shortName, index) => ({
      ...profileTemplate,
      shortName,
      active: index === 0,
      policy: {
        ...profilePolicy,
        freshness: index === 0 ? "current" as const : "last_known" as const,
      },
    })),
  });
  runtime.selectWallet = async ({ walletId }) => {
    const index = Number(walletId.replace("wallet_round_trip_", ""));
    return {
      wallet: {
        wallet_id: walletId,
        name: walletNames[index],
        selection_epoch: 1,
      },
      changed: false,
      setup_phase: "private_ready",
      authorization_required: false,
      authorization_status: "active",
    };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client(
    { name: "wallet-name-round-trip-test", version: "1.0.0" },
  ));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const list = await client.callTool({
    name: "wallet_list_saved_profiles",
    arguments: {},
  });
  const listedNames = ((list.structuredContent as {
    data: { wallets: Array<{ name: string; status: string }> };
  }).data.wallets)
    .filter((wallet) => wallet.status === "available")
    .map((wallet) => wallet.name);
  const tree = await client.callTool({ name: "wallet_get_tree", arguments: {} });
  const treeNames = ((tree.structuredContent as {
    data: { profiles: Array<{ short_name: string }> };
  }).data.profiles).map((profile) => profile.short_name);
  assert.deepEqual(listedNames, [...walletNames]);
  assert.deepEqual(treeNames, listedNames);

  const resolvedName = (response: CallToolResult): string | undefined => {
    const structured = response.structuredContent as {
      code: string;
      data: {
        wallet_name?: string;
        wallet?: { name?: string };
      };
    };
    return structured.data.wallet_name ?? structured.data.wallet?.name;
  };
  for (const name of treeNames) {
    const response = await client.callTool({
      name: "wallet_preview_saved_profile_load",
      arguments: { wallet_name: name },
    });
    assert.equal(resolvedName(response), name, name);
  }

  for (const reference of [
    "agent-boost",
    "AGENT-BOOST",
    "\"agent-boost\"",
    "\u201cagent-boost\u201d",
    "\uFF41\uFF47\uFF45\uFF4E\uFF54\uFF0D\uFF42\uFF4F\uFF4F\uFF53\uFF54",
    "my saved wallet agent-boost",
  ]) {
    const response = await client.callTool({
      name: "wallet_preview_saved_profile_load",
      arguments: { wallet_name: reference },
    });
    assert.equal(resolvedName(response), "agent-boost", reference);
  }

  const longExact = await client.callTool({
    name: "wallet_preview_saved_profile_load",
    arguments: { wallet_name: "agent-boost-eac63c72e6a7a0d2" },
  });
  assert.equal(resolvedName(longExact), "agent-boost-eac63c72e6a7a0d2");

  const normalized = await client.callTool({
    name: "wallet_preview_saved_profile_load",
    arguments: { wallet_name: "agent boost" },
  });
  assert.equal(resolvedName(normalized), "agent-boost");

  for (const reference of ["agent", "missing-wallet", "agent-boost-extra"]) {
    const missing = await client.callTool({
      name: "wallet_preview_saved_profile_load",
      arguments: { wallet_name: reference },
    });
    assert.equal(
      (missing.structuredContent as { code: string }).code,
      "WALLET_PROFILE_NOT_FOUND",
      reference,
    );
  }
});

test("saved-wallet normalized references fail closed when truly ambiguous", async (t) => {
  const runtime = fakeRuntime();
  const baseListWallets = runtime.listWallets.bind(runtime);
  runtime.listWallets = async () => {
    const listing = await baseListWallets();
    return {
      ...listing,
      wallets: [
        ...(Array.isArray(listing.wallets) ? listing.wallets : []),
        {
          wallet_id: "wallet_ambiguous_hyphen_1234",
          name: "agent_boost",
          status: "available",
          active: false,
          selection_epoch: 1,
          authorization_status: "inactive",
        },
        {
          wallet_id: "wallet_uppercase_vault_1234",
          name: "Vault",
          status: "available",
          active: false,
          selection_epoch: 1,
          authorization_status: "inactive",
        },
        {
          wallet_id: "wallet_lowercase_vault_1234",
          name: "vault",
          status: "available",
          active: false,
          selection_epoch: 1,
          authorization_status: "inactive",
        },
      ],
    };
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client(
    { name: "wallet-normalized-ambiguity-test", version: "1.0.0" },
  ));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const exact = await client.callTool({
    name: "wallet_preview_saved_profile_load",
    arguments: { wallet_name: "agent-boost" },
  });
  assert.equal(
    (exact.structuredContent as { code: string }).code,
    "WALLET_SELECTED",
  );
  const ambiguous = await client.callTool({
    name: "wallet_preview_saved_profile_load",
    arguments: { wallet_name: "agent boost" },
  });
  assert.equal(
    (ambiguous.structuredContent as { code: string }).code,
    "WALLET_PROFILE_AMBIGUOUS",
  );
  assert.deepEqual(
    (ambiguous.structuredContent as {
      data: { matching_wallet_names: string[] };
    }).data.matching_wallet_names,
    ["agent-boost", "agent_boost"],
  );

  for (const exactName of ["Vault", "vault"]) {
    const exactCase = await client.callTool({
      name: "wallet_preview_saved_profile_load",
      arguments: { wallet_name: exactName },
    });
    assert.equal(
      (exactCase.structuredContent as { code: string }).code,
      "WALLET_SELECT_CONFIRMATION_REQUIRED",
      exactName,
    );
    assert.equal(
      (exactCase.structuredContent as { data: { wallet_name: string } })
        .data.wallet_name,
      exactName,
    );
  }

  for (const normalizedReference of ["VAULT", "\"Vault\"", "\uFF36\uFF41\uFF55\uFF4C\uFF54"]) {
    const normalizedAmbiguity = await client.callTool({
      name: "wallet_preview_saved_profile_load",
      arguments: { wallet_name: normalizedReference },
    });
    assert.equal(
      (normalizedAmbiguity.structuredContent as { code: string }).code,
      "WALLET_PROFILE_AMBIGUOUS",
      normalizedReference,
    );
    assert.deepEqual(
      (normalizedAmbiguity.structuredContent as {
        data: { matching_wallet_names: string[] };
      }).data.matching_wallet_names,
      ["Vault", "vault"],
    );
  }

  const equivalentAliases = await client.callTool({
    name: "wallet_select",
    arguments: {
      wallet_name: "SAVED-WALLET",
      name: "saved-wallet",
    },
  });
  assert.equal(
    (equivalentAliases.structuredContent as { code: string }).code,
    "WALLET_SELECT_CONFIRMATION_REQUIRED",
  );
  assert.equal(
    (equivalentAliases.structuredContent as { data: { wallet_name: string } })
      .data.wallet_name,
    "saved-wallet",
  );

  const conflictingExactAliases = await client.callTool({
    name: "wallet_select",
    arguments: { wallet_name: "Vault", name: "vault" },
  });
  assert.equal(
    (conflictingExactAliases.structuredContent as { code: string }).code,
    "WALLET_PROFILE_REFERENCE_CONFLICT",
  );

  const conflictingMissingAliases = await client.callTool({
    name: "wallet_select",
    arguments: { wallet_name: "missing-one", name: "missing-two" },
  });
  assert.equal(
    (conflictingMissingAliases.structuredContent as { code: string }).code,
    "WALLET_PROFILE_REFERENCE_CONFLICT",
  );

  const ambiguousAlias = await client.callTool({
    name: "wallet_select",
    arguments: { wallet_name: "VAULT", name: "vault" },
  });
  assert.equal(
    (ambiguousAlias.structuredContent as { code: string }).code,
    "WALLET_PROFILE_AMBIGUOUS",
  );
});

test("saved-wallet load resolves generic wording in one read-only call or asks with friendly names", async (t) => {
  const callPreview = async (
    runtime: AgentBoostRuntime,
    walletName: string,
  ): Promise<CallToolResult> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await createMcpServer(runtime);
    const client = testMcpClient(new Client(
      { name: `generic-wallet-load-${walletName}`, version: "1.0.0" },
    ));
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    t.after(async () => {
      await client.close();
      await server.close();
    });
    return client.callTool({
      name: "wallet_preview_saved_profile_load",
      arguments: { wallet_name: walletName },
    });
  };

  const uniqueRuntime = fakeRuntime();
  const uniqueListWallets = uniqueRuntime.listWallets.bind(uniqueRuntime);
  let uniqueListCalls = 0;
  let uniqueSelectCalls = 0;
  uniqueRuntime.listWallets = async () => {
    uniqueListCalls += 1;
    const listing = await uniqueListWallets();
    return {
      ...listing,
      wallets: [
        ...(Array.isArray(listing.wallets) ? listing.wallets : []),
        {
          wallet_id: "wallet_archived_1234",
          name: "archived-wallet",
          status: "archived",
          active: false,
          selection_epoch: 1,
          authorization_status: "inactive",
        },
      ],
    };
  };
  uniqueRuntime.selectWallet = async () => {
    uniqueSelectCalls += 1;
    throw new Error("preview must not select an inactive wallet");
  };
  const unique = await callPreview(uniqueRuntime, "my old wallet");
  assert.equal((unique.structuredContent as { code: string }).code, "WALLET_SELECT_CONFIRMATION_REQUIRED");
  assert.equal(
    (unique.structuredContent as { data: { wallet_name: string } }).data.wallet_name,
    "saved-wallet",
  );
  assert.equal(uniqueListCalls, 1);
  assert.equal(uniqueSelectCalls, 0);

  const multipleRuntime = fakeRuntime();
  const multipleListWallets = multipleRuntime.listWallets.bind(multipleRuntime);
  let multipleListCalls = 0;
  let multipleSelectCalls = 0;
  multipleRuntime.listWallets = async () => {
    multipleListCalls += 1;
    const listing = await multipleListWallets();
    return {
      ...listing,
      wallets: [
        ...(Array.isArray(listing.wallets) ? listing.wallets : []),
        {
          wallet_id: "wallet_travel_1234",
          name: "travel-wallet",
          status: "available",
          active: false,
          selection_epoch: 1,
          authorization_status: "inactive",
        },
        {
          wallet_id: "wallet_archived_5678",
          name: "retired-wallet",
          status: "archived",
          active: false,
          selection_epoch: 1,
          authorization_status: "inactive",
        },
      ],
    };
  };
  multipleRuntime.selectWallet = async () => {
    multipleSelectCalls += 1;
    throw new Error("selection-required result must not select a wallet");
  };
  const multiple = await callPreview(multipleRuntime, "a wallet I previously set up");
  const multipleStructured = multiple.structuredContent as {
    code: string;
    outcome: string;
    data: Record<string, unknown>;
  };
  assert.equal(multipleStructured.code, "WALLET_PROFILE_SELECTION_REQUIRED");
  assert.equal(multipleStructured.outcome, "blocked");
  assert.deepEqual(multipleStructured.data.wallet_names, ["saved-wallet", "travel-wallet"]);
  assert.deepEqual(Object.keys(multipleStructured.data).sort(), ["message", "wallet_names"]);
  assert.equal(multipleListCalls, 1);
  assert.equal(multipleSelectCalls, 0);
  assert.deepEqual(multiple._meta?.[HERMES_TURN_CONTROL_KEY], {
    schema_version: 1,
    boundary: "new_user_turn",
  });
  assert.equal(
    authoritativeOutput(multiple),
    "I found two inactive saved wallets: **saved-wallet** and **travel-wallet**.\nWhich one should I load?",
  );
  assertNoVisibleInternalIds(multiple);

  const preciseRuntime = fakeRuntime();
  const preciseListWallets = preciseRuntime.listWallets.bind(preciseRuntime);
  preciseRuntime.listWallets = async () => {
    const listing = await preciseListWallets();
    return {
      ...listing,
      wallets: [
        ...(Array.isArray(listing.wallets) ? listing.wallets : []),
        {
          wallet_id: "wallet_old_1234",
          name: "old-wallet",
          status: "available",
          active: false,
          selection_epoch: 1,
          authorization_status: "inactive",
        },
      ],
    };
  };
  const precise = await callPreview(preciseRuntime, "my old wallet");
  assert.equal((precise.structuredContent as { code: string }).code, "WALLET_SELECT_CONFIRMATION_REQUIRED");
  assert.equal(
    (precise.structuredContent as { data: { wallet_name: string } }).data.wallet_name,
    "old-wallet",
  );

  for (const active of [false, true]) {
    const collisionRuntime = fakeRuntime();
    const collisionListWallets = collisionRuntime.listWallets.bind(collisionRuntime);
    collisionRuntime.listWallets = async () => {
      const listing = await collisionListWallets();
      const wallets = (Array.isArray(listing.wallets) ? listing.wallets : [])
        .map((wallet) => {
          const record = wallet as Record<string, unknown>;
          return record.name === "saved-wallet"
            ? { ...record, active }
            : active && record.active === true
              ? { ...record, active: false }
              : record;
        });
      return {
        ...listing,
        wallets: [
          ...wallets,
          {
            wallet_id: `wallet_archived_collision_${active ? "active" : "inactive"}`,
            name: "saved_wallet",
            status: "archived",
            active: false,
            selection_epoch: 1,
            authorization_status: "inactive",
          },
        ],
      };
    };
    const collision = await callPreview(collisionRuntime, "my saved wallet");
    assert.equal(
      (collision.structuredContent as { code: string }).code,
      active ? "WALLET_SELECTED" : "WALLET_SELECT_CONFIRMATION_REQUIRED",
    );
    assert.equal(
      active
        ? (collision.structuredContent as { data: { wallet: { name: string } } }).data.wallet.name
        : (collision.structuredContent as { data: { wallet_name: string } }).data.wallet_name,
      "saved-wallet",
    );
    assert.doesNotMatch(JSON.stringify(collision), /saved_wallet/u);
  }
});

test("selecting an already-active authorized wallet does not demand reauthorization", async () => {
  const runtime = fakeRuntime();
  runtime.selectWallet = async (input) => {
    assert.equal(input.userConfirmed, false);
    return {
      wallet: { name: "agent-boost" },
      changed: false,
      setup_phase: "private_ready",
      authorization_required: false,
      authorization_status: "active",
    };
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client(
    { name: "already-selected-test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  ));
  let elicitationCalls = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    elicitationCalls += 1;
    return { action: "accept", content: {} };
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.callTool({
      name: "wallet_preview_saved_profile_load",
      arguments: { wallet_name: "agent-boost" },
    });
    const text = response.content.find((block) => block.type === "text");
    assert.equal(text?.type, "text");
    assert.match(text.text, /already selected/u);
    assert.match(text.text, /authorization remains active/u);
    assert.doesNotMatch(text.text, /remains disabled|must reauthorize/u);
    const presentation = (response.structuredContent as {
      presentation: { notice: { text: string }; next_action: string };
    }).presentation;
    assert.match(presentation.notice.text, /authorization remains active/u);
    assert.equal(presentation.next_action, "No reauthorization is required.");
    const friendlyResponse = await client.callTool({
      name: "wallet_preview_saved_profile_load",
      arguments: { wallet_name: "the agent boost account" },
    });
    assert.equal(
      (friendlyResponse.structuredContent as { code: string }).code,
      "WALLET_SELECTED",
    );
    assert.match(authoritativeOutput(friendlyResponse) ?? "", /agent-boost/u);
    assert.equal(elicitationCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a stale wallet-switch approval is rejected as a hard turn boundary", async () => {
  const runtime = fakeRuntime();
  runtime.selectWallet = async (input) => {
    assert.deepEqual(input, {
      walletId: "wallet_87654321",
      userConfirmed: true,
      expectedActiveWalletName: "agent-boost",
      expectedActiveSelectionEpoch: 1,
    });
    throw new AgentBoostRequestError(
      "WALLET_SWITCH_PREVIEW_STALE",
      "The active wallet changed after this switch preview.",
      {
        expected_active_wallet_name: "agent-boost",
        expected_active_selection_epoch: 1,
        active_wallet_name: "other-wallet",
        active_selection_epoch: 2,
      },
    );
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "stale-wallet-switch-test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.callTool({
      name: "wallet_apply_saved_profile_load",
      arguments: {
        wallet_name: "saved-wallet",
        expected_active_wallet_name: "agent-boost",
        expected_active_selection_epoch: 1,
        user_confirmed: true,
      },
    });
    assert.equal(
      (response.structuredContent as { code: string }).code,
      "WALLET_SWITCH_PREVIEW_STALE",
    );
    assert.match(visibleToolSurface(response), /active wallet changed[\s\S]*Nothing changed/iu);
    assert.doesNotMatch(visibleToolSurface(response), /wallet_switch_saved_profile/u);
    assert.equal(
      (response._meta?.[HERMES_MODEL_CONTEXT_KEY] as { response_mode?: string })
        .response_mode,
      "preview_then_stop",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("wallet_id compatibility prefers exact IDs and still accepts wallet_-prefixed friendly names", async () => {
  const runtime = fakeRuntime();
  const originalListWallets = runtime.listWallets.bind(runtime);
  runtime.listWallets = async () => {
    const listing = await originalListWallets();
    return {
      ...listing,
      wallets: [
        ...(listing.wallets as Array<Record<string, unknown>>),
        {
          wallet_id: "wallet_friendly_prefix",
          name: "wallet_backup",
          status: "available",
          active: false,
          authorization_status: "inactive",
        },
        {
          wallet_id: "wallet_name_collision",
          name: "wallet_87654321",
          status: "available",
          active: false,
          authorization_status: "inactive",
        },
      ],
    };
  };
  const selectedIds: string[] = [];
  runtime.selectWallet = async (input) => {
    selectedIds.push(input.walletId);
    return {
      wallet: { name: input.walletId },
      authorization_required: true,
    };
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "wallet-reference-test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({
      name: "wallet_switch_saved_profile",
      arguments: {
        wallet_id: "wallet_backup",
        expected_active_wallet_name: "agent-boost",
        expected_active_selection_epoch: 1,
        user_confirmed: true,
      },
    });
    await client.callTool({
      name: "wallet_switch_saved_profile",
      arguments: {
        wallet_id: "wallet_87654321",
        expected_active_wallet_name: "agent-boost",
        expected_active_selection_epoch: 1,
        user_confirmed: true,
      },
    });
    assert.deepEqual(selectedIds, ["wallet_friendly_prefix", "wallet_87654321"]);

    const omittedBinding = await client.callTool({
      name: "wallet_switch_saved_profile",
      arguments: { wallet_name: "saved-wallet", user_confirmed: true },
    });
    assert.equal(
      (omittedBinding.structuredContent as { code: string }).code,
      "WALLET_SWITCH_BINDING_REQUIRED",
    );
    assert.equal(
      (omittedBinding._meta?.[HERMES_MODEL_CONTEXT_KEY] as { response_mode?: string })
        .response_mode,
      "preview_then_stop",
    );
    assert.doesNotMatch(visibleToolSurface(omittedBinding), /wallet_switch_saved_profile/u);
    assert.deepEqual(selectedIds, ["wallet_friendly_prefix", "wallet_87654321"]);

    const incompleteBinding = await client.callTool({
      name: "wallet_switch_saved_profile",
      arguments: {
        wallet_name: "saved-wallet",
        expected_active_wallet_name: "agent-boost",
        user_confirmed: true,
      },
    });
    assert.equal(incompleteBinding.isError, true);
    assert.deepEqual(selectedIds, ["wallet_friendly_prefix", "wallet_87654321"]);

    await client.callTool({
      name: "wallet_select",
      arguments: { wallet_name: "saved-wallet", user_confirmed: true },
    });
    assert.deepEqual(
      selectedIds,
      ["wallet_friendly_prefix", "wallet_87654321", "wallet_87654321"],
    );

    const conflict = await client.callTool({
      name: "wallet_switch_saved_profile",
      arguments: {
        wallet_id: "wallet_87654321",
        wallet_name: "wallet_backup",
        user_confirmed: true,
      },
    });
    assert.equal(
      (conflict.structuredContent as { code: string }).code,
      "WALLET_PROFILE_REFERENCE_CONFLICT",
    );
    assert.deepEqual(
      selectedIds,
      ["wallet_friendly_prefix", "wallet_87654321", "wallet_87654321"],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("declined wallet reauthorization and recovery confirmations cause no execution", async () => {
  const runtime = fakeRuntime();
  let reauthorizationState = await runtime.getWalletReauthorizationPlan("wra_12345678");
  let recoveryState = await runtime.getRecoveryPlan("wr_12345678");
  let reauthorizationCancellations = 0;
  let recoveryCancellations = 0;
  runtime.getWalletReauthorizationPlan = async () => reauthorizationState;
  runtime.cancelWalletReauthorizationPlan = async () => {
    reauthorizationCancellations += 1;
    reauthorizationState = {
      ...reauthorizationState,
      decision: "deny",
      blockers: [...reauthorizationState.blockers, "USER_CANCELLED"],
    };
    return reauthorizationState;
  };
  runtime.getRecoveryPlan = async () => recoveryState;
  runtime.cancelRecoveryPlan = async () => {
    recoveryCancellations += 1;
    recoveryState = {
      ...recoveryState,
      decision: "deny",
      blockers: [...recoveryState.blockers, "USER_CANCELLED"],
    };
    return recoveryState;
  };
  let reauthorizationCalls = 0;
  let recoveryCalls = 0;
  runtime.reauthorizeWallet = async () => {
    reauthorizationCalls += 1;
    throw new Error("must not reauthorize after decline");
  };
  runtime.executeRecoveryTransfer = async () => {
    recoveryCalls += 1;
    throw new Error("must not recover after decline");
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client(
    { name: "wallet-lifecycle-chat-decline-test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  ));
  let elicitationCalls = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    elicitationCalls += 1;
    return { action: "accept", content: {} };
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const reauthorization = await client.callTool({
      name: "wallet_apply_reauthorization",
      arguments: { decision_id: "wra_12345678", user_confirmed: false },
    });
    const reauthorizationResult = reauthorization.structuredContent as {
      code: string;
      presentation: { state: string; notice: { text: string }; next_action: string };
    };
    assert.equal(reauthorizationResult.code, "WALLET_REAUTHORIZATION_CONFIRMATION_REQUIRED");
    assert.equal(reauthorizationResult.presentation.state, "cancelled");
    assert.match(reauthorizationResult.presentation.notice.text, /No funds moved/u);
    assert.match(reauthorizationResult.presentation.next_action, /no authorization is pending/iu);
    assertCompactTerminalReceipt(
      reauthorization,
      [
        /Wallet authorization cancelled/u,
        /No signing authority was granted/u,
        /No funds moved\.$/u,
      ],
      2,
    );
    const reauthorizationText = reauthorization.content.find((block) => block.type === "text");
    assert.equal(reauthorizationText?.type, "text");
    assert.match(reauthorizationText.text, /reauthorization cancelled/u);
    for (const argumentsValue of [
      { decision_id: "wra_12345678" },
      { decision_id: "wra_12345678", user_confirmed: true },
    ]) {
      const retry = await client.callTool({
        name: "wallet_apply_reauthorization",
        arguments: argumentsValue,
      });
      const retryResult = retry.structuredContent as {
        code: string;
        presentation: { state: string };
      };
      assert.equal(retryResult.code, "WALLET_REAUTHORIZATION_CONFIRMATION_REQUIRED");
      assert.equal(retryResult.presentation.state, "cancelled");
    }

    const recovery = await client.callTool({
      name: "wallet_execute_recovery_transfer",
      arguments: { decision_id: "wr_12345678", user_confirmed: false },
    });
    const recoveryResult = recovery.structuredContent as {
      code: string;
      presentation: { state: string; notice: { text: string }; next_action: string };
    };
    assert.equal(recoveryResult.code, "RECOVERY_CONFIRMATION_REQUIRED");
    assert.equal(recoveryResult.presentation.state, "cancelled");
    assert.match(recoveryResult.presentation.notice.text, /Nothing was signed, submitted, or sent/u);
    assert.match(recoveryResult.presentation.next_action, /no recovery transfer is pending/iu);
    assertCompactTerminalReceipt(
      recovery,
      [
        /Recovery cancelled/u,
        /Nothing was signed or submitted\.$/u,
      ],
      2,
    );
    const recoveryText = recovery.content.find((block) => block.type === "text");
    assert.equal(recoveryText?.type, "text");
    assert.match(recoveryText.text, /Recovery transfer cancelled/u);
    for (const argumentsValue of [
      { decision_id: "wr_12345678" },
      { decision_id: "wr_12345678", user_confirmed: true },
    ]) {
      const retry = await client.callTool({
        name: "wallet_execute_recovery_transfer",
        arguments: argumentsValue,
      });
      const retryResult = retry.structuredContent as {
        code: string;
        presentation: { state: string };
      };
      assert.equal(retryResult.code, "RECOVERY_CONFIRMATION_REQUIRED");
      assert.equal(retryResult.presentation.state, "cancelled");
    }
    assert.equal(reauthorizationCalls, 0);
    assert.equal(recoveryCalls, 0);
    assert.equal(reauthorizationCancellations, 1);
    assert.equal(recoveryCancellations, 1);
    assert.equal(elicitationCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a cancelled policy preview remains terminal for omitted and true retries", async () => {
  const runtime = fakeRuntime();
  let policyState = await runtime.getPolicyUpdatePlan("wpd_12345678");
  let cancellationCalls = 0;
  let applyCalls = 0;
  runtime.getPolicyUpdatePlan = async () => policyState;
  runtime.cancelPolicyUpdatePlan = async () => {
    cancellationCalls += 1;
    policyState = {
      ...policyState,
      decision: "deny",
      blockers: [...policyState.blockers, "USER_CANCELLED"],
    };
    return policyState;
  };
  runtime.applyPolicyUpdate = async () => {
    applyCalls += 1;
    throw new Error("must not apply a cancelled policy preview");
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "policy-terminal-cancel-test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    for (const argumentsValue of [
      { decision_id: "wpd_12345678", user_confirmed: false },
      { decision_id: "wpd_12345678" },
      { decision_id: "wpd_12345678", user_confirmed: true },
    ]) {
      const response = await client.callTool({
        name: "wallet_apply_policy_update",
        arguments: argumentsValue,
      });
      const structured = response.structuredContent as {
        code: string;
        data: { requires_new_user_confirmation: boolean };
        presentation: {
          fields: unknown[];
          state: string;
          notice: { text: string };
          next_action: string;
        };
      };
      assert.equal(structured.code, "POLICY_UPDATE_CANCELLED");
      assert.equal(structured.data.requires_new_user_confirmation, false);
      assert.equal(structured.presentation.state, "cancelled");
      assert.deepEqual(structured.presentation.fields, []);
      assert.match(structured.presentation.notice.text, /unchanged.*No funds moved/iu);
      assert.match(structured.presentation.next_action, /no permission change is pending/iu);
      assert.equal(
        (response._meta?.["org.agentboost/user-facing-output"] as {
          complete_turn?: boolean;
        } | undefined)?.complete_turn,
        true,
      );
      assertCompactTerminalReceipt(
        response,
        [
          /Wallet permission change cancelled/u,
          /Permission unchanged/u,
          /No funds moved\.$/u,
        ],
        2,
      );
    }
    assert.equal(cancellationCalls, 1);
    assert.equal(applyCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("an older policy preview reports supersession rather than user cancellation", async () => {
  const runtime = fakeRuntime();
  const original = await runtime.getPolicyUpdatePlan("wpd_12345678");
  runtime.getPolicyUpdatePlan = async () => ({
    ...original,
    decision: "deny",
    blockers: ["SUPERSEDED_BY_NEW_PREVIEW"],
  });
  runtime.applyPolicyUpdate = async () => {
    throw new Error("must not apply a superseded policy preview");
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "policy-superseded-test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.callTool({
      name: "wallet_apply_policy_update",
      arguments: { decision_id: "wpd_12345678", user_confirmed: true },
    });
    const structured = response.structuredContent as {
      code: string;
      data: { reason: string; requires_new_user_confirmation: boolean };
      presentation: { title: string; state: string; notice: { text: string } };
    };
    assert.equal(structured.code, "POLICY_UPDATE_CANCELLED");
    assert.equal(structured.data.reason, "superseded");
    assert.equal(structured.data.requires_new_user_confirmation, false);
    assert.equal(structured.presentation.title, "Permission preview superseded");
    assert.equal(structured.presentation.state, "attention");
    assert.match(structured.presentation.notice.text, /newer preview replaced/u);
    const textBlock = response.content.find((block) => block.type === "text");
    assert.equal(textBlock?.type, "text");
    assert.match(textBlock.text, /superseded by a newer preview/u);
    assert.doesNotMatch(textBlock.text, /change cancelled/u);
  } finally {
    await client.close();
    await server.close();
  }
});

test("every shipped MCP tool has at least two contract-level flows", async () => {
  const runtime = fakeRuntime();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "flow-matrix", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const coverage = new Map<string, Set<string>>();
  const exercise = async (
    name: string,
    flow: string,
    arguments_: Record<string, unknown> = {},
  ): Promise<CallToolResult> => {
    const flows = coverage.get(name) ?? new Set<string>();
    flows.add(flow);
    coverage.set(name, flows);
    return await client.callTool({ name, arguments: arguments_ }) as CallToolResult;
  };
  const structured = (response: CallToolResult): {
    code: string;
    outcome: string;
    data: Record<string, unknown>;
  } => response.structuredContent as {
    code: string;
    outcome: string;
    data: Record<string, unknown>;
  };
  const expectCode = (
    response: CallToolResult,
    code: string,
    outcome?: string,
  ): void => {
    assert.equal(structured(response).code, code);
    if (outcome !== undefined) assert.equal(structured(response).outcome, outcome);
  };
  const recipient = "0x2222222222222222222222222222222222222222";
  const tradeArguments = {
    chain_id: "eip155:11155111",
    sell_asset_id: "eip155:11155111/slip44:60",
    buy_asset_id: "eip155:11155111/erc20:0x3333333333333333333333333333333333333333",
    sell_amount_atomic: "1000000000000000",
    max_slippage_bps: 50,
    recipient,
  };

  try {
    expectCode(await exercise("capabilities", "initial snapshot"), "CAPABILITIES", "ready");
    const originalCapabilities = runtime.capabilities.bind(runtime);
    runtime.capabilities = async () => ({
      ...(await originalCapabilities()),
      regular_transfer_probe: "second_snapshot",
    });
    expectCode(await exercise("capabilities", "refreshed snapshot"), "CAPABILITIES", "ready");

    const firstTradeCapabilities = await exercise(
      "trade_capabilities",
      "regular readiness inspection",
    );
    const secondTradeCapabilities = await exercise(
      "trade_capabilities",
      "private readiness inspection",
    );
    expectCode(firstTradeCapabilities, "TRADE_CAPABILITIES", "ready");
    expectCode(secondTradeCapabilities, "TRADE_CAPABILITIES", "ready");
    assert.deepEqual(
      structured(firstTradeCapabilities).data,
      structured(secondTradeCapabilities).data,
      "static trade readiness must be deterministic",
    );

    for (const mode of ["regular", "private"] as const) {
      const planned = await exercise("trade_plan", `${mode} unavailable`, {
        mode,
        ...tradeArguments,
      });
      expectCode(planned, "TRADE_NOT_CONFIGURED", "blocked");
      assert.equal(
        (structured(planned).data as { requested_mode: string }).requested_mode,
        mode,
      );
      assert.equal(
        (structured(planned).data as { effects: { network_request_attempted: boolean } })
          .effects.network_request_attempted,
        false,
      );

      const executed = await exercise("trade_execute", `${mode} execution inert`, {
        mode,
        decision_id: "td_12345678",
      });
      expectCode(executed, "TRADE_NOT_CONFIGURED", "blocked");
      assert.equal(
        (structured(executed).data as { effects: { transaction_submitted: boolean } })
          .effects.transaction_submitted,
        false,
      );

      const status = await exercise("trade_get_request", `${mode} status inert`, {
        mode,
        request_id: "tr_12345678",
      });
      expectCode(status, "TRADE_NOT_CONFIGURED", "blocked");
      assert.equal(
        (structured(status).data as { requested_mode: string }).requested_mode,
        mode,
      );
    }

    expectCode(
      await exercise("egress_capabilities", "initial policy"),
      "EGRESS_CAPABILITIES",
      "ready",
    );
    runtime.egressCapabilities = async () => ({
      contract: "org.agentboost.egress/0.1",
      mode: "explicit_fetch",
      policy: { direct_fallback: false, refreshed: true },
    });
    expectCode(
      await exercise("egress_capabilities", "refreshed policy"),
      "EGRESS_CAPABILITIES",
      "ready",
    );

    expectCode(await exercise("egress_status", "ready"), "EGRESS_STATUS", "ready");
    runtime.egressStatus = async () => ({
      status: "degraded",
      code: "SHADE_TREE_DEGRADED",
      detail: "covered route is unavailable",
      direct_fallback: false,
    });
    expectCode(await exercise("egress_status", "degraded"), "EGRESS_STATUS", "blocked");

    let observedMethod: "GET" | "HEAD" | undefined;
    runtime.egressFetch = async (input) => {
      observedMethod = input.method;
      return {
        status: 200,
        finalUrl: input.url,
        contentType: "application/json",
        body: input.method === "HEAD" ? "" : "{}",
        bytes: input.method === "HEAD" ? 0 : 2,
        redirects: 0,
        route: "shade-tree",
      };
    };
    expectCode(
      await exercise("egress_fetch", "GET text", { url: "https://example.com/data" }),
      "EGRESS_FETCHED",
      "ready",
    );
    assert.equal(observedMethod, undefined, "omitted method must preserve the GET default");
    expectCode(
      await exercise("egress_fetch", "HEAD metadata", {
        url: "https://example.com/data",
        method: "HEAD",
      }),
      "EGRESS_FETCHED",
      "ready",
    );
    assert.equal(observedMethod, "HEAD");

    expectCode(
      await exercise("onboarding_start", "resume awaiting funding"),
      "ONBOARDING_STARTED",
      "awaiting_funding",
    );
    runtime.startOnboarding = async () => {
      throw new Error("WALLET_BACKEND_UNAVAILABLE");
    };
    expectCode(
      await exercise("onboarding_start", "backend failure"),
      "REQUEST_BLOCKED",
      "blocked",
    );

    const waiting = await runtime.onboardingStatus({ setupId: "setup_12345678" });
    expectCode(
      await exercise("onboarding_status", "awaiting funding", {
        setup_id: "setup_12345678",
        since_revision: 2,
        wait_ms: 0,
      }),
      "ONBOARDING_STATUS",
      "awaiting_funding",
    );
    runtime.onboardingStatus = async () => ({
      ...waiting,
      phase: "private_ready",
      revision: waiting.revision + 1,
      publicBalanceWei: (
        BigInt(waiting.requiredFundingWei) - 100_000_000_000_000_000n
      ).toString(),
      privateBalanceWei: waiting.shieldAmountWei,
      shieldPreparedDepositCall: {
        to: "0x2222222222222222222222222222222222222222",
        data: "0xdeadbeef",
        valueWei: waiting.shieldAmountWei,
      },
      shieldBroadcastStartedAt: "2026-09-04T00:00:00.000Z",
      shieldTransactionHash: `0x${"ab".repeat(32)}`,
    });
    const readyStatus = await exercise("onboarding_status", "private ready", {
      setup_id: "setup_12345678",
    });
    expectCode(readyStatus, "ONBOARDING_STATUS", "ready");
    const readyStatusText = readyStatus.content.find((block) => block.type === "text");
    assert.match(
      readyStatusText?.type === "text" ? readyStatusText.text : "",
      /do not answer yet[\s\S]*call wallet_get_tree[\s\S]*full 3\/3 setup-completion response/u,
    );
    assert.match(
      readyStatusText?.type === "text" ? readyStatusText.text : "",
      /Do not show the funding address, raw setup balances, or an invented balance summary/u,
    );
    const readySetup = (structured(readyStatus).data as {
      setup: Record<string, unknown>;
    }).setup;
    assert.equal(readySetup.address, undefined);
    assert.equal(readySetup.publicBalanceWei, undefined);
    assert.equal(readySetup.privateBalanceWei, undefined);
    assert.equal(readySetup.requiredFundingWei, undefined);
    assert.equal(readySetup.shieldAmountWei, undefined);
    assert.equal(readySetup.shieldPreparedDepositCall, undefined);
    assert.equal(readySetup.shieldBroadcastStartedAt, undefined);
    assert.equal(readySetup.shieldTransactionHash, undefined);
    assert.equal(readySetup.delegation, undefined);
    const readyFunding = (structured(readyStatus).data as {
      funding: Record<string, unknown>;
    }).funding;
    assert.equal(readyFunding.address, undefined);
    assert.equal(readyFunding.funding_uri, undefined);
    assert.equal(readyFunding.remaining_amount_wei, undefined);
    assert.equal(readyFunding.remaining_amount_eth, undefined);
    assert.doesNotMatch(
      JSON.stringify(readyStatus),
      /0x[0-9a-f]{40}|deadbeef|abababab|funding_uri|remaining_amount_(?:wei|eth)|publicBalanceWei|privateBalanceWei|shieldPreparedDepositCall|shieldTransactionHash/u,
    );
    runtime.onboardingStatus = async () => ({
      ...waiting,
      phase: "failed",
      revision: waiting.revision + 2,
      error: { code: "SHIELD_FAILED", message: "test failure", retryable: false },
    });
    expectCode(
      await exercise("onboarding_status", "terminal failure", {
        setup_id: "setup_12345678",
      }),
      "ONBOARDING_STATUS",
      "failed",
    );

    const affordable = await exercise("wallet_get_main_balance", "affordable amount", {
      amount_native: "1",
    });
    const unaffordable = await exercise("wallet_get_main_balance", "unaffordable amount", {
      amount_native: "2",
    });
    expectCode(affordable, "WALLET_CONTEXT", "ready");
    expectCode(unaffordable, "WALLET_CONTEXT", "ready");
    assert.equal(
      (structured(affordable).data as {
        affordability_check: { main_account_covers_requested: boolean };
      }).affordability_check.main_account_covers_requested,
      true,
    );
    assert.equal(
      (structured(unaffordable).data as {
        affordability_check: { main_account_covers_requested: boolean };
      }).affordability_check.main_account_covers_requested,
      false,
    );
    expectCode(
      await exercise("wallet_get_context", "legacy affordable amount", {
        amount_native: "1",
      }),
      "WALLET_CONTEXT",
      "ready",
    );
    expectCode(
      await exercise("wallet_get_context", "legacy unaffordable amount", {
        amount_native: "2",
      }),
      "WALLET_CONTEXT",
      "ready",
    );

    expectCode(
      await exercise("wallet_list_saved_profiles", "canonical empty inventory"),
      "WALLET_LIST",
      "ready",
    );
    expectCode(
      await exercise("wallet_get_saved_profiles", "empty inventory"),
      "WALLET_LIST",
      "ready",
    );
    expectCode(
      await exercise("wallet_manage_profiles", "deprecated management alias"),
      "WALLET_LIST",
      "ready",
    );
    expectCode(
      await exercise("wallet_list", "legacy list alias"),
      "WALLET_LIST",
      "ready",
    );
    runtime.listWallets = async () => ({
      active_wallet_id: AUTHORIZATION.walletId,
      wallets: [
        {
          wallet_id: AUTHORIZATION.walletId,
          name: "agent-boost",
          active: true,
          status: "available",
          selection_epoch: 1,
          authorization_status: "active",
        },
        {
          wallet_id: "wallet_87654321",
          name: "saved-wallet",
          active: false,
          status: "available",
          selection_epoch: 1,
          authorization_status: "inactive",
        },
      ],
    });
    expectCode(
      await exercise("wallet_list_saved_profiles", "canonical active inventory"),
      "WALLET_LIST",
      "ready",
    );
    expectCode(
      await exercise("wallet_get_saved_profiles", "active inventory"),
      "WALLET_LIST",
      "ready",
    );
    expectCode(
      await exercise("wallet_manage_profiles", "deprecated active management alias"),
      "WALLET_LIST",
      "ready",
    );
    expectCode(
      await exercise("wallet_list", "legacy active list alias"),
      "WALLET_LIST",
      "ready",
    );

    expectCode(await exercise("wallet_get_tree", "live tree"), "WALLET_TREE", "ready");
    runtime.walletTree = async () => {
      throw new Error("TREE_REFRESH_FAILED");
    };
    expectCode(
      await exercise("wallet_get_tree", "refresh failure"),
      "REQUEST_BLOCKED",
      "blocked",
    );

    expectCode(
      await exercise(
        "wallet_preview_private_balance_create",
        "create first isolated pocket",
        { private_balance_name: "savings" },
      ),
      "PRIVATE_BALANCE_CREATE_PLANNED",
      "ready",
    );
    expectCode(
      await exercise(
        "wallet_preview_private_balance_create",
        "create pocket under named parent",
        { private_balance_name: "travel", wallet_name: "agent-boost" },
      ),
      "PRIVATE_BALANCE_CREATE_PLANNED",
      "ready",
    );
    expectCode(
      await exercise(
        "wallet_apply_private_balance_create",
        "creation confirmation missing",
        { decision_id: "pbc_12345678" },
      ),
      "PRIVATE_BALANCE_CREATE_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise(
        "wallet_apply_private_balance_create",
        "creation confirmed",
        { decision_id: "pbc_12345678", user_confirmed: true },
      ),
      "PRIVATE_BALANCE_CREATE_STATUS",
      "confirmed",
    );

    expectCode(
      await exercise(
        "wallet_preview_private_balance_fund",
        "fund pocket from main",
        {
          source: "$main",
          target_private_balance_name: "savings",
          amount_native: "0.1",
        },
      ),
      "PRIVATE_BALANCE_FUNDING_PLANNED",
      "ready",
    );
    expectCode(
      await exercise(
        "wallet_preview_private_balance_fund",
        "rebalance between private pockets",
        {
          source: "cash",
          target_private_balance_name: "savings",
          amount_native: "0.1",
        },
      ),
      "PRIVATE_BALANCE_FUNDING_PLANNED",
      "ready",
    );
    expectCode(
      await exercise(
        "wallet_apply_private_balance_fund",
        "funding confirmation missing",
        { decision_id: "pbf_12345678" },
      ),
      "PRIVATE_BALANCE_FUNDING_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise(
        "wallet_apply_private_balance_fund",
        "funding confirmed",
        { decision_id: "pbf_12345678", user_confirmed: true },
      ),
      "PRIVATE_BALANCE_FUNDING_STATUS",
      "confirmed",
    );
    expectCode(
      await exercise(
        "wallet_get_private_balance_operation",
        "creation status",
        { request_id: "pbcr_12345678" },
      ),
      "PRIVATE_BALANCE_OPERATION_STATUS",
      "confirmed",
    );
    expectCode(
      await exercise(
        "wallet_get_private_balance_operation",
        "funding status",
        { request_id: "pbfr_12345678" },
      ),
      "PRIVATE_BALANCE_OPERATION_STATUS",
      "confirmed",
    );
    expectCode(
      await exercise(
        "wallet_get_private_balance_operation",
        "creation timeout status by decision",
        { decision_id: "pbc_12345678" },
      ),
      "PRIVATE_BALANCE_OPERATION_STATUS",
      "confirmed",
    );
    expectCode(
      await exercise(
        "wallet_get_private_balance_operation",
        "funding timeout status by decision",
        { decision_id: "pbf_12345678" },
      ),
      "PRIVATE_BALANCE_OPERATION_STATUS",
      "confirmed",
    );

    expectCode(
      await exercise(
        "wallet_get_private_balance_policy",
        "enabled pocket policy",
        { private_balance_name: "savings" },
      ),
      "PRIVATE_BALANCE_POLICY",
      "ready",
    );
    const originalPrivateBalancePolicy = runtime.privateBalancePolicy.bind(runtime);
    runtime.privateBalancePolicy = async (input) => {
      const current = await originalPrivateBalancePolicy(input);
      const policy = current.policy as Record<string, unknown>;
      return { ...current, policy: { ...policy, enabled: false } };
    };
    expectCode(
      await exercise(
        "wallet_get_private_balance_policy",
        "disabled pocket policy",
        { private_balance_name: "savings" },
      ),
      "PRIVATE_BALANCE_POLICY",
      "ready",
    );
    runtime.privateBalancePolicy = originalPrivateBalancePolicy;

    expectCode(
      await exercise(
        "wallet_preview_private_balance_policy_update",
        "disable one pocket",
        { private_balance_name: "savings", enabled: false },
      ),
      "PRIVATE_BALANCE_POLICY_UPDATE_PLANNED",
      "ready",
    );
    expectCode(
      await exercise(
        "wallet_preview_private_balance_policy_update",
        "change one pocket count",
        { private_balance_name: "savings", max_payments: 2 },
      ),
      "PRIVATE_BALANCE_POLICY_UPDATE_PLANNED",
      "ready",
    );
    expectCode(
      await exercise(
        "wallet_apply_private_balance_policy_update",
        "pocket policy confirmation missing",
        { decision_id: "pbp_12345678" },
      ),
      "PRIVATE_BALANCE_POLICY_UPDATE_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise(
        "wallet_apply_private_balance_policy_update",
        "pocket policy confirmed",
        { decision_id: "pbp_12345678", user_confirmed: true },
      ),
      "PRIVATE_BALANCE_POLICY_UPDATED",
      "confirmed",
    );
    expectCode(
      await exercise(
        "wallet_get_private_balance_operation",
        "policy timeout status by decision",
        { decision_id: "pbp_12345678" },
      ),
      "PRIVATE_BALANCE_OPERATION_STATUS",
      "confirmed",
    );

    expectCode(await exercise("wallet_get_policy", "enabled policy"), "WALLET_POLICY", "ready");
    const enabledPolicy = await runtime.walletPolicy();
    runtime.walletPolicy = async () => ({ ...enabledPolicy, enabled: false });
    const disabledPolicy = await exercise("wallet_get_policy", "disabled policy");
    expectCode(disabledPolicy, "WALLET_POLICY", "ready");
    assert.equal(
      (structured(disabledPolicy).data as { policy: { enabled: boolean } }).policy.enabled,
      false,
    );

    expectCode(
      await exercise("wallet_preview_saved_profile_load", "canonical load preview", {
        wallet_name: "saved-wallet",
      }),
      "WALLET_SELECT_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise("wallet_apply_saved_profile_load", "canonical load approval", {
        wallet_name: "saved-wallet",
        expected_active_wallet_name: "agent-boost",
        expected_active_selection_epoch: 1,
        user_confirmed: true,
      }),
      "WALLET_SELECTED",
      "ready",
    );
    expectCode(
      await exercise("wallet_preview_saved_profile_load", "canonical cancellation preview", {
        wallet_name: "saved-wallet",
      }),
      "WALLET_SELECT_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise("wallet_apply_saved_profile_load", "canonical load cancellation", {
        wallet_name: "saved-wallet",
        expected_active_wallet_name: "agent-boost",
        expected_active_selection_epoch: 1,
        user_confirmed: false,
      }),
      "WALLET_SELECT_CONFIRMATION_REQUIRED",
      "blocked",
    );

    for (const walletMutation of [
      {
        name: "wallet_create",
        args: {
          name: "fresh-wallet",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
        },
        blockedCode: "WALLET_CREATE_CONFIRMATION_REQUIRED",
        readyCode: "WALLET_CREATED",
      },
      {
        name: "wallet_adopt_existing",
        args: {
          name: "existing-wallet",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
        },
        blockedCode: "WALLET_ADOPT_CONFIRMATION_REQUIRED",
        readyCode: "WALLET_ADOPTED",
      },
      {
        name: "wallet_switch_saved_profile",
        args: {
          wallet_id: "wallet_87654321",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
        },
        blockedCode: "WALLET_SELECT_CONFIRMATION_REQUIRED",
        readyCode: "WALLET_SELECTED",
      },
      {
        name: "wallet_select",
        args: {
          wallet_id: "wallet_87654321",
          expected_active_wallet_name: "agent-boost",
          expected_active_selection_epoch: 1,
        },
        blockedCode: "WALLET_SELECT_CONFIRMATION_REQUIRED",
        readyCode: "WALLET_SELECTED",
      },
      {
        name: "wallet_archive",
        args: { wallet_id: "wallet_87654321" },
        blockedCode: "WALLET_ARCHIVE_CONFIRMATION_REQUIRED",
        readyCode: "WALLET_ARCHIVED",
      },
    ]) {
      expectCode(
        await exercise(walletMutation.name, "confirmation missing", walletMutation.args),
        walletMutation.blockedCode,
        "blocked",
      );
      expectCode(
        await exercise(walletMutation.name, "trusted confirmation", {
          ...walletMutation.args,
          user_confirmed: true,
        }),
        walletMutation.readyCode,
        "ready",
      );
    }

    const originalReauthorizationPlan = runtime.planWalletReauthorization.bind(runtime);
    expectCode(
      await exercise("wallet_plan_reauthorization", "allowed plan"),
      "WALLET_REAUTHORIZATION_PLANNED",
      "ready",
    );
    runtime.planWalletReauthorization = async () => ({
      ...(await originalReauthorizationPlan()),
      decision: "deny",
      blockers: ["WALLET_NOT_READY"],
    });
    expectCode(
      await exercise("wallet_plan_reauthorization", "denied plan"),
      "WALLET_REAUTHORIZATION_DENIED",
      "blocked",
    );
    runtime.planWalletReauthorization = originalReauthorizationPlan;

    expectCode(
      await exercise("wallet_apply_reauthorization", "confirmation missing", {
        decision_id: "wra_12345678",
      }),
      "WALLET_REAUTHORIZATION_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise("wallet_apply_reauthorization", "trusted confirmation", {
        decision_id: "wra_12345678",
        user_confirmed: true,
      }),
      "WALLET_REAUTHORIZED",
      "ready",
    );
    expectCode(
      await exercise("wallet_reauthorize", "legacy confirmation missing", {
        decision_id: "wra_12345678",
      }),
      "WALLET_REAUTHORIZATION_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise("wallet_reauthorize", "legacy trusted confirmation", {
        decision_id: "wra_12345678",
        user_confirmed: true,
      }),
      "WALLET_REAUTHORIZED",
      "ready",
    );

    expectCode(
      await exercise("wallet_start_new_demo", "confirmation missing"),
      "DEMO_RESET_CONFIRMATION_REQUIRED",
      "blocked",
    );
    const originalStartOnboarding = fakeRuntime().startOnboarding;
    runtime.startOnboarding = originalStartOnboarding;
    expectCode(
      await exercise("wallet_start_new_demo", "trusted confirmation", {
        expected_active_wallet_name: "agent-boost",
        expected_active_selection_epoch: 1,
        user_confirmed: true,
      }),
      "DEMO_RESET_STARTED",
      "awaiting_funding",
    );

    const originalPolicyPlan = runtime.planPolicyUpdate.bind(runtime);
    expectCode(
      await exercise("wallet_plan_policy_update", "allowed update", {
        max_payments: 20,
        per_payment_limit_native: "0.5",
      }),
      "POLICY_UPDATE_PLANNED",
      "ready",
    );
    runtime.planPolicyUpdate = async (input) => ({
      ...(await originalPolicyPlan(input)),
      decision: "deny",
      blockers: ["POLICY_OUTSIDE_HARD_BOUNDS"],
    });
    expectCode(
      await exercise("wallet_plan_policy_update", "denied update", {
        max_payments: 100,
      }),
      "POLICY_UPDATE_DENIED",
      "blocked",
    );
    runtime.planPolicyUpdate = originalPolicyPlan;

    expectCode(
      await exercise("wallet_apply_policy_update", "confirmation missing", {
        decision_id: "wpd_12345678",
      }),
      "POLICY_UPDATE_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise("wallet_apply_policy_update", "confirmed exact plan", {
        decision_id: "wpd_12345678",
        user_confirmed: true,
      }),
      "POLICY_UPDATED",
      "confirmed",
    );

    const originalRegularPlan = runtime.planRegularTransfer.bind(runtime);
    expectCode(
      await exercise("wallet_preview_regular_transfer", "canonical address preview", {
        source: "$selected",
        destination: recipient,
        amount_native: "1",
      }),
      "REGULAR_TRANSFER_PLANNED",
      "ready",
    );
    expectCode(
      await exercise("wallet_preview_regular_transfer", "canonical friendly preview", {
        source: "$selected",
        destination: "new_private_wallet",
        amount_native: "1",
      }),
      "REGULAR_TRANSFER_PLANNED",
      "ready",
    );
    expectCode(
      await exercise("wallet_plan_regular_transfer", "allowed regular transfer", {
        recipient,
        amount_native: "1",
      }),
      "REGULAR_TRANSFER_PLANNED",
      "ready",
    );
    runtime.planRegularTransfer = async (input) => ({
      ...(await originalRegularPlan(input)),
      decision: "deny",
      blockers: ["INSUFFICIENT_MAIN_BALANCE_WITH_GAS_RESERVE"],
    });
    expectCode(
      await exercise("wallet_plan_regular_transfer", "denied regular transfer", {
        recipient,
        amount_native: "2",
      }),
      "REGULAR_TRANSFER_DENIED",
      "blocked",
    );
    runtime.planRegularTransfer = originalRegularPlan;

    expectCode(
      await exercise("wallet_execute_regular_transfer", "confirmation missing", {
        decision_id: "rwd_12345678",
      }),
      "REGULAR_TRANSFER_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise("wallet_execute_regular_transfer", "trusted confirmation", {
        decision_id: "rwd_12345678",
        user_confirmed: true,
      }),
      "REGULAR_TRANSFER_STATUS",
      "submitted",
    );

    const originalRegularStatus = runtime.getRegularTransferRequest.bind(runtime);
    expectCode(
      await exercise("wallet_get_regular_transfer_request", "submitted", {
        request_id: "rreq_12345678",
      }),
      "REGULAR_TRANSFER_STATUS",
      "submitted",
    );
    expectCode(
      await exercise("wallet_get_regular_transfer_request", "timeout status by decision", {
        decision_id: "rwd_12345678",
      }),
      "REGULAR_TRANSFER_STATUS",
      "submitted",
    );
    runtime.getRegularTransferRequest = async () => ({
      ...(await originalRegularStatus("rreq_12345678")),
      phase: "confirmed",
      confirmation: { method: "transaction_receipt", checkedAt: new Date(1_000).toISOString() },
    });
    expectCode(
      await exercise("wallet_get_regular_transfer_request", "confirmed", {
        request_id: "rreq_12345678",
      }),
      "REGULAR_TRANSFER_STATUS",
      "confirmed",
    );

    const originalPrivatePlan = runtime.planPrivatePayment.bind(runtime);
    expectCode(
      await exercise("wallet_preview_private_transfer", "allowed private payment", {
        source: "$selected",
        destination: recipient,
        amount_native: "0.01",
      }),
      "PAYMENT_PLANNED",
      "ready",
    );
    expectCode(
      await exercise("wallet_plan_private_payment", "legacy private address preview", {
        recipient,
        amount_native: "0.01",
      }),
      "PAYMENT_PLANNED",
      "ready",
    );
    expectCode(
      await exercise("wallet_plan_private_payment", "legacy private friendly preview", {
        recipient_wallet_name: "new_private_wallet",
        amount_native: "0.01",
      }),
      "PAYMENT_PLANNED",
      "ready",
    );
    runtime.planPrivatePayment = async (input) => ({
      ...(await originalPrivatePlan(input)),
      decision: "deny",
      blockers: ["PRIVATE_BALANCE_LIMIT"],
    });
    expectCode(
      await exercise("wallet_preview_private_transfer", "denied private payment", {
        source: "$selected",
        destination: recipient,
        amount_native: "1",
      }),
      "PAYMENT_DENIED",
      "blocked",
    );
    runtime.planPrivatePayment = originalPrivatePlan;

    expectCode(
      await exercise("wallet_execute_private_transfer", "confirmation missing", {
        decision_id: "wd_12345678",
      }),
      "PAYMENT_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise("wallet_execute_private_transfer", "trusted confirmation", {
        decision_id: "wd_12345678",
        user_confirmed: true,
      }),
      "PAYMENT_STATUS",
      "submitted",
    );
    expectCode(
      await exercise("wallet_execute_private_payment", "legacy confirmation missing", {
        decision_id: "wd_12345678",
      }),
      "PAYMENT_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise("wallet_execute_private_payment", "legacy trusted confirmation", {
        decision_id: "wd_12345678",
        user_confirmed: true,
      }),
      "PAYMENT_REQUEST",
      "submitted",
    );

    const originalPrivateStatus = runtime.getRequest.bind(runtime);
    expectCode(
      await exercise("wallet_get_private_transfer_request", "submitted", { request_id: "req_12345678" }),
      "PAYMENT_STATUS",
      "submitted",
    );
    expectCode(
      await exercise("wallet_get_private_transfer_request", "timeout status by decision", {
        decision_id: "wd_12345678",
      }),
      "PAYMENT_STATUS",
      "submitted",
    );
    expectCode(
      await exercise("wallet_get_private_payment_request", "legacy submitted status", {
        request_id: "req_12345678",
      }),
      "PAYMENT_STATUS",
      "submitted",
    );
    expectCode(
      await exercise("wallet_get_request", "legacy submitted private request", {
        request_id: "req_12345678",
      }),
      "PAYMENT_STATUS",
      "submitted",
    );
    runtime.getRequest = async () => ({
      ...(await originalPrivateStatus("req_12345678")),
      phase: "failed",
      error: { code: "TRANSACTION_REVERTED", message: "test revert" },
    });
    expectCode(
      await exercise("wallet_get_private_transfer_request", "failed", { request_id: "req_12345678" }),
      "PAYMENT_STATUS",
      "failed",
    );
    expectCode(
      await exercise("wallet_get_private_payment_request", "legacy failed status", {
        request_id: "req_12345678",
      }),
      "PAYMENT_STATUS",
      "failed",
    );
    expectCode(
      await exercise("wallet_get_request", "legacy failed private request", {
        request_id: "req_12345678",
      }),
      "PAYMENT_STATUS",
      "failed",
    );

    const originalRecoveryPlan = runtime.planRecoveryTransfer.bind(runtime);
    expectCode(
      await exercise("wallet_preview_recovery_transfer", "allowed recovery", {
        source: "$selected",
        destination: recipient,
        amount_native: "0.1",
      }),
      "RECOVERY_PLANNED",
      "ready",
    );
    expectCode(
      await exercise("wallet_plan_recovery_transfer", "legacy recovery address preview", {
        recipient,
        amount_native: "0.1",
      }),
      "RECOVERY_PLANNED",
      "ready",
    );
    expectCode(
      await exercise("wallet_plan_recovery_transfer", "legacy recovery friendly preview", {
        recipient_wallet_name: "new_private_wallet",
        amount_native: "0.1",
      }),
      "RECOVERY_PLANNED",
      "ready",
    );
    runtime.planRecoveryTransfer = async (input) => ({
      ...(await originalRecoveryPlan(input)),
      decision: "deny",
      blockers: ["RECOVERY_AMOUNT_EXCEEDS_MAX"],
    });
    expectCode(
      await exercise("wallet_preview_recovery_transfer", "denied recovery", {
        source: "$selected",
        destination: recipient,
        amount_native: "0.2",
      }),
      "RECOVERY_DENIED",
      "blocked",
    );
    runtime.planRecoveryTransfer = originalRecoveryPlan;

    expectCode(
      await exercise("wallet_execute_recovery_transfer", "confirmation missing", {
        decision_id: "wr_12345678",
      }),
      "RECOVERY_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise("wallet_execute_recovery_transfer", "trusted confirmation", {
        decision_id: "wr_12345678",
        user_confirmed: true,
      }),
      "RECOVERY_STATUS",
      "submitted",
    );

    const originalRecoveryStatus = runtime.getRecoveryRequest.bind(runtime);
    expectCode(
      await exercise("wallet_get_recovery_request", "submitted", {
        request_id: "wrr_12345678",
      }),
      "RECOVERY_STATUS",
      "submitted",
    );
    expectCode(
      await exercise("wallet_get_recovery_request", "timeout status by decision", {
        decision_id: "wr_12345678",
      }),
      "RECOVERY_STATUS",
      "submitted",
    );
    runtime.getRecoveryRequest = async () => ({
      ...(await originalRecoveryStatus("wrr_12345678")),
      phase: "indeterminate",
      error: { code: "EXECUTION_INTERRUPTED", message: "do not retry" },
    });
    expectCode(
      await exercise("wallet_get_recovery_request", "indeterminate", {
        request_id: "wrr_12345678",
      }),
      "RECOVERY_STATUS",
      "indeterminate",
    );

    const shippedTools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.equal(shippedTools.length, 54);
    assert.deepEqual(
      shippedTools.filter((name) => (coverage.get(name)?.size ?? 0) < 2),
      [],
      "every shipped tool must retain at least two named contract-level flows",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP error envelopes redact RPC credentials and local paths", async () => {
  const runtime = fakeRuntime();
  runtime.walletContext = async () => {
    throw new Error(
      "failed at https://rpc.example.invalid/private-token in /Users/alice/.wallet/state.json",
    );
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({
    name: "wallet_get_main_balance",
    arguments: {},
  });
  const serialized = JSON.stringify(response);
  assert.match(serialized, /\[redacted-url\]/);
  assert.match(serialized, /\[redacted-path\]/);
  assert.doesNotMatch(serialized, /private-token|Users\/alice/);

  await client.close();
  await server.close();
});

test("MCP rejects additional balance fields at the public contract boundary", async () => {
  const runtime = fakeRuntime();
  const validContext = await runtime.walletContext();
  runtime.walletContext = async () => ({
    ...validContext,
    balances: {
      private_payment_spendable_atomic: "999999999999999999",
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({
    name: "wallet_get_main_balance",
    arguments: {},
  });
  const structured = response.structuredContent as {
    outcome: string;
    code: string;
    data: { message: string };
  };
  assert.equal(structured.outcome, "blocked");
  assert.equal(structured.code, "REQUEST_BLOCKED");
  assert.match(structured.data.message, /additional balance fields are forbidden/u);
  assert.doesNotMatch(JSON.stringify(response), /999999999999999999/u);

  await client.close();
  await server.close();
});

test("MCP rejects any claim that the main account controls subaccounts", async () => {
  const runtime = fakeRuntime();
  const validContext = await runtime.walletContext();
  runtime.walletContext = async () => ({
    ...validContext,
    controls_subaccounts: true,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client({ name: "test", version: "1.0.0" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({
    name: "wallet_get_main_balance",
    arguments: {},
  });
  const structured = response.structuredContent as {
    outcome: string;
    code: string;
    data: { message: string };
  };
  assert.equal(structured.outcome, "blocked");
  assert.equal(structured.code, "REQUEST_BLOCKED");
  assert.match(structured.data.message, /invalid main account semantics/u);

  await client.close();
  await server.close();
});
