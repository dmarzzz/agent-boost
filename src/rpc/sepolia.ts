import {
  SEPOLIA_CHAIN_ID,
  type ChainClient,
  type TransactionReceiptStatus,
} from "../contracts.js";

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export type RpcFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SepoliaRpcClientOptions {
  rpcUrl: string;
  fetch?: RpcFetch;
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

export class SepoliaRpcClient implements ChainClient {
  readonly #rpcUrl: string;
  readonly #fetch: RpcFetch;
  readonly #timeoutMs: number;
  #nextId = 1;

  constructor(options: SepoliaRpcClientOptions | string) {
    const normalized = typeof options === "string" ? { rpcUrl: options } : options;
    this.#rpcUrl = parseHttpsRpcUrl(normalized.rpcUrl);
    this.#fetch = normalized.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = normalized.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("RPC timeout must be a positive integer");
    }
  }

  async assertSepolia(): Promise<void> {
    const result = await this.#request("eth_chainId", []);
    const chainId = parseHexQuantity(result, "eth_chainId");
    if (chainId !== BigInt(SEPOLIA_CHAIN_ID)) {
      throw new Error(
        `RPC chain mismatch: expected Sepolia ${SEPOLIA_CHAIN_ID.toString()}, received ${chainId.toString()}`,
      );
    }
  }

  async getBalanceWei(address: string): Promise<bigint> {
    if (!ETH_ADDRESS_RE.test(address)) {
      throw new Error("Balance address must be an Ethereum address");
    }
    const result = await this.#request("eth_getBalance", [address, "latest"]);
    return parseHexQuantity(result, "eth_getBalance");
  }

  async getTransactionReceiptStatus(
    transactionHash: string,
  ): Promise<TransactionReceiptStatus> {
    if (!TX_HASH_RE.test(transactionHash)) {
      throw new Error("Transaction hash must be a 32-byte hex value");
    }
    const result = await this.#request("eth_getTransactionReceipt", [
      transactionHash,
    ]);
    if (result === null) return "pending";
    if (typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Sepolia RPC eth_getTransactionReceipt returned an invalid receipt");
    }
    const receipt = result as Record<string, unknown>;
    if (
      typeof receipt.transactionHash !== "string" ||
      !TX_HASH_RE.test(receipt.transactionHash) ||
      receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()
    ) {
      throw new Error("Sepolia RPC eth_getTransactionReceipt returned a mismatched receipt");
    }
    const status = parseHexQuantity(
      receipt.status,
      "eth_getTransactionReceipt",
    );
    if (status === 1n) return "success";
    if (status === 0n) return "reverted";
    throw new Error("Sepolia RPC eth_getTransactionReceipt returned an invalid status");
  }

  async #request(method: string, params: readonly unknown[]): Promise<unknown> {
    const id = this.#nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref();
    let response: Response;
    try {
      response = await this.#fetch(this.#rpcUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new Error(`Sepolia RPC request timed out after ${this.#timeoutMs.toString()}ms`);
      }
      // Do not attach the transport error: many fetch implementations include
      // the full credential-bearing RPC URL in their error or cause string.
      throw new Error("Sepolia RPC request failed");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`Sepolia RPC returned HTTP ${response.status.toString()}`);
    }

    let payload: JsonRpcResponse;
    try {
      payload = (await response.json()) as JsonRpcResponse;
    } catch {
      throw new Error("Sepolia RPC returned invalid JSON");
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      payload.jsonrpc !== "2.0" ||
      payload.id !== id
    ) {
      throw new Error("Sepolia RPC returned an invalid or mismatched response");
    }
    if (payload.error !== undefined) {
      throw new Error(`Sepolia RPC ${method} returned an error`);
    }
    if (!("result" in payload)) {
      throw new Error(`Sepolia RPC ${method} returned no result`);
    }
    return payload.result;
  }
}

function parseHttpsRpcUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("RPC URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("RPC URL must use HTTPS");
  }
  return parsed.toString();
}

function parseHexQuantity(value: unknown, method: string): bigint {
  if (typeof value !== "string" || !HEX_QUANTITY_RE.test(value)) {
    throw new Error(`Sepolia RPC ${method} returned an invalid hex quantity`);
  }
  return BigInt(value);
}
