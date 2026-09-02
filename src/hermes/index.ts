import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isMap, parseDocument } from "yaml";

export const HERMES_SERVER_NAME = "agent-boost";
export const HERMES_MCP_TIMEOUT_SECONDS = 180;

export const HERMES_NATIVE_TOOLS = [
  "capabilities",
  "onboarding_start",
  "onboarding_status",
  "wallet_get_context",
  "wallet_start_new_demo",
  "wallet_plan_private_payment",
  "wallet_execute_private_payment",
  "wallet_get_request",
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
  now?: () => Date;
}

export interface InstalledHermesSkill {
  name: "agent-boost-setup" | "agent-boost";
  path: string;
  changed: boolean;
  backupPath?: string;
}

export interface HermesIntegrationResult {
  configPath: string;
  configChanged: boolean;
  configBackupPath?: string;
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
}

const DEFAULT_SETUP_SKILL = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost-setup/SKILL.md", import.meta.url),
);
const DEFAULT_OPERATIONAL_SKILL = fileURLToPath(
  new URL("../../integrations/hermes/agent-boost/SKILL.md", import.meta.url),
);

const RESTART_RECOMMENDATION =
  "If Hermes is already running, restart it once before setup. The no-restart commands are /reload-skills then /reload-mcp in the local CLI, or !reload-skills then !reload-mcp over Matrix. The installer did not restart Hermes.";

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
  const originalConfig = await readConfig(configPath);
  const document = parseHermesConfig(originalConfig.content, configPath);
  const desiredServer = createHermesServerConfig(executablePath);
  const configValue = document.toJS() as Record<string, unknown> | null;
  const mcpServers = configValue?.mcp_servers;
  if (mcpServers !== undefined && !isPlainRecord(mcpServers)) {
    throw new HermesInstallError(
      "CONFIG_INVALID",
      "The Hermes `mcp_servers` value must be a YAML mapping.",
      { configPath },
    );
  }
  const existingServer =
    isPlainRecord(mcpServers) && HERMES_SERVER_NAME in mcpServers
      ? mcpServers[HERMES_SERVER_NAME]
      : undefined;

  if (existingServer !== undefined) {
    if (!deepEqual(existingServer, desiredServer)) {
      throw new HermesInstallError(
        "MCP_SERVER_CONFLICT",
        `Hermes already has a conflicting ${HERMES_SERVER_NAME} MCP entry; refusing to replace it.`,
        { configPath, existing: existingServer, desired: desiredServer },
      );
    }
  }

  const configChanged = existingServer === undefined;
  if (configChanged) {
    document.setIn(["mcp_servers", HERMES_SERVER_NAME], desiredServer);
  }

  const skillsDirectory = join(dirname(configPath), "skills");
  const skillPlans = await Promise.all([
    planSkill(
      "agent-boost-setup",
      options.setupSkillSource ?? DEFAULT_SETUP_SKILL,
      skillsDirectory,
    ),
    planSkill(
      "agent-boost",
      options.operationalSkillSource ?? DEFAULT_OPERATIONAL_SKILL,
      skillsDirectory,
    ),
  ]);

  // Install skill instructions before exposing the MCP entry. Each individual
  // replacement is atomic and an existing differing file is retained as a
  // timestamped backup.
  const installedSkills: InstalledHermesSkill[] = [];
  for (const plan of skillPlans) {
    installedSkills.push(await applySkillPlan(plan, now));
  }

  let configBackupPath: string | undefined;
  if (configChanged) {
    await mkdir(dirname(configPath), { recursive: true });
    if (originalConfig.exists) {
      configBackupPath = await createBackup(
        configPath,
        originalConfig.content,
        now,
      );
    }
    const configMode = originalConfig.mode ?? 0o600;
    await atomicWrite(configPath, Buffer.from(document.toString()), configMode);
  }

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

  return {
    configPath,
    configChanged,
    ...(configBackupPath === undefined ? {} : { configBackupPath }),
    executablePath,
    skills: installedSkills,
    mcpTest,
    restartRequired: true,
    recommendation: RESTART_RECOMMENDATION,
  };
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
  try {
    const [content, metadata] = await Promise.all([
      readFile(configPath),
      stat(configPath),
    ]);
    return { exists: true, content, mode: metadata.mode & 0o777 };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { exists: false, content: Buffer.from("{}\n") };
    }
    throw error;
  }
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
  let changed = true;
  try {
    const existing = await readFile(destinationPath);
    changed = !existing.equals(content);
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw error;
    }
  }
  return { name, sourcePath, destinationPath, content, changed };
}

async function applySkillPlan(
  plan: SkillPlan,
  now: () => Date,
): Promise<InstalledHermesSkill> {
  if (!plan.changed) {
    return { name: plan.name, path: plan.destinationPath, changed: false };
  }

  await mkdir(dirname(plan.destinationPath), { recursive: true });
  let backupPath: string | undefined;
  try {
    const existing = await readFile(plan.destinationPath);
    backupPath = await createBackup(plan.destinationPath, existing, now);
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw error;
    }
  }
  await atomicWrite(plan.destinationPath, plan.content, 0o644);
  return {
    name: plan.name,
    path: plan.destinationPath,
    changed: true,
    ...(backupPath === undefined ? {} : { backupPath }),
  };
}

async function createBackup(
  targetPath: string,
  content: Buffer,
  now: () => Date,
): Promise<string> {
  const timestamp = now().toISOString().replace(/[:.]/gu, "-");
  const backupPath =
    `${targetPath}.agent-boost-${timestamp}-${randomUUID()}.bak`;
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
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, destinationPath);
    const directory = await open(dirname(destinationPath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
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
