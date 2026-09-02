import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { AgentBoostConfig } from "../config.js";
import { fetchThroughShadeTreeProxy } from "./http.js";
import { shadeTreeHostPin } from "./pin.js";
import { validateCoveredUrl } from "./policy.js";
import type {
  CoveredEgressPort,
  CoveredEgressStatus,
  CoveredFetchInput,
  CoveredFetchResult,
} from "./types.js";

interface AccessProfile {
  version: 1;
  protocol: 4;
  bootnodeOnion: string;
  directorySigner: string;
}

export class ShadeTreeEgress implements CoveredEgressPort {
  readonly #config: AgentBoostConfig;
  #process: ChildProcess | undefined;
  #token: string | undefined;
  #status: CoveredEgressStatus;
  #startPromise: Promise<void> | undefined;
  #diagnostic = "";

  constructor(config: AgentBoostConfig) {
    this.#config = config;
    this.#status = config.shadeTreeEnabled
      ? { status: "not_installed", code: "SHADE_TREE_NOT_INSTALLED", detail: "Covered egress dependency is not installed" }
      : { status: "disabled", code: "SHADE_TREE_DISABLED", detail: "Covered egress is disabled by local configuration" };
  }

  capabilities(): Record<string, unknown> {
    return {
      contract: "org.agentboost.egress/0.1",
      mode: "explicit_fetch",
      route: "shade-tree-v4-over-tor",
      methods: ["GET", "HEAD"],
      schemes: ["https"],
      destination_ports: [443],
      allowed_response_types: ["application/json", "text/*", "application/*+json"],
      max_response_bytes: this.#config.shadeTreeMaxResponseBytes,
      max_redirects: 3,
      timeout_ms: this.#config.shadeTreeRequestTimeoutMs,
      policy: {
        direct_fallback: false,
        request_bodies: "deny",
        credentials: "deny",
        private_destinations: "deny",
        arbitrary_headers: "deny",
        whole_agent_proxy: "deny",
      },
      privacy: {
        claim: "privacy-improving covered HTTPS egress",
        guarantees_anonymity: false,
        destination_sees: "Shade Tree node egress IP",
        node_sees: ["destination hostname", "port", "timing", "lifetime", "traffic volume"],
        node_does_not_see_with_valid_tls: ["URL path", "query", "response body"],
        timing_correlation_resistant: false,
      },
    };
  }

  async start(): Promise<void> {
    this.#startPromise ??= this.#start().finally(() => {
      this.#startPromise = undefined;
    });
    await this.#startPromise;
  }

  async #start(): Promise<void> {
    if (!this.#config.shadeTreeEnabled || this.#process) return;
    const prerequisites = await this.#loadPrerequisites();
    if (!prerequisites) return;
    this.#status = { status: "starting", code: "SHADE_TREE_STARTING", detail: "Starting authenticated loopback Proxy" };
    await mkdir(this.#config.shadeTreeSlotStateDir, { recursive: true, mode: 0o700 });
    await chmod(this.#config.shadeTreeSlotStateDir, 0o700);
    const token = randomBytes(32).toString("base64url");
    const args = [
      "proxy",
      "--bootnode-onion", prerequisites.access.bootnodeOnion,
      "--signer", prerequisites.access.directorySigner,
      "--identity", prerequisites.identity,
      "--members", prerequisites.members,
      "--leaf-source", "invited",
      "--max-anon",
      "--cache", join(this.#config.shadeTreeProfileDir, "directory-lkg.json"),
      "--health-cache", join(this.#config.shadeTreeProfileDir, "health-cache.json"),
      "--listen", `127.0.0.1:${this.#config.shadeTreeProxyPort}`,
    ];
    const child = spawn(this.#config.shadeTreeBin, args, {
      env: {
        ...process.env,
        SHADE_TREE_PROXY_TOKEN: token,
        SHADE_TREE_SLOT_STATE_DIR: this.#config.shadeTreeSlotStateDir,
      },
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
    this.#process = child;
    this.#token = token;
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#diagnostic = `${this.#diagnostic}${chunk.toString("utf8")}`.slice(-4_096);
    });
    child.once("exit", (code) => {
      if (this.#process !== child) return;
      this.#process = undefined;
      this.#token = undefined;
      const diagnostic = classifyProcessFailure(this.#diagnostic);
      this.#status = {
        status: diagnostic.exhausted ? "exhausted" : "failed",
        code: diagnostic.exhausted ? "SHADE_TREE_EPOCH_EXHAUSTED" : "SHADE_TREE_PROXY_EXITED",
        detail: code === null ? "Covered egress Proxy stopped" : `Covered egress Proxy exited with code ${code}`,
      };
    });
    child.once("error", () => undefined);
    try {
      await waitForAuthenticatedHealth(
        this.#config.shadeTreeProxyPort,
        token,
        this.#config.shadeTreeStartTimeoutMs,
        child,
      );
      this.#status = { status: "ready", code: "SHADE_TREE_READY", detail: "Covered HTTPS egress is ready" };
    } catch (error) {
      await this.stop();
      this.#status = {
        status: "failed",
        code: "SHADE_TREE_START_FAILED",
        detail: error instanceof Error ? error.message.slice(0, 240) : "Covered egress failed to start",
      };
    }
  }

  async stop(): Promise<void> {
    const child = this.#process;
    this.#process = undefined;
    this.#token = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  async status(): Promise<CoveredEgressStatus> {
    if (this.#config.shadeTreeEnabled && !this.#process && this.#status.status !== "failed" && this.#status.status !== "exhausted") {
      await this.#loadPrerequisites();
    }
    return { ...this.#status };
  }

  async fetch(input: CoveredFetchInput): Promise<CoveredFetchResult> {
    const method = input.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      throw new Error("COVERED_EGRESS_POLICY_DENIED: only GET and HEAD are allowed");
    }
    validateCoveredUrl(input.url);
    await this.start();
    const status = await this.status();
    if (status.status !== "ready" || !this.#token) {
      throw new Error(`${status.code}: ${status.detail}`);
    }
    try {
      return await fetchThroughShadeTreeProxy(input.url, method, {
        host: "127.0.0.1",
        port: this.#config.shadeTreeProxyPort,
        token: this.#token,
        timeoutMs: this.#config.shadeTreeRequestTimeoutMs,
        maxBytes: this.#config.shadeTreeMaxResponseBytes,
        maxRedirects: 3,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/exhausted|slot|budget/iu.test(message)) {
        this.#status = { status: "exhausted", code: "SHADE_TREE_EPOCH_EXHAUSTED", detail: "Covered egress epoch budget is exhausted" };
      } else if (/tunnel|proxy|connect|timed out/iu.test(message)) {
        this.#status = { status: "degraded", code: "SHADE_TREE_DEGRADED", detail: "Covered egress tunnel failed; no direct fallback was attempted" };
      }
      throw error;
    }
  }

  async #loadPrerequisites(): Promise<{
    access: AccessProfile;
    identity: string;
    members: string;
  } | undefined> {
    try {
      const metadata = await lstat(this.#config.shadeTreeBin);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("binary is not a regular file");
      await realpath(this.#config.shadeTreeBin);
      const pin = shadeTreeHostPin(process.platform, process.arch);
      if (!pin) throw new Error("no pinned live client exists for this host");
      const digest = createHash("sha256")
        .update(await readFile(this.#config.shadeTreeBin))
        .digest("hex");
      if (digest !== pin.sha256) throw new Error("binary digest does not match the release pin");
    } catch {
      this.#status = { status: "not_installed", code: "SHADE_TREE_NOT_INSTALLED", detail: "Install the pinned Shade Tree live client" };
      return undefined;
    }
    const identity = join(this.#config.shadeTreeProfileDir, "identity.json");
    const members = join(this.#config.shadeTreeProfileDir, "members.json");
    const accessPath = join(this.#config.shadeTreeProfileDir, "access.json");
    try {
      await Promise.all([assertOwnerFile(identity), assertOwnerFile(members), assertOwnerFile(accessPath)]);
      const access = parseAccessProfile(await readFile(accessPath, "utf8"));
      this.#status = this.#process
        ? this.#status
        : { status: "starting", code: "SHADE_TREE_ENROLLED", detail: "Enrollment profile is present; Proxy has not started yet" };
      return { access, identity, members };
    } catch {
      this.#status = { status: "needs_enrollment", code: "SHADE_TREE_NEEDS_ENROLLMENT", detail: "A Grove operator must admit this local identity and provision its matching access profile" };
      return undefined;
    }
  }
}

function parseAccessProfile(raw: string): AccessProfile {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "bootnodeOnion,directorySigner,protocol,version") {
    throw new Error("access profile has an unexpected shape");
  }
  if (
    value.version !== 1 ||
    value.protocol !== 4 ||
    typeof value.bootnodeOnion !== "string" ||
    !/^[a-z2-7]{56}\.onion$/u.test(value.bootnodeOnion) ||
    typeof value.directorySigner !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.directorySigner)
  ) {
    throw new Error("access profile is invalid");
  }
  return value as unknown as AccessProfile;
}

async function assertOwnerFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${path} must be a regular file`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${path} must not be group/world accessible`);
  await realpath(path);
}

async function waitForAuthenticatedHealth(
  port: number,
  token: string,
  timeoutMs: number,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Covered egress Proxy exited during startup");
    try {
      await authenticatedHealth(port, token);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Covered egress Proxy did not become ready within ${timeoutMs}ms`);
}

async function authenticatedHealth(port: number, token: string): Promise<void> {
  const { connect } = await import("node:net");
  const socket = connect({ host: "127.0.0.1", port });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const auth = Buffer.from(`shade-tree:${token}`).toString("base64");
    socket.write(
      `GET /_shade_tree/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      `Proxy-Authorization: Basic ${auth}\r\nConnection: close\r\n\r\n`,
    );
    const response = await new Promise<string>((resolve, reject) => {
      socket.once("data", (data) => resolve(data.toString("latin1")));
      socket.once("error", reject);
    });
    if (!response.startsWith("HTTP/1.1 204 ")) throw new Error("Proxy health authentication failed");
  } finally {
    socket.destroy();
  }
}

function classifyProcessFailure(diagnostic: string): { exhausted: boolean } {
  return { exhausted: /epoch budget exhausted|used [0-9]+\/[0-9]+ slots/iu.test(diagnostic) };
}
