import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  assert.ok(result.configBackupPath);
  assert.equal(
    await readFile(result.configBackupPath, "utf8"),
    "# keep this backup exact\nmodel:\n  default: test\n",
  );

  const config = parse(await readFile(fixture.configPath, "utf8")) as {
    mcp_servers: Record<string, unknown>;
  };
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
  assert.match(setupSkill, /immediately present the QR image/u);
  assert.match(setupSkill, /copy that\s+exact tag onto a standalone line/u);
  assert.match(setupSkill, /regardless of `ui_opened`/u);
  assert.match(setupSkill, /`remaining_amount_eth`/u);
  assert.match(setupSkill, /`remaining_amount_wei`/u);
  assert.match(setupSkill, /`funding_uri`/u);
  assert.match(setupSkill, /`setup_id`/u);
  assert.match(setupSkill, /`since_revision`/u);
  assert.match(setupSkill, /`wait_ms: 90000`/u);
  assert.doesNotMatch(setupSkill, /offer (?:the )?loopback|normally 0\.2/u);
  assert.match(setupSkill, /\/reload-skills.*\/reload-mcp/su);
  assert.match(operationalSkill, /testnet_delegated/u);
  assert.match(operationalSkill, /wallet_plan_private_payment/u);
  assert.match(operationalSkill, /`hermes:<decision_id>`/u);
  assert.match(operationalSkill, /`user_confirmed: true`/u);
  assert.doesNotMatch(
    operationalSkill,
    /mcp_agent_boost_|mcp__agent_boost__/u,
  );
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
    "wallet_plan_private_payment",
    "wallet_execute_private_payment",
    "wallet_get_request",
  ]);
  assert.doesNotMatch(JSON.stringify(HERMES_NATIVE_TOOLS), /mcp[_-]+agent/u);
});
