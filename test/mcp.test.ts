import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { AgentBoostRuntime } from "../src/mcp.js";
import { createMcpServer } from "../src/mcp.js";

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";
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
    async applyPolicyUpdate(input) {
      assert.equal(input.decisionId, "wpd_12345678");
      assert.equal(input.userConfirmed, true);
      return {
        version: 1,
        decisionId: input.decisionId,
        appliedAt: new Date(1_000).toISOString(),
        policy: {
          ...setup.delegation,
          perPaymentLimitWei: "1000000000000000000",
          lifetimeLimitWei: "10000000000000000000",
          maxPayments: 10,
          paymentsUsed: 0,
          paymentsRemaining: 10,
        },
      };
    },
    async listWallets() {
      return { active_wallet_id: AUTHORIZATION.walletId, wallets: [] };
    },
    async createWallet() {
      return { authorization_required: true };
    },
    async adoptWallet() {
      return { authorization_required: true };
    },
    async selectWallet() {
      return { authorization_required: true };
    },
    async archiveWallet() {
      return {};
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
      return {};
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
      throw new Error("not used");
    },
    async planRecoveryTransfer(input) {
      return {
        version: 1,
        decisionId: "wr_12345678",
        authorization: AUTHORIZATION,
        recipient: input.recipient,
        amountWei: "100000000000000000",
        privateBalanceSnapshotWei: "100000000000000000",
        balanceRevision: 4,
        intentDigest: `sha256:${"1".repeat(64)}`,
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(300_000).toISOString(),
        decision: "allow",
        blockers: [],
        approval: { action: "confirm", userConfirmationRequired: true },
      };
    },
    async executeRecoveryTransfer(input) {
      return {
        version: 1,
        requestId: "wrr_12345678",
        clientRequestId: input.clientRequestId,
        decisionId: input.decisionId,
        authorization: AUTHORIZATION,
        recipient: "0x2222222222222222222222222222222222222222",
        amountWei: "100000000000000000",
        phase: "submitted",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
    async getRecoveryRequest() {
      throw new Error("not used");
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
  const client = new Client({ name: "test", version: "1.0.0" });
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
      "wallet_get_context",
      "wallet_get_policy",
      "wallet_get_recovery_request",
      "wallet_get_request",
      "wallet_get_tree",
      "wallet_list",
      "wallet_plan_policy_update",
      "wallet_plan_private_payment",
      "wallet_plan_reauthorization",
      "wallet_plan_recovery_transfer",
      "wallet_reauthorize",
      "wallet_select",
      "wallet_start_new_demo",
    ],
  );
  const walletContextTool = tools.tools.find(
    (tool) => tool.name === "wallet_get_context",
  );
  assert.match(walletContextTool?.description ?? "", /same turn/u);
  assert.match(
    walletContextTool?.description ?? "",
    /History, memory, onboarding state, and prior tool results are not current-balance sources/u,
  );
  assert.match(
    walletContextTool?.description ?? "",
    /without converting balance_atomic/u,
  );
  const walletTreeTool = tools.tools.find(
    (tool) => tool.name === "wallet_get_tree",
  );
  assert.match(walletTreeTool?.description ?? "", /all wallets/u);
  assert.match(walletTreeTool?.description ?? "", /folders organize views only/u);
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
    /Quote exactly: Main account balance: 1\.5 Sepolia ETH/u,
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
  assert.match(
    policyPlanText?.type === "text" ? policyPlanText.text : "",
    /permission only(?:—|-)it does not move funds/u,
  );

  const policyApplied = await client.callTool({
    name: "wallet_apply_policy_update",
    arguments: { decision_id: "wpd_12345678", user_confirmed: true },
  });
  assert.equal(
    (policyApplied.structuredContent as { code: string }).code,
    "POLICY_UPDATED",
  );

  const plan = await client.callTool({
    name: "wallet_plan_private_payment",
    arguments: {
      recipient: "0x2222222222222222222222222222222222222222",
      amount_atomic: "10000000000000000",
    },
  });
  const planText = plan.content.find((block) => block.type === "text");
  assert.equal(planText?.type, "text");
  assert.match(planText?.type === "text" ? planText.text : "", /native approval/u);
  assert.doesNotMatch(planText?.type === "text" ? planText.text : "", /wd_|amountWei|intentDigest/u);
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
    const client = new Client(
      { name: "elicitation-test", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );
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
    const client = new Client(
      { name: "elicitation-test", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );
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
    const client = new Client({ name: "legacy-test", version: "1.0.0" });
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

test("MCP error envelopes redact RPC credentials and local paths", async () => {
  const runtime = fakeRuntime();
  runtime.walletContext = async () => {
    throw new Error(
      "failed at https://rpc.example.invalid/private-token in /Users/alice/.wallet/state.json",
    );
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(runtime);
  const client = new Client({ name: "test", version: "1.0.0" });
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
  const client = new Client({ name: "test", version: "1.0.0" });
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
  const client = new Client({ name: "test", version: "1.0.0" });
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
