import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

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
  async executePrivatePayment() {
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
  assert.equal(validate(JSON.parse(example)), true, JSON.stringify(validate.errors));

  const root = await mkdtemp(join(tmpdir(), "agent-boost-capability-"));
  const runtime = await createLocalRuntime(
    loadConfig({ AGENT_BOOST_STATE_DIR: root }, root),
    { wallet, chain },
  );
  try {
    assert.equal(
      validate(await runtime.capabilities()),
      true,
      JSON.stringify(validate.errors),
    );
  } finally {
    await runtime.shutdown();
  }
});
