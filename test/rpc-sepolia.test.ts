import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SepoliaRpcClient,
  type RpcFetch,
} from "../src/rpc/sepolia.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";

function rpcFetch(
  responder: (body: Record<string, unknown>) => Record<string, unknown>,
  calls: Array<{ url: string; init?: RequestInit }> = [],
): RpcFetch {
  return async (input, init) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(responder(body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("SepoliaRpcClient", () => {
  it("accepts Sepolia and fetches a latest balance over HTTPS JSON-RPC", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = rpcFetch((body) => ({
      jsonrpc: "2.0",
      id: body.id,
      result: body.method === "eth_chainId" ? "0xaa36a7" : "0x2a",
    }), calls);
    const client = new SepoliaRpcClient({
      rpcUrl: "https://rpc.example.invalid/sepolia",
      fetch,
    });

    await client.assertSepolia();
    assert.equal(await client.getBalanceWei(ADDRESS), 42n);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url.startsWith("https://"), true);
    const balanceRequest = JSON.parse(String(calls[1]!.init?.body)) as {
      method: string;
      params: unknown[];
    };
    assert.equal(balanceRequest.method, "eth_getBalance");
    assert.deepEqual(balanceRequest.params, [ADDRESS, "latest"]);
  });

  it("rejects non-HTTPS URLs, invalid addresses, and wrong chains", async () => {
    assert.throws(
      () => new SepoliaRpcClient("http://rpc.example.invalid"),
      /must use HTTPS/,
    );
    const client = new SepoliaRpcClient({
      rpcUrl: "https://rpc.example.invalid",
      fetch: rpcFetch((body) => ({ jsonrpc: "2.0", id: body.id, result: "0x1" })),
    });
    await assert.rejects(client.assertSepolia(), /chain mismatch/);
    await assert.rejects(client.getBalanceWei("bad"), /Ethereum address/);
  });

  it("rejects JSON-RPC errors, mismatched ids, and malformed quantities", async () => {
    const errorClient = new SepoliaRpcClient({
      rpcUrl: "https://rpc.example.invalid",
      fetch: rpcFetch((body) => ({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32_000, message: "boom" },
      })),
    });
    await assert.rejects(errorClient.assertSepolia(), /returned an error/);

    const mismatchClient = new SepoliaRpcClient({
      rpcUrl: "https://rpc.example.invalid",
      fetch: rpcFetch(() => ({ jsonrpc: "2.0", id: 999, result: "0xaa36a7" })),
    });
    await assert.rejects(mismatchClient.assertSepolia(), /mismatched response/);

    const malformedClient = new SepoliaRpcClient({
      rpcUrl: "https://rpc.example.invalid",
      fetch: rpcFetch((body) => ({ jsonrpc: "2.0", id: body.id, result: "42" })),
    });
    await assert.rejects(
      malformedClient.getBalanceWei(ADDRESS),
      /invalid hex quantity/,
    );
  });

  it("does not expose a credential-bearing RPC URL in transport errors", async () => {
    const token = "super-secret-token";
    const client = new SepoliaRpcClient({
      rpcUrl: `https://rpc.example.invalid/${token}`,
      fetch: async () => {
        throw new Error("network unavailable");
      },
    });

    await assert.rejects(client.assertSepolia(), (error: Error) => {
      assert.equal(error.message.includes(token), false);
      return true;
    });
  });

  it("classifies transaction receipts without confusing pending and reverted", async () => {
    const transactionHash = `0x${"ab".repeat(32)}`;
    const statuses: unknown[] = [
      null,
      { status: "0x1", transactionHash },
      { status: "0x0", transactionHash },
    ];
    const client = new SepoliaRpcClient({
      rpcUrl: "https://rpc.example.invalid",
      fetch: rpcFetch((body) => ({
        jsonrpc: "2.0",
        id: body.id,
        result: statuses.shift(),
      })),
    });

    assert.equal(await client.getTransactionReceiptStatus(transactionHash), "pending");
    assert.equal(await client.getTransactionReceiptStatus(transactionHash), "success");
    assert.equal(await client.getTransactionReceiptStatus(transactionHash), "reverted");
    await assert.rejects(
      client.getTransactionReceiptStatus("bad"),
      /32-byte hex value/,
    );

    const mismatch = new SepoliaRpcClient({
      rpcUrl: "https://rpc.example.invalid",
      fetch: rpcFetch((body) => ({
        jsonrpc: "2.0",
        id: body.id,
        result: { status: "0x1", transactionHash: `0x${"cd".repeat(32)}` },
      })),
    });
    await assert.rejects(
      mismatch.getTransactionReceiptStatus(transactionHash),
      /mismatched receipt/,
    );
  });
});
