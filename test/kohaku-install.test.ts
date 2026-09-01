import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  assessSupportedHost,
  inspectPinnedKohaku,
  KOHAKU_COMMIT,
  KOHAKU_PROVENANCE_FILE,
  KOHAKU_REPOSITORY,
  KOHAKU_VERSION,
} from "../src/kohaku/index.js";
import type { CommandRunner } from "../src/kohaku/runner.js";

const installer = await import("../scripts/lib/kohaku-install.mjs") as {
  assessInstallHost(platform: string, arch: string, osRelease?: string): {
    supported: boolean;
    label: string;
  };
  installPinnedKohaku(options: Record<string, unknown>): Promise<{
    installed: boolean;
    reused: boolean;
    installDir: string;
    executable: string;
    commit: string;
  }>;
};
const hermesInstaller = await import("../scripts/lib/hermes-install.mjs") as {
  configureHermesIfAvailable(options: {
    agentBoostExecutable: string;
    runCommand: (
      executable: string,
      args: string[],
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }): Promise<Record<string, unknown>>;
};

const UBUNTU_2404 = 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n';

describe("Kohaku shipping host matrix", () => {
  it("supports both macOS architectures and Ubuntu 24.04 ARM64 only", () => {
    for (const arch of ["arm64", "x64"]) {
      assert.equal(installer.assessInstallHost("darwin", arch).supported, true);
      assert.equal(assessSupportedHost("darwin", arch).supported, true);
    }
    assert.equal(
      installer.assessInstallHost("linux", "arm64", UBUNTU_2404).supported,
      true,
    );
    assert.equal(
      assessSupportedHost("linux", "arm64", UBUNTU_2404).supported,
      true,
    );
    assert.equal(
      installer.assessInstallHost(
        "linux",
        "arm64",
        'ID=ubuntu\nVERSION_ID="22.04"\n',
      ).supported,
      false,
    );
    assert.equal(
      installer.assessInstallHost("linux", "x64", UBUNTU_2404).supported,
      false,
    );
  });
});

describe("pinned Kohaku installer", () => {
  it("installs atomically, writes hashed provenance, and reuses an exact install", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-boost-install-test-"));
    const installDir = join(root, "dependencies", "kohaku-cli");
    const calls: Array<{ executable: string; args: string[]; cwd?: string }> = [];
    const runCommand = async (
      executable: string,
      args: string[],
      options: { cwd?: string } = {},
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      calls.push({ executable, args, ...(options.cwd ? { cwd: options.cwd } : {}) });
      if (executable === "git" && args[0] === "init") {
        await mkdir(args[2]!, { recursive: true });
      }
      if (executable === "git" && args.includes("checkout")) {
        const staging = args[1]!;
        await mkdir(join(staging, "bin"), { recursive: true });
        await mkdir(join(staging, "dist"), { recursive: true });
        await writeFile(join(staging, "package-lock.json"), "lock");
        await writeFile(join(staging, "bin", "kohaku.mjs"), "launcher");
        await writeFile(join(staging, "dist", "index.js"), "bundle");
      }
      if (executable === "git" && args.includes("rev-parse")) {
        return { exitCode: 0, stdout: `${KOHAKU_COMMIT}\n`, stderr: "" };
      }
      if (executable === process.execPath) {
        return { exitCode: 0, stdout: `${KOHAKU_VERSION}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const first = await installer.installPinnedKohaku({
      installDir,
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "22.20.0",
      runCommand,
    });
    assert.equal(first.installed, true);
    assert.equal(first.reused, false);
    assert.equal(first.commit, KOHAKU_COMMIT);

    const provenance = JSON.parse(
      await readFile(join(installDir, KOHAKU_PROVENANCE_FILE), "utf8"),
    ) as {
      repository: string;
      commit: string;
      sha256: { packageLock: string; launcher: string; bundle: string };
    };
    assert.equal(provenance.repository, KOHAKU_REPOSITORY);
    assert.equal(provenance.commit, KOHAKU_COMMIT);
    assert.equal(
      provenance.sha256.bundle,
      createHash("sha256").update("bundle").digest("hex"),
    );

    const callCount = calls.length;
    const second = await installer.installPinnedKohaku({
      installDir,
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "24.6.0",
      runCommand,
    });
    assert.equal(second.installed, false);
    assert.equal(second.reused, true);
    assert.equal(calls.slice(callCount).some((call) => call.executable === "npm"), false);

    const runner: CommandRunner = {
      run: async () => ({
        exitCode: 0,
        stdout: `${KOHAKU_VERSION}\n`,
        stderr: "",
      }),
    };
    const readiness = await inspectPinnedKohaku({
      executable: first.executable,
      installDir,
      runner,
    });
    assert.equal(readiness.passed, true);
    assert.equal(readiness.commit, KOHAKU_COMMIT);
  });

  it("rejects unsupported hosts and refuses an unmanaged destination", async () => {
    await assert.rejects(
      installer.installPinnedKohaku({
        installDir: "/tmp/not-used-agent-boost-test",
        platform: "linux",
        arch: "x64",
        osRelease: UBUNTU_2404,
      }),
      /Unsupported host/,
    );

    const root = await mkdtemp(join(tmpdir(), "agent-boost-unmanaged-test-"));
    const installDir = join(root, "kohaku-cli");
    await mkdir(installDir);
    await writeFile(join(installDir, "user-file"), "preserve me");
    await assert.rejects(
      installer.installPinnedKohaku({
        installDir,
        platform: "darwin",
        arch: "x64",
        nodeVersion: "22.0.0",
        runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
      /Refusing to replace unmanaged directory/,
    );
    assert.equal(await readFile(join(installDir, "user-file"), "utf8"), "preserve me");
  });
});

describe("Kohaku readiness", () => {
  it("fails closed when provenance is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-boost-readiness-test-"));
    const runner: CommandRunner = {
      run: async () => ({ exitCode: 0, stdout: `${KOHAKU_VERSION}\n`, stderr: "" }),
    };
    const result = await inspectPinnedKohaku({
      executable: join(root, "bin", "kohaku.mjs"),
      installDir: root,
      runner,
    });
    assert.equal(result.passed, false);
    assert.match(result.detail, /provenance is missing/);
  });
});

describe("overall installer Hermes integration", () => {
  it("configures Hermes with the installed absolute Agent Boost executable", async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const agentBoostExecutable = "/Users/demo/.local/bin/agent-boost";
    const result = await hermesInstaller.configureHermesIfAvailable({
      agentBoostExecutable,
      runCommand: async (executable, args) => {
        calls.push({ executable, args });
        if (executable === "hermes") {
          return { exitCode: 0, stdout: "Hermes 0.16.0", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ installed: true, next: "Reload Hermes" }),
          stderr: "",
        };
      },
    });

    assert.equal(result.status, "configured");
    assert.deepEqual(calls[1], {
      executable: agentBoostExecutable,
      args: ["install-hermes", "--executable", agentBoostExecutable],
    });
  });

  it("returns a nonfatal repair command when Hermes is missing", async () => {
    const agentBoostExecutable = "/home/demo/.local/bin/agent-boost";
    const result = await hermesInstaller.configureHermesIfAvailable({
      agentBoostExecutable,
      runCommand: async () => {
        throw new Error("ENOENT");
      },
    });

    assert.equal(result.status, "not_found");
    assert.match(String(result.warning), /not found/i);
    assert.match(String(result.command), /install-hermes/);
    assert.match(String(result.command), new RegExp(agentBoostExecutable));
  });
});
