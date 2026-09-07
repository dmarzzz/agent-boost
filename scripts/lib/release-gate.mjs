import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";

const EXPECTED_KOHAKU_COMMIT = "fcf9defa4d5ff7f63222f1b3bbe2d30e631ceffd";
const EXPECTED_FUNDING_WEI = "200000000000000000";
const EXPECTED_FUNDING_ETH = "0.2";
const EXPECTED_CHAIN_ID = "eip155:11155111";
const EXPECTED_MCP_DISCOVERY_TIMEOUT_SECONDS = 60;
const HERMES_TURN_GATE_PRE_MATCHER = ".*";
const HERMES_TURN_GATE_POST_MATCHER = "(?:mcp__agent_boost__.*|tool_call)";
const HERMES_TURN_GATE_TIMEOUT_SECONDS = 5;
export const HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK = [
  "[BEGIN AGENT BOOST MANAGED ROUTING]",
  "Agent Boost wallet rules:",
  "- An unqualified transfer from a named wallet, profile, or main account is regular/public. For an explicit regular/public send from <parent>/<pocket>, put the parent in source and the child in source_private_balance; if only the pocket or its public change is named, use $selected as source and that child name in source_private_balance. It remains regular, not private. The word private inside a saved-wallet friendly name never selects private mode or a child pocket; only an explicit private, shielded, from-private, recovery, or unshield request does. Route mode first: regular/public -> wallet_preview_regular_transfer; private/shielded -> wallet_preview_private_transfer; recovery/private-to-main -> wallet_preview_recovery_transfer. Do this even when the source is named or inactive; never list or load it first. Treat destination names as lookups; never infer wallet creation.",
  "- A private balance is a named child pocket under one saved wallet, not another top-level wallet. Use wallet_preview_private_balance_create to add one, wallet_preview_private_balance_fund to fund one, and the private-balance policy tools for its own limits. For funding, wallet_name is the parent; source=$main means that parent's public account, otherwise source is an exact sibling pocket name. Its nested public-change balance stays under that child and is regular-sendable. Use wallet_get_tree for the overview.",
  "- Any preview or result that asks for approval ends this assistant turn. Continue only after a later actual user turn; all approval happens through that chat reply, never an app, popup, or other confirmation surface. Never manufacture, quote, simulate, or impersonate user input.",
  "- Never put raw tool/function-call syntax (including <function> tags) or internal tool, decision, or request IDs in user-facing text.",
  "- A canonical transfer execution performs one no-rebroadcast verification read itself and returns the final, unresolved, or explicitly unverified state. Do not add another tool call in that assistant turn. A matching wallet_get_*_request tool is only for a later user status request; never execute again to check.",
  "- When the latest trusted Agent Boost result requested a status follow-up, a fresh user message such as check again starts a new read-only turn. Perform exactly one fresh read for that matching setup or unresolved operation; never answer from an older balance, phase, or tree. Repeating a read across user turns is allowed and required. This never permits repeating an execute, apply, create, fund, shield, or broadcast action.",
  "[END AGENT BOOST MANAGED ROUTING]",
].join("\n");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const HERMES_NATIVE_TOOLS = [
  "capabilities",
  "onboarding_start",
  "onboarding_status",
  "wallet_get_main_balance",
  "wallet_list_saved_profiles",
  "wallet_get_tree",
  "wallet_preview_private_balance_create",
  "wallet_apply_private_balance_create",
  "wallet_preview_private_balance_fund",
  "wallet_apply_private_balance_fund",
  "wallet_get_private_balance_operation",
  "wallet_get_private_balance_policy",
  "wallet_preview_private_balance_policy_update",
  "wallet_apply_private_balance_policy_update",
  "wallet_create",
  "wallet_adopt_existing",
  "wallet_preview_saved_profile_load",
  "wallet_apply_saved_profile_load",
  "wallet_archive",
  "wallet_plan_reauthorization",
  "wallet_apply_reauthorization",
  "wallet_get_policy",
  "wallet_plan_policy_update",
  "wallet_apply_policy_update",
  "wallet_start_new_demo",
  "wallet_preview_regular_transfer",
  "wallet_execute_regular_transfer",
  "wallet_get_regular_transfer_request",
  "wallet_preview_private_transfer",
  "wallet_execute_private_transfer",
  "wallet_get_private_transfer_request",
  "wallet_preview_recovery_transfer",
  "wallet_execute_recovery_transfer",
  "wallet_get_recovery_request",
  "egress_capabilities",
  "egress_status",
  "egress_fetch",
];
export const AGENT_BOOST_MCP_TOOL_COUNT = 54;
const HERMES_SKILL_NAMES = [
  "agent-boost-setup",
  "agent-boost",
  "agent-boost-wallet-tree",
  "agent-boost-wallets",
  "agent-boost-policy",
  "agent-boost-transfers",
  "agent-boost-wallet-actions",
  "agent-boost-authorize",
  "agent-boost-confirm",
  "agent-boost-covered-web",
];

const ENVELOPE_KEYS = [
  "code",
  "data",
  "manifest_digest",
  "outcome",
  "presentation",
  "retry",
  "schema",
  "schema_version",
];
const START_DATA_KEYS = ["funding", "public", "setup", "ui_opened"];
const SETUP_KEYS = [
  "address",
  "createdAt",
  "delegation",
  "error",
  "phase",
  "privateBalanceWei",
  "publicBalanceWei",
  "requiredFundingWei",
  "revision",
  "setupId",
  "shieldAmountWei",
  "updatedAt",
  "version",
];
const PUBLIC_KEYS = [
  "address",
  "delegation",
  "error",
  "phase",
  "privateBalanceWei",
  "publicBalanceWei",
  "requiredFundingWei",
  "revision",
  "rpcRoute",
  "setupId",
  "shieldAmountWei",
];
const FUNDING_KEYS = [
  "address",
  "asset",
  "chain_id",
  "funding_uri",
  "network",
  "qr_attached",
  "remaining_amount_eth",
  "remaining_amount_wei",
];

const LEAK_PATTERNS = [
  { label: "loopback host", pattern: /(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)/iu },
  { label: "local UI field", pattern: /(?:uiUrl|ui_url)/u },
  {
    label: "local filesystem path",
    pattern: /(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/|[A-Z]:\\Users\\)/u,
  },
  {
    label: "upstream RPC endpoint",
    pattern: /(?:AGENT_BOOST_RPC_URL|ethereum-sepolia-rpc|publicnode\.com)/iu,
  },
  {
    label: "secret material",
    pattern: /(?:private[_ -]?key|seed phrase|mnemonic|kohaku-password|rpc credential)/iu,
  },
];

export function buildIsolatedEnvironment(baseEnvironment, paths) {
  const environment = {};
  for (const [name, value] of Object.entries(baseEnvironment ?? {})) {
    if (value === undefined) continue;
    if (name.startsWith("AGENT_BOOST_")) continue;
    if (
      name === "HERMES_HOME" ||
      name === "NODE_OPTIONS" ||
      name === "NPM_CONFIG_PREFIX"
    ) {
      continue;
    }
    environment[name] = value;
  }
  environment.PATH = [paths.commandBin, paths.prefixBin, environment.PATH]
    .filter(Boolean)
    .join(delimiter);
  environment.HERMES_HOME = paths.hermesHome;
  environment.AGENT_BOOST_PREFIX = paths.prefix;
  environment.AGENT_BOOST_KOHAKU_INSTALL_DIR = paths.kohakuInstallDir;
  environment.AGENT_BOOST_SHADE_TREE_INSTALL_DIR = paths.shadeTreeInstallDir;
  environment.AGENT_BOOST_STATE_DIR = paths.stateDir;
  environment.AGENT_BOOST_TOR_DATA_DIR = paths.torDataDir;
  environment.AGENT_BOOST_KOHAKU_DATA_DIR = paths.kohakuDataDir;
  environment.AGENT_BOOST_KOHAKU_PASSWORD_FILE = paths.passwordFile;
  environment.AGENT_BOOST_OPEN_UI = "false";
  environment.AGENT_BOOST_UI_PORT = String(paths.uiPort);
  environment.AGENT_BOOST_TOR_RPC_PORT = String(paths.torRpcPort);
  environment.AGENT_BOOST_SHADE_TREE_PROXY_PORT = String(paths.shadeTreeProxyPort);
  return environment;
}

export function assertNoPublicLeaks(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const leak of LEAK_PATTERNS) {
    if (leak.pattern.test(serialized)) {
      throw new Error(`Public onboarding output contains ${leak.label}`);
    }
  }
}

export function validateOnboardingResult(response, options = {}) {
  const structured = record(response?.structuredContent, "structuredContent");
  exactKeys(structured, ENVELOPE_KEYS, "onboarding envelope");
  if (structured.schema !== "org.agentboost.tool-result") {
    throw new Error("Unexpected onboarding result schema");
  }
  if (structured.outcome !== "awaiting_funding") {
    throw new Error(`Expected awaiting_funding, received ${String(structured.outcome)}`);
  }
  const data = record(structured.data, "data");
  validateFundingPresentation(structured.presentation);
  exactKeys(data, START_DATA_KEYS, "onboarding data");
  if (options.expectUiOpened === false && data.ui_opened !== false) {
    throw new Error("Headless release gate unexpectedly opened a UI");
  }

  const setup = record(data.setup, "data.setup");
  const publicSnapshot = record(data.public, "data.public");
  const funding = record(data.funding, "data.funding");
  allowedKeys(setup, SETUP_KEYS, "data.setup");
  allowedKeys(publicSnapshot, PUBLIC_KEYS, "data.public");
  exactKeys(funding, FUNDING_KEYS, "data.funding");

  const setupId = stringValue(setup.setupId, "data.setup.setupId");
  const address = stringValue(funding.address, "data.funding.address");
  if (!/^0x[0-9a-fA-F]{40}$/u.test(address)) {
    throw new Error("Funding address is not a valid Ethereum address");
  }
  if (setup.address !== address || publicSnapshot.address !== address) {
    throw new Error("Funding address disagrees with the onboarding snapshots");
  }
  if (funding.chain_id !== EXPECTED_CHAIN_ID || funding.network !== "Sepolia") {
    throw new Error("Funding projection is not Sepolia");
  }
  if (
    funding.remaining_amount_wei !== EXPECTED_FUNDING_WEI ||
    funding.remaining_amount_eth !== EXPECTED_FUNDING_ETH
  ) {
    throw new Error("Fresh onboarding did not request exactly 0.2 Sepolia ETH");
  }
  const expectedFundingUri =
    `ethereum:${address}@11155111?value=${EXPECTED_FUNDING_WEI}`;
  if (funding.funding_uri !== expectedFundingUri) {
    throw new Error("Funding URI does not match the exact address and amount");
  }
  if (funding.qr_attached !== true) {
    throw new Error("onboarding_start did not mark its QR as attached");
  }

  const content = Array.isArray(response?.content) ? response.content : [];
  const images = content.filter((block) => block?.type === "image");
  if (images.length !== 1 || images[0]?.mimeType !== "image/png") {
    throw new Error("onboarding_start must return exactly one PNG image block");
  }
  const png = Buffer.from(stringValue(images[0]?.data, "PNG image data"), "base64");
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("onboarding_start image block is not a valid PNG payload");
  }

  assertNoPublicLeaks(response);
  return {
    setupId,
    address,
    fundingUri: expectedFundingUri,
    revision: integerValue(setup.revision, "data.setup.revision"),
    qrSha256: createHash("sha256").update(png).digest("hex"),
  };
}

export function validateOnboardingStatus(response, expected) {
  const structured = record(response?.structuredContent, "structuredContent");
  exactKeys(structured, ENVELOPE_KEYS, "onboarding status envelope");
  if (
    structured.schema !== "org.agentboost.tool-result" ||
    structured.outcome !== "awaiting_funding"
  ) {
    throw new Error("Unexpected onboarding_status envelope");
  }
  const data = record(structured.data, "data");
  validateFundingPresentation(structured.presentation);
  exactKeys(data, ["funding", "setup"], "onboarding status data");
  const setup = record(data.setup, "data.setup");
  const funding = record(data.funding, "data.funding");
  allowedKeys(setup, SETUP_KEYS, "data.setup");
  exactKeys(funding, FUNDING_KEYS, "data.funding");
  if (setup.setupId !== expected.setupId || setup.address !== expected.address) {
    throw new Error("onboarding_status did not preserve the setup and address");
  }
  if (
    funding.address !== expected.address ||
    funding.funding_uri !== expected.fundingUri ||
    funding.remaining_amount_wei !== EXPECTED_FUNDING_WEI ||
    funding.remaining_amount_eth !== EXPECTED_FUNDING_ETH
  ) {
    throw new Error("onboarding_status funding fallback changed unexpectedly");
  }
  if (funding.qr_attached !== false) {
    throw new Error("onboarding_status incorrectly claims to attach a QR");
  }
  assertNoPublicLeaks(response);
}

function validateFundingPresentation(value) {
  const presentation = record(value, "presentation");
  if (
    presentation.version !== "1.0" ||
    presentation.kind !== "progress" ||
    presentation.state !== "active"
  ) {
    throw new Error("Onboarding presentation contract changed");
  }
  const step = record(presentation.step, "presentation.step");
  if (step.current !== 1 || step.total !== 3 || step.label !== "Fund test wallet") {
    throw new Error("Onboarding funding step is not the required 1/3 sequence");
  }
}

export function validatePersistence(first, repeated, label = "retry") {
  if (
    first.setupId !== repeated.setupId ||
    first.address !== repeated.address ||
    first.fundingUri !== repeated.fundingUri
  ) {
    throw new Error(`${label} replaced the durable onboarding wallet`);
  }
  if (repeated.revision < first.revision) {
    throw new Error(`${label} moved the onboarding revision backwards`);
  }
}

export async function verifyInstalledHermes(options) {
  const install = record(options.installResult, "installer output");
  if (install.installed !== true) throw new Error("Agent Boost installer did not succeed");
  const agentBoost = record(install.agent_boost, "installer agent_boost");
  const kohaku = record(install.kohaku, "installer kohaku");
  const shadeTree = record(install.shade_tree, "installer shade_tree");
  const hermes = record(install.hermes, "installer hermes");
  const realSandboxRoot = await realpath(options.sandboxRoot);
  if (kohaku.commit !== EXPECTED_KOHAKU_COMMIT) {
    throw new Error("Installer did not use the pinned Kohaku commit");
  }
  if (shadeTree.version !== "0.4.0") {
    throw new Error("Installer did not report the pinned Shade Tree release");
  }
  if (shadeTree.available === true) {
    const shadeTreeExecutable = await realpath(
      stringValue(shadeTree.executable, "Shade Tree executable"),
    );
    assertWithin(realSandboxRoot, shadeTreeExecutable, "Shade Tree executable");
    if (!/^[0-9a-f]{64}$/u.test(stringValue(shadeTree.sha256, "Shade Tree SHA-256"))) {
      throw new Error("Installer did not report a Shade Tree SHA-256 pin");
    }
  } else if (shadeTree.status !== "unsupported") {
    throw new Error("Installer returned an unexpected Shade Tree availability state");
  }
  if (hermes.status !== "configured") {
    throw new Error("Hermes was not configured during the clean install");
  }

  const reportedExecutable = stringValue(
    agentBoost.executable,
    "Agent Boost executable",
  );
  const executable = await realpath(reportedExecutable);
  assertWithin(realSandboxRoot, executable, "Agent Boost executable");
  const turnGateArtifact = await realpath(join(dirname(executable), "hermes", "turn-gate.js"));
  assertWithin(realSandboxRoot, turnGateArtifact, "Agent Boost turn-gate artifact");
  const turnGateMetadata = await lstat(turnGateArtifact);
  if (!turnGateMetadata.isFile() || turnGateMetadata.isSymbolicLink()) {
    throw new Error("Installed package is missing dist/hermes/turn-gate.js");
  }
  const candidateTurnGateArtifact = join(
    options.candidateRoot,
    "dist",
    "hermes",
    "turn-gate.js",
  );
  const [installedTurnGate, candidateTurnGate] = await Promise.all([
    readFile(turnGateArtifact),
    readFile(candidateTurnGateArtifact),
  ]);
  if (!installedTurnGate.equals(candidateTurnGate)) {
    throw new Error("Packaged dist/hermes/turn-gate.js differs from the candidate build");
  }
  const hermesResult = record(hermes.result, "Hermes installer result");
  if (hermesResult.installed !== true) {
    throw new Error("Hermes installer result did not report success");
  }
  if (hermesResult.config_changed !== true) {
    throw new Error("Clean Hermes profile did not report a new Agent Boost config entry");
  }
  const [configPath, realHermesHome] = await Promise.all([
    realpath(stringValue(hermesResult.config_path, "Hermes config path")),
    realpath(options.hermesHome),
  ]);
  assertWithin(realHermesHome, configPath, "Hermes config path");
  const config = record(parseYaml(await readFile(configPath, "utf8")), "Hermes config");
  const agent = record(config.agent, "Hermes agent settings");
  if (agent.tool_use_enforcement !== true) {
    throw new Error("Hermes config did not default agent.tool_use_enforcement to true");
  }
  for (const key of [
    "execution_guidance",
    "task_completion_guidance",
    "parallel_tool_call_guidance",
  ]) {
    if (agent[key] !== false) {
      throw new Error(`Hermes config did not default agent.${key} to false`);
    }
  }
  if (agent.system_prompt !== HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK) {
    throw new Error("Hermes config does not contain the exact managed Agent Boost routing prompt");
  }
  if (hooksAutoAcceptEnabled(config.hooks_auto_accept)) {
    throw new Error("Hermes config enabled blanket hook auto-acceptance");
  }
  if (
    config.mcp_discovery_timeout !== EXPECTED_MCP_DISCOVERY_TIMEOUT_SECONDS ||
    config.mcp_single_query_discovery_timeout !==
      EXPECTED_MCP_DISCOVERY_TIMEOUT_SECONDS
  ) {
    throw new Error(
      "Hermes config did not reserve enough startup time for cold Agent Boost MCP discovery",
    );
  }
  if (record(config.display, "Hermes display settings").busy_input_mode !== "queue") {
    throw new Error("Hermes config did not default busy input handling to queue");
  }
  const plugins = record(config.plugins, "Hermes plugins");
  const enabledPlugins = plugins.enabled;
  if (!Array.isArray(enabledPlugins) || !enabledPlugins.includes("agent-boost-output-guard")) {
    throw new Error("Hermes config did not enable the Agent Boost output guard");
  }
  const pluginEntries = record(plugins.entries, "Hermes plugin entries");
  const outputGuardEntry = record(
    pluginEntries["agent-boost-output-guard"],
    "Hermes Agent Boost output-guard entry",
  );
  const outputGuardSettings = record(
    outputGuardEntry.settings,
    "Hermes Agent Boost output-guard settings",
  );
  if (outputGuardSettings.turn_gate_executable !== executable) {
    throw new Error(
      "Hermes output guard does not use the installed exact Agent Boost executable",
    );
  }
  const servers = record(config.mcp_servers, "Hermes mcp_servers");
  const server = record(servers["agent-boost"], "Hermes agent-boost server");
  if (await realpath(stringValue(server.command, "Hermes server command")) !== executable) {
    throw new Error("Hermes config does not use the installed absolute Agent Boost executable");
  }
  if (JSON.stringify(server.args) !== JSON.stringify(["mcp", "--mode", "dark", "--contract-major", "1"])) {
    throw new Error("Hermes config has unexpected Agent Boost arguments");
  }
  if (
    server.enabled !== true ||
    server.timeout !== 360 ||
    server.supports_parallel_tool_calls !== false
  ) {
    throw new Error("Hermes config has unexpected Agent Boost runtime settings");
  }
  const configuredTools = record(server.tools, "Hermes Agent Boost tools");
  if (
    JSON.stringify(configuredTools.include) !== JSON.stringify(HERMES_NATIVE_TOOLS) ||
    configuredTools.resources !== false ||
    configuredTools.prompts !== false
  ) {
    throw new Error("Hermes config has unexpected Agent Boost tool exposure");
  }

  const expectedTurnGateCommand = hermesTurnGateCommand(executable);
  const expectedHooks = expectedHermesTurnGateHooks(expectedTurnGateCommand);
  if (JSON.stringify(config.hooks) !== JSON.stringify(expectedHooks)) {
    throw new Error("Hermes config does not contain the exact Agent Boost turn-gate hooks");
  }

  const turnGateOutput = record(hermesResult.turn_gate, "Hermes installer turn_gate");
  if (
    turnGateOutput.command !== expectedTurnGateCommand ||
    turnGateOutput.allowlist_changed !== true
  ) {
    throw new Error("Hermes installer reported unexpected turn_gate output");
  }
  const allowlistPath = await realpath(
    stringValue(turnGateOutput.allowlist_path, "Hermes turn-gate allowlist path"),
  );
  assertWithin(realHermesHome, allowlistPath, "Hermes turn-gate allowlist path");
  await assertMode(allowlistPath, 0o600, "Hermes turn-gate allowlist");
  let allowlist;
  try {
    allowlist = JSON.parse(await readFile(allowlistPath, "utf8"));
  } catch {
    throw new Error("Hermes turn-gate allowlist is not valid JSON");
  }
  const expectedAllowlist = {
    approvals: [
      { event: "pre_tool_call", command: expectedTurnGateCommand },
      { event: "post_tool_call", command: expectedTurnGateCommand },
    ],
  };
  if (JSON.stringify(allowlist) !== JSON.stringify(expectedAllowlist)) {
    throw new Error("Hermes turn-gate allowlist is not exact");
  }
  const outputGuard = record(hermesResult.output_guard, "Hermes installer output_guard");
  if (outputGuard.changed !== true || outputGuard.validated !== true) {
    throw new Error("Hermes installer did not install and validate the output guard");
  }
  const outputGuardPath = await realpath(
    stringValue(outputGuard.plugin_path, "Hermes output-guard plugin path"),
  );
  assertWithin(realHermesHome, outputGuardPath, "Hermes output-guard plugin path");
  for (const file of ["__init__.py", "plugin.yaml"]) {
    const [actual, expected] = await Promise.all([
      readFile(join(outputGuardPath, file)),
      readFile(join(options.candidateRoot, "integrations", "hermes", "agent-boost-output-guard", file)),
    ]);
    if (!actual.equals(expected)) throw new Error(`Installed output guard ${file} differs from candidate`);
  }

  const installedSkills = Array.isArray(hermesResult.skills) ? hermesResult.skills : [];
  for (const name of HERMES_SKILL_NAMES) {
    const installed = installedSkills.find((skill) => skill?.name === name);
    if (!installed) throw new Error(`Hermes did not install the ${name} skill`);
    if (installed.changed !== true) {
      throw new Error(`Clean Hermes profile did not report a new ${name} skill`);
    }
    const destination = await realpath(stringValue(installed.path, `${name} skill path`));
    assertWithin(realHermesHome, destination, `${name} skill path`);
    const [actual, expected] = await Promise.all([
      readFile(destination),
      readFile(join(options.candidateRoot, "integrations", "hermes", name, "SKILL.md")),
    ]);
    if (!actual.equals(expected)) throw new Error(`Installed ${name} skill differs from candidate`);
  }

  return {
    executable,
    configPath,
    turnGateArtifact,
    turnGateCommand: expectedTurnGateCommand,
    hermesVersion: publicHermesVersion(
      stringValue(hermes.hermes_version, "Hermes version"),
    ),
    kohakuCommit: EXPECTED_KOHAKU_COMMIT,
  };
}

export async function verifyInstalledTurnGate(options) {
  const stateDirectory = stringValue(
    options.stateDirectory,
    "turn-gate smoke state directory",
  );
  const environment = {
    ...(options.environment ?? {}),
    AGENT_BOOST_HERMES_TURN_GATE_DIR: stateDirectory,
  };
  const commandArgs = Array.isArray(options.commandArgs)
    ? [...options.commandArgs]
    : ["hermes-turn-gate"];
  const session = "release-gate-turn-gate-smoke";
  const previewResult = {
    _meta: {
      "org.agentboost/turn-control": {
        schema_version: 1,
        boundary: "new_user_turn",
        continuation: {
          tool: "wallet_create",
          binding: {
            name: "release-smoke-wallet",
            expected_active_wallet_name: "agent-boost",
            expected_active_selection_epoch: 1,
          },
        },
      },
      "org.agentboost/model-context": { response_mode: "preview_then_stop" },
    },
    content: [{ type: "text", text: "Create release-smoke-wallet after a later reply." }],
  };
  const invoke = async (payload, label) => {
    const execution = await spawnCapture(options.executable, commandArgs, {
      env: environment,
      input: `${JSON.stringify(payload)}\n`,
      timeoutMs: 10_000,
      outputLimit: 64 * 1024,
    });
    if (execution.exitCode !== 0) {
      throw new Error(`Installed turn gate failed during ${label}: ${diagnostic(execution)}`);
    }
    try {
      return record(JSON.parse(execution.stdout), `${label} turn-gate response`);
    } catch {
      throw new Error(`Installed turn gate returned invalid JSON during ${label}`);
    }
  };
  const hookPayload = (event, turn, tool, input = {}, result) => ({
    hook_event_name: event,
    tool_name: tool,
    tool_input: input,
    session_id: session,
    extra: {
      turn_id: turn,
      tool_call_id: `${turn}-${event}`,
      ...(result === undefined ? {} : { result }),
    },
  });
  const nativePreLlmPayload = (sessionId, turn, userMessage) => ({
    hook_event_name: "pre_llm_call",
    tool_name: null,
    tool_input: null,
    session_id: sessionId,
    cwd: "",
    extra: {
      task_id: `${sessionId}-task`,
      turn_id: turn,
      user_message: userMessage,
    },
  });
  const attestRootTurn = async (sessionId, turn, userMessage, label) => {
    const response = await invoke(
      nativePreLlmPayload(sessionId, turn, userMessage),
      label,
    );
    if (response.continue === false) {
      throw new Error(`Installed turn gate blocked ${label}`);
    }
    return response;
  };

  await attestRootTurn(
    session,
    "turn-1",
    "Create release-smoke-wallet.",
    "preview root-turn attestation",
  );
  const published = await invoke(
    hookPayload(
      "post_tool_call",
      "turn-1",
      "mcp__agent_boost__wallet_create",
      {},
      previewResult,
    ),
    "preview publication",
  );
  assertAllowedTurnGateResponse(published, "preview publication");

  const sameTurn = await invoke(
    hookPayload("pre_tool_call", "turn-1", "mcp__agent_boost__wallet_get_main_balance"),
    "same-turn continuation",
  );
  assertBlockedTurnGateResponse(sameTurn, "same-turn continuation");

  const exactContinuation = hookPayload(
    "pre_tool_call",
    "turn-2",
    "mcp__agent_boost__wallet_create",
    {
      name: "release-smoke-wallet",
      expected_active_wallet_name: "agent-boost",
      expected_active_selection_epoch: 1,
      user_confirmed: true,
    },
  );
  const approvalContext = await attestRootTurn(
    session,
    "turn-2",
    "approve",
    "actual-user approval authentication",
  );
  if (typeof approvalContext.context !== "string" || !approvalContext.context.includes("wallet_create")) {
    throw new Error("Installed turn gate did not authenticate the actual user approval");
  }
  assertAllowedTurnGateResponse(
    await invoke(exactContinuation, "later exact continuation"),
    "later exact continuation",
  );
  assertBlockedTurnGateResponse(
    await invoke(exactContinuation, "consumed continuation replay"),
    "consumed continuation replay",
  );

  const directSession = "release-gate-direct-confirmation";
  await attestRootTurn(
    directSession,
    "direct-turn-1",
    "Archive old-wallet now.",
    "direct confirmation root-turn attestation",
  );
  const direct = {
    ...hookPayload(
      "pre_tool_call",
      "direct-turn-1",
      "mcp__agent_boost__wallet_archive",
      { wallet_name: "old-wallet", user_confirmed: true },
    ),
    session_id: directSession,
  };
  assertBlockedTurnGateResponse(
    await invoke(direct, "direct lifecycle confirmation"),
    "direct lifecycle confirmation",
  );

  const unrelatedSession = "release-gate-unrelated-call";
  await attestRootTurn(
    unrelatedSession,
    "ordinary-turn-1",
    "Show me my wallets.",
    "unrelated call root-turn attestation",
  );
  const unrelated = {
    ...hookPayload(
      "pre_tool_call",
      "ordinary-turn-1",
      "mcp__agent_boost__wallet_get_tree",
    ),
    session_id: unrelatedSession,
  };
  assertAllowedTurnGateResponse(
    await invoke(unrelated, "unrelated call"),
    "unrelated call",
  );

  const bridgedToolName = "mcp__agent_boost__wallet_archive";
  const bridgedConfirmation = {
    wallet_name: "release-smoke-archive",
    user_confirmed: true,
  };
  const directBridgedSession = "release-gate-bridged-direct";
  await attestRootTurn(
    directBridgedSession,
    "bridged-direct-turn-1",
    "Archive release-smoke-archive now.",
    "direct bridged confirmation root-turn attestation",
  );
  const directBridged = {
    ...hookPayload(
      "pre_tool_call",
      "bridged-direct-turn-1",
      "tool_call",
      {
        name: bridgedToolName,
        arguments: JSON.stringify(bridgedConfirmation),
      },
    ),
    session_id: directBridgedSession,
  };
  assertBlockedTurnGateResponse(
    await invoke(directBridged, "direct bridged string confirmation"),
    "direct bridged string confirmation",
  );

  const bridgedPreviewResult = {
    _meta: {
      "org.agentboost/turn-control": {
        schema_version: 1,
        boundary: "new_user_turn",
        continuation: {
          tool: "wallet_archive",
          binding: { wallet_name: "release-smoke-archive" },
        },
      },
      "org.agentboost/model-context": { response_mode: "preview_then_stop" },
    },
    content: [{ type: "text", text: "Archive release-smoke-archive after a later reply." }],
  };
  const bridgedPreviewSession = "release-gate-bridged-preview";
  await attestRootTurn(
    bridgedPreviewSession,
    "bridged-turn-1",
    "Archive release-smoke-archive.",
    "bridged preview root-turn attestation",
  );
  const bridgedPreview = {
    ...hookPayload(
      "post_tool_call",
      "bridged-turn-1",
      "tool_call",
      {
        name: bridgedToolName,
        arguments: JSON.stringify({ wallet_name: "release-smoke-archive" }),
      },
      bridgedPreviewResult,
    ),
    session_id: bridgedPreviewSession,
  };
  assertAllowedTurnGateResponse(
    await invoke(bridgedPreview, "bridged preview publication"),
    "bridged preview publication",
  );
  const bridgedContinuation = {
    ...hookPayload(
      "pre_tool_call",
      "bridged-turn-2",
      "tool_call",
      {
        name: bridgedToolName,
        arguments: JSON.stringify(bridgedConfirmation),
      },
    ),
    session_id: bridgedPreviewSession,
  };
  const bridgedApprovalContext = await attestRootTurn(
    bridgedPreviewSession,
    "bridged-turn-2",
    "approve",
    "bridged actual-user approval authentication",
  );
  if (
    typeof bridgedApprovalContext.context !== "string" ||
    !bridgedApprovalContext.context.includes("wallet_archive")
  ) {
    throw new Error("Installed turn gate did not authenticate the bridged approval");
  }
  assertAllowedTurnGateResponse(
    await invoke(bridgedContinuation, "later exact bridged string confirmation"),
    "later exact bridged string confirmation",
  );
  assertBlockedTurnGateResponse(
    await invoke(bridgedContinuation, "consumed bridged string confirmation replay"),
    "consumed bridged string confirmation replay",
  );

  return {
    sameTurnBlocked: true,
    exactContinuationAllowed: true,
    continuationConsumed: true,
    directConfirmationBlocked: true,
    unrelatedCallAllowed: true,
    bridgedDirectConfirmationBlocked: true,
    bridgedExactContinuationAllowed: true,
    bridgedContinuationConsumed: true,
  };
}

export async function verifySensitivePermissions(paths) {
  await assertMode(paths.stateDir, 0o700, "Agent Boost state directory");
  await assertMode(join(paths.stateDir, "state.json"), 0o600, "Agent Boost state file");
  await assertMode(dirname(paths.passwordFile), 0o700, "Agent Boost secret directory");
  await assertMode(paths.passwordFile, 0o600, "Kohaku password file");
  await assertPrivateTree(paths.kohakuDataDir);
}

export async function copyTrackedCandidate(sourceRoot, destinationRoot, runCommand = spawnCapture) {
  const listed = await runCommand("git", ["-C", sourceRoot, "ls-files", "-z"], {
    timeoutMs: 30_000,
  });
  if (listed.exitCode !== 0) {
    throw new Error(`Could not enumerate candidate files: ${diagnostic(listed)}`);
  }
  const files = listed.stdout.split("\0").filter(Boolean);
  if (files.length === 0) throw new Error("Candidate contains no tracked files");
  for (const file of files) {
    const source = join(sourceRoot, file);
    const destination = join(destinationRoot, file);
    const metadata = await lstat(source);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (metadata.isSymbolicLink()) {
      throw new Error(`Candidate symlinks are not supported by the release gate: ${file}`);
    }
    if (!metadata.isFile()) continue;
    await copyFile(source, destination);
    await chmod(destination, metadata.mode & 0o777);
  }
  return files;
}

export async function installHermesCommand(commandBin, hermesExecutable) {
  if (!isAbsolute(hermesExecutable)) {
    throw new Error("--hermes must be an absolute executable path");
  }
  const metadata = await stat(hermesExecutable);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error("--hermes must name an executable regular file");
  }
  await mkdir(commandBin, { recursive: true, mode: 0o700 });
  const destination = join(commandBin, "hermes");
  await symlink(hermesExecutable, destination);
  return destination;
}

export async function spawnCapture(executable, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hasInput = options.input !== undefined;
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const outputLimit = options.outputLimit ?? 32 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const capture = (destination, chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > outputLimit) {
        child.kill("SIGKILL");
        finish(() => rejectPromise(new Error("Release-gate command output exceeded its limit")));
        return;
      }
      destination.push(chunk);
    };
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => finish(() => rejectPromise(error)));
    child.stdin?.once("error", (error) => finish(() => rejectPromise(error)));
    child.once("close", (exitCode, signal) => {
      finish(() => resolvePromise({
        exitCode: exitCode ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => rejectPromise(new Error(`Release-gate command timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref();
    if (hasInput) child.stdin.end(options.input);
  });
}

export function parseInstallerOutput(result) {
  if (result.exitCode !== 0) {
    throw new Error(`Clean install failed: ${diagnostic(result)}`);
  }
  const jsonStart = result.stdout.indexOf("{");
  if (jsonStart === -1) throw new Error("Clean installer did not return a JSON report");
  try {
    return JSON.parse(result.stdout.slice(jsonStart));
  } catch {
    throw new Error("Clean installer did not return a JSON report");
  }
}

export async function inspectCandidate(sourceRoot, runCommand = spawnCapture) {
  const revision = await runCommand("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    timeoutMs: 30_000,
  });
  if (revision.exitCode !== 0) throw new Error(`Could not resolve candidate: ${diagnostic(revision)}`);
  const dirty = await runCommand("git", [
    "-C",
    sourceRoot,
    "diff",
    "--quiet",
    "HEAD",
    "--",
  ], {
    timeoutMs: 30_000,
  });
  if (dirty.exitCode !== 0 && dirty.exitCode !== 1) {
    throw new Error(`Could not inspect candidate changes: ${diagnostic(dirty)}`);
  }
  return { sha: revision.stdout.trim(), trackedChanges: dirty.exitCode === 1 };
}

function hooksAutoAcceptEnabled(value) {
  return value === true || (
    typeof value === "string" &&
    ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
  );
}

function hermesTurnGateCommand(executable) {
  const commandPath = /^[A-Za-z0-9_./:@%+=,-]+$/u.test(executable)
    ? executable
    : `'${executable.replaceAll("'", `'"'"'`)}'`;
  return `${commandPath} hermes-turn-gate`;
}

function expectedHermesTurnGateHooks(command) {
  return {
    pre_tool_call: [{
      matcher: HERMES_TURN_GATE_PRE_MATCHER,
      command,
      timeout: HERMES_TURN_GATE_TIMEOUT_SECONDS,
      fail_closed: true,
    }],
    post_tool_call: [{
      matcher: HERMES_TURN_GATE_POST_MATCHER,
      command,
      timeout: HERMES_TURN_GATE_TIMEOUT_SECONDS,
    }],
  };
}

function assertAllowedTurnGateResponse(value, label) {
  if (Object.keys(value).length !== 0) {
    throw new Error(`Installed turn gate unexpectedly blocked ${label}`);
  }
}

function assertBlockedTurnGateResponse(value, label) {
  if (
    value.action !== "block" ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    throw new Error(`Installed turn gate failed to block ${label}`);
  }
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys changed: ${actual.join(", ")}`);
  }
}

function allowedKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unexpected public fields: ${unexpected.join(", ")}`);
  }
  for (const required of ["setupId", "revision", "phase", "address"]) {
    if (!(required in value)) throw new Error(`${label} is missing ${required}`);
  }
}

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function stringValue(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function integerValue(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be an integer`);
  return value;
}

function assertWithin(parent, child, label) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(`${label} is outside the isolated release-gate directory`);
}

async function assertMode(path, expected, label) {
  const metadata = await lstat(path);
  const actual = metadata.mode & 0o777;
  if (actual !== expected) {
    throw new Error(`${label} has mode ${actual.toString(8)}, expected ${expected.toString(8)}`);
  }
}

async function assertPrivateTree(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error("Kohaku private state contains a symlink");
  if (metadata.isDirectory()) {
    if ((metadata.mode & 0o777) !== 0o700) {
      throw new Error(`Kohaku private directory has unsafe mode: ${path}`);
    }
    for (const entry of await readdir(path)) await assertPrivateTree(join(path, entry));
  } else if (metadata.isFile() && (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`Kohaku private file has unsafe mode: ${path}`);
  }
}

function diagnostic(result) {
  return (result.stderr?.trim() || result.stdout?.trim() || "no diagnostics").slice(0, 2_000);
}

function publicHermesVersion(value) {
  const firstLine = value.split(/\r?\n/u)[0]?.trim();
  if (!firstLine) throw new Error("Hermes version output was empty");
  assertNoPublicLeaks(firstLine);
  return firstLine.slice(0, 160);
}

export const RELEASE_GATE_CONSTANTS = Object.freeze({
  expectedChainId: EXPECTED_CHAIN_ID,
  expectedFundingEth: EXPECTED_FUNDING_ETH,
  expectedFundingWei: EXPECTED_FUNDING_WEI,
  expectedKohakuCommit: EXPECTED_KOHAKU_COMMIT,
});
