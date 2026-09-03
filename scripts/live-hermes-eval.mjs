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

const canonicalWalletTree = [
  "🗂 wallets/",
  "└── 💼 agent-boost/ [active]",
  "\u00a0\u00a0\u00a0\u00a0├── 🌐 main/ — 1.5 Sepolia ETH · live",
  "\u00a0\u00a0\u00a0\u00a0└── 🥷 private/ — 0.25 Sepolia ETH · live",
  "",
  "Folders organize wallet views; they do not imply custody or control.",
].join("\n");

const expectedTraces = {
  "setup-funding-qr": ["onboarding_start"],
  "setup-partial-funding": ["onboarding_status"],
  "setup-preparing-private-balance": ["onboarding_status"],
  "setup-ready": ["onboarding_status", "capabilities", "wallet_get_tree"],
  "setup-failed": ["onboarding_status"],
  "start-new-demo-wallet": ["wallet_start_new_demo"],
  "advanced-setup-shows-live-policy": ["wallet_get_policy"],
  "wallet-tree-without-identifiers": ["wallet_get_tree"],
  "plain-wallet-overview-uses-tree": ["wallet_get_tree"],
  "saved-wallet-inventory": ["wallet_manage_profiles"],
  "already-active-wallet-needs-no-switch": ["wallet_manage_profiles"],
  "ambiguous-old-wallet": ["wallet_manage_profiles"],
  "load-and-reauthorize-previous-wallet": [
    "wallet_manage_profiles",
    "wallet_select",
    "wallet_plan_reauthorization",
    "wallet_reauthorize",
  ],
  "cancel-wallet-switch": ["wallet_manage_profiles"],
  "ambiguous-amount-clarification": [],
  "confirmed-payment-with-emoji": [
    "capabilities",
    "wallet_get_context",
    "wallet_plan_private_payment",
    "wallet_execute_private_payment",
    "wallet_get_request",
  ],
  "confirmed-regular-transfer": [
    "wallet_get_context",
    "wallet_plan_regular_transfer",
    "wallet_execute_regular_transfer",
    "wallet_get_regular_transfer_request",
  ],
  "regular-transfer-gas-reserve-blocked": [
    "wallet_get_context",
    "wallet_plan_regular_transfer",
  ],
  "chat-regular-transfer-cancelled": [
    "wallet_get_context",
    "wallet_plan_regular_transfer",
    "wallet_execute_regular_transfer",
  ],
  "indeterminate-payment-stays-unresolved": [
    "wallet_get_context",
    "wallet_plan_private_payment",
    "wallet_execute_private_payment",
    "wallet_get_request",
  ],
  "chat-payment-cancelled": [
    "wallet_get_context",
    "wallet_plan_private_payment",
    "wallet_execute_private_payment",
  ],
  "main-balance-read": ["wallet_get_context"],
  "amount-affordability-is-server-computed": ["wallet_get_context"],
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
  "policy-update-cancelled": [
    "wallet_plan_policy_update",
    "wallet_apply_policy_update",
  ],
  "expired-delegation-blocked": [
    "wallet_get_context",
    "wallet_plan_private_payment",
  ],
  "confirmed-exact-recovery": [
    "wallet_plan_recovery_transfer",
    "wallet_execute_recovery_transfer",
    "wallet_get_recovery_request",
  ],
  "covered-public-read": ["egress_status", "egress_fetch"],
  "covered-read-needs-enrollment": ["egress_status"],
};

const optionalTraceTools = {
  "amount-affordability-is-server-computed": new Set(["wallet_get_policy"]),
  "policy-update-with-confirmation": new Set(["wallet_get_policy"]),
};

const alternativeTraceOrders = {
  // Both reads are non-mutating, and either may discover readiness first.
  "setup-ready": [["capabilities", "onboarding_status", "wallet_get_tree"]],
};

const responseRules = {
  "setup-funding-qr": [
    { includes: ["1/3", "0.2", "Sepolia", "0x1111111111111111111111111111111111111111"], maxLines: 7 },
  ],
  "setup-partial-funding": [
    { includes: ["1/3", "0.15", "Next", "check again"], maxLines: 4 },
  ],
  "setup-preparing-private-balance": [
    { includes: ["2/3", "Funding found", "check again"], maxLines: 5 },
  ],
  "setup-ready": [
    {
      includes: ["3/3", "Dark Mode", "wallets/", "Tor", "Sepolia test payment"],
      exactBlock: canonicalWalletTree,
      excludes: ["0x", "Public balance", "Private balance"],
      maxLines: 11,
    },
  ],
  "setup-failed": [
    { includes: ["needs attention", "deadline", "Next"], maxLines: 4 },
  ],
  "start-new-demo-wallet": [
    { includes: ["archive", "fresh wallet", "Sepolia funding"], maxLines: 4 },
    { includes: ["1/3", "0.2", "Next"], maxLines: 5 },
  ],
  "advanced-setup-shows-live-policy": [
    { includes: ["Current wallet permission", "1 send", "0.05", "expiry"], maxLines: 4 },
  ],
  "wallet-tree-without-identifiers": [
    { includes: ["wallets/", "agent-boost/", "main/", "private/", "do not imply custody or control"], exact: canonicalWalletTree, maxLines: 6 },
  ],
  "plain-wallet-overview-uses-tree": [
    {
      includes: ["wallets/", "agent-boost/", "main/", "private/", "do not imply custody or control"],
      exact: canonicalWalletTree,
      maxLines: 6,
    },
  ],
  "saved-wallet-inventory": [
    { includes: ["agent-boost", "active", "saved-wallet", "imported-wallet", "adopt"], maxLines: 6 },
  ],
  "already-active-wallet-needs-no-switch": [
    { includes: ["agent-boost", "already", "active"], excludes: ["confirm", "authorize"], maxLines: 3 },
  ],
  "ambiguous-old-wallet": [
    { includes: ["saved-wallet", "travel-wallet", "which"], excludes: ["wallet_"], maxLines: 3 },
  ],
  "load-and-reauthorize-previous-wallet": [
    { includes: ["saved-wallet", "switch", "signing", "cancel"], maxLines: 5 },
    { includes: ["saved-wallet", "authorize", "0.05", "No funds"], maxLines: 8 },
    { includes: ["saved-wallet", "authorized", "No funds"], maxLines: 4 },
  ],
  "cancel-wallet-switch": [
    { includes: ["saved-wallet", "switch", "signing", "cancel"], maxLines: 5 },
    { includes: ["cancelled", "Nothing changed"], maxLines: 3 },
  ],
  "ambiguous-amount-clarification": [
    { includes: ["exact amount", "0x2222222222222222222222222222222222222222"], maxLines: 2 },
  ],
  "confirmed-payment-with-emoji": [
    { includes: ["Sent", "0.01", "0x2222222222222222222222222222222222222222"], maxLines: 16 },
  ],
  "confirmed-regular-transfer": [
    { includes: ["regular", "0.01", "0x2222222222222222222222222222222222222222", "public", "approve"], maxLines: 9 },
    { includes: ["regular", "0.01", "0x2222222222222222222222222222222222222222", "confirmed"], maxLines: 6 },
  ],
  "regular-transfer-gas-reserve-blocked": [
    {
      includes: ["regular", "blocked", "gas"],
      includesAny: [["Nothing was sent", "No funds sent"]],
      excludes: ["private"],
      maxLines: 6,
    },
  ],
  "chat-regular-transfer-cancelled": [
    { includes: ["regular", "0.01", "0x2222222222222222222222222222222222222222", "public", "cancel"], maxLines: 8 },
    {
      includes: ["cancelled"],
      includesAny: [["Nothing was sent", "No transfer was sent", "No funds were sent"]],
      maxLines: 3,
    },
  ],
  "indeterminate-payment-stays-unresolved": [
    { includes: ["Not confirmed", "won’t retry"], maxLines: 16 },
  ],
  "chat-payment-cancelled": [
    {
      includes: ["cancelled"],
      includesAny: [["Nothing was sent", "No payment was sent", "No funds were sent"]],
      maxLines: 14,
    },
  ],
  "main-balance-read": [
    { includes: ["Main account balance", "0.1 Sepolia ETH"], maxLines: 3 },
  ],
  "amount-affordability-is-server-computed": [
    { includes: ["cannot", "100", "policy"], excludes: ["can send 100", "sufficient funds"], maxLines: 4 },
  ],
  "local-deny-override": [
    { includes: ["blocked", "security policy"], excludes: ["approve"], maxLines: 3 },
  ],
  "local-allow-override": [
    { includes: ["Sent", "0.01", "0x2222222222222222222222222222222222222222"], excludes: ["approve"], maxLines: 4 },
  ],
  "policy-update-with-confirmation": [
    { includes: ["New wallet permission", "10", "1", "approve"], maxLines: 10 },
    { includes: ["Permission updated", "10", "1", "not move"], maxLines: 8 },
  ],
  "policy-update-cancelled": [
    { includes: ["New wallet permission", "10", "1", "approve"], maxLines: 10 },
    {
      includes: ["cancelled", "no funds"],
      includesAny: [["unchanged", "not changed"]],
      maxLines: 3,
    },
  ],
  "expired-delegation-blocked": [
    { includes: ["blocked", "expired", "wallet"], excludes: ["approve"], maxLines: 4 },
  ],
  "confirmed-exact-recovery": [
    { includes: ["recovery", "0.01", "0x2222222222222222222222222222222222222222", "public", "approve"], maxLines: 8 },
    { includes: ["recovery", "0.01", "confirmed", "remaining private balance"], maxLines: 4 },
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
  /\b(?:decision_id|request_id|client_request_id|user_confirmed|wallet_id|wallet_name|amount_atomic|amount_native)\b/iu,
  /\b(?:wallet_get_context|wallet_get_tree|wallet_manage_profiles|wallet_list|wallet_get_policy|wallet_plan_policy_update|wallet_apply_policy_update|wallet_start_new_demo|wallet_create|wallet_adopt_existing|wallet_select|wallet_archive|wallet_plan_reauthorization|wallet_reauthorize|wallet_plan_regular_transfer|wallet_execute_regular_transfer|wallet_get_regular_transfer_request|wallet_plan_private_payment|wallet_execute_private_payment|wallet_get_request|wallet_plan_recovery_transfer|wallet_execute_recovery_transfer|wallet_get_recovery_request|egress_status|egress_fetch)\b/iu,
  /\borg\.agentboost\/model-context\b/iu,
  /\b(?:native|external)\s+(?:approval|confirmation|interface|prompt)\b/iu,
  /\b(?:plan|decision|request|wallet)\s+id\b/iu,
  /\b(?:seed phrase|private key|wallet password)\b/iu,
  /\b(?:(?:wd|wpd|req|rwd|rreq|wra|wr|wrr|wallet|auth|setup|archive)_|sha256:)[A-Za-z0-9._:-]*/u,
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
    provider: options.provider ?? (options.baseUrl ? "custom" : "profile default"),
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
    ...(options.baseUrl
      ? {
          model: {
            provider: options.provider ?? "custom",
            default: options.model,
            base_url: options.baseUrl,
            api_key: "local-eval-not-a-secret",
          },
        }
      : {}),
    mcp_servers: {
      "agent-boost": {
        command: tsx,
        args: [join(root, "evals", "fake-mcp.ts")],
        env: {
          AGENT_BOOST_EVAL_SCENARIO: flow.scenario,
          AGENT_BOOST_EVAL_CASE: flow.id,
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
            "wallet_get_tree",
            "wallet_manage_profiles",
            "wallet_get_policy",
            "wallet_plan_policy_update",
            "wallet_apply_policy_update",
            "wallet_start_new_demo",
            "wallet_create",
            "wallet_adopt_existing",
            "wallet_select",
            "wallet_archive",
            "wallet_plan_reauthorization",
            "wallet_reauthorize",
            "wallet_plan_regular_transfer",
            "wallet_execute_regular_transfer",
            "wallet_get_regular_transfer_request",
            "wallet_plan_private_payment",
            "wallet_execute_private_payment",
            "wallet_get_request",
            "wallet_plan_recovery_transfer",
            "wallet_execute_recovery_transfer",
            "wallet_get_recovery_request",
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
  if (options.baseUrl) {
    await writeFile(
      join(home, ".env"),
      `OPENAI_BASE_URL=${options.baseUrl}\nOPENAI_API_KEY=local-eval-not-a-secret\n`,
      { mode: 0o600 },
    );
  }

  const environment = { ...process.env };
  environment.HERMES_HOME = home;
  environment.AGENT_BOOST_EVAL_SCENARIO = flow.scenario;
  environment.AGENT_BOOST_EVAL_CASE = flow.id;
  environment.AGENT_BOOST_EVAL_TRACE = tracePath;
  environment.HERMES_SKIP_UPDATE_CHECK = "1";
  delete environment.HERMES_SESSION_ID;

  const outputs = [];
  let sessionId;
  try {
    for (const step of flow.steps.filter((entry) => entry.actor === "user")) {
      const usesSetupSkill = flow.id.startsWith("setup-") || [
        "start-new-demo-wallet",
        "advanced-setup-shows-live-policy",
      ].includes(flow.id);
      const skillArgs = flow.skill_loading === "progressive"
        ? []
        : ["--skills", usesSetupSkill ? "agent-boost-setup" : "agent-boost"];
      const args = [
        "chat",
        "-q",
        step.text,
        "-Q",
        "--source",
        "tool",
        "--toolsets",
        "agent-boost",
        ...skillArgs,
        "--max-turns",
        "12",
        ...(sessionId ? ["--resume", sessionId] : []),
        ...(!options.baseUrl && options.model ? ["--model", options.model] : []),
        ...(!options.baseUrl && options.provider ? ["--provider", options.provider] : []),
      ];
      const result = await spawnCapture(hermes, args, {
        cwd: sandbox,
        env: environment,
        timeoutMs: options.timeoutMs,
        stdin: "",
      });
      if (result.exitCode !== 0) {
        const diagnostic = [result.stderr.trim(), result.stdout.trim()]
          .filter(Boolean)
          .join("\n");
        throw new Error(`Hermes exited ${result.exitCode}: ${publicDiagnostic(diagnostic)}`);
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
    if (rule.exact !== undefined && output !== rule.exact) {
      failures.push(`turn ${index + 1} does not exactly match the canonical response`);
    }
    if (rule.exactBlock !== undefined && !output.includes(rule.exactBlock)) {
      failures.push(`turn ${index + 1} is missing the exact canonical response block`);
    }
    const visibleLines = output.split("\n").filter((line) => line.trim().length > 0).length;
    if (visibleLines > rule.maxLines) {
      failures.push(`turn ${index + 1} exceeds ${rule.maxLines} lines`);
    }
    for (const required of rule.includes) {
      if (!output.toLocaleLowerCase().includes(required.toLocaleLowerCase())) {
        failures.push(`turn ${index + 1} is missing ${JSON.stringify(required)}`);
      }
    }
    for (const alternatives of rule.includesAny ?? []) {
      if (!alternatives.some((value) =>
        output.toLocaleLowerCase().includes(value.toLocaleLowerCase())
      )) {
        failures.push(
          `turn ${index + 1} is missing one of ${alternatives.map(JSON.stringify).join(", ")}`,
        );
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
  const optional = optionalTraceTools[id] ?? new Set();
  const names = traces
    .map((entry) => entry.name)
    .filter((name) => !optional.has(name));
  const acceptedTraces = [
    expectedTraces[id],
    ...(alternativeTraceOrders[id] ?? []),
  ];
  if (!acceptedTraces.some((trace) => JSON.stringify(names) === JSON.stringify(trace))) {
    failures.push(
      `tool trace mismatch: expected ${acceptedTraces.map((trace) => trace.join(", ") || "none").join(" or ")}; received ${names.join(", ") || "none"}`,
    );
  }
  return failures;
}

function parseArgs(args) {
  const options = { cases: [], keep: false, timeoutMs: 180_000 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") options.keep = true;
    else if (["--hermes", "--case", "--model", "--provider", "--base-url", "--report", "--timeout-ms"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--case") options.cases.push(value);
      else if (arg === "--timeout-ms") options.timeoutMs = Number(value);
      else if (arg === "--base-url") options.baseUrl = value;
      else options[arg.slice(2)] = value;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run eval:live -- --hermes /absolute/path/to/hermes [--case ID] [--provider PROVIDER] [--model MODEL] [--base-url URL] [--report PATH] [--keep]\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.hermes) throw new Error("--hermes is required");
  if (options.baseUrl) {
    if (!options.model) throw new Error("--base-url requires --model");
    const baseUrl = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(baseUrl.protocol)) {
      throw new Error("--base-url must use http or https");
    }
    if (!["127.0.0.1", "::1", "localhost"].includes(baseUrl.hostname)) {
      throw new Error("--base-url is limited to a loopback model endpoint");
    }
  }
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
    .replace(/\b(?:gh[opsu]|sk|key|token)_[A-Za-z0-9_-]{8,}\b/giu, "[redacted-secret]")
    .slice(0, 1_000);
}

function spawnCapture(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(options.stdin ?? "");
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
