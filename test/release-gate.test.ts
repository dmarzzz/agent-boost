import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK as INSTALLER_SYSTEM_PROMPT_BLOCK,
} from "../src/hermes/index.js";

const gate = await import("../scripts/lib/release-gate.mjs") as unknown as {
  HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK: string;
  assertNoPublicLeaks(value: unknown): void;
  buildIsolatedEnvironment(
    environment: NodeJS.ProcessEnv,
    paths: Record<string, string | number>,
  ): Record<string, string>;
  parseInstallerOutput(result: {
    exitCode: number;
    stdout: string;
    stderr: string;
  }): Record<string, unknown>;
  inspectCandidate(
    sourceRoot: string,
    runCommand: (
      executable: string,
      args: string[],
      options?: Record<string, unknown>,
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  ): Promise<{ sha: string; trackedChanges: boolean }>;
  validateOnboardingResult(
    response: Record<string, unknown>,
    options?: { expectUiOpened?: boolean },
  ): {
    setupId: string;
    address: string;
    fundingUri: string;
    revision: number;
    qrSha256: string;
  };
  validateOnboardingStatus(
    response: Record<string, unknown>,
    expected: { setupId: string; address: string; fundingUri: string },
  ): void;
  validatePersistence(
    first: { setupId: string; address: string; fundingUri: string; revision: number },
    repeated: { setupId: string; address: string; fundingUri: string; revision: number },
    label?: string,
  ): void;
  verifyInstalledHermes(options: Record<string, unknown>): Promise<{
    executable: string;
    configPath: string;
    turnGateArtifact: string;
    turnGateCommand: string;
    hermesVersion: string;
    kohakuCommit: string;
  }>;
  verifyInstalledTurnGate(options: Record<string, unknown>): Promise<{
    sameTurnBlocked: boolean;
    exactContinuationAllowed: boolean;
    continuationConsumed: boolean;
    directConfirmationBlocked: boolean;
    unrelatedCallAllowed: boolean;
    bridgedDirectConfirmationBlocked: boolean;
    bridgedExactContinuationAllowed: boolean;
    bridgedContinuationConsumed: boolean;
  }>;
};

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SETUP_ID = "setup_12345678";
const FUNDING_URI = `ethereum:${ADDRESS}@11155111?value=200000000000000000`;
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const HERMES_SKILL_NAMES = [
  "agent-boost-setup",
  "agent-boost",
  "agent-boost-wallet-tree",
  "agent-boost-wallets",
  "agent-boost-policy",
  "agent-boost-transfers",
  "agent-boost-wallet-actions",
  "agent-boost-authorize",
  "agent-boost-confirm",
  "agent-boost-covered-web",
] as const;

test("release verification uses the installer's exact managed routing prompt", () => {
  assert.equal(
    gate.HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK,
    INSTALLER_SYSTEM_PROMPT_BLOCK,
  );
});

test("release gate reports staged tracked changes", async () => {
  const calls: string[][] = [];
  const inspected = await gate.inspectCandidate("/candidate", async (_command, args) => {
    calls.push(args);
    return args.includes("rev-parse")
      ? { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "" };
  });
  assert.equal(inspected.trackedChanges, true);
  assert.deepEqual(calls[1], ["-C", "/candidate", "diff", "--quiet", "HEAD", "--"]);
});

function delegation(): Record<string, unknown> {
  return {
    mode: "testnet_delegated",
    chainId: 11_155_111,
    perPaymentLimitWei: "50000000000000000",
    lifetimeLimitWei: "50000000000000000",
    spentWei: "0",
    expiresAt: "2026-09-02T00:00:00.000Z",
    enabled: true,
  };
}

function setup(revision = 3): Record<string, unknown> {
  return {
    version: 1,
    setupId: SETUP_ID,
    revision,
    phase: "awaiting_funding",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z",
    address: ADDRESS,
    publicBalanceWei: "0",
    privateBalanceWei: "0",
    requiredFundingWei: "200000000000000000",
    shieldAmountWei: "100000000000000000",
    delegation: delegation(),
  };
}

function publicSnapshot(revision = 3): Record<string, unknown> {
  const value = setup(revision);
  delete value.version;
  delete value.createdAt;
  delete value.updatedAt;
  value.rpcRoute = {
    mode: "tor",
    scope: "ethereum_json_rpc",
    status: "ready",
    directFallback: false,
  };
  return value;
}

function funding(qrAttached: boolean): Record<string, unknown> {
  return {
    chain_id: "eip155:11155111",
    network: "Sepolia",
    asset: "Sepolia ETH",
    address: ADDRESS,
    funding_uri: FUNDING_URI,
    remaining_amount_wei: "200000000000000000",
    remaining_amount_eth: "0.2",
    qr_attached: qrAttached,
  };
}

function envelope(data: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "org.agentboost.tool-result",
    schema_version: "1.0",
    manifest_digest: `sha256:${"a".repeat(64)}`,
    outcome: "awaiting_funding",
    code: "ONBOARDING_STARTED",
    presentation: {
      version: "1.0",
      kind: "progress",
      title: "Fund your test wallet",
      state: "active",
      step: { current: 1, total: 3, label: "Fund test wallet" },
      fields: [
        { label: "Amount", value: "0.2 Sepolia ETH", format: "amount" },
        { label: "Address", value: ADDRESS, format: "address" },
      ],
      notice: { tone: "warning", text: "Testnet only." },
      next_action: "Send the test funds, then reply ✅ or say sent.",
    },
    retry: { mode: "wait", safe_with_same_arguments: true, after_ms: 2000 },
    data,
  };
}

function startResponse(revision = 3): Record<string, unknown> {
  const structuredContent = envelope({
    setup: setup(revision),
    public: publicSnapshot(revision),
    funding: funding(true),
    ui_opened: false,
  });
  return {
    structuredContent,
    content: [
      { type: "text", text: JSON.stringify(structuredContent) },
      { type: "image", data: PNG, mimeType: "image/png" },
    ],
  };
}

test("release gate accepts the exact public funding projection and PNG", () => {
  const snapshot = gate.validateOnboardingResult(startResponse(), {
    expectUiOpened: false,
  });
  assert.equal(snapshot.setupId, SETUP_ID);
  assert.equal(snapshot.address, ADDRESS);
  assert.equal(snapshot.fundingUri, FUNDING_URI);
  assert.equal(snapshot.revision, 3);
  assert.match(snapshot.qrSha256, /^[0-9a-f]{64}$/u);

  const status = envelope({ setup: setup(4), funding: funding(false) });
  status.code = "ONBOARDING_STATUS";
  gate.validateOnboardingStatus(
    { structuredContent: status, content: [{ type: "text", text: JSON.stringify(status) }] },
    snapshot,
  );
});

test("release gate rejects localhost, local paths, and schema expansion", () => {
  const localhost = startResponse();
  ((localhost.structuredContent as { data: { setup: Record<string, unknown> } }).data.setup)
    .uiUrl = "http://127.0.0.1:9183";
  assert.throws(
    () => gate.validateOnboardingResult(localhost),
    /unexpected public fields|loopback host/u,
  );

  assert.throws(
    () => gate.assertNoPublicLeaks({ message: "read /Users/demo/.wallet/state.json" }),
    /local filesystem path/u,
  );

  const expanded = startResponse();
  ((expanded.structuredContent as { data: { funding: Record<string, unknown> } }).data.funding)
    .debug = "not public";
  assert.throws(() => gate.validateOnboardingResult(expanded), /keys changed/u);
});

test("release gate requires retries and restarts to preserve the wallet", () => {
  const first = gate.validateOnboardingResult(startResponse(3));
  const repeated = gate.validateOnboardingResult(startResponse(5));
  gate.validatePersistence(first, repeated);
  assert.throws(
    () => gate.validatePersistence(first, { ...repeated, address: `0x${"2".repeat(40)}` }),
    /replaced the durable onboarding wallet/u,
  );
  assert.throws(
    () => gate.validatePersistence(first, { ...repeated, revision: 2 }),
    /revision backwards/u,
  );
});

test("isolated environment scrubs inherited Agent Boost and Node overrides", () => {
  const environment = gate.buildIsolatedEnvironment(
    {
      PATH: "/usr/bin",
      NODE_OPTIONS: "--require /tmp/injected.js",
      HERMES_HOME: "/home/user/.hermes",
      AGENT_BOOST_RPC_URL: "https://credential.invalid/token",
      SAFE_VALUE: "preserved",
    },
    {
      commandBin: "/gate/commands",
      prefix: "/gate/prefix",
      prefixBin: "/gate/prefix/bin",
      hermesHome: "/gate/hermes",
      kohakuInstallDir: "/gate/dependencies/kohaku-cli",
      shadeTreeInstallDir: "/gate/dependencies/shade-tree",
      stateDir: "/gate/state",
      torDataDir: "/gate/state/tor",
      kohakuDataDir: "/gate/state/kohaku",
      passwordFile: "/gate/state/secrets/kohaku-password",
      uiPort: 19001,
      torRpcPort: 19002,
      shadeTreeProxyPort: 19003,
    },
  );
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.AGENT_BOOST_RPC_URL, undefined);
  assert.equal(environment.HERMES_HOME, "/gate/hermes");
  assert.equal(environment.SAFE_VALUE, "preserved");
  assert.match(environment.PATH ?? "", /^\/gate\/commands/u);
});

test("release gate verifies isolated Hermes config and exact packaged skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-release-verify-"));
  const candidateRoot = join(root, "candidate");
  const hermesHome = join(root, "hermes");
  const executable = join(root, "prefix", "lib", "agent-boost", "dist", "cli.js");
  const installedTurnGate = join(
    root,
    "prefix",
    "lib",
    "agent-boost",
    "dist",
    "hermes",
    "turn-gate.js",
  );
  const candidateTurnGate = join(candidateRoot, "dist", "hermes", "turn-gate.js");
  const configPath = join(hermesHome, "config.yaml");
  const allowlistPath = join(hermesHome, "shell-hooks-allowlist.json");
  const outputGuardPath = join(hermesHome, "plugins", "agent-boost-output-guard");
  for (const name of HERMES_SKILL_NAMES) {
    await mkdir(join(candidateRoot, "integrations", "hermes", name), { recursive: true });
    await mkdir(join(hermesHome, "skills", name), { recursive: true });
  }
  await mkdir(join(root, "prefix", "lib", "agent-boost", "dist", "hermes"), {
    recursive: true,
  });
  await mkdir(join(candidateRoot, "dist", "hermes"), { recursive: true });
  await mkdir(join(candidateRoot, "integrations", "hermes", "agent-boost-output-guard"), { recursive: true });
  await mkdir(outputGuardPath, { recursive: true });
  await writeFile(executable, "#!/usr/bin/env node\n", { mode: 0o755 });
  await writeFile(installedTurnGate, "export const packagedTurnGate = true;\n");
  await writeFile(candidateTurnGate, "export const packagedTurnGate = true;\n");
  await chmod(executable, 0o755);
  for (const [name, content] of [
    ["__init__.py", "def register(ctx):\n    pass\n"],
    ["plugin.yaml", "name: agent-boost-output-guard\nversion: '1.0.0'\n"],
  ] as const) {
    await writeFile(join(candidateRoot, "integrations", "hermes", "agent-boost-output-guard", name), content);
    await writeFile(join(outputGuardPath, name), content);
  }
  const turnGateCommand = `${await realpath(executable)} hermes-turn-gate`;
  for (const name of HERMES_SKILL_NAMES) {
    const content = `---\nname: ${name}\n---\n`;
    await writeFile(join(candidateRoot, "integrations", "hermes", name, "SKILL.md"), content);
    await writeFile(join(hermesHome, "skills", name, "SKILL.md"), content);
  }
  await writeFile(
    configPath,
    [
      "agent:",
      "  tool_use_enforcement: true",
      "  execution_guidance: false",
      "  task_completion_guidance: false",
      "  parallel_tool_call_guidance: false",
      "  system_prompt: |-",
      ...gate.HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK
        .split("\n")
        .map((line) => `    ${line}`),
      "mcp_discovery_timeout: 60",
      "mcp_single_query_discovery_timeout: 60",
      "hooks_auto_accept: false",
      "display:",
      "  busy_input_mode: queue",
      "plugins:",
      "  enabled: [agent-boost-output-guard]",
      "  entries:",
      "    agent-boost-output-guard:",
      "      settings:",
      `        turn_gate_executable: ${await realpath(executable)}`,
      "hooks:",
      "  pre_tool_call:",
      "    - matcher: .*",
      `      command: ${turnGateCommand}`,
      "      timeout: 5",
      "      fail_closed: true",
      "  post_tool_call:",
      "    - matcher: (?:mcp__agent_boost__.*|tool_call)",
      `      command: ${turnGateCommand}`,
      "      timeout: 5",
      "mcp_servers:",
      "  agent-boost:",
      `    command: ${executable}`,
      "    args: [mcp, --mode, dark, --contract-major, '1']",
      "    enabled: true",
      "    timeout: 360",
      "    supports_parallel_tool_calls: false",
      "    tools:",
      "      include:",
      "        - capabilities",
      "        - onboarding_start",
      "        - onboarding_status",
      "        - wallet_get_main_balance",
      "        - wallet_list_saved_profiles",
      "        - wallet_get_tree",
      "        - wallet_preview_private_balance_create",
      "        - wallet_apply_private_balance_create",
      "        - wallet_preview_private_balance_fund",
      "        - wallet_apply_private_balance_fund",
      "        - wallet_get_private_balance_operation",
      "        - wallet_get_private_balance_policy",
      "        - wallet_preview_private_balance_policy_update",
      "        - wallet_apply_private_balance_policy_update",
      "        - wallet_create",
      "        - wallet_adopt_existing",
      "        - wallet_preview_saved_profile_load",
      "        - wallet_apply_saved_profile_load",
      "        - wallet_archive",
      "        - wallet_plan_reauthorization",
      "        - wallet_apply_reauthorization",
      "        - wallet_get_policy",
      "        - wallet_plan_policy_update",
      "        - wallet_apply_policy_update",
      "        - wallet_start_new_demo",
      "        - wallet_preview_regular_transfer",
      "        - wallet_execute_regular_transfer",
      "        - wallet_get_regular_transfer_request",
      "        - wallet_preview_private_transfer",
      "        - wallet_execute_private_transfer",
      "        - wallet_get_private_transfer_request",
      "        - wallet_preview_recovery_transfer",
      "        - wallet_execute_recovery_transfer",
      "        - wallet_get_recovery_request",
      "        - egress_capabilities",
      "        - egress_status",
      "        - egress_fetch",
      "      resources: false",
      "      prompts: false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(
    allowlistPath,
    `${JSON.stringify({
      approvals: [
        { event: "pre_tool_call", command: turnGateCommand },
        { event: "post_tool_call", command: turnGateCommand },
      ],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const installed = await gate.verifyInstalledHermes({
    sandboxRoot: root,
    hermesHome,
    candidateRoot,
    installResult: {
      installed: true,
      agent_boost: { executable },
      kohaku: { commit: "fcf9defa4d5ff7f63222f1b3bbe2d30e631ceffd" },
      shade_tree: {
        version: "0.4.0",
        available: false,
        status: "unsupported",
      },
      hermes: {
        status: "configured",
        hermes_version: "Hermes 0.16.0\nProject: /private/local/hermes-checkout",
        result: {
          installed: true,
          config_path: configPath,
          config_changed: true,
          turn_gate: {
            command: turnGateCommand,
            allowlist_path: allowlistPath,
            allowlist_changed: true,
          },
          output_guard: {
            plugin_path: outputGuardPath,
            changed: true,
            backup_paths: [],
            validated: true,
          },
          skills: HERMES_SKILL_NAMES.map((name) => ({
            name,
            changed: true,
            path: join(hermesHome, "skills", name, "SKILL.md"),
          })),
        },
      },
    },
  });
  assert.equal(installed.executable, await realpath(executable));
  assert.equal(installed.turnGateArtifact, await realpath(installedTurnGate));
  assert.equal(installed.turnGateCommand, turnGateCommand);
  assert.equal(installed.hermesVersion, "Hermes 0.16.0");
  assert.equal(await readFile(configPath, "utf8").then((value) => value.includes(executable)), true);
});

test("release gate drives the installed turn gate through stdin across safety flows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-release-turn-gate-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const result = await gate.verifyInstalledTurnGate({
    executable: process.execPath,
    commandArgs: [
      "--import",
      "tsx",
      join(process.cwd(), "src", "cli.ts"),
      "hermes-turn-gate",
    ],
    environment: {
      ...process.env,
      HERMES_HOME: join(root, "hermes"),
    },
    stateDirectory: join(root, "state"),
  });
  assert.deepEqual(result, {
    sameTurnBlocked: true,
    exactContinuationAllowed: true,
    continuationConsumed: true,
    directConfirmationBlocked: true,
    unrelatedCallAllowed: true,
    bridgedDirectConfirmationBlocked: true,
    bridgedExactContinuationAllowed: true,
    bridgedContinuationConsumed: true,
  });
});

test("release gate refuses failed or non-JSON installer output", () => {
  assert.deepEqual(
    gate.parseInstallerOutput({
      exitCode: 0,
      stdout: 'node scripts/install.mjs\n{"installed":true}\n',
      stderr: "",
    }),
    { installed: true },
  );
  assert.throws(
    () => gate.parseInstallerOutput({ exitCode: 1, stdout: "", stderr: "build failed" }),
    /build failed/u,
  );
  assert.throws(
    () => gate.parseInstallerOutput({ exitCode: 0, stdout: "not-json", stderr: "" }),
    /JSON report/u,
  );
});
