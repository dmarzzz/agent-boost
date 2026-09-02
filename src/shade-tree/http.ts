import { once } from "node:events";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";

import { assertCoveredContentType, validateCoveredUrl } from "./policy.js";
import type { CoveredFetchResult } from "./types.js";

const MAX_HEADER_BYTES = 32 * 1024;

export interface ShadeTreeProxyFetchOptions {
  host: "127.0.0.1";
  port: number;
  token: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
}

export async function fetchThroughShadeTreeProxy(
  rawUrl: string,
  method: "GET" | "HEAD",
  options: ShadeTreeProxyFetchOptions,
): Promise<CoveredFetchResult> {
  let url = validateCoveredUrl(rawUrl);
  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    const response = await requestOnce(url, method, options);
    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("COVERED_EGRESS_UPSTREAM_INVALID: redirect has no location");
      if (redirects === options.maxRedirects) {
        throw new Error("COVERED_EGRESS_REDIRECT_LIMIT: too many redirects");
      }
      url = validateCoveredUrl(new URL(location, url).href);
      continue;
    }
    const contentType = method === "HEAD"
      ? response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
      : assertCoveredContentType(response.headers.get("content-type") ?? undefined);
    const body = method === "HEAD" ? "" : decodeUtf8(response.body);
    return {
      status: response.status,
      finalUrl: url.href,
      contentType,
      body,
      bytes: response.body.byteLength,
      redirects,
      route: "shade-tree",
    };
  }
  throw new Error("COVERED_EGRESS_REDIRECT_LIMIT: too many redirects");
}

async function requestOnce(
  url: URL,
  method: "GET" | "HEAD",
  options: ShadeTreeProxyFetchOptions,
): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const socket = connectTcp({ host: options.host, port: options.port });
  let activeSocket: Socket | TLSSocket = socket;
  const timer = setTimeout(
    () => activeSocket.destroy(new Error("covered egress timed out")),
    options.timeoutMs,
  );
  timer.unref();
  try {
    await once(socket, "connect");
    const auth = Buffer.from(`shade-tree:${options.token}`).toString("base64");
    socket.write(
      `CONNECT ${url.hostname}:443 HTTP/1.1\r\n` +
      `Host: ${url.hostname}:443\r\n` +
      `Proxy-Authorization: Basic ${auth}\r\n` +
      "Connection: close\r\n\r\n",
    );
    const connectResponse = await readHeader(socket);
    if (connectResponse.status !== 200) {
      throw new Error(
        connectResponse.status === 407
          ? "COVERED_EGRESS_PROXY_AUTH_FAILED"
          : `COVERED_EGRESS_TUNNEL_FAILED: proxy returned ${connectResponse.status}`,
      );
    }
    if (connectResponse.rest.byteLength > 0) {
      socket.unshift(connectResponse.rest);
    }
    const tls = connectTls({
      socket,
      servername: url.hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
    });
    activeSocket = tls;
    await once(tls, "secureConnect");
    const path = `${url.pathname}${url.search}` || "/";
    tls.write(
      `${method} ${path} HTTP/1.1\r\n` +
      `Host: ${url.hostname}\r\n` +
      "Accept: application/json, text/plain;q=0.9, text/*;q=0.8\r\n" +
      "Accept-Encoding: identity\r\n" +
      "User-Agent: agent-boost-covered-egress/0.1\r\n" +
      "Connection: close\r\n\r\n",
    );
    const upstream = await readHeader(tls);
    const encoding = upstream.headers.get("content-encoding")?.trim().toLowerCase();
    if (encoding && encoding !== "identity") {
      throw new Error("COVERED_EGRESS_CONTENT_DENIED: compressed responses are not accepted");
    }
    const body = method === "HEAD"
      ? Buffer.alloc(0)
      : await readBody(tls, upstream.rest, upstream.headers, options.maxBytes);
    return { status: upstream.status, headers: upstream.headers, body };
  } finally {
    clearTimeout(timer);
    activeSocket.destroy();
    socket.destroy();
  }
}

async function readHeader(socket: Socket | TLSSocket): Promise<{
  status: number;
  headers: Headers;
  rest: Buffer;
}> {
  let buffer = Buffer.alloc(0);
  while (true) {
    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary !== -1) {
      const raw = buffer.subarray(0, boundary).toString("latin1");
      const lines = raw.split("\r\n");
      const statusLine = lines.shift() ?? "";
      const match = /^HTTP\/1\.[01] ([0-9]{3})(?: |$)/u.exec(statusLine);
      if (!match?.[1]) throw new Error("COVERED_EGRESS_UPSTREAM_INVALID: malformed HTTP status");
      const headers = new Headers();
      for (const line of lines) {
        const split = line.indexOf(":");
        if (split <= 0) throw new Error("COVERED_EGRESS_UPSTREAM_INVALID: malformed HTTP header");
        headers.append(line.slice(0, split).trim(), line.slice(split + 1).trim());
      }
      return {
        status: Number(match[1]),
        headers,
        rest: buffer.subarray(boundary + 4),
      };
    }
    if (buffer.byteLength > MAX_HEADER_BYTES) {
      throw new Error("COVERED_EGRESS_UPSTREAM_INVALID: response headers exceed 32 KiB");
    }
    const chunk = socket.read() as Buffer | null;
    if (chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      continue;
    }
    const event = await Promise.race([
      once(socket, "readable").then(() => "readable" as const),
      once(socket, "end").then(() => "end" as const),
    ]);
    if (event === "end") throw new Error("COVERED_EGRESS_UPSTREAM_INVALID: connection closed before headers");
  }
}

async function readBody(
  socket: Socket | TLSSocket,
  initial: Buffer,
  headers: Headers,
  maxBytes: number,
): Promise<Buffer> {
  const lengthHeader = headers.get("content-length");
  const transfer = headers.get("transfer-encoding")?.toLowerCase();
  if (lengthHeader && transfer) {
    throw new Error("COVERED_EGRESS_UPSTREAM_INVALID: conflicting response framing");
  }
  if (lengthHeader) {
    if (!/^(0|[1-9][0-9]*)$/u.test(lengthHeader)) {
      throw new Error("COVERED_EGRESS_UPSTREAM_INVALID: invalid content-length");
    }
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      throw new Error("COVERED_EGRESS_RESPONSE_LIMIT: response exceeds configured limit");
    }
    return readExact(socket, initial, length);
  }
  if (transfer?.includes("chunked")) {
    return decodeChunked(await readUntilEnd(socket, initial, maxBytes + MAX_HEADER_BYTES), maxBytes);
  }
  return readUntilEnd(socket, initial, maxBytes);
}

async function readExact(socket: Socket | TLSSocket, initial: Buffer, length: number): Promise<Buffer> {
  let buffer = initial;
  while (buffer.byteLength < length) {
    const chunk = socket.read() as Buffer | null;
    if (chunk) buffer = Buffer.concat([buffer, chunk]);
    else {
      const event = await Promise.race([
        once(socket, "readable").then(() => "readable" as const),
        once(socket, "end").then(() => "end" as const),
      ]);
      if (event === "end") break;
    }
  }
  if (buffer.byteLength < length) {
    throw new Error("COVERED_EGRESS_UPSTREAM_INVALID: response ended before content-length");
  }
  return buffer.subarray(0, length);
}

async function readUntilEnd(
  socket: Socket | TLSSocket,
  initial: Buffer,
  maxBytes: number,
): Promise<Buffer> {
  const chunks = [initial];
  let size = initial.byteLength;
  for await (const chunk of socket) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > maxBytes) {
      throw new Error("COVERED_EGRESS_RESPONSE_LIMIT: response exceeds configured limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function decodeChunked(input: Buffer, maxBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  let total = 0;
  while (true) {
    const lineEnd = input.indexOf("\r\n", offset);
    if (lineEnd === -1) throw new Error("COVERED_EGRESS_UPSTREAM_INVALID: malformed chunked body");
    const rawSize = input.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0] ?? "";
    if (!/^[0-9a-fA-F]+$/u.test(rawSize)) {
      throw new Error("COVERED_EGRESS_UPSTREAM_INVALID: malformed chunk size");
    }
    const size = Number.parseInt(rawSize, 16);
    offset = lineEnd + 2;
    if (size === 0) break;
    if (!Number.isSafeInteger(size) || offset + size + 2 > input.byteLength) {
      throw new Error("COVERED_EGRESS_UPSTREAM_INVALID: incomplete chunked body");
    }
    total += size;
    if (total > maxBytes) {
      throw new Error("COVERED_EGRESS_RESPONSE_LIMIT: response exceeds configured limit");
    }
    chunks.push(input.subarray(offset, offset + size));
    offset += size;
    if (input.subarray(offset, offset + 2).toString("ascii") !== "\r\n") {
      throw new Error("COVERED_EGRESS_UPSTREAM_INVALID: malformed chunk boundary");
    }
    offset += 2;
  }
  return Buffer.concat(chunks);
}

function decodeUtf8(body: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("COVERED_EGRESS_CONTENT_DENIED: response is not valid UTF-8");
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
