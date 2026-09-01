import assert from "node:assert/strict";
import { request } from "node:http";
import { afterEach, describe, it } from "node:test";

import type { RpcFetch } from "../src/rpc/index.js";
import { TorRpcProxy } from "../src/tor/index.js";

const running: TorRpcProxy[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (proxy) => proxy.stop()));
});

async function makeProxy(fetch: RpcFetch): Promise<TorRpcProxy> {
  const proxy = new TorRpcProxy({
    upstreamUrl: "https://rpc.example.invalid/private-token",
    fetch,
    port: 0,
    maxRequestBytes: 256,
  });
  await proxy.start();
  running.push(proxy);
  return proxy;
}

function rawRequest(
  url: string,
  options: { method?: string; host?: string; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  const body = options.body ?? '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}';
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: options.method ?? "POST",
        headers: {
          Host: options.host ?? parsed.host,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

describe("TorRpcProxy", () => {
  it("forwards fixed-origin JSON-RPC only through the injected Tor fetch", async () => {
    const calls: Array<{ input: string; body: string }> = [];
    const proxy = await makeProxy(async (input, init) => {
      calls.push({ input: String(input), body: String(init?.body) });
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" });
    });
    const result = await rawRequest(proxy.url);
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input, "https://rpc.example.invalid/private-token");
    assert.match(calls[0]?.body ?? "", /eth_chainId/);
  });

  it("requires the random path, exact Host, POST, and valid JSON-RPC", async () => {
    const proxy = await makeProxy(async () => Response.json({ result: "ok" }));
    const parsed = new URL(proxy.url);
    assert.equal((await rawRequest(`${parsed.origin}/rpc/not-the-token`)).status, 404);
    assert.equal((await rawRequest(proxy.url, { host: "evil.example" })).status, 421);
    assert.equal((await rawRequest(proxy.url, { method: "GET" })).status, 405);
    assert.equal((await rawRequest(proxy.url, { body: "not-json" })).status, 400);
    assert.equal((await rawRequest(proxy.url, {
      body: '{"jsonrpc":"2.0","id":1,"method":"admin_peers","params":[]}',
    })).status, 400);
    assert.equal((await rawRequest(proxy.url, { body: "x".repeat(300) })).status, 413);
  });

  it("returns a generic failure and never retries directly when Tor fails", async () => {
    let calls = 0;
    const proxy = await makeProxy(async () => {
      calls += 1;
      throw new Error("https://credential-bearing-upstream.invalid");
    });
    const result = await rawRequest(proxy.url);
    assert.equal(result.status, 502);
    assert.equal(calls, 1);
    assert.match(result.body, /tor_rpc_unavailable/);
    assert.doesNotMatch(result.body, /credential-bearing/);
  });
});
