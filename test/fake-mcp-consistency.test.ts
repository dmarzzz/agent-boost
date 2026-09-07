import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_BOOST_ADDRESS = "0x1111111111111111111111111111111111111111";
const SAVED_WALLET_ADDRESS = "0x2222222222222222222222222222222222222222";
const NEW_PRIVATE_WALLET_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

interface ScenarioExpectation {
  scenario: "named-source-regular-transfer" | "current-chat-named-source-regular-transfer";
  initialName: string;
  initialAddress: string;
  sourceInput: string;
  sourceName: string;
  sourceAddress: string;
  recipientInput: string;
  recipientName: string;
}

type DirectMcpClient = Omit<Client, "callTool"> & {
  callTool(input: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult>;
};

function resultData(result: CallToolResult): Record<string, unknown> {
  const structured = result.structuredContent as Record<string, unknown>;
  return structured.data as Record<string, unknown>;
}

function resultCode(result: CallToolResult): string {
  return String((result.structuredContent as Record<string, unknown>).code);
}

function activeInventoryWallet(data: Record<string, unknown>): Record<string, unknown> {
  const wallets = data.wallets as Array<Record<string, unknown>>;
  const active = wallets.filter((wallet) => wallet.active === true);
  assert.equal(active.length, 1);
  return active[0]!;
}

function activeTreeProfile(data: Record<string, unknown>): Record<string, unknown> {
  const profiles = data.profiles as Array<Record<string, unknown>>;
  const active = profiles.filter((profile) => profile.active === true);
  assert.equal(active.length, 1);
  return active[0]!;
}

async function connectFakeMcp(
  tracePath: string,
  scenario: string,
  evalCase: string,
): Promise<DirectMcpClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(root, "evals", "fake-mcp.ts")],
    cwd: root,
    env: {
      ...getDefaultEnvironment(),
      AGENT_BOOST_EVAL_SCENARIO: scenario,
      AGENT_BOOST_EVAL_CASE: evalCase,
      AGENT_BOOST_EVAL_TRACE: tracePath,
      AGENT_BOOST_EVAL_TURN: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "fake-projection-consistency",
    version: "1.0.0",
  }) as DirectMcpClient;
  await client.connect(transport);
  return client;
}

async function verifyProjectionConsistency(expected: ScenarioExpectation): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), "agent-boost-fake-consistency-"));
  const tracePath = join(sandbox, "trace.ndjson");
  await mkdir(sandbox, { recursive: true, mode: 0o700 });
  await writeFile(tracePath, "", { mode: 0o600 });

  const client = await connectFakeMcp(tracePath, expected.scenario, expected.scenario);

  try {
    const inventoryBefore = resultData(await client.callTool({
      name: "wallet_get_saved_profiles",
      arguments: {},
    }));
    const activeBefore = activeInventoryWallet(inventoryBefore);
    assert.equal(activeBefore.name, expected.initialName);
    assert.equal(activeBefore.selection_epoch, 1);

    const treeBefore = resultData(await client.callTool({
      name: "wallet_get_tree",
      arguments: {},
    }));
    assert.equal(activeTreeProfile(treeBefore).short_name, expected.initialName);

    const contextBefore = resultData(await client.callTool({
      name: "wallet_get_main_balance",
      arguments: {},
    }));
    assert.equal(contextBefore.address, expected.initialAddress);
    assert.equal(
      contextBefore.account_id,
      `eip155:11155111:${expected.initialAddress}`,
    );

    const sourcePreview = await client.callTool({
      name: "wallet_preview_regular_transfer",
      arguments: {
        source: expected.sourceInput,
        destination: expected.recipientInput,
        amount_native: "0.1",
      },
    });
    assert.equal(resultCode(sourcePreview), "REGULAR_TRANSFER_SOURCE_SWITCH_REQUIRED");
    const preview = resultData(sourcePreview);
    assert.equal(preview.source_wallet_name, expected.sourceName);
    assert.equal(preview.recipient_wallet_name, expected.recipientName);
    assert.equal(preview.expected_active_wallet_name, expected.initialName);
    assert.equal(preview.expected_active_selection_epoch, 1);

    const reauthorization = await client.callTool({
      name: "wallet_apply_saved_profile_load",
      arguments: {
        wallet_name: expected.sourceName,
        expected_active_wallet_name: expected.initialName,
        expected_active_selection_epoch: 1,
        user_confirmed: true,
      },
    });
    assert.equal(
      resultCode(reauthorization),
      "WALLET_REAUTHORIZATION_PLANNED",
      JSON.stringify(reauthorization.structuredContent),
    );

    const inventoryAfter = resultData(await client.callTool({
      name: "wallet_get_saved_profiles",
      arguments: {},
    }));
    const activeAfter = activeInventoryWallet(inventoryAfter);
    assert.equal(activeAfter.name, expected.sourceName);
    assert.equal(activeAfter.selection_epoch, 2);

    const treeAfter = resultData(await client.callTool({
      name: "wallet_get_tree",
      arguments: {},
    }));
    assert.equal(activeTreeProfile(treeAfter).short_name, expected.sourceName);

    const contextAfter = resultData(await client.callTool({
      name: "wallet_get_main_balance",
      arguments: {},
    }));
    assert.equal(contextAfter.address, expected.sourceAddress);
    assert.equal(contextAfter.balance_atomic, "200000000000000000");
    assert.equal(contextAfter.account_id, `eip155:11155111:${expected.sourceAddress}`);

    const reauthorizationPlan = resultData(reauthorization).plan as Record<string, unknown>;
    assert.equal(typeof reauthorizationPlan.decisionId, "string");
    assert.equal(resultCode(await client.callTool({
      name: "wallet_apply_reauthorization",
      arguments: {
        decision_id: reauthorizationPlan.decisionId,
        user_confirmed: true,
      },
    })), "WALLET_REAUTHORIZED");

    const finalPlan = await client.callTool({
      name: "wallet_preview_regular_transfer",
      arguments: {
        source: expected.sourceName,
        destination: expected.recipientName,
        amount_native: "0.1",
      },
    });
    assert.equal(resultCode(finalPlan), "REGULAR_TRANSFER_PLANNED");
    const finalPlanValue = resultData(finalPlan).plan as Record<string, unknown>;
    const authorization = finalPlanValue.authorization as Record<string, unknown>;
    assert.equal(authorization.walletName, expected.sourceName);
    assert.equal(authorization.selectionEpoch, 2);
    assert.equal(finalPlanValue.mainBalanceSnapshotWei, "200000000000000000");
  } finally {
    await client.close();
    await rm(sandbox, { recursive: true, force: true });
  }
}

test("named-source fake MCP reads share one active-wallet projection", async (t) => {
  const scenarios: ScenarioExpectation[] = [
    {
      scenario: "named-source-regular-transfer",
      initialName: "agent-boost",
      initialAddress: AGENT_BOOST_ADDRESS,
      sourceInput: "saved-wallet",
      sourceName: "saved-wallet",
      sourceAddress: SAVED_WALLET_ADDRESS,
      recipientInput: "agent-boost",
      recipientName: "agent-boost",
    },
    {
      scenario: "current-chat-named-source-regular-transfer",
      initialName: "new_private_wallet",
      initialAddress: NEW_PRIVATE_WALLET_ADDRESS,
      sourceInput: "the agent boost wallet",
      sourceName: "agent-boost",
      sourceAddress: AGENT_BOOST_ADDRESS,
      recipientInput: "my new private wallet",
      recipientName: "new_private_wallet",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.scenario, () => verifyProjectionConsistency(scenario));
  }
});

async function verifyWalletLifecyclePostcondition(
  action: "create" | "adopt",
): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), `agent-boost-fake-${action}-`));
  const tracePath = join(sandbox, "trace.ndjson");
  await writeFile(tracePath, "", { mode: 0o600 });
  const evalCase = action === "create" ? "create-named-wallet" : "adopt-local-wallet";
  let client = await connectFakeMcp(tracePath, "wallet-lifecycle", evalCase);

  try {
    const tool = action === "create" ? "wallet_create" : "wallet_adopt_existing";
    const name = action === "create" ? "travel-wallet" : "imported-wallet";
    const previewCode = action === "create"
      ? "WALLET_CREATE_CONFIRMATION_REQUIRED"
      : "WALLET_ADOPT_CONFIRMATION_REQUIRED";
    const appliedCode = action === "create" ? "WALLET_CREATED" : "WALLET_ADOPTED";

    const preview = await client.callTool({
      name: tool,
      arguments: { name },
    });
    assert.equal(resultCode(preview), previewCode);
    const previewData = resultData(preview);
    assert.equal(previewData.expected_active_wallet_name, "agent-boost");
    assert.equal(previewData.expected_active_selection_epoch, 1);
    assert.equal(resultCode(await client.callTool({
      name: tool,
      arguments: {
        name,
        expected_active_wallet_name: previewData.expected_active_wallet_name,
        expected_active_selection_epoch: previewData.expected_active_selection_epoch,
        user_confirmed: true,
      },
    })), appliedCode);

    // The live harness starts a new MCP process on the next chat turn. Verify
    // the postcondition from disk rather than from module-local state.
    await client.close();
    client = await connectFakeMcp(tracePath, "wallet-lifecycle", evalCase);

    const inventory = resultData(await client.callTool({
      name: "wallet_get_saved_profiles",
      arguments: {},
    }));
    const active = activeInventoryWallet(inventory);
    assert.equal(active.name, name);
    assert.equal(active.selection_epoch, 2);
    assert.equal(active.authorization_status, "missing");

    const wallets = inventory.wallets as Array<Record<string, unknown>>;
    assert.ok(wallets.some((wallet) => wallet.name === name));
    const local = inventory.unregistered_local_wallets as Array<Record<string, unknown>>;
    const counts = inventory.counts as Record<string, unknown>;
    if (action === "adopt") {
      assert.equal(active.origin, "adopted");
      assert.ok(!local.some((wallet) => wallet.name === "imported-wallet"));
      assert.equal(counts.unregistered_local, 0);
      assert.equal(counts.adoptable_local, 0);
    } else {
      assert.ok(local.some((wallet) => wallet.name === "imported-wallet"));
      assert.equal(counts.unregistered_local, 1);
      assert.equal(counts.adoptable_local, 1);
    }
  } finally {
    await client.close();
    await rm(sandbox, { recursive: true, force: true });
  }
}

test("created and adopted wallets persist into registered inventory", async (t) => {
  await t.test("create then read after restart", () =>
    verifyWalletLifecyclePostcondition("create"));
  await t.test("adopt then read after restart", () =>
    verifyWalletLifecyclePostcondition("adopt"));
});

test("applied policy is returned by a later read after restart", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "agent-boost-fake-policy-"));
  const tracePath = join(sandbox, "trace.ndjson");
  await writeFile(tracePath, "", { mode: 0o600 });
  let client = await connectFakeMcp(
    tracePath,
    "policy-update",
    "policy-update-with-confirmation",
  );

  try {
    const before = resultData(await client.callTool({
      name: "wallet_get_policy",
      arguments: {},
    })).policy as Record<string, unknown>;
    assert.equal(before.maxPayments, 1);
    assert.equal(before.perPaymentLimitWei, "50000000000000000");

    assert.equal(resultCode(await client.callTool({
      name: "wallet_plan_policy_update",
      arguments: {
        max_payments: 10,
        per_payment_limit_native: "1",
      },
    })), "POLICY_UPDATE_PLANNED");

    const afterPlan = resultData(await client.callTool({
      name: "wallet_get_policy",
      arguments: {},
    })).policy as Record<string, unknown>;
    assert.deepEqual(afterPlan, before, "planning must not change the active policy");

    assert.equal(resultCode(await client.callTool({
      name: "wallet_apply_policy_update",
      arguments: {
        decision_id: "wpd_eval_12345678",
        user_confirmed: true,
      },
    })), "POLICY_UPDATED");

    await client.close();
    client = await connectFakeMcp(
      tracePath,
      "policy-update",
      "policy-update-with-confirmation",
    );
    const afterApply = resultData(await client.callTool({
      name: "wallet_get_policy",
      arguments: {},
    })).policy as Record<string, unknown>;
    assert.equal(afterApply.maxPayments, 10);
    assert.equal(afterApply.paymentsRemaining, 10);
    assert.equal(afterApply.perPaymentLimitWei, "1000000000000000000");
    assert.equal(afterApply.lifetimeLimitWei, "10000000000000000000");
  } finally {
    await client.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
