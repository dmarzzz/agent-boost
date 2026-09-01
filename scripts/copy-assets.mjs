import { chmod, copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/kohaku/", import.meta.url), { recursive: true });
await copyFile(
  new URL("../src/kohaku/network-guard.mjs", import.meta.url),
  new URL("../dist/kohaku/network-guard.mjs", import.meta.url),
);

await chmod(new URL("../dist/cli.js", import.meta.url), 0o755);
