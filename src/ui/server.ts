import { createRequire } from "node:module";
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

interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}

interface PngApi {
  new (options: { width: number; height: number }): PngImage;
  sync: {
    read(data: Buffer): PngImage;
    write(image: PngImage): Buffer;
  };
}

type Rgba = readonly [red: number, green: number, blue: number, alpha: number];

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs") as { PNG: PngApi };

const QR_SIZE = 480;
const AGENT_CARD_WIDTH = 720;
const AGENT_CARD_HEIGHT = 800;
const SOOT: Rgba = [10, 9, 14, 255];
const CARBON: Rgba = [21, 19, 27, 255];
const CARBON_RAISED: Rgba = [28, 25, 35, 255];
const QR_SMOKE: Rgba = [169, 162, 180, 255];
const LINE: Rgba = [48, 43, 57, 255];
const ULTRAVIOLET: Rgba = [130, 104, 255, 255];
const VOLT: Rgba = [201, 255, 87, 255];
const AMBER: Rgba = [255, 184, 77, 255];
const SIGNAL_VIOLET: Rgba = [63, 23, 108, 255];
const SIGNAL_CYAN: Rgba = [4, 55, 83, 255];
const SIGNAL_MAGENTA: Rgba = [87, 21, 54, 255];
const SIGNAL_TEAL: Rgba = [3, 67, 55, 255];

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

function setPixel(image: PngImage, x: number, y: number, color: Rgba): void {
  if (x < 0 || x >= image.width || y < 0 || y >= image.height) return;
  const offset = (y * image.width + x) * 4;
  const alpha = color[3] / 255;
  const inverse = 1 - alpha;
  image.data[offset] = Math.round(color[0] * alpha + (image.data[offset] ?? 0) * inverse);
  image.data[offset + 1] = Math.round(color[1] * alpha + (image.data[offset + 1] ?? 0) * inverse);
  image.data[offset + 2] = Math.round(color[2] * alpha + (image.data[offset + 2] ?? 0) * inverse);
  image.data[offset + 3] = 255;
}

function fill(image: PngImage, color: Rgba): void {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) setPixel(image, x, y, color);
  }
}

function fillRect(
  image: PngImage,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Rgba,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      setPixel(image, column, row, color);
    }
  }
}

function fillRoundedRect(
  image: PngImage,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: Rgba,
): void {
  const right = x + width - 1;
  const bottom = y + height - 1;
  for (let row = y; row <= bottom; row += 1) {
    for (let column = x; column <= right; column += 1) {
      const nearestX = Math.max(x + radius, Math.min(column, right - radius));
      const nearestY = Math.max(y + radius, Math.min(row, bottom - radius));
      const dx = column - nearestX;
      const dy = row - nearestY;
      if (dx * dx + dy * dy <= radius * radius) setPixel(image, column, row, color);
    }
  }
}

function drawDisc(image: PngImage, centerX: number, centerY: number, radius: number, color: Rgba): void {
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy <= radius * radius) setPixel(image, x, y, color);
    }
  }
}

function drawLine(
  image: PngImage,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  color: Rgba,
  thickness = 1,
): void {
  const distance = Math.max(Math.abs(endX - startX), Math.abs(endY - startY));
  if (distance === 0) {
    drawDisc(image, startX, startY, Math.max(1, Math.floor(thickness / 2)), color);
    return;
  }
  for (let step = 0; step <= distance; step += 1) {
    const progress = step / distance;
    const x = Math.round(startX + (endX - startX) * progress);
    const y = Math.round(startY + (endY - startY) * progress);
    drawDisc(image, x, y, Math.max(0, Math.floor(thickness / 2)), color);
  }
}

function drawOrbit(
  image: PngImage,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  rotation: number,
  color: Rgba,
): void {
  const steps = 360;
  let previousX = centerX;
  let previousY = centerY;
  for (let step = 0; step <= steps; step += 1) {
    const angle = step / steps * Math.PI * 2;
    const localX = Math.cos(angle) * radiusX;
    const localY = Math.sin(angle) * radiusY;
    const x = Math.round(centerX + localX * Math.cos(rotation) - localY * Math.sin(rotation));
    const y = Math.round(centerY + localX * Math.sin(rotation) + localY * Math.cos(rotation));
    if (step > 0) drawLine(image, previousX, previousY, x, y, color);
    previousX = x;
    previousY = y;
  }
}

function blit(destination: PngImage, source: PngImage, offsetX: number, offsetY: number): void {
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sourceOffset = (y * source.width + x) * 4;
      setPixel(destination, offsetX + x, offsetY + y, [
        source.data[sourceOffset] ?? 0,
        source.data[sourceOffset + 1] ?? 0,
        source.data[sourceOffset + 2] ?? 0,
        source.data[sourceOffset + 3] ?? 255,
      ]);
    }
  }
}

function mixColor(start: Rgba, end: Rgba, amount: number): Rgba {
  return [
    Math.round(start[0] + (end[0] - start[0]) * amount),
    Math.round(start[1] + (end[1] - start[1]) * amount),
    Math.round(start[2] + (end[2] - start[2]) * amount),
    255,
  ];
}

function applySignalSpectrum(qr: PngImage): void {
  for (let y = 0; y < qr.height; y += 1) {
    const vertical = y / Math.max(1, qr.height - 1);
    for (let x = 0; x < qr.width; x += 1) {
      const offset = (y * qr.width + x) * 4;
      const red = qr.data[offset] ?? 255;
      const green = qr.data[offset + 1] ?? 255;
      const blue = qr.data[offset + 2] ?? 255;
      if (red + green + blue > 24) continue;

      const horizontal = x / Math.max(1, qr.width - 1);
      const top = mixColor(SIGNAL_VIOLET, SIGNAL_CYAN, horizontal);
      const bottom = mixColor(SIGNAL_MAGENTA, SIGNAL_TEAL, horizontal);
      const signal = mixColor(top, bottom, vertical);
      qr.data[offset] = signal[0];
      qr.data[offset + 1] = signal[1];
      qr.data[offset + 2] = signal[2];
    }
  }
}

/**
 * Builds the attachment sent to an agent host. The QR keeps conventional
 * dark-on-light polarity and an uninterrupted scan field while the containing
 * card carries the Agent Boost dark-sidecar identity.
 */
export async function generateFundingQrCardPng(
  address: string,
  amountWei: string,
): Promise<Buffer> {
  const qr = PNG.sync.read(await QRCode.toBuffer(buildSepoliaFundingUri(address, amountWei), {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 4,
    width: QR_SIZE,
    color: { dark: "#000000FF", light: "#A9A2B4FF" },
  }));
  applySignalSpectrum(qr);
  const card = new PNG({ width: AGENT_CARD_WIDTH, height: AGENT_CARD_HEIGHT });
  fill(card, SOOT);
  fillRoundedRect(card, 36, 30, 648, 740, 32, [0, 0, 0, 92]);
  fillRoundedRect(card, 40, 26, 640, 740, 30, CARBON);
  fillRoundedRect(card, 41, 27, 638, 738, 29, CARBON_RAISED);

  // A restrained protocol grid and three offset aperture rings echo the local
  // onboarding UI without placing any decoration inside the QR quiet zone.
  for (let x = 0; x < AGENT_CARD_WIDTH; x += 48) {
    drawLine(card, x, 0, x, AGENT_CARD_HEIGHT, [ULTRAVIOLET[0], ULTRAVIOLET[1], ULTRAVIOLET[2], 9]);
  }
  for (let y = 0; y < AGENT_CARD_HEIGHT; y += 48) {
    drawLine(card, 0, y, AGENT_CARD_WIDTH, y, [ULTRAVIOLET[0], ULTRAVIOLET[1], ULTRAVIOLET[2], 9]);
  }
  drawOrbit(card, 360, 356, 326, 282, 0.08, [ULTRAVIOLET[0], ULTRAVIOLET[1], ULTRAVIOLET[2], 64]);
  drawOrbit(card, 360, 356, 292, 326, 1.08, [ULTRAVIOLET[0], ULTRAVIOLET[1], ULTRAVIOLET[2], 44]);
  drawOrbit(card, 360, 356, 278, 306, 2.02, [ULTRAVIOLET[0], ULTRAVIOLET[1], ULTRAVIOLET[2], 32]);

  // Header glyph: agent core, private relay, and a live network indicator.
  drawDisc(card, 78, 70, 7, ULTRAVIOLET);
  drawDisc(card, 78, 70, 16, [ULTRAVIOLET[0], ULTRAVIOLET[1], ULTRAVIOLET[2], 25]);
  drawLine(card, 102, 70, 210, 70, [ULTRAVIOLET[0], ULTRAVIOLET[1], ULTRAVIOLET[2], 116], 2);
  for (let index = 0; index < 4; index += 1) {
    fillRoundedRect(card, 102 + index * 28, 61, 18, 18, 4, [ULTRAVIOLET[0], ULTRAVIOLET[1], ULTRAVIOLET[2], 30 + index * 25]);
  }
  drawDisc(card, 639, 70, 5, AMBER);
  drawDisc(card, 639, 70, 13, [AMBER[0], AMBER[1], AMBER[2], 18]);

  // The QR is intentionally the only light surface and receives a full quiet
  // zone from the encoder plus an additional physical frame in the card.
  fillRoundedRect(card, 92, 96, 536, 536, 26, [0, 0, 0, 92]);
  fillRoundedRect(card, 96, 92, 528, 528, 24, QR_SMOKE);
  blit(card, qr, 120, 116);

  // Footer signal: information enters the private core and exits through the
  // scoped live route. It is decorative and stays well clear of the scan field.
  drawDisc(card, 116, 698, 7, ULTRAVIOLET);
  for (let index = 0; index < 5; index += 1) {
    const y = 686 + index * 6;
    drawLine(card, 130, 698, 288, y, [ULTRAVIOLET[0], ULTRAVIOLET[1], ULTRAVIOLET[2], 52 + index * 18]);
    drawLine(card, 288, y, 342, 698, [ULTRAVIOLET[0], ULTRAVIOLET[1], ULTRAVIOLET[2], 52 + index * 18]);
  }
  fillRoundedRect(card, 342, 672, 52, 52, 14, [10, 9, 14, 255]);
  fillRoundedRect(card, 352, 682, 32, 32, 8, [ULTRAVIOLET[0], ULTRAVIOLET[1], ULTRAVIOLET[2], 72]);
  drawDisc(card, 368, 698, 6, ULTRAVIOLET);
  drawLine(card, 394, 698, 594, 698, [VOLT[0], VOLT[1], VOLT[2], 118], 2);
  drawDisc(card, 604, 698, 7, VOLT);
  drawDisc(card, 604, 698, 18, [VOLT[0], VOLT[1], VOLT[2], 18]);
  fillRect(card, 96, 742, 432, 2, LINE);
  fillRect(card, 536, 742, 40, 2, [ULTRAVIOLET[0], ULTRAVIOLET[1], ULTRAVIOLET[2], 155]);
  fillRect(card, 584, 742, 40, 2, [VOLT[0], VOLT[1], VOLT[2], 180]);

  return PNG.sync.write(card);
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
    ...(snapshot.rpcRoute === undefined ? {} : {
      rpcRoute: {
        mode: "tor" as const,
        scope: "ethereum_json_rpc" as const,
        status: snapshot.rpcRoute.status,
        directFallback: false as const,
      },
    }),
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
