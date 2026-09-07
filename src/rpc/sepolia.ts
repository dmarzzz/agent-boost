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
/** Public Sepolia RPCs commonly cap eth_getLogs at 50,000 blocks. */
const USER_OPERATION_LOG_BLOCKS_PER_RANGE = 50_000n;
/** Keep fallback batches below the local RPC proxy's 100-request ceiling. */
const USER_OPERATION_LOG_BATCH_SIZE = 20;
/**
 * Bound work even if an RPC returns a syntactically valid hostile height.
 * This still scans every Sepolia block through 51,199,999 (well beyond the
 * current chain) while limiting one lookup to 1,024 bounded ranges.
 */
const USER_OPERATION_LOG_MAX_RANGES = 1_024;
const USER_OPERATION_LOG_MAX_BLOCK =
  BigInt(USER_OPERATION_LOG_MAX_RANGES) * USER_OPERATION_LOG_BLOCKS_PER_RANGE - 1n;

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
    const latestBlock = parseHexQuantity(
      await this.#request("eth_blockNumber", []),
      "eth_blockNumber",
    );
    if (latestBlock > USER_OPERATION_LOG_MAX_BLOCK) {
      throw new Error("Sepolia RPC block height exceeds the receipt scan safety bound");
    }
    const ranges = descendingBlockRanges(latestBlock);
    const newest = ranges.next();
    if (newest.done) {
      throw new Error("Sepolia RPC receipt scan produced no block ranges");
    }

    // A newly submitted UserOperation should be in the newest range. Keep that
    // common path to one log request, then scan older non-overlapping ranges in
    // bounded batches so recovery also works after a long offline interval.
    let canonicalLogs = canonicalUserOperationLogs(
      await this.#request("eth_getLogs", [
        userOperationLogFilter(newest.value, normalizedHash),
      ]),
    );
    let batchSupportedForScan = true;
    while (canonicalLogs.length === 0) {
      const batch: Array<{ method: string; params: readonly unknown[] }> = [];
      for (let index = 0; index < USER_OPERATION_LOG_BATCH_SIZE; index += 1) {
        const range = ranges.next();
        if (range.done) break;
        batch.push({
          method: "eth_getLogs",
          params: [userOperationLogFilter(range.value, normalizedHash)],
        });
      }
      if (batch.length === 0) break;
      const result = await this.#canonicalLogsFromRequests(
        batch,
        batchSupportedForScan,
      );
      canonicalLogs = result.logs;
      batchSupportedForScan = result.batchSupported;
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

  async #canonicalLogsFromRequests(
    requests: readonly { method: string; params: readonly unknown[] }[],
    batchSupported: boolean,
  ): Promise<{
    logs: Record<string, unknown>[];
    batchSupported: boolean;
  }> {
    if (batchSupported) {
      let results: unknown[];
      try {
        results = await this.#requestBatch(requests);
      } catch {
        // Batch support is only an optimization. Downgrade this receipt scan,
        // not the client: a later lookup must retry after a transient failure.
        return {
          logs: await this.#canonicalLogsSequential(requests),
          batchSupported: false,
        };
      }
      // Keep evidence validation outside the transport fallback catch. Invalid
      // or ambiguous logs fail closed instead of being retried sequentially.
      return {
        logs: results.flatMap(canonicalUserOperationLogs),
        batchSupported: true,
      };
    }
    return {
      logs: await this.#canonicalLogsSequential(requests),
      batchSupported: false,
    };
  }

  async #canonicalLogsSequential(
    requests: readonly { method: string; params: readonly unknown[] }[],
  ): Promise<Record<string, unknown>[]> {
    for (const request of requests) {
      const logs = canonicalUserOperationLogs(
        await this.#request(request.method, request.params),
      );
      // Once an exact-hash range contains canonical evidence, older ranges
      // cannot change that receipt and need not delay terminal reconciliation.
      if (logs.length > 0) return logs;
    }
    return [];
  }

  async #requestBatch(
    requests: readonly { method: string; params: readonly unknown[] }[],
  ): Promise<unknown[]> {
    if (requests.length === 0) return [];
    const payload = requests.map((request) => ({
      jsonrpc: "2.0" as const,
      id: this.#nextId++,
      method: request.method,
      params: request.params,
    }));
    const response = await this.#post(payload);
    if (!Array.isArray(response) || response.length !== payload.length) {
      throw new Error("Sepolia RPC returned an invalid batch response");
    }
    const expectedIds = new Set(payload.map((request) => request.id));
    const responses = new Map<number, JsonRpcResponse>();
    for (const value of response) {
      if (
        typeof value !== "object" || value === null || Array.isArray(value)
      ) {
        throw new Error("Sepolia RPC returned an invalid batch response");
      }
      const item = value as JsonRpcResponse;
      if (
        item.jsonrpc !== "2.0" || typeof item.id !== "number" ||
        !expectedIds.has(item.id) || responses.has(item.id)
      ) {
        throw new Error("Sepolia RPC returned an invalid or mismatched batch response");
      }
      if (item.error !== undefined) {
        throw new Error("Sepolia RPC batch returned an error");
      }
      if (!("result" in item)) {
        throw new Error("Sepolia RPC batch returned no result");
      }
      responses.set(item.id, item);
    }
    return payload.map((request) => responses.get(request.id)!.result);
  }

  async #request(method: string, params: readonly unknown[]): Promise<unknown> {
    const id = this.#nextId++;
    const payload = await this.#post({ jsonrpc: "2.0", id, method, params });
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error("Sepolia RPC returned an invalid or mismatched response");
    }
    const response = payload as JsonRpcResponse;
    if (response.jsonrpc !== "2.0" || response.id !== id) {
      throw new Error("Sepolia RPC returned an invalid or mismatched response");
    }
    if (response.error !== undefined) {
      throw new Error(`Sepolia RPC ${method} returned an error`);
    }
    if (!("result" in response)) {
      throw new Error(`Sepolia RPC ${method} returned no result`);
    }
    return response.result;
  }

  async #post(body: unknown): Promise<unknown> {
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
        body: JSON.stringify(body),
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

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Sepolia RPC returned invalid JSON");
    }
    return payload;
  }
}

interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
}

function* descendingBlockRanges(latestBlock: bigint): Generator<BlockRange> {
  if (latestBlock < 0n || latestBlock > USER_OPERATION_LOG_MAX_BLOCK) {
    throw new Error("Sepolia RPC block height exceeds the receipt scan safety bound");
  }
  let toBlock = latestBlock;
  for (let count = 0; count < USER_OPERATION_LOG_MAX_RANGES; count += 1) {
    const fromBlock = toBlock + 1n > USER_OPERATION_LOG_BLOCKS_PER_RANGE
      ? toBlock + 1n - USER_OPERATION_LOG_BLOCKS_PER_RANGE
      : 0n;
    yield { fromBlock, toBlock };
    if (fromBlock === 0n) return;
    toBlock = fromBlock - 1n;
  }
  throw new Error("Sepolia RPC receipt scan exceeded its range safety bound");
}

function userOperationLogFilter(
  range: BlockRange,
  normalizedHash: string,
): Record<string, unknown> {
  return {
    address: ENTRY_POINT_V08_ADDRESS,
    fromBlock: hexQuantity(range.fromBlock),
    toBlock: hexQuantity(range.toBlock),
    topics: [USER_OPERATION_EVENT_TOPIC, normalizedHash],
  };
}

function canonicalUserOperationLogs(result: unknown): Record<string, unknown>[] {
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
    if (log.removed !== true) canonicalLogs.push(log);
  }
  return canonicalLogs;
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

function hexQuantity(value: bigint): string {
  if (value < 0n) throw new Error("Sepolia RPC block range cannot be negative");
  return `0x${value.toString(16)}`;
}
