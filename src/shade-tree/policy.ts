import { isIP } from "node:net";

const DENIED_SUFFIXES = [
  ".internal",
  ".intranet",
  ".lan",
  ".local",
  ".localhost",
  ".onion",
  ".home",
] as const;

const CREDENTIAL_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "key",
  "password",
  "secret",
  "sig",
  "signature",
  "token",
]);

export function validateCoveredUrl(raw: string): URL {
  if (raw.length === 0 || raw.length > 2_048) {
    throw new Error("COVERED_EGRESS_URL_INVALID: URL must be 1..2048 characters");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("COVERED_EGRESS_URL_INVALID: URL is not valid");
  }
  if (url.protocol !== "https:") {
    throw new Error("COVERED_EGRESS_POLICY_DENIED: only HTTPS is allowed");
  }
  if (url.username || url.password) {
    throw new Error("COVERED_EGRESS_POLICY_DENIED: URL credentials are not allowed");
  }
  if (url.port && url.port !== "443") {
    throw new Error("COVERED_EGRESS_POLICY_DENIED: only destination port 443 is allowed");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    host.length === 0 ||
    host.length > 253 ||
    host === "localhost" ||
    isIP(host) !== 0 ||
    !host.includes(".") ||
    DENIED_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw new Error("COVERED_EGRESS_POLICY_DENIED: target must be a public DNS hostname");
  }
  if (!/^[a-z0-9.-]+$/u.test(host) || host.includes("..")) {
    throw new Error("COVERED_EGRESS_POLICY_DENIED: target hostname is invalid");
  }
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
      throw new Error("COVERED_EGRESS_POLICY_DENIED: credential-like query parameters are not allowed");
    }
  }
  url.hash = "";
  return url;
}

export function assertCoveredContentType(value: string | undefined): string {
  const contentType = (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    contentType === "application/json" ||
    contentType.endsWith("+json") ||
    contentType.startsWith("text/")
  ) {
    return contentType;
  }
  throw new Error(
    `COVERED_EGRESS_CONTENT_DENIED: response type ${contentType || "unknown"} is not text or JSON`,
  );
}
