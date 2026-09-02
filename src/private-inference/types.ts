export type PrivateInferenceTrustMode = "reviewed_release" | "hardware";

export interface PrivateInferenceConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  modelAllowlist: readonly string[];
  trustMode: PrivateInferenceTrustMode;
  acceptedComposeHashes: readonly string[];
  acceptedSessionIds: readonly string[];
  requestTimeoutMs: number;
  maxInputChars: number;
  maxOutputTokens: number;
  maxResponseBytes: number;
}

export type PrivateInferencePhase =
  | "disabled"
  | "configured"
  | "verifying"
  | "ready"
  | "blocked"
  | "closed";

export interface PrivateInferenceStatus {
  contract: "org.agentboost.private-inference/0.1";
  status: PrivateInferencePhase;
  enabled: boolean;
  trust_mode: PrivateInferenceTrustMode;
  release_pinned: boolean;
  model?: string;
  available_models?: readonly string[];
  verified_at?: string;
  identity_expires_at?: string;
  compose_hash?: string;
  receipt_count: number;
  detail: string;
  direct_fallback: false;
}

export interface PrivateInferenceQueryInput {
  query: string;
  model?: string;
}

export interface PrivateInferenceResult {
  model: string;
  answer: string;
  receipt_id: string;
  receipt_verified: true;
  attestation_verified: true;
  release_pinned: boolean;
  direct_fallback: false;
  hides_origin_ip: false;
  primary_agent_saw_tool_arguments: true;
}

export type PolicyDecision = "allow" | "confirm" | "deny";

export interface DynamicPolicyInput {
  action: string;
  baseline: PolicyDecision;
  policy: string;
  facts: Record<string, unknown>;
}

export interface DynamicPolicyResult {
  baseline: PolicyDecision;
  model_decision?: PolicyDecision;
  effective_decision: PolicyDecision;
  reason: string;
  enforcement: "restrict_only";
  failed_closed: boolean;
  receipt_id?: string;
}

export interface PrivateInferencePort {
  capabilities(): Record<string, unknown>;
  status(): Promise<PrivateInferenceStatus>;
  query(input: PrivateInferenceQueryInput): Promise<PrivateInferenceResult>;
  evaluatePolicy(input: DynamicPolicyInput): Promise<DynamicPolicyResult>;
  close(): Promise<void>;
}
