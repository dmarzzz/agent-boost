import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { loadConfig } from "../src/config.js";
import type { ChainClient, WalletAdapter } from "../src/contracts.js";
import { createLocalRuntime } from "../src/service.js";

const wallet: WalletAdapter = {
  async ensureWallet() {},
  async nextFreshAddress() {
    return "0x1111111111111111111111111111111111111111";
  },
  async prewarmPrivacy() {},
  async shieldWei() {
    return {};
  },
  async getPrivateBalanceWei() {
    return 0n;
  },
  async executePrivatePayment(input) {
    assert.match(input.broadcastRequestId, /^req_/u);
    await input.beforeBroadcast();
    return {};
  },
};

const chain: ChainClient = {
  async assertSepolia() {},
  async getBalanceWei() {
    return 0n;
  },
};

test("checked-in example and runtime capabilities satisfy the v1 schema", async () => {
  const [schema, example] = await Promise.all([
    readFile(new URL("../spec/wallet-capability-v1.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../spec/wallet-capability-v1.example.json", import.meta.url), "utf8"),
  ]);
  const validate = new Ajv2020({ allErrors: true }).compile(JSON.parse(schema));
  const parsedExample = JSON.parse(example) as Record<string, unknown>;
  assert.equal(validate(parsedExample), true, JSON.stringify(validate.errors));
  assert.equal(parsedExample.contract, "org.agentboost.wallet/1.8");
  const legacyVersion = structuredClone(parsedExample);
  legacyVersion.contract = "org.agentboost.wallet/1.7";
  assert.equal(
    validate(legacyVersion),
    false,
    "the exact 1.8 capability expansion must not masquerade as the strict 1.7 contract",
  );

  const root = await mkdtemp(join(tmpdir(), "agent-boost-capability-"));
  const runtime = await createLocalRuntime(
    loadConfig({ AGENT_BOOST_STATE_DIR: root }, root),
    { wallet, chain },
  );
  try {
    const capabilities = await runtime.capabilities();
    assert.equal(
      validate(capabilities),
      true,
      JSON.stringify(validate.errors),
    );
    assert.equal(capabilities.contract, "org.agentboost.wallet/1.8");
    assert.deepEqual(capabilities.private_balance_management, {
      available: true,
      named: true,
      multiple_per_profile: true,
      create_available: true,
      fund_from_main_available: true,
      fund_from_private_balance_available: true,
      per_balance_policy_editing: true,
      public_change: {
        nested_under_source_private_balance: true,
        regular_transfer_source: true,
      },
    });
    assert.deepEqual(capabilities.regular_transfer, {
      available: false,
      source_kinds: ["main", "private_balance_public_change"],
    });
    assert.equal(
      (capabilities.wallet_management as { multiple_profiles: boolean })
        .multiple_profiles,
      true,
    );
    assert.deepEqual((capabilities.security as { overrides: object }).overrides, {});
  } finally {
    await runtime.shutdown();
  }

  const overrideRoot = await mkdtemp(join(tmpdir(), "agent-boost-capability-"));
  const overridden = await createLocalRuntime(
    loadConfig(
      {
        AGENT_BOOST_STATE_DIR: overrideRoot,
        AGENT_BOOST_PAYMENT_APPROVAL: "allow",
      },
      overrideRoot,
    ),
    { wallet, chain },
  );
  try {
    const capabilities = await overridden.capabilities();
    assert.equal(validate(capabilities), true, JSON.stringify(validate.errors));
    const security = capabilities.security as {
      default: Record<string, string>;
      overrides: Record<string, string>;
      effective: Record<string, string>;
      hard_limits: Record<string, unknown>;
    };
    assert.equal(security.default["payment.execute"], "confirm");
    assert.equal(security.overrides["payment.execute"], "allow");
    assert.equal(security.effective["payment.execute"], "allow");
    assert.equal(security.hard_limits.mainnet_available, false);
    assert.equal(security.hard_limits.rpc_direct_fallback, false);
  } finally {
    await overridden.shutdown();
  }
});
