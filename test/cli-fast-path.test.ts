import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const CLI_SOURCE = new URL("../src/cli.ts", import.meta.url);

test("Hermes turn-gate startup has no eager local runtime imports", async () => {
  const source = await readFile(CLI_SOURCE, "utf8");
  const parsed = ts.createSourceFile(
    CLI_SOURCE.pathname,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const eagerLocalImports = parsed.statements
    .filter(ts.isImportDeclaration)
    .filter((declaration) => !declaration.importClause?.isTypeOnly)
    .map((declaration) => declaration.moduleSpecifier)
    .filter(ts.isStringLiteral)
    .map((specifier) => specifier.text)
    .filter((specifier) => specifier.startsWith("."));

  assert.deepEqual(
    eagerLocalImports,
    [],
    "local CLI modules must stay dynamically imported so Hermes hooks do not load wallet/Tor startup code",
  );
  assert.match(
    source,
    /case "hermes-turn-gate": \{[\s\S]*?await import\("\.\/hermes\/turn-gate\.js"\)/u,
  );
});
