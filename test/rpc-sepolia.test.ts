import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SepoliaRpcClient,
  type RpcFetch,
} from "../src/rpc/sepolia.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const ENTRY_POINT_V08_ADDRESS =
  "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const USER_OPERATION_EVENT_TOPIC =
  "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const USER_OPERATION_HASH = `0x${"12".repeat(32)}`;
const TRANSACTION_HASH = `0x${"ab".repeat(32)}`;
const EVENT_SENDER = `0x${"23".repeat(20)}`;
const SENDER_TOPIC = `0x${"0".repeat(24)}${"23".repeat(20)}`;
const PAYMASTER_TOPIC = `0x${"0".repeat(24)}${"34".repeat(20)}`;

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function userOperationLog(success: boolean): Record<string, unknown> {
  return {
    address: ENTRY_POINT_V08_ADDRESS,
    topics: [
      USER_OPERATION_EVENT_TOPIC,
      USER_OPERATION_HASH,
      SENDER_TOPIC,
      PAYMASTER_TOPIC,
    ],
    data: `0x${word(7n)}${word(success ? 1n : 0n)}${word(8n)}${word(9n)}`,
    transactionHash: TRANSACTION_HASH,
    removed: false,
  };
}

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

  it("resolves an exact EntryPoint v0.8 UserOperation event and its transaction", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const results: unknown[] = [[userOperationLog(true)], [userOperationLog(false)]];
    const client = new SepoliaRpcClient({
      rpcUrl: "https://rpc.example.invalid/sepolia",
      fetch: rpcFetch((body) => ({
        jsonrpc: "2.0",
        id: body.id,
        result: results.shift(),
      }), calls),
    });

    assert.deepEqual(await client.getUserOperationReceiptStatus(
      USER_OPERATION_HASH,
      EVENT_SENDER,
    ), {
      status: "success",
      transactionHash: TRANSACTION_HASH,
    });
    assert.deepEqual(await client.getUserOperationReceiptStatus(USER_OPERATION_HASH), {
      status: "reverted",
      transactionHash: TRANSACTION_HASH,
    });

    const request = JSON.parse(String(calls[0]!.init?.body)) as {
      method: string;
      params: unknown[];
    };
    assert.equal(request.method, "eth_getLogs");
    assert.deepEqual(request.params, [
      {
        address: ENTRY_POINT_V08_ADDRESS,
        fromBlock: "earliest",
        toBlock: "latest",
        topics: [USER_OPERATION_EVENT_TOPIC, USER_OPERATION_HASH],
      },
    ]);
  });

  it("binds a UserOperation receipt to its exact indexed sender", async () => {
    const client = new SepoliaRpcClient({
      rpcUrl: "https://rpc.example.invalid",
      fetch: rpcFetch((body) => ({
        jsonrpc: "2.0",
        id: body.id,
        result: [userOperationLog(true)],
      })),
    });

    await assert.rejects(
      client.getUserOperationReceiptStatus(USER_OPERATION_HASH, ADDRESS),
      /mismatched UserOperation sender/,
    );
    await assert.rejects(
      client.getUserOperationReceiptStatus(USER_OPERATION_HASH, "bad"),
      /Expected UserOperation sender/,
    );
  });

  it("keeps absent and removed UserOperation events pending", async () => {
    const removed = { ...userOperationLog(true), removed: true };
    const results: unknown[] = [[], [removed]];
    const client = new SepoliaRpcClient({
      rpcUrl: "https://rpc.example.invalid",
      fetch: rpcFetch((body) => ({
        jsonrpc: "2.0",
        id: body.id,
        result: results.shift(),
      })),
    });

    assert.deepEqual(await client.getUserOperationReceiptStatus(USER_OPERATION_HASH), {
      status: "pending",
    });
    assert.deepEqual(await client.getUserOperationReceiptStatus(USER_OPERATION_HASH), {
      status: "pending",
    });
  });

  it("rejects invalid hashes and malformed or ambiguous UserOperation logs", async () => {
    const results: unknown[] = [
      {},
      [{ ...userOperationLog(true), address: ADDRESS }],
      [{ ...userOperationLog(true), topics: [USER_OPERATION_EVENT_TOPIC] }],
      [{
        ...userOperationLog(true),
        data: `0x${word(7n)}${word(2n)}${word(8n)}${word(9n)}`,
      }],
      [userOperationLog(true), userOperationLog(true)],
    ];
    const client = new SepoliaRpcClient({
      rpcUrl: "https://rpc.example.invalid",
      fetch: rpcFetch((body) => ({
        jsonrpc: "2.0",
        id: body.id,
        result: results.shift(),
      })),
    });

    await assert.rejects(
      client.getUserOperationReceiptStatus("bad"),
      /32-byte hex value/,
    );
    await assert.rejects(
      client.getUserOperationReceiptStatus(USER_OPERATION_HASH),
      /invalid log list/,
    );
    await assert.rejects(
      client.getUserOperationReceiptStatus(USER_OPERATION_HASH),
      /mismatched EntryPoint/,
    );
    await assert.rejects(
      client.getUserOperationReceiptStatus(USER_OPERATION_HASH),
      /invalid UserOperation topics/,
    );
    await assert.rejects(
      client.getUserOperationReceiptStatus(USER_OPERATION_HASH),
      /invalid UserOperation success flag/,
    );
    await assert.rejects(
      client.getUserOperationReceiptStatus(USER_OPERATION_HASH),
      /ambiguous UserOperation logs/,
    );
  });
});
