import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("loadConfig is Sepolia-only, HTTPS-only, and avoids reserved ports", () => {
  const config = loadConfig({}, "/tmp/agent-boost-home");
  assert.equal(config.uiPort, 9183);
  assert.equal(config.autoOpenUi, false);
  assert.equal(config.torRpcPort, 9185);
  assert.equal(config.shadeTreeProxyPort, 9186);
  assert.equal(config.shadeTreeEnabled, true);
  assert.equal(config.shadeTreeMaxResponseBytes, 1_048_576);
  assert.equal(config.torDataDir, "/tmp/agent-boost-home/.local/share/agent-boost/tor");
  assert.equal(config.fundingTargetWei, 200_000_000_000_000_000n);
  assert.equal(config.paymentLimitWei, 1_000_000_000_000_000_000n);
  assert.equal(config.paymentLifetimeLimitWei, 10_000_000_000_000_000_000n);
  assert.equal(config.maxPayments, 10);
  assert.equal(config.delegationTtlMs, 7 * 24 * 60 * 60_000);
  assert.deepEqual(config.security.default, {
    "wallet.read": "allow",
    "payment.plan": "allow",
    "payment.execute": "confirm",
  });
  assert.deepEqual(config.security.overrides, {});
  assert.equal(config.security.effective["payment.execute"], "confirm");
  assert.match(config.rpcUrl, /^https:/);
  assert.equal(
    config.kohakuBin,
    "/tmp/agent-boost-home/.local/share/agent-boost/dependencies/kohaku-cli/bin/kohaku.mjs",
  );

  assert.throws(
    () => loadConfig({ AGENT_BOOST_RPC_URL: "http://rpc.example" }, "/tmp/home"),
    /must use HTTPS/,
  );
  const customPolicy = loadConfig(
    {
      AGENT_BOOST_PAYMENT_LIMIT_WEI: "2000000000000000000",
      AGENT_BOOST_MAX_PAYMENTS: "3",
    },
    "/tmp/home",
  );
  assert.equal(customPolicy.paymentLifetimeLimitWei, 6_000_000_000_000_000_000n);
  assert.equal(customPolicy.maxPayments, 3);
  assert.throws(
    () => loadConfig({ AGENT_BOOST_UI_PORT: "9180" }, "/tmp/home"),
    /reserved ports/,
  );
  assert.throws(
    () => loadConfig({ AGENT_BOOST_UI_PORT: "9184" }, "/tmp/home"),
    /reserved ports/,
  );
  assert.throws(
    () => loadConfig({ AGENT_BOOST_UI_PORT: "9185" }, "/tmp/home"),
    /reserved ports/,
  );
  assert.throws(
    () => loadConfig({ AGENT_BOOST_TOR_RPC_PORT: "9183" }, "/tmp/home"),
    /UI port/,
  );
  assert.throws(
    () => loadConfig({ AGENT_BOOST_SHADE_TREE_PROXY_PORT: "9185" }, "/tmp/home"),
    /Tor RPC port/,
  );
  assert.equal(
    loadConfig({ AGENT_BOOST_PAYMENT_APPROVAL: "allow" }, "/tmp/home")
      .security.effective["payment.execute"],
    "allow",
  );
  assert.throws(
    () => loadConfig({ AGENT_BOOST_PAYMENT_APPROVAL: "sometimes" }, "/tmp/home"),
    /must be allow, confirm, or deny/,
  );
  assert.equal(
    loadConfig({ AGENT_BOOST_DELEGATION_TTL_MS: "86400000" }, "/tmp/home")
      .delegationTtlMs,
    86_400_000,
  );
  assert.throws(
    () => loadConfig({ AGENT_BOOST_DELEGATION_TTL_MS: "0" }, "/tmp/home"),
    /must be a positive integer/,
  );
});
