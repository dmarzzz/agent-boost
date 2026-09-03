import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AgentBoostRuntime } from "../src/mcp.js";
import { createMcpServer } from "../src/mcp.js";

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";

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
    async planPrivatePayment(input) {
      return {
        version: 1,
        decisionId: "wd_12345678",
        recipient: input.recipient,
        amountWei: input.amountWei,
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
      "wallet_execute_private_payment",
      "wallet_get_context",
      "wallet_get_request",
      "wallet_plan_private_payment",
      "wallet_start_new_demo",
    ],
  );
  const walletContextTool = tools.tools.find(
    (tool) => tool.name === "wallet_get_context",
  );
  assert.match(walletContextTool?.description ?? "", /same turn/u);
  assert.match(
    walletContextTool?.description ?? "",
    /Never answer from history, memory, onboarding state, or a prior tool result/u,
  );
  assert.match(
    walletContextTool?.description ?? "",
    /do not convert balance_atomic yourself/u,
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

  const plan = await client.callTool({
    name: "wallet_plan_private_payment",
    arguments: {
      recipient: "0x2222222222222222222222222222222222222222",
      amount_atomic: "10000000000000000",
    },
  });
  const planText = plan.content.find((block) => block.type === "text");
  assert.equal(planText?.type, "text");
  assert.match(planText?.type === "text" ? planText.text : "", /reply ✅, yes, or send it/u);
  assert.doesNotMatch(planText?.type === "text" ? planText.text : "", /wd_|amountWei|intentDigest/u);

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
