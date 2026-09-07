#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";

import type { HermesInstallError } from "./hermes/index.js";
import type { LocalAgentBoostRuntime } from "./service.js";

const VERSION = "0.1.0";

function usage(): string {
  return `Agent Boost ${VERSION} — dark mode for your agent

Usage:
  agent-boost install-hermes [--executable /absolute/path/to/agent-boost]
  agent-boost hermes-turn-gate
  agent-boost mcp [--mode dark] [--contract-major 1]
  agent-boost onboard
  agent-boost status [--json]
  agent-boost doctor [--json]
  agent-boost version

The current POC is Sepolia-only and uses valueless test funds.`;
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function exitAfterFlush(code: number): Promise<never> {
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
    new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
  ]);
  process.exit(code);
}

function currentExitCode(): number {
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

async function withRuntime(
  operation: (runtime: LocalAgentBoostRuntime) => Promise<void>,
): Promise<void> {
  const [{ loadConfig }, { createLocalRuntime }] = await Promise.all([
    import("./config.js"),
    import("./service.js"),
  ]);
  return withManagedRuntime(await createLocalRuntime(loadConfig()), operation);
}

async function withManagedRuntime(
  runtime: LocalAgentBoostRuntime,
  operation: (runtime: LocalAgentBoostRuntime) => Promise<void>,
): Promise<void> {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.shutdown().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await operation(runtime);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await runtime.shutdown();
  }
}

async function withRegistrationFirstMcpRuntime(): Promise<void> {
  const [{ loadConfig }, { runStdioMcp }, { LocalAgentBoostRuntime }] =
    await Promise.all([
      import("./config.js"),
      import("./mcp.js"),
      import("./service.js"),
    ]);
  const runtime = new LocalAgentBoostRuntime(loadConfig());
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.shutdown().finally(() => process.exit(0));
  };
  try {
    await runStdioMcp(runtime, async () => {
      await runtime.initialize();
      // Do not install graceful shutdown handlers until initialization is
      // complete. Before this point the process keeps Node's default signal
      // behavior, avoiding shutdown racing Tor bootstrap or crash recovery.
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await runtime.shutdown();
  }
}

async function installHermes(args: readonly string[]): Promise<void> {
  const [{ installHermesIntegration }, { SpawnCommandRunner }] = await Promise.all([
    import("./hermes/index.js"),
    import("./kohaku/index.js"),
  ]);
  const requested = flagValue(args, "--executable");
  const executablePath = await realpath(requested ?? process.argv[1] ?? "");
  const runner = new SpawnCommandRunner({ defaultTimeoutMs: 3 * 60_000 });
  const result = await installHermesIntegration({
    executablePath,
    runCommand: async (command, commandArgs) =>
      runner.run({ executable: command, args: commandArgs }),
  });
  print({
    installed: true,
    config_path: result.configPath,
    config_changed: result.configChanged,
    ...(result.configBackupPath === undefined
      ? {}
      : { config_backup_path: result.configBackupPath }),
    turn_gate: {
      command: result.turnGateCommand,
      allowlist_path: result.hookAllowlistPath,
      allowlist_changed: result.hookAllowlistChanged,
      ...(result.hookAllowlistBackupPath === undefined
        ? {}
        : { allowlist_backup_path: result.hookAllowlistBackupPath }),
    },
    output_guard: {
      plugin_path: result.outputGuardPluginPath,
      changed: result.outputGuardPluginChanged,
      backup_paths: result.outputGuardPluginBackupPaths,
      validated: result.outputGuardPluginTest.exitCode === 0,
    },
    skills: result.skills.map((skill) => ({
      name: skill.name,
      path: skill.path,
      changed: skill.changed,
      ...(skill.backupPath === undefined
        ? {}
        : { backup_path: skill.backupPath }),
    })),
    next: result.recommendation,
  });
}

function safeCliError(error: HermesInstallError): Record<string, unknown> {
  const details = error.details;
  return {
    code: error.code,
    message: error.message,
    ...(details.rollback === undefined ? {} : { rollback: details.rollback }),
    ...(details.lockCleanup === undefined
      ? {}
      : { lock_cleanup: details.lockCleanup }),
    ...(details.committed === true ? { committed: true } : {}),
    ...(typeof details.recommendation === "string"
      ? { recommendation: details.recommendation }
      : {}),
    ...(typeof details.lockPath === "string"
      ? { lock_path: details.lockPath }
      : {}),
    ...(typeof details.path === "string"
      ? { target_path: details.path }
      : {}),
    ...(typeof details.ownerPid === "number"
      ? { owner_pid: details.ownerPid }
      : {}),
    ...(typeof details.remediation === "string"
      ? { remediation: details.remediation }
      : {}),
  };
}

async function doctor(): Promise<void> {
  const [
    { loadConfig },
    { assessSupportedHost, inspectPinnedKohaku, SpawnCommandRunner },
    { SepoliaRpcClient },
    { ShadeTreeEgress },
    { TorRpcProxy, TorRpcRoute },
  ] = await Promise.all([
    import("./config.js"),
    import("./kohaku/index.js"),
    import("./rpc/index.js"),
    import("./shade-tree/index.js"),
    import("./tor/index.js"),
  ]);
  const config = loadConfig();
  const checks: Array<{
    name: string;
    status: "pass" | "fail" | "warn";
    detail: string;
  }> = [];

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: major >= 22 ? "pass" : "fail",
    detail: `Node ${process.versions.node}; version 22 or newer required`,
  });

  let osRelease = "";
  if (process.platform === "linux") {
    try {
      osRelease = await readFile("/etc/os-release", "utf8");
    } catch {
      // Host assessment below returns a useful unsupported-host failure.
    }
  }
  const host = assessSupportedHost(process.platform, process.arch, osRelease);
  checks.push({
    name: "host",
    status: host.supported ? "pass" : "fail",
    detail: `${host.label}; ${host.detail}`,
  });

  const runner = new SpawnCommandRunner({ defaultTimeoutMs: 30_000 });
  const kohaku = await inspectPinnedKohaku({
    executable: config.kohakuBin,
    installDir: config.kohakuInstallDir,
    runner,
  });
  checks.push({
    name: "kohaku",
    status: kohaku.passed ? "pass" : "fail",
    detail: kohaku.detail,
  });

  const rpcRoute = new TorRpcRoute({
    rpcUrl: config.rpcUrl,
    dataDir: config.torDataDir,
    bootstrapTimeoutMs: config.torBootstrapTimeoutMs,
  });
  const rpcProxy = new TorRpcProxy({
    upstreamUrl: config.rpcUrl,
    fetch: rpcRoute.fetchRpc,
    port: config.torRpcPort,
  });
  try {
    await rpcRoute.ready();
    await rpcRoute.verifyTor();
    checks.push({
      name: "tor",
      status: "pass",
      detail: "Tor bootstrapped and the verification service observed a Tor exit",
    });
    await rpcProxy.start();
    await new SepoliaRpcClient({
      rpcUrl: config.rpcUrl,
      fetch: async (_input, init) => globalThis.fetch(rpcProxy.url, init),
    }).assertSepolia();
    checks.push({
      name: "sepolia_rpc_over_tor",
      status: "pass",
      detail: "Authenticated loopback relay returned Sepolia chain ID 11155111 through Tor",
    });
  } catch (error) {
    checks.push({
      name: "tor_rpc_route",
      status: "fail",
      detail: error instanceof Error ? error.message : "Tor RPC route check failed",
    });
  } finally {
    await rpcProxy.stop();
    await rpcRoute.close();
  }

  try {
    const hermes = await runner.run({ executable: "hermes", args: ["--version"] });
    checks.push({
      name: "hermes",
      status: hermes.exitCode === 0 ? "pass" : "warn",
      detail:
        hermes.exitCode === 0
          ? hermes.stdout.trim().slice(0, 120) || "Hermes executable is available"
          : "Hermes is optional until integration",
    });
  } catch {
    checks.push({
      name: "hermes",
      status: "warn",
      detail: "Hermes is not on PATH; install or pass its environment during setup",
    });
  }

  const shadeTree = new ShadeTreeEgress(config);
  try {
    await shadeTree.start();
    const covered = await shadeTree.status();
    checks.push({
      name: "covered_egress",
      status: covered.status === "ready" ? "pass" : "warn",
      detail: `${covered.status}: ${covered.detail}; explicit HTTPS fetch only, no direct fallback`,
    });
  } finally {
    await shadeTree.stop();
  }

  const passed = checks.every((check) => check.status !== "fail");
  print({ passed, network: "sepolia", checks });
  if (!passed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${usage()}\n`);
      return;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "install-hermes":
      await installHermes(args);
      return;
    case "hermes-turn-gate": {
      // Keep this safety-critical hook on a deliberately tiny startup path.
      // Loading the wallet, Tor, MCP, or installer graphs here can consume
      // Hermes' entire shell-hook timeout before the gate reads stdin.
      const { runHermesTurnGate } = await import("./hermes/turn-gate.js");
      await runHermesTurnGate();
      return exitAfterFlush(currentExitCode());
    }
    case "doctor":
      await doctor();
      return exitAfterFlush(currentExitCode());
    case "status": {
      const [{ loadConfig }, { readLocalStatus }] = await Promise.all([
        import("./config.js"),
        import("./service.js"),
      ]);
      print(await readLocalStatus(loadConfig()));
      return;
    }
    case "onboard":
      await withRuntime(async (runtime) => {
        const started = await runtime.startOnboarding();
        print({
          setup_id: started.record.setupId,
          phase: started.record.phase,
          ui_opened: started.uiOpened,
          ui_url: started.record.uiUrl,
          address: started.record.address,
        });
        let record = started.record;
        while (record.phase !== "private_ready" && record.phase !== "failed") {
          record = await runtime.onboardingStatus({
            setupId: record.setupId,
            sinceRevision: record.revision,
            waitMs: 90_000,
          });
          print({ phase: record.phase, revision: record.revision });
        }
        if (record.phase === "failed") process.exitCode = 1;
      });
      return exitAfterFlush(currentExitCode());
    case "mcp": {
      const mode = flagValue(args, "--mode") ?? "dark";
      const contractMajor = flagValue(args, "--contract-major") ?? "1";
      if (mode !== "dark" || contractMajor !== "1") {
        throw new Error("The POC supports only --mode dark --contract-major 1");
      }
      await withRegistrationFirstMcpRuntime();
      return exitAfterFlush(currentExitCode());
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch(async (error: unknown) => {
  const { HermesInstallError } = await import("./hermes/index.js");
  if (error instanceof HermesInstallError) {
    process.stderr.write(
      `agent-boost: ${JSON.stringify(safeCliError(error), null, 2)}\n`,
      () => process.exit(1),
    );
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-boost: ${message}\n`, () => process.exit(1));
});
