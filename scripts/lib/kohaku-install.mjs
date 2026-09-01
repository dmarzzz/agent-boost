import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform as currentPlatform, arch as currentArch } from "node:os";
import { dirname, join, resolve } from "node:path";

const pin = JSON.parse(
  await readFile(new URL("../../src/kohaku/kohaku-pin.json", import.meta.url), "utf8"),
);

export const KOHAKU_REPOSITORY = pin.repository;
export const KOHAKU_COMMIT = pin.commit;
export const KOHAKU_VERSION = pin.version;
export const KOHAKU_PROVENANCE_FILE = ".agent-boost-install.json";

export function defaultKohakuInstallDir(home = homedir()) {
  return join(
    home,
    ".local",
    "share",
    "agent-boost",
    "dependencies",
    "kohaku-cli",
  );
}

export function assessInstallHost(platform, arch, osRelease = "") {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return {
      supported: true,
      label: `macOS ${arch === "arm64" ? "Apple silicon" : "Intel"}`,
    };
  }
  if (platform === "linux" && arch === "arm64") {
    const fields = parseOsRelease(osRelease);
    const supported =
      fields.ID?.toLowerCase() === "ubuntu" && fields.VERSION_ID === "24.04";
    return {
      supported,
      label: supported
        ? "Ubuntu 24.04 ARM64"
        : `${fields.PRETTY_NAME ?? "Linux"} ARM64`,
    };
  }
  return { supported: false, label: `${platform} ${arch}` };
}

export async function readCurrentOsRelease(platform = currentPlatform()) {
  if (platform !== "linux") return "";
  try {
    return await readFile("/etc/os-release", "utf8");
  } catch {
    return "";
  }
}

export async function installPinnedKohaku(options = {}) {
  const platform = options.platform ?? currentPlatform();
  const arch = options.arch ?? currentArch();
  const osRelease =
    options.osRelease ?? (await readCurrentOsRelease(platform));
  const host = assessInstallHost(platform, arch, osRelease);
  if (!host.supported) {
    throw new Error(
      `Unsupported host ${host.label}. Supported hosts are macOS arm64, macOS x64, and Ubuntu 24.04 arm64.`,
    );
  }
  assertNode22(options.nodeVersion ?? process.versions.node);

  const target = resolve(
    options.installDir ??
      process.env.AGENT_BOOST_KOHAKU_INSTALL_DIR ??
      defaultKohakuInstallDir(options.home),
  );
  const parent = dirname(target);
  const runCommand = options.runCommand ?? spawnCommand;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);

  const lockPath = `${target}.install.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(`${process.pid.toString()}\n`, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Another Kohaku installation is already using ${lockPath}`);
    }
    throw error;
  }

  let staging;
  try {
    const existing = await inspectManagedInstall(target, runCommand);
    if (existing.ready) {
      return {
        installed: false,
        reused: true,
        installDir: target,
        executable: join(target, "bin", "kohaku.mjs"),
        commit: KOHAKU_COMMIT,
        version: KOHAKU_VERSION,
        host: host.label,
      };
    }
    if (existing.exists && !existing.managed) {
      throw new Error(
        `Refusing to replace unmanaged directory ${target}; move it aside or choose AGENT_BOOST_KOHAKU_INSTALL_DIR`,
      );
    }

    staging = await mkdtemp(join(parent, ".kohaku-cli-install-"));
    await checked(runCommand, "git", ["init", "--quiet", staging]);
    await checked(runCommand, "git", [
      "-C",
      staging,
      "remote",
      "add",
      "origin",
      KOHAKU_REPOSITORY,
    ]);
    await checked(runCommand, "git", [
      "-C",
      staging,
      "fetch",
      "--quiet",
      "--depth",
      "1",
      "origin",
      KOHAKU_COMMIT,
    ]);
    await checked(runCommand, "git", [
      "-C",
      staging,
      "checkout",
      "--quiet",
      "--detach",
      "FETCH_HEAD",
    ]);
    const revision = await checked(runCommand, "git", [
      "-C",
      staging,
      "rev-parse",
      "HEAD",
    ]);
    if (revision.stdout.trim() !== KOHAKU_COMMIT) {
      throw new Error("Fetched Kohaku revision did not match the pinned commit");
    }

    await checked(
      runCommand,
      options.npmExecutable ?? "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: staging, timeoutMs: 20 * 60_000 },
    );
    await checked(
      runCommand,
      options.npmExecutable ?? "npm",
      ["run", "build"],
      { cwd: staging, timeoutMs: 10 * 60_000 },
    );
    await checked(
      runCommand,
      options.npmExecutable ?? "npm",
      ["prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: staging, timeoutMs: 10 * 60_000 },
    );

    const executable = join(staging, "bin", "kohaku.mjs");
    await chmod(executable, 0o755);
    const versionResult = await checked(
      runCommand,
      process.execPath,
      [executable, "--version"],
      { timeoutMs: 30_000 },
    );
    if (versionResult.stdout.trim().split(/\s+/)[0] !== KOHAKU_VERSION) {
      throw new Error("Built Kohaku executable did not report the pinned version");
    }

    const provenance = {
      schemaVersion: 1,
      repository: KOHAKU_REPOSITORY,
      commit: KOHAKU_COMMIT,
      version: KOHAKU_VERSION,
      platform,
      arch,
      installedAt: new Date().toISOString(),
      sha256: {
        packageLock: await sha256(join(staging, "package-lock.json")),
        launcher: await sha256(executable),
        bundle: await sha256(join(staging, "dist", "index.js")),
      },
    };
    const provenancePath = join(staging, KOHAKU_PROVENANCE_FILE);
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await chmod(provenancePath, 0o600);

    let backup;
    if (existing.exists) {
      backup = `${target}.backup-${Date.now().toString()}-${randomBytes(3).toString("hex")}`;
      await rename(target, backup);
    }
    try {
      await rename(staging, target);
      staging = undefined;
    } catch (error) {
      if (backup) await rename(backup, target);
      throw error;
    }

    return {
      installed: true,
      reused: false,
      installDir: target,
      executable: join(target, "bin", "kohaku.mjs"),
      commit: KOHAKU_COMMIT,
      version: KOHAKU_VERSION,
      host: host.label,
      ...(backup ? { backup } : {}),
    };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function spawnCommand(executable, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    const limit = 16 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 60_000;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const capture = (destination, chunk) => {
      size += chunk.byteLength;
      if (size > limit) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("Installer command output exceeded 16 MiB")));
        return;
      }
      destination.push(chunk);
    };
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (exitCode, signal) => {
      finish(() =>
        resolvePromise({
          exitCode: exitCode ?? 1,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`Installer command timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref();
  });
}

async function checked(runCommand, executable, args, options = {}) {
  let result;
  try {
    result = await runCommand(executable, args, options);
  } catch (error) {
    throw new Error(`Could not run ${executable}: ${error?.message ?? String(error)}`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "no diagnostics";
    throw new Error(`${executable} ${args[0] ?? ""} failed: ${detail.slice(0, 1_000)}`);
  }
  return result;
}

async function inspectManagedInstall(target, runCommand) {
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, managed: false, ready: false };
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { exists: true, managed: false, ready: false };
  }
  let provenance;
  try {
    provenance = JSON.parse(
      await readFile(join(target, KOHAKU_PROVENANCE_FILE), "utf8"),
    );
  } catch {
    return { exists: true, managed: false, ready: false };
  }
  const managed = provenance?.schemaVersion === 1;
  if (
    !managed ||
    provenance.repository !== KOHAKU_REPOSITORY ||
    provenance.commit !== KOHAKU_COMMIT ||
    provenance.version !== KOHAKU_VERSION
  ) {
    return { exists: true, managed, ready: false };
  }
  const hashes = [
    ["packageLock", "package-lock.json"],
    ["launcher", "bin/kohaku.mjs"],
    ["bundle", "dist/index.js"],
  ];
  for (const [key, relativePath] of hashes) {
    try {
      if ((await sha256(join(target, relativePath))) !== provenance.sha256?.[key]) {
        return { exists: true, managed: true, ready: false };
      }
    } catch {
      return { exists: true, managed: true, ready: false };
    }
  }
  try {
    const result = await runCommand(
      process.execPath,
      [join(target, "bin", "kohaku.mjs"), "--version"],
      { timeoutMs: 30_000 },
    );
    const ready =
      result.exitCode === 0 && result.stdout.trim().split(/\s+/)[0] === KOHAKU_VERSION;
    return { exists: true, managed: true, ready };
  } catch {
    return { exists: true, managed: true, ready: false };
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function assertNode22(version) {
  const major = Number(String(version).split(".")[0]);
  if (!Number.isSafeInteger(major) || major < 22) {
    throw new Error(`Node.js 22 or newer is required; received ${version}`);
  }
}

function parseOsRelease(raw) {
  const fields = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    fields[match[1]] = (match[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}
