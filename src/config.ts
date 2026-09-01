import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  DEFAULT_FUNDING_WEI,
  DEFAULT_PAYMENT_LIMIT_WEI,
  DEFAULT_SHIELD_WEI,
} from "./contracts.js";
import { AGENT_BOOST_RUNTIME_LOCK_PORT } from "./state/runtime-lock.js";

export interface AgentBoostConfig {
  stateDir: string;
  kohakuDataDir: string;
  kohakuInstallDir: string;
  kohakuPasswordFile: string;
  kohakuBin: string;
  kohakuWalletName: string;
  rpcUrl: string;
  uiHost: "127.0.0.1";
  uiPort: number;
  fundingTargetWei: bigint;
  shieldAmountWei: bigint;
  paymentLimitWei: bigint;
  autoOpenUi: boolean;
  autoShield: boolean;
  executeEnabled: boolean;
  fundingPollMs: number;
  privateBalancePollMs: number;
  setupTimeoutMs: number;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function positiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function unsignedBigIntEnv(
  value: string | undefined,
  fallback: bigint,
  name: string,
): bigint {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a canonical atomic-unit integer string`);
  }
  return BigInt(value);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): AgentBoostConfig {
  const stateDir = resolve(
    env.AGENT_BOOST_STATE_DIR ?? `${home}/.local/share/agent-boost`,
  );
  const rpcUrl =
    env.AGENT_BOOST_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
  const kohakuInstallDir = resolve(
    env.AGENT_BOOST_KOHAKU_INSTALL_DIR ??
      `${stateDir}/dependencies/kohaku-cli`,
  );

  let parsedRpc: URL;
  try {
    parsedRpc = new URL(rpcUrl);
  } catch {
    throw new Error("AGENT_BOOST_RPC_URL must be a valid HTTPS URL");
  }
  if (parsedRpc.protocol !== "https:") {
    throw new Error("AGENT_BOOST_RPC_URL must use HTTPS");
  }

  const uiPort = positiveIntegerEnv(env.AGENT_BOOST_UI_PORT, 9183, "AGENT_BOOST_UI_PORT");
  if (
    uiPort > 65_535 ||
    uiPort === 9180 ||
    uiPort === AGENT_BOOST_RUNTIME_LOCK_PORT
  ) {
    throw new Error(
      "AGENT_BOOST_UI_PORT must be between 1 and 65535 and cannot use reserved ports 9180 or 9184",
    );
  }

  return {
    stateDir,
    kohakuDataDir: resolve(
      env.AGENT_BOOST_KOHAKU_DATA_DIR ?? `${stateDir}/kohaku`,
    ),
    kohakuInstallDir,
    kohakuPasswordFile: resolve(
      env.AGENT_BOOST_KOHAKU_PASSWORD_FILE ?? `${stateDir}/secrets/kohaku-password`,
    ),
    kohakuBin:
      env.AGENT_BOOST_KOHAKU_BIN ?? `${kohakuInstallDir}/bin/kohaku.mjs`,
    kohakuWalletName: env.AGENT_BOOST_KOHAKU_WALLET ?? "agent-boost",
    rpcUrl,
    uiHost: "127.0.0.1",
    uiPort,
    fundingTargetWei: unsignedBigIntEnv(
      env.AGENT_BOOST_FUNDING_WEI,
      DEFAULT_FUNDING_WEI,
      "AGENT_BOOST_FUNDING_WEI",
    ),
    shieldAmountWei: unsignedBigIntEnv(
      env.AGENT_BOOST_SHIELD_WEI,
      DEFAULT_SHIELD_WEI,
      "AGENT_BOOST_SHIELD_WEI",
    ),
    paymentLimitWei: unsignedBigIntEnv(
      env.AGENT_BOOST_PAYMENT_LIMIT_WEI,
      DEFAULT_PAYMENT_LIMIT_WEI,
      "AGENT_BOOST_PAYMENT_LIMIT_WEI",
    ),
    autoOpenUi: booleanEnv(env.AGENT_BOOST_OPEN_UI, true),
    autoShield: booleanEnv(env.AGENT_BOOST_AUTO_SHIELD, true),
    executeEnabled: booleanEnv(env.AGENT_BOOST_EXECUTE, true),
    fundingPollMs: positiveIntegerEnv(
      env.AGENT_BOOST_FUNDING_POLL_MS,
      4_000,
      "AGENT_BOOST_FUNDING_POLL_MS",
    ),
    privateBalancePollMs: positiveIntegerEnv(
      env.AGENT_BOOST_PRIVATE_POLL_MS,
      8_000,
      "AGENT_BOOST_PRIVATE_POLL_MS",
    ),
    setupTimeoutMs: positiveIntegerEnv(
      env.AGENT_BOOST_SETUP_TIMEOUT_MS,
      30 * 60_000,
      "AGENT_BOOST_SETUP_TIMEOUT_MS",
    ),
  };
}
