import { spawn, type ChildProcess } from "node:child_process";

export interface OpenBrowserOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

function waitForSpawn(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("spawn", () => {
      child.unref();
      finish(true);
    });
    child.once("error", () => finish(false));
  });
}

/** Opens the local setup page without a shell. Headless and unsupported hosts return false. */
export async function openFundingUi(
  url: string,
  options: OpenBrowserOptions = {},
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    return false;
  }

  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const spawnProcess = options.spawnProcess ?? spawn;
  let command: string;
  let args: string[];

  if (platform === "darwin") {
    command = "open";
    args = [parsed.href];
  } else if (platform === "linux" && (environment.DISPLAY || environment.WAYLAND_DISPLAY)) {
    command = "xdg-open";
    args = [parsed.href];
  } else {
    return false;
  }

  try {
    return await waitForSpawn(spawnProcess(command, args, {
      detached: true,
      stdio: "ignore",
      env: environment,
    }));
  } catch {
    return false;
  }
}

export const openVisibleBrowser = openFundingUi;
