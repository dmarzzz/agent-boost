import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import type { RpcFetch } from "../rpc/sepolia.js";

export interface TorRpcProxyPort {
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface TorRpcProxyOptions {
  upstreamUrl: string;
  fetch: RpcFetch;
  host?: "127.0.0.1";
  port?: number;
  requestTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxConcurrentRequests?: number;
}

const ALLOWED_RPC_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_createAccessList",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendRawTransaction",
  "eth_syncing",
  "net_version",
  "web3_clientVersion",
]);

/** A loopback-only, authenticated, fixed-origin JSON-RPC reverse proxy. */
export class TorRpcProxy implements TorRpcProxyPort {
  readonly #upstreamUrl: string;
  readonly #fetch: RpcFetch;
  readonly #host: "127.0.0.1";
  readonly #configuredPort: number;
  readonly #token = randomBytes(32).toString("base64url");
  readonly #requestTimeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxConcurrentRequests: number;
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;
  #port: number | undefined;
  #activeRequests = 0;

  constructor(options: TorRpcProxyOptions) {
    const upstream = new URL(options.upstreamUrl);
    if (upstream.protocol !== "https:") {
      throw new Error("Tor RPC proxy upstream must use HTTPS");
    }
    this.#upstreamUrl = upstream.toString();
    this.#fetch = options.fetch;
    this.#host = options.host ?? "127.0.0.1";
    this.#configuredPort = options.port ?? 9_185;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024;
    this.#maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    this.#maxConcurrentRequests = options.maxConcurrentRequests ?? 4;
    for (const [value, label, allowZero] of [
      [this.#configuredPort, "port", true],
      [this.#requestTimeoutMs, "request timeout", false],
      [this.#maxRequestBytes, "request limit", false],
      [this.#maxResponseBytes, "response limit", false],
      [this.#maxConcurrentRequests, "concurrency limit", false],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
        throw new Error(`Tor RPC proxy ${label} is invalid`);
      }
    }
    if (this.#configuredPort > 65_535) {
      throw new Error("Tor RPC proxy port is invalid");
    }
  }

  get url(): string {
    const port = this.#port ?? this.#configuredPort;
    if (port === 0) throw new Error("Tor RPC proxy URL is unavailable before start");
    return `http://${this.#host}:${port}/rpc/${this.#token}`;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (!response.headersSent && error instanceof ClientRequestError) {
          sendJson(response, error.status, error.code);
        } else if (!response.headersSent) {
          sendJson(response, 502, "rpc_route_failed");
        }
        else response.destroy();
      });
    });
    server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(this.#configuredPort, this.#host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Tor RPC proxy did not bind a TCP loopback address");
    }
    this.#port = address.port;
    this.#server = server;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#port = undefined;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const expectedHost = `${this.#host}:${this.#port?.toString() ?? ""}`;
    if (request.headers.host !== expectedHost) {
      sendJson(response, 421, "loopback_host_required");
      return;
    }
    if (request.url !== `/rpc/${this.#token}`) {
      sendJson(response, 404, "not_found");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, "method_not_allowed");
      return;
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) {
      sendJson(response, 415, "json_required");
      return;
    }
    if (this.#activeRequests >= this.#maxConcurrentRequests) {
      sendJson(response, 429, "rpc_route_busy");
      return;
    }

    this.#activeRequests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    timer.unref();
    const abortOnDisconnect = (): void => controller.abort();
    request.once("aborted", abortOnDisconnect);
    try {
      const body = await readBoundedBody(
        request,
        this.#maxRequestBytes,
        controller.signal,
      );
      validateJsonRpc(body);
      let upstream: Response;
      try {
        upstream = await this.#fetch(this.#upstreamUrl, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: body.toString("utf8"),
          signal: controller.signal,
        });
      } catch {
        sendJson(response, 502, "tor_rpc_unavailable");
        return;
      }

      const declaredLength = Number(upstream.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.#maxResponseBytes) {
        sendJson(response, 502, "rpc_response_too_large");
        return;
      }
      const responseBody = await readBoundedResponse(
        upstream,
        this.#maxResponseBytes,
        controller.signal,
      );
      response.writeHead(upstream.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        "Content-Length": responseBody.byteLength,
        "X-Content-Type-Options": "nosniff",
      });
      response.end(responseBody);
    } finally {
      clearTimeout(timer);
      request.off("aborted", abortOnDisconnect);
      this.#activeRequests -= 1;
    }
  }
}

async function readBoundedBody(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume();
    throw new ClientRequestError(413, "rpc_request_too_large");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  const onAbort = (): void => {
    request.destroy(new Error("RPC request timed out"));
  };
  if (signal.aborted) throw new ClientRequestError(408, "rpc_request_timeout");
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      length += chunk.byteLength;
      if (length > maxBytes) throw new ClientRequestError(413, "rpc_request_too_large");
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal.aborted) throw new ClientRequestError(408, "rpc_request_timeout");
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks);
}

function validateJsonRpc(body: Buffer): void {
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ClientRequestError(400, "invalid_json");
  }
  const requests = Array.isArray(payload) ? payload : [payload];
  if (requests.length === 0 || requests.length > 100) {
    throw new ClientRequestError(400, "invalid_json_rpc");
  }
  for (const value of requests) {
    if (
      !isRecord(value) ||
      value.jsonrpc !== "2.0" ||
      typeof value.method !== "string" ||
      !ALLOWED_RPC_METHODS.has(value.method)
    ) {
      throw new ClientRequestError(400, "invalid_json_rpc");
    }
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new Error("RPC response timed out"));
    else signal.addEventListener(
      "abort",
      () => reject(new Error("RPC response timed out")),
      { once: true },
    );
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ClientRequestError(502, "rpc_response_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

class ClientRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response: ServerResponse, status: number, code: string): void {
  const body = JSON.stringify({ error: code });
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
