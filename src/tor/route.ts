import { isIP } from "node:net";
import { chmod, lstat, mkdir } from "node:fs/promises";

import {
  ArtiSocketProvider,
  TorClient,
  storage,
  type ArtiSocket,
  type FetchInit,
} from "tor-js/wasm-file";

import type { RpcFetch } from "../rpc/sepolia.js";

export type TorRouteStatus = "starting" | "ready" | "failed" | "closed";

export interface TorClientPort {
  ready(): Promise<void>;
  fetch(url: string, init?: FetchInit): Promise<Response>;
  close(): void;
}

export interface TorRpcRoutePort {
  readonly status: TorRouteStatus;
  readonly fetchRpc: RpcFetch;
  ready(): Promise<void>;
  verifyTor(): Promise<void>;
  close(): Promise<void>;
}

export interface TorRpcRouteOptions {
  rpcUrl: string;
  dataDir: string;
  bootstrapTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  client?: TorClientPort;
}

const TOR_CHECK_URL = "https://check.torproject.org/api/ip";

/**
 * A deliberately narrow Tor transport. Its public fetch function accepts only
 * the one configured HTTPS RPC endpoint and never falls back to global fetch.
 */
export class TorRpcRoute implements TorRpcRoutePort {
  readonly #rpcUrl: string;
  readonly #rpcOrigin: string;
  readonly #dataDir: string;
  readonly #bootstrapTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  #client: TorClientPort | undefined;
  #status: TorRouteStatus = "starting";

  constructor(options: TorRpcRouteOptions) {
    const parsed = parseRpcUrl(options.rpcUrl);
    this.#rpcUrl = parsed.toString();
    this.#rpcOrigin = parsed.origin;
    this.#dataDir = options.dataDir;
    this.#bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 120_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#bootstrapTimeoutMs) ||
      this.#bootstrapTimeoutMs <= 0
    ) {
      throw new Error("Tor bootstrap timeout must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw new Error("Tor RPC request timeout must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes <= 0) {
      throw new Error("Tor RPC response limit must be a positive integer");
    }

    this.#client = options.client;
  }

  get status(): TorRouteStatus {
    return this.#status;
  }

  readonly fetchRpc: RpcFetch = async (input, init = {}) => {
    if (this.#status !== "ready") {
      throw new Error("Tor RPC route is not ready");
    }
    const requested = inputUrl(input);
    if (requested !== this.#rpcUrl) {
      throw new Error("Tor RPC route rejected a non-configured destination");
    }
    if ((init.method ?? "GET").toUpperCase() !== "POST") {
      throw new Error("Tor RPC route accepts JSON-RPC POST only");
    }

    try {
      const client = requiredClient(this.#client);
      return await withRequestDeadline(
        (async () => {
          const response = await client.fetch(this.#rpcUrl, {
            method: "POST",
            headers: rpcHeaders(init.headers),
            body: requestBody(init.body),
            ...(init.signal ? { signal: init.signal } : {}),
          });
          if (response.url) {
            const responseUrl = new URL(response.url);
            if (responseUrl.origin !== this.#rpcOrigin) {
              throw new Error("Tor RPC route rejected an upstream redirect");
            }
          }
          const body = await readBoundedResponse(response, this.#maxResponseBytes);
          return new Response(Uint8Array.from(body).buffer, {
            status: response.status,
            statusText: response.statusText,
            headers: {
              "content-type": response.headers.get("content-type") ?? "application/json",
            },
          });
        })(),
        this.#requestTimeoutMs,
        init.signal,
      );
    } catch {
      this.#status = "failed";
      this.#client?.close();
      this.#client = undefined;
      throw new Error("Tor RPC request failed");
    }
  };

  async ready(): Promise<void> {
    if (this.#status === "closed") throw new Error("Tor RPC route is closed");
    await ensurePrivateDirectory(this.#dataDir);
    this.#status = "starting";
    try {
      this.#client ??= new TorClient({
        storage: storage.addLocking(
          ignoreEmptyArtiState(new storage.FilesystemStorage(this.#dataDir)),
          "agent-boost-tor",
        ),
        logLevel: "error",
        socketProvider: new ClosingSocketProvider(),
      });
      await withTimeout(
        this.#client.ready(),
        this.#bootstrapTimeoutMs,
        "Tor bootstrap timed out",
      );
      this.#status = "ready";
    } catch {
      this.#status = "failed";
      this.#client?.close();
      this.#client = undefined;
      throw new Error("Tor bootstrap failed");
    }
  }

  async verifyTor(): Promise<void> {
    if (this.#status !== "ready") throw new Error("Tor RPC route is not ready");
    try {
      const client = requiredClient(this.#client);
      const response = await withRequestDeadline(
        client.fetch(TOR_CHECK_URL, {
          method: "GET",
          headers: { accept: "application/json" },
        }),
        this.#requestTimeoutMs,
        undefined,
      );
      if (!response.ok) throw new Error("Tor verification service returned an error");
      const body = await withRequestDeadline(
        readBoundedResponse(response, 64 * 1024),
        this.#requestTimeoutMs,
        undefined,
      );
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new Error("Tor verification service returned invalid JSON");
      }
      if (!isRecord(payload) || payload.IsTor !== true) {
        throw new Error("Tor verification did not confirm a Tor exit");
      }
    } catch {
      this.#status = "failed";
      this.#client?.close();
      this.#client = undefined;
      throw new Error("Tor verification failed");
    }
  }

  async close(): Promise<void> {
    if (this.#status === "closed") return;
    this.#status = "closed";
    this.#client?.close();
  }
}

/**
 * tor-js 0.4.0 can persist empty Arti state records on clean shutdown. Arti
 * rejects those empty strings as corrupt on the next bootstrap. Treat only
 * empty state values as absent; directory documents and non-empty state remain
 * untouched, so the Tor cache is still reusable across launches.
 */
export function ignoreEmptyArtiState(
  inner: storage.TorStorageSimple,
): storage.TorStorageSimple {
  const usable = (key: string, value: string | null): value is string =>
    value !== null && !(key.startsWith("state:") && value.length === 0);

  return {
    async get(key) {
      const value = await inner.get(key);
      return usable(key, value) ? value : null;
    },
    set: (key, value) => inner.set(key, value),
    delete: (key) => inner.delete(key),
    keys: (prefix) => inner.keys(prefix),
    async getAll(prefix) {
      return (await inner.getAll(prefix)).filter(([key, value]) =>
        usable(key, value),
      );
    },
  };
}

function parseRpcUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Tor RPC URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Tor RPC URL must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Tor RPC URL credentials must use a URL path or header, not userinfo");
  }
  if (isIP(parsed.hostname) !== 0) {
    throw new Error("Tor RPC URL must use a hostname so DNS resolution stays inside Tor");
  }
  return parsed;
}

function inputUrl(input: string | URL | Request): string {
  if (typeof input === "string") return new URL(input).toString();
  if (input instanceof URL) return input.toString();
  return new URL(input.url).toString();
}

function rpcHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const source = new Headers(headers);
  const contentType = source.get("content-type") ?? "application/json";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new Error("Tor RPC route requires JSON content");
  }
  return {
    accept: "application/json",
    "content-type": contentType,
  };
}

function requestBody(body: BodyInit | null | undefined): string | Uint8Array {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error("Tor RPC route requires a buffered JSON body");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Tor data path must be a directory, not a symlink");
  }
  await chmod(path, 0o700);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withRequestDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | null | undefined,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Tor RPC request timed out")), timeoutMs);
    timer.unref();
    if (signal) {
      onAbort = () => reject(new Error("Tor RPC request aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Tor RPC response exceeded its limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Tor RPC response exceeded its limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredClient(client: TorClientPort | undefined): TorClientPort {
  if (!client) throw new Error("Tor client is unavailable");
  return client;
}

/** tor-js 0.4.0 does not retain direct sockets in its default provider. */
class ClosingSocketProvider extends ArtiSocketProvider {
  readonly #openSockets = new Set<ArtiSocket>();

  override async connect(target: string): Promise<ArtiSocket> {
    const socket = await super.connect(target);
    this.#openSockets.add(socket);
    void socket.closed.then(() => this.#openSockets.delete(socket));
    return socket;
  }

  override close(): void {
    for (const socket of this.#openSockets) socket.close();
    this.#openSockets.clear();
    super.close();
  }
}
