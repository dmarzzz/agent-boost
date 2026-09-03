import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { AgentBoostRuntime } from "../src/mcp.js";
import { createMcpServer } from "../src/mcp.js";

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";
const HERMES_MODEL_CONTEXT_KEY = "org.agentboost/model-context";
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
            }],
          },
          {
            shortName: "travel",
            active: false,
            setupPhase: "private_ready",
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
            }],
          },
        ],
        archivedProfiles: 1,
        relationship: { type: "profile_container", impliesControl: false },
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
            authorization_status: "active",
          },
          {
            wallet_id: "wallet_87654321",
            name: "saved-wallet",
            status: "available",
            active: false,
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
    async reauthorizeWallet() {
      return { wallet: { name: "agent-boost" } };
    },
    async planRegularTransfer(input) {
      return {
        version: 1,
        decisionId: "rwd_12345678",
        recipient: input.recipient,
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
        recipient: input.recipient,
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
      };
    },
    async planRecoveryTransfer(input) {
      return {
        version: 1,
        decisionId: "wr_12345678",
        wallet: WALLET_SELECTION,
        recipient: input.recipient,
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
      "wallet_archive",
      "wallet_create",
      "wallet_execute_private_payment",
      "wallet_execute_recovery_transfer",
      "wallet_execute_regular_transfer",
      "wallet_get_context",
      "wallet_get_policy",
      "wallet_get_recovery_request",
      "wallet_get_regular_transfer_request",
      "wallet_get_request",
      "wallet_get_tree",
      "wallet_list",
      "wallet_plan_policy_update",
      "wallet_plan_private_payment",
      "wallet_plan_reauthorization",
      "wallet_plan_recovery_transfer",
      "wallet_plan_regular_transfer",
      "wallet_reauthorize",
      "wallet_select",
      "wallet_start_new_demo",
    ],
  );
  const walletContextTool = tools.tools.find(
    (tool) => tool.name === "wallet_get_context",
  );
  assert.match(walletContextTool?.description ?? "", /same turn/u);
  assert.match(walletContextTool?.description ?? "", /wallet_get_tree instead/u);
  assert.match(walletContextTool?.description ?? "", /do not call this first/u);
  assert.match(
    walletContextTool?.description ?? "",
    /History, memory, onboarding state, and prior tool results are not current-balance sources/u,
  );
  assert.match(
    walletContextTool?.description ?? "",
    /without converting balance_atomic/u,
  );
  assert.match(walletContextTool?.description ?? "", /pass it as amount_native/u);
  const walletTreeTool = tools.tools.find(
    (tool) => tool.name === "wallet_get_tree",
  );
  assert.match(walletTreeTool?.description ?? "", /all wallets/u);
  assert.match(walletTreeTool?.description ?? "", /folders organize views only/u);
  assert.match(walletTreeTool?.description ?? "", /entire final answer is data\.rendered exactly/u);
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
    arguments: { user_confirmed: true },
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
    name: "wallet_get_context",
    arguments: {},
  });
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

  const affordabilityContext = await client.callTool({
    name: "wallet_get_context",
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
        accounts: Array<{
          short_name: string;
          balance_native: string;
          freshness: string;
        }>;
      }>;
      relationship: { implies_control: boolean };
    };
  }).data;
  assert.equal(
    walletTreeData.rendered,
    [
      "🗂 wallets/",
      "|-- 💼 agent-boost/ [active]",
      "|   |-- 🌐 main/      ≈68.899 Sepolia ETH · live",
      "|   `-- 🥷 private/   0.25 Sepolia ETH · live",
      "`-- 💼 travel/",
      "    |-- 🌐 main/      0.75 Sepolia ETH · live",
      "    `-- 🥷 private/   0.1 Sepolia ETH · last known",
      "",
      "Folders organize wallet views; they do not imply custody or control.",
    ].join("\n"),
  );
  assert.equal(walletTreeData.addresses_included, false);
  assert.equal(walletTreeData.raw_atomic_values_included, false);
  assert.equal(walletTreeData.archived_profiles_hidden, 1);
  assert.equal(walletTreeData.relationship.implies_control, false);
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
  assert.doesNotMatch(JSON.stringify(policy), new RegExp(WALLET_ADDRESS, "u"));

  const policyPlanTool = tools.tools.find(
    (tool) => tool.name === "wallet_plan_policy_update",
  );
  const policyApplyTool = tools.tools.find(
    (tool) => tool.name === "wallet_apply_policy_update",
  );
  assert.match(policyPlanTool?.description ?? "", /REQUEST-TURN TOOL ONLY/u);
  assert.match(policyApplyTool?.title ?? "", /after yes or ✅/u);
  const policyApplyRequired = (policyApplyTool?.inputSchema as {
    required?: string[];
  }).required ?? [];
  assert.ok(!policyApplyRequired.includes("decision_id"));

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
  const policyPlanText = policyPlan.content.find((block) => block.type === "text");
  const policyPlanEnvelope = policyPlan.structuredContent as {
    data: { applied: boolean; requires_new_user_confirmation: boolean };
    presentation: { kind: string; state: string };
  };
  assert.equal(policyPlanEnvelope.data.applied, false);
  assert.equal(policyPlanEnvelope.data.requires_new_user_confirmation, true);
  assert.equal(policyPlanEnvelope.presentation.kind, "confirmation");
  assert.equal(policyPlanEnvelope.presentation.state, "pending");
  assert.match(
    policyPlanText?.type === "text" ? policyPlanText.text : "",
    /permission only(?:—|-)it does not move funds/u,
  );
  assert.match(
    policyPlanText?.type === "text" ? policyPlanText.text : "",
    /PREVIEW ONLY (?:—|-) NOT APPLIED/u,
  );
  assert.match(
    policyPlanText?.type === "text" ? policyPlanText.text : "",
    /end this turn[\s\S]*new user message/u,
  );
  assert.doesNotMatch(
    policyPlanText?.type === "text" ? policyPlanText.text : "",
    /wpd_/u,
  );
  const hermesPolicyResult = simulateHermesContentArbitration(policyPlan);
  assert.doesNotMatch(hermesPolicyResult.result, /wpd_/u);
  const hermesPolicyContext = hermesPolicyResult._meta?.[HERMES_MODEL_CONTEXT_KEY] as {
    data: { plan: { decisionId: string } };
  };
  assert.equal(hermesPolicyContext.data.plan.decisionId, "wpd_12345678");

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
    /new user message[\s\S]*Do not plan again/u,
  );

  const policyApplied = await client.callTool({
    name: "wallet_apply_policy_update",
    arguments: { user_confirmed: true },
  });
  assert.equal(
    (policyApplied.structuredContent as { code: string }).code,
    "POLICY_UPDATED",
  );

  const regularPlan = await client.callTool({
    name: "wallet_plan_regular_transfer",
    arguments: {
      recipient: "0x2222222222222222222222222222222222222222",
      amount_native: "1",
    },
  });
  const regularPlanText = regularPlan.content.find((block) => block.type === "text");
  assert.match(
    regularPlanText?.type === "text" ? regularPlanText.text : "",
    /Regular public transfer ready for native approval/u,
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
  const regularPresentation = (regularPlan.structuredContent as {
    presentation: { title: string; notice: { text: string } };
  }).presentation;
  assert.equal(regularPresentation.title, "Confirm regular testnet transfer");
  assert.match(regularPresentation.notice.text, /public Sepolia transfer from the main account/u);

  const regularExecuted = await client.callTool({
    name: "wallet_execute_regular_transfer",
    arguments: { decision_id: "rwd_12345678", user_confirmed: true },
  });
  const regularExecutedPayload = regularExecuted.structuredContent as {
    code: string;
    data: { request: { clientRequestId: string } };
  };
  assert.equal(regularExecutedPayload.code, "REGULAR_TRANSFER_REQUEST");
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
    /Regular public transfer is not confirmed[\s\S]*wallet_get_regular_transfer_request/u,
  );

  const plan = await client.callTool({
    name: "wallet_plan_private_payment",
    arguments: {
      recipient: "0x2222222222222222222222222222222222222222",
      amount_native: "0.01",
    },
  });
  const planText = plan.content.find((block) => block.type === "text");
  assert.equal(planText?.type, "text");
  assert.match(planText?.type === "text" ? planText.text : "", /native approval/u);
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
      interaction: { transport: string };
      fields: Array<{ label: string; value: string }>;
    };
  }).presentation;
  assert.equal(planPresentation.kind, "confirmation");
  assert.equal(planPresentation.title, "Confirm private test payment");
  assert.equal(planPresentation.interaction.transport, "mcp_elicitation");
  assert.deepEqual(
    planPresentation.fields.map((field) => field.label),
    ["Amount", "To", "Network"],
  );

  const executeTool = tools.tools.find(
    (tool) => tool.name === "wallet_execute_private_payment",
  );
  const planTool = tools.tools.find(
    (tool) => tool.name === "wallet_plan_private_payment",
  );
  const planProperties = (planTool?.inputSchema as {
    properties?: Record<string, unknown>;
  }).properties ?? {};
  assert.ok("amount_native" in planProperties);
  assert.ok(!("amount_atomic" in planProperties));
  assert.match(executeTool?.description ?? "", /agent—not the user/u);
  assert.match(executeTool?.description ?? "", /Never ask the user to supply tool syntax/u);

  const executed = await client.callTool({
    name: "wallet_execute_private_payment",
    arguments: {
      decision_id: "wd_12345678",
      user_confirmed: true,
    },
  });
  const executedPayload = executed.structuredContent as {
    data: { request: { clientRequestId: string } };
  };
  assert.equal(
    executedPayload.data.request.clientRequestId,
    "hermes:wd_12345678",
  );
  assert.doesNotMatch(
    JSON.stringify(executedPayload),
    /recipientBalanceBeforeWei|reconciliation/,
  );
  const executedText = executed.content.find((block) => block.type === "text");
  assert.match(
    executedText?.type === "text" ? executedText.text : "",
    /not confirmed[\s\S]*wallet_get_request[\s\S]*Never infer success/u,
  );
  const hermesRequestResult = simulateHermesContentArbitration(executed);
  const hermesRequestContext = hermesRequestResult._meta?.[HERMES_MODEL_CONTEXT_KEY] as {
    data: { request: { requestId: string } };
  };
  assert.equal(hermesRequestContext.data.request.requestId, "req_12345678");

  await client.close();
  await server.close();
});

test("MCP native payment confirmation accepts, declines, and fails closed", async (t) => {
  await t.test("accepted elicitation executes the exact plan", async () => {
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
      { name: "elicitation-test", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    ));
    let prompt = "";
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      assert.equal(request.params.mode, "form");
      prompt = request.params.message;
      return { action: "accept", content: {} };
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "wallet_execute_private_payment",
        arguments: { decision_id: "wd_12345678" },
      });
      assert.equal(
        (response.structuredContent as { code: string }).code,
        "PAYMENT_REQUEST",
      );
      assert.equal(executeCalls, 1);
      assert.match(prompt, /Confirm private test payment/u);
      assert.match(prompt, /Amount: 0\.02 Sepolia ETH/u);
      assert.match(prompt, /0x2222222222222222222222222222222222222222/u);
      assert.match(prompt, /on-chain activity remains visible/u);
    } finally {
      await client.close();
      await server.close();
    }
  });

  await t.test("declined elicitation never executes", async () => {
    const runtime = fakeRuntime();
    let executed = false;
    runtime.executePrivatePayment = async () => {
      executed = true;
      throw new Error("must not execute");
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await createMcpServer(runtime);
    const client = testMcpClient(new Client(
      { name: "elicitation-test", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    ));
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "wallet_execute_private_payment",
        arguments: { decision_id: "wd_12345678" },
      });
      const structured = response.structuredContent as {
        code: string;
        outcome: string;
        presentation: { state: string };
      };
      assert.equal(structured.code, "PAYMENT_CANCELLED");
      assert.equal(structured.outcome, "blocked");
      assert.equal(structured.presentation.state, "cancelled");
      assert.equal(executed, false);
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
        name: "wallet_execute_private_payment",
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
    { name: "regular-elicitation-test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  ));
  let prompt = "";
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompt = request.params.message;
    return { action: "accept", content: {} };
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.callTool({
      name: "wallet_execute_regular_transfer",
      arguments: { decision_id: "rwd_12345678" },
    });
    assert.equal(
      (response.structuredContent as { code: string }).code,
      "REGULAR_TRANSFER_REQUEST",
    );
    assert.equal(regularCalls, 1);
    assert.equal(privateCalls, 0);
    assert.match(prompt, /Confirm regular testnet transfer/u);
    assert.match(prompt, /From: selected main public account/u);
    assert.match(prompt, /regular public transfer/u);
  } finally {
    await client.close();
    await server.close();
  }
});

test("wallet lifecycle confirmations use friendly names and keep internal IDs out of text", async () => {
  const runtime = fakeRuntime();
  const prompts: string[] = [];
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = testMcpClient(new Client(
    { name: "wallet-lifecycle-elicitation-test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  ));
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompts.push(request.params.message);
    return { action: "accept", content: {} };
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.callTool({ name: "wallet_list", arguments: {} });
    const listText = list.content.find((block) => block.type === "text");
    assert.equal(listText?.type, "text");
    assert.match(listText.text, /saved-wallet/u);
    assert.doesNotMatch(listText.text, /wallet_[A-Za-z0-9-]+/u);

    const selected = await client.callTool({
      name: "wallet_select",
      arguments: { wallet_id: "wallet_87654321" },
    });
    const selectedText = selected.content.find((block) => block.type === "text");
    assert.equal(selectedText?.type, "text");
    assert.match(selectedText.text, /saved-wallet is now selected/u);
    assert.doesNotMatch(selectedText.text, /wallet_[A-Za-z0-9-]+/u);

    const plan = await client.callTool({
      name: "wallet_plan_reauthorization",
      arguments: {},
    });
    assert.equal(
      (plan.structuredContent as { code: string }).code,
      "WALLET_REAUTHORIZATION_PLANNED",
    );
    const reauthorized = await client.callTool({
      name: "wallet_reauthorize",
      arguments: { decision_id: "wra_12345678" },
    });
    assert.equal(
      (reauthorized.structuredContent as { code: string }).code,
      "WALLET_REAUTHORIZED",
    );

    assert.equal(prompts.length, 2);
    assert.match(prompts[0]!, /saved-wallet/u);
    assert.doesNotMatch(prompts[0]!, /wallet_[A-Za-z0-9-]+/u);
    assert.match(prompts[1]!, /agent-boost/u);
    assert.match(prompts[1]!, /0\.1 Sepolia ETH max each/u);
    assert.match(prompts[1]!, /0\.1 Sepolia ETH total/u);
    assert.doesNotMatch(prompts[1]!, /\bwei\b/u);
    assert.doesNotMatch(prompts[1]!, /(?:wallet_|wra_)[A-Za-z0-9-]+/u);
  } finally {
    await client.close();
    await server.close();
  }
});

test("declined wallet reauthorization and recovery confirmations cause no execution", async () => {
  const runtime = fakeRuntime();
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
    { name: "wallet-lifecycle-decline-test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  ));
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const reauthorization = await client.callTool({
      name: "wallet_reauthorize",
      arguments: { decision_id: "wra_12345678" },
    });
    const reauthorizationResult = reauthorization.structuredContent as {
      code: string;
      presentation: { state: string };
    };
    assert.equal(reauthorizationResult.code, "WALLET_REAUTHORIZATION_CONFIRMATION_REQUIRED");
    assert.equal(reauthorizationResult.presentation.state, "cancelled");
    const reauthorizationText = reauthorization.content.find((block) => block.type === "text");
    assert.equal(reauthorizationText?.type, "text");
    assert.match(reauthorizationText.text, /reauthorization cancelled/u);

    const recovery = await client.callTool({
      name: "wallet_execute_recovery_transfer",
      arguments: { decision_id: "wr_12345678" },
    });
    const recoveryResult = recovery.structuredContent as {
      code: string;
      presentation: { state: string };
    };
    assert.equal(recoveryResult.code, "RECOVERY_CONFIRMATION_REQUIRED");
    assert.equal(recoveryResult.presentation.state, "cancelled");
    const recoveryText = recovery.content.find((block) => block.type === "text");
    assert.equal(recoveryText?.type, "text");
    assert.match(recoveryText.text, /Recovery transfer cancelled/u);
    assert.equal(reauthorizationCalls, 0);
    assert.equal(recoveryCalls, 0);
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
      phase: "failed",
      revision: waiting.revision + 1,
      error: { code: "SHIELD_FAILED", message: "test failure", retryable: false },
    });
    expectCode(
      await exercise("onboarding_status", "terminal failure", {
        setup_id: "setup_12345678",
      }),
      "ONBOARDING_STATUS",
      "failed",
    );

    const affordable = await exercise("wallet_get_context", "affordable amount", {
      amount_native: "1",
    });
    const unaffordable = await exercise("wallet_get_context", "unaffordable amount", {
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

    expectCode(await exercise("wallet_list", "empty inventory"), "WALLET_LIST", "ready");
    runtime.listWallets = async () => ({
      active_wallet_id: AUTHORIZATION.walletId,
      wallets: [
        {
          wallet_id: AUTHORIZATION.walletId,
          name: "agent-boost",
          active: true,
          status: "available",
          authorization_status: "active",
        },
        {
          wallet_id: "wallet_87654321",
          name: "saved-wallet",
          active: false,
          status: "available",
          authorization_status: "inactive",
        },
      ],
    });
    expectCode(await exercise("wallet_list", "active inventory"), "WALLET_LIST", "ready");

    expectCode(await exercise("wallet_get_tree", "live tree"), "WALLET_TREE", "ready");
    runtime.walletTree = async () => {
      throw new Error("TREE_REFRESH_FAILED");
    };
    expectCode(
      await exercise("wallet_get_tree", "refresh failure"),
      "REQUEST_BLOCKED",
      "blocked",
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

    for (const walletMutation of [
      {
        name: "wallet_create",
        args: { name: "fresh-wallet" },
        blockedCode: "WALLET_CREATE_CONFIRMATION_REQUIRED",
        readyCode: "WALLET_CREATED",
      },
      {
        name: "wallet_adopt_existing",
        args: { name: "existing-wallet" },
        blockedCode: "WALLET_ADOPT_CONFIRMATION_REQUIRED",
        readyCode: "WALLET_ADOPTED",
      },
      {
        name: "wallet_select",
        args: { wallet_id: "wallet_87654321" },
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
      await exercise("wallet_reauthorize", "confirmation missing", {
        decision_id: "wra_12345678",
      }),
      "WALLET_REAUTHORIZATION_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise("wallet_reauthorize", "trusted confirmation", {
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
      await exercise("wallet_apply_policy_update", "confirmed latest plan", {
        user_confirmed: true,
      }),
      "POLICY_UPDATED",
      "confirmed",
    );

    const originalRegularPlan = runtime.planRegularTransfer.bind(runtime);
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
      "REGULAR_TRANSFER_REQUEST",
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
      await exercise("wallet_plan_private_payment", "allowed private payment", {
        recipient,
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
      await exercise("wallet_plan_private_payment", "denied private payment", {
        recipient,
        amount_native: "1",
      }),
      "PAYMENT_DENIED",
      "blocked",
    );
    runtime.planPrivatePayment = originalPrivatePlan;

    expectCode(
      await exercise("wallet_execute_private_payment", "confirmation missing", {
        decision_id: "wd_12345678",
      }),
      "PAYMENT_CONFIRMATION_REQUIRED",
      "blocked",
    );
    expectCode(
      await exercise("wallet_execute_private_payment", "trusted confirmation", {
        decision_id: "wd_12345678",
        user_confirmed: true,
      }),
      "PAYMENT_REQUEST",
      "submitted",
    );

    const originalPrivateStatus = runtime.getRequest.bind(runtime);
    expectCode(
      await exercise("wallet_get_request", "submitted", { request_id: "req_12345678" }),
      "PAYMENT_STATUS",
      "submitted",
    );
    runtime.getRequest = async () => ({
      ...(await originalPrivateStatus("req_12345678")),
      phase: "failed",
      error: { code: "TRANSACTION_REVERTED", message: "test revert" },
    });
    expectCode(
      await exercise("wallet_get_request", "failed", { request_id: "req_12345678" }),
      "PAYMENT_STATUS",
      "failed",
    );

    const originalRecoveryPlan = runtime.planRecoveryTransfer.bind(runtime);
    expectCode(
      await exercise("wallet_plan_recovery_transfer", "allowed recovery", {
        recipient,
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
      await exercise("wallet_plan_recovery_transfer", "denied recovery", {
        recipient,
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
      "RECOVERY_REQUEST",
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
    assert.equal(shippedTools.length, 32);
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
    name: "wallet_get_context",
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
    name: "wallet_get_context",
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
    name: "wallet_get_context",
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
