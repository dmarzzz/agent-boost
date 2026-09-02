import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("loadConfig is Sepolia-only, HTTPS-only, and avoids reserved ports", () => {
  const config = loadConfig({}, "/tmp/agent-boost-home");
  assert.equal(config.uiPort, 9183);
  assert.equal(config.torRpcPort, 9185);
  assert.equal(config.shadeTreeProxyPort, 9186);
  assert.equal(config.shadeTreeEnabled, true);
  assert.equal(config.shadeTreeMaxResponseBytes, 1_048_576);
  assert.equal(config.torDataDir, "/tmp/agent-boost-home/.local/share/agent-boost/tor");
  assert.equal(config.fundingTargetWei, 200_000_000_000_000_000n);
  assert.equal(config.paymentLimitWei, 50_000_000_000_000_000n);
  assert.equal(config.delegationTtlMs, 7 * 24 * 60 * 60_000);
  assert.deepEqual(config.security.default, {
    "wallet.read": "allow",
    "payment.plan": "allow",
    "payment.execute": "confirm",
  });
  assert.deepEqual(config.security.overrides, {});
  assert.equal(config.security.effective["payment.execute"], "confirm");
  assert.match(config.rpcUrl, /^https:/);
  assert.deepEqual(config.privateInference, {
    enabled: false,
    baseUrl: "https://tee.redpill.ai/v1",
    modelAllowlist: [],
    trustMode: "reviewed_release",
    acceptedComposeHashes: [],
    acceptedSessionIds: [],
    requestTimeoutMs: 120_000,
    maxInputChars: 32_768,
    maxOutputTokens: 2_048,
    maxResponseBytes: 1_048_576,
  });
  assert.equal(
    config.kohakuBin,
    "/tmp/agent-boost-home/.local/share/agent-boost/dependencies/kohaku-cli/bin/kohaku.mjs",
  );

  assert.throws(
    () => loadConfig({ AGENT_BOOST_RPC_URL: "http://rpc.example" }, "/tmp/home"),
    /must use HTTPS/,
  );
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

test("disabled private inference ignores provider-only settings", () => {
  const config = loadConfig({
    AGENT_BOOST_PRIVATE_INFERENCE_BASE_URL: "http://insecure.example",
    AGENT_BOOST_PRIVATE_INFERENCE_TRUST_MODE: "anything",
    AGENT_BOOST_PRIVATE_INFERENCE_ACCEPTED_COMPOSE_HASHES: "invalid",
    AGENT_BOOST_PRIVATE_INFERENCE_REQUEST_TIMEOUT_MS: "0",
  }, "/tmp/home");
  assert.equal(config.privateInference.enabled, false);
});

test("private inference requires credentials, an allowlisted model, and release pins", () => {
  const base = {
    AGENT_BOOST_PRIVATE_INFERENCE_ENABLED: "true",
    AGENT_BOOST_PRIVATE_INFERENCE_API_KEY: "secret-test-key",
    AGENT_BOOST_PRIVATE_INFERENCE_MODEL: "provider/private-model",
    AGENT_BOOST_PRIVATE_INFERENCE_MODEL_ALLOWLIST: "provider/private-model",
  };
  assert.throws(
    () => loadConfig(base, "/tmp/home"),
    /ACCEPTED_COMPOSE_HASHES is required/u,
  );
  assert.throws(
    () => loadConfig({
      ...base,
      AGENT_BOOST_PRIVATE_INFERENCE_MODEL_ALLOWLIST: "provider/other-model",
      AGENT_BOOST_PRIVATE_INFERENCE_ACCEPTED_COMPOSE_HASHES: "a".repeat(64),
    }, "/tmp/home"),
    /must include the configured model/u,
  );
  assert.throws(
    () => loadConfig({
      ...base,
      AGENT_BOOST_PRIVATE_INFERENCE_ACCEPTED_COMPOSE_HASHES: "not-a-digest",
    }, "/tmp/home"),
    /64-character lowercase/u,
  );
  assert.throws(
    () => loadConfig({
      ...base,
      AGENT_BOOST_PRIVATE_INFERENCE_ACCEPTED_COMPOSE_HASHES: "a".repeat(64),
      AGENT_BOOST_PRIVATE_INFERENCE_BASE_URL: "http://gateway.example/v1",
    }, "/tmp/home"),
    /must use HTTPS/u,
  );
});

test("private inference supports explicit hardware mode and bounded resources", () => {
  const config = loadConfig({
    AGENT_BOOST_PRIVATE_INFERENCE_ENABLED: "1",
    AGENT_BOOST_PRIVATE_INFERENCE_API_KEY: "secret-test-key",
    AGENT_BOOST_PRIVATE_INFERENCE_MODEL: "provider/private-model",
    AGENT_BOOST_PRIVATE_INFERENCE_MODEL_ALLOWLIST:
      "provider/private-model, provider/private-model,provider/backup",
    AGENT_BOOST_PRIVATE_INFERENCE_TRUST_MODE: "hardware",
    AGENT_BOOST_PRIVATE_INFERENCE_ACCEPTED_SESSION_IDS: "b".repeat(64),
    AGENT_BOOST_PRIVATE_INFERENCE_REQUEST_TIMEOUT_MS: "90000",
    AGENT_BOOST_PRIVATE_INFERENCE_MAX_INPUT_CHARS: "4096",
    AGENT_BOOST_PRIVATE_INFERENCE_MAX_OUTPUT_TOKENS: "512",
    AGENT_BOOST_PRIVATE_INFERENCE_MAX_RESPONSE_BYTES: "65536",
  }, "/tmp/home").privateInference;
  assert.equal(config.enabled, true);
  assert.equal(config.trustMode, "hardware");
  assert.deepEqual(config.modelAllowlist, [
    "provider/private-model",
    "provider/backup",
  ]);
  assert.deepEqual(config.acceptedComposeHashes, []);
  assert.deepEqual(config.acceptedSessionIds, ["b".repeat(64)]);
  assert.equal(config.requestTimeoutMs, 90_000);
  assert.equal(config.maxInputChars, 4_096);
  assert.equal(config.maxOutputTokens, 512);
  assert.equal(config.maxResponseBytes, 65_536);
});
