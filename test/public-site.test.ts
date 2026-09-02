import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const publicFile = (name: string): Promise<string> =>
  readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

test("public loadout receipt contains no wallet identifiers or remote dependencies", async () => {
  const [html, css, script] = await Promise.all([
    publicFile("index.html"),
    publicFile("styles.css"),
    publicFile("app.js"),
  ]);
  const site = `${html}\n${css}\n${script}`;

  assert.match(site, /Dark Mode/);
  assert.match(site, /vault combination stayed home/);
  assert.match(site, /No addresses\. No balances\. No account IDs\./);
  assert.doesNotMatch(site, /0x[a-fA-F0-9]{40}/u);
  assert.doesNotMatch(site, /wallet_address|address=|balanceWei|amountWei|transactionHash/u);
  assert.doesNotMatch(site, /https?:\/\/(?!openapi\.vercel\.sh)/u);
});

test("feature state stays in an allowlisted fragment and is scrubbed immediately", async () => {
  const script = await publicFile("app.js");
  const config = JSON.parse(
    await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  ) as { headers: Array<{ headers: Array<{ key: string; value: string }> }> };
  const headers = new Map(config.headers[0]?.headers.map(({ key, value }) => [key, value]));

  assert.match(script, /location\.hash/);
  assert.match(script, /history\.replaceState/);
  assert.match(script, /params\.get\("v"\) === "1"/);
  assert.match(script, /Example loadout/);
  assert.doesNotMatch(script, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage)\b/u);
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.match(headers.get("Content-Security-Policy") ?? "", /connect-src 'none'/u);
  assert.equal(headers.get("Cache-Control"), "no-store");
});
