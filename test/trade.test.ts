import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  tradeCapabilities,
  tradeNotConfigured,
  type TradeMode,
} from "../src/trade.js";

test("trade capability example and runtime document satisfy the v1 schema", async () => {
  const [schema, example] = await Promise.all([
    readFile(new URL("../spec/trade-capability-v1.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../spec/trade-capability-v1.example.json", import.meta.url), "utf8"),
  ]);
  const validate = new Ajv2020({ allErrors: true }).compile(JSON.parse(schema));
  assert.equal(validate(JSON.parse(example)), true, JSON.stringify(validate.errors));
  assert.equal(validate(tradeCapabilities()), true, JSON.stringify(validate.errors));
});

for (const mode of ["regular", "private"] satisfies TradeMode[]) {
  test(`${mode} trade attempts are inert and fail closed`, () => {
    const unavailable = tradeNotConfigured({
      action: "plan",
      mode,
      intent: {
        version: 1,
        operation: "swap_exact_in",
        mode,
        chainId: "eip155:11155111",
        sellAssetId: "eip155:11155111/slip44:60",
        buyAssetId:
          "eip155:11155111/erc20:0x2222222222222222222222222222222222222222",
        sellAmountAtomic: "1000000000000000",
        maxSlippageBps: 100,
        recipient: "0x1111111111111111111111111111111111111111",
      },
    });

    assert.equal(unavailable.status, "not_configured");
    assert.equal(unavailable.requested_mode, mode);
    assert.deepEqual(unavailable.effects, {
      state_changed: false,
      network_request_attempted: false,
      quote_requested: false,
      approval_requested: false,
      signature_requested: false,
      transaction_submitted: false,
    });
    assert.equal(
      unavailable.reason_code,
      mode === "private"
        ? "PRIVATE_SWAP_DESIGN_NOT_SELECTED"
        : "SEPOLIA_SWAP_VENUE_NOT_CONFIGURED",
    );
  });
}
