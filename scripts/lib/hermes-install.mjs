import { spawnCommand } from "./kohaku-install.mjs";

export async function configureHermesIfAvailable(options) {
  const runCommand = options.runCommand ?? spawnCommand;
  let probe;
  try {
    probe = await runCommand("hermes", ["--version"], { timeoutMs: 30_000 });
  } catch {
    return missingHermes(options.agentBoostExecutable);
  }
  if (probe.exitCode !== 0) return missingHermes(options.agentBoostExecutable);

  const configured = await runCommand(
    options.agentBoostExecutable,
    [
      "install-hermes",
      "--executable",
      options.agentBoostExecutable,
    ],
    { timeoutMs: 3 * 60_000 },
  );
  if (configured.exitCode !== 0) {
    const detail =
      configured.stderr?.trim() || configured.stdout?.trim() || "no diagnostics";
    throw new Error(`Hermes integration failed: ${detail.slice(0, 2_000)}`);
  }
  let result;
  try {
    result = JSON.parse(configured.stdout);
  } catch {
    throw new Error("Hermes integration returned invalid JSON");
  }
  return {
    status: "configured",
    hermes_version: probe.stdout.trim() || "available",
    result,
    next: result.next ??
      "Restart the active Hermes session or reload MCP discovery, then ask Hermes to set up Agent Boost.",
  };
}

function missingHermes(agentBoostExecutable) {
  const quotedExecutable = shellQuote(agentBoostExecutable);
  return {
    status: "not_found",
    warning:
      "Hermes was not found on PATH, so its Agent Boost integration was not configured.",
    command: `${quotedExecutable} install-hermes --executable ${quotedExecutable}`,
    next:
      "Install Hermes or make it available on PATH, then run the command above.",
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
