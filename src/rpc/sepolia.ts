import {
  SEPOLIA_CHAIN_ID,
  type ChainClient,
  type TransactionReceiptStatus,
  type UserOperationReceiptStatus,
} from "../contracts.js";

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ABI_ADDRESS_TOPIC_RE = /^0x0{24}[0-9a-fA-F]{40}$/;
const USER_OPERATION_EVENT_DATA_RE = /^0x[0-9a-fA-F]{256}$/;

/** Canonical singleton used by Kohaku's pinned ERC-4337 EntryPoint v0.8 path. */
const ENTRY_POINT_V08_ADDRESS =
  "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
/** keccak256(UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)). */
const USER_OPERATION_EVENT_TOPIC =
  "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";

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

  async getUserOperationReceiptStatus(
    userOperationHash: string,
    expectedSender?: string,
  ): Promise<UserOperationReceiptStatus> {
    if (!TX_HASH_RE.test(userOperationHash)) {
      throw new Error("UserOperation hash must be a 32-byte hex value");
    }
    if (expectedSender !== undefined && !ETH_ADDRESS_RE.test(expectedSender)) {
      throw new Error("Expected UserOperation sender must be an Ethereum address");
    }
    const normalizedHash = userOperationHash.toLowerCase();
    const expectedSenderTopic = expectedSender === undefined
      ? undefined
      : `0x${"0".repeat(24)}${expectedSender.slice(2).toLowerCase()}`;
    const result = await this.#request("eth_getLogs", [
      {
        address: ENTRY_POINT_V08_ADDRESS,
        fromBlock: "earliest",
        toBlock: "latest",
        topics: [USER_OPERATION_EVENT_TOPIC, normalizedHash],
      },
    ]);
    if (!Array.isArray(result)) {
      throw new Error("Sepolia RPC eth_getLogs returned an invalid log list");
    }

    const canonicalLogs: Record<string, unknown>[] = [];
    for (const value of result) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Sepolia RPC eth_getLogs returned an invalid UserOperation log");
      }
      const log = value as Record<string, unknown>;
      if (log.removed !== undefined && typeof log.removed !== "boolean") {
        throw new Error("Sepolia RPC eth_getLogs returned an invalid UserOperation log");
      }
      // A removed log is not evidence of canonical inclusion after a reorg.
      if (log.removed === true) continue;
      canonicalLogs.push(log);
    }
    if (canonicalLogs.length === 0) return { status: "pending" };
    if (canonicalLogs.length !== 1) {
      throw new Error("Sepolia RPC eth_getLogs returned ambiguous UserOperation logs");
    }

    const log = canonicalLogs[0]!;
    if (
      typeof log.address !== "string" ||
      log.address.toLowerCase() !== ENTRY_POINT_V08_ADDRESS.toLowerCase()
    ) {
      throw new Error("Sepolia RPC eth_getLogs returned a mismatched EntryPoint log");
    }
    if (!Array.isArray(log.topics) || log.topics.length !== 4) {
      throw new Error("Sepolia RPC eth_getLogs returned invalid UserOperation topics");
    }
    const [eventTopic, hashTopic, senderTopic, paymasterTopic] = log.topics;
    if (
      typeof eventTopic !== "string" ||
      eventTopic.toLowerCase() !== USER_OPERATION_EVENT_TOPIC ||
      typeof hashTopic !== "string" ||
      hashTopic.toLowerCase() !== normalizedHash
    ) {
      throw new Error("Sepolia RPC eth_getLogs returned mismatched UserOperation topics");
    }
    if (
      typeof senderTopic !== "string" ||
      !ABI_ADDRESS_TOPIC_RE.test(senderTopic) ||
      typeof paymasterTopic !== "string" ||
      !ABI_ADDRESS_TOPIC_RE.test(paymasterTopic)
    ) {
      throw new Error("Sepolia RPC eth_getLogs returned invalid UserOperation topics");
    }
    if (
      expectedSenderTopic !== undefined &&
      senderTopic.toLowerCase() !== expectedSenderTopic
    ) {
      throw new Error("Sepolia RPC eth_getLogs returned a mismatched UserOperation sender");
    }
    if (
      typeof log.transactionHash !== "string" ||
      !TX_HASH_RE.test(log.transactionHash)
    ) {
      throw new Error("Sepolia RPC eth_getLogs returned an invalid transaction hash");
    }
    if (
      typeof log.data !== "string" ||
      !USER_OPERATION_EVENT_DATA_RE.test(log.data)
    ) {
      throw new Error("Sepolia RPC eth_getLogs returned invalid UserOperation data");
    }

    // ABI data words are nonce, success, actualGasCost, and actualGasUsed.
    const successWord = log.data.slice(2 + 64, 2 + 128).toLowerCase();
    const falseWord = "0".repeat(64);
    const trueWord = `${"0".repeat(63)}1`;
    if (successWord !== falseWord && successWord !== trueWord) {
      throw new Error("Sepolia RPC eth_getLogs returned an invalid UserOperation success flag");
    }
    return {
      status: successWord === trueWord ? "success" : "reverted",
      transactionHash: log.transactionHash,
    };
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
