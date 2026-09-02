#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";

import { loadConfig } from "./config.js";
import { installHermesIntegration } from "./hermes/index.js";
import {
  assessSupportedHost,
  inspectPinnedKohaku,
  SpawnCommandRunner,
} from "./kohaku/index.js";
import { runStdioMcp } from "./mcp.js";
import { SepoliaRpcClient } from "./rpc/index.js";
import { ShadeTreeEgress } from "./shade-tree/index.js";
import {
  createLocalRuntime,
  readLocalStatus,
  type LocalAgentBoostRuntime,
} from "./service.js";
import { TorRpcProxy, TorRpcRoute } from "./tor/index.js";

const VERSION = "0.1.0";

function usage(): string {
  return `Agent Boost ${VERSION} — dark mode for your agent

Usage:
  agent-boost install-hermes [--executable /absolute/path/to/agent-boost]
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
  const runtime = await createLocalRuntime(loadConfig());
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

async function installHermes(args: readonly string[]): Promise<void> {
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
    skills: result.skills.map((skill) => ({
      name: skill.name,
      path: skill.path,
      changed: skill.changed,
    })),
    next: result.recommendation,
  });
}

async function doctor(): Promise<void> {
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
    case "doctor":
      await doctor();
      return exitAfterFlush(currentExitCode());
    case "status":
      print(await readLocalStatus(loadConfig()));
      return;
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
      await withRuntime((runtime) => runStdioMcp(runtime));
      return exitAfterFlush(currentExitCode());
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-boost: ${message}\n`, () => process.exit(1));
});
