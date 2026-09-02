export type CoveredEgressStatusName =
  | "disabled"
  | "not_installed"
  | "needs_enrollment"
  | "starting"
  | "ready"
  | "degraded"
  | "exhausted"
  | "failed";

export interface CoveredEgressStatus {
  status: CoveredEgressStatusName;
  code: string;
  detail: string;
}

export interface CoveredFetchInput {
  url: string;
  method?: "GET" | "HEAD";
}

export interface CoveredFetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  bytes: number;
  redirects: number;
  route: "shade-tree";
}

export interface CoveredEgressPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  capabilities(): Record<string, unknown>;
  status(): Promise<CoveredEgressStatus>;
  fetch(input: CoveredFetchInput): Promise<CoveredFetchResult>;
}
