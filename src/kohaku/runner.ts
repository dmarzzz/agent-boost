import { spawn } from "node:child_process";

export interface CommandInvocation {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(invocation: CommandInvocation): Promise<CommandResult>;
}

export interface SpawnCommandRunnerOptions {
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Executes a binary directly with an argv array. It never invokes a shell, so
 * wallet names, paths, and RPC URLs cannot become shell syntax.
 */
export class SpawnCommandRunner implements CommandRunner {
  readonly #defaultTimeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: SpawnCommandRunnerOptions = {}) {
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 15 * 60_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#defaultTimeoutMs) || this.#defaultTimeoutMs <= 0) {
      throw new Error("Command timeout must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#maxOutputBytes) || this.#maxOutputBytes <= 0) {
      throw new Error("Command output limit must be a positive integer");
    }
  }

  run(invocation: CommandInvocation): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const childEnvironment = { ...process.env };
      // Do not allow the parent shell to silently disable Kohaku's Tor path or
      // introduce an unrelated proxy/direct fallback into this security boundary.
      delete childEnvironment.KOHAKU_WITHOUT_TOR;
      delete childEnvironment.HTTP_PROXY;
      delete childEnvironment.HTTPS_PROXY;
      delete childEnvironment.ALL_PROXY;
      delete childEnvironment.NO_PROXY;
      delete childEnvironment.NODE_USE_ENV_PROXY;
      delete childEnvironment.http_proxy;
      delete childEnvironment.https_proxy;
      delete childEnvironment.all_proxy;
      delete childEnvironment.no_proxy;
      delete childEnvironment.node_use_env_proxy;
      delete childEnvironment.NODE_OPTIONS;
      delete childEnvironment.AGENT_BOOST_RPC_URL;
      delete childEnvironment.RPC_URL;
      delete childEnvironment.AGENT_BOOST_ALLOWED_RPC_URL;
      if (invocation.env) Object.assign(childEnvironment, invocation.env);
      const child = spawn(invocation.executable, [...invocation.args], {
        cwd: invocation.cwd,
        env: childEnvironment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;

      const finish = (
        callback: () => void,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      const capture = (destination: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > this.#maxOutputBytes) {
          child.kill("SIGKILL");
          finish(() =>
            reject(
              new Error(
                `Command output exceeded ${this.#maxOutputBytes.toString()} bytes`,
              ),
            ),
          );
          return;
        }
        destination.push(chunk);
      };

      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (exitCode, signal) => {
        finish(() => {
          if (exitCode === null) {
            reject(new Error(`Command exited after signal ${signal ?? "unknown"}`));
            return;
          }
          resolve({
            exitCode,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
      });

      const timeoutMs = invocation.timeoutMs ?? this.#defaultTimeoutMs;
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() =>
          reject(new Error(`Command timed out after ${timeoutMs.toString()}ms`)),
        );
      }, timeoutMs);
      timeout.unref();
    });
  }
}
