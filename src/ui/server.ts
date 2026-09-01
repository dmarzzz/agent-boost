import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import QRCode from "qrcode";

import { SEPOLIA_CHAIN_ID, type PublicOnboardingSnapshot } from "../contracts.js";
import { APP_JS, INDEX_HTML, STYLES_CSS } from "./assets.js";

export type FundingSnapshotProvider =
  () => PublicOnboardingSnapshot | Promise<PublicOnboardingSnapshot>;

export interface FundingUiServerOptions {
  snapshotProvider: FundingSnapshotProvider;
  host?: "127.0.0.1" | "::1" | "localhost";
  port?: number;
}

export interface OnboardingUiServerOptions {
  getSnapshot: FundingSnapshotProvider;
  host?: "127.0.0.1" | "::1" | "localhost";
  port?: number;
}

export interface RunningFundingUiServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function setSecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
  response.setHeader("Cache-Control", "no-store");
}

function parseLoopbackHost(host: string | undefined): string | undefined {
  if (host === undefined) return undefined;
  const normalized = host.toLowerCase();
  if (/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(normalized)) return normalized;
  if (/^\[::1\](:\d{1,5})?$/.test(normalized)) return normalized;
  return undefined;
}

function hasTrustedOrigin(request: IncomingMessage, trustedHost: string): boolean {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).origin === `http://${trustedHost}`;
  } catch {
    return false;
  }
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  setSecurityHeaders(response);
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

export function buildSepoliaFundingUri(address: string, amountWei: string): string {
  if (!ADDRESS_PATTERN.test(address)) throw new Error("A valid Ethereum address is required");
  if (!/^\d+$/.test(amountWei) || BigInt(amountWei) <= 0n) {
    throw new Error("A positive funding amount in wei is required");
  }
  return `ethereum:${address}@${SEPOLIA_CHAIN_ID}?value=${amountWei}`;
}

export async function generateFundingQrDataUrl(
  address: string,
  amountWei: string,
): Promise<string> {
  return QRCode.toDataURL(buildSepoliaFundingUri(address, amountWei), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 480,
    color: { dark: "#0A090EFF", light: "#F1EEE8FF" },
  });
}

export async function generateFundingQrPng(
  address: string,
  amountWei: string,
): Promise<Buffer> {
  return QRCode.toBuffer(buildSepoliaFundingUri(address, amountWei), {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 480,
    color: { dark: "#0A090EFF", light: "#F1EEE8FF" },
  });
}

async function publicSnapshot(
  provider: FundingSnapshotProvider,
): Promise<PublicOnboardingSnapshot> {
  const snapshot = await provider();
  const remainingFunding = BigInt(snapshot.requiredFundingWei) - BigInt(snapshot.publicBalanceWei);
  const acceptsFunding = snapshot.phase === "awaiting_funding" || snapshot.phase === "funding_pending";
  const qrDataUrl = snapshot.address === undefined || !acceptsFunding || remainingFunding <= 0n
    ? undefined
    : await generateFundingQrDataUrl(snapshot.address, remainingFunding.toString());

  // Copy only the explicit public contract. In particular, never serialize an
  // adapter, key material, provider configuration, or arbitrary record fields.
  return {
    setupId: snapshot.setupId,
    revision: snapshot.revision,
    phase: snapshot.phase,
    ...(snapshot.address === undefined ? {} : { address: snapshot.address }),
    publicBalanceWei: snapshot.publicBalanceWei,
    privateBalanceWei: snapshot.privateBalanceWei,
    requiredFundingWei: snapshot.requiredFundingWei,
    shieldAmountWei: snapshot.shieldAmountWei,
    ...(qrDataUrl === undefined ? {} : { qrDataUrl }),
    delegation: {
      mode: snapshot.delegation.mode,
      chainId: snapshot.delegation.chainId,
      perPaymentLimitWei: snapshot.delegation.perPaymentLimitWei,
      lifetimeLimitWei: snapshot.delegation.lifetimeLimitWei,
      spentWei: snapshot.delegation.spentWei,
      expiresAt: snapshot.delegation.expiresAt,
      enabled: snapshot.delegation.enabled,
    },
    ...(snapshot.error === undefined ? {} : {
      error: {
        code: snapshot.error.code,
        message: snapshot.error.message,
        retryable: snapshot.error.retryable,
      },
    }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  provider: FundingSnapshotProvider,
): Promise<void> {
  const trustedHost = parseLoopbackHost(request.headers.host);
  if (trustedHost === undefined) {
    send(response, 421, "text/plain; charset=utf-8", "Loopback host required\n");
    return;
  }
  if (!hasTrustedOrigin(request, trustedHost)) {
    send(response, 403, "text/plain; charset=utf-8", "Cross-origin request rejected\n");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "text/plain; charset=utf-8", "Method not allowed\n", { Allow: "GET, HEAD" });
    return;
  }

  const path = new URL(request.url ?? "/", `http://${trustedHost}`).pathname;
  let status = 200;
  let contentType = "text/plain; charset=utf-8";
  let body: string;

  if (path === "/") {
    contentType = "text/html; charset=utf-8";
    body = INDEX_HTML;
  } else if (path === "/styles.css") {
    contentType = "text/css; charset=utf-8";
    body = STYLES_CSS;
  } else if (path === "/app.js") {
    contentType = "text/javascript; charset=utf-8";
    body = APP_JS;
  } else if (path === "/api/state") {
    contentType = "application/json; charset=utf-8";
    try {
      body = JSON.stringify(await publicSnapshot(provider));
    } catch {
      status = 503;
      body = JSON.stringify({ error: "onboarding_state_unavailable" });
    }
  } else {
    status = 404;
    body = "Not found\n";
  }

  if (request.method === "HEAD") body = "";
  send(response, status, contentType, body);
}

export async function startFundingUiServer(
  options: FundingUiServerOptions,
): Promise<RunningFundingUiServer> {
  const port = options.port ?? 0;
  const host = options.host ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65_535 || port === 9_180) {
    throw new Error("UI port must be an available port other than 9180");
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, options.snapshotProvider).catch(() => {
      if (!response.headersSent) {
        send(response, 500, "text/plain; charset=utf-8", "Local UI error\n");
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Local UI did not bind to a TCP port");
  }

  return {
    server,
    url: `http://${host === "::1" ? "[::1]" : host}:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

export class OnboardingUiServer {
  readonly #options: OnboardingUiServerOptions;
  #running: RunningFundingUiServer | undefined;

  constructor(options: OnboardingUiServerOptions) {
    this.#options = options;
  }

  async start(): Promise<{ url: string }> {
    if (this.#running !== undefined) return { url: this.#running.url };
    this.#running = await startFundingUiServer({
      snapshotProvider: this.#options.getSnapshot,
      ...(this.#options.host === undefined ? {} : { host: this.#options.host }),
      ...(this.#options.port === undefined ? {} : { port: this.#options.port }),
    });
    return { url: this.#running.url };
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = undefined;
    if (running !== undefined) await running.close();
  }
}
