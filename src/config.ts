import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  DEFAULT_FUNDING_WEI,
  DEFAULT_LIFETIME_LIMIT_WEI,
  DEFAULT_MAX_PAYMENTS,
  DEFAULT_PAYMENT_LIMIT_WEI,
  DEFAULT_SHIELD_WEI,
  MAX_POLICY_LIFETIME_LIMIT_WEI,
  MAX_POLICY_PAYMENT_LIMIT_WEI,
  MAX_POLICY_PAYMENTS,
  MAX_POLICY_TTL_MS,
  TORNADO_DEPOSIT_GAS_RESERVE_WEI,
  type PaymentApproval,
} from "./contracts.js";
import { AGENT_BOOST_RUNTIME_LOCK_PORT } from "./state/runtime-lock.js";

export interface AgentBoostConfig {
  stateDir: string;
  torDataDir: string;
  torBootstrapTimeoutMs: number;
  torRpcPort: number;
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
  paymentLifetimeLimitWei: bigint;
  maxPayments: number;
  delegationTtlMs: number;
  autoOpenUi: boolean;
  autoShield: boolean;
  executeEnabled: boolean;
  security: {
    default: {
      "wallet.read": "allow";
      "payment.plan": "allow";
      "payment.execute": "confirm";
    };
    overrides: {
      "payment.execute"?: PaymentApproval;
    };
    effective: {
      "wallet.read": "allow";
      "payment.plan": "allow";
      "payment.execute": PaymentApproval;
    };
  };
  fundingPollMs: number;
  privateBalancePollMs: number;
  setupTimeoutMs: number;
  shadeTreeEnabled: boolean;
  shadeTreeInstallDir: string;
  shadeTreeBin: string;
  shadeTreeProfileDir: string;
  shadeTreeSlotStateDir: string;
  shadeTreeProxyPort: number;
  shadeTreeStartTimeoutMs: number;
  shadeTreeRequestTimeoutMs: number;
  shadeTreeMaxResponseBytes: number;
}

const DEFAULT_SECURITY = {
  "wallet.read": "allow",
  "payment.plan": "allow",
  "payment.execute": "confirm",
} as const;

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

function paymentApprovalEnv(value: string | undefined): PaymentApproval | undefined {
  if (value === undefined) return undefined;
  if (value === "allow" || value === "confirm" || value === "deny") return value;
  throw new Error("AGENT_BOOST_PAYMENT_APPROVAL must be allow, confirm, or deny");
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
  const shadeTreeInstallDir = resolve(
    env.AGENT_BOOST_SHADE_TREE_INSTALL_DIR ??
      `${stateDir}/dependencies/shade-tree`,
  );
  const paymentApprovalOverride = paymentApprovalEnv(
    env.AGENT_BOOST_PAYMENT_APPROVAL,
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
    uiPort === AGENT_BOOST_RUNTIME_LOCK_PORT ||
    uiPort === 9185
  ) {
    throw new Error(
      "AGENT_BOOST_UI_PORT must be between 1 and 65535 and cannot use reserved ports 9180, 9184, or 9185",
    );
  }

  const torRpcPort = positiveIntegerEnv(
    env.AGENT_BOOST_TOR_RPC_PORT,
    9185,
    "AGENT_BOOST_TOR_RPC_PORT",
  );
  if (
    torRpcPort > 65_535 ||
    torRpcPort === 9180 ||
    torRpcPort === AGENT_BOOST_RUNTIME_LOCK_PORT ||
    torRpcPort === uiPort
  ) {
    throw new Error(
      "AGENT_BOOST_TOR_RPC_PORT must be an available port other than 9180, 9184, or the UI port",
    );
  }

  const shadeTreeProxyPort = positiveIntegerEnv(
    env.AGENT_BOOST_SHADE_TREE_PROXY_PORT,
    9186,
    "AGENT_BOOST_SHADE_TREE_PROXY_PORT",
  );
  if (
    shadeTreeProxyPort > 65_535 ||
    shadeTreeProxyPort === 9180 ||
    shadeTreeProxyPort === AGENT_BOOST_RUNTIME_LOCK_PORT ||
    shadeTreeProxyPort === uiPort ||
    shadeTreeProxyPort === torRpcPort
  ) {
    throw new Error(
      "AGENT_BOOST_SHADE_TREE_PROXY_PORT must be an available port other than 9180, 9184, the UI port, or the Tor RPC port",
    );
  }

  const paymentLimitWei = unsignedBigIntEnv(
    env.AGENT_BOOST_PAYMENT_LIMIT_WEI,
    DEFAULT_PAYMENT_LIMIT_WEI,
    "AGENT_BOOST_PAYMENT_LIMIT_WEI",
  );
  const maxPayments = positiveIntegerEnv(
    env.AGENT_BOOST_MAX_PAYMENTS,
    DEFAULT_MAX_PAYMENTS,
    "AGENT_BOOST_MAX_PAYMENTS",
  );
  const paymentLifetimeLimitWei = unsignedBigIntEnv(
    env.AGENT_BOOST_LIFETIME_LIMIT_WEI,
    env.AGENT_BOOST_PAYMENT_LIMIT_WEI === undefined &&
        env.AGENT_BOOST_MAX_PAYMENTS === undefined
      ? DEFAULT_LIFETIME_LIMIT_WEI
      : paymentLimitWei * BigInt(maxPayments),
    "AGENT_BOOST_LIFETIME_LIMIT_WEI",
  );
  const delegationTtlMs = positiveIntegerEnv(
    env.AGENT_BOOST_DELEGATION_TTL_MS,
    7 * 24 * 60 * 60_000,
    "AGENT_BOOST_DELEGATION_TTL_MS",
  );
  if (paymentLimitWei <= 0n || paymentLimitWei > MAX_POLICY_PAYMENT_LIMIT_WEI) {
    throw new Error("AGENT_BOOST_PAYMENT_LIMIT_WEI exceeds the adjustable testnet bounds");
  }
  if (maxPayments > MAX_POLICY_PAYMENTS) {
    throw new Error("AGENT_BOOST_MAX_PAYMENTS exceeds the adjustable testnet bounds");
  }
  if (
    paymentLifetimeLimitWei <= 0n ||
    paymentLifetimeLimitWei > MAX_POLICY_LIFETIME_LIMIT_WEI ||
    paymentLifetimeLimitWei > paymentLimitWei * BigInt(maxPayments)
  ) {
    throw new Error("AGENT_BOOST_LIFETIME_LIMIT_WEI exceeds the configured payment envelope");
  }
  if (delegationTtlMs > MAX_POLICY_TTL_MS) {
    throw new Error("AGENT_BOOST_DELEGATION_TTL_MS exceeds the adjustable testnet bounds");
  }
  const shieldAmountWei = unsignedBigIntEnv(
    env.AGENT_BOOST_SHIELD_WEI,
    DEFAULT_SHIELD_WEI,
    "AGENT_BOOST_SHIELD_WEI",
  );
  if (shieldAmountWei !== DEFAULT_SHIELD_WEI) {
    throw new Error(
      `AGENT_BOOST_SHIELD_WEI must equal the pinned Sepolia Tornado 0.1 ETH denomination (${DEFAULT_SHIELD_WEI.toString()} wei)`,
    );
  }
  const fundingTargetWei = unsignedBigIntEnv(
    env.AGENT_BOOST_FUNDING_WEI,
    DEFAULT_FUNDING_WEI,
    "AGENT_BOOST_FUNDING_WEI",
  );
  const autoShield = booleanEnv(env.AGENT_BOOST_AUTO_SHIELD, true);
  if (
    autoShield &&
    fundingTargetWei < shieldAmountWei + TORNADO_DEPOSIT_GAS_RESERVE_WEI
  ) {
    throw new Error(
      "AGENT_BOOST_FUNDING_WEI must cover the shield amount plus the Tornado deposit gas reserve",
    );
  }

  return {
    stateDir,
    torDataDir: resolve(
      env.AGENT_BOOST_TOR_DATA_DIR ?? `${stateDir}/tor`,
    ),
    torBootstrapTimeoutMs: positiveIntegerEnv(
      env.AGENT_BOOST_TOR_BOOTSTRAP_TIMEOUT_MS,
      120_000,
      "AGENT_BOOST_TOR_BOOTSTRAP_TIMEOUT_MS",
    ),
    torRpcPort,
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
    fundingTargetWei,
    shieldAmountWei,
    paymentLimitWei,
    paymentLifetimeLimitWei,
    maxPayments,
    delegationTtlMs,
    autoOpenUi: booleanEnv(env.AGENT_BOOST_OPEN_UI, false),
    autoShield,
    executeEnabled: booleanEnv(env.AGENT_BOOST_EXECUTE, true),
    security: {
      default: { ...DEFAULT_SECURITY },
      overrides: paymentApprovalOverride === undefined
        ? {}
        : { "payment.execute": paymentApprovalOverride },
      effective: {
        ...DEFAULT_SECURITY,
        ...(paymentApprovalOverride === undefined
          ? {}
          : { "payment.execute": paymentApprovalOverride }),
      },
    },
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
    shadeTreeEnabled: booleanEnv(env.AGENT_BOOST_SHADE_TREE_ENABLED, true),
    shadeTreeInstallDir,
    shadeTreeBin:
      env.AGENT_BOOST_SHADE_TREE_BIN ?? `${shadeTreeInstallDir}/bin/shade-tree`,
    shadeTreeProfileDir: resolve(
      env.AGENT_BOOST_SHADE_TREE_PROFILE_DIR ?? `${stateDir}/shade-tree/profile`,
    ),
    shadeTreeSlotStateDir: resolve(
      env.AGENT_BOOST_SHADE_TREE_SLOT_STATE_DIR ?? `${stateDir}/shade-tree/slots`,
    ),
    shadeTreeProxyPort,
    shadeTreeStartTimeoutMs: positiveIntegerEnv(
      env.AGENT_BOOST_SHADE_TREE_START_TIMEOUT_MS,
      10_000,
      "AGENT_BOOST_SHADE_TREE_START_TIMEOUT_MS",
    ),
    shadeTreeRequestTimeoutMs: positiveIntegerEnv(
      env.AGENT_BOOST_SHADE_TREE_REQUEST_TIMEOUT_MS,
      30_000,
      "AGENT_BOOST_SHADE_TREE_REQUEST_TIMEOUT_MS",
    ),
    shadeTreeMaxResponseBytes: positiveIntegerEnv(
      env.AGENT_BOOST_SHADE_TREE_MAX_RESPONSE_BYTES,
      1_048_576,
      "AGENT_BOOST_SHADE_TREE_MAX_RESPONSE_BYTES",
    ),
  };
}
