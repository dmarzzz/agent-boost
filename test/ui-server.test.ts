import assert from "node:assert/strict";
import { request } from "node:http";
import { afterEach, describe, it } from "node:test";

import {
  buildSepoliaFundingUri,
  generateFundingQrCardPng,
  generateFundingQrDataUrl,
  generateFundingQrPng,
  OnboardingUiServer,
} from "../src/ui/index.js";
import type { OnboardingPhase, PublicOnboardingSnapshot } from "../src/contracts.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const FUNDING_WEI = "200000000000000000";

function snapshot(phase: OnboardingPhase = "awaiting_funding"): PublicOnboardingSnapshot {
  const publicBalanceWei = phase === "funding_pending"
    ? "100000000000000000"
    : ["funded_public", "shielding", "private_ready"].includes(phase)
      ? FUNDING_WEI
      : "0";
  return {
    setupId: "setup-local-demo",
    revision: 4,
    phase,
    address: ADDRESS,
    publicBalanceWei,
    privateBalanceWei: phase === "private_ready" ? "100000000000000000" : "0",
    requiredFundingWei: FUNDING_WEI,
    shieldAmountWei: "100000000000000000",
    delegation: {
      mode: "testnet_delegated",
      chainId: 11_155_111,
      perPaymentLimitWei: "100000000000000000",
      lifetimeLimitWei: FUNDING_WEI,
      spentWei: "0",
      expiresAt: "2026-09-02T00:00:00.000Z",
      enabled: phase === "private_ready",
    },
    rpcRoute: {
      mode: "tor",
      scope: "ethereum_json_rpc",
      status: "ready",
      directFallback: false,
    },
  };
}

const running: OnboardingUiServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (server) => server.stop()));
});

async function serverFor(value: PublicOnboardingSnapshot = snapshot()): Promise<string> {
  const server = new OnboardingUiServer({
    getSnapshot: async () => value,
    port: 0,
  });
  running.push(server);
  return (await server.start()).url;
}

async function statusWithHeaders(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

describe("funding QR", () => {
  it("encodes an exact Sepolia EIP-681 native transfer", () => {
    assert.equal(
      buildSepoliaFundingUri(ADDRESS, FUNDING_WEI),
      `ethereum:${ADDRESS}@11155111?value=${FUNDING_WEI}`,
    );
    assert.throws(() => buildSepoliaFundingUri("not-an-address", FUNDING_WEI));
    assert.throws(() => buildSepoliaFundingUri(ADDRESS, "0"));
  });

  it("provides data URL and PNG forms for browser and MCP fallbacks", async () => {
    const [dataUrl, png, card] = await Promise.all([
      generateFundingQrDataUrl(ADDRESS, FUNDING_WEI),
      generateFundingQrPng(ADDRESS, FUNDING_WEI),
      generateFundingQrCardPng(ADDRESS, FUNDING_WEI),
    ]);
    assert.match(dataUrl, /^data:image\/png;base64,/);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual([...card.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(card.readUInt32BE(16), 720);
    assert.equal(card.readUInt32BE(20), 800);
    assert.ok(card.length > png.length);
  });
});

describe("onboarding UI server", () => {
  it("binds to loopback, renders the local shell, and can stop twice", async () => {
    const server = new OnboardingUiServer({ getSnapshot: async () => snapshot() });
    running.push(server);
    const first = await server.start();
    const second = await server.start();
    assert.equal(second.url, first.url);
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(first.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Dark mode for your agent/);
    await server.stop();
    await server.stop();
    running.splice(running.indexOf(server), 1);
  });

  it("sets restrictive browser security and no-store headers", async () => {
    const url = await serverFor();
    const response = await fetch(url);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.match(response.headers.get("permissions-policy") ?? "", /camera=\(\)/);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /img-src 'self' data:/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|https:/);
  });

  it("rejects non-loopback Host and cross-origin browser requests", async () => {
    const url = await serverFor();
    assert.equal(await statusWithHeaders(url, { Host: "evil.example" }), 421);

    const badOrigin = await fetch(url, { headers: { Origin: "https://evil.example" } });
    assert.equal(badOrigin.status, 403);

    const sameOrigin = await fetch(`${url}/api/state`, { headers: { Origin: url } });
    assert.equal(sameOrigin.status, 200);

    const crossSite = await fetch(url, { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403);
  });

  it("returns only the public snapshot plus a server-generated funding QR", async () => {
    const value = snapshot() as PublicOnboardingSnapshot & { privateKey: string };
    value.privateKey = "must-never-leave-the-process";
    const url = await serverFor(value);
    const response = await fetch(`${url}/api/state`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.phase, "awaiting_funding");
    assert.equal(body.address, ADDRESS);
    assert.deepEqual(body.rpcRoute, {
      mode: "tor",
      scope: "ethereum_json_rpc",
      status: "ready",
      directFallback: false,
    });
    assert.match(String(body.qrDataUrl), /^data:image\/png;base64,/);
    assert.equal(body.privateKey, undefined);
    assert.doesNotMatch(JSON.stringify(body), /must-never-leave-the-process/);
  });

  it("stops presenting a funding QR once the target is funded", async () => {
    const url = await serverFor(snapshot("funded_public"));
    const body = await (await fetch(`${url}/api/state`)).json() as Record<string, unknown>;
    assert.equal(body.publicBalanceWei, FUNDING_WEI);
    assert.equal(body.qrDataUrl, undefined);
  });

  it("keeps awaiting, shielding, and ready funding cues honest", async () => {
    for (const phase of ["awaiting_funding", "shielding", "private_ready"] as const) {
      const url = await serverFor(snapshot(phase));
      const body = await (await fetch(`${url}/api/state`)).json() as Record<string, unknown>;
      assert.equal(body.phase, phase);
      if (phase === "awaiting_funding") {
        assert.match(String(body.qrDataUrl), /^data:image\/png;base64,/);
      } else {
        assert.equal(body.qrDataUrl, undefined);
      }
    }
  });

  it("ships an accessible copy status and non-clipping narrow layout", async () => {
    const url = await serverFor();
    const [html, css, script] = await Promise.all([
      fetch(url).then(async (response) => response.text()),
      fetch(`${url}/styles.css`).then(async (response) => response.text()),
      fetch(`${url}/app.js`).then(async (response) => response.text()),
    ]);

    assert.match(html, /aria-label="Copy wallet address"/);
    assert.match(html, /id="copy-status" role="status" aria-live="polite"/);
    assert.match(css, /\.address-row \{[^}]*min-width: 0/);
    assert.match(css, /\.funding-facts > \* \{ min-width: 0; \}/);
    assert.match(css, /\.narrative, \.aperture-panel \{ min-width: 0/);
    assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /\.address-row code \{[^}]*flex: 1 1 0/);
    assert.match(css, /\.address-row button \{[^}]*flex: 0 0 auto/);
    assert.match(css, /\[hidden\] \{ display: none !important; \}/);
    assert.match(css, /@media \(max-width: 420px\)/);
    assert.match(script, /setAttribute\('aria-current', 'step'\)/);
    assert.match(script, /Still needed on Sepolia/);
    assert.match(script, /Wallet address copied\./);
    assert.match(script, /Tor unavailable — direct access disabled/);
    assert.match(html, /id="rpc-route-label">Checking Tor…/);
    assert.match(html, /id="hermes-handoff" role="status"/);
    assert.match(script, /After you send, reply “funded”/);
    assert.match(script, /Some Sepolia ETH arrived\. Send the remaining amount shown\./);
    assert.match(script, /Return to Hermes — Agent Boost is ready/);
    assert.match(css, /\.hermes-handoff\[data-state="ready"\]/);
  });

  it("supports every onboarding phase without adding privileged actions", async () => {
    const phases: OnboardingPhase[] = [
      "not_started",
      "creating_wallet",
      "preparing_privacy",
      "awaiting_funding",
      "funding_pending",
      "funded_public",
      "shielding",
      "private_ready",
      "failed",
    ];
    let current = snapshot(phases[0]);
    const server = new OnboardingUiServer({ getSnapshot: async () => current });
    running.push(server);
    const { url } = await server.start();
    for (const phase of phases) {
      current = snapshot(phase);
      const response = await fetch(`${url}/api/state`);
      assert.equal((await response.json() as { phase: string }).phase, phase);
    }

    const html = await (await fetch(url)).text();
    assert.doesNotMatch(html, /approve|shield now|send payment/i);
    assert.match(html, /copy-address/);
  });

  it("fails closed with a generic response when state cannot be read", async () => {
    const server = new OnboardingUiServer({
      getSnapshot: async () => { throw new Error("secret provider path"); },
    });
    running.push(server);
    const { url } = await server.start();
    const response = await fetch(`${url}/api/state`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "onboarding_state_unavailable" });
  });
});
