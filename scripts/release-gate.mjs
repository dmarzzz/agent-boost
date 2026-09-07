#!/usr/bin/env node

import { createServer } from "node:net";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  assertNoPublicLeaks,
  buildIsolatedEnvironment,
  copyTrackedCandidate,
  inspectCandidate,
  installHermesCommand,
  parseInstallerOutput,
  spawnCapture,
  validateOnboardingResult,
  validateOnboardingStatus,
  validatePersistence,
  verifyInstalledHermes,
  verifyInstalledTurnGate,
  verifySensitivePermissions,
  AGENT_BOOST_MCP_TOOL_COUNT,
  HERMES_NATIVE_TOOLS,
} from "./lib/release-gate.mjs";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_TIMEOUT_MS = 60 * 60_000;
const TOOL_TIMEOUT_MS = 10 * 60_000;

function usage() {
  return `Agent Boost clean-install release gate

Usage:
  node scripts/release-gate.mjs --hermes /absolute/path/to/hermes [options]

Options:
  --candidate PATH   Git worktree to package (default: repository root)
  --hermes PATH      Absolute Hermes executable used for isolated integration
  --report PATH      Write the public-safe JSON report to this path
  --keep             Preserve the temporary sandbox after a successful run
  --help             Show this help

The gate uses a clean copy of tracked candidate files, isolated Agent Boost and
Hermes state, real pinned Kohaku installation, and an unfunded Sepolia wallet.
It never broadcasts a transaction. A separate live Matrix smoke is still
required to prove homeserver media upload and Element X rendering.`;
}

async function main() {
  let sandboxRoot;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const candidateSource = resolve(options.candidate ?? scriptRoot);
    const hermesExecutable = resolveHermes(options.hermes);
    sandboxRoot = await mkdtemp(join(tmpdir(), "agent-boost-release-gate-"));
    await chmod(sandboxRoot, 0o700);
    const report = await runReleaseGate({
      candidateSource,
      hermesExecutable,
      sandboxRoot,
    });
    if (options.report) await writeReport(resolve(options.report), report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (options.keep) {
      process.stderr.write(`Release-gate sandbox preserved at ${sandboxRoot}\n`);
    } else {
      await removeSandbox(sandboxRoot);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`agent-boost release gate: ${detail}\n`);
    if (sandboxRoot) {
      process.stderr.write(
        `Isolated failure state was preserved locally with mode 0700 at ${sandboxRoot}\n`,
      );
    }
    process.exitCode = 1;
  }
}

export async function runReleaseGate(options) {
  const candidate = await inspectCandidate(options.candidateSource);
  const candidateRoot = join(options.sandboxRoot, "candidate");
  const prefix = join(options.sandboxRoot, "prefix");
  const paths = {
    commandBin: join(options.sandboxRoot, "command-bin"),
    prefix,
    prefixBin: join(prefix, "bin"),
    hermesHome: join(options.sandboxRoot, "hermes"),
    kohakuInstallDir: join(options.sandboxRoot, "dependencies", "kohaku-cli"),
    shadeTreeInstallDir: join(options.sandboxRoot, "dependencies", "shade-tree"),
    stateDir: join(options.sandboxRoot, "state"),
    torDataDir: join(options.sandboxRoot, "state", "tor"),
    kohakuDataDir: join(options.sandboxRoot, "state", "kohaku"),
    passwordFile: join(options.sandboxRoot, "state", "secrets", "kohaku-password"),
    uiPort: await reserveLoopbackPort(),
    torRpcPort: await reserveLoopbackPort(),
    shadeTreeProxyPort: await reserveLoopbackPort(),
  };
  if (paths.uiPort === paths.torRpcPort) paths.torRpcPort = await reserveLoopbackPort();
  while (
    paths.shadeTreeProxyPort === paths.uiPort ||
    paths.shadeTreeProxyPort === paths.torRpcPort
  ) {
    paths.shadeTreeProxyPort = await reserveLoopbackPort();
  }

  await mkdir(candidateRoot, { recursive: true, mode: 0o700 });
  const copiedFiles = await copyTrackedCandidate(options.candidateSource, candidateRoot);
  await installHermesCommand(paths.commandBin, options.hermesExecutable);
  const environment = buildIsolatedEnvironment(process.env, paths);

  const installed = parseInstallerOutput(
    await spawnCapture("make", ["install"], {
      cwd: candidateRoot,
      env: environment,
      timeoutMs: INSTALL_TIMEOUT_MS,
    }),
  );
  const verifiedInstall = await verifyInstalledHermes({
    installResult: installed,
    sandboxRoot: options.sandboxRoot,
    hermesHome: paths.hermesHome,
    candidateRoot,
  });
  const turnGateSmoke = await verifyInstalledTurnGate({
    executable: verifiedInstall.executable,
    environment,
    stateDirectory: join(options.sandboxRoot, "turn-gate-smoke"),
  });

  const capabilitiesAndFirst = await withMcp(
    verifiedInstall.executable,
    environment,
    async (client, transport) => {
      const listed = await client.listTools();
      const toolNames = listed.tools.map((tool) => tool.name);
      if (
        toolNames.length !== AGENT_BOOST_MCP_TOOL_COUNT ||
        new Set(toolNames).size !== AGENT_BOOST_MCP_TOOL_COUNT
      ) {
        throw new Error(
          `Installed MCP exposed ${toolNames.length} tools (${new Set(toolNames).size} unique), expected ${AGENT_BOOST_MCP_TOOL_COUNT}`,
        );
      }
      const missingCanonicalTools = HERMES_NATIVE_TOOLS.filter(
        (name) => !toolNames.includes(name),
      );
      if (missingCanonicalTools.length > 0) {
        throw new Error(
          `Installed MCP is missing canonical Hermes tools: ${missingCanonicalTools.join(", ")}`,
        );
      }

      const capabilities = await callTool(client, "capabilities", {});
      assertNoPublicLeaks(capabilities);
      const capabilitiesData = capabilities?.structuredContent?.data;
      if (capabilitiesData?.chain_id !== "eip155:11155111") {
        throw new Error("Installed MCP server did not report Sepolia capabilities");
      }
      if (capabilitiesData?.privacy?.rpc_egress?.direct_fallback !== false) {
        throw new Error("Installed MCP server did not fail closed for RPC egress");
      }

      const firstResult = await callTool(client, "onboarding_start", {});
      const first = validateOnboardingResult(firstResult, { expectUiOpened: false });
      const repeatedResult = await callTool(client, "onboarding_start", {});
      const repeated = validateOnboardingResult(repeatedResult, { expectUiOpened: false });
      validatePersistence(first, repeated, "repeated onboarding_start");

      const policyBefore = await callTool(client, "wallet_get_policy", {});
      expectToolCode(policyBefore, "WALLET_POLICY", "wallet_get_policy before cancellation");
      const policyPlan = await callTool(client, "wallet_plan_policy_update", {
        max_payments: 2,
        per_payment_limit_native: "0.01",
        lifetime_limit_native: "0.02",
        expires_in_hours: 1,
        enabled: true,
      });
      expectToolCode(policyPlan, "POLICY_UPDATE_PLANNED", "canonical policy planner");
      const decisionId = policyPlan?.structuredContent?.data?.plan?.decisionId;
      if (typeof decisionId !== "string" || !decisionId.startsWith("wpd_")) {
        throw new Error("Canonical policy planner did not return its internal decision ID");
      }
      const cancelledPolicy = await callTool(client, "wallet_apply_policy_update", {
        decision_id: decisionId,
        user_confirmed: false,
      });
      expectToolCode(cancelledPolicy, "POLICY_UPDATE_CANCELLED", "policy cancellation");
      const policyAfter = await callTool(client, "wallet_get_policy", {});
      expectToolCode(policyAfter, "WALLET_POLICY", "wallet_get_policy after cancellation");
      if (
        JSON.stringify(policyBefore?.structuredContent?.data?.policy) !==
        JSON.stringify(policyAfter?.structuredContent?.data?.policy)
      ) {
        throw new Error("Cancelling the installed policy preview changed active permission");
      }

      const pid = transport.pid;
      if (!pid) throw new Error("MCP transport did not expose its child process ID");
      process.kill(pid, "SIGKILL");
      await waitForProcessExit(pid, 10_000);
      return {
        first,
        repeated,
        toolSurface: { total: toolNames.length, canonical: HERMES_NATIVE_TOOLS.length },
        policyPreviewCancelled: true,
      };
    },
    { crashOnReturn: true },
  );

  const restarted = await withMcp(
    verifiedInstall.executable,
    environment,
    async (client) => {
      const restartedResult = await callTool(client, "onboarding_start", {});
      const snapshot = validateOnboardingResult(restartedResult, { expectUiOpened: false });
      validatePersistence(capabilitiesAndFirst.first, snapshot, "MCP process restart");
      const status = await callTool(client, "onboarding_status", {
        setup_id: snapshot.setupId,
        since_revision: 0,
        wait_ms: 0,
      });
      validateOnboardingStatus(status, snapshot);
      return snapshot;
    },
  );

  await verifySensitivePermissions(paths);
  const report = {
    schema: "org.agentboost.release-gate",
    schema_version: "1.0",
    passed: true,
    candidate: {
      sha: candidate.sha,
      tracked_changes: candidate.trackedChanges,
      tracked_files: copiedFiles.length,
    },
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
    },
    installation: {
      agent_boost_version: installed.agent_boost?.version,
      kohaku_commit: verifiedInstall.kohakuCommit,
      hermes_version: verifiedInstall.hermesVersion,
      isolated_config_and_skills: true,
      packaged_turn_gate_verified: true,
      turn_gate_hooks_verified: true,
      mcp_tools_total: capabilitiesAndFirst.toolSurface.total,
      hermes_canonical_tools: capabilitiesAndFirst.toolSurface.canonical,
    },
    onboarding: {
      setup_id: restarted.setupId,
      address: restarted.address,
      funding_uri: restarted.fundingUri,
      remaining_amount_eth: "0.2",
      remaining_amount_wei: "200000000000000000",
      qr_sha256: restarted.qrSha256,
      repeated_start_preserved_wallet: true,
      process_restart_preserved_wallet: true,
      loopback_url_exposed: false,
    },
    safe_tool_flows: {
      policy_preview_cancelled: capabilitiesAndFirst.policyPreviewCancelled,
      active_policy_unchanged: capabilitiesAndFirst.policyPreviewCancelled,
      turn_gate_same_turn_blocked: turnGateSmoke.sameTurnBlocked,
      turn_gate_exact_continuation_allowed: turnGateSmoke.exactContinuationAllowed,
      turn_gate_continuation_consumed: turnGateSmoke.continuationConsumed,
      turn_gate_direct_confirmation_blocked: turnGateSmoke.directConfirmationBlocked,
      turn_gate_unrelated_call_allowed: turnGateSmoke.unrelatedCallAllowed,
      turn_gate_bridged_direct_confirmation_blocked:
        turnGateSmoke.bridgedDirectConfirmationBlocked,
      turn_gate_bridged_exact_continuation_allowed:
        turnGateSmoke.bridgedExactContinuationAllowed,
      turn_gate_bridged_continuation_consumed:
        turnGateSmoke.bridgedContinuationConsumed,
    },
    checks: [
      "candidate_packaged_and_installed",
      "pinned_kohaku_verified",
      "hermes_config_and_skills_verified",
      "packaged_turn_gate_verified",
      "installed_turn_gate_hooks_and_allowlist_verified",
      "installed_turn_gate_multi_flow_smoke_verified",
      "installed_mcp_54_tool_surface_verified",
      "canonical_policy_plan_cancel_status_verified",
      "exact_funding_projection_verified",
      "png_qr_attachment_verified",
      "wallet_persistence_verified",
      "public_output_leak_denylist_verified",
      "private_state_permissions_verified",
    ],
    live_matrix_smoke_required: true,
  };
  assertNoPublicLeaks(report);
  return report;
}

async function withMcp(executable, environment, operation, options = {}) {
  const transport = new StdioClientTransport({
    command: executable,
    args: ["mcp", "--mode", "dark", "--contract-major", "1"],
    env: environment,
    stderr: "pipe",
    maxBufferSize: 16 * 1024 * 1024,
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => {
    if (Buffer.concat(stderr).byteLength < 64 * 1024) stderr.push(Buffer.from(chunk));
  });
  const client = new Client({ name: "agent-boost-release-gate", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await operation(client, transport);
  } catch (error) {
    const detail = Buffer.concat(stderr).toString("utf8").trim();
    if (detail && error instanceof Error) {
      throw new Error(`${error.message}; MCP stderr: ${detail.slice(0, 1_000)}`);
    }
    throw error;
  } finally {
    await client.close().catch(() => undefined);
    if (!options.crashOnReturn) await transport.close().catch(() => undefined);
  }
}

function callTool(client, name, args) {
  return client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: TOOL_TIMEOUT_MS, maxTotalTimeout: TOOL_TIMEOUT_MS },
  );
}

function expectToolCode(response, expected, label) {
  const code = response?.structuredContent?.code;
  if (response?.isError === true || code !== expected) {
    throw new Error(`${label} returned ${String(code)}, expected ${expected}`);
  }
}

function parseArguments(args) {
  const options = { keep: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--candidate" || arg === "--hermes" || arg === "--report") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown release-gate option: ${arg}`);
    }
  }
  if (!options.help && !options.hermes) {
    throw new Error("--hermes with an absolute Hermes executable path is required");
  }
  return options;
}

function resolveHermes(value) {
  if (!value) return "";
  if (!isAbsolute(value)) throw new Error("--hermes must be an absolute path");
  return resolve(value);
}

async function reserveLoopbackPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectPromise(new Error("Could not reserve a loopback port")));
        return;
      }
      server.close((error) => error ? rejectPromise(error) : resolvePromise(address.port));
    });
  });
}

async function waitForProcessExit(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Crashed MCP process did not exit promptly");
}

async function writeReport(path, report) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function removeSandbox(path) {
  const resolved = resolve(path);
  const expectedParent = resolve(tmpdir());
  if (
    dirname(resolved) !== expectedParent ||
    !basename(resolved).startsWith("agent-boost-release-gate-")
  ) {
    throw new Error("Refusing to remove an unrecognized release-gate directory");
  }
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) throw new Error("Release-gate sandbox is not a directory");
  await rm(resolved, { recursive: true, force: false });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
