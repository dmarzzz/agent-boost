#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assessInstallHost,
  installPinnedKohaku,
  readCurrentOsRelease,
  spawnCommand,
} from "./lib/kohaku-install.mjs";
import { configureHermesIfAvailable } from "./lib/hermes-install.mjs";
import { installPinnedShadeTree } from "./lib/shade-tree-install.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = resolve(
  process.env.AGENT_BOOST_PREFIX ?? join(homedir(), ".local"),
);
let packDir;

try {
  const host = assessInstallHost(
    process.platform,
    process.arch,
    await readCurrentOsRelease(),
  );
  if (!host.supported) {
    throw new Error(
      `Unsupported host ${host.label}. Supported hosts are macOS arm64, macOS x64, and Ubuntu 24.04 arm64.`,
    );
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22) {
    throw new Error(`Node.js 22 or newer is required; received ${process.versions.node}`);
  }

  await checked("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: projectRoot,
    timeoutMs: 10 * 60_000,
  });
  await checked("npm", ["run", "check"], {
    cwd: projectRoot,
    timeoutMs: 5 * 60_000,
  });
  await checked("npm", ["test"], {
    cwd: projectRoot,
    timeoutMs: 10 * 60_000,
  });
  await checked("npm", ["run", "build"], {
    cwd: projectRoot,
    timeoutMs: 5 * 60_000,
  });

  packDir = await mkdtemp(join(tmpdir(), "agent-boost-pack-"));
  const packed = await checked(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
    { cwd: projectRoot, timeoutMs: 5 * 60_000 },
  );
  const packResult = JSON.parse(packed.stdout);
  const filename = packResult?.[0]?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    throw new Error("npm pack did not return an Agent Boost tarball");
  }
  const tarball = join(packDir, filename);
  await readFile(tarball);
  const kohaku = await installPinnedKohaku();
  const shadeTree = await installPinnedShadeTree();
  await checked(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { timeoutMs: 10 * 60_000 },
  );

  const agentBoost = join(prefix, "bin", "agent-boost");
  const version = await checked(agentBoost, ["--version"], { timeoutMs: 30_000 });
  const hermes = await configureHermesIfAvailable({
    agentBoostExecutable: agentBoost,
  });
  const binDir = dirname(agentBoost);
  const pathConfigured = (process.env.PATH ?? "")
    .split(delimiter)
    .some((entry) => resolve(entry) === resolve(binDir));

  process.stdout.write(
    `${JSON.stringify(
      {
        installed: true,
        agent_boost: {
          executable: agentBoost,
          version: version.stdout.trim(),
        },
        kohaku,
        shade_tree: shadeTree,
        hermes,
        path_configured: pathConfigured,
        setup_prompt: "Set up Agent Boost for me.",
        next: hermes.status === "configured"
          ? 'Restart Hermes once, then say: "Set up Agent Boost for me."'
          : hermes.next,
        diagnostics: pathConfigured
          ? "agent-boost doctor"
          : `Add ${binDir} to PATH before running agent-boost doctor`,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(
    `agent-boost installer: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (packDir) await rm(packDir, { recursive: true, force: true });
}

async function checked(executable, args, options = {}) {
  const result = await spawnCommand(executable, args, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no diagnostics";
    throw new Error(`${executable} ${args[0] ?? ""} failed: ${detail.slice(0, 2_000)}`);
  }
  return result;
}
