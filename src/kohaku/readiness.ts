import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CommandRunner } from "./runner.js";
import {
  KOHAKU_COMMIT,
  KOHAKU_PROVENANCE_FILE,
  KOHAKU_REPOSITORY,
  KOHAKU_VERSION,
  type KohakuInstallProvenance,
} from "./pin.js";

export interface SupportedHostResult {
  supported: boolean;
  platform: NodeJS.Platform | string;
  arch: string;
  label: string;
  detail: string;
}

export interface KohakuReadinessResult {
  passed: boolean;
  version?: string;
  commit?: string;
  detail: string;
  failures: string[];
}

export function assessSupportedHost(
  platform: NodeJS.Platform | string,
  arch: string,
  osRelease = "",
): SupportedHostResult {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return {
      supported: true,
      platform,
      arch,
      label: `macOS ${arch === "arm64" ? "Apple silicon" : "Intel"}`,
      detail: "Supported event POC host",
    };
  }

  if (platform === "linux" && arch === "arm64") {
    const fields = parseOsRelease(osRelease);
    const ubuntu2404 =
      fields.ID?.toLowerCase() === "ubuntu" && fields.VERSION_ID === "24.04";
    return {
      supported: ubuntu2404,
      platform,
      arch,
      label: ubuntu2404
        ? "Ubuntu 24.04 ARM64"
        : `${fields.PRETTY_NAME ?? "Linux"} ARM64`,
      detail: ubuntu2404
        ? "Supported event POC host"
        : "The Linux event build supports only Ubuntu 24.04 on ARM64",
    };
  }

  return {
    supported: false,
    platform,
    arch,
    label: `${platform} ${arch}`,
    detail:
      "Supported hosts are macOS arm64, macOS x64, and Ubuntu 24.04 arm64",
  };
}

export async function inspectPinnedKohaku(options: {
  executable: string;
  installDir: string;
  runner: CommandRunner;
  readFile?: typeof readFile;
}): Promise<KohakuReadinessResult> {
  const failures: string[] = [];
  let version: string | undefined;
  try {
    const result = await options.runner.run({
      executable: options.executable,
      args: ["--version"],
      timeoutMs: 30_000,
    });
    version = result.stdout.trim().split(/\s+/)[0];
    if (result.exitCode !== 0) failures.push("Kohaku executable returned a failure");
    if (version !== KOHAKU_VERSION) {
      failures.push(
        `Kohaku version must be ${KOHAKU_VERSION}; received ${version || "no version"}`,
      );
    }
  } catch {
    failures.push("Kohaku executable was not found or could not start");
  }

  const read = options.readFile ?? readFile;
  let provenance: KohakuInstallProvenance | undefined;
  try {
    const raw = await read(join(options.installDir, KOHAKU_PROVENANCE_FILE), "utf8");
    provenance = JSON.parse(raw) as KohakuInstallProvenance;
  } catch {
    failures.push("Kohaku provenance is missing or invalid; reinstall the pinned build");
  }

  if (provenance) {
    if (
      provenance.schemaVersion !== 1 ||
      provenance.repository !== KOHAKU_REPOSITORY ||
      provenance.commit !== KOHAKU_COMMIT ||
      provenance.version !== KOHAKU_VERSION
    ) {
      failures.push("Kohaku provenance does not match the Agent Boost pin");
    } else {
      const files: Array<[keyof KohakuInstallProvenance["sha256"], string]> = [
        ["packageLock", "package-lock.json"],
        ["launcher", "bin/kohaku.mjs"],
        ["bundle", "dist/index.js"],
      ];
      for (const [key, relativePath] of files) {
        try {
          const bytes = await read(join(options.installDir, relativePath));
          const actual = createHash("sha256").update(bytes).digest("hex");
          if (actual !== provenance.sha256?.[key]) {
            failures.push(`Kohaku ${relativePath} does not match installed provenance`);
          }
        } catch {
          failures.push(`Kohaku ${relativePath} is missing or unreadable`);
        }
      }
    }
  }

  const commit = provenance?.commit;
  return {
    passed: failures.length === 0,
    ...(version ? { version } : {}),
    ...(commit ? { commit } : {}),
    detail:
      failures.length === 0
        ? `Kohaku ${KOHAKU_VERSION} at ${KOHAKU_COMMIT.slice(0, 12)} is ready`
        : failures.join("; "),
    failures,
  };
}

function parseOsRelease(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2] ?? "";
    fields[match[1]!] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}
