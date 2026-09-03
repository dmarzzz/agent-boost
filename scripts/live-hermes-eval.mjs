#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stringify as stringifyYaml } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = JSON.parse(
  await readFile(join(root, "evals", "ideal-flows.json"), "utf8"),
);

const expectedTraces = {
  "setup-funding-qr": ["onboarding_start"],
  "ambiguous-amount-clarification": [],
  "confirmed-payment-with-emoji": [
    "capabilities",
    "wallet_get_context",
    "wallet_plan_private_payment",
    "wallet_execute_private_payment",
    "wallet_get_request",
  ],
  "indeterminate-payment-stays-unresolved": [
    "wallet_get_context",
    "wallet_plan_private_payment",
    "wallet_execute_private_payment",
    "wallet_get_request",
  ],
  "local-deny-override": [
    "capabilities",
    "wallet_get_context",
    "wallet_plan_private_payment",
  ],
  "local-allow-override": [
    "capabilities",
    "wallet_get_context",
    "wallet_plan_private_payment",
    "wallet_execute_private_payment",
  ],
  "policy-update-with-confirmation": [
    "wallet_plan_policy_update",
    "wallet_apply_policy_update",
  ],
  "covered-public-read": ["egress_status", "egress_fetch"],
  "covered-read-needs-enrollment": ["egress_status"],
};

const responseRules = {
  "setup-funding-qr": [
    { includes: ["0.2", "Sepolia", "0x1111111111111111111111111111111111111111"], maxLines: 5 },
  ],
  "ambiguous-amount-clarification": [
    { includes: ["exact amount", "0x2222222222222222222222222222222222222222"], maxLines: 2 },
  ],
  "confirmed-payment-with-emoji": [
    { includes: ["0.01", "0x2222222222222222222222222222222222222222", "approve"], maxLines: 5 },
    { includes: ["Sent", "0.01", "0x2222222222222222222222222222222222222222"], maxLines: 4 },
  ],
  "indeterminate-payment-stays-unresolved": [
    { includes: ["0.01", "0x2222222222222222222222222222222222222222", "approve"], maxLines: 5 },
    { includes: ["Not confirmed", "won’t retry"], maxLines: 4 },
  ],
  "local-deny-override": [
    { includes: ["blocked", "security policy"], excludes: ["approve"], maxLines: 3 },
  ],
  "local-allow-override": [
    { includes: ["Sent", "0.01", "0x2222222222222222222222222222222222222222"], excludes: ["approve"], maxLines: 4 },
  ],
  "policy-update-with-confirmation": [
    { includes: ["New wallet permission", "10", "1", "approve"], maxLines: 8 },
    { includes: ["Permission updated", "10", "1", "No funds moved"], maxLines: 4 },
  ],
  "covered-public-read": [
    { includes: ["status", "ok", "no direct fallback"], maxLines: 4 },
  ],
  "covered-read-needs-enrollment": [
    { includes: ["needs", "operator enrollment", "direct request"], maxLines: 3 },
  ],
};

const forbidden = [
  /\bmcp\b/iu,
  /\bwei\b/iu,
  /\b(?:decision_id|request_id|client_request_id|user_confirmed|amount_atomic)\b/iu,
  /\b(?:wallet_get_context|wallet_get_policy|wallet_plan_policy_update|wallet_apply_policy_update|wallet_plan_private_payment|wallet_execute_private_payment|wallet_get_request|egress_status|egress_fetch)\b/iu,
  /\b(?:seed phrase|private key|wallet password)\b/iu,
  /\b(?:wd_|wpd_|req_|sha256:)[A-Za-z0-9._:-]*/u,
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const hermes = resolveExecutable(options.hermes);
  const requested = options.cases.length
    ? new Set(options.cases)
    : new Set(Object.keys(expectedTraces));
  const flows = fixtures.flows.filter((flow) => requested.has(flow.id));
  if (flows.length !== requested.size) {
    const found = new Set(flows.map((flow) => flow.id));
    throw new Error(`Unknown eval case: ${[...requested].find((id) => !found.has(id))}`);
  }

  const reports = [];
  for (const flow of flows) reports.push(await runFlow(flow, hermes, options));
  const report = {
    schema: "org.agentboost.live-hermes-eval",
    schema_version: "1.0",
    passed: reports.every((entry) => entry.passed),
    hermes,
    provider: options.provider ?? "profile default",
    model: options.model ?? "profile default",
    cases: reports,
  };
  if (options.report) {
    await mkdir(dirname(resolve(options.report)), { recursive: true, mode: 0o700 });
    await writeFile(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

async function runFlow(flow, hermes, options) {
  const sandbox = await mkdtemp(join(tmpdir(), `agent-boost-hermes-eval-${flow.id}-`));
  await chmod(sandbox, 0o700);
  const home = join(sandbox, "hermes");
  const tracePath = join(sandbox, "tool-trace.ndjson");
  await mkdir(join(home, "skills", "agent-boost"), { recursive: true, mode: 0o700 });
  await mkdir(join(home, "skills", "agent-boost-setup"), { recursive: true, mode: 0o700 });
  await copyFile(
    join(root, "integrations", "hermes", "agent-boost", "SKILL.md"),
    join(home, "skills", "agent-boost", "SKILL.md"),
  );
  await copyFile(
    join(root, "integrations", "hermes", "agent-boost-setup", "SKILL.md"),
    join(home, "skills", "agent-boost-setup", "SKILL.md"),
  );
  await writeFile(tracePath, "", { mode: 0o600 });
  const tsx = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const config = {
    onboarding: { seen: { busy_input_prompt: true } },
    memory: { enabled: false, write_approval: true },
    skills: { write_approval: true },
    mcp_servers: {
      "agent-boost": {
        command: tsx,
        args: [join(root, "evals", "fake-mcp.ts")],
        env: {
          AGENT_BOOST_EVAL_SCENARIO: flow.scenario,
          AGENT_BOOST_EVAL_TRACE: tracePath,
        },
        enabled: true,
        timeout: 30,
        supports_parallel_tool_calls: false,
        tools: {
          include: [
            "capabilities",
            "onboarding_start",
            "onboarding_status",
            "wallet_get_context",
            "wallet_get_policy",
            "wallet_plan_policy_update",
            "wallet_apply_policy_update",
            "wallet_start_new_demo",
            "wallet_plan_private_payment",
            "wallet_execute_private_payment",
            "wallet_get_request",
            "egress_capabilities",
            "egress_status",
            "egress_fetch",
          ],
          resources: false,
          prompts: false,
        },
      },
    },
    platform_toolsets: { cli: ["agent-boost"] },
  };
  await writeFile(join(home, "config.yaml"), stringifyYaml(config), { mode: 0o600 });

  const environment = { ...process.env };
  environment.HERMES_HOME = home;
  environment.AGENT_BOOST_EVAL_SCENARIO = flow.scenario;
  environment.AGENT_BOOST_EVAL_TRACE = tracePath;
  environment.HERMES_SKIP_UPDATE_CHECK = "1";
  delete environment.HERMES_SESSION_ID;

  const outputs = [];
  let sessionId;
  try {
    for (const step of flow.steps.filter((entry) => entry.actor === "user")) {
      const args = [
        "chat",
        "-q",
        step.text,
        "-Q",
        "--source",
        "tool",
        "--toolsets",
        "agent-boost",
        "--skills",
        flow.id === "setup-funding-qr" ? "agent-boost-setup" : "agent-boost",
        "--max-turns",
        "12",
        ...(sessionId ? ["--resume", sessionId] : []),
        ...(options.model ? ["--model", options.model] : []),
        ...(options.provider ? ["--provider", options.provider] : []),
      ];
      const result = await spawnCapture(hermes, args, {
        cwd: sandbox,
        env: environment,
        timeoutMs: options.timeoutMs,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Hermes exited ${result.exitCode}: ${publicDiagnostic(result.stderr)}`);
      }
      sessionId = parseSessionId(result.stderr) ?? sessionId;
      if (!sessionId) throw new Error("Hermes quiet output did not include a session ID");
      outputs.push(cleanHermesResponse(result.stdout));
    }
    const traces = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const failures = grade(flow.id, outputs, traces);
    return {
      id: flow.id,
      passed: failures.length === 0,
      failures,
      responses: outputs,
      tool_trace: traces.map((entry) => entry.name),
    };
  } catch (error) {
    return {
      id: flow.id,
      passed: false,
      failures: [error instanceof Error ? error.message : String(error)],
      responses: outputs,
      tool_trace: [],
    };
  } finally {
    if (options.keep) {
      process.stderr.write(`Preserved ${flow.id} sandbox: ${sandbox}\n`);
    } else {
      await rm(sandbox, { recursive: true, force: true });
    }
  }
}

function grade(id, outputs, traces) {
  const failures = [];
  const rules = responseRules[id];
  if (outputs.length !== rules.length) {
    failures.push(`expected ${rules.length} assistant turns, received ${outputs.length}`);
  }
  for (let index = 0; index < Math.min(outputs.length, rules.length); index += 1) {
    const output = outputs[index];
    const rule = rules[index];
    if (output.split("\n").length > rule.maxLines) {
      failures.push(`turn ${index + 1} exceeds ${rule.maxLines} lines`);
    }
    for (const required of rule.includes) {
      if (!output.toLocaleLowerCase().includes(required.toLocaleLowerCase())) {
        failures.push(`turn ${index + 1} is missing ${JSON.stringify(required)}`);
      }
    }
    for (const excluded of rule.excludes ?? []) {
      if (output.toLocaleLowerCase().includes(excluded.toLocaleLowerCase())) {
        failures.push(`turn ${index + 1} unexpectedly includes ${JSON.stringify(excluded)}`);
      }
    }
    for (const pattern of forbidden) {
      if (pattern.test(output)) failures.push(`turn ${index + 1} exposes ${pattern}`);
    }
  }
  const names = traces.map((entry) => entry.name);
  if (JSON.stringify(names) !== JSON.stringify(expectedTraces[id])) {
    failures.push(
      `tool trace mismatch: expected ${expectedTraces[id].join(", ") || "none"}; received ${names.join(", ") || "none"}`,
    );
  }
  return failures;
}

function parseArgs(args) {
  const options = { cases: [], keep: false, timeoutMs: 180_000 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") options.keep = true;
    else if (["--hermes", "--case", "--model", "--provider", "--report", "--timeout-ms"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--case") options.cases.push(value);
      else if (arg === "--timeout-ms") options.timeoutMs = Number(value);
      else options[arg.slice(2)] = value;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run eval:live -- --hermes /absolute/path/to/hermes [--case ID] [--provider PROVIDER] [--model MODEL] [--report PATH] [--keep]\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.hermes) throw new Error("--hermes is required");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return options;
}

function resolveExecutable(value) {
  if (!isAbsolute(value)) throw new Error("--hermes must be an absolute path");
  return resolve(value);
}

function parseSessionId(stderr) {
  return stderr.match(/(?:^|\n)session_id:\s*([^\s]+)/u)?.[1];
}

function cleanHermesResponse(stdout) {
  return stdout
    .split("\n")
    .filter((line) =>
      !/^⚠ tirith security scanner enabled but not available\b/iu.test(line.trim())
    )
    .join("\n")
    .trim();
}

function publicDiagnostic(stderr) {
  return stderr
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(/\/(?:Users|home|private|tmp|var|etc|opt|root)\/[^\s"'<>]*/giu, "[redacted-path]")
    .slice(0, 1_000);
}

function spawnCapture(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error(`Hermes eval timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

await main().catch((error) => {
  process.stderr.write(`live Hermes eval: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
