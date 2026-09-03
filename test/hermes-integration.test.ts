import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import {
  HERMES_NATIVE_TOOLS,
  HermesInstallError,
  createHermesServerConfig,
  installHermesIntegration,
  type CommandResult,
} from "../src/hermes/index.js";

interface Fixture {
  root: string;
  configPath: string;
  executablePath: string;
}

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
    if (args.join(" ") === "mcp test agent-boost") {
      return { exitCode: 0, stdout: "connected\n", stderr: "" };
    }
    return { exitCode: 99, stdout: "", stderr: "unexpected command" };
  };
}

test("installs a conflict-safe Hermes integration and both skills", async () => {
  const fixture = await createFixture("# keep this backup exact\nmodel:\n  default: test\n");
  const calls: string[][] = [];
  const result = await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, calls),
    now: () => new Date("2026-09-01T12:34:56.000Z"),
  });

  assert.deepEqual(calls, [
    ["hermes", "config", "path"],
    ["hermes", "mcp", "test", "agent-boost"],
  ]);
  assert.equal(result.configChanged, true);
  assert.equal(result.restartRequired, true);
  assert.match(result.recommendation, /did not restart Hermes/u);
  assert.match(result.recommendation, /\/reload-skills.*\/reload-mcp/u);
  assert.match(result.recommendation, /\/new.*!new/u);
  assert.ok(result.configBackupPath);
  assert.equal(
    await readFile(result.configBackupPath, "utf8"),
    "# keep this backup exact\nmodel:\n  default: test\n",
  );

  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    agent: { tool_use_enforcement: boolean };
    mcp_servers: Record<string, unknown>;
  };
  assert.equal(config.agent.tool_use_enforcement, true);
  assert.deepEqual(
    config.mcp_servers["agent-boost"],
    createHermesServerConfig(result.executablePath),
  );
  assert.equal(
    (config.mcp_servers["agent-boost"] as { timeout: number }).timeout,
    180,
  );

  const setupSkill = await readFile(
    join(fixture.root, "profile", "skills", "agent-boost-setup", "SKILL.md"),
    "utf8",
  );
  const operationalSkill = await readFile(
    join(fixture.root, "profile", "skills", "agent-boost", "SKILL.md"),
    "utf8",
  );
  const setupMetadata = skillFrontmatter(setupSkill);
  const operationalMetadata = skillFrontmatter(operationalSkill);
  const setupDescription = String(setupMetadata.description);
  const operationalDescription = String(operationalMetadata.description);
  assert.ok(setupDescription.length <= 60);
  assert.ok(operationalDescription.length <= 60);
  assert.match(setupDescription, /\.$/u);
  assert.match(operationalDescription, /\.$/u);
  assert.doesNotMatch(setupSkill, /requires_toolsets/u);
  assert.deepEqual(
    (
      (operationalMetadata.metadata as { hermes: Record<string, unknown> })
        .hermes.requires_toolsets
    ),
    ["mcp-agent-boost"],
  );
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
  assert.match(setupSkill, /`private_ready` goes directly to completion verification/u);
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
  assert.match(setupSkill, /exact tool-returned `data\.rendered` tree/u);
  assert.match(operationalSkill, /testnet_delegated/u);
  assert.match(operationalSkill, /wallet_plan_private_payment/u);
  assert.match(operationalSkill, /`user_confirmed: true`/u);
  assert.match(operationalSkill, /agent operates every tool/iu);
  assert.match(operationalSkill, /Never ask the user to type a tool name/iu);
  assert.match(operationalSkill, /wallet tree is a live view/iu);
  assert.match(
    operationalSkill,
    /tree rule wins[\s\S]*Never call `wallet_get_context` first/iu,
  );
  assert.match(operationalSkill, /shortened address[\s\S]*aggregate total/iu);
  assert.match(
    operationalSkill,
    /tool_search[\s\S]*tool_describe[\s\S]*tool_call[\s\S]*loaded path/u,
  );
  assert.match(
    operationalSkill,
    /never tell the user to reload[\s\S]*contact an operator/iu,
  );
  assert.match(operationalSkill, /Every single-account balance is a live read/u);
  assert.match(
    operationalSkill,
    /history, memory, onboarding status, and prior[\s\S]*never balance\s+sources/iu,
  );
  assert.match(operationalSkill, /never convert `balance_atomic` or wei/u);
  assert.match(
    operationalSkill,
    /Do not mention the\s+address unless the user asks/u,
  );
  assert.match(operationalSkill, /first gate[\s\S]*never blocks/iu);
  assert.match(operationalSkill, /`yes`[\s\S]*`send it`[\s\S]*`✅`/u);
  assert.match(operationalSkill, /Never claim an unresolved payment succeeded from a balance change/u);
  assert.match(operationalSkill, /does not make the[\s\S]*address disappear/u);
  assert.match(operationalSkill, /Never offer to reveal[\s\S]*private key/u);
  assert.doesNotMatch(
    operationalSkill,
    /mcp_agent_boost_|mcp__agent_boost__/u,
  );
});

test("preserves an advanced user's explicit tool-use setting", async () => {
  const fixture = await createFixture(
    "agent:\n  tool_use_enforcement: false\nmodel:\n  default: test\n",
  );
  const calls: string[][] = [];

  await installHermesIntegration({
    executablePath: fixture.executablePath,
    runCommand: successfulRunner(fixture.configPath, calls),
  });

  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    agent: { tool_use_enforcement: boolean };
  };
  assert.equal(config.agent.tool_use_enforcement, false);
});

test("checked-in Hermes YAML stays identical to the generated config", async () => {
  const examplePath = new URL(
    "../integrations/hermes/mcp-config.yaml",
    import.meta.url,
  );
  const example = parse(await readFile(examplePath, "utf8")) as {
    mcp_servers: Record<string, unknown>;
  };
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
  assert.deepEqual(
    result.skills.map((skill) => skill.changed),
    [false, false],
  );
  assert.deepEqual(directoryAfter.sort(), directoryBefore.sort());
  assert.deepEqual(secondCalls, [
    ["hermes", "config", "path"],
    ["hermes", "mcp", "test", "agent-boost"],
  ]);
});

test("upgrades a prior Agent Boost tool subset without weakening conflict safety", async () => {
  const fixture = await createFixture();
  const previous = createHermesServerConfig(
    await realpath(fixture.executablePath),
  ) as {
    tools: { include: string[] };
  };
  previous.tools.include = previous.tools.include.filter(
    (tool) => ![
      "wallet_get_policy",
      "wallet_plan_policy_update",
      "wallet_apply_policy_update",
    ].includes(tool),
  );
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
  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    mcp_servers: Record<string, unknown>;
  };
  assert.deepEqual(
    config.mcp_servers["agent-boost"],
    createHermesServerConfig(result.executablePath),
  );
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

test("reports MCP validation failure without restarting Hermes", async () => {
  const fixture = await createFixture();
  const calls: string[][] = [];
  const runner = async (
    command: string,
    args: readonly string[],
  ): Promise<CommandResult> => {
    calls.push([command, ...args]);
    if (args.join(" ") === "config path") {
      return { exitCode: 0, stdout: `Config path: ${fixture.configPath}\n`, stderr: "" };
    }
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
      return true;
    },
  );
  assert.deepEqual(calls, [
    ["hermes", "config", "path"],
    ["hermes", "mcp", "test", "agent-boost"],
  ]);
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
    "wallet_get_context",
    "wallet_get_tree",
    "wallet_get_policy",
    "wallet_plan_policy_update",
    "wallet_apply_policy_update",
    "wallet_start_new_demo",
    "wallet_plan_private_payment",
    "wallet_execute_private_payment",
    "wallet_get_request",
    "egress_capabilities",
    "egress_status",
    "egress_fetch",
  ]);
  assert.doesNotMatch(JSON.stringify(HERMES_NATIVE_TOOLS), /mcp[_-]+agent/u);
});
