import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type {
  RegularTransferPlan,
  RegularTransferRequest,
} from "../src/contracts.js";
import type { AgentBoostRuntime } from "../src/mcp.js";
import { createMcpServer } from "../src/mcp.js";

const MAIN = "0x1111111111111111111111111111111111111111";
const CHANGE = "0x3333333333333333333333333333333333333333";
const BACKEND = "abpb-secret-backend-name";
const POLICY_DEBIT_AT = "2026-01-01T00:00:01.000Z";
const AUTHORIZATION = {
  walletId: "wallet_regular_redaction",
  walletName: "agent-boost",
  selectionEpoch: 1,
  authorizationId: "auth_regular_redaction",
};
const POCKET = {
  walletId: AUTHORIZATION.walletId,
  walletName: AUTHORIZATION.walletName,
  selectionEpoch: AUTHORIZATION.selectionEpoch,
  privateBalanceId: "private_regular_redaction",
  privateBalanceName: "travel",
  backendWalletName: BACKEND,
  privateBalanceRevision: 4,
};
const PLAN: RegularTransferPlan = {
  version: 1,
  decisionId: "rwd_regular_redaction",
  recipient: MAIN,
  amountWei: "2000000000000000",
  mainBalanceSnapshotWei: "5000000000000000",
  gasReserveWei: "1000000000000000",
  authorization: AUTHORIZATION,
  sourcePrivateBalance: POCKET,
  sourcePublicAddress: CHANGE,
  intentDigest: `sha256:${"a".repeat(64)}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:05:00.000Z",
  decision: "allow",
  blockers: [],
  approval: { action: "confirm", userConfirmationRequired: true },
};
const REQUEST: RegularTransferRequest = {
  version: 1,
  requestId: "rreq_regular_redaction",
  clientRequestId: "hermes:rwd_regular_redaction",
  decisionId: PLAN.decisionId,
  recipient: PLAN.recipient,
  amountWei: PLAN.amountWei,
  gasReserveWei: PLAN.gasReserveWei,
  authorization: AUTHORIZATION,
  sourcePrivateBalance: POCKET,
  sourcePublicAddress: CHANGE,
  sourcePublicBalanceBeforeWei: PLAN.mainBalanceSnapshotWei,
  sourcePublicBalanceAfterWei: "1999000000000000",
  phase: "confirmed",
  createdAt: PLAN.createdAt,
  updatedAt: POLICY_DEBIT_AT,
  broadcastStartedAt: POLICY_DEBIT_AT,
  policySpendDebitedAt: POLICY_DEBIT_AT,
  privatePolicySpendDebitedAt: POLICY_DEBIT_AT,
  transactionHash: `0x${"b".repeat(64)}`,
  confirmation: { method: "transaction_receipt", checkedAt: POLICY_DEBIT_AT },
  reconciliation: { attempts: 1, checkedAt: POLICY_DEBIT_AT },
};

type TestClient = Omit<Client, "callTool"> & {
  callTool(input: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult>;
};

function partialRuntime(): AgentBoostRuntime {
  return {
    async capabilities() {
      return { version: 1, network: "sepolia" };
    },
    async egressCapabilities() {
      return { version: 1, route: "shade-tree" };
    },
    async planRegularTransfer(
      input: Parameters<AgentBoostRuntime["planRegularTransfer"]>[0],
    ) {
      assert.equal(input.sourcePrivateBalanceName, "travel");
      return PLAN;
    },
    async getRegularTransferPlan(decisionId: string) {
      assert.equal(decisionId, PLAN.decisionId);
      return PLAN;
    },
    async executeRegularTransfer(
      input: Parameters<AgentBoostRuntime["executeRegularTransfer"]>[0],
    ) {
      assert.equal(input.decisionId, PLAN.decisionId);
      assert.equal(input.userConfirmed, true);
      return REQUEST;
    },
    async getRegularTransferRequest(requestId: string) {
      assert.equal(requestId, REQUEST.requestId);
      return REQUEST;
    },
  } as unknown as AgentBoostRuntime;
}

function assertNoPocketExecutionSecrets(result: CallToolResult): void {
  const visible = JSON.stringify(result);
  assert.doesNotMatch(visible, new RegExp(CHANGE, "iu"));
  assert.doesNotMatch(visible, new RegExp(BACKEND, "iu"));
  assert.doesNotMatch(visible, /sourcePublicAddress/iu);
  assert.doesNotMatch(visible, /backendWalletName/iu);
  assert.doesNotMatch(visible, /(?:private)?PolicySpend(?:Debited|Restored)At/iu);
}

test("MCP pocket regular preview and receipt hide exact source-account internals", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(partialRuntime());
  const client = new Client({
    name: "regular-transfer-public-output-test",
    version: "1.0.0",
  }) as TestClient;
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const preview = await client.callTool({
      name: "wallet_preview_regular_transfer",
      arguments: {
        source: "$selected",
        destination: MAIN,
        source_private_balance: "travel",
        amount_native: "0.002",
      },
    });
    assertNoPocketExecutionSecrets(preview);
    const previewSurface = JSON.stringify(preview);
    assert.match(previewSurface, /travel/u);
    assert.match(previewSurface, /public change/iu);
    assert.doesNotMatch(
      previewSurface,
      /public Sepolia transfer from the main account/iu,
    );

    const receipt = await client.callTool({
      name: "wallet_execute_regular_transfer",
      arguments: {
        decision_id: PLAN.decisionId,
        user_confirmed: true,
      },
    });
    assertNoPocketExecutionSecrets(receipt);
    assert.match(JSON.stringify(receipt), /travel/u);
    const userFacing = receipt._meta?.["org.agentboost/user-facing-output"] as {
      rendered_response?: unknown;
    } | undefined;
    const renderedResponse = userFacing?.rendered_response;
    if (typeof renderedResponse !== "string") {
      assert.fail("Expected an authoritative user-facing receipt");
    }
    assert.match(renderedResponse, /travel public change/iu);
  } finally {
    await client.close();
    await server.close();
  }
});
