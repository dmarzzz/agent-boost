import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isMap, parseDocument } from "yaml";

export const HERMES_SERVER_NAME = "agent-boost";
// A cold Kohaku private-wallet initialization can legitimately spend a little
// over three minutes rebuilding its Tor state before it returns a durable
// result. Keep the bridge bounded, but leave enough room for that first-run
// path so Hermes does not abandon an operation that completed successfully.
export const HERMES_MCP_TIMEOUT_SECONDS = 360;
const HERMES_LEGACY_MCP_TIMEOUT_SECONDS = 180;
export const HERMES_MCP_DISCOVERY_TIMEOUT_SECONDS = 60;
export const HERMES_TURN_GATE_PRE_MATCHER = ".*";
export const HERMES_TURN_GATE_POST_MATCHER =
  "(?:mcp__agent_boost__.*|tool_call)";
export const HERMES_TURN_GATE_TIMEOUT_SECONDS = 5;
export const HERMES_OUTPUT_GUARD_PLUGIN_NAME = "agent-boost-output-guard";

export const HERMES_AGENT_BOOST_SYSTEM_PROMPT_BEGIN =
  "[BEGIN AGENT BOOST MANAGED ROUTING]";
export const HERMES_AGENT_BOOST_SYSTEM_PROMPT_END =
  "[END AGENT BOOST MANAGED ROUTING]";
export const HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK = [
  HERMES_AGENT_BOOST_SYSTEM_PROMPT_BEGIN,
  "Agent Boost wallet rules:",
  "- An unqualified transfer from a named wallet, profile, or main account is regular/public. For an explicit regular/public send from <parent>/<pocket>, put the parent in source and the child in source_private_balance; if only the pocket or its public change is named, use $selected as source and that child name in source_private_balance. It remains regular, not private. The word private inside a saved-wallet friendly name never selects private mode or a child pocket; only an explicit private, shielded, from-private, recovery, or unshield request does. Route mode first: regular/public -> wallet_preview_regular_transfer; private/shielded -> wallet_preview_private_transfer; recovery/private-to-main -> wallet_preview_recovery_transfer. Do this even when the source is named or inactive; never list or load it first. Treat destination names as lookups; never infer wallet creation.",
  "- A private balance is a named child pocket under one saved wallet, not another top-level wallet. Use wallet_preview_private_balance_create to add one, wallet_preview_private_balance_fund to fund one, and the private-balance policy tools for its own limits. For funding, wallet_name is the parent; source=$main means that parent's public account, otherwise source is an exact sibling pocket name. Its nested public-change balance stays under that child and is regular-sendable. Use wallet_get_tree for the overview.",
  "- Any preview or result that asks for approval ends this assistant turn. Continue only after a later actual user turn; all approval happens through that chat reply, never an app, popup, or other confirmation surface. Never manufacture, quote, simulate, or impersonate user input.",
  "- Never put raw tool/function-call syntax (including <function> tags) or internal tool, decision, or request IDs in user-facing text.",
  "- A canonical transfer execution performs one no-rebroadcast verification read itself and returns the final, unresolved, or explicitly unverified state. Do not add another tool call in that assistant turn. A matching wallet_get_*_request tool is only for a later user status request; never execute again to check.",
  "- When the latest trusted Agent Boost result requested a status follow-up, a fresh user message such as check again starts a new read-only turn. Perform exactly one fresh read for that matching setup or unresolved operation; never answer from an older balance, phase, or tree. Repeating a read across user turns is allowed and required. This never permits repeating an execute, apply, create, fund, shield, or broadcast action.",
  HERMES_AGENT_BOOST_SYSTEM_PROMPT_END,
].join("\n");

export const HERMES_SKILL_NAMES = [
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
] as const;

export type HermesSkillName = (typeof HERMES_SKILL_NAMES)[number];

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
] as const;

// The final canonical allowlist shipped immediately before named private
// balances. This exact set is safe to expand because it was installer-owned;
// arbitrary subsets remain operator customizations and must fail closed.
const HERMES_HISTORICAL_29_TOOL_ALLOWLIST = [
  "capabilities",
  "onboarding_start",
  "onboarding_status",
  "wallet_get_main_balance",
  "wallet_list_saved_profiles",
  "wallet_get_tree",
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
] as const;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<CommandResult>;

export interface InstallHermesIntegrationOptions {
  executablePath: string;
  runCommand: CommandRunner;
  hermesCommand?: string;
  setupSkillSource?: string;
  operationalSkillSource?: string;
  walletTreeSkillSource?: string;
  walletsSkillSource?: string;
  policySkillSource?: string;
  transfersSkillSource?: string;
  walletActionsSkillSource?: string;
  authorizationSkillSource?: string;
  confirmationSkillSource?: string;
  coveredWebSkillSource?: string;
  outputGuardPluginSource?: string;
  outputGuardManifestSource?: string;
  now?: () => Date;
}

export interface InstalledHermesSkill {
  name: HermesSkillName;
  path: string;
  changed: boolean;
  backupPath?: string;
}

export interface HermesIntegrationResult {
  configPath: string;
  configChanged: boolean;
  configBackupPath?: string;
  hookAllowlistPath: string;
  hookAllowlistChanged: boolean;
  hookAllowlistBackupPath?: string;
  turnGateCommand: string;
  hookTests: Readonly<{
    preToolCall: CommandResult;
    postToolCall: CommandResult;
  }>;
  outputGuardPluginPath: string;
  outputGuardPluginChanged: boolean;
  outputGuardPluginBackupPaths: string[];
  outputGuardPluginTest: CommandResult;
  executablePath: string;
  skills: InstalledHermesSkill[];
  mcpTest: CommandResult;
  restartRequired: true;
  recommendation: string;
}

export type HermesInstallErrorCode =
  | "COMMAND_FAILED"
  | "CONFIG_PATH_INVALID"
  | "CONFIG_INVALID"
  | "INSTALL_LOCKED"
  | "INSTALL_TARGET_CHANGED"
  | "INSTALL_TARGET_UNSAFE"
  | "HOOK_CONFIG_CONFLICT"
  | "HOOK_ALLOWLIST_INVALID"
  | "HOOK_TEST_FAILED"
  | "PLUGIN_CONFIG_CONFLICT"
  | "PLUGIN_TEST_FAILED"
  | "MCP_SERVER_CONFLICT"
  | "EXECUTABLE_INVALID"
  | "MCP_TEST_FAILED";

export class HermesInstallError extends Error {
  readonly code: HermesInstallErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: HermesInstallErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "HermesInstallError";
    this.code = code;
    this.details = details;
  }
}

interface SkillPlan {
  name: InstalledHermesSkill["name"];
  sourcePath: string;
  destinationPath: string;
  content: Buffer;
  changed: boolean;
  original: FileSnapshot;
  destinationDirectoryExisted: boolean;
  managedRoot: string;
}

interface FileSnapshot {
  exists: boolean;
  content: Buffer;
  mode?: number;
}

interface HookAllowlistPlan {
  path: string;
  command: string;
  content: Buffer;
  changed: boolean;
  original: FileSnapshot;
}

interface ManagedFilePlan {
  sourcePath: string;
  destinationPath: string;
  content: Buffer;
  changed: boolean;
  original: FileSnapshot;
  destinationDirectoryExisted: boolean;
  managedRoot: string;
}

const DEFAULT_SETUP_SKILL = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost-setup/SKILL.md", import.meta.url),
);
const DEFAULT_OPERATIONAL_SKILL = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost/SKILL.md", import.meta.url),
);
const DEFAULT_WALLET_TREE_SKILL = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost-wallet-tree/SKILL.md", import.meta.url),
);
const DEFAULT_WALLETS_SKILL = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost-wallets/SKILL.md", import.meta.url),
);
const DEFAULT_POLICY_SKILL = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost-policy/SKILL.md", import.meta.url),
);
const DEFAULT_TRANSFERS_SKILL = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost-transfers/SKILL.md", import.meta.url),
);
const DEFAULT_WALLET_ACTIONS_SKILL = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost-wallet-actions/SKILL.md", import.meta.url),
);
const DEFAULT_AUTHORIZATION_SKILL = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost-authorize/SKILL.md", import.meta.url),
);
const DEFAULT_CONFIRMATION_SKILL = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost-confirm/SKILL.md", import.meta.url),
);
const DEFAULT_COVERED_WEB_SKILL = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost-covered-web/SKILL.md", import.meta.url),
);
const DEFAULT_OUTPUT_GUARD_PLUGIN = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost-output-guard/__init__.py", import.meta.url),
);
const DEFAULT_OUTPUT_GUARD_MANIFEST = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost-output-guard/plugin.yaml", import.meta.url),
);

const RESTART_RECOMMENDATION =
  "Restart Hermes once so the native pre-LLM bridge and installed turn-gate hooks are registered, then start a fresh conversation before setup. Use /new locally or !new over Matrix so stale facts do not survive the upgrade. Reloading skills or MCP alone does not register newly configured plugins or hooks. The installer did not restart Hermes or reset its sessions.";

const HERMES_AGENT_SAFETY_DEFAULTS = {
  tool_use_enforcement: true,
  execution_guidance: false,
  task_completion_guidance: false,
  parallel_tool_call_guidance: false,
} as const;

/**
 * Install Agent Boost into the active Hermes profile without restarting Hermes.
 *
 * The command runner is deliberately injected so callers can control process
 * execution and tests never need a real Hermes installation.
 */
export async function installHermesIntegration(
  options: InstallHermesIntegrationOptions,
): Promise<HermesIntegrationResult> {
  const hermesCommand = options.hermesCommand ?? "hermes";
  const now = options.now ?? (() => new Date());
  const executablePath = await validateExecutable(options.executablePath);
  const configPath = await resolveHermesConfigPath(
    options.runCommand,
    hermesCommand,
  );
  await assertSafeManagedParent(dirname(configPath), configPath);
  const installLock = await acquireInstallLock(configPath);
  try {
    const result = await installHermesIntegrationLocked(
      options,
      hermesCommand,
      now,
      executablePath,
      configPath,
    );
    const lockCleanup = await installLock.release();
    if (!lockCleanup.complete) {
      throw new HermesInstallError(
        "COMMAND_FAILED",
        "Hermes integration installed, but its install lock could not be cleaned up safely.",
        { committed: true, lockCleanup },
      );
    }
    return result;
  } catch (error) {
    const lockCleanup = await installLock.release();
    if (lockCleanup.complete) throw error;
    if (error instanceof HermesInstallError) {
      throw new HermesInstallError(error.code, error.message, {
        ...error.details,
        lockCleanup,
      });
    }
    throw new HermesInstallError(
      "COMMAND_FAILED",
      error instanceof Error ? error.message : "Hermes integration install failed.",
      { cause: String(error), lockCleanup },
    );
  }
}

async function installHermesIntegrationLocked(
  options: InstallHermesIntegrationOptions,
  hermesCommand: string,
  now: () => Date,
  executablePath: string,
  configPath: string,
): Promise<HermesIntegrationResult> {
  await assertSafeManagedParent(dirname(configPath), configPath);
  const originalConfig = await readConfig(configPath);
  const document = parseHermesConfig(originalConfig.content, configPath);
  const desiredServer = createHermesServerConfig(executablePath);
  const configValue = document.toJS() as Record<string, unknown> | null;
  const shouldDefaultMcpDiscoveryTimeout =
    configValue?.mcp_discovery_timeout === undefined;
  const shouldDefaultSingleQueryMcpDiscoveryTimeout =
    configValue?.mcp_single_query_discovery_timeout === undefined;
  assertHooksAutoAcceptDisabled(configValue?.hooks_auto_accept, configPath);
  const mcpServers = configValue?.mcp_servers;
  if (mcpServers !== undefined && !isPlainRecord(mcpServers)) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `mcp_servers` value must be a YAML mapping.",
      { configPath },
    );
  }
  const agentConfig = configValue?.agent;
  if (agentConfig !== undefined && !isPlainRecord(agentConfig)) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `agent` value must be a YAML mapping.",
      { configPath },
    );
  }
  const agentDefaultsToApply = Object.entries(HERMES_AGENT_SAFETY_DEFAULTS)
    .filter(([key]) =>
      agentConfig === undefined || agentConfig[key] === undefined
    );
  const systemPromptPlan = planHermesSystemPrompt(
    agentConfig?.system_prompt,
    configPath,
  );
  const toolsConfig = configValue?.tools;
  if (toolsConfig !== undefined && !isPlainRecord(toolsConfig)) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `tools` value must be a YAML mapping.",
      { configPath },
    );
  }
  const toolSearchConfig = isPlainRecord(toolsConfig)
    ? toolsConfig.tool_search
    : undefined;
  if (
    toolSearchConfig !== undefined &&
    typeof toolSearchConfig !== "boolean" &&
    !isPlainRecord(toolSearchConfig)
  ) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `tools.tool_search` value must be a YAML mapping or legacy boolean.",
      { configPath },
    );
  }
  const shouldDefaultToolSearch =
    toolSearchConfig === undefined ||
    (isPlainRecord(toolSearchConfig) && toolSearchConfig.enabled === undefined);
  const displayConfig = configValue?.display;
  if (displayConfig !== undefined && !isPlainRecord(displayConfig)) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `display` value must be a YAML mapping.",
      { configPath },
    );
  }
  const shouldDefaultBusyInputMode = displayConfig === undefined ||
    displayConfig.busy_input_mode === undefined;
  const pluginsConfig = configValue?.plugins;
  if (pluginsConfig !== undefined && !isPlainRecord(pluginsConfig)) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `plugins` value must be a YAML mapping.",
      { configPath },
    );
  }
  const enabledPlugins = isPlainRecord(pluginsConfig)
    ? pluginsConfig.enabled
    : undefined;
  const disabledPlugins = isPlainRecord(pluginsConfig)
    ? pluginsConfig.disabled
    : undefined;
  if (enabledPlugins !== undefined && (
    !Array.isArray(enabledPlugins) ||
    !enabledPlugins.every((entry) => typeof entry === "string")
  )) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `plugins.enabled` value must be a list of plugin names.",
      { configPath },
    );
  }
  if (disabledPlugins !== undefined && (
    !Array.isArray(disabledPlugins) ||
    !disabledPlugins.every((entry) => typeof entry === "string")
  )) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `plugins.disabled` value must be a list of plugin names.",
      { configPath },
    );
  }
  if (Array.isArray(disabledPlugins) && disabledPlugins.includes(HERMES_OUTPUT_GUARD_PLUGIN_NAME)) {
    throw new HermesInstallError(
      "PLUGIN_CONFIG_CONFLICT",
      `Hermes explicitly disables ${HERMES_OUTPUT_GUARD_PLUGIN_NAME}; refusing to override the operator deny-list.`,
      { configPath },
    );
  }
  const shouldEnableOutputGuard = !Array.isArray(enabledPlugins) ||
    !enabledPlugins.includes(HERMES_OUTPUT_GUARD_PLUGIN_NAME);
  const existingServer =
    isPlainRecord(mcpServers) && HERMES_SERVER_NAME in mcpServers
      ? mcpServers[HERMES_SERVER_NAME]
      : undefined;

  if (existingServer !== undefined) {
    if (
      !deepEqual(existingServer, desiredServer) &&
      !isSafeAgentBoostUpgrade(existingServer, desiredServer)
    ) {
      throw new HermesInstallError(
        "MCP_SERVER_CONFLICT",
        `Hermes already has a conflicting ${HERMES_SERVER_NAME} MCP entry; refusing to replace it.`,
        { configPath, existing: existingServer, desired: desiredServer },
      );
    }
  }

  const turnGateCommand = createHermesTurnGateCommand(executablePath);
  const previousExecutablePath = isPlainRecord(existingServer) &&
      typeof existingServer.command === "string" &&
      existingServer.command !== executablePath &&
      isAbsolute(existingServer.command) &&
      isSafeAgentBoostUpgrade(existingServer, desiredServer)
    ? existingServer.command
    : undefined;
  const legacyTurnGateCommands = previousExecutablePath === undefined
    ? []
    : [createHermesTurnGateCommand(previousExecutablePath)];
  const outputGuardExecutableSettingChanged = configureOutputGuardPlugin(
    document,
    configValue,
    executablePath,
    previousExecutablePath,
    configPath,
  );
  const turnGateConfigChanged = configureHermesTurnGateHooks(
    document,
    configValue,
    turnGateCommand,
    legacyTurnGateCommands,
    configPath,
  );

  const configChanged =
    existingServer === undefined ||
    !deepEqual(existingServer, desiredServer) ||
    agentDefaultsToApply.length > 0 ||
    systemPromptPlan.changed ||
    shouldDefaultMcpDiscoveryTimeout ||
    shouldDefaultSingleQueryMcpDiscoveryTimeout ||
    shouldDefaultToolSearch ||
    shouldDefaultBusyInputMode ||
    shouldEnableOutputGuard ||
    outputGuardExecutableSettingChanged ||
    turnGateConfigChanged;
  if (existingServer === undefined || !deepEqual(existingServer, desiredServer)) {
    document.setIn(["mcp_servers", HERMES_SERVER_NAME], desiredServer);
  }
  for (const [key, value] of agentDefaultsToApply) {
    document.setIn(["agent", key], value);
  }
  if (systemPromptPlan.changed) {
    document.setIn(["agent", "system_prompt"], systemPromptPlan.value);
  }
  if (shouldDefaultMcpDiscoveryTimeout) {
    document.set("mcp_discovery_timeout", HERMES_MCP_DISCOVERY_TIMEOUT_SECONDS);
  }
  if (shouldDefaultSingleQueryMcpDiscoveryTimeout) {
    document.set(
      "mcp_single_query_discovery_timeout",
      HERMES_MCP_DISCOVERY_TIMEOUT_SECONDS,
    );
  }
  if (shouldDefaultToolSearch) {
    document.setIn(["tools", "tool_search", "enabled"], "off");
  }
  if (shouldDefaultBusyInputMode) {
    document.setIn(["display", "busy_input_mode"], "queue");
  }
  if (shouldEnableOutputGuard) {
    document.setIn(
      ["plugins", "enabled"],
      [...(Array.isArray(enabledPlugins) ? enabledPlugins : []), HERMES_OUTPUT_GUARD_PLUGIN_NAME],
    );
  }

  const skillsDirectory = join(dirname(configPath), "skills");
  const hookAllowlistPlan = await planHookAllowlist(
    join(dirname(configPath), "shell-hooks-allowlist.json"),
    turnGateCommand,
    legacyTurnGateCommands,
  );
  const skillSources: Record<HermesSkillName, string> = {
    "agent-boost-setup": options.setupSkillSource ?? DEFAULT_SETUP_SKILL,
    "agent-boost": options.operationalSkillSource ?? DEFAULT_OPERATIONAL_SKILL,
    "agent-boost-wallet-tree": options.walletTreeSkillSource ?? DEFAULT_WALLET_TREE_SKILL,
    "agent-boost-wallets": options.walletsSkillSource ?? DEFAULT_WALLETS_SKILL,
    "agent-boost-policy": options.policySkillSource ?? DEFAULT_POLICY_SKILL,
    "agent-boost-transfers": options.transfersSkillSource ?? DEFAULT_TRANSFERS_SKILL,
    "agent-boost-wallet-actions": options.walletActionsSkillSource ?? DEFAULT_WALLET_ACTIONS_SKILL,
    "agent-boost-authorize": options.authorizationSkillSource ?? DEFAULT_AUTHORIZATION_SKILL,
    "agent-boost-confirm": options.confirmationSkillSource ?? DEFAULT_CONFIRMATION_SKILL,
    "agent-boost-covered-web": options.coveredWebSkillSource ?? DEFAULT_COVERED_WEB_SKILL,
  };
  const skillPlans = await Promise.all(
    HERMES_SKILL_NAMES.map((name) =>
      planSkill(name, skillSources[name], skillsDirectory),
    ),
  );
  const outputGuardPluginPath = join(
    dirname(configPath),
    "plugins",
    HERMES_OUTPUT_GUARD_PLUGIN_NAME,
  );
  const outputGuardPlans = await Promise.all([
    planManagedFile(
      options.outputGuardPluginSource ?? DEFAULT_OUTPUT_GUARD_PLUGIN,
      join(outputGuardPluginPath, "__init__.py"),
    ),
    planManagedFile(
      options.outputGuardManifestSource ?? DEFAULT_OUTPUT_GUARD_MANIFEST,
      join(outputGuardPluginPath, "plugin.yaml"),
    ),
  ]);

  // Install skill instructions before exposing the MCP entry. Each individual
  // replacement is atomic and an existing differing file is retained as a
  // timestamped backup.
  const installedSkills: InstalledHermesSkill[] = [];
  const attemptedSkillPlans: SkillPlan[] = [];
  const attemptedOutputGuardPlans: ManagedFilePlan[] = [];
  const outputGuardPluginBackupPaths: string[] = [];
  const backupPathCandidates: string[] = [];
  let hookAllowlistMutationAttempted = false;
  let hookAllowlistBackupPath: string | undefined;
  let configMutationAttempted = false;
  let configBackupPath: string | undefined;
  const installedConfig = Buffer.from(document.toString());
  const installedConfigMode = originalConfig.mode ?? 0o600;
  try {
    for (const plan of skillPlans) {
      installedSkills.push(await applySkillPlan(plan, now, () => {
        // Record immediately before atomicWrite: rename may succeed before a
        // later directory fsync reports failure.
        attemptedSkillPlans.push(plan);
      }, (path) => backupPathCandidates.push(path)));
    }

    for (const plan of outputGuardPlans) {
      await applyManagedFilePlan(plan, now, () => {
        attemptedOutputGuardPlans.push(plan);
      }, (path) => {
        outputGuardPluginBackupPaths.push(path);
        backupPathCandidates.push(path);
      });
    }

    if (hookAllowlistPlan.changed) {
      await assertInstallTargetUnchanged(
        hookAllowlistPlan.path,
        hookAllowlistPlan.original,
      );
      if (hookAllowlistPlan.original.exists) {
        hookAllowlistBackupPath = await createBackup(
          hookAllowlistPlan.path,
          hookAllowlistPlan.original.content,
          now,
          (path) => backupPathCandidates.push(path),
        );
      }
      await assertInstallTargetUnchanged(
        hookAllowlistPlan.path,
        hookAllowlistPlan.original,
      );
      hookAllowlistMutationAttempted = true;
      await atomicWrite(hookAllowlistPlan.path, hookAllowlistPlan.content, 0o600);
    }

    if (configChanged) {
      await mkdir(dirname(configPath), { recursive: true });
      await assertInstallTargetUnchanged(configPath, originalConfig);
      if (originalConfig.exists) {
        configBackupPath = await createBackup(
          configPath,
          originalConfig.content,
          now,
          (path) => backupPathCandidates.push(path),
        );
      }
      await assertInstallTargetUnchanged(configPath, originalConfig);
      configMutationAttempted = true;
      await atomicWrite(configPath, installedConfig, installedConfigMode);
    }

    const preToolCallHookTest = await runHermesTurnGateTest({
      runCommand: options.runCommand,
      hermesCommand,
      event: "pre_tool_call",
      command: turnGateCommand,
      configPath,
    });
    const postToolCallHookTest = await runHermesTurnGateTest({
      runCommand: options.runCommand,
      hermesCommand,
      event: "post_tool_call",
      command: turnGateCommand,
      configPath,
    });

    let mcpTest: CommandResult;
    try {
      mcpTest = await options.runCommand(hermesCommand, [
        "mcp",
        "test",
        HERMES_SERVER_NAME,
      ]);
    } catch (error) {
      throw new HermesInstallError(
        "MCP_TEST_FAILED",
        `Could not launch the Hermes MCP test for ${HERMES_SERVER_NAME}.`,
        {
          configPath,
          configChanged,
          configBackupPath,
          cause: String(error),
          recommendation: RESTART_RECOMMENDATION,
        },
      );
    }
    if (mcpTest.exitCode !== 0) {
      throw new HermesInstallError(
        "MCP_TEST_FAILED",
        `Hermes could not connect to the ${HERMES_SERVER_NAME} MCP server.`,
        {
          configPath,
          configChanged,
          configBackupPath,
          stdout: mcpTest.stdout,
          stderr: mcpTest.stderr,
          exitCode: mcpTest.exitCode,
          recommendation: RESTART_RECOMMENDATION,
        },
      );
    }

    let outputGuardPluginTest: CommandResult;
    try {
      outputGuardPluginTest = await options.runCommand(hermesCommand, [
        "plugins",
        "doctor",
        outputGuardPluginPath,
        "--ci",
      ]);
    } catch (error) {
      throw new HermesInstallError(
        "PLUGIN_TEST_FAILED",
        `Could not launch the Hermes plugin doctor for ${HERMES_OUTPUT_GUARD_PLUGIN_NAME}.`,
        { configPath, outputGuardPluginPath, cause: String(error) },
      );
    }
    if (outputGuardPluginTest.exitCode !== 0) {
      throw new HermesInstallError(
        "PLUGIN_TEST_FAILED",
        `Hermes could not validate the ${HERMES_OUTPUT_GUARD_PLUGIN_NAME} plugin.`,
        {
          configPath,
          outputGuardPluginPath,
          stdout: outputGuardPluginTest.stdout,
          stderr: outputGuardPluginTest.stderr,
          exitCode: outputGuardPluginTest.exitCode,
        },
      );
    }

    for (const plan of skillPlans) {
      await assertInstallTargetUnchanged(
        plan.destinationPath,
        plan.changed
          ? { exists: true, content: plan.content, mode: 0o644 }
          : plan.original,
      );
    }
    for (const plan of outputGuardPlans) {
      await assertInstallTargetUnchanged(
        plan.destinationPath,
        plan.changed
          ? { exists: true, content: plan.content, mode: 0o644 }
          : plan.original,
      );
    }
    await assertInstallTargetUnchanged(
      hookAllowlistPlan.path,
      hookAllowlistPlan.changed
        ? { exists: true, content: hookAllowlistPlan.content, mode: 0o600 }
        : hookAllowlistPlan.original,
    );
    await assertInstallTargetUnchanged(
      configPath,
      configChanged
        ? { exists: true, content: installedConfig, mode: installedConfigMode }
        : originalConfig,
    );

    return {
      configPath,
      configChanged,
      ...(configBackupPath === undefined ? {} : { configBackupPath }),
      hookAllowlistPath: hookAllowlistPlan.path,
      hookAllowlistChanged: hookAllowlistPlan.changed,
      ...(hookAllowlistBackupPath === undefined
        ? {}
        : { hookAllowlistBackupPath }),
      turnGateCommand,
      hookTests: {
        preToolCall: preToolCallHookTest,
        postToolCall: postToolCallHookTest,
      },
      outputGuardPluginPath,
      outputGuardPluginChanged: outputGuardPlans.some((plan) => plan.changed),
      outputGuardPluginBackupPaths,
      outputGuardPluginTest,
      executablePath,
      skills: installedSkills,
      mcpTest,
      restartRequired: true,
      recommendation: RESTART_RECOMMENDATION,
    };
  } catch (error) {
    const rollback = await rollbackInstall({
      configPath,
      configMutationAttempted,
      installedConfig,
      installedConfigMode,
      originalConfig,
      hookAllowlistPlan,
      hookAllowlistMutationAttempted,
      attemptedSkillPlans,
      attemptedOutputGuardPlans,
      backupPathCandidates,
    });
    if (error instanceof HermesInstallError) {
      throw new HermesInstallError(error.code, error.message, {
        ...error.details,
        rollback,
      });
    }
    throw new HermesInstallError(
      "COMMAND_FAILED",
      "Could not finish installing the Hermes integration.",
      { cause: String(error), rollback },
    );
  }
}

function planHermesSystemPrompt(
  existing: unknown,
  configPath: string,
): { value: string; changed: boolean } {
  if (existing === undefined) {
    return { value: HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK, changed: true };
  }
  if (typeof existing !== "string") {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `agent.system_prompt` value must be a string.",
      { configPath },
    );
  }

  const begin = existing.indexOf(HERMES_AGENT_BOOST_SYSTEM_PROMPT_BEGIN);
  const end = existing.indexOf(HERMES_AGENT_BOOST_SYSTEM_PROMPT_END);
  if (begin < 0 && end < 0) {
    const separator = existing.length === 0 ? "" : "\n\n";
    return {
      value: `${existing}${separator}${HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK}`,
      changed: true,
    };
  }

  const blockEnd = end + HERMES_AGENT_BOOST_SYSTEM_PROMPT_END.length;
  const malformed =
    begin < 0 ||
    end < begin ||
    blockEnd !== existing.length ||
    existing.indexOf(HERMES_AGENT_BOOST_SYSTEM_PROMPT_BEGIN, begin + 1) >= 0 ||
    existing.indexOf(HERMES_AGENT_BOOST_SYSTEM_PROMPT_END, end + 1) >= 0;
  if (malformed) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `agent.system_prompt` contains a malformed or non-terminal Agent Boost managed routing block; refusing to overwrite operator text.",
      { configPath },
    );
  }

  const value = `${existing.slice(0, begin)}${HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK}`;
  return { value, changed: value !== existing };
}

export function createHermesServerConfig(executablePath: string): object {
  return {
    command: executablePath,
    args: ["mcp", "--mode", "dark", "--contract-major", "1"],
    enabled: true,
    timeout: HERMES_MCP_TIMEOUT_SECONDS,
    supports_parallel_tool_calls: false,
    tools: {
      include: [...HERMES_NATIVE_TOOLS],
      resources: false,
      prompts: false,
    },
  };
}

export function createHermesTurnGateHooks(executablePath: string): Record<
  "pre_tool_call" | "post_tool_call",
  Array<Record<string, unknown>>
> {
  return hermesTurnGateHooksForCommand(
    createHermesTurnGateCommand(executablePath),
  );
}

function hermesTurnGateHooksForCommand(command: string): Record<
  "pre_tool_call" | "post_tool_call",
  Array<Record<string, unknown>>
> {
  return {
    pre_tool_call: [{
      // A boundary ends the whole assistant tool-use turn, so every later
      // tool must pass through the pre hook (including terminal, skill_view,
      // web/search, and tools from other servers).
      matcher: HERMES_TURN_GATE_PRE_MATCHER,
      command,
      timeout: HERMES_TURN_GATE_TIMEOUT_SECONDS,
      fail_closed: true,
    }],
    post_tool_call: [{
      // Only Agent Boost results can publish a boundary. Keep post matching
      // narrow to avoid needless hook work and to reduce the trust surface.
      matcher: HERMES_TURN_GATE_POST_MATCHER,
      command,
      timeout: HERMES_TURN_GATE_TIMEOUT_SECONDS,
    }],
  };
}

function createHermesTurnGateCommand(executablePath: string): string {
  const commandPath = /^[A-Za-z0-9_./:@%+=,-]+$/u.test(executablePath)
    ? executablePath
    : `'${executablePath.replaceAll("'", `'"'"'`)}'`;
  return `${commandPath} hermes-turn-gate`;
}

function assertHooksAutoAcceptDisabled(value: unknown, configPath: string): void {
  const enabled = value === true || (
    typeof value === "string" &&
    ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
  );
  if (!enabled) return;
  throw new HermesInstallError(
    "CONFIG_INVALID",
    "Agent Boost turn-gate hooks require `hooks_auto_accept` to remain false or absent; refusing blanket hook auto-approval.",
    { configPath },
  );
}

async function runHermesTurnGateTest(input: {
  runCommand: CommandRunner;
  hermesCommand: string;
  event: "pre_tool_call" | "post_tool_call";
  command: string;
  configPath: string;
}): Promise<CommandResult> {
  const args = [
    "hooks",
    "test",
    input.event,
    "--for-tool",
    "mcp__agent_boost__capabilities",
  ] as const;
  let result: CommandResult;
  try {
    result = await input.runCommand(input.hermesCommand, args);
  } catch (error) {
    throw new HermesInstallError(
      "HOOK_TEST_FAILED",
      `Could not launch the Hermes ${input.event} turn-gate test.`,
      {
        configPath: input.configPath,
        command: `${input.hermesCommand} ${args.join(" ")}`,
        cause: String(error),
      },
    );
  }

  const marker = `→ ${input.command}`;
  const markerIndex = result.stdout.indexOf(marker);
  const duplicateIndex = markerIndex < 0
    ? -1
    : result.stdout.indexOf(marker, markerIndex + marker.length);
  const nextHookIndex = markerIndex < 0
    ? -1
    : result.stdout.indexOf("\n  → ", markerIndex + marker.length);
  const commandSection = markerIndex < 0
    ? ""
    : result.stdout.slice(
        markerIndex,
        nextHookIndex < 0 ? undefined : nextHookIndex,
      );
  const stdoutLine = commandSection.match(
    /(?:^|\n)\s+stdout: ([^\n]+)(?:\n|$)/u,
  )?.[1];
  let producedValidJson = false;
  if (stdoutLine !== undefined) {
    try {
      producedValidJson = isPlainRecord(JSON.parse(stdoutLine));
    } catch {
      producedValidJson = false;
    }
  }
  const passed =
    result.exitCode === 0 &&
    markerIndex >= 0 &&
    duplicateIndex < 0 &&
    /(?:^|\n)\s+exit=0\b/u.test(commandSection) &&
    producedValidJson &&
    (
      input.event === "post_tool_call" ||
      /(?:^|\n)\s+parsed \(Hermes wire shape\):/u.test(commandSection)
    ) &&
    !/✗\s+(?:error|timed out)/u.test(commandSection);
  if (!passed) {
    throw new HermesInstallError(
      "HOOK_TEST_FAILED",
      `Hermes could not validate the installed ${input.event} turn gate.`,
      {
        configPath: input.configPath,
        hookEvent: input.event,
        hookCommand: input.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
    );
  }
  return result;
}

function configureHermesTurnGateHooks(
  document: ReturnType<typeof parseHermesConfig>,
  configValue: Record<string, unknown> | null,
  command: string,
  legacyCommands: readonly string[],
  configPath: string,
): boolean {
  const hooksConfig = configValue?.hooks;
  if (hooksConfig !== undefined && !isPlainRecord(hooksConfig)) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `hooks` value must be a YAML mapping.",
      { configPath },
    );
  }

  const desired = hermesTurnGateHooksForCommand(command);
  const managedCommands = new Set([command, ...legacyCommands]);
  let changed = false;
  const preLlmEntries = isPlainRecord(hooksConfig)
    ? hooksConfig.pre_llm_call
    : undefined;
  if (preLlmEntries !== undefined) {
    if (!Array.isArray(preLlmEntries)) {
      throw new HermesInstallError(
        "CONFIG_INVALID",
        "The Hermes `hooks.pre_llm_call` value must be a list.",
        { configPath },
      );
    }
    for (const entry of preLlmEntries) {
      if (
        !isPlainRecord(entry) ||
        typeof entry.command !== "string" ||
        !managedCommands.has(entry.command)
      ) {
        continue;
      }
      if (!deepEqual(entry, legacyHermesPreLlmHookForCommand(entry.command))) {
        throw new HermesInstallError(
          "HOOK_CONFIG_CONFLICT",
          "Hermes already has a customized pre_llm_call entry using the Agent Boost turn-gate command; refusing to remove it.",
          { configPath, event: "pre_llm_call", command: entry.command },
        );
      }
    }
    const updatedPreLlmEntries = preLlmEntries.filter((entry) =>
      !isPlainRecord(entry) ||
      typeof entry.command !== "string" ||
      !managedCommands.has(entry.command)
    );
    if (!deepEqual(updatedPreLlmEntries, preLlmEntries)) {
      if (updatedPreLlmEntries.length === 0) {
        document.deleteIn(["hooks", "pre_llm_call"]);
      } else {
        document.setIn(["hooks", "pre_llm_call"], updatedPreLlmEntries);
      }
      changed = true;
    }
  }

  for (const event of ["pre_tool_call", "post_tool_call"] as const) {
    const entries = isPlainRecord(hooksConfig) ? hooksConfig[event] : undefined;
    const [spec] = desired[event];
    if (entries === undefined) {
      document.setIn(["hooks", event], [spec]);
      changed = true;
      continue;
    }
    if (!Array.isArray(entries)) {
      throw new HermesInstallError(
        "CONFIG_INVALID",
        `The Hermes \`hooks.${event}\` value must be a list.`,
        { configPath },
      );
    }
    const managedEntries = entries.filter((entry) =>
      isPlainRecord(entry) &&
      typeof entry.command === "string" &&
      managedCommands.has(entry.command)
    );
    for (const entry of managedEntries) {
      const entryCommand = String(entry.command);
      const [expected] = hermesTurnGateHooksForCommand(entryCommand)[event];
      const legacyPreMatcher = event === "pre_tool_call"
        ? { ...expected, matcher: HERMES_TURN_GATE_POST_MATCHER }
        : undefined;
      if (
        !deepEqual(entry, expected) &&
        (legacyPreMatcher === undefined || !deepEqual(entry, legacyPreMatcher))
      ) {
        throw new HermesInstallError(
          "HOOK_CONFIG_CONFLICT",
          `Hermes already has a conflicting ${event} entry for the Agent Boost turn gate; refusing to replace it.`,
          { configPath, event, command: entryCommand },
        );
      }
    }

    let inserted = false;
    const updated = entries.flatMap((entry) => {
      if (
        !isPlainRecord(entry) ||
        typeof entry.command !== "string" ||
        !managedCommands.has(entry.command)
      ) {
        return [entry];
      }
      if (inserted) return [];
      inserted = true;
      return [spec];
    });
    if (!inserted) updated.push(spec);
    if (!deepEqual(updated, entries)) {
      document.setIn(["hooks", event], updated);
      changed = true;
    }
  }
  return changed;
}

function legacyHermesPreLlmHookForCommand(
  command: string,
): Record<string, unknown> {
  return {
    command,
    timeout: HERMES_TURN_GATE_TIMEOUT_SECONDS,
  };
}

function configureOutputGuardPlugin(
  document: ReturnType<typeof parseHermesConfig>,
  configValue: Record<string, unknown> | null,
  executablePath: string,
  previousExecutablePath: string | undefined,
  configPath: string,
): boolean {
  const pluginsConfig = configValue?.plugins;
  const entries = isPlainRecord(pluginsConfig)
    ? pluginsConfig.entries
    : undefined;
  if (entries !== undefined && !isPlainRecord(entries)) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `plugins.entries` value must be a YAML mapping.",
      { configPath },
    );
  }
  const pluginEntry = isPlainRecord(entries)
    ? entries[HERMES_OUTPUT_GUARD_PLUGIN_NAME]
    : undefined;
  if (pluginEntry !== undefined && !isPlainRecord(pluginEntry)) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      `The Hermes \`plugins.entries.${HERMES_OUTPUT_GUARD_PLUGIN_NAME}\` value must be a YAML mapping.`,
      { configPath },
    );
  }
  const settings = isPlainRecord(pluginEntry)
    ? pluginEntry.settings
    : undefined;
  if (settings !== undefined && !isPlainRecord(settings)) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      `The Hermes \`plugins.entries.${HERMES_OUTPUT_GUARD_PLUGIN_NAME}.settings\` value must be a YAML mapping.`,
      { configPath },
    );
  }
  const existingExecutable = isPlainRecord(settings)
    ? settings.turn_gate_executable
    : undefined;
  if (
    existingExecutable !== undefined &&
    existingExecutable !== executablePath &&
    existingExecutable !== previousExecutablePath
  ) {
    throw new HermesInstallError(
      "PLUGIN_CONFIG_CONFLICT",
      `${HERMES_OUTPUT_GUARD_PLUGIN_NAME} already has a conflicting turn_gate_executable setting; refusing to replace it.`,
      {
        configPath,
        existing: existingExecutable,
        desired: executablePath,
      },
    );
  }
  if (existingExecutable === executablePath) return false;
  document.setIn(
    [
      "plugins",
      "entries",
      HERMES_OUTPUT_GUARD_PLUGIN_NAME,
      "settings",
      "turn_gate_executable",
    ],
    executablePath,
  );
  return true;
}

function isSafeAgentBoostUpgrade(existing: unknown, desired: unknown): boolean {
  if (!isPlainRecord(existing) || !isPlainRecord(desired)) return false;
  if (
    typeof existing.command !== "string" ||
    typeof desired.command !== "string" ||
    !isAbsolute(existing.command)
  ) {
    return false;
  }
  const existingTools = existing.tools;
  const desiredTools = desired.tools;
  if (!isPlainRecord(existingTools) || !isPlainRecord(desiredTools)) return false;
  const existingInclude = existingTools.include;
  const desiredInclude = desiredTools.include;
  if (!Array.isArray(existingInclude) || !Array.isArray(desiredInclude)) return false;
  const legacyAliases = new Map<string, readonly string[]>([
    ["wallet_get_context", ["wallet_get_main_balance"]],
    ["wallet_get_request", ["wallet_get_private_transfer_request"]],
    ["wallet_get_private_payment_request", ["wallet_get_private_transfer_request"]],
    ["wallet_get_saved_profiles", ["wallet_list_saved_profiles"]],
    ["wallet_list", ["wallet_list_saved_profiles"]],
    ["wallet_manage_profiles", ["wallet_list_saved_profiles"]],
    [
      "wallet_switch_saved_profile",
      ["wallet_preview_saved_profile_load", "wallet_apply_saved_profile_load"],
    ],
    [
      "wallet_select",
      ["wallet_preview_saved_profile_load", "wallet_apply_saved_profile_load"],
    ],
    ["wallet_reauthorize", ["wallet_apply_reauthorization"]],
    ["wallet_plan_regular_transfer", ["wallet_preview_regular_transfer"]],
    ["wallet_plan_private_payment", ["wallet_preview_private_transfer"]],
    ["wallet_execute_private_payment", ["wallet_execute_private_transfer"]],
    ["wallet_plan_recovery_transfer", ["wallet_preview_recovery_transfer"]],
  ]);
  const normalizedExisting = existingInclude.flatMap((tool) =>
    typeof tool === "string" ? (legacyAliases.get(tool) ?? [tool]) : [tool]
  );
  const normalizedSet = new Set(normalizedExisting);
  const normalizedMatchesDesired =
    normalizedSet.size === desiredInclude.length &&
    desiredInclude.every((tool) => normalizedSet.has(tool));
  const matchesHistoricalCanonicalAllowlist =
    deepEqual(desiredInclude, [...HERMES_NATIVE_TOOLS]) &&
    existingInclude.length === HERMES_HISTORICAL_29_TOOL_ALLOWLIST.length &&
    new Set(existingInclude).size === existingInclude.length &&
    HERMES_HISTORICAL_29_TOOL_ALLOWLIST.every((tool) =>
      existingInclude.includes(tool)
    );
  if (
    !existingInclude.every((tool) => {
      if (typeof tool !== "string") return false;
      if (desiredInclude.includes(tool)) return true;
      const replacements = legacyAliases.get(tool);
      return replacements !== undefined &&
        replacements.every((replacement) => desiredInclude.includes(replacement));
    }) ||
    new Set(existingInclude).size !== existingInclude.length ||
    (!normalizedMatchesDesired && !matchesHistoricalCanonicalAllowlist)
  ) {
    return false;
  }
  const normalizedTimeout =
    existing.timeout === HERMES_LEGACY_MCP_TIMEOUT_SECONDS &&
    desired.timeout === HERMES_MCP_TIMEOUT_SECONDS
      ? desired.timeout
      : existing.timeout;
  return deepEqual(
    {
      ...existing,
      command: desired.command,
      timeout: normalizedTimeout,
      tools: { ...existingTools, include: desiredInclude },
    },
    desired,
  );
}

async function acquireInstallLock(configPath: string): Promise<{
  path: string;
  release: () => Promise<Record<string, unknown> & { complete: boolean }>;
}> {
  const lockPath = join(dirname(configPath), ".agent-boost-install.lock");
  await mkdir(dirname(lockPath), { recursive: true });
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      const owner = await readFile(lockPath, "utf8").catch(() => "unavailable");
      throw new HermesInstallError(
        "INSTALL_LOCKED",
        "Another Agent Boost integration install is already in progress.",
        {
          lockPath,
          ...(lockOwnerPid(owner) === undefined
            ? {}
            : { ownerPid: lockOwnerPid(owner) }),
          remediation:
            "Verify the recorded PID is not running an Agent Boost install, then remove only this lock file and retry.",
        },
      );
    }
    throw error;
  }

  const token = randomUUID();
  const lockContent = `${JSON.stringify({ pid: process.pid, token })}\n`;
  try {
    await handle.writeFile(lockContent);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
  const ownedStat = await handle.stat();
  let released = false;
  return {
    path: lockPath,
    release: async () => {
      if (released) return { complete: true, path: lockPath, status: "already_released" };
      released = true;
      let cleanup: Record<string, unknown> & { complete: boolean };
      try {
        const [currentStat, currentContent] = await Promise.all([
          stat(lockPath),
          readFile(lockPath, "utf8"),
        ]);
        if (
          currentStat.dev === ownedStat.dev &&
          currentStat.ino === ownedStat.ino &&
          currentContent === lockContent
        ) {
          await unlink(lockPath);
          cleanup = { complete: true, path: lockPath, status: "removed" };
        } else {
          cleanup = {
            complete: false,
            path: lockPath,
            status: "ownership_lost",
            remediation:
              "Verify no Agent Boost install owns the path before removing only the reported lock.",
          };
        }
      } catch (error) {
        cleanup = isNodeError(error) && error.code === "ENOENT"
          ? { complete: true, path: lockPath, status: "already_absent" }
          : {
              complete: false,
              path: lockPath,
              status: "cleanup_failed",
              error: String(error),
              remediation:
                "Verify no Agent Boost install owns the path before removing only the reported lock.",
            };
      }
      try {
        await handle.close();
      } catch (error) {
        cleanup = {
          ...cleanup,
          complete: false,
          close_error: String(error),
        };
      }
      return cleanup;
    },
  };
}

function lockOwnerPid(owner: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(owner);
    if (isPlainRecord(parsed) && Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0) {
      return Number(parsed.pid);
    }
  } catch {
    // An unverifiable lock is intentionally never removed automatically.
  }
  return undefined;
}

async function resolveHermesConfigPath(
  runCommand: CommandRunner,
  hermesCommand: string,
): Promise<string> {
  let result: CommandResult;
  try {
    result = await runCommand(hermesCommand, ["config", "path"]);
  } catch (error) {
    throw new HermesInstallError(
      "COMMAND_FAILED",
      "Could not launch Hermes to resolve its active configuration path.",
      { command: `${hermesCommand} config path`, cause: String(error) },
    );
  }
  if (result.exitCode !== 0) {
    throw new HermesInstallError(
      "COMMAND_FAILED",
      "Could not resolve the active Hermes configuration path.",
      {
        command: `${hermesCommand} config path`,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    );
  }

  const lines = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const direct = lines.findLast((line) => isAbsolute(line));
  const labelled = lines
    .map((line) => line.match(/(?:^|:\s*)(\/.*)$/u)?.[1]?.trim())
    .findLast((line) => line !== undefined && isAbsolute(line));
  const configPath = direct ?? labelled;

  if (configPath === undefined || !isAbsolute(configPath)) {
    throw new HermesInstallError(
      "CONFIG_PATH_INVALID",
      "`hermes config path` did not return an absolute path.",
      { stdout: result.stdout },
    );
  }
  return configPath;
}

async function validateExecutable(input: string): Promise<string> {
  if (!isAbsolute(input)) {
    throw new HermesInstallError(
      "EXECUTABLE_INVALID",
      "The Agent Boost executable path must be absolute.",
      { executablePath: input },
    );
  }
  try {
    await access(input, fsConstants.X_OK);
    return await realpath(input);
  } catch (error) {
    throw new HermesInstallError(
      "EXECUTABLE_INVALID",
      "The Agent Boost executable is missing or not executable.",
      { executablePath: input, cause: String(error) },
    );
  }
}

async function readConfig(configPath: string): Promise<{
  exists: boolean;
  content: Buffer;
  mode?: number;
}> {
  const snapshot = await readFileSnapshot(configPath);
  return snapshot.exists
    ? snapshot
    : { exists: false, content: Buffer.from("{}\n") };
}

async function planHookAllowlist(
  path: string,
  command: string,
  legacyCommands: readonly string[],
): Promise<HookAllowlistPlan> {
  const original = await readFileSnapshot(path);
  let parsed: unknown = { approvals: [] };
  if (original.exists) {
    try {
      parsed = JSON.parse(original.content.toString("utf8")) as unknown;
    } catch (error) {
      throw new HermesInstallError(
        "HOOK_ALLOWLIST_INVALID",
        "The Hermes shell-hook allowlist is not valid JSON; refusing to replace it.",
        { path, cause: String(error) },
      );
    }
  }
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.approvals)) {
    throw new HermesInstallError(
      "HOOK_ALLOWLIST_INVALID",
      "The Hermes shell-hook allowlist must contain an `approvals` array; refusing to replace it.",
      { path },
    );
  }
  const managedEvents = new Set(["pre_tool_call", "post_tool_call"]);
  const retiredEvents = new Set(["pre_llm_call"]);
  const legacyCommandSet = new Set(legacyCommands);
  const seenCurrentPairs = new Set<string>();
  const approvals = (parsed.approvals as unknown[]).filter((entry) => {
    if (
      !isPlainRecord(entry) ||
      typeof entry.event !== "string" ||
      typeof entry.command !== "string" ||
      (!managedEvents.has(entry.event) && !retiredEvents.has(entry.event))
    ) {
      return true;
    }
    if (retiredEvents.has(entry.event)) {
      const usesManagedCommand = entry.command === command ||
        legacyCommandSet.has(entry.command);
      return !usesManagedCommand || !deepEqual(entry, {
        event: entry.event,
        command: entry.command,
      });
    }
    if (legacyCommandSet.has(entry.command)) return false;
    if (entry.command !== command) return true;
    if (seenCurrentPairs.has(entry.event)) return false;
    seenCurrentPairs.add(entry.event);
    return true;
  });

  const required = (["pre_tool_call", "post_tool_call"] as const).map((event) => ({
    event,
    command,
  }));
  const missing = required.filter((requiredEntry) =>
    !approvals.some((entry) =>
      isPlainRecord(entry) &&
      entry.event === requiredEntry.event &&
      entry.command === requiredEntry.command
    )
  );
  const approvalsChanged = approvals.length !== parsed.approvals.length;
  const contentChanged = !original.exists || missing.length > 0 || approvalsChanged;
  const modeChanged = original.exists && original.mode !== 0o600;
  if (!contentChanged && !modeChanged) {
    return {
      path,
      command,
      content: original.content,
      changed: false,
      original,
    };
  }
  return {
    path,
    command,
    content: contentChanged
      ? Buffer.from(`${JSON.stringify({
          ...parsed,
          approvals: [...approvals, ...missing],
        }, null, 2)}\n`)
      : original.content,
    changed: true,
    original,
  };
}

function parseHermesConfig(content: Buffer, configPath: string) {
  const document = parseDocument(content.toString("utf8"));
  if (document.errors.length > 0) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The active Hermes configuration is not valid YAML.",
      {
        configPath,
        errors: document.errors.map((error) => error.message),
      },
    );
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The active Hermes configuration must contain a top-level YAML mapping.",
      { configPath },
    );
  }
  return document;
}

async function planSkill(
  name: SkillPlan["name"],
  sourcePath: string,
  skillsDirectory: string,
): Promise<SkillPlan> {
  const content = await readFile(sourcePath);
  const destinationPath = join(skillsDirectory, name, "SKILL.md");
  const managedRoot = dirname(skillsDirectory);
  const destinationDirectoryExisted = await assertSafeManagedParent(
    managedRoot,
    destinationPath,
  );
  const original = await readFileSnapshot(destinationPath);
  const changed = !original.exists || !original.content.equals(content);
  return {
    name,
    sourcePath,
    destinationPath,
    content,
    changed,
    original,
    destinationDirectoryExisted,
    managedRoot,
  };
}

async function planManagedFile(
  sourcePath: string,
  destinationPath: string,
): Promise<ManagedFilePlan> {
  const content = await readFile(sourcePath);
  const managedRoot = dirname(dirname(dirname(destinationPath)));
  const destinationDirectoryExisted = await assertSafeManagedParent(
    managedRoot,
    destinationPath,
  );
  const original = await readFileSnapshot(destinationPath);
  return {
    sourcePath,
    destinationPath,
    content,
    changed: !original.exists || !original.content.equals(content),
    original,
    destinationDirectoryExisted,
    managedRoot,
  };
}

async function applyManagedFilePlan(
  plan: ManagedFilePlan,
  now: () => Date,
  onMutationAttempt: () => void,
  onBackupPath: (path: string) => void,
): Promise<void> {
  await assertSafeManagedParent(plan.managedRoot, plan.destinationPath);
  await assertInstallTargetUnchanged(plan.destinationPath, plan.original);
  if (!plan.changed) return;
  await mkdir(dirname(plan.destinationPath), { recursive: true });
  await assertSafeManagedParent(plan.managedRoot, plan.destinationPath);
  await assertInstallTargetUnchanged(plan.destinationPath, plan.original);
  if (plan.original.exists) {
    await createBackup(
      plan.destinationPath,
      plan.original.content,
      now,
      onBackupPath,
    );
  }
  await assertInstallTargetUnchanged(plan.destinationPath, plan.original);
  onMutationAttempt();
  await atomicWrite(plan.destinationPath, plan.content, 0o644);
}

async function applySkillPlan(
  plan: SkillPlan,
  now: () => Date,
  onMutationAttempt: () => void,
  onBackupPath: (path: string) => void,
): Promise<InstalledHermesSkill> {
  await assertSafeManagedParent(plan.managedRoot, plan.destinationPath);
  await assertInstallTargetUnchanged(plan.destinationPath, plan.original);
  if (!plan.changed) {
    return { name: plan.name, path: plan.destinationPath, changed: false };
  }

  await mkdir(dirname(plan.destinationPath), { recursive: true });
  await assertSafeManagedParent(plan.managedRoot, plan.destinationPath);
  await assertInstallTargetUnchanged(plan.destinationPath, plan.original);
  const backupPath = plan.original.exists
    ? await createBackup(
        plan.destinationPath,
        plan.original.content,
        now,
        onBackupPath,
      )
    : undefined;
  await assertInstallTargetUnchanged(plan.destinationPath, plan.original);
  onMutationAttempt();
  await atomicWrite(plan.destinationPath, plan.content, 0o644);
  return {
    name: plan.name,
    path: plan.destinationPath,
    changed: true,
    ...(backupPath === undefined ? {} : { backupPath }),
  };
}

async function assertSafeManagedParent(
  managedRoot: string,
  destinationPath: string,
): Promise<boolean> {
  const root = resolve(managedRoot);
  const parent = resolve(dirname(destinationPath));
  const fromRoot = relative(root, parent);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new HermesInstallError(
      "INSTALL_TARGET_UNSAFE",
      "Hermes integration targets must remain inside the active Hermes profile.",
      { managedRoot: root, path: destinationPath },
    );
  }

  const components = fromRoot === "" ? [] : fromRoot.split(sep);
  let current = root;
  let parentExists = true;
  for (const component of ["", ...components]) {
    if (component) current = join(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new HermesInstallError(
          "INSTALL_TARGET_UNSAFE",
          "Hermes integration parent paths must be real directories, not links or non-directories.",
          { managedRoot: root, path: destinationPath, unsafeParent: current },
        );
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        parentExists = false;
        break;
      }
      throw error;
    }
  }
  return parentExists;
}

async function assertInstallTargetUnchanged(
  path: string,
  planned: FileSnapshot,
): Promise<void> {
  const current = await readFileSnapshot(path);
  if (snapshotsEqual(current, planned)) return;
  throw new HermesInstallError(
    "INSTALL_TARGET_CHANGED",
    "A Hermes integration file changed while the install was being prepared; refusing to overwrite it.",
    { path },
  );
}

async function rollbackInstall(input: {
  configPath: string;
  configMutationAttempted: boolean;
  installedConfig: Buffer;
  installedConfigMode: number;
  originalConfig: FileSnapshot;
  hookAllowlistPlan: HookAllowlistPlan;
  hookAllowlistMutationAttempted: boolean;
  attemptedSkillPlans: SkillPlan[];
  attemptedOutputGuardPlans: ManagedFilePlan[];
  backupPathCandidates: string[];
}): Promise<{
  complete: boolean;
  entries: Array<Record<string, unknown>>;
  backupPaths: string[];
}> {
  const entries: Array<Record<string, unknown>> = [];
  if (input.configMutationAttempted) {
    entries.push(await restoreFileIfOwned({
      path: input.configPath,
      installedContent: input.installedConfig,
      installedMode: input.installedConfigMode,
      original: input.originalConfig,
      removeEmptyParent: false,
    }));
  }
  if (input.hookAllowlistMutationAttempted) {
    entries.push(await restoreFileIfOwned({
      path: input.hookAllowlistPlan.path,
      installedContent: input.hookAllowlistPlan.content,
      installedMode: 0o600,
      original: input.hookAllowlistPlan.original,
      removeEmptyParent: false,
    }));
  }
  for (const plan of [...input.attemptedOutputGuardPlans].reverse()) {
    entries.push(await restoreFileIfOwned({
      path: plan.destinationPath,
      installedContent: plan.content,
      installedMode: 0o644,
      original: plan.original,
      removeEmptyParent: !plan.destinationDirectoryExisted,
    }));
  }
  for (const plan of [...input.attemptedSkillPlans].reverse()) {
    entries.push(await restoreFileIfOwned({
      path: plan.destinationPath,
      installedContent: plan.content,
      installedMode: 0o644,
      original: plan.original,
      removeEmptyParent: !plan.destinationDirectoryExisted,
    }));
  }
  const backupPaths: string[] = [];
  for (const path of input.backupPathCandidates) {
    if (await pathExists(path)) backupPaths.push(path);
  }
  return {
    complete: entries.every((entry) =>
      entry.status !== "conflict" && entry.status !== "failed"
    ),
    entries,
    backupPaths,
  };
}

async function restoreFileIfOwned(input: {
  path: string;
  installedContent: Buffer;
  installedMode: number;
  original: FileSnapshot;
  removeEmptyParent: boolean;
}): Promise<Record<string, unknown>> {
  try {
    const current = await readFileSnapshot(input.path);
    if (snapshotsEqual(current, input.original)) {
      return { path: input.path, status: "unchanged" };
    }
    const owned =
      current.exists &&
      current.mode === input.installedMode &&
      current.content.equals(input.installedContent);
    if (!owned) {
      return {
        path: input.path,
        status: "conflict",
        reason: "The file changed outside this install; it was left untouched.",
      };
    }
    if (input.original.exists) {
      await atomicWrite(
        input.path,
        input.original.content,
        input.original.mode ?? 0o600,
      );
      return { path: input.path, status: "restored" };
    }
    await unlink(input.path);
    let parentRemoved = false;
    if (input.removeEmptyParent) {
      try {
        await rmdir(dirname(input.path));
        parentRemoved = true;
      } catch (error) {
        if (
          !isNodeError(error) ||
          (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST")
        ) {
          return {
            path: input.path,
            status: "failed",
            operation: "remove-empty-parent",
            error: String(error),
          };
        }
      }
    }
    return { path: input.path, status: "removed", parentRemoved };
  } catch (error) {
    return { path: input.path, status: "failed", error: String(error) };
  }
}

async function readFileSnapshot(path: string): Promise<FileSnapshot> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new HermesInstallError(
        "INSTALL_TARGET_UNSAFE",
        "Hermes integration targets must be regular files with a single filesystem link.",
        { path },
      );
    }
    const content = await readFile(path);
    return { exists: true, content, mode: metadata.mode & 0o777 };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { exists: false, content: Buffer.alloc(0) };
    }
    throw error;
  }
}

function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return left.mode === right.mode && left.content.equals(right.content);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function createBackup(
  targetPath: string,
  content: Buffer,
  now: () => Date,
  onBackupPath: (path: string) => void = () => undefined,
): Promise<string> {
  const timestamp = now().toISOString().replace(/[:.]/gu, "-");
  const backupPath =
    `${targetPath}.agent-boost-${timestamp}-${randomUUID()}.bak`;
  onBackupPath(backupPath);
  await atomicWrite(backupPath, content, 0o600);
  return backupPath;
}

async function atomicWrite(
  destinationPath: string,
  content: Buffer,
  mode: number,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const temporaryPath = join(
    dirname(destinationPath),
    `.${basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", mode);
  let renamed = false;
  try {
    try {
      await handle.writeFile(content);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, destinationPath);
    renamed = true;
    const directory = await open(dirname(destinationPath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortRecursively(left)) === JSON.stringify(sortRecursively(right));
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortRecursively);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortRecursively(nested)]),
    );
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
