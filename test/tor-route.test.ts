import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ignoreEmptyArtiState,
  TorRpcRoute,
  type TorClientPort,
} from "../src/tor/index.js";

class FakeTorClient implements TorClientPort {
  readonly calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  readyCalls = 0;
  closed = false;
  torVerified = true;
  failFetch = false;
  hangFetch = false;

  async ready(): Promise<void> {
    this.readyCalls += 1;
  }

  async fetch(
    url: string,
    init?: { method?: string; body?: string | Uint8Array | ArrayBuffer },
  ): Promise<Response> {
    this.calls.push({ url, method: init?.method, body: init?.body });
    if (this.hangFetch) return new Promise<Response>(() => undefined);
    if (this.failFetch) throw new Error("direct fallback bait https://secret.invalid");
    if (url.includes("check.torproject.org")) {
      return Response.json({ IsTor: this.torVerified, IP: "127.0.0.2" });
    }
    return Response.json({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" });
  }

  close(): void {
    this.closed = true;
  }
}

async function fixture(client = new FakeTorClient()): Promise<{
  client: FakeTorClient;
  route: TorRpcRoute;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-boost-tor-route-"));
  return {
    client,
    route: new TorRpcRoute({
      rpcUrl: "https://rpc.example.invalid/sepolia-token",
      dataDir,
      client,
    }),
  };
}

describe("TorRpcRoute", () => {
  it("ignores only empty Arti state persisted by tor-js", async () => {
    const values = new Map<string, string>([
      ["state:guards", ""],
      ["state:usable", "non-empty"],
      ["dir:empty-document", ""],
    ]);
    const wrapped = ignoreEmptyArtiState({
      async get(key) { return values.get(key) ?? null; },
      async set(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); },
      async keys(prefix) {
        return [...values.keys()].filter((key) => key.startsWith(prefix));
      },
      async getAll(prefix) {
        return [...values.entries()].filter(([key]) => key.startsWith(prefix));
      },
    });

    assert.equal(await wrapped.get("state:guards"), null);
    assert.equal(await wrapped.get("state:usable"), "non-empty");
    assert.equal(await wrapped.get("dir:empty-document"), "");
    assert.deepEqual(await wrapped.getAll("state:"), [["state:usable", "non-empty"]]);
  });

  it("boots, verifies a Tor exit, and accepts only the fixed HTTPS RPC", async () => {
    const { client, route } = await fixture();
    await route.ready();
    await route.verifyTor();
    assert.equal(route.status, "ready");

    const response = await route.fetchRpc(
      "https://rpc.example.invalid/sepolia-token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      },
    );
    assert.equal(response.status, 200);
    assert.equal(client.calls.at(-1)?.url, "https://rpc.example.invalid/sepolia-token");
    await assert.rejects(
      route.fetchRpc("https://other.invalid", { method: "POST", body: "{}" }),
      /non-configured destination/,
    );
    await route.close();
    assert.equal(client.closed, true);
  });

  it("fails closed when Tor verification or transport fails", async () => {
    const first = await fixture();
    await first.route.ready();
    first.client.torVerified = false;
    await assert.rejects(first.route.verifyTor(), /verification failed/);
    assert.equal(first.route.status, "failed");

    const second = await fixture();
    await second.route.ready();
    second.client.failFetch = true;
    await assert.rejects(
      second.route.fetchRpc("https://rpc.example.invalid/sepolia-token", {
        method: "POST",
        body: "{}",
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Tor RPC request failed" &&
        !error.message.includes("secret.invalid"),
    );
    assert.equal(second.route.status, "failed");
  });

  it("enforces an outer deadline even when the Tor client ignores AbortSignal", async () => {
    const client = new FakeTorClient();
    const dataDir = await mkdtemp(join(tmpdir(), "agent-boost-tor-timeout-"));
    const route = new TorRpcRoute({
      rpcUrl: "https://rpc.example.invalid/sepolia-token",
      dataDir,
      client,
      requestTimeoutMs: 10,
    });
    await route.ready();
    client.hangFetch = true;
    await assert.rejects(
      route.fetchRpc("https://rpc.example.invalid/sepolia-token", {
        method: "POST",
        body: "{}",
      }),
      /Tor RPC request failed/,
    );
    assert.equal(route.status, "failed");
    assert.equal(client.closed, true);
  });

  it("rejects clearnet, userinfo, and IP-literal upstreams", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agent-boost-tor-route-invalid-"));
    const client = new FakeTorClient();
    assert.throws(
      () => new TorRpcRoute({ rpcUrl: "http://rpc.example", dataDir, client }),
      /must use HTTPS/,
    );
    assert.throws(
      () => new TorRpcRoute({ rpcUrl: "https://user:pass@rpc.example", dataDir, client }),
      /userinfo/,
    );
    assert.throws(
      () => new TorRpcRoute({ rpcUrl: "https://127.0.0.1", dataDir, client }),
      /hostname/,
    );
  });
});
