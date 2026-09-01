#!/usr/bin/env node

import { installPinnedKohaku } from "./lib/kohaku-install.mjs";

try {
  const result = await installPinnedKohaku();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `agent-boost Kohaku installer: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
