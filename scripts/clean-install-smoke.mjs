#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assessInstallHost,
  readCurrentOsRelease,
} from "./lib/kohaku-install.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let sandbox;

try {
  const host = assessInstallHost(
    process.platform,
    process.arch,
    await readCurrentOsRelease(),
  );
  if (!host.supported) throw new Error(`Unsupported release host: ${host.label}`);
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error("Node.js 22 or newer is required");
  }

  sandbox = await mkdtemp(join(tmpdir(), "agent-boost-clean-install-"));
  await chmod(sandbox, 0o700);
  const packDir = join(sandbox, "pack");
  const prefix = join(sandbox, "prefix");
  await mkdir(packDir, { recursive: true, mode: 0o700 });
  const packed = await checked("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packDir,
  ], root);
  const packResult = JSON.parse(packed.stdout);
  const filename = packResult?.[0]?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    throw new Error("npm pack did not return an Agent Boost tarball");
  }
  const tarball = join(packDir, filename);
  await checked("npm", [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ], root);

  const packageRoot = join(prefix, "lib", "node_modules", "agent-boost");
  const executable = join(prefix, "bin", process.platform === "win32" ? "agent-boost.cmd" : "agent-boost");
  const version = await checked(executable, ["--version"], sandbox);
  if (version.stdout.trim() !== "0.1.0") {
    throw new Error(`Unexpected installed version: ${version.stdout.trim()}`);
  }

  for (const required of [
    "README.md",
    "agent-boost.example.toml",
    "dist/cli.js",
    "dist/kohaku/network-guard.mjs",
    "dist/shade-tree/runtime.js",
    "integrations/hermes/agent-boost/SKILL.md",
    "integrations/hermes/agent-boost-setup/SKILL.md",
  ]) {
    const metadata = await lstat(join(packageRoot, required));
    if (!metadata.isFile()) throw new Error(`Packaged artifact is missing ${required}`);
  }

  const configModule = await import(
    `${pathToFileURL(join(packageRoot, "dist", "config.js")).href}?smoke=${Date.now()}`
  );
  const isolatedHome = join(sandbox, "home");
  const config = configModule.loadConfig({}, isolatedHome);
  if (config.rpcUrl !== "https://ethereum-sepolia-rpc.publicnode.com") {
    throw new Error("Installed package has an unexpected default Sepolia RPC");
  }
  if (config.security.effective["payment.execute"] !== "confirm") {
    throw new Error("Installed package lost the default confirmation policy");
  }
  if (
    config.shadeTreeEnabled !== true ||
    config.shadeTreeProxyPort !== 9186 ||
    config.shadeTreeMaxResponseBytes !== 1_048_576
  ) {
    throw new Error("Installed package lost the covered-egress fail-closed defaults");
  }

  const packageFiles = await walk(packageRoot);
  const forbidden = packageFiles.filter((path) =>
    /(?:^|\/)(?:docs\/(?:issues|roadmaps)|experiments)(?:\/|$)/u.test(path)
  );
  if (forbidden.length) {
    throw new Error(`Private planning material entered the package: ${forbidden.join(", ")}`);
  }
  process.stdout.write(`${JSON.stringify({
    schema: "org.agentboost.clean-install-smoke",
    schema_version: "1.0",
    passed: true,
    host: {
      label: host.label,
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
    },
    package: {
      filename: basename(tarball),
      files: packageFiles.length,
      version: version.stdout.trim(),
      hermes_skills: 2,
    },
    checks: [
      "native_host_supported",
      "tarball_installed_into_empty_prefix",
      "installed_executable_started",
      "runtime_config_loaded",
      "default_security_confirmed",
      "covered_egress_defaults_loaded",
      "hermes_skills_packaged",
      "private_notes_excluded",
    ],
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `clean-install smoke: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (sandbox) await removeSandbox(sandbox);
}

async function walk(rootPath, relative = "") {
  const entries = await readdir(join(rootPath, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walk(rootPath, child));
    else if (entry.isFile()) files.push(child.replaceAll("\\", "/"));
  }
  return files;
}

function checked(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectPromise);
    child.once("close", (exitCode) => {
      const result = {
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.exitCode !== 0) {
        rejectPromise(
          new Error(`${command} ${args[0] ?? ""} failed: ${(result.stderr || result.stdout).slice(0, 2_000)}`),
        );
        return;
      }
      resolvePromise(result);
    });
  });
}

async function removeSandbox(path) {
  const resolved = resolve(path);
  if (
    dirname(resolved) !== resolve(tmpdir()) ||
    !basename(resolved).startsWith("agent-boost-clean-install-")
  ) {
    throw new Error("Refusing to remove an unrecognized smoke-test directory");
  }
  await rm(resolved, { recursive: true, force: true });
}
