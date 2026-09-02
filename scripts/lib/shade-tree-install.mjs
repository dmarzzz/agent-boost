import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, platform as currentPlatform, arch as currentArch } from "node:os";
import { dirname, join, resolve } from "node:path";

import { spawnCommand } from "./kohaku-install.mjs";

export const SHADE_TREE_VERSION = "0.4.0";
export const SHADE_TREE_RELEASE_TAG = "v0.4.0";
export const SHADE_TREE_RELEASE_COMMIT = "db074e4e75daf87b50fd52bda5378c9d04ce6c4d";
export const SHADE_TREE_REPOSITORY = "https://github.com/dmarzzz/shade-tree-node";
export const SHADE_TREE_PROVENANCE_FILE = ".agent-boost-install.json";

const HOSTS = new Map([
  ["linux:arm64", {
    label: "Linux ARM64 GNU",
    asset: "shade-tree-0.4.0-aarch64-unknown-linux-gnu-live",
    sha256: "17432ff1d53138d0535b4940a0ee0dcde7421d09fe614533225aa3c12bee1196",
  }],
  ["darwin:arm64", {
    label: "macOS Apple silicon",
    asset: "shade-tree-0.4.0-aarch64-apple-darwin-live",
    sha256: "9002f9bb1b834cfabcb761ed6ce6b678e10f6690e7f74e7f89ef54a33f25fb3f",
  }],
]);

export function defaultShadeTreeInstallDir(home = homedir()) {
  return join(home, ".local", "share", "agent-boost", "dependencies", "shade-tree");
}

export function assessShadeTreeHost(platform, arch) {
  const pin = HOSTS.get(`${platform}:${arch}`);
  if (pin) return { supported: true, ...pin };
  return {
    supported: false,
    label: platform === "darwin" && arch === "x64"
      ? "macOS Intel (upstream v0.4.0 has no live binary)"
      : `${platform} ${arch}`,
  };
}

export async function installPinnedShadeTree(options = {}) {
  const platform = options.platform ?? currentPlatform();
  const arch = options.arch ?? currentArch();
  const host = options.hostPin ?? assessShadeTreeHost(platform, arch);
  if (!host.supported) {
    return {
      installed: false,
      reused: false,
      available: false,
      status: "unsupported",
      host: host.label,
      version: SHADE_TREE_VERSION,
      warning: "Covered egress is unavailable on this host; wallet features remain available.",
    };
  }
  const target = resolve(
    options.installDir ??
      process.env.AGENT_BOOST_SHADE_TREE_INSTALL_DIR ??
      defaultShadeTreeInstallDir(options.home),
  );
  const parent = dirname(target);
  const runCommand = options.runCommand ?? spawnCommand;
  const download = options.download ?? downloadAsset;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const lockPath = `${target}.install.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(`${process.pid}\n`, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another Shade Tree installation is in progress");
    throw error;
  }

  let staging;
  try {
    const existing = await inspectManagedInstall(target, runCommand, host);
    if (existing.ready) {
      return {
        installed: false,
        reused: true,
        available: true,
        status: "installed",
        installDir: target,
        executable: join(target, "bin", "shade-tree"),
        version: SHADE_TREE_VERSION,
        releaseCommit: SHADE_TREE_RELEASE_COMMIT,
        asset: host.asset,
        sha256: host.sha256,
        host: host.label,
      };
    }
    if (existing.exists && !existing.managed) {
      throw new Error(`Refusing to replace unmanaged directory ${target}`);
    }
    staging = await mkdtemp(join(parent, ".shade-tree-install-"));
    const binDir = join(staging, "bin");
    await mkdir(binDir, { mode: 0o700 });
    const bytes = Buffer.from(await download(releaseUrl(host.asset)));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== host.sha256) {
      throw new Error(`Shade Tree release digest mismatch for ${host.asset}`);
    }
    const executable = join(binDir, "shade-tree");
    await writeFile(executable, bytes, { mode: 0o755, flag: "wx" });
    await chmod(executable, 0o755);
    const version = await runCommand(executable, ["--version"], { timeoutMs: 30_000 });
    if (version.exitCode !== 0 || !version.stdout.includes(SHADE_TREE_VERSION)) {
      const macHint = platform === "darwin"
        ? " The upstream v0.4.0 binary is not notarized; review macOS Gatekeeper before choosing whether to allow it."
        : "";
      throw new Error(`Pinned Shade Tree binary did not report version ${SHADE_TREE_VERSION}.${macHint}`);
    }
    const provenance = {
      schemaVersion: 1,
      repository: SHADE_TREE_REPOSITORY,
      releaseTag: SHADE_TREE_RELEASE_TAG,
      releaseCommit: SHADE_TREE_RELEASE_COMMIT,
      version: SHADE_TREE_VERSION,
      asset: host.asset,
      sha256: host.sha256,
      platform,
      arch,
      installedAt: new Date().toISOString(),
    };
    await writeFile(
      join(staging, SHADE_TREE_PROVENANCE_FILE),
      `${JSON.stringify(provenance, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    let backup;
    if (existing.exists) {
      backup = `${target}.backup-${Date.now()}-${randomBytes(3).toString("hex")}`;
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
      available: true,
      status: "installed",
      installDir: target,
      executable: join(target, "bin", "shade-tree"),
      version: SHADE_TREE_VERSION,
      releaseCommit: SHADE_TREE_RELEASE_COMMIT,
      asset: host.asset,
      sha256: host.sha256,
      host: host.label,
      ...(backup ? { backup } : {}),
    };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

function releaseUrl(asset) {
  return `${SHADE_TREE_REPOSITORY}/releases/download/${SHADE_TREE_RELEASE_TAG}/${asset}`;
}

async function downloadAsset(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not download Shade Tree release: HTTP ${response.status}`);
  const maximum = 128 * 1024 * 1024;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximum) {
    throw new Error("Shade Tree release asset exceeds the 128 MiB download limit");
  }
  if (!response.body) throw new Error("Shade Tree release response has no body");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximum) {
      throw new Error("Shade Tree release asset exceeds the 128 MiB download limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function inspectManagedInstall(target, runCommand, host) {
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, managed: false, ready: false };
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return { exists: true, managed: false, ready: false };
  }
  let provenance;
  try {
    provenance = JSON.parse(await readFile(join(target, SHADE_TREE_PROVENANCE_FILE), "utf8"));
  } catch {
    return { exists: true, managed: false, ready: false };
  }
  const managed = provenance?.schemaVersion === 1;
  if (
    !managed ||
    provenance.releaseCommit !== SHADE_TREE_RELEASE_COMMIT ||
    provenance.version !== SHADE_TREE_VERSION ||
    provenance.asset !== host.asset ||
    provenance.sha256 !== host.sha256
  ) {
    return { exists: true, managed, ready: false };
  }
  const executable = join(target, "bin", "shade-tree");
  try {
    const digest = createHash("sha256").update(await readFile(executable)).digest("hex");
    if (digest !== host.sha256) return { exists: true, managed: true, ready: false };
    const version = await runCommand(executable, ["--version"], { timeoutMs: 30_000 });
    return {
      exists: true,
      managed: true,
      ready: version.exitCode === 0 && version.stdout.includes(SHADE_TREE_VERSION),
    };
  } catch {
    return { exists: true, managed: true, ready: false };
  }
}
