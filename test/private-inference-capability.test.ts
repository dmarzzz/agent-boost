import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { loadConfig } from "../src/config.js";
import { PrivateInference } from "../src/private-inference/index.js";

test("private inference example and disabled runtime satisfy the closed schema", async () => {
  const [schema, example] = await Promise.all([
    readFile(
      new URL(
        "../spec/private-inference-capability-v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../spec/private-inference-capability-v1.example.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const validate = new Ajv2020({ allErrors: true }).compile(JSON.parse(schema));
  assert.equal(validate(JSON.parse(example)), true, JSON.stringify(validate.errors));

  const runtime = new PrivateInference(loadConfig({}, "/tmp/home").privateInference);
  assert.equal(
    validate(runtime.capabilities()),
    true,
    JSON.stringify(validate.errors),
  );

  const mutated = JSON.parse(example) as {
    assurance: { direct_fallback: boolean };
  };
  mutated.assurance.direct_fallback = true;
  assert.equal(validate(mutated), false);
});
