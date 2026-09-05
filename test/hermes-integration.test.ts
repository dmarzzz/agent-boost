import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, realpath, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import {
  HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK,
  HERMES_MCP_DISCOVERY_TIMEOUT_SECONDS,
  HERMES_NATIVE_TOOLS,
  HERMES_SKILL_NAMES,
  HERMES_TURN_GATE_POST_MATCHER,
  HERMES_TURN_GATE_PRE_MATCHER,
  HermesInstallError,
  createHermesServerConfig,
  createHermesTurnGateHooks,
  installHermesIntegration,
  type CommandResult,
} from "../src/hermes/index.js";

interface Fixture {
  root: string;
  configPath: string;
  executablePath: string;
}

const HISTORICAL_29_TOOL_ALLOWLIST = [
  "capabilities",
  "onboarding_start",
  "onboarding_status",
  "wallet_get_main_balance",
  "wallet_list_saved_profiles",
  "wallet_get_tree",
  "wallet_create",
  "wallet_adopt_existing",
  "wallet_preview_saved_profile_load",
  "wallet_apply_saved_profile_load",
  "wallet_archive",
  "wallet_plan_reauthorization",
  "wallet_apply_reauthorization",
  "wallet_get_policy",
  "wallet_plan_policy_update",
  "wallet_apply_policy_update",
  "wallet_start_new_demo",
  "wallet_preview_regular_transfer",
  "wallet_execute_regular_transfer",
  "wallet_get_regular_transfer_request",
  "wallet_preview_private_transfer",
  "wallet_execute_private_transfer",
  "wallet_get_private_transfer_request",
  "wallet_preview_recovery_transfer",
  "wallet_execute_recovery_transfer",
  "wallet_get_recovery_request",
  "egress_capabilities",
  "egress_status",
  "egress_fetch",
] as const;

const NAMED_PRIVATE_BALANCE_TOOLS = [
  "wallet_preview_private_balance_create",
  "wallet_apply_private_balance_create",
  "wallet_preview_private_balance_fund",
  "wallet_apply_private_balance_fund",
  "wallet_get_private_balance_operation",
  "wallet_get_private_balance_policy",
  "wallet_preview_private_balance_policy_update",
  "wallet_apply_private_balance_policy_update",
] as const;

function skillFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u);
  assert.ok(match?.[1], "skill must begin with YAML frontmatter");
  return parse(match[1]) as Record<string, unknown>;
}

async function createFixture(config = "model:\n  default: test\n"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-hermes-"));
  const configPath = join(root, "profile", "config.yaml");
  const executablePath = join(root, "bin", "agent-boost");
  await mkdir(join(root, "profile"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(configPath, config, { mode: 0o600 });
  await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(executablePath, 0o755);
  return { root, configPath, executablePath };
}

function successfulRunner(configPath: string, calls: string[][]) {
  return async (command: string, args: readonly string[]): Promise<CommandResult> => {
    calls.push([command, ...args]);
    if (args.join(" ") === "config path") {
      return { exitCode: 0, stdout: `${configPath}\n`, stderr: "" };
    }
    const hookResult = await successfulHookResult(configPath, args);
    if (hookResult !== undefined) return hookResult;
    if (args[0] === "plugins" && args[1] === "doctor" && args[3] === "--ci") {
      return { exitCode: 0, stdout: "plugin valid\n", stderr: "" };
    }
    if (args.join(" ") === "mcp test agent-boost") {
      return { exitCode: 0, stdout: "connected\n", stderr: "" };
    }
    return { exitCode: 99, stdout: "", stderr: "unexpected command" };
  };
}

async function successfulHookResult(
  configPath: string,
  args: readonly string[],
): Promise<CommandResult | undefined> {
  if (
    args.length !== 5 ||
    args[0] !== "hooks" ||
    args[1] !== "test" ||
    (args[2] !== "pre_tool_call" && args[2] !== "post_tool_call") ||
    args[3] !== "--for-tool" ||
    args[4] !== "mcp__agent_boost__capabilities"
  ) {
    return undefined;
  }
  const config = parse(await readFile(configPath, "utf8")) as {
    hooks: Record<"pre_tool_call" | "post_tool_call", Array<{ command: string }>>;
  };
  const event = args[2];
  const command = config.hooks[event]
    .find((entry) => entry.command.endsWith(" hermes-turn-gate"))?.command;
  assert.ok(command);
  return {
    exitCode: 0,
    stdout: [
      `Firing 1 hook(s) for event '${event}':`,
      "",
      `  → ${command}`,
      "      exit=0  elapsed=0.01s",
      '      stdout: {"continue":true}',
      event === "pre_tool_call"
        ? '      parsed (Hermes wire shape): {"continue": true}'
        : "      parsed: <none — hook contributed nothing to the dispatcher>",
      "",
    ].join("\n"),
    stderr: "",
  };
}

test("installs a conflict-safe Hermes integration and modular skill bundle", async () => {
  const fixture = await createFixture("# keep this backup exact\nmodel:\n  default: test\n");
  const calls: string[][] = [];
  const result = await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, calls),
    now: () => new Date("2026-09-01T12:34:56.000Z"),
  });

  assert.deepEqual(calls, [
    ["hermes", "config", "path"],
    ["hermes", "hooks", "test", "pre_tool_call", "--for-tool", "mcp__agent_boost__capabilities"],
    ["hermes", "hooks", "test", "post_tool_call", "--for-tool", "mcp__agent_boost__capabilities"],
    ["hermes", "mcp", "test", "agent-boost"],
    ["hermes", "plugins", "doctor", result.outputGuardPluginPath, "--ci"],
  ]);
  assert.equal(result.configChanged, true);
  assert.equal(result.restartRequired, true);
  assert.match(result.recommendation, /did not restart Hermes/u);
  assert.match(result.recommendation, /turn-gate hooks are registered/u);
  assert.match(result.recommendation, /Reloading skills or MCP alone does not register/u);
  assert.match(result.recommendation, /\/new.*!new/u);
  assert.ok(result.configBackupPath);
  assert.equal(
    await readFile(result.configBackupPath, "utf8"),
    "# keep this backup exact\nmodel:\n  default: test\n",
  );

  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    agent: {
      tool_use_enforcement: boolean;
      execution_guidance: boolean;
      task_completion_guidance: boolean;
      parallel_tool_call_guidance: boolean;
      system_prompt: string;
    };
    tools: { tool_search: { enabled: string } };
    display: { busy_input_mode: string };
    plugins: {
      enabled: string[];
      entries: Record<string, { settings: { turn_gate_executable: string } }>;
    };
    mcp_discovery_timeout: number;
    mcp_single_query_discovery_timeout: number;
    hooks_auto_accept?: boolean;
    hooks: Record<string, unknown>;
    mcp_servers: Record<string, unknown>;
  };
  assert.deepEqual(config.agent, {
    tool_use_enforcement: true,
    execution_guidance: false,
    task_completion_guidance: false,
    parallel_tool_call_guidance: false,
    system_prompt: HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK,
  });
  assert.equal(config.tools.tool_search.enabled, "off");
  assert.equal(config.display.busy_input_mode, "queue");
  assert.deepEqual(config.plugins.enabled, ["agent-boost-output-guard"]);
  assert.equal(
    config.plugins.entries["agent-boost-output-guard"]?.settings.turn_gate_executable,
    result.executablePath,
  );
  assert.equal(
    config.mcp_discovery_timeout,
    HERMES_MCP_DISCOVERY_TIMEOUT_SECONDS,
  );
  assert.equal(
    config.mcp_single_query_discovery_timeout,
    HERMES_MCP_DISCOVERY_TIMEOUT_SECONDS,
  );
  assert.equal(config.hooks_auto_accept, undefined);
  assert.deepEqual(config.hooks, createHermesTurnGateHooks(result.executablePath));
  assert.deepEqual(
    config.mcp_servers["agent-boost"],
    createHermesServerConfig(result.executablePath),
  );
  assert.equal(
    (config.mcp_servers["agent-boost"] as { timeout: number }).timeout,
    360,
  );
  assert.equal(
    result.turnGateCommand,
    `${result.executablePath} hermes-turn-gate`,
  );
  assert.equal(
    result.hookAllowlistPath,
    join(fixture.root, "profile", "shell-hooks-allowlist.json"),
  );
  assert.equal(result.hookAllowlistChanged, true);
  assert.equal(result.hookAllowlistBackupPath, undefined);
  assert.equal(result.hookTests.preToolCall.exitCode, 0);
  assert.equal(result.hookTests.postToolCall.exitCode, 0);
  assert.equal(result.outputGuardPluginChanged, true);
  assert.equal(result.outputGuardPluginBackupPaths.length, 0);
  assert.equal(result.outputGuardPluginTest.exitCode, 0);
  assert.equal(
    await readFile(join(result.outputGuardPluginPath, "plugin.yaml"), "utf8"),
    await readFile(join(process.cwd(), "integrations/hermes/agent-boost-output-guard/plugin.yaml"), "utf8"),
  );
  assert.match(
    await readFile(join(result.outputGuardPluginPath, "__init__.py"), "utf8"),
    /transform_llm_output/u,
  );
  assert.deepEqual(
    JSON.parse(await readFile(result.hookAllowlistPath, "utf8")),
    {
      approvals: [
        { event: "pre_tool_call", command: result.turnGateCommand },
        { event: "post_tool_call", command: result.turnGateCommand },
      ],
    },
  );
  assert.equal((await stat(result.hookAllowlistPath)).mode & 0o777, 0o600);

  assert.deepEqual(
    result.skills.map((skill) => skill.name),
    [...HERMES_SKILL_NAMES],
  );
  const skillEntries = await Promise.all(
    HERMES_SKILL_NAMES.map(async (name) => [
      name,
      await readFile(
        join(fixture.root, "profile", "skills", name, "SKILL.md"),
        "utf8",
      ),
    ] as const),
  );
  const skills = Object.fromEntries(skillEntries) as Record<
    (typeof HERMES_SKILL_NAMES)[number],
    string
  >;
  for (const [name, content] of skillEntries) {
    const metadata = skillFrontmatter(content);
    const description = String(metadata.description);
    assert.ok(description.length <= 60, `${name} description exceeds 60 characters`);
    assert.match(description, /\.$/u, `${name} description must end with a period`);
    assert.doesNotMatch(content, /mcp_agent_boost_|mcp__agent_boost__/u);
  }

  const setupSkill = skills["agent-boost-setup"];
  const routerSkill = skills["agent-boost"];
  const treeSkill = skills["agent-boost-wallet-tree"];
  const walletsSkill = skills["agent-boost-wallets"];
  const policySkill = skills["agent-boost-policy"];
  const transfersSkill = skills["agent-boost-transfers"];
  const walletActionsSkill = skills["agent-boost-wallet-actions"];
  const authorizationSkill = skills["agent-boost-authorize"];
  const confirmationSkill = skills["agent-boost-confirm"];
  const coveredWebSkill = skills["agent-boost-covered-web"];

  assert.doesNotMatch(setupSkill, /requires_toolsets/u);
  assert.doesNotMatch(routerSkill, /requires_toolsets/u);
  for (const content of [
    treeSkill,
    walletsSkill,
    policySkill,
    transfersSkill,
    walletActionsSkill,
    authorizationSkill,
    confirmationSkill,
    coveredWebSkill,
  ]) {
    assert.doesNotMatch(content, /requires_toolsets/u);
  }

  assert.ok(Buffer.byteLength(routerSkill) < 4_000);
  assert.ok(Buffer.byteLength(treeSkill) < 2_500);
  assert.ok(Buffer.byteLength(walletsSkill) < 9_000);
  assert.ok(Buffer.byteLength(policySkill) < 7_000);
  assert.ok(Buffer.byteLength(transfersSkill) < 9_000);
  assert.ok(Buffer.byteLength(confirmationSkill) < 9_000);

  assert.match(routerSkill, /load `agent-boost-wallet-tree`/iu);
  assert.match(routerSkill, /Load agent-boost[\s\S]*saved-wallet request/iu);
  assert.match(routerSkill, /confirmation-only message[\s\S]*immediately\s+preceding preview/iu);
  assert.match(routerSkill, /\/reload-skills[\s\S]*\/reload-mcp/su);

  assert.match(setupSkill, /onboarding_start/u);
  assert.match(setupSkill, /immediately[\s\S]*tool-returned QR/u);
  assert.match(setupSkill, /gateway owns MCP image delivery/u);
  assert.match(setupSkill, /never[\s\S]*manually send a `MEDIA:` tag/u);
  assert.match(setupSkill, /`remaining_amount_eth`/u);
  assert.match(setupSkill, /remaining_amount_wei/u);
  assert.match(setupSkill, /`funding_uri`/u);
  assert.match(setupSkill, /`action: send` and `target: matrix`/u);
  assert.match(setupSkill, /final visible response exactly the server-provided funding[\s\S]*address/u);
  assert.match(setupSkill, /No label, prefix, suffix,[\s\S]*backticks, or[\s\S]*code fence/u);
  assert.match(setupSkill, /sent[\s\S]*done[\s\S]*funded[\s\S]*✅[\s\S]*👍/u);
  assert.match(setupSkill, /Never require a magic[\s\S]*command syntax/u);
  assert.match(setupSkill, /`setupId` and `revision`/u);
  assert.match(setupSkill, /`wait_ms: 30000`/u);
  assert.match(setupSkill, /at most one[\s\S]*`onboarding_status`[\s\S]*`wait_ms: 90000`/u);
  assert.match(setupSkill, /do not hold the conversation in an unbounded loop/u);
  assert.match(setupSkill, /Do not resend the QR unless they ask/u);
  assert.match(
    setupSkill,
    /`private_ready` goes directly to completion verification and[\s\S]*not by itself permission to answer/u,
  );
  assert.match(setupSkill, /Never show a zero-amount[\s\S]*old QR/u);
  assert.doesNotMatch(setupSkill, /send_message` a third|exact tag as the/u);
  assert.doesNotMatch(setupSkill, /offer (?:the )?loopback|normally 0\.2/u);
  assert.match(setupSkill, /\/reload-skills.*\/reload-mcp/su);
  assert.match(setupSkill, /D A R K  M O D E/u);
  assert.match(setupSkill, /tiny permission slip/u);
  assert.match(setupSkill, /3\/3 · Dark Mode online/u);
  assert.match(setupSkill, /agent-boost-phi\.vercel\.app\/#v=1/u);
  assert.match(setupSkill, /never put[\s\S]*address[\s\S]*balance[\s\S]*setup ID/u);
  assert.match(setupSkill, /remote Hermes cannot open a[\s\S]*participant’s device/u);
  assert.match(setupSkill, /View your agent’s loadout/u);
  assert.match(setupSkill, /`wallet_get_tree`/u);
  assert.match(setupSkill, /exact\s+tool-returned `data\.rendered` tree/u);
  assert.match(
    setupSkill,
    /fresh result is the sole[\s\S]*authoritative source[\s\S]*`readiness\.rpc_egress: ready`/u,
  );
  assert.match(
    setupSkill,
    /Never call[\s\S]*`egress_capabilities` or `egress_status` while completing setup/u,
  );
  assert.match(
    setupSkill,
    /`wallet_get_tree` exactly once[\s\S]*final tool call[\s\S]*call no other tool/u,
  );
  assert.match(
    setupSkill,
    /completion response is invalid unless it contains[\s\S]*`data\.rendered` value copied byte-for-byte/u,
  );
  assert.match(
    setupSkill,
    /Do\s+not replace it with a wallet count,[\s\S]*raw address or balance summary/u,
  );

  assert.deepEqual(
    [...treeSkill.matchAll(/`(wallet_[a-z_]+)`/gu)].map((match) => match[1]),
    ["wallet_get_tree"],
  );
  assert.match(treeSkill, /Invoke `wallet_get_tree` exactly once/u);
  assert.match(treeSkill, /first successful result is the final[\s\S]*byte-for-byte/iu);
  assert.match(treeSkill, /do not search, describe, invoke, or retry any\s+tool/iu);

  assert.match(walletsSkill, /`wallet_list_saved_profiles`/u);
  assert.match(walletsSkill, /`wallet_preview_saved_profile_load`/u);
  assert.match(walletsSkill, /`wallet_get_main_balance`/u);
  assert.match(walletsSkill, /active[\s\S]*do not[\s\S]*ask for confirmation/iu);
  assert.match(walletsSkill, /two or more[\s\S]*friendly names[\s\S]*Never choose/iu);
  assert.match(walletsSkill, /transfer that merely names a[\s\S]*source wallet is not a load request/iu);
  assert.match(
    walletsSkill,
    /`wallet_preview_saved_profile_load`[\s\S]*user's friendly[\s\S]*`wallet_name`[\s\S]*exact canonical/iu,
  );
  assert.match(
    walletsSkill,
    /Valid stored bounded authorization is preserved[\s\S]*missing, expired, disabled, or exhausted/iu,
  );
  assert.doesNotMatch(walletsSkill, /switch[\s\S]{0,120}disables delegated signing/iu);
  assert.doesNotMatch(walletsSkill, /wallet_select/u);

  assert.match(policySkill, /Hard turn boundary:[\s\S]*separate user turns/iu);
  assert.match(policySkill, /call only `wallet_plan_policy_update`/u);
  assert.match(policySkill, /`max_payments`[\s\S]*`per_payment_limit_native`/u);
  assert.doesNotMatch(policySkill, /wallet_apply_policy_update/u);

  assert.match(transfersSkill, /`wallet_preview_regular_transfer`/u);
  assert.match(transfersSkill, /`wallet_preview_private_transfer`/u);
  assert.match(transfersSkill, /`wallet_preview_recovery_transfer`/u);
  assert.doesNotMatch(transfersSkill, /wallet_execute_|wallet_get_(?:regular_transfer|private_payment|recovery)_request/u);
  assert.match(transfersSkill, /next user reply[\s\S]*`agent-boost-confirm`/iu);
  assert.match(transfersSkill, /every transfer mode[\s\S]*required `destination` field/iu);
  assert.match(transfersSkill, /Never ask the user for a saved[\s\S]*wallet's address/iu);
  assert.match(transfersSkill, /Can we transfer 0\.1 eth to my new[\s\S]*private wallet from[\s\S]*the agent boost wallet/iu);
  assert.match(transfersSkill, /friendly profile name[\s\S]*does\s+not change an explicitly stated route/iu);
  assert.match(transfersSkill, /explicitly[\s\S]*required `source` field/iu);
  assert.match(transfersSkill, /reserved literal `\$selected`/u);
  for (const code of [
    "REGULAR_TRANSFER_SOURCE_SWITCH_REQUIRED",
    "PRIVATE_PAYMENT_SOURCE_SWITCH_REQUIRED",
    "RECOVERY_TRANSFER_SOURCE_SWITCH_REQUIRED",
  ]) {
    assert.match(transfersSkill, new RegExp(code, "u"));
  }
  assert.match(transfersSkill, /typed result is the complete\s+source-switch preview/iu);
  assert.match(
    transfersSkill,
    /Valid authorization remains[\s\S]*Missing, expired, disabled, or exhausted/iu,
  );
  assert.match(transfersSkill, /Do not call a saved-wallet inventory, switch,[\s\S]*again in this assistant turn/iu);
  assert.match(transfersSkill, /Switch, authorization, and\s+send remain three distinct confirmations/iu);
  assert.match(transfersSkill, /`USE_RECOVERY_TRANSFER`[\s\S]*exact recovery preview/iu);
  assert.match(
    transfersSkill,
    /For a `confirm` decision[\s\S]*no execution[\s\S]*For `allow` with[\s\S]*`userConfirmationRequired: false`[\s\S]*same\s+assistant turn/iu,
  );

  assert.match(walletActionsSkill, /`wallet_apply_saved_profile_load`/u);
  assert.doesNotMatch(walletActionsSkill, /`wallet_select`/u);
  assert.match(walletActionsSkill, /`wallet_plan_reauthorization`/u);
  assert.doesNotMatch(walletActionsSkill, /wallet_apply_reauthorization|wallet_reauthorize/u);
  assert.match(walletActionsSkill, /preserved mode,[\s\S]*`amount_native`[\s\S]*`source_wallet_name`/iu);
  assert.match(walletActionsSkill, /`recipient` or `recipient_wallet_name`/u);
  assert.match(walletActionsSkill, /source-switch preview[\s\S]*do not repeat an inventory\s+read/iu);
  assert.match(
    walletActionsSkill,
    /`expected_active_wallet_name`[\s\S]*`expected_active_selection_epoch`/u,
  );
  assert.match(walletActionsSkill, /preview\s+is stale[\s\S]*never retry that approval/iu);
  assert.match(walletActionsSkill, /If a transfer is waiting:[\s\S]*Pending next/iu);

  assert.match(authorizationSkill, /`wallet_apply_reauthorization`/u);
  assert.doesNotMatch(authorizationSkill, /`wallet_reauthorize`/u);
  assert.match(authorizationSkill, /Authorization approval never\s+doubles as transfer approval/u);
  assert.match(authorizationSkill, /create the matching[\s\S]*transfer preview automatically/iu);
  assert.match(authorizationSkill, /`source_wallet_name`[\s\S]*`recipient_wallet_name`/u);

  assert.match(confirmationSkill, /`wallet_apply_policy_update`/u);
  assert.match(confirmationSkill, /`wallet_execute_regular_transfer`/u);
  assert.match(confirmationSkill, /`wallet_execute_private_transfer`/u);
  assert.match(confirmationSkill, /`wallet_execute_recovery_transfer`/u);
  assert.match(confirmationSkill, /`user_confirmed: false`/u);
  assert.match(
    confirmationSkill,
    /exactly one of two situations:[\s\S]*new user reply[\s\S]*approval[\s\S]*`allow`[\s\S]*user-confirmation requirement is false/iu,
  );
  assert.match(
    confirmationSkill,
    /immediate same-turn continuation authorized by the local[\s\S]*applies only to transfer\s+plans/iu,
  );
  assert.match(confirmationSkill, /saved-wallet friendly destination[\s\S]*Do not replace it with the\s+internally resolved address/iu);
  assert.match(confirmationSkill, /bound plan's\s+address remains execution authority/iu);

  assert.match(coveredWebSkill, /`egress_status`[\s\S]*`egress_fetch`/u);
  assert.match(coveredWebSkill, /`untrusted_external`/u);

  for (const content of skillEntries.map(([, value]) => value)) {
    assert.doesNotMatch(
      content,
      /\b(?:native|external|another|system)\b[^\n]{0,40}\b(?:approval|confirmation|interface|prompt|surface|ui)\b|\b(?:button|popup|notification)\b/iu,
    );
  }
});

test("binds MCP and hook approvals to the resolved executable behind a symlink", async () => {
  const fixture = await createFixture();
  const requestedPath = join(fixture.root, "bin", "agent-boost-current");
  await symlink(fixture.executablePath, requestedPath);
  const resolvedPath = await realpath(fixture.executablePath);

  const result = await installHermesIntegration({
    executablePath: requestedPath,
    runCommand: successfulRunner(fixture.configPath, []),
  });
  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    hooks: Record<string, unknown>;
    mcp_servers: Record<string, unknown>;
    plugins: {
      entries: Record<string, { settings: { turn_gate_executable: string } }>;
    };
  };
  assert.equal(result.executablePath, resolvedPath);
  assert.equal(result.turnGateCommand, `${resolvedPath} hermes-turn-gate`);
  assert.deepEqual(config.hooks, createHermesTurnGateHooks(resolvedPath));
  assert.deepEqual(
    config.mcp_servers["agent-boost"],
    createHermesServerConfig(resolvedPath),
  );
  assert.equal(
    config.plugins.entries["agent-boost-output-guard"]?.settings.turn_gate_executable,
    resolvedPath,
  );
  assert.doesNotMatch(
    await readFile(result.hookAllowlistPath, "utf8"),
    /agent-boost-current/u,
  );
});

test("quotes a resolved executable path with spaces and apostrophes exactly once", async () => {
  const fixture = await createFixture();
  const specialDirectory = join(fixture.root, "bin with space");
  const specialPath = join(specialDirectory, "agent'boost");
  await mkdir(specialDirectory, { recursive: true });
  await writeFile(specialPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(specialPath, 0o755);
  const resolvedPath = await realpath(specialPath);
  const expectedCommand = `'${resolvedPath.replaceAll("'", `'"'"'`)}' hermes-turn-gate`;

  const result = await installHermesIntegration({
    executablePath: specialPath,
    runCommand: successfulRunner(fixture.configPath, []),
  });
  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    hooks: Record<string, unknown>;
    plugins: {
      entries: Record<string, { settings: { turn_gate_executable: string } }>;
    };
  };
  assert.equal(result.turnGateCommand, expectedCommand);
  assert.deepEqual(config.hooks, createHermesTurnGateHooks(resolvedPath));
  assert.equal(
    config.plugins.entries["agent-boost-output-guard"]?.settings.turn_gate_executable,
    resolvedPath,
  );
  assert.deepEqual(
    JSON.parse(await readFile(result.hookAllowlistPath, "utf8")),
    {
      approvals: [
        { event: "pre_tool_call", command: expectedCommand },
        { event: "post_tool_call", command: expectedCommand },
      ],
    },
  );
});

test("preserves an advanced user's explicit tool-use and tool-search settings", async () => {
  const fixture = await createFixture(
    [
      "agent:",
      "  tool_use_enforcement: false",
      "  execution_guidance: true",
      "  task_completion_guidance: false",
      "  parallel_tool_call_guidance: true",
      "hooks_auto_accept: false",
      "hooks:",
      "  pre_tool_call:",
      "    - matcher: terminal",
      "      command: /operator/pre-hook",
      "      timeout: 7",
      "  post_tool_call:",
      "    - matcher: terminal",
      "      command: /operator/post-hook",
      "tools:",
      "  tool_search:",
      "    enabled: auto",
      "    threshold_pct: 7",
      "  operator_extension:",
      "    enabled: true",
      "display:",
      "  busy_input_mode: interrupt",
      "plugins:",
      "  enabled: [operator-plugin]",
      "  entries:",
      "    operator-plugin:",
      "      settings: {mode: strict}",
      "    agent-boost-output-guard:",
      "      settings: {operator_setting: keep}",
      "mcp_discovery_timeout: 23",
      "mcp_single_query_discovery_timeout: 29",
      "model:",
      "  default: test",
      "",
    ].join("\n"),
  );
  const calls: string[][] = [];

  await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, calls),
  });

  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    agent: {
      tool_use_enforcement: boolean;
      execution_guidance: boolean;
      task_completion_guidance: boolean;
      parallel_tool_call_guidance: boolean;
      system_prompt: string;
    };
    hooks_auto_accept: boolean;
    hooks: {
      pre_tool_call: Array<Record<string, unknown>>;
      post_tool_call: Array<Record<string, unknown>>;
    };
    tools: {
      tool_search: { enabled: string; threshold_pct: number };
      operator_extension: { enabled: boolean };
    };
    display: { busy_input_mode: string };
    plugins: {
      enabled: string[];
      entries: Record<string, { settings: Record<string, unknown> }>;
    };
    mcp_discovery_timeout: number;
    mcp_single_query_discovery_timeout: number;
  };
  assert.deepEqual(config.agent, {
    tool_use_enforcement: false,
    execution_guidance: true,
    task_completion_guidance: false,
    parallel_tool_call_guidance: true,
    system_prompt: HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK,
  });
  assert.equal(config.hooks_auto_accept, false);
  assert.deepEqual(config.hooks.pre_tool_call[0], {
    matcher: "terminal",
    command: "/operator/pre-hook",
    timeout: 7,
  });
  assert.deepEqual(config.hooks.post_tool_call[0], {
    matcher: "terminal",
    command: "/operator/post-hook",
  });
  assert.deepEqual(
    {
      pre_tool_call: config.hooks.pre_tool_call.slice(1),
      post_tool_call: config.hooks.post_tool_call.slice(1),
    },
    createHermesTurnGateHooks(await realpath(fixture.executablePath)),
  );
  assert.equal(config.tools.tool_search.enabled, "auto");
  assert.equal(config.tools.tool_search.threshold_pct, 7);
  assert.equal(config.tools.operator_extension.enabled, true);
  assert.equal(config.display.busy_input_mode, "interrupt");
  assert.deepEqual(config.plugins.enabled, ["operator-plugin", "agent-boost-output-guard"]);
  assert.equal(
    config.plugins.entries["agent-boost-output-guard"]?.settings.turn_gate_executable,
    await realpath(fixture.executablePath),
  );
  assert.equal(
    config.plugins.entries["agent-boost-output-guard"]?.settings.operator_setting,
    "keep",
  );
  assert.deepEqual(config.plugins.entries["operator-plugin"], {
    settings: { mode: "strict" },
  });
  assert.equal(config.mcp_discovery_timeout, 23);
  assert.equal(config.mcp_single_query_discovery_timeout, 29);
});

test("appends the managed routing block without changing existing operator prompt bytes", async () => {
  const operatorPrompt =
    "Keep responses brief and to the point. A few sentences at most unless explicitly asked for detail.";
  const fixture = await createFixture(
    `agent:\n  system_prompt: ${JSON.stringify(operatorPrompt)}\nmodel:\n  default: test\n`,
  );

  await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, []),
  });

  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    agent: { system_prompt: string };
  };
  assert.equal(
    config.agent.system_prompt,
    `${operatorPrompt}\n\n${HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK}`,
  );
  assert.equal(
    config.agent.system_prompt.slice(0, operatorPrompt.length),
    operatorPrompt,
  );
  assert.match(config.agent.system_prompt, /wallet_preview_regular_transfer/u);
  assert.match(config.agent.system_prompt, /source is named or inactive/iu);
  assert.match(config.agent.system_prompt, /never infer wallet creation/iu);
  assert.match(config.agent.system_prompt, /private balance is a named child pocket/iu);
  assert.match(
    config.agent.system_prompt,
    /wallet_name is the parent; source=\$main means that parent's public account/iu,
  );
  assert.match(config.agent.system_prompt, /asks for approval ends this assistant turn/iu);
  assert.match(config.agent.system_prompt, /later actual user turn/iu);
  assert.match(
    config.agent.system_prompt,
    /all approval happens through that chat reply, never an app, popup, or other confirmation surface/iu,
  );
  assert.match(config.agent.system_prompt, /never manufacture, quote, simulate, or impersonate/iu);
  assert.match(config.agent.system_prompt, /raw tool\/function-call syntax/iu);
  assert.match(config.agent.system_prompt, /internal tool, decision, or request IDs/iu);
  assert.match(
    config.agent.system_prompt,
    /canonical transfer execution[\s\S]*no-rebroadcast verification read[\s\S]*later user status request/iu,
  );
  assert.match(
    config.agent.system_prompt,
    /latest trusted Agent Boost result requested a status follow-up[\s\S]*check again starts a new read-only turn[\s\S]*repeating a read across user turns is allowed and required/iu,
  );
  assert.match(
    config.agent.system_prompt,
    /never permits repeating an execute, apply, create, fund, shield, or broadcast action/iu,
  );
});

test("updates only a terminal managed routing block and preserves its operator prefix", async () => {
  const operatorPrefix = "Operator text with  double spaces and a trailing tab\t\n\n";
  const staleBlock = [
    "[BEGIN AGENT BOOST MANAGED ROUTING]",
    "obsolete managed instruction",
    "[END AGENT BOOST MANAGED ROUTING]",
  ].join("\n");
  const originalPrompt = `${operatorPrefix}${staleBlock}`;
  const originalConfig =
    `agent:\n  system_prompt: ${JSON.stringify(originalPrompt)}\nmodel:\n  default: test\n`;
  const fixture = await createFixture(originalConfig);

  const result = await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, []),
    now: () => new Date("2026-09-03T12:34:56.000Z"),
  });

  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    agent: { system_prompt: string };
  };
  assert.equal(
    config.agent.system_prompt,
    `${operatorPrefix}${HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK}`,
  );
  assert.equal(config.agent.system_prompt.slice(0, operatorPrefix.length), operatorPrefix);
  assert.ok(result.configBackupPath);
  assert.equal(await readFile(result.configBackupPath, "utf8"), originalConfig);
});

test("refuses malformed or non-string managed prompt state before making changes", async (t) => {
  const cases = [
    { label: "non-string", original: "agent:\n  system_prompt: 42\n" },
    {
      label: "unpaired marker",
      original: "agent:\n  system_prompt: '[BEGIN AGENT BOOST MANAGED ROUTING]'\n",
    },
    {
      label: "operator suffix after managed block",
      original: [
        "agent:",
        "  system_prompt: |-",
        "    [BEGIN AGENT BOOST MANAGED ROUTING]",
        "    stale",
        "    [END AGENT BOOST MANAGED ROUTING]",
        "    operator text after managed block",
        "",
      ].join("\n"),
    },
  ];
  for (const { label, original } of cases) {
    await t.test(label, async () => {
      const fixture = await createFixture(original);
      const calls: string[][] = [];
      await assert.rejects(
        installHermesIntegration({
          executablePath: fixture.executablePath,
          runCommand: successfulRunner(fixture.configPath, calls),
        }),
        (error: unknown) =>
          error instanceof HermesInstallError &&
          error.code === "CONFIG_INVALID" &&
          /system_prompt|managed routing block/iu.test(error.message),
      );
      assert.deepEqual(calls, [["hermes", "config", "path"]]);
      assert.equal(await readFile(fixture.configPath, "utf8"), original);
      await assert.rejects(
        readFile(join(fixture.root, "profile", "shell-hooks-allowlist.json")),
        { code: "ENOENT" },
      );
      await assert.rejects(
        readdir(join(fixture.root, "profile", "skills")),
        { code: "ENOENT" },
      );
    });
  }
});

test("refuses blanket hook auto-approval without modifying the profile", async () => {
  const original = "hooks_auto_accept: true\nmodel:\n  default: test\n";
  const fixture = await createFixture(original);
  const calls: string[][] = [];

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, calls),
    }),
    (error: unknown) =>
      error instanceof HermesInstallError &&
      error.code === "CONFIG_INVALID" &&
      /blanket hook auto-approval/u.test(error.message),
  );

  assert.deepEqual(calls, [["hermes", "config", "path"]]);
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
  await assert.rejects(
    readFile(join(fixture.root, "profile", "shell-hooks-allowlist.json")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readdir(join(fixture.root, "profile", "skills")),
    { code: "ENOENT" },
  );
});

test("preserves an explicit output-guard plugin deny-list", async () => {
  const original = [
    "plugins:",
    "  disabled: [agent-boost-output-guard]",
    "model:",
    "  default: test",
    "",
  ].join("\n");
  const fixture = await createFixture(original);
  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, []),
    }),
    (error: unknown) =>
      error instanceof HermesInstallError && error.code === "PLUGIN_CONFIG_CONFLICT",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
});

test("preserves every explicit Hermes tool-search mode and legacy boolean", async (t) => {
  for (const [source, expected] of [
    ["on", "on"],
    ["off", "off"],
    ["auto", "auto"],
    ["true", true],
    ["false", false],
  ] as const) {
    await t.test(source, async () => {
      const toolSearch = typeof expected === "boolean"
        ? `  tool_search: ${source}`
        : `  tool_search:\n    enabled: ${source}`;
      const fixture = await createFixture(
        `tools:\n${toolSearch}\nmodel:\n  default: test\n`,
      );

      await installHermesIntegration({
        executablePath: fixture.executablePath,
        runCommand: successfulRunner(fixture.configPath, []),
      });

      const config = parse(await readFile(fixture.configPath, "utf8")) as {
        tools: { tool_search: boolean | { enabled: string } };
      };
      assert.deepEqual(
        config.tools.tool_search,
        typeof expected === "boolean" ? expected : { enabled: expected },
      );
    });
  }
});

test("adds the eager default without disturbing tool-search tuning or YAML comments", async () => {
  const fixture = await createFixture(
    [
      "# operator-owned header",
      "model:",
      "  default: test # keep this comment",
      "tools:",
      "  tool_search:",
      "    threshold_pct: 9 # operator tuning",
      "  operator_extension:",
      "    mode: custom",
      "",
    ].join("\n"),
  );

  await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, []),
  });

  const installed = await readFile(fixture.configPath, "utf8");
  assert.match(installed, /# operator-owned header/u);
  assert.match(installed, /# keep this comment/u);
  assert.match(installed, /# operator tuning/u);
  const config = parse(installed) as {
    tools: {
      tool_search: { enabled: string; threshold_pct: number };
      operator_extension: { mode: string };
    };
  };
  assert.deepEqual(config.tools.tool_search, {
    threshold_pct: 9,
    enabled: "off",
  });
  assert.deepEqual(config.tools.operator_extension, { mode: "custom" });
});

test("validates the complete modular bundle before installing any skill", async () => {
  const original = "model:\n  default: test\n";
  const fixture = await createFixture(original);
  const calls: string[][] = [];

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, calls),
      confirmationSkillSource: join(fixture.root, "missing-confirmation-skill.md"),
    }),
    { code: "ENOENT" },
  );

  assert.deepEqual(calls, [["hermes", "config", "path"]]);
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
  await assert.rejects(
    readdir(join(fixture.root, "profile", "skills")),
    { code: "ENOENT" },
  );
});

test("checked-in Hermes YAML stays identical to the generated config", async () => {
  const examplePath = new URL(
    "../integrations/hermes/mcp-config.yaml",
    import.meta.url,
  );
  const example = parse(await readFile(examplePath, "utf8")) as {
    agent: {
      tool_use_enforcement: boolean;
      execution_guidance: boolean;
      task_completion_guidance: boolean;
      parallel_tool_call_guidance: boolean;
      system_prompt: string;
    };
    mcp_discovery_timeout: number;
    mcp_single_query_discovery_timeout: number;
    tools: { tool_search: { enabled: string } };
    plugins: {
      enabled: string[];
      entries: Record<string, { settings: { turn_gate_executable: string } }>;
    };
    hooks_auto_accept: boolean;
    hooks: Record<string, unknown>;
    mcp_servers: Record<string, unknown>;
  };
  assert.deepEqual(example.agent, {
    tool_use_enforcement: true,
    execution_guidance: false,
    task_completion_guidance: false,
    parallel_tool_call_guidance: false,
    system_prompt: HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK,
  });
  assert.equal(
    example.mcp_discovery_timeout,
    HERMES_MCP_DISCOVERY_TIMEOUT_SECONDS,
  );
  assert.equal(
    example.mcp_single_query_discovery_timeout,
    HERMES_MCP_DISCOVERY_TIMEOUT_SECONDS,
  );
  assert.equal(example.tools.tool_search.enabled, "off");
  assert.deepEqual(example.plugins.enabled, ["agent-boost-output-guard"]);
  assert.equal(
    example.plugins.entries["agent-boost-output-guard"]?.settings.turn_gate_executable,
    "/absolute/path/to/agent-boost",
  );
  assert.equal(example.hooks_auto_accept, false);
  assert.deepEqual(
    example.hooks,
    createHermesTurnGateHooks("/absolute/path/to/agent-boost"),
  );
  assert.equal(
    (example.hooks.pre_tool_call as Array<{ matcher: string }>)[0]?.matcher,
    HERMES_TURN_GATE_PRE_MATCHER,
  );
  assert.equal(
    (example.hooks.post_tool_call as Array<{ matcher: string }>)[0]?.matcher,
    HERMES_TURN_GATE_POST_MATCHER,
  );
  assert.deepEqual(
    example.mcp_servers["agent-boost"],
    createHermesServerConfig("/absolute/path/to/agent-boost"),
  );
});

test("an identical repeat is idempotent and does not create another backup", async () => {
  const fixture = await createFixture();
  const firstCalls: string[][] = [];
  await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, firstCalls),
  });
  const directoryBefore = await readdir(join(fixture.root, "profile"));

  const secondCalls: string[][] = [];
  const result = await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, secondCalls),
  });
  const directoryAfter = await readdir(join(fixture.root, "profile"));

  assert.equal(result.configChanged, false);
  assert.equal(result.configBackupPath, undefined);
  assert.equal(result.hookAllowlistChanged, false);
  assert.equal(result.hookAllowlistBackupPath, undefined);
  assert.deepEqual(
    result.skills.map((skill) => skill.changed),
    HERMES_SKILL_NAMES.map(() => false),
  );
  assert.deepEqual(directoryAfter.sort(), directoryBefore.sort());
  const installed = parse(await readFile(fixture.configPath, "utf8")) as {
    agent: { system_prompt: string };
  };
  assert.equal(
    installed.agent.system_prompt.split("[BEGIN AGENT BOOST MANAGED ROUTING]").length - 1,
    1,
  );
  assert.deepEqual(secondCalls, [
    ["hermes", "config", "path"],
    ["hermes", "hooks", "test", "pre_tool_call", "--for-tool", "mcp__agent_boost__capabilities"],
    ["hermes", "hooks", "test", "post_tool_call", "--for-tool", "mcp__agent_boost__capabilities"],
    ["hermes", "mcp", "test", "agent-boost"],
    ["hermes", "plugins", "doctor", result.outputGuardPluginPath, "--ci"],
  ]);
});

test("preserves existing hook approvals and adds only the exact turn-gate pairs", async () => {
  const fixture = await createFixture();
  const allowlistPath = join(
    fixture.root,
    "profile",
    "shell-hooks-allowlist.json",
  );
  const original = `${JSON.stringify({
    approvals: [{
      event: "pre_tool_call",
      command: "/operator/existing-hook",
      approved_at: "2026-09-01T00:00:00Z",
    }],
    operator_metadata: { keep: true },
  }, null, 2)}\n`;
  await writeFile(allowlistPath, original, { mode: 0o640 });
  await chmod(allowlistPath, 0o640);

  const result = await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, []),
    now: () => new Date("2026-09-03T12:00:00.000Z"),
  });

  assert.equal(result.hookAllowlistChanged, true);
  assert.ok(result.hookAllowlistBackupPath);
  assert.equal(await readFile(result.hookAllowlistBackupPath, "utf8"), original);
  assert.equal((await stat(result.hookAllowlistPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    JSON.parse(await readFile(result.hookAllowlistPath, "utf8")),
    {
      approvals: [
        {
          event: "pre_tool_call",
          command: "/operator/existing-hook",
          approved_at: "2026-09-01T00:00:00Z",
        },
        { event: "pre_tool_call", command: result.turnGateCommand },
        { event: "post_tool_call", command: result.turnGateCommand },
      ],
      operator_metadata: { keep: true },
    },
  );
});

test("removes the retired managed pre-LLM approval and tightens allowlist mode", async () => {
  const fixture = await createFixture();
  const resolvedExecutablePath = await realpath(fixture.executablePath);
  const command = `${resolvedExecutablePath} hermes-turn-gate`;
  const allowlistPath = join(
    fixture.root,
    "profile",
    "shell-hooks-allowlist.json",
  );
  const original = `${JSON.stringify({
    operator_metadata: { preserve: true },
    approvals: [
      { event: "pre_llm_call", command },
      { event: "pre_tool_call", command },
      { event: "post_tool_call", command },
    ],
  })}\n`;
  await writeFile(allowlistPath, original, { mode: 0o644 });
  await chmod(allowlistPath, 0o644);

  const result = await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, []),
  });

  assert.equal(result.hookAllowlistChanged, true);
  assert.ok(result.hookAllowlistBackupPath);
  assert.equal(await readFile(result.hookAllowlistBackupPath, "utf8"), original);
  assert.deepEqual(JSON.parse(await readFile(allowlistPath, "utf8")), {
    operator_metadata: { preserve: true },
    approvals: [
      { event: "pre_tool_call", command },
      { event: "post_tool_call", command },
    ],
  });
  assert.equal((await stat(allowlistPath)).mode & 0o777, 0o600);
});

test("migrates a prior managed executable path without leaving duplicate hooks or approvals", async () => {
  const fixture = await createFixture();
  const previousExecutablePath = join(fixture.root, "old-bin", "agent-boost");
  await mkdir(join(fixture.root, "old-bin"), { recursive: true });
  await writeFile(previousExecutablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(previousExecutablePath, 0o755);
  const resolvedPreviousExecutablePath = await realpath(previousExecutablePath);
  const previousServer = createHermesServerConfig(resolvedPreviousExecutablePath);
  const previousHooks = createHermesTurnGateHooks(resolvedPreviousExecutablePath);
  const previousCommand = `${resolvedPreviousExecutablePath} hermes-turn-gate`;
  const previousHooksWithPreLlm = {
    pre_llm_call: [{ command: previousCommand, timeout: 5 }],
    ...previousHooks,
  };
  // Simulate the previously shipped narrow pre matcher. The installer owns
  // this exact legacy shape and must upgrade it to the all-tool hard stop.
  previousHooks.pre_tool_call[0]!.matcher = HERMES_TURN_GATE_POST_MATCHER;
  previousHooks.pre_tool_call.push({ ...previousHooks.pre_tool_call[0]! });
  previousHooks.post_tool_call.push({ ...previousHooks.post_tool_call[0]! });
  await writeFile(
    fixture.configPath,
    [
      `hooks: ${JSON.stringify(previousHooksWithPreLlm)}`,
      `plugins: {entries: {agent-boost-output-guard: {settings: {turn_gate_executable: ${JSON.stringify(resolvedPreviousExecutablePath)}, operator_setting: keep}}}}`,
      `mcp_servers: {agent-boost: ${JSON.stringify(previousServer)}}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const allowlistPath = join(
    fixture.root,
    "profile",
    "shell-hooks-allowlist.json",
  );
  await writeFile(
    allowlistPath,
    `${JSON.stringify({
      approvals: [
        { event: "pre_tool_call", command: "/operator/hook" },
        { event: "pre_llm_call", command: previousCommand },
        { event: "pre_tool_call", command: previousCommand },
        { event: "pre_tool_call", command: previousCommand },
        { event: "post_tool_call", command: previousCommand },
      ],
      operator_metadata: { keep: true },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const result = await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, []),
  });
  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    hooks: Record<string, unknown>;
    mcp_servers: Record<string, unknown>;
    plugins: {
      entries: Record<string, { settings: Record<string, unknown> }>;
    };
  };
  assert.deepEqual(config.hooks, createHermesTurnGateHooks(result.executablePath));
  assert.deepEqual(
    config.mcp_servers["agent-boost"],
    createHermesServerConfig(result.executablePath),
  );
  assert.deepEqual(
    config.plugins.entries["agent-boost-output-guard"]?.settings,
    {
      turn_gate_executable: result.executablePath,
      operator_setting: "keep",
    },
  );
  assert.doesNotMatch(await readFile(fixture.configPath, "utf8"), new RegExp(previousCommand, "u"));
  assert.deepEqual(
    JSON.parse(await readFile(allowlistPath, "utf8")),
    {
      approvals: [
        { event: "pre_tool_call", command: "/operator/hook" },
        { event: "pre_tool_call", command: result.turnGateCommand },
        { event: "post_tool_call", command: result.turnGateCommand },
      ],
      operator_metadata: { keep: true },
    },
  );
});

test("upgrades every legacy Hermes tool name from the full prior allowlist", async () => {
  const legacyUpgrades: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["wallet_get_saved_profiles", ["wallet_list_saved_profiles"]],
    ["wallet_list", ["wallet_list_saved_profiles"]],
    ["wallet_manage_profiles", ["wallet_list_saved_profiles"]],
    ["wallet_get_context", ["wallet_get_main_balance"]],
    ["wallet_get_request", ["wallet_get_private_transfer_request"]],
    ["wallet_get_private_payment_request", ["wallet_get_private_transfer_request"]],
    [
      "wallet_switch_saved_profile",
      ["wallet_preview_saved_profile_load", "wallet_apply_saved_profile_load"],
    ],
    [
      "wallet_select",
      ["wallet_preview_saved_profile_load", "wallet_apply_saved_profile_load"],
    ],
    ["wallet_reauthorize", ["wallet_apply_reauthorization"]],
    ["wallet_plan_regular_transfer", ["wallet_preview_regular_transfer"]],
    ["wallet_plan_private_payment", ["wallet_preview_private_transfer"]],
    ["wallet_execute_private_payment", ["wallet_execute_private_transfer"]],
    ["wallet_plan_recovery_transfer", ["wallet_preview_recovery_transfer"]],
  ];
  for (const [legacyName, canonicalNames] of legacyUpgrades) {
    const fixture = await createFixture();
    const previous = createHermesServerConfig(
      await realpath(fixture.executablePath),
    ) as {
      tools: { include: string[] };
    };
    previous.tools.include = previous.tools.include
      .filter((tool) => !canonicalNames.includes(tool))
      .concat(legacyName);
    assert.ok(previous.tools.include.includes(legacyName));
    assert.ok(canonicalNames.every((canonicalName) => !previous.tools.include.includes(canonicalName)));
    await writeFile(
      fixture.configPath,
      `mcp_servers:\n  agent-boost: ${JSON.stringify(previous)}\n`,
      { mode: 0o600 },
    );
    const calls: string[][] = [];

    const result = await installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, calls),
      now: () => new Date("2026-09-02T12:00:00.000Z"),
    });

    assert.equal(result.configChanged, true);
    assert.ok(result.configBackupPath);
    assert.match(await readFile(result.configBackupPath, "utf8"), new RegExp(legacyName, "u"));
    const configText = await readFile(fixture.configPath, "utf8");
    const config = parse(configText) as {
      mcp_servers: Record<string, unknown>;
    };
    const installedServer = config.mcp_servers["agent-boost"] as {
      tools: { include: string[] };
    };
    assert.ok(!installedServer.tools.include.includes(legacyName));
    assert.deepEqual(
      config.mcp_servers["agent-boost"],
      createHermesServerConfig(result.executablePath),
    );
  }
});

test("upgrades the exact mixed legacy production allowlist in one install", async () => {
  const fixture = await createFixture();
  const previous = createHermesServerConfig(
    await realpath(fixture.executablePath),
  ) as { tools: { include: string[] } };
  const replaced = new Set([
    "wallet_list_saved_profiles",
    "wallet_get_main_balance",
    "wallet_get_private_transfer_request",
    "wallet_preview_saved_profile_load",
    "wallet_apply_saved_profile_load",
    "wallet_apply_reauthorization",
    "wallet_preview_regular_transfer",
    "wallet_preview_private_transfer",
    "wallet_execute_private_transfer",
    "wallet_preview_recovery_transfer",
  ]);
  const legacyNames = [
    "wallet_get_saved_profiles",
    "wallet_get_context",
    "wallet_get_request",
    "wallet_get_private_payment_request",
    "wallet_select",
    "wallet_reauthorize",
    "wallet_plan_regular_transfer",
    "wallet_plan_private_payment",
    "wallet_execute_private_payment",
    "wallet_plan_recovery_transfer",
  ];
  previous.tools.include = [
    ...previous.tools.include.filter((name) => !replaced.has(name)),
    ...legacyNames,
  ];
  await writeFile(
    fixture.configPath,
    `mcp_servers:\n  agent-boost: ${JSON.stringify(previous)}\n`,
    { mode: 0o600 },
  );

  const result = await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, []),
    now: () => new Date("2026-09-02T12:00:00.000Z"),
  });

  assert.ok(result.configBackupPath);
  const backup = await readFile(result.configBackupPath, "utf8");
  for (const legacyName of legacyNames) assert.match(backup, new RegExp(legacyName, "u"));
  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    mcp_servers: Record<string, unknown>;
  };
  assert.deepEqual(
    config.mcp_servers["agent-boost"],
    createHermesServerConfig(result.executablePath),
  );
});

test("upgrades only the exact historical 29-tool allowlist and stays idempotent", async () => {
  assert.equal(HISTORICAL_29_TOOL_ALLOWLIST.length, 29);
  assert.equal(HERMES_NATIVE_TOOLS.length, 37);
  assert.deepEqual(
    HERMES_NATIVE_TOOLS.filter(
      (tool) => !HISTORICAL_29_TOOL_ALLOWLIST.includes(
        tool as (typeof HISTORICAL_29_TOOL_ALLOWLIST)[number],
      ),
    ),
    NAMED_PRIVATE_BALANCE_TOOLS,
  );
  const fixture = await createFixture();
  const previous = createHermesServerConfig(
    await realpath(fixture.executablePath),
  ) as { tools: { include: string[] } };
  previous.tools.include = [...HISTORICAL_29_TOOL_ALLOWLIST].reverse();
  const original = `mcp_servers:\n  agent-boost: ${JSON.stringify(previous)}\n`;
  await writeFile(fixture.configPath, original, { mode: 0o600 });

  const first = await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, []),
    now: () => new Date("2026-09-02T12:00:00.000Z"),
  });
  assert.equal(first.configChanged, true);
  assert.ok(first.configBackupPath);
  assert.equal(await readFile(first.configBackupPath, "utf8"), original);
  const migratedText = await readFile(fixture.configPath, "utf8");
  const migrated = parse(migratedText) as {
    mcp_servers: Record<string, { tools: { include: string[] } }>;
  };
  assert.deepEqual(
    migrated.mcp_servers["agent-boost"]?.tools.include,
    [...HERMES_NATIVE_TOOLS],
  );

  const second = await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, []),
    now: () => new Date("2026-09-02T12:00:01.000Z"),
  });
  assert.equal(second.configChanged, false);
  assert.equal(second.configBackupPath, undefined);
  assert.equal(await readFile(fixture.configPath, "utf8"), migratedText);
  assert.deepEqual(
    second.skills.map(({ changed }) => changed),
    HERMES_SKILL_NAMES.map(() => false),
  );
});

test("rejects every near-miss of the historical 29-tool allowlist", async (t) => {
  const nearMisses = {
    "one historical tool missing": HISTORICAL_29_TOOL_ALLOWLIST.slice(0, -1),
    "only one new private-balance tool added": [
      ...HISTORICAL_29_TOOL_ALLOWLIST,
      NAMED_PRIVATE_BALANCE_TOOLS[0],
    ],
    "one historical tool replaced by a custom tool": [
      ...HISTORICAL_29_TOOL_ALLOWLIST.slice(0, -1),
      "operator_custom_wallet_tool",
    ],
    "one historical tool duplicated": [
      ...HISTORICAL_29_TOOL_ALLOWLIST.slice(0, -1),
      HISTORICAL_29_TOOL_ALLOWLIST[0],
    ],
  } satisfies Record<string, readonly string[]>;

  for (const [name, include] of Object.entries(nearMisses)) {
    await t.test(name, async () => {
      const fixture = await createFixture();
      const partial = createHermesServerConfig(
        await realpath(fixture.executablePath),
      ) as { tools: { include: string[] } };
      partial.tools.include = [...include];
      const original = `mcp_servers:\n  agent-boost: ${JSON.stringify(partial)}\n`;
      await writeFile(fixture.configPath, original, { mode: 0o600 });
      const calls: string[][] = [];

      await assert.rejects(
        installHermesIntegration({
          executablePath: fixture.executablePath,
          runCommand: successfulRunner(fixture.configPath, calls),
        }),
        (error: unknown) =>
          error instanceof HermesInstallError && error.code === "MCP_SERVER_CONFLICT",
      );
      assert.equal(await readFile(fixture.configPath, "utf8"), original);
      assert.deepEqual(calls, [["hermes", "config", "path"]]);
      await assert.rejects(
        readFile(join(fixture.root, "profile", "skills", "agent-boost", "SKILL.md")),
        { code: "ENOENT" },
      );
    });
  }
});

test("refuses a conflicting agent-boost entry without modifying files", async () => {
  const original = [
    "mcp_servers:",
    "  agent-boost:",
    "    command: /someone/elses/agent-boost",
    "",
  ].join("\n");
  const fixture = await createFixture(original);
  const calls: string[][] = [];

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, calls),
    }),
    (error: unknown) =>
      error instanceof HermesInstallError &&
      error.code === "MCP_SERVER_CONFLICT",
  );

  assert.equal(await readFile(fixture.configPath, "utf8"), original);
  assert.deepEqual(calls, [["hermes", "config", "path"]]);
  await assert.rejects(
    readFile(
      join(fixture.root, "profile", "skills", "agent-boost", "SKILL.md"),
    ),
    { code: "ENOENT" },
  );
});

test("refuses a conflicting turn-gate entry without approving or replacing it", async () => {
  const fixture = await createFixture();
  const command = `${await realpath(fixture.executablePath)} hermes-turn-gate`;
  const original = [
    "hooks:",
    "  pre_tool_call:",
    "    - matcher: terminal",
    `      command: ${JSON.stringify(command)}`,
    "      timeout: 30",
    "model:",
    "  default: test",
    "",
  ].join("\n");
  await writeFile(fixture.configPath, original, { mode: 0o600 });

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, []),
    }),
    (error: unknown) =>
      error instanceof HermesInstallError &&
      error.code === "HOOK_CONFIG_CONFLICT",
  );

  assert.equal(await readFile(fixture.configPath, "utf8"), original);
  await assert.rejects(
    readFile(join(fixture.root, "profile", "shell-hooks-allowlist.json")),
    { code: "ENOENT" },
  );
});

test("removes only the exact managed pre-LLM hook and approval", async () => {
  const fixture = await createFixture();
  const command = `${await realpath(fixture.executablePath)} hermes-turn-gate`;
  const operatorHook = {
    command: "/operator/pre-llm-hook",
    timeout: 17,
    operator_setting: "keep",
  };
  await writeFile(
    fixture.configPath,
    [
      "hooks:",
      "  pre_llm_call:",
      `    - ${JSON.stringify(operatorHook)}`,
      `    - ${JSON.stringify({ command, timeout: 5 })}`,
      "model:",
      "  default: test",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const allowlistPath = join(
    fixture.root,
    "profile",
    "shell-hooks-allowlist.json",
  );
  const operatorApproval = {
    event: "pre_llm_call",
    command: "/operator/pre-llm-hook",
    approved_at: "operator-owned",
  };
  const customizedManagedApproval = {
    event: "pre_llm_call",
    command,
    approved_at: "operator-customized",
  };
  await writeFile(
    allowlistPath,
    `${JSON.stringify({
      approvals: [
        operatorApproval,
        customizedManagedApproval,
        { event: "pre_llm_call", command },
      ],
      operator_metadata: { keep: true },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const result = await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, []),
  });
  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    hooks: Record<string, Array<Record<string, unknown>>>;
  };
  assert.deepEqual(config.hooks.pre_llm_call, [operatorHook]);
  assert.deepEqual(
    {
      pre_tool_call: config.hooks.pre_tool_call,
      post_tool_call: config.hooks.post_tool_call,
    },
    createHermesTurnGateHooks(result.executablePath),
  );
  assert.deepEqual(JSON.parse(await readFile(allowlistPath, "utf8")), {
    approvals: [
      operatorApproval,
      customizedManagedApproval,
      { event: "pre_tool_call", command: result.turnGateCommand },
      { event: "post_tool_call", command: result.turnGateCommand },
    ],
    operator_metadata: { keep: true },
  });
});

test("refuses to remove a customized pre-LLM hook using the managed command", async () => {
  const fixture = await createFixture();
  const command = `${await realpath(fixture.executablePath)} hermes-turn-gate`;
  const original = [
    "hooks:",
    "  pre_llm_call:",
    `    - command: ${JSON.stringify(command)}`,
    "      timeout: 11",
    "      operator_setting: keep",
    "model:",
    "  default: test",
    "",
  ].join("\n");
  await writeFile(fixture.configPath, original, { mode: 0o600 });

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, []),
    }),
    (error: unknown) =>
      error instanceof HermesInstallError &&
      error.code === "HOOK_CONFIG_CONFLICT" &&
      error.details.event === "pre_llm_call",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
  await assert.rejects(
    readFile(join(fixture.root, "profile", "shell-hooks-allowlist.json")),
    { code: "ENOENT" },
  );
});

test("refuses malformed or conflicting native bridge plugin settings before mutation", async (t) => {
  const cases = [
    {
      name: "entries is not a mapping",
      config: "plugins:\n  entries: []\n",
      code: "CONFIG_INVALID",
    },
    {
      name: "plugin entry is not a mapping",
      config: "plugins:\n  entries:\n    agent-boost-output-guard: []\n",
      code: "CONFIG_INVALID",
    },
    {
      name: "settings is not a mapping",
      config: "plugins:\n  entries:\n    agent-boost-output-guard:\n      settings: []\n",
      code: "CONFIG_INVALID",
    },
    {
      name: "executable conflicts",
      config: "plugins:\n  entries:\n    agent-boost-output-guard:\n      settings:\n        turn_gate_executable: /operator/agent-boost\n",
      code: "PLUGIN_CONFIG_CONFLICT",
    },
  ] as const;
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = await createFixture(entry.config);
      await assert.rejects(
        installHermesIntegration({
          executablePath: fixture.executablePath,
          runCommand: successfulRunner(fixture.configPath, []),
        }),
        (error: unknown) =>
          error instanceof HermesInstallError && error.code === entry.code,
      );
      assert.equal(await readFile(fixture.configPath, "utf8"), entry.config);
      await assert.rejects(
        readFile(join(fixture.root, "profile", "shell-hooks-allowlist.json")),
        { code: "ENOENT" },
      );
      await assert.rejects(
        readdir(join(fixture.root, "profile", "skills")),
        { code: "ENOENT" },
      );
    });
  }
});

test("refuses linked config, skill, and hook targets before mutation", async (t) => {
  await t.test("config parent directory", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside-profile");
    const linkedProfile = join(fixture.root, "linked-profile");
    await mkdir(outside);
    await writeFile(join(outside, "config.yaml"), "model:\n  default: outside\n", {
      mode: 0o600,
    });
    await symlink(outside, linkedProfile);
    const linkedConfigPath = join(linkedProfile, "config.yaml");

    await assert.rejects(
      installHermesIntegration({
        executablePath: fixture.executablePath,
        runCommand: successfulRunner(linkedConfigPath, []),
      }),
      (error: unknown) =>
        error instanceof HermesInstallError &&
        error.code === "INSTALL_TARGET_UNSAFE",
    );
    assert.deepEqual(await readdir(outside), ["config.yaml"]);
  });

  await t.test("config target", async () => {
    const fixture = await createFixture();
    const target = join(fixture.root, "linked-config-target.yaml");
    const original = "model:\n  default: linked\n";
    await writeFile(target, original, { mode: 0o600 });
    await unlink(fixture.configPath);
    await symlink(target, fixture.configPath);

    await assert.rejects(
      installHermesIntegration({
        executablePath: fixture.executablePath,
        runCommand: successfulRunner(fixture.configPath, []),
      }),
      (error: unknown) =>
        error instanceof HermesInstallError &&
        error.code === "INSTALL_TARGET_UNSAFE",
    );
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal((await lstat(fixture.configPath)).isSymbolicLink(), true);
  });

  await t.test("skill target", async () => {
    const fixture = await createFixture();
    const target = join(fixture.root, "linked-skill-target.md");
    const originalConfig = await readFile(fixture.configPath, "utf8");
    await writeFile(target, "operator-owned linked skill\n", { mode: 0o600 });
    const destinationDirectory = join(
      fixture.root,
      "profile",
      "skills",
      "agent-boost-setup",
    );
    await mkdir(destinationDirectory, { recursive: true });
    await symlink(target, join(destinationDirectory, "SKILL.md"));

    await assert.rejects(
      installHermesIntegration({
        executablePath: fixture.executablePath,
        runCommand: successfulRunner(fixture.configPath, []),
      }),
      (error: unknown) =>
        error instanceof HermesInstallError &&
        error.code === "INSTALL_TARGET_UNSAFE",
    );
    assert.equal(await readFile(target, "utf8"), "operator-owned linked skill\n");
    assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  });

  await t.test("skill parent directory", async () => {
    const fixture = await createFixture();
    const originalConfig = await readFile(fixture.configPath, "utf8");
    const outside = join(fixture.root, "outside-skills");
    await mkdir(outside);
    await symlink(outside, join(fixture.root, "profile", "skills"));

    await assert.rejects(
      installHermesIntegration({
        executablePath: fixture.executablePath,
        runCommand: successfulRunner(fixture.configPath, []),
      }),
      (error: unknown) =>
        error instanceof HermesInstallError &&
        error.code === "INSTALL_TARGET_UNSAFE",
    );
    assert.deepEqual(await readdir(outside), []);
    assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  });

  await t.test("plugin parent directory", async () => {
    const fixture = await createFixture();
    const originalConfig = await readFile(fixture.configPath, "utf8");
    const plugins = join(fixture.root, "profile", "plugins");
    const outside = join(fixture.root, "outside-plugin");
    await mkdir(plugins);
    await mkdir(outside);
    await symlink(outside, join(plugins, "agent-boost-output-guard"));

    await assert.rejects(
      installHermesIntegration({
        executablePath: fixture.executablePath,
        runCommand: successfulRunner(fixture.configPath, []),
      }),
      (error: unknown) =>
        error instanceof HermesInstallError &&
        error.code === "INSTALL_TARGET_UNSAFE",
    );
    assert.deepEqual(await readdir(outside), []);
    assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  });

  await t.test("hook allowlist target", async () => {
    const fixture = await createFixture();
    const target = join(fixture.root, "linked-hook-allowlist.json");
    const originalConfig = await readFile(fixture.configPath, "utf8");
    const originalAllowlist = '{"approvals":[]}\n';
    await writeFile(target, originalAllowlist, { mode: 0o600 });
    const allowlistPath = join(
      fixture.root,
      "profile",
      "shell-hooks-allowlist.json",
    );
    await symlink(target, allowlistPath);

    await assert.rejects(
      installHermesIntegration({
        executablePath: fixture.executablePath,
        runCommand: successfulRunner(fixture.configPath, []),
      }),
      (error: unknown) =>
        error instanceof HermesInstallError &&
        error.code === "INSTALL_TARGET_UNSAFE",
    );
    assert.equal(await readFile(target, "utf8"), originalAllowlist);
    assert.equal((await lstat(allowlistPath)).isSymbolicLink(), true);
    assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  });

  await t.test("hardlinked config target", async () => {
    const fixture = await createFixture();
    const target = join(fixture.root, "hardlinked-config-target.yaml");
    const original = "model:\n  default: hardlinked\n";
    await writeFile(target, original, { mode: 0o600 });
    await unlink(fixture.configPath);
    await link(target, fixture.configPath);

    await assert.rejects(
      installHermesIntegration({
        executablePath: fixture.executablePath,
        runCommand: successfulRunner(fixture.configPath, []),
      }),
      (error: unknown) =>
        error instanceof HermesInstallError &&
        error.code === "INSTALL_TARGET_UNSAFE",
    );
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal((await stat(target)).nlink, 2);
  });

  await t.test("hardlinked hook allowlist target", async () => {
    const fixture = await createFixture();
    const target = join(fixture.root, "hardlinked-hook-allowlist.json");
    const originalConfig = await readFile(fixture.configPath, "utf8");
    const originalAllowlist = '{"approvals":[]}\n';
    await writeFile(target, originalAllowlist, { mode: 0o600 });
    const allowlistPath = join(
      fixture.root,
      "profile",
      "shell-hooks-allowlist.json",
    );
    await link(target, allowlistPath);

    await assert.rejects(
      installHermesIntegration({
        executablePath: fixture.executablePath,
        runCommand: successfulRunner(fixture.configPath, []),
      }),
      (error: unknown) =>
        error instanceof HermesInstallError &&
        error.code === "INSTALL_TARGET_UNSAFE",
    );
    assert.equal(await readFile(target, "utf8"), originalAllowlist);
    assert.equal((await stat(target)).nlink, 2);
    assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  });
});

test("refuses a malformed hook allowlist before mutating config or skills", async () => {
  const fixture = await createFixture();
  const originalConfig = await readFile(fixture.configPath, "utf8");
  const allowlistPath = join(
    fixture.root,
    "profile",
    "shell-hooks-allowlist.json",
  );
  const malformed = '{"approvals": "not-a-list"}\n';
  await writeFile(allowlistPath, malformed, { mode: 0o600 });

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, []),
    }),
    (error: unknown) =>
      error instanceof HermesInstallError &&
      error.code === "HOOK_ALLOWLIST_INVALID",
  );

  assert.equal(await readFile(allowlistPath, "utf8"), malformed);
  assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  await assert.rejects(
    readdir(join(fixture.root, "profile", "skills")),
    { code: "ENOENT" },
  );
});

test("refuses to broaden a customized partial Agent Boost allowlist", async () => {
  const fixture = await createFixture();
  const partial = createHermesServerConfig(
    await realpath(fixture.executablePath),
  ) as { tools: { include: string[] } };
  partial.tools.include = ["capabilities", "wallet_get_tree"];
  const original = `mcp_servers:\n  agent-boost: ${JSON.stringify(partial)}\n`;
  await writeFile(fixture.configPath, original, { mode: 0o600 });

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, []),
    }),
    (error: unknown) =>
      error instanceof HermesInstallError && error.code === "MCP_SERVER_CONFLICT",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
  await assert.rejects(
    readFile(join(fixture.root, "profile", "skills", "agent-boost", "SKILL.md")),
    { code: "ENOENT" },
  );
});

test("a failed Hermes turn-gate smoke test rolls back the whole install", async (t) => {
  for (const failedEvent of ["pre_tool_call", "post_tool_call"] as const) {
    await t.test(failedEvent, async () => {
      const fixture = await createFixture();
      const originalConfig = await readFile(fixture.configPath, "utf8");
      const calls: string[][] = [];

      await assert.rejects(
        installHermesIntegration({
          executablePath: fixture.executablePath,
          runCommand: async (command, args) => {
            calls.push([command, ...args]);
            if (args.join(" ") === "config path") {
              return {
                exitCode: 0,
                stdout: `${fixture.configPath}\n`,
                stderr: "",
              };
            }
            const hookResult = await successfulHookResult(
              fixture.configPath,
              args,
            );
            if (hookResult !== undefined) {
              if (args[2] !== failedEvent) return hookResult;
              return {
                exitCode: 0,
                stdout: failedEvent === "pre_tool_call"
                  ? hookResult.stdout.replace(
                      /      exit=0[\s\S]*$/u,
                      "      ✗ error: synthetic gate failure\n",
                    )
                  : hookResult.stdout.replace(
                      '      stdout: {"continue":true}',
                      "      stdout: {not-json}",
                    ),
                stderr: "",
              };
            }
            return { exitCode: 0, stdout: "connected\n", stderr: "" };
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof HermesInstallError);
          assert.equal(error.code, "HOOK_TEST_FAILED");
          assert.equal(error.details.hookEvent, failedEvent);
          assert.equal(
            (error.details.rollback as { complete: boolean }).complete,
            true,
          );
          return true;
        },
      );

      assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
      await assert.rejects(
        readFile(join(fixture.root, "profile", "shell-hooks-allowlist.json")),
        { code: "ENOENT" },
      );
      assert.deepEqual(
        await readdir(join(fixture.root, "profile", "skills")),
        [],
      );
      assert.deepEqual(
        calls.map((call) => call.slice(0, 3)),
        [
          ["hermes", "config", "path"],
          ...(["pre_tool_call", "post_tool_call"] as const)
            .slice(0, ["pre_tool_call", "post_tool_call"].indexOf(failedEvent) + 1)
            .map(() => ["hermes", "hooks", "test"]),
        ],
      );
    });
  }
});

test("reports MCP validation failure without restarting Hermes", async () => {
  const fixture = await createFixture();
  const originalConfig = await readFile(fixture.configPath, "utf8");
  const calls: string[][] = [];
  const runner = async (
    command: string,
    args: readonly string[],
  ): Promise<CommandResult> => {
    calls.push([command, ...args]);
    if (args.join(" ") === "config path") {
      return { exitCode: 0, stdout: `Config path: ${fixture.configPath}\n`, stderr: "" };
    }
    const hookResult = await successfulHookResult(fixture.configPath, args);
    if (hookResult !== undefined) return hookResult;
    const staged = parse(await readFile(fixture.configPath, "utf8")) as {
      tools: { tool_search: { enabled: string } };
      mcp_servers: Record<string, unknown>;
    };
    assert.equal(staged.tools.tool_search.enabled, "off");
    assert.ok(staged.mcp_servers["agent-boost"]);
    return { exitCode: 1, stdout: "", stderr: "connection refused" };
  };

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: runner,
    }),
    (error: unknown) => {
      assert.ok(error instanceof HermesInstallError);
      assert.equal(error.code, "MCP_TEST_FAILED");
      assert.match(String(error.details.recommendation), /did not restart Hermes/u);
      assert.equal(
        (error.details.rollback as { complete: boolean }).complete,
        true,
      );
      return true;
    },
  );
  assert.deepEqual(calls, [
    ["hermes", "config", "path"],
    ["hermes", "hooks", "test", "pre_tool_call", "--for-tool", "mcp__agent_boost__capabilities"],
    ["hermes", "hooks", "test", "post_tool_call", "--for-tool", "mcp__agent_boost__capabilities"],
    ["hermes", "mcp", "test", "agent-boost"],
  ]);
  assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  await assert.rejects(
    readFile(join(fixture.root, "profile", "shell-hooks-allowlist.json")),
    { code: "ENOENT" },
  );
  for (const name of HERMES_SKILL_NAMES) {
    await assert.rejects(
      readFile(join(fixture.root, "profile", "skills", name, "SKILL.md")),
      { code: "ENOENT" },
    );
  }
  await assert.rejects(
    readFile(join(fixture.root, "profile", ".agent-boost-install.lock")),
    { code: "ENOENT" },
  );
});

test("a failed output-guard plugin doctor rolls back config and plugin files", async () => {
  const fixture = await createFixture();
  const originalConfig = await readFile(fixture.configPath, "utf8");
  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: async (command, args) => {
        if (args.join(" ") === "config path") {
          return { exitCode: 0, stdout: `${fixture.configPath}\n`, stderr: "" };
        }
        const hook = await successfulHookResult(fixture.configPath, args);
        if (hook !== undefined) return hook;
        if (args.join(" ") === "mcp test agent-boost") {
          return { exitCode: 0, stdout: "connected\n", stderr: "" };
        }
        if (args[0] === "plugins" && args[1] === "doctor") {
          return { exitCode: 1, stdout: "", stderr: "invalid plugin" };
        }
        return { exitCode: 99, stdout: "", stderr: `${command}: unexpected` };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof HermesInstallError);
      assert.equal(error.code, "PLUGIN_TEST_FAILED");
      assert.equal((error.details.rollback as { complete: boolean }).complete, true);
      return true;
    },
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  await assert.rejects(
    readFile(join(fixture.root, "profile", "plugins", "agent-boost-output-guard", "__init__.py")),
    { code: "ENOENT" },
  );
});

test("MCP failure restores existing skill bytes and modes and removes new skills", async () => {
  const fixture = await createFixture("# original\nmodel:\n  default: test\n");
  const existingNames = HERMES_SKILL_NAMES.slice(0, 2);
  for (const name of existingNames) {
    const path = join(fixture.root, "profile", "skills", name, "SKILL.md");
    await mkdir(join(fixture.root, "profile", "skills", name), { recursive: true });
    await writeFile(path, `old ${name}\n`, { mode: 0o640 });
    await chmod(path, 0o640);
  }
  const originalConfig = await readFile(fixture.configPath, "utf8");

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: async (_command, args) => {
        if (args.join(" ") === "config path") {
          return { exitCode: 0, stdout: `${fixture.configPath}\n`, stderr: "" };
        }
        const hookResult = await successfulHookResult(fixture.configPath, args);
        if (hookResult !== undefined) return hookResult;
        return { exitCode: 1, stdout: "", stderr: "validation failed" };
      },
    }),
    (error: unknown) =>
      error instanceof HermesInstallError &&
      error.code === "MCP_TEST_FAILED" &&
      (error.details.rollback as { complete: boolean }).complete,
  );

  assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  for (const name of existingNames) {
    const path = join(fixture.root, "profile", "skills", name, "SKILL.md");
    assert.equal(await readFile(path, "utf8"), `old ${name}\n`);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
  }
  for (const name of HERMES_SKILL_NAMES.slice(2)) {
    await assert.rejects(
      readFile(join(fixture.root, "profile", "skills", name, "SKILL.md")),
      { code: "ENOENT" },
    );
  }
});

test("final CAS leaves out-of-band config and allowlist edits untouched during rollback", async (t) => {
  for (const targetName of ["config", "allowlist"] as const) {
    await t.test(targetName, async () => {
      const fixture = await createFixture();
      const originalConfig = await readFile(fixture.configPath, "utf8");
      const allowlistPath = join(
        fixture.root,
        "profile",
        "shell-hooks-allowlist.json",
      );
      const targetPath = targetName === "config"
        ? fixture.configPath
        : allowlistPath;
      const externalContent = targetName === "config"
        ? "model:\n  default: external-edit\n"
        : '{"approvals":[],"external_edit":true}\n';

      await assert.rejects(
        installHermesIntegration({
          executablePath: fixture.executablePath,
          runCommand: async (_command, args) => {
            if (args.join(" ") === "config path") {
              return {
                exitCode: 0,
                stdout: `${fixture.configPath}\n`,
                stderr: "",
              };
            }
            const hookResult = await successfulHookResult(
              fixture.configPath,
              args,
            );
            if (hookResult !== undefined) return hookResult;
            await writeFile(targetPath, externalContent, { mode: 0o600 });
            return { exitCode: 0, stdout: "connected\n", stderr: "" };
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof HermesInstallError);
          assert.equal(error.code, "INSTALL_TARGET_CHANGED");
          const rollback = error.details.rollback as {
            complete: boolean;
            entries: Array<{ path: string; status: string }>;
          };
          assert.equal(rollback.complete, false);
          assert.deepEqual(
            rollback.entries.find((entry) => entry.path === targetPath),
            {
              path: targetPath,
              status: "conflict",
              reason: "The file changed outside this install; it was left untouched.",
            },
          );
          return true;
        },
      );

      assert.equal(await readFile(targetPath, "utf8"), externalContent);
      if (targetName === "config") {
        await assert.rejects(readFile(allowlistPath), { code: "ENOENT" });
      } else {
        assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
      }
    });
  }
});

test("rollback never deletes a future skill that this install did not attempt", async () => {
  const fixture = await createFixture();
  const setupPath = join(
    fixture.root,
    "profile",
    "skills",
    "agent-boost-setup",
    "SKILL.md",
  );
  const futurePath = join(
    fixture.root,
    "profile",
    "skills",
    "agent-boost",
    "SKILL.md",
  );
  await mkdir(join(fixture.root, "profile", "skills", "agent-boost-setup"), {
    recursive: true,
  });
  await writeFile(setupPath, "operator setup skill\n", { mode: 0o640 });
  await chmod(setupPath, 0o640);
  const futureContent = await readFile(
    new URL("../integrations/hermes/agent-boost/SKILL.md", import.meta.url),
  );
  let injected = false;
  let reportedBackupPaths: string[] = [];

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, []),
      now: () => {
        if (!injected) {
          injected = true;
          mkdirSync(join(fixture.root, "profile", "skills", "agent-boost"), {
            recursive: true,
          });
          writeFileSync(futurePath, futureContent, { mode: 0o644 });
          chmodSync(futurePath, 0o644);
        }
        return new Date("2026-09-03T00:00:00.000Z");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof HermesInstallError);
      assert.equal(error.code, "INSTALL_TARGET_CHANGED");
      assert.equal(
        (error.details.rollback as { complete: boolean }).complete,
        true,
      );
      reportedBackupPaths = (
        error.details.rollback as { backupPaths: string[] }
      ).backupPaths;
      return true;
    },
  );

  assert.equal(await readFile(setupPath, "utf8"), "operator setup skill\n");
  assert.equal((await stat(setupPath)).mode & 0o777, 0o640);
  assert.deepEqual(await readFile(futurePath), futureContent);
  assert.equal(reportedBackupPaths.length, 1);
  assert.equal(await readFile(reportedBackupPaths[0]!, "utf8"), "operator setup skill\n");
});

test("final validation detects an out-of-band edit to an unchanged skill", async () => {
  const fixture = await createFixture();
  for (const name of HERMES_SKILL_NAMES) {
    const destination = join(fixture.root, "profile", "skills", name, "SKILL.md");
    await mkdir(join(fixture.root, "profile", "skills", name), { recursive: true });
    await writeFile(
      destination,
      await readFile(new URL(`../integrations/hermes/${name}/SKILL.md`, import.meta.url)),
      { mode: 0o644 },
    );
    await chmod(destination, 0o644);
  }
  const changedPath = join(
    fixture.root,
    "profile",
    "skills",
    "agent-boost-setup",
    "SKILL.md",
  );
  const originalConfig = await readFile(fixture.configPath, "utf8");

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: async (_command, args) => {
        if (args.join(" ") === "config path") {
          return { exitCode: 0, stdout: `${fixture.configPath}\n`, stderr: "" };
        }
        const hookResult = await successfulHookResult(fixture.configPath, args);
        if (hookResult !== undefined) return hookResult;
        await writeFile(changedPath, "external edit during validation\n", {
          mode: 0o644,
        });
        return { exitCode: 0, stdout: "connected\n", stderr: "" };
      },
    }),
    (error: unknown) =>
      error instanceof HermesInstallError &&
      error.code === "INSTALL_TARGET_CHANGED" &&
      (error.details.rollback as { complete: boolean }).complete,
  );

  assert.equal(await readFile(changedPath, "utf8"), "external edit during validation\n");
  assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
});

test("serializes concurrent installs and releases the owned lock", async () => {
  const fixture = await createFixture();
  let signalMcpStarted: (() => void) | undefined;
  const mcpStarted = new Promise<void>((resolve) => {
    signalMcpStarted = resolve;
  });
  let releaseMcp: (() => void) | undefined;
  const mcpReleased = new Promise<void>((resolve) => {
    releaseMcp = resolve;
  });
  const first = installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: async (_command, args) => {
      if (args.join(" ") === "config path") {
        return { exitCode: 0, stdout: `${fixture.configPath}\n`, stderr: "" };
      }
      const hookResult = await successfulHookResult(fixture.configPath, args);
      if (hookResult !== undefined) return hookResult;
      signalMcpStarted?.();
      await mcpReleased;
      return { exitCode: 0, stdout: "connected\n", stderr: "" };
    },
  });
  await mcpStarted;
  const configDuringFirst = await readFile(fixture.configPath);

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, []),
    }),
    (error: unknown) =>
      error instanceof HermesInstallError && error.code === "INSTALL_LOCKED",
  );
  assert.deepEqual(await readFile(fixture.configPath), configDuringFirst);

  releaseMcp?.();
  await first;
  await assert.rejects(
    readFile(join(fixture.root, "profile", ".agent-boost-install.lock")),
    { code: "ENOENT" },
  );
});

test("lock cleanup failure never masks install commit or rollback outcome", async (t) => {
  await t.test("committed install", async () => {
    const fixture = await createFixture();
    const lockPath = join(fixture.root, "profile", ".agent-boost-install.lock");
    let lockReplaced = false;
    await assert.rejects(
      installHermesIntegration({
        executablePath: fixture.executablePath,
        runCommand: async (_command, args) => {
          if (args.join(" ") === "config path") {
            return { exitCode: 0, stdout: `${fixture.configPath}\n`, stderr: "" };
          }
          const hookResult = await successfulHookResult(fixture.configPath, args);
          if (hookResult !== undefined) return hookResult;
          if (!lockReplaced) {
            await unlink(lockPath);
            await mkdir(lockPath);
            lockReplaced = true;
          }
          return { exitCode: 0, stdout: "connected\n", stderr: "" };
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HermesInstallError);
        assert.equal(error.code, "COMMAND_FAILED");
        assert.equal(error.details.committed, true);
        assert.equal(
          (error.details.lockCleanup as { complete: boolean }).complete,
          false,
        );
        return true;
      },
    );
    const config = parse(await readFile(fixture.configPath, "utf8")) as {
      mcp_servers: Record<string, unknown>;
    };
    assert.ok(config.mcp_servers["agent-boost"]);
    assert.match(
      await readFile(
        join(fixture.root, "profile", "skills", "agent-boost", "SKILL.md"),
        "utf8",
      ),
      /Agent Boost/u,
    );
  });

  await t.test("failed validation with completed rollback", async () => {
    const fixture = await createFixture();
    const originalConfig = await readFile(fixture.configPath, "utf8");
    const lockPath = join(fixture.root, "profile", ".agent-boost-install.lock");
    await assert.rejects(
      installHermesIntegration({
        executablePath: fixture.executablePath,
        runCommand: async (_command, args) => {
          if (args.join(" ") === "config path") {
            return { exitCode: 0, stdout: `${fixture.configPath}\n`, stderr: "" };
          }
          const hookResult = await successfulHookResult(fixture.configPath, args);
          if (hookResult !== undefined) return hookResult;
          await unlink(lockPath);
          await mkdir(lockPath);
          return { exitCode: 1, stdout: "", stderr: "validation failed" };
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HermesInstallError);
        assert.equal(error.code, "MCP_TEST_FAILED");
        assert.equal(
          (error.details.rollback as { complete: boolean }).complete,
          true,
        );
        assert.equal(
          (error.details.lockCleanup as { complete: boolean }).complete,
          false,
        );
        return true;
      },
    );
    assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
    await assert.rejects(
      readFile(join(fixture.root, "profile", "skills", "agent-boost", "SKILL.md")),
      { code: "ENOENT" },
    );
  });
});

test("does not race-reclaim a dead-owner lock and reports the owner PID", async () => {
  const fixture = await createFixture();
  const lockPath = join(fixture.root, "profile", ".agent-boost-install.lock");
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: 2_147_483_647, token: "crashed-owner" })}\n`,
    { mode: 0o600 },
  );

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, []),
    }),
    (error: unknown) => {
      assert.ok(error instanceof HermesInstallError);
      assert.equal(error.code, "INSTALL_LOCKED");
      assert.equal(error.details.ownerPid, 2_147_483_647);
      assert.match(String(error.details.remediation), /remove only this lock file/iu);
      return true;
    },
  );
  assert.match(await readFile(lockPath, "utf8"), /crashed-owner/u);
});

test("keeps an unverifiable lock and returns safe manual remediation", async () => {
  const fixture = await createFixture();
  const lockPath = join(fixture.root, "profile", ".agent-boost-install.lock");
  await writeFile(lockPath, "unverifiable owner\n", { mode: 0o600 });

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, []),
    }),
    (error: unknown) => {
      assert.ok(error instanceof HermesInstallError);
      assert.equal(error.code, "INSTALL_LOCKED");
      assert.equal(error.details.lockPath, lockPath);
      assert.match(String(error.details.remediation), /Verify the recorded PID/iu);
      return true;
    },
  );
  assert.equal(await readFile(lockPath, "utf8"), "unverifiable owner\n");
});

test("rejects a malformed mcp_servers section before making changes", async () => {
  const original = "mcp_servers: not-a-mapping\n";
  const fixture = await createFixture(original);
  const calls: string[][] = [];

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, calls),
    }),
    (error: unknown) =>
      error instanceof HermesInstallError && error.code === "CONFIG_INVALID",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
  assert.deepEqual(calls, [["hermes", "config", "path"]]);
});

test("rejects a malformed agent section before making changes", async () => {
  const original = "agent: not-a-mapping\n";
  const fixture = await createFixture(original);
  const calls: string[][] = [];

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, calls),
    }),
    (error: unknown) =>
      error instanceof HermesInstallError && error.code === "CONFIG_INVALID",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
  assert.deepEqual(calls, [["hermes", "config", "path"]]);
});

test("rejects a malformed tools section before making changes", async () => {
  const original = "tools: not-a-mapping\n";
  const fixture = await createFixture(original);
  const calls: string[][] = [];

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, calls),
    }),
    (error: unknown) =>
      error instanceof HermesInstallError && error.code === "CONFIG_INVALID",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
  assert.deepEqual(calls, [["hermes", "config", "path"]]);
});

test("rejects a malformed tool-search section before making changes", async () => {
  const original = "tools:\n  tool_search: invalid\n";
  const fixture = await createFixture(original);
  const calls: string[][] = [];

  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: successfulRunner(fixture.configPath, calls),
    }),
    (error: unknown) =>
      error instanceof HermesInstallError && error.code === "CONFIG_INVALID",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
  assert.deepEqual(calls, [["hermes", "config", "path"]]);
});

test("wraps a missing Hermes command as a structured installer error", async () => {
  const fixture = await createFixture();
  await assert.rejects(
    installHermesIntegration({
      executablePath: fixture.executablePath,
      runCommand: async () => {
        throw new Error("spawn ENOENT");
      },
    }),
    (error: unknown) =>
      error instanceof HermesInstallError && error.code === "COMMAND_FAILED",
  );
});

test("uses native tool names and never encodes Hermes version prefixes", () => {
  assert.deepEqual(HERMES_NATIVE_TOOLS, [
    "capabilities",
    "onboarding_start",
    "onboarding_status",
    "wallet_get_main_balance",
    "wallet_list_saved_profiles",
    "wallet_get_tree",
    "wallet_preview_private_balance_create",
    "wallet_apply_private_balance_create",
    "wallet_preview_private_balance_fund",
    "wallet_apply_private_balance_fund",
    "wallet_get_private_balance_operation",
    "wallet_get_private_balance_policy",
    "wallet_preview_private_balance_policy_update",
    "wallet_apply_private_balance_policy_update",
    "wallet_create",
    "wallet_adopt_existing",
    "wallet_preview_saved_profile_load",
    "wallet_apply_saved_profile_load",
    "wallet_archive",
    "wallet_plan_reauthorization",
    "wallet_apply_reauthorization",
    "wallet_get_policy",
    "wallet_plan_policy_update",
    "wallet_apply_policy_update",
    "wallet_start_new_demo",
    "wallet_preview_regular_transfer",
    "wallet_execute_regular_transfer",
    "wallet_get_regular_transfer_request",
    "wallet_preview_private_transfer",
    "wallet_execute_private_transfer",
    "wallet_get_private_transfer_request",
    "wallet_preview_recovery_transfer",
    "wallet_execute_recovery_transfer",
    "wallet_get_recovery_request",
    "egress_capabilities",
    "egress_status",
    "egress_fetch",
  ]);
  assert.doesNotMatch(JSON.stringify(HERMES_NATIVE_TOOLS), /mcp[_-]+agent/u);
});
