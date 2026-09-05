import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_SCHEMA = "org.agentboost.hermes-turn-gate";
const STATE_VERSION = 1;
const TURN_MARKER_PATTERN = /^[0-9a-f]{64}\.json$/u;
const CONTINUATION_PATTERN = /^[0-9a-f]{64}\.pending\.json$/u;
const USER_DECISION_PATTERN = /^[0-9a-f]{64}\.decision\.json$/u;
const DEFERRED_TRANSFER_PATTERN = /^[0-9a-f]{64}\.transfer\.json$/u;
const PENDING_STATUS_READ_PATTERN = /^[0-9a-f]{64}\.status\.json$/u;
const PENDING_DISPATCH_STATUS_PATTERN = /^[0-9a-f]{64}\.dispatch-status\.json$/u;
const ROUTED_TRANSFER_PATTERN = /^[0-9a-f]{64}\.route\.json$/u;
const ALLOW_MODE_TRANSFER_PATTERN = /^[0-9a-f]{64}\.allow-transfer\.json$/u;
const ALLOW_MODE_TRANSFER_CLAIM_PATTERN = /^[0-9a-f]{64}\.allow-transfer-claim\.json$/u;
const SAVED_WALLET_SELECTION_PATTERN = /^[0-9a-f]{64}\.wallet-selection\.json$/u;
const ROUTED_WALLET_CHOICE_PATTERN = /^[0-9a-f]{64}\.wallet-choice\.json$/u;
const NESTED_FORK_TURN_PATTERN = /^[0-9a-f]{64}\.fork\.json$/u;
const ROOT_TURN_PATTERN = /^[0-9a-f]{64}\.root\.json$/u;
const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_RENDERED_RESPONSE_CHARS = 4_000;
const MAX_AUTHENTICATED_RENDERED_CHARS = 12_000;
const MAX_BINDING_ENTRIES = 12;
const MAX_BINDING_STRING_CHARS = 512;
const MANIFEST_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

interface JsonRecord {
  [key: string]: unknown;
}

interface TurnIdentity {
  sessionId: string;
  turnId: string;
}

type BindingValue = string | number | boolean;
type StableBinding = Record<string, BindingValue>;

interface Continuation {
  tool: ConfirmationTool;
  binding: StableBinding;
}

interface BoundaryPreview {
  renderedResponse?: string;
  continuation?: Continuation;
}

interface BoundaryMarker {
  schema: typeof STATE_SCHEMA;
  version: typeof STATE_VERSION;
  kind: "turn_boundary";
  created_at_ms: number;
  expires_at_ms: number;
  rendered_response?: string;
}

interface NestedForkTurnMarker {
  schema: typeof STATE_SCHEMA;
  version: typeof STATE_VERSION;
  kind: "nested_fork_turn";
  created_at_ms: number;
  expires_at_ms: number;
}

interface RootTurnMarker {
  schema: typeof STATE_SCHEMA;
  version: typeof STATE_VERSION;
  kind: "root_turn";
  created_at_ms: number;
  expires_at_ms: number;
}

interface PendingContinuation {
  schema: typeof STATE_SCHEMA;
  version: typeof STATE_VERSION;
  kind: "pending_continuation";
  created_at_ms: number;
  expires_at_ms: number;
  preview_turn_hash: string;
  tool: ConfirmationTool;
  binding: StableBinding;
}

interface UserDecisionMarker {
  schema: typeof STATE_SCHEMA;
  version: typeof STATE_VERSION;
  kind: "user_decision";
  created_at_ms: number;
  expires_at_ms: number;
  decision_turn_hash: string;
  preview_turn_hash: string;
  tool: ConfirmationTool;
  binding: StableBinding;
  user_confirmed: boolean;
}

type DeferredTransferMode = "regular" | "private" | "recovery";

interface DeferredTransfer {
  schema: typeof STATE_SCHEMA;
  version: typeof STATE_VERSION;
  kind: "deferred_transfer";
  created_at_ms: number;
  expires_at_ms: number;
  source_preview_turn_hash: string;
  stage: "source_switch" | "reauthorization";
  mode: DeferredTransferMode;
  source: string;
  source_private_balance?: string;
  destination: string;
  amount_native: string;
  reauthorization_decision_id?: string;
}

type StatusReadTool =
  | "onboarding_status"
  | "wallet_get_tree"
  | "wallet_get_private_balance_operation"
  | "wallet_get_private_transfer_request"
  | "wallet_get_recovery_request"
  | "wallet_get_regular_transfer_request";

interface PendingStatusRead {
  schema: typeof STATE_SCHEMA;
  version: typeof STATE_VERSION;
  kind: "pending_status_read";
  created_at_ms: number;
  expires_at_ms: number;
  result_turn_hash: string;
  state: "unresolved" | "terminal";
  tool: StatusReadTool;
  binding: StableBinding;
}

interface PendingDispatchStatus {
  schema: typeof STATE_SCHEMA;
  version: typeof STATE_VERSION;
  kind: "pending_dispatch_status";
  created_at_ms: number;
  expires_at_ms: number;
  dispatch_turn_hash: string;
  tool: StatusReadTool;
  binding: StableBinding;
  source_tool: ConfirmationTool | StatusReadTool;
  source_binding: StableBinding;
}

type RoutedTool =
  | "$clarify_private_balance_fund"
  | "$clarify_private_balance_policy"
  | "$clarify_status_followup"
  | "$clarify_wallet_graph_create"
  | "$clarify_wallet_policy"
  | StatusReadTool
  | "wallet_create"
  | "wallet_get_private_balance_policy"
  | "wallet_get_policy"
  | "wallet_get_tree"
  | "wallet_plan_policy_update"
  | "wallet_plan_reauthorization"
  | "wallet_preview_private_balance_create"
  | "wallet_preview_private_balance_fund"
  | "wallet_preview_private_balance_policy_update"
  | "wallet_preview_private_transfer"
  | "wallet_preview_recovery_transfer"
  | "wallet_preview_regular_transfer";

interface RoutedTransfer {
  schema: typeof STATE_SCHEMA;
  version: typeof STATE_VERSION;
  kind: "routed_transfer";
  created_at_ms: number;
  expires_at_ms: number;
  turn_hash: string;
  tool: RoutedTool;
  binding: StableBinding;
  arguments_pinned: boolean;
}

type TransferExecuteTool =
  | "wallet_execute_regular_transfer"
  | "wallet_execute_private_transfer"
  | "wallet_execute_recovery_transfer";

interface AllowModeTransferExecution {
  schema: typeof STATE_SCHEMA;
  version: typeof STATE_VERSION;
  kind: "allow_mode_transfer_execution";
  created_at_ms: number;
  expires_at_ms: number;
  preview_turn_hash: string;
  state: "active" | "consumed";
  tool: TransferExecuteTool;
  decision_id: string;
}

interface SavedWalletSelection {
  schema: typeof STATE_SCHEMA;
  version: typeof STATE_VERSION;
  kind: "saved_wallet_selection";
  created_at_ms: number;
  expires_at_ms: number;
  preview_turn_hash: string;
  wallet_names: string[];
}

interface RoutedSavedWalletChoice {
  schema: typeof STATE_SCHEMA;
  version: typeof STATE_VERSION;
  kind: "routed_saved_wallet_choice";
  created_at_ms: number;
  expires_at_ms: number;
  turn_hash: string;
  wallet_name: string;
}

export interface HermesTurnGateOptions {
  stateDirectory?: string;
  now?: () => number;
  ttlMs?: number;
  maxInputBytes?: number;
  /** @internal Observable seam used by deterministic storage-failure tests. */
  onStateTransition?: (
    stage: "pending_continuation_retired" | "boundary_published",
  ) => void | Promise<void>;
}

export interface HermesTurnGateIoOptions extends HermesTurnGateOptions {
  stdin?: AsyncIterable<unknown>;
  stdout?: { write(chunk: string): unknown };
}

export type HermesTurnGateResponse =
  | Record<string, never>
  | { action: "block"; message: string }
  | { action: "modify"; args: JsonRecord }
  | { context: string };

const CONFIRMATION_TOOLS = [
  "wallet_create",
  "wallet_adopt_existing",
  "wallet_apply_saved_profile_load",
  "wallet_archive",
  "wallet_start_new_demo",
  "wallet_apply_reauthorization",
  "wallet_apply_policy_update",
  "wallet_apply_private_balance_create",
  "wallet_apply_private_balance_fund",
  "wallet_apply_private_balance_policy_update",
  "wallet_execute_regular_transfer",
  "wallet_execute_private_transfer",
  "wallet_execute_recovery_transfer",
] as const;

type ConfirmationTool = (typeof CONFIRMATION_TOOLS)[number];

const CONFIRMATION_TOOL_SET = new Set<string>(CONFIRMATION_TOOLS);
const AGENT_BOOST_MCP_PREFIX = "mcp__agent_boost__";
const BOUNDARY_PRODUCER_TOOLS = new Set<string>([
  ...CONFIRMATION_TOOLS,
  "wallet_select",
  "wallet_switch_saved_profile",
  "wallet_reauthorize",
  "wallet_plan_policy_update",
  "wallet_plan_reauthorization",
  "wallet_preview_saved_profile_load",
  "wallet_preview_private_balance_create",
  "wallet_preview_private_balance_fund",
  "wallet_preview_private_balance_policy_update",
  "wallet_preview_regular_transfer",
  "wallet_plan_regular_transfer",
  "wallet_preview_private_transfer",
  "wallet_plan_private_payment",
  "wallet_preview_recovery_transfer",
  "wallet_plan_recovery_transfer",
  "wallet_get_tree",
]);

const STATUS_RESULT_PRODUCER_TOOLS = new Set<string>([
  "onboarding_start",
  "onboarding_status",
  "wallet_create",
  "wallet_adopt_existing",
  "wallet_preview_saved_profile_load",
  "wallet_apply_saved_profile_load",
  "wallet_switch_saved_profile",
  "wallet_select",
  "wallet_start_new_demo",
  "wallet_apply_private_balance_create",
  "wallet_apply_private_balance_fund",
  "wallet_apply_private_balance_policy_update",
  "wallet_get_private_balance_operation",
  "wallet_execute_regular_transfer",
  "wallet_get_regular_transfer_request",
  "wallet_execute_private_transfer",
  "wallet_execute_private_payment",
  "wallet_get_private_transfer_request",
  "wallet_get_private_payment_request",
  "wallet_get_request",
  "wallet_execute_recovery_transfer",
  "wallet_get_recovery_request",
  "wallet_get_tree",
]);

const STATUS_READ_TOOLS = new Set<StatusReadTool>([
  "onboarding_status",
  "wallet_get_tree",
  "wallet_get_private_balance_operation",
  "wallet_get_private_transfer_request",
  "wallet_get_recovery_request",
  "wallet_get_regular_transfer_request",
]);

function asRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hermesBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function hermesSafeInteger(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function positiveFiniteInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Hermes turn-gate limits must be positive safe integers");
  }
  return value;
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(`${STATE_SCHEMA}\0`, "utf8");
  for (const part of parts) {
    hash.update(part, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

export function hermesTurnGateStateDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  const override = nonEmptyString(environment.AGENT_BOOST_HERMES_TURN_GATE_DIR);
  if (override) return override;
  const hermesHome = nonEmptyString(environment.HERMES_HOME) ?? join(userHome, ".hermes");
  return join(hermesHome, "state", "agent-boost-turn-gate-v1");
}

function turnIdentity(payload: JsonRecord): TurnIdentity | undefined {
  const extra = asRecord(payload.extra);
  const sessionId = nonEmptyString(payload.session_id) ?? nonEmptyString(extra?.task_id);
  const turnId = nonEmptyString(extra?.turn_id);
  return sessionId && turnId ? { sessionId, turnId } : undefined;
}

function turnHash(identity: TurnIdentity): string {
  return digest(["turn", identity.sessionId, identity.turnId]);
}

function markerName(identity: TurnIdentity): string {
  return `${turnHash(identity)}.json`;
}

function continuationName(identity: TurnIdentity): string {
  return `${digest(["session", identity.sessionId])}.pending.json`;
}

function userDecisionName(identity: TurnIdentity): string {
  return `${turnHash(identity)}.decision.json`;
}

function deferredTransferName(identity: TurnIdentity): string {
  return `${digest(["session", identity.sessionId])}.transfer.json`;
}

function pendingStatusReadName(identity: TurnIdentity): string {
  return `${digest(["session", identity.sessionId])}.status.json`;
}

function pendingDispatchStatusName(identity: TurnIdentity): string {
  return `${digest(["session", identity.sessionId])}.dispatch-status.json`;
}

function routedTransferName(identity: TurnIdentity): string {
  return `${turnHash(identity)}.route.json`;
}

function allowModeTransferName(identity: TurnIdentity): string {
  return `${turnHash(identity)}.allow-transfer.json`;
}

function allowModeTransferClaimName(identity: TurnIdentity): string {
  return `${turnHash(identity)}.allow-transfer-claim.json`;
}

function savedWalletSelectionName(identity: TurnIdentity): string {
  return `${digest(["session", identity.sessionId])}.wallet-selection.json`;
}

function routedSavedWalletChoiceName(identity: TurnIdentity): string {
  return `${turnHash(identity)}.wallet-choice.json`;
}

function nestedForkTurnName(identity: TurnIdentity): string {
  return `${digest(["fork-turn", identity.sessionId, identity.turnId])}.fork.json`;
}

function rootTurnName(identity: TurnIdentity): string {
  return `${digest(["root-turn", identity.sessionId, identity.turnId])}.root.json`;
}

function canonicalToolName(value: unknown): ConfirmationTool | undefined {
  const rawTool = nonEmptyString(value);
  const tool = rawTool?.startsWith(AGENT_BOOST_MCP_PREFIX)
    ? rawTool.slice(AGENT_BOOST_MCP_PREFIX.length)
    : rawTool;
  const canonical = tool === "wallet_select" || tool === "wallet_switch_saved_profile"
    ? "wallet_apply_saved_profile_load"
      : tool === "wallet_reauthorize"
        ? "wallet_apply_reauthorization"
        : tool === "wallet_execute_private_payment"
          ? "wallet_execute_private_transfer"
          : tool;
  return canonical && CONFIRMATION_TOOL_SET.has(canonical)
    ? canonical as ConfirmationTool
    : undefined;
}

function canonicalStatusReadTool(value: unknown): StatusReadTool | undefined {
  const rawTool = nonEmptyString(value);
  const tool = rawTool?.startsWith(AGENT_BOOST_MCP_PREFIX)
    ? rawTool.slice(AGENT_BOOST_MCP_PREFIX.length)
    : rawTool;
  const canonical = tool === "wallet_get_private_payment_request" || tool === "wallet_get_request"
    ? "wallet_get_private_transfer_request"
    : tool;
  return canonical && STATUS_READ_TOOLS.has(canonical as StatusReadTool)
    ? canonical as StatusReadTool
    : undefined;
}

function transferDecisionId(
  tool: TransferExecuteTool,
  value: unknown,
): string | undefined {
  const decisionId = nonEmptyString(value);
  const prefix = tool === "wallet_execute_regular_transfer"
    ? "rwd"
    : tool === "wallet_execute_private_transfer"
      ? "wd"
      : "wr";
  return decisionId &&
      new RegExp(`^${prefix}_[A-Za-z0-9-]{8,128}$`, "u").test(decisionId)
    ? decisionId
    : undefined;
}

function stableBinding(value: unknown): StableBinding | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record);
  if (entries.length > MAX_BINDING_ENTRIES) return undefined;
  const binding: StableBinding = {};
  for (const [key, entry] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key)) return undefined;
    if (typeof entry === "string") {
      if (entry.length === 0 || entry.length > MAX_BINDING_STRING_CHARS) return undefined;
      binding[key] = entry;
      continue;
    }
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry)) return undefined;
      binding[key] = entry;
      continue;
    }
    if (typeof entry === "boolean") {
      binding[key] = entry;
      continue;
    }
    return undefined;
  }
  return binding;
}

function walletNameBinding(record: JsonRecord): string | undefined {
  return nonEmptyString(record.wallet_name) ??
    nonEmptyString(record.name) ??
    nonEmptyString(record.wallet_id);
}

function continuationActiveWalletBinding(
  record: JsonRecord,
): StableBinding | undefined {
  const expectedName = nonEmptyString(record.expected_active_wallet_name);
  const expectedEpoch = record.expected_active_selection_epoch;
  if (
    !expectedName ||
    typeof expectedEpoch !== "number" ||
    !Number.isSafeInteger(expectedEpoch)
  ) {
    return undefined;
  }
  return {
    expected_active_wallet_name: expectedName,
    expected_active_selection_epoch: expectedEpoch,
  };
}

function invocationActiveWalletBinding(
  record: JsonRecord,
): StableBinding | undefined {
  const expectedName = nonEmptyString(record.expected_active_wallet_name);
  const expectedEpoch = hermesSafeInteger(record.expected_active_selection_epoch);
  if (!expectedName || expectedEpoch === undefined) return undefined;
  return {
    expected_active_wallet_name: expectedName,
    expected_active_selection_epoch: expectedEpoch,
  };
}

function normalizeContinuationBinding(
  tool: ConfirmationTool,
  rawBinding: unknown,
): StableBinding | undefined {
  const raw = stableBinding(rawBinding);
  if (!raw) return undefined;
  if (
    tool === "wallet_apply_reauthorization" ||
    tool === "wallet_apply_policy_update" ||
    tool === "wallet_apply_private_balance_create" ||
    tool === "wallet_apply_private_balance_fund" ||
    tool === "wallet_apply_private_balance_policy_update" ||
    tool === "wallet_execute_regular_transfer" ||
    tool === "wallet_execute_private_transfer" ||
    tool === "wallet_execute_recovery_transfer"
  ) {
    const decisionId = nonEmptyString(raw.decision_id);
    return decisionId ? { decision_id: decisionId } : undefined;
  }

  const activeBinding = continuationActiveWalletBinding(raw);
  if (tool === "wallet_start_new_demo") return activeBinding;

  const walletName = walletNameBinding(raw);
  if (!walletName) return undefined;
  if (tool === "wallet_archive") return { wallet_name: walletName };
  if (activeBinding === undefined) {
    return undefined;
  }
  if (tool === "wallet_create" || tool === "wallet_adopt_existing") {
    return {
      name: walletName,
      ...activeBinding,
    };
  }
  return {
    wallet_name: walletName,
    ...activeBinding,
  };
}

function parseContinuation(value: unknown): Continuation | undefined {
  const record = asRecord(value);
  const tool = canonicalToolName(record?.tool);
  if (!record || !tool) return undefined;
  const binding = normalizeContinuationBinding(tool, record.binding);
  return binding ? { tool, binding } : undefined;
}

function decisionContinuation(
  tool: ConfirmationTool,
  data: JsonRecord,
): Continuation | undefined {
  const plan = asRecord(data.plan);
  const decisionId = nonEmptyString(plan?.decisionId) ?? nonEmptyString(plan?.decision_id);
  return decisionId ? { tool, binding: { decision_id: decisionId } } : undefined;
}

function inferredContinuation(envelopeValue: unknown): Continuation | undefined {
  const envelope = asRecord(envelopeValue);
  const code = nonEmptyString(envelope?.code);
  if (!envelope || !code) return undefined;
  const data = asRecord(envelope.data) ?? {};
  if (data.reason !== undefined) return undefined;

  if (code === "POLICY_UPDATE_PLANNED" || code === "POLICY_UPDATE_CONFIRMATION_REQUIRED") {
    return decisionContinuation("wallet_apply_policy_update", data);
  }
  if (
    code === "PRIVATE_BALANCE_CREATE_PLANNED" ||
    code === "PRIVATE_BALANCE_CREATE_CONFIRMATION_REQUIRED"
  ) {
    return decisionContinuation("wallet_apply_private_balance_create", data);
  }
  if (
    code === "PRIVATE_BALANCE_FUNDING_PLANNED" ||
    code === "PRIVATE_BALANCE_FUNDING_CONFIRMATION_REQUIRED"
  ) {
    return decisionContinuation("wallet_apply_private_balance_fund", data);
  }
  if (
    code === "PRIVATE_BALANCE_POLICY_UPDATE_PLANNED" ||
    code === "PRIVATE_BALANCE_POLICY_UPDATE_CONFIRMATION_REQUIRED"
  ) {
    return decisionContinuation("wallet_apply_private_balance_policy_update", data);
  }
  if (
    code === "WALLET_REAUTHORIZATION_PLANNED" ||
    code === "WALLET_REAUTHORIZATION_CONFIRMATION_REQUIRED"
  ) {
    return decisionContinuation("wallet_apply_reauthorization", data);
  }
  if (code === "REGULAR_TRANSFER_PLANNED" || code === "REGULAR_TRANSFER_CONFIRMATION_REQUIRED") {
    return decisionContinuation("wallet_execute_regular_transfer", data);
  }
  if (code === "PAYMENT_PLANNED" || code === "PAYMENT_CONFIRMATION_REQUIRED") {
    return decisionContinuation("wallet_execute_private_transfer", data);
  }
  if (code === "RECOVERY_PLANNED" || code === "RECOVERY_CONFIRMATION_REQUIRED") {
    return decisionContinuation("wallet_execute_recovery_transfer", data);
  }

  if (code.endsWith("_SOURCE_SWITCH_REQUIRED")) {
    return parseContinuation({
      tool: "wallet_apply_saved_profile_load",
      binding: {
        wallet_name: data.source_wallet_name,
        expected_active_wallet_name: data.expected_active_wallet_name,
        expected_active_selection_epoch: data.expected_active_selection_epoch,
      },
    });
  }
  if (code === "WALLET_CREATE_CONFIRMATION_REQUIRED") {
    return parseContinuation({ tool: "wallet_create", binding: data });
  }
  if (code === "WALLET_ADOPT_CONFIRMATION_REQUIRED") {
    return parseContinuation({ tool: "wallet_adopt_existing", binding: data });
  }
  if (code === "WALLET_SELECT_CONFIRMATION_REQUIRED") {
    return parseContinuation({ tool: "wallet_apply_saved_profile_load", binding: data });
  }
  if (code === "WALLET_ARCHIVE_CONFIRMATION_REQUIRED") {
    return parseContinuation({ tool: "wallet_archive", binding: data });
  }
  if (code === "DEMO_RESET_CONFIRMATION_REQUIRED") {
    return parseContinuation({ tool: "wallet_start_new_demo", binding: data });
  }
  return undefined;
}

function responseText(record: JsonRecord): string | undefined {
  const meta = asRecord(record._meta);
  const explicitControl = asRecord(meta?.["org.agentboost/turn-control"]);
  const explicit = nonEmptyString(explicitControl?.rendered_response);
  if (explicit) return explicit.slice(0, MAX_RENDERED_RESPONSE_CHARS);
  const userFacing = asRecord(meta?.["org.agentboost/user-facing-output"]);
  const authoritative = userFacing?.schema_version === 1 && userFacing.mode === "replace"
    ? nonEmptyString(userFacing.rendered_response)
    : undefined;
  if (authoritative) return authoritative.slice(0, MAX_RENDERED_RESPONSE_CHARS);

  const content = Array.isArray(record.content) ? record.content : [];
  for (const entry of content) {
    const text = nonEmptyString(asRecord(entry)?.text);
    if (text) return text.slice(0, MAX_RENDERED_RESPONSE_CHARS);
  }
  const rendered = nonEmptyString(record.result);
  if (!rendered || rendered.startsWith("{") || rendered.startsWith("[")) return undefined;
  return rendered.slice(0, MAX_RENDERED_RESPONSE_CHARS);
}

function topLevelToolResult(value: unknown): JsonRecord | undefined {
  // Hermes gives post-tool hooks the tool's final result. MCP results are one
  // JSON string whose top-level object contains `result`, `structuredContent`,
  // and `_meta`. Never recurse into `result` or content: those fields may hold
  // untrusted fetched text which can look exactly like Agent Boost metadata.
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function modelContextEnvelope(record: JsonRecord): JsonRecord | undefined {
  const meta = asRecord(record._meta);
  const modelContext = asRecord(meta?.["org.agentboost/model-context"]);
  return modelContext?.schema === "org.agentboost.tool-result" &&
      modelContext.schema_version === "1.0"
    ? modelContext
    : undefined;
}

function boundaryPreviewFromResult(value: unknown): BoundaryPreview | undefined {
  const record = topLevelToolResult(value);
  if (!record) return undefined;
  const meta = asRecord(record._meta);
  const turnControl = asRecord(meta?.["org.agentboost/turn-control"]);
  const explicitBoundary = turnControl?.schema_version === 1 &&
    turnControl.boundary === "new_user_turn";
  const legacyBoundary = turnControl?.action === "end_turn";
  const modelContext = asRecord(meta?.["org.agentboost/model-context"]);
  const modelBoundary = modelContext?.response_mode === "preview_then_stop";
  if (explicitBoundary || legacyBoundary || modelBoundary) {
    const explicitContinuation = explicitBoundary
      ? parseContinuation(turnControl.continuation)
      : undefined;
    const continuation = explicitContinuation ??
      inferredContinuation(record.structuredContent) ??
      inferredContinuation(modelContext) ??
      inferredContinuation(record);
    const renderedResponse = responseText(record);
    return {
      ...(renderedResponse === undefined ? {} : { renderedResponse }),
      ...(continuation === undefined ? {} : { continuation }),
    };
  }
  return undefined;
}

function savedWalletSelectionFromResult(record: JsonRecord): string[] | undefined {
  const envelope = modelContextEnvelope(record);
  if (envelope?.code !== "WALLET_PROFILE_SELECTION_REQUIRED") return undefined;
  const names = asRecord(envelope.data)?.wallet_names;
  if (!Array.isArray(names)) return undefined;
  const selection = parseSavedWalletSelection({
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "saved_wallet_selection",
    created_at_ms: 0,
    expires_at_ms: 1,
    preview_turn_hash: "0".repeat(64),
    wallet_names: names,
  });
  return selection?.wallet_names;
}

interface StatusReadTarget {
  tool: StatusReadTool;
  binding: StableBinding;
}

interface StatusObservation {
  state: "unresolved" | "terminal";
  target: StatusReadTarget;
  decisionId?: string;
  releaseRoute?: true;
}

function statusResultCodeAllowed(producerTool: string, code: string): boolean {
  if (producerTool === "onboarding_start") return code === "ONBOARDING_STARTED";
  if (producerTool === "onboarding_status") return code === "ONBOARDING_STATUS";
  if (producerTool === "wallet_get_tree") return code === "WALLET_TREE";
  if (producerTool === "wallet_start_new_demo") return code === "DEMO_RESET_STARTED";
  if (producerTool === "wallet_create") return code === "WALLET_CREATED";
  if (producerTool === "wallet_adopt_existing") return code === "WALLET_ADOPTED";
  if (
    producerTool === "wallet_preview_saved_profile_load" ||
    producerTool === "wallet_apply_saved_profile_load" ||
    producerTool === "wallet_switch_saved_profile" ||
    producerTool === "wallet_select"
  ) {
    return code === "WALLET_SELECTED";
  }
  if (producerTool === "wallet_apply_private_balance_create") {
    return code === "PRIVATE_BALANCE_CREATE_STATUS";
  }
  if (producerTool === "wallet_apply_private_balance_fund") {
    return code === "PRIVATE_BALANCE_FUNDING_STATUS";
  }
  if (producerTool === "wallet_apply_private_balance_policy_update") {
    return code === "PRIVATE_BALANCE_POLICY_UPDATED";
  }
  if (producerTool === "wallet_get_private_balance_operation") {
    return code === "PRIVATE_BALANCE_OPERATION_STATUS";
  }
  if (producerTool === "wallet_execute_regular_transfer") {
    return code === "REGULAR_TRANSFER_REQUEST" || code === "REGULAR_TRANSFER_STATUS";
  }
  if (producerTool === "wallet_get_regular_transfer_request") {
    return code === "REGULAR_TRANSFER_STATUS";
  }
  if (
    producerTool === "wallet_execute_private_transfer" ||
    producerTool === "wallet_execute_private_payment"
  ) {
    return code === "PAYMENT_REQUEST" || code === "PAYMENT_STATUS";
  }
  if (
    producerTool === "wallet_get_private_transfer_request" ||
    producerTool === "wallet_get_private_payment_request" ||
    producerTool === "wallet_get_request"
  ) {
    return code === "PAYMENT_STATUS";
  }
  if (producerTool === "wallet_execute_recovery_transfer") {
    return code === "RECOVERY_REQUEST" || code === "RECOVERY_STATUS";
  }
  return producerTool === "wallet_get_recovery_request" && code === "RECOVERY_STATUS";
}

function statusReadTarget(
  tool: StatusReadTool,
  binding: StableBinding,
): StatusReadTarget | undefined {
  const validated = routedBinding(tool, binding, true);
  return validated ? { tool, binding: validated } : undefined;
}

function timeoutRecoveryStatusTarget(
  tool: ConfirmationTool,
  binding: StableBinding,
): StatusReadTarget | undefined {
  if (
    tool === "wallet_create" ||
    tool === "wallet_adopt_existing" ||
    tool === "wallet_apply_saved_profile_load" ||
    tool === "wallet_archive" ||
    tool === "wallet_start_new_demo" ||
    tool === "wallet_apply_reauthorization" ||
    tool === "wallet_apply_policy_update"
  ) {
    // These effects do not expose a durable request handle before dispatch.
    // The wallet tree is the authoritative, ID-free reconciliation read for
    // existence, active selection, policy, archive, and authorization state.
    return statusReadTarget("wallet_get_tree", {});
  }
  const decisionId = nonEmptyString(binding.decision_id);
  if (!decisionId) return undefined;
  if (
    tool === "wallet_apply_private_balance_create" ||
    tool === "wallet_apply_private_balance_fund" ||
    tool === "wallet_apply_private_balance_policy_update"
  ) {
    return statusReadTarget("wallet_get_private_balance_operation", {
      decision_id: decisionId,
    });
  }
  if (tool === "wallet_execute_regular_transfer") {
    return statusReadTarget("wallet_get_regular_transfer_request", {
      decision_id: decisionId,
    });
  }
  if (tool === "wallet_execute_private_transfer") {
    return statusReadTarget("wallet_get_private_transfer_request", {
      decision_id: decisionId,
    });
  }
  if (tool === "wallet_execute_recovery_transfer") {
    return statusReadTarget("wallet_get_recovery_request", {
      decision_id: decisionId,
    });
  }
  return undefined;
}

function statusObservationFromResult(
  record: JsonRecord,
  producerTool: string,
): StatusObservation | undefined {
  const envelope = modelContextEnvelope(record);
  const code = nonEmptyString(envelope?.code);
  if (!code || !statusResultCodeAllowed(producerTool, code)) return undefined;
  const data = asRecord(envelope?.data);
  if (!data) return undefined;

  if (
    code === "ONBOARDING_STARTED" ||
    code === "ONBOARDING_STATUS" ||
    code === "DEMO_RESET_STARTED" ||
    code === "WALLET_CREATED" ||
    code === "WALLET_ADOPTED" ||
    code === "WALLET_SELECTED"
  ) {
    const setup = asRecord(data.setup);
    const setupId = nonEmptyString(setup?.setupId);
    const revision = setup?.revision;
    const phase = nonEmptyString(setup?.phase);
    const target = setupId && typeof revision === "number" &&
        Number.isSafeInteger(revision) && revision >= 0
      ? statusReadTarget("onboarding_status", {
          setup_id: setupId,
          since_revision: revision,
          wait_ms: 30_000,
        })
      : undefined;
    if (!target || !phase) return undefined;
    if (phase === "private_ready") {
      // Keep the read-only setup handle resumable for its bounded TTL even
      // after readiness. The native output guard still requires the current
      // turn to finish capabilities -> wallet tree, but a host interruption
      // between those reads must not strand the next explicit "check again"
      // with no trusted setup identity. A later unrelated unresolved subject
      // replaces this handle, and expiry retires it automatically.
      return { state: "unresolved", target, releaseRoute: true };
    }
    if (phase === "failed") {
      return { state: "terminal", target };
    }
    if ([
      "not_started",
      "creating_wallet",
      "preparing_privacy",
      "awaiting_funding",
      "funding_pending",
      "funded_public",
      "shielding",
    ].includes(phase)) {
      return { state: "unresolved", target };
    }
    return undefined;
  }

  const request = asRecord(data.request);
  const requestId = nonEmptyString(request?.requestId);
  const decisionId = nonEmptyString(request?.decisionId);
  const phase = nonEmptyString(request?.phase);
  if (!requestId || !phase) return undefined;

  let tool: StatusReadTool;
  let unresolved: readonly string[];
  let terminal: readonly string[];
  if (code === "REGULAR_TRANSFER_REQUEST" || code === "REGULAR_TRANSFER_STATUS") {
    tool = "wallet_get_regular_transfer_request";
    unresolved = ["executing", "submitted", "indeterminate"];
    terminal = ["confirmed", "failed"];
  } else if (code === "PAYMENT_REQUEST" || code === "PAYMENT_STATUS") {
    tool = "wallet_get_private_transfer_request";
    unresolved = ["executing", "submitted", "indeterminate"];
    terminal = ["confirmed", "failed"];
  } else if (code === "RECOVERY_REQUEST" || code === "RECOVERY_STATUS") {
    tool = "wallet_get_recovery_request";
    unresolved = ["executing", "submitted", "indeterminate"];
    terminal = ["confirmed", "failed"];
  } else if (code === "PRIVATE_BALANCE_CREATE_STATUS") {
    tool = "wallet_get_private_balance_operation";
    unresolved = ["creating", "indeterminate"];
    terminal = ["created", "failed"];
  } else if (code === "PRIVATE_BALANCE_FUNDING_STATUS") {
    tool = "wallet_get_private_balance_operation";
    unresolved = ["executing", "submitted", "indeterminate"];
    terminal = ["confirmed", "failed"];
  } else if (code === "PRIVATE_BALANCE_POLICY_UPDATED") {
    tool = "wallet_get_private_balance_operation";
    unresolved = ["applying"];
    terminal = ["applied", "failed"];
  } else {
    tool = "wallet_get_private_balance_operation";
    if (requestId.startsWith("pbcr_")) {
      unresolved = ["creating", "indeterminate"];
      terminal = ["created", "failed"];
    } else if (requestId.startsWith("pbfr_")) {
      unresolved = ["executing", "submitted", "indeterminate"];
      terminal = ["confirmed", "failed"];
    } else if (requestId.startsWith("pbpr_")) {
      unresolved = ["applying"];
      terminal = ["applied", "failed"];
    } else {
      return undefined;
    }
  }
  const target = statusReadTarget(tool, { request_id: requestId });
  if (!target) return undefined;
  if (terminal.includes(phase)) {
    return { state: "terminal", target, ...(decisionId ? { decisionId } : {}) };
  }
  return unresolved.includes(phase)
    ? { state: "unresolved", target, ...(decisionId ? { decisionId } : {}) }
    : undefined;
}

function sameStatusSubject(
  left: StatusReadTarget,
  right: { tool: StatusReadTool; binding: StableBinding },
  leftDecisionId?: string,
): boolean {
  if (left.tool !== right.tool) return false;
  if (left.tool === "wallet_get_tree") return true;
  if (left.tool === "onboarding_status") {
    return left.binding.setup_id === right.binding.setup_id;
  }
  const leftRequestId = nonEmptyString(left.binding.request_id);
  const rightRequestId = nonEmptyString(right.binding.request_id);
  if (leftRequestId && rightRequestId) return leftRequestId === rightRequestId;
  const leftDecision = nonEmptyString(left.binding.decision_id) ?? leftDecisionId;
  const rightDecision = nonEmptyString(right.binding.decision_id);
  return Boolean(leftDecision && rightDecision && leftDecision === rightDecision);
}

function statusObservationMatchesInvocation(
  observation: StatusObservation,
  producerTool: string,
  invocation: ToolInvocation | undefined,
): boolean {
  const effectTool = canonicalToolName(producerTool);
  if (
    effectTool === "wallet_apply_private_balance_create" ||
    effectTool === "wallet_apply_private_balance_fund" ||
    effectTool === "wallet_apply_private_balance_policy_update" ||
    effectTool === "wallet_execute_regular_transfer" ||
    effectTool === "wallet_execute_private_transfer" ||
    effectTool === "wallet_execute_recovery_transfer"
  ) {
    // An effect result is authoritative only for the exact decision invoked
    // at the trusted boundary. A signed-but-mismatched result must never
    // replace or retire another operation's recovery handle.
    const invokedDecisionId = nonEmptyString(invocation?.input.decision_id);
    return Boolean(
      invocation && invokedDecisionId && observation.decisionId === invokedDecisionId,
    );
  }
  const requestGetter = producerTool === "wallet_get_private_balance_operation" ||
    producerTool === "wallet_get_regular_transfer_request" ||
    producerTool === "wallet_get_private_transfer_request" ||
    producerTool === "wallet_get_private_payment_request" ||
    producerTool === "wallet_get_request" ||
    producerTool === "wallet_get_recovery_request";
  if (!requestGetter && producerTool !== "onboarding_status") return true;
  if (!invocation) return false;
  if (producerTool === "onboarding_status") {
    const setupId = nonEmptyString(invocation.input.setup_id);
    const sinceRevision = invocation.input.since_revision;
    const resultRevision = observation.target.binding.since_revision;
    return setupId === observation.target.binding.setup_id &&
      (sinceRevision === undefined || (
        typeof sinceRevision === "number" &&
        Number.isSafeInteger(sinceRevision) &&
        sinceRevision >= 0 &&
        typeof resultRevision === "number" &&
        resultRevision >= sinceRevision
      ));
  }
  const requestId = nonEmptyString(invocation.input.request_id);
  const decisionId = nonEmptyString(invocation.input.decision_id);
  return requestId !== undefined && decisionId === undefined
    ? requestId === observation.target.binding.request_id
    : decisionId !== undefined && requestId === undefined
      ? decisionId === observation.decisionId
      : false;
}

function sameJsonValue(left: unknown, right: unknown, depth = 0): boolean {
  if (left === right) return true;
  if (depth >= 32 || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameJsonValue(entry, right[index], depth + 1));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] &&
      sameJsonValue(leftRecord[key], rightRecord[key], depth + 1)
    );
}

function authenticatedAgentBoostEnvelope(
  record: JsonRecord,
): { code: string; outcome: string; data: JsonRecord } | undefined {
  const structured = asRecord(record.structuredContent);
  const context = modelContextEnvelope(record);
  const structuredCode = nonEmptyString(structured?.code);
  const contextCode = nonEmptyString(context?.code);
  const structuredOutcome = nonEmptyString(structured?.outcome);
  const contextOutcome = nonEmptyString(context?.outcome);
  const structuredDigest = nonEmptyString(structured?.manifest_digest);
  const contextDigest = nonEmptyString(context?.manifest_digest);
  const structuredData = asRecord(structured?.data);
  const contextData = asRecord(context?.data);
  if (
    structured?.schema !== "org.agentboost.tool-result" ||
    structured.schema_version !== "1.0" ||
    !structuredCode ||
    structuredCode !== contextCode ||
    !structuredOutcome ||
    structuredOutcome !== contextOutcome ||
    !structuredDigest ||
    structuredDigest !== contextDigest ||
    !MANIFEST_DIGEST_PATTERN.test(structuredDigest) ||
    !structuredData ||
    !contextData ||
    !sameJsonValue(structuredData, contextData)
  ) {
    return undefined;
  }
  return { code: structuredCode, outcome: structuredOutcome, data: structuredData };
}

function noEffectResultCodeAllowed(tool: ConfirmationTool, code: string): boolean {
  if (code === "REQUEST_BLOCKED") return true;
  if (tool === "wallet_create") {
    return code === "WALLET_CREATE_CONFIRMATION_REQUIRED" ||
      code === "WALLET_LIFECYCLE_BINDING_REQUIRED" ||
      code === "WALLET_LIFECYCLE_PREVIEW_STALE";
  }
  if (tool === "wallet_adopt_existing") {
    return code === "WALLET_ADOPT_CONFIRMATION_REQUIRED" ||
      code === "WALLET_LIFECYCLE_BINDING_REQUIRED" ||
      code === "WALLET_LIFECYCLE_PREVIEW_STALE";
  }
  if (tool === "wallet_apply_saved_profile_load") {
    return code === "WALLET_SELECT_CONFIRMATION_REQUIRED" ||
      code === "WALLET_SWITCH_BINDING_REQUIRED" ||
      code === "WALLET_SWITCH_PREVIEW_STALE" ||
      code === "WALLET_PROFILE_REFERENCE_CONFLICT" ||
      code === "WALLET_PROFILE_NOT_FOUND" ||
      code === "WALLET_PROFILE_AMBIGUOUS" ||
      code === "WALLET_PROFILE_SELECTION_REQUIRED";
  }
  if (tool === "wallet_archive") {
    return code === "WALLET_ARCHIVE_CONFIRMATION_REQUIRED" ||
      code === "WALLET_PROFILE_REFERENCE_CONFLICT" ||
      code === "WALLET_PROFILE_NOT_FOUND" ||
      code === "WALLET_PROFILE_AMBIGUOUS";
  }
  if (tool === "wallet_start_new_demo") {
    return code === "DEMO_RESET_CONFIRMATION_REQUIRED" ||
      code === "WALLET_LIFECYCLE_BINDING_REQUIRED" ||
      code === "WALLET_LIFECYCLE_PREVIEW_STALE";
  }
  if (tool === "wallet_apply_reauthorization") {
    return code === "WALLET_REAUTHORIZATION_CONFIRMATION_REQUIRED" ||
      code === "WALLET_REAUTHORIZATION_DENIED";
  }
  if (tool === "wallet_apply_policy_update") {
    return code === "POLICY_UPDATE_CONFIRMATION_REQUIRED" ||
      code === "POLICY_UPDATE_CANCELLED" ||
      code === "POLICY_UPDATE_DENIED";
  }
  if (tool === "wallet_apply_private_balance_create") {
    return code === "PRIVATE_BALANCE_CREATE_CONFIRMATION_REQUIRED" ||
      code === "PRIVATE_BALANCE_CREATE_CANCELLED" ||
      code === "PRIVATE_BALANCE_CREATE_DENIED";
  }
  if (tool === "wallet_apply_private_balance_fund") {
    return code === "PRIVATE_BALANCE_FUNDING_CONFIRMATION_REQUIRED" ||
      code === "PRIVATE_BALANCE_FUNDING_CANCELLED" ||
      code === "PRIVATE_BALANCE_FUNDING_DENIED";
  }
  if (tool === "wallet_apply_private_balance_policy_update") {
    return code === "PRIVATE_BALANCE_POLICY_UPDATE_CONFIRMATION_REQUIRED" ||
      code === "PRIVATE_BALANCE_POLICY_UPDATE_CANCELLED" ||
      code === "PRIVATE_BALANCE_POLICY_UPDATE_DENIED";
  }
  if (tool === "wallet_execute_regular_transfer") {
    return code === "REGULAR_TRANSFER_CONFIRMATION_REQUIRED" ||
      code === "REGULAR_TRANSFER_CANCELLED" ||
      code === "REGULAR_TRANSFER_DENIED";
  }
  if (tool === "wallet_execute_private_transfer") {
    return code === "PAYMENT_CONFIRMATION_REQUIRED" ||
      code === "PAYMENT_CANCELLED" ||
      code === "PAYMENT_DENIED";
  }
  return code === "RECOVERY_CONFIRMATION_REQUIRED" ||
    code === "RECOVERY_CANCELLED" ||
    code === "RECOVERY_DENIED";
}

function authenticatedNoEffectResult(
  record: JsonRecord | undefined,
  producerTool: string | undefined,
): boolean {
  if (!record || !producerTool) return false;
  const tool = canonicalToolName(producerTool);
  const envelope = authenticatedAgentBoostEnvelope(record);
  if (
    !tool ||
    !envelope ||
    envelope.outcome !== "blocked" ||
    !noEffectResultCodeAllowed(tool, envelope.code) ||
    "request" in envelope.data ||
    "setup" in envelope.data ||
    "receipt" in envelope.data ||
    envelope.data.applied === true ||
    envelope.data.changed === true
  ) {
    return false;
  }
  return envelope.code !== "REQUEST_BLOCKED" ||
    nonEmptyString(envelope.data.message) !== undefined;
}

function authenticatedWalletTreeResult(record: JsonRecord | undefined): boolean {
  if (!record) return false;
  const structured = asRecord(record.structuredContent);
  const structuredData = asRecord(structured?.data);
  const rendered = nonEmptyString(structuredData?.rendered);
  const manifestDigest = nonEmptyString(structured?.manifest_digest);
  const meta = asRecord(record._meta);
  const context = asRecord(meta?.["org.agentboost/model-context"]);
  const control = asRecord(meta?.["org.agentboost/turn-control"]);
  const output = asRecord(meta?.["org.agentboost/user-facing-output"]);
  return Boolean(
    structured?.schema === "org.agentboost.tool-result" &&
    structured.schema_version === "1.0" &&
    structured.outcome === "ready" &&
    structured.code === "WALLET_TREE" &&
    manifestDigest &&
    MANIFEST_DIGEST_PATTERN.test(manifestDigest) &&
    rendered &&
    rendered.length <= MAX_AUTHENTICATED_RENDERED_CHARS &&
    context?.response_mode === "verbatim" &&
    context.rendered === rendered &&
    control?.schema_version === 1 &&
    control.boundary === "new_user_turn" &&
    control.rendered_response === rendered &&
    output?.schema_version === 1 &&
    output.mode === "replace" &&
    output.rendered_response === rendered
  );
}

function dispatchMatchesInvocation(
  dispatch: PendingDispatchStatus,
  producerTool: string | undefined,
  invocation: ToolInvocation | undefined,
): boolean {
  if (!producerTool || !invocation) return false;
  const confirmationTool = canonicalToolName(producerTool);
  if (confirmationTool) {
    const binding = invocationBinding(confirmationTool, invocation.input);
    return dispatch.source_tool === confirmationTool && Boolean(
      binding && sameBinding(dispatch.source_binding, binding),
    );
  }
  const sourceTool = canonicalStatusReadTool(producerTool);
  if (!sourceTool) return false;
  const binding = routedBinding(sourceTool, invocation.input, true);
  return dispatch.source_tool === sourceTool && Boolean(
    binding && sameBinding(dispatch.source_binding, binding),
  );
}

function dispatchMatchesExactInvocation(
  dispatch: PendingDispatchStatus,
  identity: TurnIdentity,
  producerTool: string | undefined,
  invocation: ToolInvocation | undefined,
): boolean {
  return dispatch.dispatch_turn_hash === turnHash(identity) &&
    dispatchMatchesInvocation(dispatch, producerTool, invocation);
}

async function statusObservationHasCurrentProvenance(
  stateDirectory: string,
  identity: TurnIdentity,
  observation: StatusObservation,
  producerTool: string,
  invocation: ToolInvocation | undefined,
  now: number,
): Promise<boolean> {
  const mayEstablishFreshHandle = producerTool === "onboarding_start" ||
    producerTool === "wallet_preview_saved_profile_load";
  const pendingDispatch = await readPendingDispatchStatus(stateDirectory, identity, now);
  if (pendingDispatch.status === "invalid") return false;
  if (pendingDispatch.status === "active") {
    // Dispatch is the newest lifecycle phase and deliberately shadows any
    // older result marker. Only its exact subject may advance it.
    return dispatchMatchesInvocation(pendingDispatch.value, producerTool, invocation) ||
      sameStatusSubject(
      observation.target,
      pendingDispatch.value,
      observation.decisionId,
    );
  }

  const pendingStatus = await readPendingStatusRead(stateDirectory, identity, now);
  if (pendingStatus.status === "invalid") return false;
  if (pendingStatus.status === "active") {
    const sameSubject = sameStatusSubject(
      observation.target,
      pendingStatus.value,
      observation.decisionId,
    );
    if (!sameSubject) {
      // Status reads require a pre-tool dispatch marker, so a delayed older
      // read cannot win. A small set of trusted first-handle producers cannot
      // know their setup ID until the result and may establish the new subject.
      return mayEstablishFreshHandle;
    }
    // A terminal tombstone is monotonic for its subject. A duplicated or
    // out-of-order unresolved result cannot resurrect it.
    return pendingStatus.value.state !== "terminal" || observation.state === "terminal";
  }

  // A fresh read result may establish the first handle. Effect results may
  // not: every recoverable effect is staged in pre_tool before it can run.
  return mayEstablishFreshHandle;
}

function deferredTransferFromSourceSwitch(
  record: JsonRecord,
  invocation: ToolInvocation | undefined,
  trustedTool: string | undefined,
  identity: TurnIdentity,
  now: number,
  ttlMs: number,
): DeferredTransfer | undefined {
  const envelope = modelContextEnvelope(record);
  const code = nonEmptyString(envelope?.code);
  const mode: DeferredTransferMode | undefined =
    code === "REGULAR_TRANSFER_SOURCE_SWITCH_REQUIRED"
      ? "regular"
      : code === "PRIVATE_PAYMENT_SOURCE_SWITCH_REQUIRED"
        ? "private"
        : code === "RECOVERY_TRANSFER_SOURCE_SWITCH_REQUIRED"
          ? "recovery"
          : undefined;
  const data = asRecord(envelope?.data);
  const source = deferredReference(data?.source_wallet_name);
  const resultPrivateBalanceRaw =
    data?.source_private_balance ?? data?.source_private_balance_name;
  const invocationPrivateBalanceRaw = trustedTool === "wallet_preview_regular_transfer"
    ? invocation?.input.source_private_balance
    : trustedTool === "wallet_plan_regular_transfer"
      ? invocation?.input.source_private_balance_name
      : undefined;
  const normalizePrivateBalance = (value: unknown): string | undefined =>
    value === "$main" || value === "$default" || value === undefined
      ? undefined
      : privateBalanceReference(value);
  const resultPrivateBalance = normalizePrivateBalance(resultPrivateBalanceRaw);
  const invocationPrivateBalance = normalizePrivateBalance(invocationPrivateBalanceRaw);
  if (
    (resultPrivateBalanceRaw !== undefined &&
      resultPrivateBalanceRaw !== "$main" &&
      resultPrivateBalanceRaw !== "$default" &&
      resultPrivateBalance === undefined) ||
    (invocationPrivateBalanceRaw !== undefined &&
      invocationPrivateBalanceRaw !== "$main" &&
      invocationPrivateBalanceRaw !== "$default" &&
      invocationPrivateBalance === undefined) ||
    (resultPrivateBalance !== undefined &&
      invocationPrivateBalance !== undefined &&
      resultPrivateBalance !== invocationPrivateBalance)
  ) {
    return undefined;
  }
  const sourcePrivateBalance = resultPrivateBalance ?? invocationPrivateBalance;
  const destination = deferredReference(
    data?.recipient_wallet_name ?? data?.recipient,
  );
  const amount = deferredAmount(data?.amount_native);
  if (!mode || !source || !destination || !amount) return undefined;
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "deferred_transfer",
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
    source_preview_turn_hash: turnHash(identity),
    stage: "source_switch",
    mode,
    source,
    ...(sourcePrivateBalance === undefined
      ? {}
      : { source_private_balance: sourcePrivateBalance }),
    destination,
    amount_native: amount,
  };
}

function promoteDeferredTransferForReauthorization(
  record: JsonRecord,
  current: DeferredTransfer,
): DeferredTransfer | undefined {
  const envelope = modelContextEnvelope(record);
  const code = nonEmptyString(envelope?.code);
  if (
    code !== "WALLET_REAUTHORIZATION_PLANNED" &&
    code !== "WALLET_REAUTHORIZATION_CONFIRMATION_REQUIRED"
  ) {
    return undefined;
  }
  const data = asRecord(envelope?.data);
  if (data?.reason !== undefined) return undefined;
  const plan = asRecord(data?.plan);
  const wallet = asRecord(plan?.wallet);
  const walletName = deferredReference(wallet?.walletName ?? wallet?.wallet_name);
  const decisionId = deferredReference(plan?.decisionId ?? plan?.decision_id);
  if (walletName !== current.source || !decisionId) return undefined;
  return {
    ...current,
    stage: "reauthorization",
    reauthorization_decision_id: decisionId,
  };
}

function terminalTransferPreview(record: JsonRecord): boolean {
  const code = nonEmptyString(modelContextEnvelope(record)?.code);
  return code === "REGULAR_TRANSFER_PLANNED" ||
    code === "REGULAR_TRANSFER_DENIED" ||
    code === "REGULAR_TRANSFER_CONFIRMATION_REQUIRED" ||
    code === "PAYMENT_PLANNED" ||
    code === "PAYMENT_DENIED" ||
    code === "PAYMENT_CONFIRMATION_REQUIRED" ||
    code === "RECOVERY_PLANNED" ||
    code === "RECOVERY_DENIED" ||
    code === "RECOVERY_CONFIRMATION_REQUIRED";
}

function transferPreviewRoute(producerTool: string): {
  plannedCode: string;
  deniedCode: string;
  tool: TransferExecuteTool;
} | undefined {
  return producerTool === "wallet_preview_regular_transfer" ||
      producerTool === "wallet_plan_regular_transfer"
    ? {
        plannedCode: "REGULAR_TRANSFER_PLANNED",
        deniedCode: "REGULAR_TRANSFER_DENIED",
        tool: "wallet_execute_regular_transfer" as const,
      }
    : producerTool === "wallet_preview_private_transfer" ||
        producerTool === "wallet_plan_private_payment"
      ? {
          plannedCode: "PAYMENT_PLANNED",
          deniedCode: "PAYMENT_DENIED",
          tool: "wallet_execute_private_transfer" as const,
        }
      : producerTool === "wallet_preview_recovery_transfer" ||
          producerTool === "wallet_plan_recovery_transfer"
        ? {
            plannedCode: "RECOVERY_PLANNED",
            deniedCode: "RECOVERY_DENIED",
            tool: "wallet_execute_recovery_transfer" as const,
          }
        : undefined;
}

function allowModeTransferExecutionFromResult(
  record: JsonRecord,
  producerTool: string,
): { tool: TransferExecuteTool; decisionId: string } | undefined {
  const route = transferPreviewRoute(producerTool);
  if (!route) return undefined;

  // Agent Boost mirrors the signed envelope in both structuredContent and
  // model-context. Require those independent transport views to agree before
  // granting a destructive same-turn continuation.
  const structured = asRecord(record.structuredContent);
  const modelContext = modelContextEnvelope(record);
  if (
    structured?.schema !== "org.agentboost.tool-result" ||
    structured.schema_version !== "1.0" ||
    structured.outcome !== "ready" ||
    structured.code !== route.plannedCode ||
    modelContext?.outcome !== "ready" ||
    modelContext.code !== route.plannedCode
  ) {
    return undefined;
  }
  const structuredPlan = asRecord(asRecord(structured.data)?.plan);
  const contextPlan = asRecord(asRecord(modelContext.data)?.plan);
  const structuredApproval = asRecord(structuredPlan?.approval);
  const contextApproval = asRecord(contextPlan?.approval);
  const structuredDecisionId = transferDecisionId(route.tool, structuredPlan?.decisionId);
  const contextDecisionId = transferDecisionId(route.tool, contextPlan?.decisionId);
  const structuredBlockers = structuredPlan?.blockers;
  const contextBlockers = contextPlan?.blockers;
  if (
    !structuredDecisionId ||
    structuredDecisionId !== contextDecisionId ||
    structuredPlan?.decision !== "allow" ||
    contextPlan?.decision !== "allow" ||
    structuredApproval?.action !== "allow" ||
    contextApproval?.action !== "allow" ||
    structuredApproval.userConfirmationRequired !== false ||
    contextApproval.userConfirmationRequired !== false ||
    !Array.isArray(structuredBlockers) ||
    structuredBlockers.length !== 0 ||
    !Array.isArray(contextBlockers) ||
    contextBlockers.length !== 0
  ) {
    return undefined;
  }
  return { tool: route.tool, decisionId: structuredDecisionId };
}

function validatedDeniedTransferPreview(
  record: JsonRecord,
  producerTool: string,
): boolean {
  const route = transferPreviewRoute(producerTool);
  if (!route) return false;
  const structured = asRecord(record.structuredContent);
  const modelContext = modelContextEnvelope(record);
  if (
    structured?.schema !== "org.agentboost.tool-result" ||
    structured.schema_version !== "1.0" ||
    structured.outcome !== "blocked" ||
    structured.code !== route.deniedCode ||
    modelContext?.outcome !== "blocked" ||
    modelContext.code !== route.deniedCode
  ) {
    return false;
  }
  const structuredPlan = asRecord(asRecord(structured.data)?.plan);
  const contextPlan = asRecord(asRecord(modelContext.data)?.plan);
  const structuredDecisionId = transferDecisionId(route.tool, structuredPlan?.decisionId);
  const contextDecisionId = transferDecisionId(route.tool, contextPlan?.decisionId);
  return Boolean(
    structuredDecisionId &&
    structuredDecisionId === contextDecisionId &&
    structuredPlan?.decision === "deny" &&
    contextPlan?.decision === "deny" &&
    Array.isArray(structuredPlan.blockers) &&
    structuredPlan.blockers.length > 0 &&
    Array.isArray(contextPlan.blockers) &&
    contextPlan.blockers.length > 0,
  );
}

async function ensurePrivateStateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const state = await lstat(path);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error("Hermes turn-gate state path must be a real directory");
  }
  await chmod(path, 0o700);
}

async function writePrivateTemporary(
  stateDirectory: string,
  value: unknown,
): Promise<string> {
  const temporary = join(
    stateDirectory,
    `.tmp-${process.pid.toString()}-${randomUUID()}`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporary;
}

async function publishRootTurn(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
  ttlMs: number,
): Promise<void> {
  await ensurePrivateStateDirectory(stateDirectory);
  const marker: RootTurnMarker = {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "root_turn",
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
  };
  const temporary = await writePrivateTemporary(stateDirectory, marker);
  try {
    await rename(temporary, join(stateDirectory, rootTurnName(identity)));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function publishBoundary(
  stateDirectory: string,
  identity: TurnIdentity,
  preview: BoundaryPreview,
  now: number,
  ttlMs: number,
): Promise<boolean> {
  await ensurePrivateStateDirectory(stateDirectory);
  const destination = join(stateDirectory, markerName(identity));
  const marker: BoundaryMarker = {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "turn_boundary",
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
    ...(preview.renderedResponse === undefined
      ? {}
      : { rendered_response: preview.renderedResponse }),
  };
  const temporary = await writePrivateTemporary(stateDirectory, marker);
  try {
    // A fully-written hard link gives same-turn publication first-writer-wins
    // semantics. There is no stale process lock to strand after a crash.
    await link(temporary, destination);
    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    return false;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function publishContinuation(
  stateDirectory: string,
  identity: TurnIdentity,
  continuation: Continuation,
  now: number,
  ttlMs: number,
): Promise<void> {
  await ensurePrivateStateDirectory(stateDirectory);
  const pending: PendingContinuation = {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "pending_continuation",
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
    preview_turn_hash: turnHash(identity),
    tool: continuation.tool,
    binding: continuation.binding,
  };
  const temporary = await writePrivateTemporary(stateDirectory, pending);
  try {
    // Rename is the publication point. A newer preview intentionally
    // supersedes the previous session continuation atomically.
    await rename(temporary, join(stateDirectory, continuationName(identity)));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function clearContinuation(
  stateDirectory: string,
  identity: TurnIdentity,
): Promise<void> {
  try {
    // Unlink is the atomic retirement point. A hard boundary without a valid
    // continuation must supersede, never preserve, an older approval preview.
    await unlink(join(stateDirectory, continuationName(identity)));
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

async function retireSupersededContinuation(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<void> {
  const pendingPath = join(stateDirectory, continuationName(identity));
  const claimPath = join(
    stateDirectory,
    `.retire-pending-${digest(["session", identity.sessionId])}-${randomUUID()}.json`,
  );
  try {
    // Rename is a compare-and-retire point. A competing same-turn preview may
    // already have published the winning continuation; if so, restore it and
    // let the immutable boundary marker decide which preview won.
    await rename(pendingPath, claimPath);
  } catch (error) {
    if (isFileNotFound(error)) return;
    throw error;
  }

  const claimed = await readState(claimPath, parsePendingContinuation, now);
  if (
    claimed.status === "active" &&
    claimed.value.preview_turn_hash === turnHash(identity)
  ) {
    await restoreClaim(claimPath, pendingPath);
    return;
  }
  await unlink(claimPath).catch(() => undefined);
}

async function clearUserDecision(
  stateDirectory: string,
  identity: TurnIdentity,
): Promise<void> {
  try {
    await unlink(join(stateDirectory, userDecisionName(identity)));
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

async function publishUserDecision(
  stateDirectory: string,
  identity: TurnIdentity,
  pending: PendingContinuation,
  userConfirmed: boolean,
  now: number,
  ttlMs: number,
): Promise<void> {
  await ensurePrivateStateDirectory(stateDirectory);
  const marker: UserDecisionMarker = {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "user_decision",
    created_at_ms: now,
    expires_at_ms: Math.min(now + ttlMs, pending.expires_at_ms),
    decision_turn_hash: turnHash(identity),
    preview_turn_hash: pending.preview_turn_hash,
    tool: pending.tool,
    binding: pending.binding,
    user_confirmed: userConfirmed,
  };
  const temporary = await writePrivateTemporary(stateDirectory, marker);
  try {
    // pre_llm_call may be retried for one turn. Replacing this turn-scoped
    // record ensures only the latest authenticated user message can decide.
    await rename(temporary, join(stateDirectory, userDecisionName(identity)));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function publishDeferredTransfer(
  stateDirectory: string,
  identity: TurnIdentity,
  deferred: DeferredTransfer,
): Promise<void> {
  await ensurePrivateStateDirectory(stateDirectory);
  const temporary = await writePrivateTemporary(stateDirectory, deferred);
  try {
    await rename(temporary, join(stateDirectory, deferredTransferName(identity)));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function clearDeferredTransfer(
  stateDirectory: string,
  identity: TurnIdentity,
): Promise<void> {
  try {
    await unlink(join(stateDirectory, deferredTransferName(identity)));
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

async function publishPendingStatusRead(
  stateDirectory: string,
  identity: TurnIdentity,
  target: { tool: StatusReadTool; binding: StableBinding },
  now: number,
  ttlMs: number,
  state: "unresolved" | "terminal" = "unresolved",
): Promise<void> {
  await ensurePrivateStateDirectory(stateDirectory);
  const pending: PendingStatusRead = {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "pending_status_read",
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
    result_turn_hash: turnHash(identity),
    state,
    tool: target.tool,
    binding: target.binding,
  };
  const temporary = await writePrivateTemporary(stateDirectory, pending);
  try {
    await rename(temporary, join(stateDirectory, pendingStatusReadName(identity)));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function clearPendingStatusRead(
  stateDirectory: string,
  identity: TurnIdentity,
): Promise<void> {
  try {
    await unlink(join(stateDirectory, pendingStatusReadName(identity)));
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

async function publishPendingDispatchStatus(
  stateDirectory: string,
  identity: TurnIdentity,
  target: StatusReadTarget,
  sourceTool: ConfirmationTool | StatusReadTool,
  sourceBinding: StableBinding,
  now: number,
  ttlMs: number,
): Promise<void> {
  await ensurePrivateStateDirectory(stateDirectory);
  const pending: PendingDispatchStatus = {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "pending_dispatch_status",
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
    dispatch_turn_hash: turnHash(identity),
    tool: target.tool,
    binding: target.binding,
    source_tool: sourceTool,
    source_binding: sourceBinding,
  };
  const temporary = await writePrivateTemporary(stateDirectory, pending);
  try {
    await rename(temporary, join(stateDirectory, pendingDispatchStatusName(identity)));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function clearPendingDispatchStatus(
  stateDirectory: string,
  identity: TurnIdentity,
): Promise<void> {
  try {
    await unlink(join(stateDirectory, pendingDispatchStatusName(identity)));
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

async function publishRoutedTransfer(
  stateDirectory: string,
  identity: TurnIdentity,
  tool: RoutedTool,
  binding: StableBinding,
  argumentsPinned: boolean,
  now: number,
  ttlMs: number,
): Promise<void> {
  await ensurePrivateStateDirectory(stateDirectory);
  const routed: RoutedTransfer = {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "routed_transfer",
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
    turn_hash: turnHash(identity),
    tool,
    binding,
    arguments_pinned: argumentsPinned,
  };
  const temporary = await writePrivateTemporary(stateDirectory, routed);
  try {
    await rename(temporary, join(stateDirectory, routedTransferName(identity)));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function clearRoutedTransfer(
  stateDirectory: string,
  identity: TurnIdentity,
): Promise<void> {
  try {
    await unlink(join(stateDirectory, routedTransferName(identity)));
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

async function publishAllowModeTransferExecution(
  stateDirectory: string,
  identity: TurnIdentity,
  tool: TransferExecuteTool,
  decisionId: string,
  now: number,
  ttlMs: number,
): Promise<boolean> {
  await ensurePrivateStateDirectory(stateDirectory);
  const marker: AllowModeTransferExecution = {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "allow_mode_transfer_execution",
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
    preview_turn_hash: turnHash(identity),
    state: "active",
    tool,
    decision_id: decisionId,
  };
  const temporary = await writePrivateTemporary(stateDirectory, marker);
  try {
    // A trusted allow-mode preview may be delivered more than once by the
    // hook transport. First-writer-wins prevents a duplicate delivery from
    // replacing either the exact active pin or its consumed tombstone.
    await link(temporary, join(stateDirectory, allowModeTransferName(identity)));
    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    return false;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function publishSavedWalletSelection(
  stateDirectory: string,
  identity: TurnIdentity,
  walletNames: string[],
  now: number,
  ttlMs: number,
): Promise<void> {
  await ensurePrivateStateDirectory(stateDirectory);
  const selection: SavedWalletSelection = {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "saved_wallet_selection",
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
    preview_turn_hash: turnHash(identity),
    wallet_names: walletNames,
  };
  const temporary = await writePrivateTemporary(stateDirectory, selection);
  try {
    await rename(temporary, join(stateDirectory, savedWalletSelectionName(identity)));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function clearSavedWalletSelection(
  stateDirectory: string,
  identity: TurnIdentity,
): Promise<void> {
  try {
    await unlink(join(stateDirectory, savedWalletSelectionName(identity)));
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

async function publishRoutedSavedWalletChoice(
  stateDirectory: string,
  identity: TurnIdentity,
  walletName: string,
  now: number,
  ttlMs: number,
): Promise<void> {
  await ensurePrivateStateDirectory(stateDirectory);
  const route: RoutedSavedWalletChoice = {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "routed_saved_wallet_choice",
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
    turn_hash: turnHash(identity),
    wallet_name: walletName,
  };
  const temporary = await writePrivateTemporary(stateDirectory, route);
  try {
    await rename(temporary, join(stateDirectory, routedSavedWalletChoiceName(identity)));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function clearRoutedSavedWalletChoice(
  stateDirectory: string,
  identity: TurnIdentity,
): Promise<void> {
  try {
    await unlink(join(stateDirectory, routedSavedWalletChoiceName(identity)));
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

type StateRead<T> =
  | { status: "absent" }
  | { status: "active"; value: T }
  | { status: "invalid" };

function parseBoundaryMarker(value: unknown): BoundaryMarker | undefined {
  const record = asRecord(value);
  if (
    record?.schema !== STATE_SCHEMA ||
    record.version !== STATE_VERSION ||
    record.kind !== "turn_boundary" ||
    typeof record.created_at_ms !== "number" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    typeof record.expires_at_ms !== "number" ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.expires_at_ms <= record.created_at_ms ||
    (record.rendered_response !== undefined && typeof record.rendered_response !== "string")
  ) {
    return undefined;
  }
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "turn_boundary",
    created_at_ms: record.created_at_ms,
    expires_at_ms: record.expires_at_ms,
    ...(typeof record.rendered_response === "string"
      ? { rendered_response: record.rendered_response }
      : {}),
  };
}

function parseNestedForkTurnMarker(value: unknown): NestedForkTurnMarker | undefined {
  const record = asRecord(value);
  if (
    record?.schema !== STATE_SCHEMA ||
    record.version !== STATE_VERSION ||
    record.kind !== "nested_fork_turn" ||
    typeof record.created_at_ms !== "number" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    typeof record.expires_at_ms !== "number" ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.expires_at_ms <= record.created_at_ms ||
    Object.keys(record).some((key) => ![
      "schema",
      "version",
      "kind",
      "created_at_ms",
      "expires_at_ms",
    ].includes(key))
  ) {
    return undefined;
  }
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "nested_fork_turn",
    created_at_ms: record.created_at_ms,
    expires_at_ms: record.expires_at_ms,
  };
}

function parseRootTurnMarker(value: unknown): RootTurnMarker | undefined {
  const record = asRecord(value);
  if (
    record?.schema !== STATE_SCHEMA ||
    record.version !== STATE_VERSION ||
    record.kind !== "root_turn" ||
    typeof record.created_at_ms !== "number" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    typeof record.expires_at_ms !== "number" ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.expires_at_ms <= record.created_at_ms ||
    Object.keys(record).some((key) => ![
      "schema",
      "version",
      "kind",
      "created_at_ms",
      "expires_at_ms",
    ].includes(key))
  ) {
    return undefined;
  }
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "root_turn",
    created_at_ms: record.created_at_ms,
    expires_at_ms: record.expires_at_ms,
  };
}

function parsePendingContinuation(value: unknown): PendingContinuation | undefined {
  const record = asRecord(value);
  const tool = canonicalToolName(record?.tool);
  const binding = tool ? normalizeContinuationBinding(tool, record?.binding) : undefined;
  if (
    record?.schema !== STATE_SCHEMA ||
    record.version !== STATE_VERSION ||
    record.kind !== "pending_continuation" ||
    typeof record.created_at_ms !== "number" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    typeof record.expires_at_ms !== "number" ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.expires_at_ms <= record.created_at_ms ||
    typeof record.preview_turn_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.preview_turn_hash) ||
    !tool ||
    !binding
  ) {
    return undefined;
  }
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "pending_continuation",
    created_at_ms: record.created_at_ms,
    expires_at_ms: record.expires_at_ms,
    preview_turn_hash: record.preview_turn_hash,
    tool,
    binding,
  };
}

function parseUserDecisionMarker(value: unknown): UserDecisionMarker | undefined {
  const record = asRecord(value);
  const tool = canonicalToolName(record?.tool);
  const binding = tool ? normalizeContinuationBinding(tool, record?.binding) : undefined;
  if (
    record?.schema !== STATE_SCHEMA ||
    record.version !== STATE_VERSION ||
    record.kind !== "user_decision" ||
    typeof record.created_at_ms !== "number" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    typeof record.expires_at_ms !== "number" ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.expires_at_ms <= record.created_at_ms ||
    typeof record.decision_turn_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.decision_turn_hash) ||
    typeof record.preview_turn_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.preview_turn_hash) ||
    !tool ||
    !binding ||
    typeof record.user_confirmed !== "boolean"
  ) {
    return undefined;
  }
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "user_decision",
    created_at_ms: record.created_at_ms,
    expires_at_ms: record.expires_at_ms,
    decision_turn_hash: record.decision_turn_hash,
    preview_turn_hash: record.preview_turn_hash,
    tool,
    binding,
    user_confirmed: record.user_confirmed,
  };
}

function deferredReference(value: unknown): string | undefined {
  const reference = nonEmptyString(value);
  return reference && reference.length <= MAX_BINDING_STRING_CHARS &&
      !/[\u0000-\u001f\u007f]/u.test(reference)
    ? reference
    : undefined;
}

function privateBalanceReference(value: unknown): string | undefined {
  const reference = nonEmptyString(value);
  return reference && reference.length <= 64 &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(reference)
    ? reference
    : undefined;
}

function deferredAmount(value: unknown): string | undefined {
  const amount = nonEmptyString(value);
  return amount && /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u.test(amount)
    ? amount
    : undefined;
}

function parseDeferredTransfer(value: unknown): DeferredTransfer | undefined {
  const record = asRecord(value);
  const mode = record?.mode;
  const source = deferredReference(record?.source);
  const sourcePrivateBalance = record?.source_private_balance === undefined
    ? undefined
    : privateBalanceReference(record.source_private_balance);
  const destination = deferredReference(record?.destination);
  const amount = deferredAmount(record?.amount_native);
  const decisionId = record?.reauthorization_decision_id === undefined
    ? undefined
    : deferredReference(record.reauthorization_decision_id);
  if (
    record?.schema !== STATE_SCHEMA ||
    record.version !== STATE_VERSION ||
    record.kind !== "deferred_transfer" ||
    typeof record.created_at_ms !== "number" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    typeof record.expires_at_ms !== "number" ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.expires_at_ms <= record.created_at_ms ||
    typeof record.source_preview_turn_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.source_preview_turn_hash) ||
    (record.stage !== "source_switch" && record.stage !== "reauthorization") ||
    (mode !== "regular" && mode !== "private" && mode !== "recovery") ||
    !source ||
    (record.source_private_balance !== undefined && !sourcePrivateBalance) ||
    !destination ||
    !amount ||
    (record.stage === "source_switch" && decisionId !== undefined) ||
    (record.stage === "reauthorization" && !decisionId) ||
    Object.keys(record).some((key) => ![
      "schema",
      "version",
      "kind",
      "created_at_ms",
      "expires_at_ms",
      "source_preview_turn_hash",
      "stage",
      "mode",
      "source",
      "source_private_balance",
      "destination",
      "amount_native",
      "reauthorization_decision_id",
    ].includes(key))
  ) {
    return undefined;
  }
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "deferred_transfer",
    created_at_ms: record.created_at_ms,
    expires_at_ms: record.expires_at_ms,
    source_preview_turn_hash: record.source_preview_turn_hash,
    stage: record.stage,
    mode,
    source,
    ...(sourcePrivateBalance === undefined
      ? {}
      : { source_private_balance: sourcePrivateBalance }),
    destination,
    amount_native: amount,
    ...(decisionId === undefined ? {} : { reauthorization_decision_id: decisionId }),
  };
}

const ROUTED_TOOLS = new Set<RoutedTool>([
  "$clarify_private_balance_fund",
  "$clarify_private_balance_policy",
  "$clarify_status_followup",
  "$clarify_wallet_graph_create",
  "$clarify_wallet_policy",
  "onboarding_status",
  "wallet_get_private_balance_operation",
  "wallet_get_private_transfer_request",
  "wallet_get_recovery_request",
  "wallet_get_regular_transfer_request",
  "wallet_create",
  "wallet_get_private_balance_policy",
  "wallet_get_policy",
  "wallet_get_tree",
  "wallet_plan_policy_update",
  "wallet_plan_reauthorization",
  "wallet_preview_private_balance_create",
  "wallet_preview_private_balance_fund",
  "wallet_preview_private_balance_policy_update",
  "wallet_preview_private_transfer",
  "wallet_preview_recovery_transfer",
  "wallet_preview_regular_transfer",
]);

function exactBindingKeys(binding: StableBinding, keys: readonly string[]): boolean {
  const actual = Object.keys(binding).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function routedBinding(
  tool: RoutedTool,
  value: unknown,
  argumentsPinned: boolean,
): StableBinding | undefined {
  const binding = stableBinding(value);
  if (!binding) return undefined;
  if (!argumentsPinned) return exactBindingKeys(binding, []) ? binding : undefined;

  if (
    tool === "$clarify_private_balance_fund" ||
    tool === "$clarify_private_balance_policy" ||
    tool === "$clarify_status_followup" ||
    tool === "$clarify_wallet_graph_create" ||
    tool === "$clarify_wallet_policy" ||
    tool === "wallet_get_tree"
  ) {
    return exactBindingKeys(binding, []) ? binding : undefined;
  }
  if (tool === "onboarding_status") {
    const setupId = nonEmptyString(binding.setup_id);
    const revision = binding.since_revision;
    const waitMs = binding.wait_ms;
    return setupId && setupId.length >= 8 && setupId.length <= MAX_BINDING_STRING_CHARS &&
        typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 &&
        waitMs === 30_000 &&
        exactBindingKeys(binding, ["setup_id", "since_revision", "wait_ms"])
      ? { setup_id: setupId, since_revision: revision, wait_ms: waitMs }
      : undefined;
  }
  const statusPrefixes = tool === "wallet_get_regular_transfer_request"
    ? { request: "rreq", decision: "rwd" }
    : tool === "wallet_get_private_transfer_request"
      ? { request: "req", decision: "wd" }
      : tool === "wallet_get_recovery_request"
        ? { request: "wrr", decision: "wr" }
        : tool === "wallet_get_private_balance_operation"
          ? { request: "(?:pbcr|pbfr|pbpr)", decision: "(?:pbc|pbf|pbp)" }
          : undefined;
  if (statusPrefixes) {
    const requestId = nonEmptyString(binding.request_id);
    const decisionId = nonEmptyString(binding.decision_id);
    if (
      requestId && decisionId === undefined &&
      new RegExp(`^${statusPrefixes.request}_[A-Za-z0-9-]{8,128}$`, "u").test(requestId) &&
      exactBindingKeys(binding, ["request_id"])
    ) {
      return { request_id: requestId };
    }
    return decisionId && requestId === undefined &&
        new RegExp(`^${statusPrefixes.decision}_[A-Za-z0-9-]{8,128}$`, "u").test(decisionId) &&
        exactBindingKeys(binding, ["decision_id"])
      ? { decision_id: decisionId }
      : undefined;
  }
  if (tool === "wallet_get_policy") {
    const wallet = binding.wallet_name === undefined
      ? undefined
      : privateBalanceReference(binding.wallet_name);
    const keys = wallet === undefined ? [] : ["wallet_name"];
    return exactBindingKeys(binding, keys)
      ? wallet === undefined ? {} : { wallet_name: wallet }
      : undefined;
  }
  if (tool === "wallet_plan_reauthorization") {
    const wallet = binding.wallet_name === undefined
      ? undefined
      : privateBalanceReference(binding.wallet_name);
    const keys = wallet === undefined ? [] : ["wallet_name"];
    return exactBindingKeys(binding, keys)
      ? wallet === undefined ? {} : { wallet_name: wallet }
      : undefined;
  }
  if (tool === "wallet_create") {
    const name = privateBalanceReference(binding.name);
    return name && exactBindingKeys(binding, ["name"]) ? { name } : undefined;
  }
  if (tool === "wallet_preview_private_balance_create") {
    const name = privateBalanceReference(binding.private_balance_name);
    const wallet = binding.wallet_name === undefined
      ? undefined
      : privateBalanceReference(binding.wallet_name);
    const keys = wallet === undefined
      ? ["private_balance_name"]
      : ["private_balance_name", "wallet_name"];
    return name && exactBindingKeys(binding, keys)
      ? { private_balance_name: name, ...(wallet === undefined ? {} : { wallet_name: wallet }) }
      : undefined;
  }
  if (tool === "wallet_preview_private_balance_fund") {
    const source = binding.source === "$main"
      ? "$main"
      : privateBalanceReference(binding.source);
    const target = privateBalanceReference(binding.target_private_balance_name);
    const amount = deferredAmount(binding.amount_native);
    const wallet = binding.wallet_name === undefined
      ? undefined
      : privateBalanceReference(binding.wallet_name);
    const keys = wallet === undefined
      ? ["source", "target_private_balance_name", "amount_native"]
      : ["wallet_name", "source", "target_private_balance_name", "amount_native"];
    return source && target && amount && exactBindingKeys(binding, keys)
      ? {
        ...(wallet === undefined ? {} : { wallet_name: wallet }),
        source,
        target_private_balance_name: target,
        amount_native: amount,
      }
      : undefined;
  }
  if (
    tool === "wallet_get_private_balance_policy" ||
    tool === "wallet_preview_private_balance_policy_update"
  ) {
    const privateBalance = privateBalanceReference(binding.private_balance_name);
    const wallet = binding.wallet_name === undefined
      ? undefined
      : privateBalanceReference(binding.wallet_name);
    const allowed = new Set([
      "wallet_name",
      "private_balance_name",
      ...(tool === "wallet_preview_private_balance_policy_update"
        ? [
          "max_payments",
          "per_payment_limit_native",
          "lifetime_limit_native",
          "expires_in_hours",
          "enabled",
        ]
        : []),
    ]);
    if (
      !privateBalance ||
      (binding.wallet_name !== undefined && !wallet) ||
      Object.keys(binding).some((key) => !allowed.has(key))
    ) {
      return undefined;
    }
    if (tool === "wallet_get_private_balance_policy") {
      const keys = wallet === undefined
        ? ["private_balance_name"]
        : ["wallet_name", "private_balance_name"];
      return exactBindingKeys(binding, keys)
        ? {
          ...(wallet === undefined ? {} : { wallet_name: wallet }),
          private_balance_name: privateBalance,
        }
        : undefined;
    }
    const numericKeys = ["max_payments", "expires_in_hours"];
    if (numericKeys.some((key) =>
      binding[key] !== undefined &&
      (typeof binding[key] !== "number" ||
        !Number.isSafeInteger(binding[key]) ||
        binding[key] <= 0)
    )) return undefined;
    const amountKeys = ["per_payment_limit_native", "lifetime_limit_native"];
    if (amountKeys.some((key) =>
      binding[key] !== undefined && deferredAmount(binding[key]) === undefined
    )) return undefined;
    if (binding.enabled !== undefined && typeof binding.enabled !== "boolean") {
      return undefined;
    }
    if (Object.keys(binding).every((key) =>
      key === "wallet_name" || key === "private_balance_name"
    )) return undefined;
    return {
      ...(wallet === undefined ? {} : { wallet_name: wallet }),
      private_balance_name: privateBalance,
      ...Object.fromEntries(Object.entries(binding).filter(([key]) =>
        key !== "wallet_name" && key !== "private_balance_name"
      )),
    };
  }
  if (
    tool === "wallet_preview_regular_transfer" ||
    tool === "wallet_preview_private_transfer" ||
    tool === "wallet_preview_recovery_transfer"
  ) {
    const source = deferredReference(binding.source);
    const sourcePrivateBalance = binding.source_private_balance === undefined
      ? undefined
      : binding.source_private_balance === "$default"
        ? "$default"
        : privateBalanceReference(binding.source_private_balance);
    const destination = deferredReference(binding.destination);
    const amount = deferredAmount(binding.amount_native);
    const keys = sourcePrivateBalance === undefined
      ? ["source", "destination", "amount_native"]
      : ["source", "source_private_balance", "destination", "amount_native"];
    return source && destination && amount && exactBindingKeys(binding, keys)
      ? {
        source,
        ...(sourcePrivateBalance === undefined
          ? {}
          : { source_private_balance: sourcePrivateBalance }),
        destination,
        amount_native: amount,
      }
      : undefined;
  }
  if (tool === "wallet_plan_policy_update") {
    const allowed = new Set([
      "wallet_name",
      "max_payments",
      "count",
      "per_payment_limit_native",
      "per_send_amount",
      "lifetime_limit_native",
      "expires_in_hours",
      "enabled",
    ]);
    if (Object.keys(binding).some((key) => !allowed.has(key))) return undefined;
    const wallet = binding.wallet_name === undefined
      ? undefined
      : privateBalanceReference(binding.wallet_name);
    if (binding.wallet_name !== undefined && !wallet) return undefined;
    const numericKeys = ["max_payments", "count", "expires_in_hours"];
    if (numericKeys.some((key) =>
      binding[key] !== undefined &&
      (typeof binding[key] !== "number" || !Number.isSafeInteger(binding[key]) || binding[key] <= 0)
    )) return undefined;
    const amountKeys = [
      "per_payment_limit_native",
      "per_send_amount",
      "lifetime_limit_native",
    ];
    if (amountKeys.some((key) =>
      binding[key] !== undefined && deferredAmount(binding[key]) === undefined
    )) return undefined;
    if (binding.enabled !== undefined && typeof binding.enabled !== "boolean") return undefined;
    if (Object.keys(binding).every((key) => key === "wallet_name")) return undefined;
    return binding;
  }
  return undefined;
}

function parsePendingStatusRead(value: unknown): PendingStatusRead | undefined {
  const record = asRecord(value);
  const tool = typeof record?.tool === "string" &&
      STATUS_READ_TOOLS.has(record.tool as StatusReadTool)
    ? record.tool as StatusReadTool
    : undefined;
  const binding = tool ? routedBinding(tool, record?.binding, true) : undefined;
  if (
    record?.schema !== STATE_SCHEMA ||
    record.version !== STATE_VERSION ||
    record.kind !== "pending_status_read" ||
    typeof record.created_at_ms !== "number" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    typeof record.expires_at_ms !== "number" ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.expires_at_ms <= record.created_at_ms ||
    typeof record.result_turn_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.result_turn_hash) ||
    (record.state !== undefined &&
      record.state !== "unresolved" && record.state !== "terminal") ||
    !tool ||
    !binding ||
    Object.keys(record).some((key) => ![
      "schema",
      "version",
      "kind",
      "created_at_ms",
      "expires_at_ms",
      "result_turn_hash",
      "state",
      "tool",
      "binding",
    ].includes(key))
  ) {
    return undefined;
  }
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "pending_status_read",
    created_at_ms: record.created_at_ms,
    expires_at_ms: record.expires_at_ms,
    result_turn_hash: record.result_turn_hash,
    // Version-one markers written before terminal tombstones existed were all
    // unresolved handles. Preserve that safe on-disk compatibility.
    state: record.state === "terminal" ? "terminal" : "unresolved",
    tool,
    binding,
  };
}

function parsePendingDispatchStatus(value: unknown): PendingDispatchStatus | undefined {
  const record = asRecord(value);
  const tool = typeof record?.tool === "string" &&
      STATUS_READ_TOOLS.has(record.tool as StatusReadTool)
    ? record.tool as StatusReadTool
    : undefined;
  const binding = tool ? routedBinding(tool, record?.binding, true) : undefined;
  const sourceTool = typeof record?.source_tool === "string" &&
      (CONFIRMATION_TOOL_SET.has(record.source_tool) ||
        STATUS_READ_TOOLS.has(record.source_tool as StatusReadTool))
    ? record.source_tool as ConfirmationTool | StatusReadTool
    : undefined;
  const sourceBinding = sourceTool && CONFIRMATION_TOOL_SET.has(sourceTool)
    ? normalizeContinuationBinding(sourceTool as ConfirmationTool, record?.source_binding)
    : sourceTool
      ? routedBinding(sourceTool as StatusReadTool, record?.source_binding, true)
      : undefined;
  if (
    record?.schema !== STATE_SCHEMA ||
    record.version !== STATE_VERSION ||
    record.kind !== "pending_dispatch_status" ||
    typeof record.created_at_ms !== "number" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    typeof record.expires_at_ms !== "number" ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.expires_at_ms <= record.created_at_ms ||
    typeof record.dispatch_turn_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.dispatch_turn_hash) ||
    !tool ||
    !binding ||
    !sourceTool ||
    !sourceBinding ||
    Object.keys(record).some((key) => ![
      "schema",
      "version",
      "kind",
      "created_at_ms",
      "expires_at_ms",
      "dispatch_turn_hash",
      "tool",
      "binding",
      "source_tool",
      "source_binding",
    ].includes(key))
  ) {
    return undefined;
  }
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "pending_dispatch_status",
    created_at_ms: record.created_at_ms,
    expires_at_ms: record.expires_at_ms,
    dispatch_turn_hash: record.dispatch_turn_hash,
    tool,
    binding,
    source_tool: sourceTool,
    source_binding: sourceBinding,
  };
}

function parseRoutedTransfer(value: unknown): RoutedTransfer | undefined {
  const record = asRecord(value);
  const tool = typeof record?.tool === "string" && ROUTED_TOOLS.has(record.tool as RoutedTool)
    ? record.tool as RoutedTool
    : undefined;
  const argumentsPinned = record?.arguments_pinned;
  const binding = tool && typeof argumentsPinned === "boolean"
    ? routedBinding(tool, record?.binding, argumentsPinned)
    : undefined;
  if (
    record?.schema !== STATE_SCHEMA ||
    record.version !== STATE_VERSION ||
    record.kind !== "routed_transfer" ||
    typeof record.created_at_ms !== "number" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    typeof record.expires_at_ms !== "number" ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.expires_at_ms <= record.created_at_ms ||
    typeof record.turn_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.turn_hash) ||
    !tool ||
    !binding ||
    typeof argumentsPinned !== "boolean" ||
    Object.keys(record).some((key) => ![
      "schema",
      "version",
      "kind",
      "created_at_ms",
      "expires_at_ms",
      "turn_hash",
      "tool",
      "binding",
      "arguments_pinned",
    ].includes(key))
  ) {
    return undefined;
  }
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "routed_transfer",
    created_at_ms: record.created_at_ms,
    expires_at_ms: record.expires_at_ms,
    turn_hash: record.turn_hash,
    tool,
    binding,
    arguments_pinned: argumentsPinned,
  };
}

function parseAllowModeTransferExecution(
  value: unknown,
): AllowModeTransferExecution | undefined {
  const record = asRecord(value);
  const tool = record?.tool === "wallet_execute_regular_transfer" ||
      record?.tool === "wallet_execute_private_transfer" ||
      record?.tool === "wallet_execute_recovery_transfer"
    ? record.tool
    : undefined;
  const decisionId = tool ? transferDecisionId(tool, record?.decision_id) : undefined;
  if (
    record?.schema !== STATE_SCHEMA ||
    record.version !== STATE_VERSION ||
    record.kind !== "allow_mode_transfer_execution" ||
    typeof record.created_at_ms !== "number" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    typeof record.expires_at_ms !== "number" ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.expires_at_ms <= record.created_at_ms ||
    typeof record.preview_turn_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.preview_turn_hash) ||
    (record.state !== "active" && record.state !== "consumed") ||
    !tool ||
    !decisionId ||
    Object.keys(record).some((key) => ![
      "schema",
      "version",
      "kind",
      "created_at_ms",
      "expires_at_ms",
      "preview_turn_hash",
      "state",
      "tool",
      "decision_id",
    ].includes(key))
  ) {
    return undefined;
  }
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "allow_mode_transfer_execution",
    created_at_ms: record.created_at_ms,
    expires_at_ms: record.expires_at_ms,
    preview_turn_hash: record.preview_turn_hash,
    state: record.state,
    tool,
    decision_id: decisionId,
  };
}

function savedWalletChoice(value: unknown): string | undefined {
  const name = nonEmptyString(value);
  return name && name.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(name)
    ? name
    : undefined;
}

function parseSavedWalletSelection(value: unknown): SavedWalletSelection | undefined {
  const record = asRecord(value);
  const rawNames = Array.isArray(record?.wallet_names) ? record.wallet_names : [];
  const walletNames = rawNames.map(savedWalletChoice);
  if (
    record?.schema !== STATE_SCHEMA ||
    record.version !== STATE_VERSION ||
    record.kind !== "saved_wallet_selection" ||
    typeof record.created_at_ms !== "number" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    typeof record.expires_at_ms !== "number" ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.expires_at_ms <= record.created_at_ms ||
    typeof record.preview_turn_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.preview_turn_hash) ||
    rawNames.length < 2 ||
    rawNames.length > 20 ||
    walletNames.some((name) => name === undefined) ||
    new Set(walletNames).size !== walletNames.length
  ) {
    return undefined;
  }
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "saved_wallet_selection",
    created_at_ms: record.created_at_ms,
    expires_at_ms: record.expires_at_ms,
    preview_turn_hash: record.preview_turn_hash,
    wallet_names: walletNames as string[],
  };
}

function parseRoutedSavedWalletChoice(value: unknown): RoutedSavedWalletChoice | undefined {
  const record = asRecord(value);
  const walletName = savedWalletChoice(record?.wallet_name);
  if (
    record?.schema !== STATE_SCHEMA ||
    record.version !== STATE_VERSION ||
    record.kind !== "routed_saved_wallet_choice" ||
    typeof record.created_at_ms !== "number" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    typeof record.expires_at_ms !== "number" ||
    !Number.isSafeInteger(record.expires_at_ms) ||
    record.expires_at_ms <= record.created_at_ms ||
    typeof record.turn_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.turn_hash) ||
    !walletName
  ) {
    return undefined;
  }
  return {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    kind: "routed_saved_wallet_choice",
    created_at_ms: record.created_at_ms,
    expires_at_ms: record.expires_at_ms,
    turn_hash: record.turn_hash,
    wallet_name: walletName,
  };
}

async function readState<T>(
  path: string,
  parser: (value: unknown) => T | undefined,
  now: number,
): Promise<StateRead<T>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    return isFileNotFound(error) ? { status: "absent" } : { status: "invalid" };
  }
  let value: T | undefined;
  try {
    value = parser(JSON.parse(content));
  } catch {
    return { status: "invalid" };
  }
  if (!value) return { status: "invalid" };
  const expiring = value as T & { expires_at_ms?: unknown };
  if (typeof expiring.expires_at_ms !== "number") return { status: "invalid" };
  if (expiring.expires_at_ms <= now) {
    await unlink(path).catch(() => undefined);
    return { status: "absent" };
  }
  return { status: "active", value };
}

async function readBoundary(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<StateRead<BoundaryMarker>> {
  return readState(
    join(stateDirectory, markerName(identity)),
    parseBoundaryMarker,
    now,
  );
}

async function readNestedForkTurn(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<StateRead<NestedForkTurnMarker>> {
  return readState(
    join(stateDirectory, nestedForkTurnName(identity)),
    parseNestedForkTurnMarker,
    now,
  );
}

async function readRootTurn(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<StateRead<RootTurnMarker>> {
  return readState(
    join(stateDirectory, rootTurnName(identity)),
    parseRootTurnMarker,
    now,
  );
}

async function readPendingContinuation(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<StateRead<PendingContinuation>> {
  return readState(
    join(stateDirectory, continuationName(identity)),
    parsePendingContinuation,
    now,
  );
}

async function readUserDecision(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<StateRead<UserDecisionMarker>> {
  return readState(
    join(stateDirectory, userDecisionName(identity)),
    parseUserDecisionMarker,
    now,
  );
}

async function readDeferredTransfer(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<StateRead<DeferredTransfer>> {
  return readState(
    join(stateDirectory, deferredTransferName(identity)),
    parseDeferredTransfer,
    now,
  );
}

async function readPendingStatusRead(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<StateRead<PendingStatusRead>> {
  return readState(
    join(stateDirectory, pendingStatusReadName(identity)),
    parsePendingStatusRead,
    now,
  );
}

async function readPendingDispatchStatus(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<StateRead<PendingDispatchStatus>> {
  return readState(
    join(stateDirectory, pendingDispatchStatusName(identity)),
    parsePendingDispatchStatus,
    now,
  );
}

async function readRoutedTransfer(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<StateRead<RoutedTransfer>> {
  return readState(
    join(stateDirectory, routedTransferName(identity)),
    parseRoutedTransfer,
    now,
  );
}

async function readAllowModeTransferExecution(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<StateRead<AllowModeTransferExecution>> {
  return readState(
    join(stateDirectory, allowModeTransferName(identity)),
    parseAllowModeTransferExecution,
    now,
  );
}

async function readSavedWalletSelection(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<StateRead<SavedWalletSelection>> {
  return readState(
    join(stateDirectory, savedWalletSelectionName(identity)),
    parseSavedWalletSelection,
    now,
  );
}

async function readRoutedSavedWalletChoice(
  stateDirectory: string,
  identity: TurnIdentity,
  now: number,
): Promise<StateRead<RoutedSavedWalletChoice>> {
  return readState(
    join(stateDirectory, routedSavedWalletChoiceName(identity)),
    parseRoutedSavedWalletChoice,
    now,
  );
}

interface ToolInvocation {
  tool: string;
  input: JsonRecord;
  invalidProtectedInput?: true;
}

function toolInvocation(record: JsonRecord): ToolInvocation | undefined {
  const outerTool = nonEmptyString(record.tool_name);
  const outerInput = asRecord(record.tool_input) ?? {};
  if (!outerTool) return undefined;
  if (outerTool !== "tool_call") return { tool: outerTool, input: outerInput };
  const innerTool = nonEmptyString(outerInput.name);
  if (!innerTool) return undefined;

  // Hermes's Tool Search bridge accepts either an object or one JSON-encoded
  // object for `arguments`. Mirror that compatibility exactly once so a model
  // cannot hide `user_confirmed` from this pre-hook while Hermes still parses
  // and dispatches the protected call. Double-encoded, malformed, and
  // non-object inputs remain invalid.
  let innerInputValue = outerInput.arguments;
  if (innerInputValue === undefined || innerInputValue === null) {
    innerInputValue = {};
  } else if (typeof innerInputValue === "string") {
    try {
      innerInputValue = JSON.parse(innerInputValue);
    } catch {
      return canonicalToolName(innerTool)
        ? { tool: innerTool, input: {}, invalidProtectedInput: true }
        : undefined;
    }
  }
  const innerInput = asRecord(innerInputValue);
  if (!innerInput) {
    return canonicalToolName(innerTool)
      ? { tool: innerTool, input: {}, invalidProtectedInput: true }
      : undefined;
  }
  return { tool: innerTool, input: innerInput };
}

function trustedBoundaryProducerTool(record: JsonRecord): string | undefined {
  const outerTool = nonEmptyString(record.tool_name);
  if (!outerTool) return undefined;
  if (outerTool === "tool_call") {
    const innerTool = nonEmptyString(asRecord(record.tool_input)?.name);
    if (!innerTool?.startsWith(AGENT_BOOST_MCP_PREFIX)) return undefined;
    const tool = innerTool.slice(AGENT_BOOST_MCP_PREFIX.length);
    return BOUNDARY_PRODUCER_TOOLS.has(tool) ? tool : undefined;
  }
  if (outerTool.startsWith(AGENT_BOOST_MCP_PREFIX)) {
    const tool = outerTool.slice(AGENT_BOOST_MCP_PREFIX.length);
    return BOUNDARY_PRODUCER_TOOLS.has(tool) ? tool : undefined;
  }
  return undefined;
}

function trustedStatusProducerTool(record: JsonRecord): string | undefined {
  const outerTool = nonEmptyString(record.tool_name);
  if (!outerTool) return undefined;
  if (outerTool === "tool_call") {
    const innerTool = nonEmptyString(asRecord(record.tool_input)?.name);
    if (!innerTool?.startsWith(AGENT_BOOST_MCP_PREFIX)) return undefined;
    const tool = innerTool.slice(AGENT_BOOST_MCP_PREFIX.length);
    return STATUS_RESULT_PRODUCER_TOOLS.has(tool) ? tool : undefined;
  }
  if (outerTool.startsWith(AGENT_BOOST_MCP_PREFIX)) {
    const tool = outerTool.slice(AGENT_BOOST_MCP_PREFIX.length);
    return STATUS_RESULT_PRODUCER_TOOLS.has(tool) ? tool : undefined;
  }
  return undefined;
}

function agentBoostInvocationTool(record: JsonRecord): string | undefined {
  const outerTool = nonEmptyString(record.tool_name);
  if (!outerTool) return undefined;
  if (outerTool === "tool_call") {
    const innerTool = nonEmptyString(asRecord(record.tool_input)?.name);
    return innerTool?.startsWith(AGENT_BOOST_MCP_PREFIX)
      ? innerTool.slice(AGENT_BOOST_MCP_PREFIX.length)
      : undefined;
  }
  return outerTool.startsWith(AGENT_BOOST_MCP_PREFIX)
    ? outerTool.slice(AGENT_BOOST_MCP_PREFIX.length)
    : undefined;
}

function sameRoutedTransferArguments(
  input: JsonRecord,
  expected: StableBinding,
): boolean {
  const keys = Object.keys(input).sort();
  const expectedKeys = Object.keys(expected).sort();
  return keys.length === expectedKeys.length &&
    keys.every((key, index) =>
      key === expectedKeys[index] && input[key] === expected[key]
    );
}

function routedTransferDirective(
  record: JsonRecord,
  routed: RoutedTransfer,
): HermesTurnGateResponse | undefined {
  const tool = agentBoostInvocationTool(record);
  if (!tool) return undefined;
  const expectedArguments = routed.binding;
  if (routed.tool === "$clarify_status_followup") {
    return {
      action: "block",
      message:
        "Agent Boost has no trusted unresolved setup or operation for this status " +
        "follow-up. No Agent Boost tool may be called yet. Ask which setup or " +
        "operation the user wants checked; do not start, retry, or replace anything.",
    };
  }
  if (routed.tool === "$clarify_private_balance_fund") {
    return {
      action: "block",
      message:
        "The user asked to fund a private balance using an unresolved pronoun. " +
        "No Agent Boost tool may be called yet. Ask which private balance should " +
        "receive the funds; do not invent a target or fund any wallet.",
    };
  }
  if (routed.tool === "$clarify_private_balance_policy") {
    return {
      action: "block",
      message:
        "The private-balance policy request is missing one exact child target, a " +
        "concrete setting, or an explicit read/change instruction, or it requested " +
        "an unsupported bulk change. No Agent Boost tool may be called yet. Ask only " +
        "for the missing friendly name, parent wallet, setting, or instruction; do " +
        "not invent a target or apply a bulk change.",
    };
  }
  if (routed.tool === "$clarify_wallet_graph_create") {
    return {
      action: "block",
      message:
        "The user requested a new wallet and child balance without both exact names. " +
        "No Agent Boost tool may be called yet. Ask for the missing friendly name; " +
        "do not invent a wallet or private-balance name.",
    };
  }
  if (routed.tool === "$clarify_wallet_policy") {
    return {
      action: "block",
      message:
        "The wallet-policy request did not specify a setting together with an " +
        "explicit instruction to read or change it. No Agent Boost tool may be " +
        "called yet. Ask for the missing instruction or which send count, per-send " +
        "limit, total limit, expiry, or enabled state they want to change.",
    };
  }
  if (tool !== routed.tool) {
    return {
      action: "block",
      message:
        `Agent Boost pinned this user request to ${routed.tool}` +
        `${routed.arguments_pinned ? ` with arguments ${JSON.stringify(expectedArguments)}` : ""}. ` +
        "The different Agent Boost " +
        "tool was blocked without applying any wallet action. Call only the pinned tool now.",
    };
  }
  if (!routed.arguments_pinned) return undefined;
  const invocation = toolInvocation(record);
  if (invocation && sameRoutedTransferArguments(invocation.input, expectedArguments)) {
    return undefined;
  }
  const outerInput = asRecord(record.tool_input) ?? {};
  return {
    action: "modify",
    args: record.tool_name === "tool_call"
      ? { ...outerInput, arguments: expectedArguments }
      : expectedArguments,
  };
}

function routedSavedWalletChoiceDirective(
  record: JsonRecord,
  routed: RoutedSavedWalletChoice,
): HermesTurnGateResponse | undefined {
  const tool = agentBoostInvocationTool(record);
  if (!tool) return undefined;
  const expectedArguments = { wallet_name: routed.wallet_name };
  if (tool !== "wallet_preview_saved_profile_load") {
    return {
      action: "block",
      message:
        "Agent Boost pinned this saved-wallet choice to " +
        `wallet_preview_saved_profile_load with arguments ${JSON.stringify(expectedArguments)}. ` +
        "The different Agent Boost tool was blocked without changing any wallet. " +
        "Call the pinned preview now.",
    };
  }
  const invocation = toolInvocation(record);
  if (
    invocation &&
    Object.keys(invocation.input).length === 1 &&
    invocation.input.wallet_name === routed.wallet_name
  ) {
    return undefined;
  }
  const outerInput = asRecord(record.tool_input) ?? {};
  return {
    action: "modify",
    args: record.tool_name === "tool_call"
      ? { ...outerInput, arguments: expectedArguments }
      : expectedArguments,
  };
}

function invocationBinding(tool: ConfirmationTool, input: JsonRecord): StableBinding | undefined {
  if (
    tool === "wallet_apply_reauthorization" ||
    tool === "wallet_apply_policy_update" ||
    tool === "wallet_apply_private_balance_create" ||
    tool === "wallet_apply_private_balance_fund" ||
    tool === "wallet_apply_private_balance_policy_update" ||
    tool === "wallet_execute_regular_transfer" ||
    tool === "wallet_execute_private_transfer" ||
    tool === "wallet_execute_recovery_transfer"
  ) {
    const decisionId = nonEmptyString(input.decision_id);
    return decisionId ? { decision_id: decisionId } : undefined;
  }
  const activeBinding = invocationActiveWalletBinding(input);
  if (tool === "wallet_start_new_demo") return activeBinding;
  const walletName = walletNameBinding(input);
  if (!walletName) return undefined;
  if (tool === "wallet_archive") return { wallet_name: walletName };
  if (activeBinding === undefined) {
    return undefined;
  }
  if (tool === "wallet_create" || tool === "wallet_adopt_existing") {
    return {
      name: walletName,
      ...activeBinding,
    };
  }
  return {
    wallet_name: walletName,
    ...activeBinding,
  };
}

function sameBinding(left: StableBinding, right: StableBinding): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

async function restoreClaim(claimPath: string, pendingPath: string): Promise<void> {
  try {
    await link(claimPath, pendingPath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  } finally {
    await unlink(claimPath).catch(() => undefined);
  }
}

type ClaimResult =
  | "allowed"
  | "absent"
  | "invalid"
  | "same_turn"
  | "mismatch"
  | "decision_absent"
  | "decision_invalid"
  | "decision_mismatch"
  | "raced";

async function claimMatchingContinuation(
  stateDirectory: string,
  identity: TurnIdentity,
  tool: ConfirmationTool,
  binding: StableBinding | undefined,
  userConfirmed: boolean,
  now: number,
  beforeCommit?: () => Promise<void>,
): Promise<ClaimResult> {
  const pendingPath = join(stateDirectory, continuationName(identity));
  const decisionPath = join(stateDirectory, userDecisionName(identity));
  const initial = await readPendingContinuation(stateDirectory, identity, now);
  if (initial.status !== "active") return initial.status;
  if (initial.value.preview_turn_hash === turnHash(identity)) return "same_turn";
  if (
    initial.value.tool !== tool ||
    !binding ||
    !sameBinding(initial.value.binding, binding)
  ) {
    return "mismatch";
  }

  const initialDecision = await readUserDecision(stateDirectory, identity, now);
  if (initialDecision.status === "absent") return "decision_absent";
  if (initialDecision.status === "invalid") return "decision_invalid";
  if (
    initialDecision.value.decision_turn_hash !== turnHash(identity) ||
    initialDecision.value.preview_turn_hash !== initial.value.preview_turn_hash ||
    initialDecision.value.tool !== tool ||
    initialDecision.value.user_confirmed !== userConfirmed ||
    !sameBinding(initialDecision.value.binding, initial.value.binding)
  ) {
    return "decision_mismatch";
  }

  // Rename the continuation first: it is the one-shot serialization point, so
  // parallel model calls cannot both consume one real user decision.
  const pendingClaimPath = join(
    stateDirectory,
    `.claim-pending-${digest(["session", identity.sessionId])}-${randomUUID()}.json`,
  );
  try {
    await rename(pendingPath, pendingClaimPath);
  } catch (error) {
    return isFileNotFound(error) ? "raced" : "invalid";
  }

  const claimed = await readState(pendingClaimPath, parsePendingContinuation, now);
  if (claimed.status !== "active") {
    if (claimed.status === "invalid") await restoreClaim(pendingClaimPath, pendingPath);
    return claimed.status;
  }
  if (
    claimed.value.preview_turn_hash === turnHash(identity) ||
    claimed.value.tool !== tool ||
    !binding ||
    !sameBinding(claimed.value.binding, binding)
  ) {
    await restoreClaim(pendingClaimPath, pendingPath);
    return claimed.value.preview_turn_hash === turnHash(identity) ? "same_turn" : "mismatch";
  }

  const decisionClaimPath = join(
    stateDirectory,
    `.claim-decision-${turnHash(identity)}-${randomUUID()}.json`,
  );
  try {
    await rename(decisionPath, decisionClaimPath);
  } catch (error) {
    await restoreClaim(pendingClaimPath, pendingPath);
    return isFileNotFound(error) ? "raced" : "decision_invalid";
  }
  const claimedDecision = await readState(
    decisionClaimPath,
    parseUserDecisionMarker,
    now,
  );
  if (
    claimedDecision.status !== "active" ||
    claimedDecision.value.decision_turn_hash !== turnHash(identity) ||
    claimedDecision.value.preview_turn_hash !== claimed.value.preview_turn_hash ||
    claimedDecision.value.tool !== tool ||
    claimedDecision.value.user_confirmed !== userConfirmed ||
    !sameBinding(claimedDecision.value.binding, claimed.value.binding)
  ) {
    await restoreClaim(pendingClaimPath, pendingPath);
    if (claimedDecision.status === "invalid") {
      await restoreClaim(decisionClaimPath, decisionPath);
      return "decision_invalid";
    }
    if (claimedDecision.status === "active") {
      await restoreClaim(decisionClaimPath, decisionPath);
      return "decision_mismatch";
    }
    return "decision_absent";
  }

  if (beforeCommit) {
    try {
      // The recovery marker and the one-shot claim are one logical commit. If
      // staging the marker fails, restore both pieces of authority so the
      // authenticated approval is not silently consumed by a blocked call.
      await beforeCommit();
    } catch {
      let restoreError: unknown;
      try {
        await restoreClaim(pendingClaimPath, pendingPath);
      } catch (error) {
        restoreError = error;
      }
      try {
        await restoreClaim(decisionClaimPath, decisionPath);
      } catch (error) {
        restoreError ??= error;
      }
      if (restoreError) throw restoreError;
      return "invalid";
    }
  }

  await Promise.all([unlink(pendingClaimPath), unlink(decisionClaimPath)]);
  return "allowed";
}

type AllowModeTransferClaimResult =
  | "allowed"
  | "absent"
  | "invalid"
  | "stale"
  | "mismatch"
  | "consumed"
  | "raced";

async function claimAllowModeTransferExecution(
  stateDirectory: string,
  identity: TurnIdentity,
  tool: string | undefined,
  input: JsonRecord,
  now: number,
  beforeCommit: () => Promise<void>,
): Promise<AllowModeTransferClaimResult> {
  const markerPath = join(stateDirectory, allowModeTransferName(identity));
  const claimPath = join(stateDirectory, allowModeTransferClaimName(identity));
  const initial = await readAllowModeTransferExecution(stateDirectory, identity, now);
  if (initial.status !== "active") return initial.status;
  if (initial.value.preview_turn_hash !== turnHash(identity)) return "stale";
  if (initial.value.state === "consumed") return "consumed";
  if (
    tool !== initial.value.tool ||
    !sameRoutedTransferArguments(input, { decision_id: initial.value.decision_id })
  ) {
    return "mismatch";
  }

  // Keep the active marker in place while using a deterministic hard-link as
  // the one-shot lock. Parallel pre-tool calls can never both claim one plan.
  try {
    await link(markerPath, claimPath);
  } catch (error) {
    if (isFileNotFound(error) ||
      (error instanceof Error && "code" in error && error.code === "EEXIST")) {
      return "raced";
    }
    return "invalid";
  }
  const claimed = await readState(claimPath, parseAllowModeTransferExecution, now);
  if (
    claimed.status !== "active" ||
    claimed.value.state !== "active" ||
    claimed.value.preview_turn_hash !== turnHash(identity) ||
    claimed.value.tool !== tool ||
    !sameRoutedTransferArguments(input, { decision_id: claimed.value.decision_id })
  ) {
    await unlink(claimPath).catch(() => undefined);
    if (claimed.status === "invalid") return "invalid";
    if (claimed.status === "absent") return "raced";
    return claimed.value.state === "consumed" ? "consumed" : "mismatch";
  }

  const consumed: AllowModeTransferExecution = {
    ...claimed.value,
    state: "consumed",
  };
  let temporary: string;
  try {
    temporary = await writePrivateTemporary(stateDirectory, consumed);
  } catch {
    await unlink(claimPath).catch(() => undefined);
    return "invalid";
  }
  try {
    // The consumed tombstone is the irreversible one-shot serialization
    // point. A replayed preview post-hook cannot republish over it.
    await rename(temporary, markerPath);
    try {
      await beforeCommit();
    } catch {
      // Restore the original active inode atomically when dispatch provenance
      // cannot be staged, so a hook/storage failure never burns the plan.
      await rename(claimPath, markerPath);
      return "invalid";
    }
    await unlink(claimPath).catch(() => undefined);
    return "allowed";
  } catch {
    await unlink(claimPath).catch(() => undefined);
    return "invalid";
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function pruneExpiredState(stateDirectory: string, now: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(stateDirectory);
  } catch (error) {
    if (isFileNotFound(error)) return;
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    const parser = NESTED_FORK_TURN_PATTERN.test(entry)
      ? parseNestedForkTurnMarker
      : ROOT_TURN_PATTERN.test(entry)
        ? parseRootTurnMarker
        : TURN_MARKER_PATTERN.test(entry)
        ? parseBoundaryMarker
        : CONTINUATION_PATTERN.test(entry)
        ? parsePendingContinuation
        : USER_DECISION_PATTERN.test(entry)
          ? parseUserDecisionMarker
        : DEFERRED_TRANSFER_PATTERN.test(entry)
            ? parseDeferredTransfer
            : PENDING_STATUS_READ_PATTERN.test(entry)
              ? parsePendingStatusRead
              : PENDING_DISPATCH_STATUS_PATTERN.test(entry)
                ? parsePendingDispatchStatus
            : ROUTED_TRANSFER_PATTERN.test(entry)
              ? parseRoutedTransfer
              : ALLOW_MODE_TRANSFER_PATTERN.test(entry) ||
                  ALLOW_MODE_TRANSFER_CLAIM_PATTERN.test(entry)
                ? parseAllowModeTransferExecution
              : SAVED_WALLET_SELECTION_PATTERN.test(entry)
                ? parseSavedWalletSelection
                : ROUTED_WALLET_CHOICE_PATTERN.test(entry)
                  ? parseRoutedSavedWalletChoice
              : undefined;
    if (!parser) return;
    const path = join(stateDirectory, entry);
    try {
      const state = parser(JSON.parse(await readFile(path, "utf8")));
      if (state && state.expires_at_ms <= now) await unlink(path).catch(() => undefined);
    } catch {
      // Corrupt security state remains in place so a matching operation fails
      // closed instead of silently forgetting its confirmation boundary.
    }
  }));
}

function boundaryBlock(marker: BoundaryMarker): HermesTurnGateResponse {
  const instruction =
    "Agent Boost ended tool use for this assistant turn after producing the complete " +
    "user-facing response or a confirmation preview. No later user chat message exists " +
    "yet. Do not call another tool or treat this as an error. Return the prior response " +
    "now and wait for a new user message.";
  const rendered = nonEmptyString(marker.rendered_response);
  return {
    action: "block",
    message: rendered ? `${instruction}\n\nPrior response:\n${rendered}` : instruction,
  };
}

function identityUnavailableBlock(): HermesTurnGateResponse {
  return {
    action: "block",
    message:
      "Agent Boost could not verify the Hermes session and turn identity, so this tool " +
      "call was blocked. No wallet action was applied.",
  };
}

function nestedAgentBoostInvocationBlock(): HermesTurnGateResponse {
  return {
    action: "block",
    message:
      "Agent Boost blocked this wallet tool call because it came from a nested " +
      "Hermes review or task fork, not the root user turn. No wallet action was " +
      "applied and no confirmation authority was consumed.",
  };
}

function unclassifiedAgentBoostInvocationBlock(): HermesTurnGateResponse {
  return {
    action: "block",
    message:
      "Agent Boost blocked this wallet tool call because the native Hermes " +
      "turn classification was missing or invalid. No wallet action was " +
      "applied and no confirmation authority was consumed. Start a fresh " +
      "user turn before retrying.",
  };
}

function continuationBlock(result: Exclude<ClaimResult, "allowed">): HermesTurnGateResponse {
  const detail = result === "same_turn"
    ? "The matching preview was created in this same assistant turn, not before the current user message."
    : result === "mismatch"
      ? "The tool or stable arguments do not match the preview that the user was shown."
      : result === "decision_absent"
        ? "The actual user message for this turn was not an unambiguous approval or rejection of that preview."
        : result === "decision_mismatch"
          ? "The requested confirmation value does not match the approval or rejection in the actual user message for this turn."
          : result === "decision_invalid"
            ? "The authenticated user-decision state for this turn could not be validated."
      : result === "raced"
        ? "This one-shot confirmation was already claimed by another tool call."
        : result === "invalid"
          ? "The saved confirmation provenance could not be validated."
          : "No matching unconsumed preview from an earlier user turn exists.";
  return {
    action: "block",
    message:
      `Agent Boost blocked this confirmation-required wallet action. ${detail} ` +
      "No wallet action was applied. If the user still wants this action, create a fresh " +
      "preview without asserting confirmation, show it in chat, and wait for a later user reply.",
  };
}

function allowModeTransferBlock(
  result: Exclude<AllowModeTransferClaimResult, "allowed">,
): HermesTurnGateResponse {
  const detail = result === "mismatch"
    ? "The execute tool or decision does not match the allow-policy preview from this turn."
    : result === "consumed" || result === "raced"
      ? "That allow-policy preview was already claimed by another execute call."
      : result === "stale"
        ? "The allow-policy preview belongs to a different assistant turn."
        : result === "invalid"
          ? "The allow-policy preview provenance could not be validated."
          : "No trusted allow-policy preview from this assistant turn authorizes it.";
  return {
    action: "block",
    message:
      `Agent Boost blocked this confirmation-omitted transfer execution. ${detail} ` +
      "No wallet action was applied. Create one fresh transfer preview for the current " +
      "request; execute only its exact same-turn allow decision.",
  };
}

function allowModePostDispatchBlock(): HermesTurnGateResponse {
  return {
    action: "block",
    message:
      "Agent Boost already dispatched this assistant turn's one exact allow-policy " +
      "transfer. This duplicate or unrelated Agent Boost call was blocked without " +
      "applying another wallet action, and the original transfer's status-recovery " +
      "handle was preserved. Wait for a new user message before checking its status " +
      "or starting another wallet action.",
  };
}

function invalidProtectedInvocationBlock(): HermesTurnGateResponse {
  return {
    action: "block",
    message:
      "Agent Boost could not validate the protected tool arguments in this Hermes " +
      "bridge call. The call was blocked and no wallet action was applied.",
  };
}

function isTransferConfirmationTool(tool: ConfirmationTool): boolean {
  return tool === "wallet_execute_regular_transfer" ||
    tool === "wallet_execute_private_transfer" ||
    tool === "wallet_execute_recovery_transfer";
}

function authenticatedUserDecision(
  message: unknown,
  tool: ConfirmationTool,
): boolean | undefined {
  if (typeof message !== "string" || message.length > 160) return undefined;
  const normalized = message
    .normalize("NFKC")
    .replace(/[\uFE0E\uFE0F]/gu, "")
    .trim()
    .toLowerCase();
  if (!normalized || normalized.includes("?") || /[\r\n]/u.test(normalized)) {
    return undefined;
  }
  const genericApproval = /^(?:yes(?:,?\s+(?:please|go ahead|approve\s+it))?|approve(?: it)?|approved|confirm(?: it)?|proceed(?: please)?|please proceed|authorize(?: it)?|go ahead|do it|please do|sure|ok(?:ay)?|looks good|sounds good|(?:✅|👍))[.!]*$/u;
  const genericRejection = /^(?:no(?:,?\s+(?:thanks|cancel(?:\s+it)?|stop|keep\s+it\s+as[- ]is|leave\s+it\s+unchanged))?|nope|nah|abort|cancel(?: it| please)?|decline(?: it)?|reject(?: it)?|stop|leave\s+it\s+unchanged|(?:do not|don['’]t) (?:proceed|do it|apply it)|never mind|✕|❌)[.!]*$/u;
  let scopedApproval: RegExp | undefined;
  let scopedRejection: RegExp | undefined;
  if (isTransferConfirmationTool(tool)) {
    scopedApproval = /^(?:(?:i\s+)?(?:approve|authorize|confirm)(?:\s+it|\s+the)?\s+(?:regular\s+|private\s+|recovery\s+)?(?:transfer|send|payment)|confirm\s+(?:it|the\s+(?:regular\s+|private\s+|recovery\s+)?(?:transfer|payment))|confirm\s+yes\s+send|yes,?\s+send\s+it|send\s+it|(?:✅|👍)\s+(?:authorize|send\s+it|(?:regular\s+|private\s+|recovery\s+)?(?:transfer|payment)))[.!]*$/u;
    scopedRejection = /^(?:cancel\s+(?:the\s+)?(?:regular\s+|private\s+|recovery\s+)?(?:transfer|send|payment)|(?:do not|don['’]t)\s+(?:send(?:\s+it)?|authorize|confirm\s+the\s+(?:transfer|payment)))[.!]*$/u;
  } else if (tool === "wallet_apply_saved_profile_load") {
    scopedApproval = /^(?:(?:i\s+)?approve\s+(?:the\s+)?(?:switch|load)|yes,?\s+(?:switch\s+wallets?|load\s+it)|(?:✅|👍)\s+(?:switch\s+wallets?|load\s+it))[.!]*$/u;
    scopedRejection = /^(?:cancel\s+(?:the\s+)?(?:wallet\s+)?(?:switch|load)|(?:do not|don['’]t)\s+(?:switch(?:\s+wallets?)?|load(?:\s+it|\s+the\s+wallet)?))[.!]*$/u;
  } else if (tool === "wallet_apply_reauthorization") {
    scopedApproval = /^(?:(?:i\s+)?approve\s+(?:the\s+)?reauthorization|(?:i\s+)?authorize\s+(?:the\s+)?wallet|reauthorize(?:\s+it)?|(?:✅|👍)\s+(?:authorize(?:\s+it|\s+wallet)?|reauthorize))[.!]*$/u;
    scopedRejection = /^(?:cancel\s+(?:the\s+)?(?:wallet\s+)?(?:reauthorization|authorization)|(?:do not|don['’]t)\s+(?:authorize(?:\s+the\s+wallet)?|reauthorize(?:\s+it)?))[.!]*$/u;
  } else if (
    tool === "wallet_apply_policy_update" ||
    tool === "wallet_apply_private_balance_policy_update"
  ) {
    scopedApproval = /^(?:(?:i\s+)?approve\s+(?:the\s+)?(?:policy|permission)(?:\s+update)?|yes,?\s+apply\s+it|(?:✅|👍)\s+(?:apply\s+it|(?:policy|permission)(?:\s+update)?))[.!]*$/u;
    scopedRejection = /^(?:cancel\s+(?:the\s+)?(?:policy|permission)(?:\s+(?:change|update))?|(?:do not|don['’]t)\s+apply\s+(?:it|the\s+(?:policy|permission)(?:\s+(?:change|update))?))[.!]*$/u;
  } else if (tool === "wallet_apply_private_balance_create") {
    scopedApproval = /^(?:yes,?\s+create\s+(?:it|the\s+(?:private\s+)?(?:balance|pocket))|create\s+it|(?:✅|👍)\s+create\s+it)[.!]*$/u;
    scopedRejection = /^(?:cancel\s+(?:the\s+)?(?:private[- ]balance|private\s+pocket)\s+creat(?:e|ion)|(?:do not|don['’]t)\s+create\s+(?:it|the\s+(?:private\s+)?(?:balance|pocket)))[.!]*$/u;
  } else if (tool === "wallet_apply_private_balance_fund") {
    scopedApproval = /^(?:(?:(?:yes,?|✅|👍)\s+)?fund\s+it(?:\s+exactly\s+as\s+(?:previewed|shown|planned))?|(?:i\s+)?approve\s+(?:the\s+)?(?:private[- ]balance\s+)?funding)[.!]*$/u;
    scopedRejection = /^(?:cancel\s+(?:the\s+)?(?:private[- ]balance\s+)?funding|(?:do not|don['’]t)\s+fund\s+it)[.!]*$/u;
  } else if (tool === "wallet_create") {
    scopedApproval = /^(?:yes,?\s+create\s+it|(?:✅|👍)\s+create\s+it)[.!]*$/u;
    scopedRejection = /^(?:cancel\s+(?:the\s+)?(?:wallet\s+)?creat(?:e|ion)|(?:do not|don['’]t)\s+create(?:\s+it|\s+the\s+wallet)?)[.!]*$/u;
  } else if (tool === "wallet_adopt_existing") {
    scopedApproval = /^(?:yes,?\s+adopt\s+it|(?:✅|👍)\s+adopt\s+it)[.!]*$/u;
    scopedRejection = /^(?:cancel\s+(?:the\s+)?(?:wallet\s+)?adoption|(?:do not|don['’]t)\s+adopt(?:\s+it|\s+the\s+wallet)?)[.!]*$/u;
  } else if (tool === "wallet_archive") {
    scopedApproval = /^(?:yes,?\s+archive\s+it|(?:✅|👍)\s+archive\s+it)[.!]*$/u;
    scopedRejection = /^(?:cancel\s+(?:the\s+)?(?:wallet\s+)?archiv(?:e|ing)|(?:do not|don['’]t)\s+archive(?:\s+it|\s+the\s+wallet)?)[.!]*$/u;
  } else if (tool === "wallet_start_new_demo") {
    scopedApproval = /^(?:yes,?\s+(?:reset|start)\s+it|(?:✅|👍)\s+(?:reset|start)\s+it)[.!]*$/u;
    scopedRejection = /^(?:cancel\s+(?:the\s+)?(?:wallet\s+)?reset|(?:do not|don['’]t)\s+(?:reset|start)(?:\s+it|\s+a\s+new\s+demo)?)[.!]*$/u;
  }
  const privateBalancePolicyApproval =
    tool === "wallet_apply_private_balance_policy_update" &&
    /^(?:(?:✅|👍)\s+)?(?:i\s+)?approve\s+(?:this\s+policy\s+(?:change|update)|(?:this|the)\s+(?:child[- ]policy|private[- ]balance\s+policy)\s+(?:change|update))[.!]*$/u.test(
      normalized,
    );
  const approves = genericApproval.test(normalized) ||
    scopedApproval?.test(normalized) === true || privateBalancePolicyApproval;
  const rejects = genericRejection.test(normalized) || scopedRejection?.test(normalized) === true;
  return approves === rejects ? undefined : approves;
}

function continuationContext(
  pending: PendingContinuation,
  userConfirmed: boolean,
): string {
  const argumentsJson = JSON.stringify({
    ...pending.binding,
    user_confirmed: userConfirmed,
  });
  return userConfirmed
    ? `Agent Boost authenticated this turn's actual user message as approval of the pending preview. Your first and only response action is to call exactly ${pending.tool} once with arguments ${argumentsJson}. Make that tool call now, before writing any user-facing text. A text-only acknowledgement does not execute the action and must never claim it was sent, submitted, applied, or started. Do not replan, switch tools, or change any argument.`
    : `Agent Boost authenticated this turn's actual user message as rejection of the pending preview. Your first and only response action is to call exactly ${pending.tool} once with arguments ${argumentsJson}. Make that tool call now, before writing any user-facing text. A text-only acknowledgement does not cancel the action and must never claim it was cancelled. Do not apply the action, replan, switch tools, or change any argument.`;
}

function deferredTransferPreviewTool(mode: DeferredTransferMode): string {
  return mode === "regular"
    ? "wallet_preview_regular_transfer"
    : mode === "private"
      ? "wallet_preview_private_transfer"
      : "wallet_preview_recovery_transfer";
}

function deferredContinuationContext(
  pending: PendingContinuation,
  deferred: DeferredTransfer,
  userConfirmed: boolean,
): string {
  if (!userConfirmed) return "";
  const transferArguments = JSON.stringify({
    source: deferred.source,
    ...(deferred.source_private_balance === undefined
      ? {}
      : { source_private_balance: deferred.source_private_balance }),
    destination: deferred.destination,
    amount_native: deferred.amount_native,
  });
  if (
    deferred.stage === "source_switch" &&
    pending.tool === "wallet_apply_saved_profile_load" &&
    pending.preview_turn_hash === deferred.source_preview_turn_hash &&
    pending.binding.wallet_name === deferred.source
  ) {
    return ` This switch is part of a deferred ${deferred.mode} transfer with canonical arguments ${transferArguments}. A successful wallet_apply_saved_profile_load normally returns the reauthorization preview itself. If it does, show that signed preview and stop this assistant turn; do not call wallet_plan_reauthorization again. Only if its truthful WALLET_SELECTED fallback says the automatic preview was unavailable should you call wallet_plan_reauthorization in this same assistant turn. If the result instead says bounded authorization remains active, call ${deferredTransferPreviewTool(deferred.mode)} with those exact arguments in this same assistant turn. Preserve the exact transfer arguments and never replace either canonical wallet name with $selected or a conversational alias.`;
  }
  if (
    deferred.stage === "reauthorization" &&
    pending.tool === "wallet_apply_reauthorization" &&
    pending.binding.decision_id === deferred.reauthorization_decision_id
  ) {
    return ` Only if that exact authorization succeeds, call exactly ${deferredTransferPreviewTool(deferred.mode)} once in this same assistant turn with arguments ${transferArguments}. This second call is a preview only: show its signed confirmation and end the assistant turn. Do not replace either canonical wallet name with $selected or a conversational alias.`;
  }
  return "";
}

function savedWalletLoadReference(
  message: string,
): { kind: "specific" | "generic"; reference: string } | undefined {
  if (
    /\b(?:do\s+not|don['’]t|never)\s+(?:load|open|select|use|switch(?:\s+to)?)\b/iu
      .test(message)
  ) {
    return undefined;
  }
  const match = message.match(
    /\b(load|open|select|use|switch\s+to)\b((?:[^.!?]|\.(?=[a-z0-9])){1,128})/iu,
  );
  if (!match) return undefined;
  const action = (match[1] ?? "").toLowerCase();
  const tail = (match[2] ?? "").trim();
  if (
    action === "use" &&
    /^(?:(?:only|exactly)\s+)*(?:(?:(?:the|this)\s+)?agent[ -]boost\s+tool|(?:the|this)\s+tool)\b/iu
      .test(tail)
  ) {
    // `Use the Agent Boost tool ...` is tool-selection syntax, including when
    // the following identifier is misspelled. Never reinterpret it as a
    // saved-wallet friendly name. Explicit wallet wrappers below remain legal.
    return undefined;
  }
  // Selecting/loading already makes the named profile active. Treat common
  // restatements of that effect as request syntax, not as part of the friendly
  // name. Without this, `load wallet agent-boost and make it active` was pinned
  // to the impossible literal name `agent-boost and make it active`, even when
  // the wallet tree had just returned the exact `agent-boost` label.
  const actionableTail = tail.replace(
    /(?:(?:\s*[,;:]\s*|\s+)and\s+)(?:(?:make|set)\s+(?:it|that|this)(?:\s+as)?\s+(?:the\s+)?(?:active|current|selected)(?:\s+(?:wallet|profile|account))?|(?:activate|load|open|select|use|switch\s+to)\s+(?:it|that|this))(?:\s+(?:please|now))*\s*$/iu,
    "",
  ).trimEnd();
  const quotedName = String.raw`["'\u2018\u201c]?[a-z0-9][a-z0-9._-]{0,63}["'\u2019\u201d]?`;
  const exactFriendlyName = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const candidate = value.trim();
    const pairs = new Map([
      ['"', '"'],
      ["'", "'"],
      ["\u2018", "\u2019"],
      ["\u201c", "\u201d"],
    ]);
    const closing = pairs.get(candidate[0] ?? "");
    const unquoted = closing && candidate.endsWith(closing)
      ? candidate.slice(1, -1)
      : candidate;
    return /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(unquoted)
      ? unquoted
      : undefined;
  };
  // A natural wrapper around an exact friendly name is stronger than the
  // generic wording inside that wrapper. Pin only the name so a weak model
  // cannot turn `my saved wallet named agent-boost` into a literal profile
  // lookup for that whole sentence fragment. Parse this before trimming
  // politeness so friendly names such as `now` and `please` remain valid when
  // the user explicitly introduces them with `named` or `called`.
  const explicitlyNamed = actionableTail.match(
    new RegExp(
      `^(?:(?:my|the|a|an)\\s+)?(?:(?:saved|existing|previous|old|previously\\s+set\\s+up)\\s+)*(?:wallet|profile|account)\\s+(?:(?:named|called)(?:\\s+exactly)?|with\\s+(?:the\\s+)?name(?:\\s+of)?)\\s+(${quotedName})(?:(?:\\s*[,;:]\\s*|\\s+)(?:please|now))*(?:\\s*[,;:]?)?$`,
      "iu",
    ),
  );
  const explicitName = exactFriendlyName(explicitlyNamed?.[1]);
  if (explicitName !== undefined) {
    return { kind: "specific", reference: explicitName };
  }
  // Request politeness is not part of a saved profile's friendly name. Trim
  // whitespace- or punctuation-delimited suffixes while preserving names such
  // as `please-wallet`, `travel_now`, and `travel.wallet` exactly.
  const reference = actionableTail.replace(
    /(?:(?:\s*[,;:]\s*|\s+)(?:please|now))+(?:\s*[,;:]?)?$/iu,
    "",
  ).trimEnd();
  const positionallyNamed = reference.match(
    new RegExp(
      `^(?:(?:my|the|a|an)\\s+)?(?:(?:saved|existing)\\s+)?(?:wallet|profile|account)\\s+(${quotedName})$`,
      "iu",
    ),
  );
  const positionalName = exactFriendlyName(positionallyNamed?.[1]);
  if (positionalName !== undefined) {
    return { kind: "specific", reference: positionalName };
  }
  if (/^(?:(?:my|the)\s+)?agent[ -]boost\s+(?:wallet|profile|account)$/iu.test(reference)) {
    return { kind: "specific", reference: "agent-boost" };
  }
  const postfixedName = reference.match(
    new RegExp(
      `^(?:(?:my|the)\\s+)?(${quotedName})\\s+(?:wallet|profile|account)$`,
      "iu",
    ),
  );
  const postfixFriendlyName = exactFriendlyName(postfixedName?.[1]);
  const genericPostfixedNames = new Set([
    "a",
    "an",
    "any",
    "existing",
    "my",
    "old",
    "one",
    "previous",
    "saved",
    "some",
    "the",
  ]);
  if (
    postfixFriendlyName !== undefined &&
    !genericPostfixedNames.has(postfixFriendlyName.toLowerCase())
  ) {
    return { kind: "specific", reference: postfixFriendlyName };
  }
  const normalizedTail = reference.toLowerCase();
  const ambiguousSimpleTargets = new Set([
    "everything",
    "it",
    "page",
    "settings",
    "that",
    "this",
  ]);
  const simpleLifecyclePrefix = message
    .slice(0, match.index ?? 0)
    .normalize("NFKC")
    .toLowerCase()
    .trim();
  const exactSimpleLifecycle = ["load", "select", "switch to", "use"].includes(action) &&
    (simpleLifecyclePrefix === "" || simpleLifecyclePrefix === "please") &&
    exactFriendlyName(reference) !== undefined &&
    !ambiguousSimpleTargets.has(
      exactFriendlyName(reference)?.toLowerCase() ?? normalizedTail,
    );
  const hasWalletCue = /\b(?:wallets?|profiles?|accounts?|saved|existing|previous|previously|old)\b|[a-z0-9][_-][a-z0-9]/u
    .test(normalizedTail);
  if (
    !hasWalletCue && !exactSimpleLifecycle
  ) {
    return undefined;
  }
  if (/[a-z0-9][_-][a-z0-9]/u.test(normalizedTail)) {
    return {
      kind: "specific",
      reference: exactFriendlyName(reference) ?? reference,
    };
  }
  const genericWords = new Set([
    "a",
    "already",
    "an",
    "any",
    "before",
    "configured",
    "created",
    "existing",
    "have",
    "i",
    "my",
    "of",
    "old",
    "one",
    "please",
    "previous",
    "previously",
    "profile",
    "profiles",
    "saved",
    "set",
    "some",
    "that",
    "the",
    "up",
    "wallet",
    "wallets",
    "was",
    "account",
    "accounts",
  ]);
  const distinguishingWords = normalizedTail
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)
    .filter((word) => !genericWords.has(word));
  return {
    kind: distinguishingWords.length > 0 ? "specific" : "generic",
    reference,
  };
}

function savedWalletChoiceKey(value: string): string {
  const tokens = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  while (["please", "load", "open", "select", "use", "switch", "to"].includes(tokens[0] ?? "")) {
    tokens.shift();
  }
  if (tokens[0] === "my" || tokens[0] === "the") tokens.shift();
  while (["please", "now"].includes(tokens.at(-1) ?? "")) tokens.pop();
  if (["wallet", "profile", "account"].includes(tokens.at(-1) ?? "")) tokens.pop();
  return tokens.join("");
}

function selectedSavedWalletChoice(
  message: unknown,
  walletNames: readonly string[],
): string | undefined {
  if (typeof message !== "string" || message.length > 512) return undefined;
  const key = savedWalletChoiceKey(message);
  if (!key) return undefined;
  const matches = walletNames.filter((walletName) => savedWalletChoiceKey(walletName) === key);
  return matches.length === 1 ? matches[0] : undefined;
}

function compactNaturalRequest(message: string): string {
  return message
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim();
}

function walletAuthorizationArguments(message: string): StableBinding | undefined {
  const compact = compactNaturalRequest(message);
  if (
    /^(?:please\s+)?(?:authorize|reauthorize)(?:\s+it|\s+(?:(?:my|the)\s+)?(?:wallet|profile|account))?(?:\s+(?:please|now))*$/iu
      .test(compact) ||
    /^(?:please\s+)?(?:authorize|reauthorize)\s+(?:(?:my|the)\s+)?(?:active|current|selected)\s+(?:wallet|profile|account)(?:\s+(?:please|now))*$/iu
      .test(compact)
  ) {
    return {};
  }

  const patterns = [
    /^(?:please\s+)?(?:authorize|reauthorize)\s+(?:(?:my|the)\s+)?(?:wallet|profile|account)(?:\s+(?:(?:named|called)|with\s+(?:the\s+)?name(?:\s+of)?))?\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\s+(?:please|now))*$/iu,
    /^(?:please\s+)?(?:authorize|reauthorize)\s+(?:(?:my|the)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\s+(?:wallet|profile|account))?(?:\s+(?:please|now))*$/iu,
  ];
  const reservedTargets = new Set([
    "a",
    "active",
    "an",
    "current",
    "existing",
    "it",
    "load",
    "open",
    "payment",
    "policy",
    "private",
    "public",
    "recovery",
    "regular",
    "saved",
    "select",
    "selected",
    "send",
    "switch",
    "the",
    "transfer",
    "wallet",
  ]);
  for (const pattern of patterns) {
    const walletName = privateBalanceReference(compact.match(pattern)?.[1]);
    if (walletName && !reservedTargets.has(walletName.toLowerCase())) {
      return { wallet_name: walletName };
    }
  }
  return undefined;
}

function singleWalletCreationArguments(message: string): StableBinding | undefined {
  const compact = compactNaturalRequest(message);
  const reservedNames = new Set([
    "a",
    "an",
    "another",
    "even",
    "me",
    "my",
    "new",
    "the",
  ]);
  const patterns = [
    /^(?:please\s+)?(?:create|add|make|set\s+up)\s+(?:me\s+)?(?:(?:a|an)\s+)?(?:(?:another|new)\s+)?(?:top[- ]level\s+)?(?:wallet|profile)(?:\s+(?:named|called)|\s+with\s+(?:the\s+)?name(?:\s+of)?)?\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\s+(?:please|now))*$/iu,
    /^(?:please\s+)?(?:create|add|make|set\s+up)\s+(?:me\s+)?(?:(?:a|an)\s+)?(?:(?:another|new)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(?:wallet|profile)(?:\s+(?:please|now))*$/iu,
  ];
  for (const pattern of patterns) {
    const name = privateBalanceReference(compact.match(pattern)?.[1]);
    if (name && !reservedNames.has(name.toLowerCase())) return { name };
  }
  return undefined;
}

interface WalletGraphCreationArguments {
  walletName?: string;
  privateBalanceName?: string;
}

/**
 * Split a compound graph-creation request without carrying its second action
 * across the top-level wallet's setup boundary. Recognizing the entire shape
 * also keeps a weak model from treating `under it` as the current wallet.
 */
function walletGraphCreationArguments(
  message: string,
): WalletGraphCreationArguments | undefined {
  const compact = compactNaturalRequest(message);
  const match = compact.match(
    /^(.{1,192}?)(?:\s*[,;]\s*(?:(?:and\s+)?then|and)?\s+|\s+(?:and\s+then|and|then)\s+)(.{1,192})$/iu,
  );
  const parentClause = match?.[1]?.trim();
  const childClause = match?.[2]?.trim();
  if (
    !parentClause ||
    !childClause ||
    !/^(?:please\s+)?(?:create|add|make|set\s+up)\b[\s\S]*\b(?:wallet|profile)\b/iu.test(parentClause) ||
    !/^(?:please\s+)?(?:add|create|make|set\s+up)\b/iu.test(childClause) ||
    !/\b(?:private[- ]balance|private\s+(?:pocket|subwallet)|pocket|child)\b/iu.test(childClause) ||
    !/\b(?:under|inside|within|in)\s+(?:it|that\s+(?:one|wallet)|the\s+new\s+wallet)$/iu
      .test(childClause)
  ) {
    return undefined;
  }
  const walletName = privateBalanceReference(
    singleWalletCreationArguments(parentClause)?.name,
  );
  const childCreationClause = childClause.replace(
    /\s+(?:under|inside|within|in)\s+(?:it|that\s+(?:one|wallet)|the\s+new\s+wallet)$/iu,
    "",
  );
  const privateBalanceName = privateBalanceReference(
    privateBalanceCreationArguments(childCreationClause)?.private_balance_name,
  );
  return {
    ...(walletName === undefined ? {} : { walletName }),
    ...(privateBalanceName === undefined ? {} : { privateBalanceName }),
  };
}

function walletCreationArguments(message: string): StableBinding | undefined {
  const graph = walletGraphCreationArguments(message);
  if (graph) {
    return graph.walletName && graph.privateBalanceName
      ? { name: graph.walletName }
      : undefined;
  }
  return singleWalletCreationArguments(message);
}

function extractTrailingParentWallet(
  value: string,
): { body: string; walletName?: string } {
  const patterns = [
    /\s+(?:under|inside|within|in|for)\s+(?:(?:my|the)\s+)?(?:wallet|profile)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/iu,
    /\s+(?:under|inside|within|in|for)\s+(?:(?:my|the)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(?:wallet|profile)$/iu,
    /\s+(?:under|inside|within|in|for)\s+(?:(?:my|the)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/iu,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const walletName = privateBalanceReference(match?.[1]);
    if (match?.index !== undefined && walletName) {
      return { body: value.slice(0, match.index).trim(), walletName };
    }
  }
  return { body: value };
}

function extractPrivateBalanceCreationParent(
  value: string,
): { body: string; walletName?: string } {
  const existingRelation = extractTrailingParentWallet(value);
  if (existingRelation.walletName !== undefined) return existingRelation;
  const patterns = [
    /\s+to\s+(?:(?:my|the)\s+)?(?:wallet|profile)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/iu,
    /\s+to\s+(?:(?:my|the)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(?:wallet|profile)$/iu,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const walletName = privateBalanceReference(match?.[1]);
    if (match?.index !== undefined && walletName) {
      return { body: value.slice(0, match.index).trim(), walletName };
    }
  }
  return { body: value };
}

function privateBalanceNameFromClause(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value
    .trim()
    .replace(/^(?:(?:my|the|a|an|another|new)\s+)+/iu, "")
    .replace(/(?:\s+(?:please|now))+$/iu, "")
    .trim();
  const patterns = [
    /^(?:private[- ]balance|private\s+(?:pocket|subwallet)|shielded\s+(?:balance|pocket)|pocket|child)(?:\s+(?:named|called))?\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/iu,
    /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(?:private[- ]balance|private\s+(?:pocket|subwallet)|shielded\s+(?:balance|pocket)|pocket|child)$/iu,
    /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u,
  ];
  for (const pattern of patterns) {
    const name = privateBalanceReference(compact.match(pattern)?.[1]);
    if (name) return name;
  }
  return undefined;
}

function privateBalanceCreationArguments(message: string): StableBinding | undefined {
  // A sequenced request still has to stop at the first confirmation boundary.
  // Parse only the creation clause so "create reserve, then fund it" pins the
  // named create preview instead of degrading into an unpinned funding call.
  const compact = compactNaturalRequest(message)
    .replace(
      /\s*(?:,\s*)?(?:and\s+)?then\s+(?=(?:fund|top[- ]?up|deposit|rebalance|move)\b)[\s\S]*$/iu,
      "",
    )
    .replace(/^(?:please\s+)?(?:create|add|make|set\s+up)\s+/iu, "")
    .trim();
  const { body, walletName } = extractPrivateBalanceCreationParent(compact);
  const privateBalanceName = privateBalanceNameFromClause(body);
  if (!privateBalanceName) return undefined;
  return {
    private_balance_name: privateBalanceName,
    ...(walletName === undefined ? {} : { wallet_name: walletName }),
  };
}

function nativeAmountInRequest(message: string): string | undefined {
  const match = message.match(
    /(?<![a-z0-9_.])((?:\d+(?:\.\d+)?|\.\d+))\s*(?:sepolia\s+)?eth\b/iu,
  );
  const captured = match?.[1];
  return captured === undefined ? undefined : captured.startsWith(".") ? `0${captured}` : captured;
}

function stripNativeAmount(message: string): string {
  return message
    .replace(/(?<![a-z0-9_.])(?:\d+(?:\.\d+)?|\.\d+)\s*(?:sepolia\s+)?eth\b/iu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function privateBalanceFundingSource(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value
    .trim()
    .replace(/^(?:(?:my|the|a|an)\s+)+/iu, "")
    .replace(/(?:\s+(?:please|now))+$/iu, "")
    .trim();
  if (/^(?:(?:parent|wallet)['’]?s?\s+)?(?:main|public)(?:\s+(?:wallet|account|balance|funds?))?$|^parent(?:\s+(?:wallet|account))?$/iu.test(compact)) {
    return "$main";
  }
  return privateBalanceNameFromClause(compact);
}

function privateBalanceFundingArguments(message: string): StableBinding | undefined {
  const amount = nativeAmountInRequest(message) ?? "0.1";
  const withoutAmount = stripNativeAmount(compactNaturalRequest(message))
    .replace(
      /\s+(?:with|for|worth|amount(?:\s+of)?)\s+(?=(?:from|under|inside|within|in|for)\b|$)/iu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .trim();
  const { body, walletName } = extractTrailingParentWallet(withoutAmount);
  const fundMatch = body.match(
    /^(?:please\s+)?(?:fund|top[- ]?up|deposit(?:\s+into)?|rebalance)\s+(.{1,128}?)\s+from\s+(.{1,128})$/iu,
  );
  const moveMatch = body.match(
    /^(?:please\s+)?move\s+(?:funds?\s+)?from\s+(.{1,128}?)\s+to\s+(.{1,128})$/iu,
  );
  const targetWithParent = extractTrailingParentWallet(
    (fundMatch?.[1] ?? moveMatch?.[2] ?? "").trim(),
  );
  const target = privateBalanceNameFromClause(targetWithParent.body);
  const source = privateBalanceFundingSource(fundMatch?.[2] ?? moveMatch?.[1]);
  if (!target || !source) return undefined;
  const resolvedWalletName = walletName ?? targetWithParent.walletName;
  return {
    ...(resolvedWalletName === undefined ? {} : { wallet_name: resolvedWalletName }),
    source,
    target_private_balance_name: target,
    amount_native: amount,
  };
}

function hasUnresolvedPrivateBalanceFundingTarget(message: string): boolean {
  return /^(?:please\s+)?(?:fund|top[- ]?up|deposit(?:\s+into)?|rebalance)\s+(?:(?:my|the)\s+)?(?:it|this|that)(?:\s+with\s+(?:\d+(?:\.\d+)?|\.\d+)\s*(?:sepolia\s+)?eth)?\s+from\b/iu
    .test(compactNaturalRequest(message));
}

function privateBalancePolicyTargetArguments(
  message: string,
): StableBinding | undefined {
  const compact = compactNaturalRequest(message);
  const childCue =
    "(?:private[- ]balance|private\\s+(?:pocket|subwallet)|shielded\\s+(?:balance|pocket)|pocket|child)";
  const name = "([A-Za-z0-9][A-Za-z0-9._-]{0,63})";
  const policyCue = "(?:polic(?:y|ies)|permission|limits?|guardrails?)";
  const reservedChildNames = new Set([
    "a",
    "an",
    "allow",
    "change",
    "check",
    "current",
    "disable",
    "edit",
    "enable",
    "get",
    "modify",
    "my",
    "permit",
    "read",
    "set",
    "show",
    "the",
    "update",
    "view",
  ]);
  const implicitGrammarTokens = new Set([
    "all",
    "allowance",
    "allowances",
    "and",
    "another",
    "as",
    "any",
    "at",
    "available",
    "active",
    "by",
    "both",
    "config",
    "configuration",
    "control",
    "controls",
    "default",
    "each",
    "either",
    "every",
    "existing",
    "for",
    "first",
    "from",
    "guardrail",
    "guardrails",
    "her",
    "hers",
    "his",
    "if",
    "in",
    "inside",
    "into",
    "its",
    "last",
    "latest",
    "limit",
    "limits",
    "main",
    "mine",
    "new",
    "next",
    "neither",
    "of",
    "old",
    "on",
    "one",
    "only",
    "or",
    "other",
    "our",
    "ours",
    "permission",
    "permissions",
    "policy",
    "policies",
    "previous",
    "prior",
    "primary",
    "private",
    "public",
    "ready",
    "rule",
    "rules",
    "second",
    "secondary",
    "selected",
    "setting",
    "settings",
    "some",
    "that",
    "these",
    "their",
    "theirs",
    "then",
    "third",
    "this",
    "those",
    "to",
    "under",
    "when",
    "where",
    "while",
    "with",
    "within",
    "without",
    "your",
    "yours",
  ]);
  const nestedTargetPatterns = [
    {
      pattern: new RegExp(
        `\\b(?:change|update|edit|set|modify|show|view|get|check|read)\\s+(?:(?:my|the|a|an)\\s+)?${childCue}\\s+${name}(?:['’]s)?(?:\\s+${policyCue})?\\s+(?:under|inside|within|in)\\s+(?:(?:my|the)\\s+)?(?:(?:wallet|profile)\\s+)?${name}\\b`,
        "iu",
      ),
      parentIndex: 2,
      childIndex: 1,
    },
    {
      pattern: new RegExp(
        `\\b${policyCue}\\s+(?:for|of|on)\\s+(?:(?:my|the)\\s+)?${name}\\s*\\/\\s*${name}\\b`,
        "iu",
      ),
      parentIndex: 1,
      childIndex: 2,
    },
    {
      pattern: new RegExp(
        `\\b${name}\\s*\\/\\s*${name}(?:['’]s)?\\s+${policyCue}\\b`,
        "iu",
      ),
      parentIndex: 1,
      childIndex: 2,
    },
    {
      pattern: new RegExp(
        `\\b${policyCue}\\s+(?:for|of|on)\\s+(?:(?:my|the)\\s+)?${name}\\s+(?:under|inside|within|in)\\s+(?:(?:my|the)\\s+)?(?:(?:wallet|profile)\\s+)?${name}\\b`,
        "iu",
      ),
      parentIndex: 2,
      childIndex: 1,
    },
    {
      pattern: new RegExp(
        `\\b${policyCue}\\s+(?:for|of|on)\\s+(?:(?:my|the)\\s+)?${childCue}\\s+${name}\\s+(?:under|inside|within|in)\\s+(?:(?:my|the)\\s+)?(?:(?:wallet|profile)\\s+)?${name}\\b`,
        "iu",
      ),
      parentIndex: 2,
      childIndex: 1,
    },
  ] as const;
  for (const [index, { pattern, parentIndex, childIndex }] of
    nestedTargetPatterns.entries()) {
    const match = compact.match(pattern);
    const walletName = privateBalanceReference(match?.[parentIndex]);
    const privateBalanceName = privateBalanceReference(match?.[childIndex]);
    const normalizedName = privateBalanceName?.toLowerCase();
    if (
      walletName &&
      privateBalanceName &&
      (index !== 0 ||
        (normalizedName !== undefined &&
          !reservedChildNames.has(normalizedName) &&
          !implicitGrammarTokens.has(normalizedName)))
    ) {
      return { wallet_name: walletName, private_balance_name: privateBalanceName };
    }
  }
  const childPatterns = [
    new RegExp(
      `\\b${childCue}\\s+(?:named|called)\\s+${name}\\b`,
      "iu",
    ),
    new RegExp(
      `\\b${policyCue}\\s+(?:for|of|on)\\s+(?:(?:my|the)\\s+)?${name}\\s+${childCue}\\b`,
      "iu",
    ),
    new RegExp(
      `\\b(?:(?:my|the)\\s+)?${name}\\s+${childCue}(?:['’]s)?(?:\\s+${policyCue})?\\b`,
      "iu",
    ),
  ];
  let privateBalanceName: string | undefined;
  for (const [index, pattern] of childPatterns.entries()) {
    privateBalanceName = privateBalanceReference(compact.match(pattern)?.[1]);
    const normalizedName = privateBalanceName?.toLowerCase();
    // The first pattern has an explicit `named`/`called` cue, so unusual but
    // legal friendly names such as "and" remain usable there. The two
    // implicit postfix grammars must not turn prose glue into an inferred
    // child name. Slash references were already handled above and stay exact.
    if (
      privateBalanceName &&
      normalizedName !== undefined &&
      (index === 0 ||
        (!reservedChildNames.has(normalizedName) &&
          !implicitGrammarTokens.has(normalizedName)))
    ) break;
    privateBalanceName = undefined;
  }
  if (!privateBalanceName) return undefined;

  let walletName = extractTrailingParentWallet(compact).walletName;
  if (walletName === undefined) {
    const parentPatterns = [
      /\b(?:under|inside|within|in|for|of|on)\s+(?:(?:my|the)\s+)?(?:wallet|profile)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})\b/iu,
      /\b(?:under|inside|within|in|for|of|on)\s+(?:(?:my|the)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(?:wallet|profile)\b/iu,
      /\b(?:under|inside|within)\s+(?:(?:my|the)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?=\s+(?:to|with|and)\b|$)/iu,
    ];
    for (const pattern of parentPatterns) {
      walletName = privateBalanceReference(compact.match(pattern)?.[1]);
      if (walletName) break;
    }
  }
  if (walletName === privateBalanceName) walletName = undefined;
  return {
    ...(walletName === undefined ? {} : { wallet_name: walletName }),
    private_balance_name: privateBalanceName,
  };
}

function ambiguousPrivateBalancePolicyShorthandArguments(
  message: string,
): StableBinding | undefined {
  const compact = compactNaturalRequest(message);
  // A bare "cash under alpha" relation is not enough authority to reinterpret
  // arbitrary project/configuration prose as a wallet mutation. Preserve the
  // two friendly names only to ask one concrete clarification.
  const match = compact.match(
    /\b(?:change|update|edit|set|modify)\s+(?:(?:my|the)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:['’]s)?(?:\s+(?:polic(?:y|ies)|permission|limits?|guardrails?))?\s+(?:under|inside|within|in)\s+(?:(?:my|the)\s+)?(?:(?:wallet|profile)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(?:to|with)\b/iu,
  );
  const privateBalanceName = privateBalanceReference(match?.[1]);
  const walletName = privateBalanceReference(match?.[2]);
  if (!privateBalanceName || !walletName || privateBalanceName === walletName) {
    return undefined;
  }
  const hasWalletPolicyShape =
    /\b(?:enabled|disabled|sends?|payments?|per[- ]send|each|total|overall|expir(?:e|es|y|ing)|days?|hours?)\b/iu
      .test(compact) &&
    /\b(?:\d+(?:\.\d+)?|\.\d+)\s+(?:sepolia\s+)?eth\b/iu.test(compact);
  return hasWalletPolicyShape
    ? { wallet_name: walletName, private_balance_name: privateBalanceName }
    : undefined;
}

function regularExpressionLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasExplicitPrivateBalancePolicyScope(
  message: string,
  target: StableBinding,
): boolean {
  const privateBalanceName = typeof target.private_balance_name === "string"
    ? target.private_balance_name
    : undefined;
  if (!privateBalanceName) return false;
  const compact = compactNaturalRequest(message);
  const child = regularExpressionLiteral(privateBalanceName);
  const childCue =
    "(?:private[- ]balance|private\\s+(?:pocket|subwallet)|shielded\\s+(?:balance|pocket)|pocket|child)";
  const policyCue = "(?:polic(?:y|ies)|permission|limits?|guardrails?)";
  const localChildReferences = [
    new RegExp(`\\b${childCue}\\s+(?:(?:named|called)\\s+)?${child}\\b`, "iu"),
    new RegExp(`\\b${child}\\s+${childCue}\\b`, "iu"),
    new RegExp(
      `\\b${childCue}\\s+${policyCue}\\s+(?:for|of|on)\\s+(?:(?:my|the)\\s+)?${child}\\b`,
      "iu",
    ),
  ];
  if (localChildReferences.some((pattern) => pattern.test(compact))) return true;

  const walletName = typeof target.wallet_name === "string"
    ? target.wallet_name
    : undefined;
  if (!walletName) return false;
  const wallet = regularExpressionLiteral(walletName);
  return new RegExp(`\\b${wallet}\\s*\\/\\s*${child}\\b`, "iu").test(compact);
}

function privateBalancePolicySignalText(
  normalized: string,
  target: StableBinding | undefined,
): string {
  const childCue =
    "(?:private[- ]balance|private\\s+(?:pocket|subwallet)|shielded\\s+(?:balance|pocket)|pocket|child)";
  const policyCue = "(?:polic(?:y|ies)|permission|limits?|guardrails?)";
  const friendlyName = "[a-z0-9][a-z0-9._-]{0,63}";
  let actionText = normalized
    .replace(
      /\b(?:wallet[- ]controlled\s+)?public[- ]change(?:[- ]+(?:accounts?|wallets?|balances?|funds?))?\b/gu,
      " ",
    )
    .replace(
      new RegExp(
        `\\b(${childCue}\\s+(?:named|called)\\s+)${friendlyName}(?![a-z0-9._-])`,
        "gu",
      ),
      "$1friendly-name",
    )
    .replace(
      new RegExp(
        `\\b(${policyCue}\\s+(?:for|of|on)\\s+(?:(?:my|the)\\s+)?)${friendlyName}(?=\\s+${childCue}\\b)`,
        "gu",
      ),
      "$1friendly-name",
    )
    .replace(
      new RegExp(
        `\\b(${policyCue}\\s+(?:for|of|on)\\s+(?:(?:my|the)\\s+)?)${friendlyName}\\s*\\/\\s*${friendlyName}(?![a-z0-9._-])`,
        "gu",
      ),
      "$1friendly-wallet/friendly-name",
    )
    .replace(
      new RegExp(
        `(?<![a-z0-9._-])${friendlyName}\\s*\\/\\s*${friendlyName}(?=(?:['’]s)?\\s+${policyCue}\\b)`,
        "gu",
      ),
      "friendly-wallet/friendly-name",
    );

  const childName = typeof target?.private_balance_name === "string"
    ? target.private_balance_name.toLowerCase()
    : undefined;
  if (childName) {
    const child = regularExpressionLiteral(childName);
    actionText = actionText
      .replace(
        new RegExp(
          `(\\b${childCue}\\s+(?:(?:named|called)\\s+)?)${child}(?![a-z0-9._-])`,
          "gu",
        ),
        "$1friendly-name",
      )
      .replace(
        new RegExp(
          `(\\b${policyCue}\\s+(?:for|of|on)\\s+(?:(?:my|the)\\s+)?)${child}(?=\\s+(?:under|inside|within|in)\\b)`,
          "gu",
        ),
        "$1friendly-name",
      )
      .replace(
        new RegExp(
          `(\\b(?:change|update|edit|set|modify|allow|permit|enable|disable|show|list|display|view|get|check|read)\\b[^.!?]{0,64}?)${child}(?=\\s+${childCue}\\b)`,
          "gu",
        ),
        "$1friendly-name",
      );
  }

  const walletName = typeof target?.wallet_name === "string"
    ? target.wallet_name.toLowerCase()
    : undefined;
  if (walletName) {
    const wallet = regularExpressionLiteral(walletName);
    const parentCue = "(?:under|inside|within|in|for|of|on)";
    actionText = actionText
      .replace(
        new RegExp(
          `(\\b${parentCue}\\s+(?:(?:my|the)\\s+)?(?:wallet|profile)\\s+)${wallet}(?![a-z0-9._-])`,
          "gu",
        ),
        "$1friendly-wallet",
      )
      .replace(
        new RegExp(
          `(\\b${parentCue}\\s+(?:(?:my|the)\\s+)?)${wallet}(?=\\s+(?:wallet|profile)\\b)`,
          "gu",
        ),
        "$1friendly-wallet",
      )
      .replace(
        new RegExp(
          `(\\b(?:under|inside|within|in|for)\\s+(?:(?:my|the)\\s+)?)${wallet}(?=\\s+(?:to|with|and)\\b|$)`,
          "gu",
        ),
        "$1friendly-wallet",
      );
  }
  return actionText;
}

function walletPolicySignalText(
  normalized: string,
  walletName: string | undefined,
): string {
  if (!walletName) return normalized;
  const wallet = regularExpressionLiteral(walletName.toLowerCase());
  const actionCue = "(?:change|update|edit|set|modify|show|view|get|check)";
  const walletCue = "(?:wallet|profile)";
  const policyCue = "(?:polic(?:y|ies)|permission|limits?|guardrails?)";
  return normalized
    .replace(
      new RegExp(
        `(\\b${actionCue}\\s+(?:(?:my|the)\\s+)?${walletCue}\\s+)${wallet}(?=(?:['’]s)?\\s+${policyCue}\\b)`,
        "gu",
      ),
      "$1friendly-wallet",
    )
    .replace(
      new RegExp(
        `(\\b${actionCue}\\s+(?:(?:my|the)\\s+)?${walletCue}\\s+)${wallet}(?=\\s+(?:to|with)\\b)`,
        "gu",
      ),
      "$1friendly-wallet",
    )
    .replace(
      new RegExp(
        `(\\b${actionCue}\\s+(?:(?:my|the)\\s+)?)${wallet}(?=\\s+${walletCue}(?:['’]s)?\\s+${policyCue}\\b)`,
        "gu",
      ),
      "$1friendly-wallet",
    )
    .replace(
      new RegExp(
        `(\\b${actionCue}\\s+(?:(?:my|the)\\s+)?)${wallet}(?=(?:['’]s)?\\s+${policyCue}\\b)`,
        "gu",
      ),
      "$1friendly-wallet",
    )
    .replace(
      new RegExp(
        `(\\b${policyCue}\\s+(?:for|of|on)\\s+(?:(?:my|the)\\s+)?(?:${walletCue}\\s+)?)${wallet}(?=(?:['’]s)?(?:\\s+${walletCue})?\\b)`,
        "gu",
      ),
      "$1friendly-wallet",
    );
}

function normalizedPolicyAmount(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.startsWith(".") ? `0${value}` : value;
}

function firstPolicyCapture(
  message: string,
  patterns: readonly RegExp[],
): string | undefined {
  for (const pattern of patterns) {
    const value = pattern.exec(message)?.[1];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Parse only values carrying an explicit policy unit or qualifier. Wallet-name
 * digits, addresses, dates, and bare transfer amounts must never become policy
 * limits merely because they occur in the same request.
 */
function walletPolicySettings(message: string): StableBinding {
  const compact = compactNaturalRequest(message);
  const binding: StableBinding = {};

  const count = firstPolicyCapture(compact, [
    /\b(\d{1,3})\s+(?:sends?|payments?|transfers?)\b/iu,
    /\b(?:send|payment|transfer)\s+count(?:\s+(?:of|is|to))?\s+(\d{1,3})\b/iu,
  ]);
  if (count !== undefined) binding.max_payments = Number(count);

  const perSend = normalizedPolicyAmount(firstPolicyCapture(compact, [
    /(?:(?:at\s+most|up\s+to|limit(?:ed)?\s+to|max(?:imum)?(?:\s+of)?)\s+)?((?:\d+(?:\.\d+)?|\.\d+))\s*(?:sepolia\s+)?eth\s+(?:each|per[- ](?:send|payment|transfer))\b/iu,
    /\b(?:per[- ](?:send|payment|transfer)(?:\s+(?:limit|cap|maximum))?|(?:limit|cap|maximum)\s+per[- ](?:send|payment|transfer))(?:\s+(?:of|to|is|at))?\s+((?:\d+(?:\.\d+)?|\.\d+))\s*(?:sepolia\s+)?eth\b/iu,
    /\b(?:each|every)\s+(?:send|payment|transfer)(?:\s+(?:is|at|limited\s+to|capped\s+at|up\s+to|at\s+most))?\s+((?:\d+(?:\.\d+)?|\.\d+))\s*(?:sepolia\s+)?eth\b/iu,
  ]));
  if (perSend !== undefined) binding.per_payment_limit_native = perSend;

  const total = normalizedPolicyAmount(firstPolicyCapture(compact, [
    /\b(?:total|lifetime|overall)(?:\s+(?:limit|allowance|cap))?(?:\s+(?:of|to|is|at))?\s+((?:\d+(?:\.\d+)?|\.\d+))\s*(?:sepolia\s+)?eth\b/iu,
    /(?<![a-z0-9_.])((?:\d+(?:\.\d+)?|\.\d+))\s*(?:sepolia\s+)?eth\s+(?:total|overall|lifetime)(?:\s+(?:limit|allowance|cap))?\b/iu,
  ]));
  if (total !== undefined) binding.lifetime_limit_native = total;

  const expiry = compact.match(
    /\b(?:for|expires?\s+(?:in|after)|expiring\s+(?:in|after)|expiry\s+(?:of|in|after)|valid\s+for)\s+(\d{1,3})\s*(hours?|hrs?|days?|weeks?)\b/iu,
  ) ?? compact.match(
    /\b(\d{1,3})\s*(hours?|hrs?|days?|weeks?)\s+(?:expiry|expiration|validity)\b/iu,
  );
  if (expiry?.[1] !== undefined && expiry[2] !== undefined) {
    const value = Number(expiry[1]);
    const unit = expiry[2].toLowerCase();
    binding.expires_in_hours = value *
      (unit.startsWith("week") ? 168 : unit.startsWith("day") ? 24 : 1);
  }

  const enables = /\b(?:enable|enabled|turn\s+on|allow\s+sends?)\b/iu.test(compact);
  const disables = /\b(?:disable|disabled|turn\s+off|block\s+sends?)\b/iu.test(compact);
  if (enables !== disables) binding.enabled = enables;
  return binding;
}

function privateBalancePolicyArguments(message: string): StableBinding | undefined {
  const target = privateBalancePolicyTargetArguments(message);
  if (!target) return undefined;
  const signalText = privateBalancePolicySignalText(
    compactNaturalRequest(message).toLowerCase(),
    target,
  );
  const binding: StableBinding = { ...target, ...walletPolicySettings(signalText) };
  return Object.keys(binding).some((key) =>
    key !== "wallet_name" && key !== "private_balance_name"
  )
    ? binding
    : undefined;
}

function walletPolicyTarget(message: string): string | undefined {
  const compact = compactNaturalRequest(message);
  const patterns = [
    /\b(?:change|update|edit|set|modify|show|view|get|check)\s+(?:(?:my|the)\s+)?(?:wallet|profile)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:['’]s)?\s+(?:polic(?:y|ies)|permission|limits?|guardrails?)\b/iu,
    /\b(?:change|update|edit|set|modify)\s+(?:(?:my|the)\s+)?(?:wallet|profile)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(?:to|with)\b/iu,
    /\b(?:change|update|edit|set|modify|show|view|get|check)\s+(?:(?:my|the)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+wallet(?:['’]s)?\s+(?:polic(?:y|ies)|permission|limits?|guardrails?)/iu,
    /\b(?:change|update|edit|set|modify|show|view|get|check)\s+(?:(?:my|the)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:['’]s)?\s+(?:polic(?:y|ies)|permission|limits?|guardrails?)\b/iu,
    /\b(?:polic(?:y|ies)|permission|limits?|guardrails?)\s+(?:for|of|on)\s+(?:(?:my|the)\s+)?(?:(?:wallet|profile)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\s+(?:wallet|profile))?\b/iu,
  ];
  const generic = new Set([
    "a",
    "active",
    "current",
    "main",
    "my",
    "policy",
    "selected",
    "the",
    "wallet",
  ]);
  for (const pattern of patterns) {
    const name = privateBalanceReference(compact.match(pattern)?.[1]);
    if (name && !generic.has(name.toLowerCase())) return name;
  }
  return undefined;
}

function walletPolicyArguments(message: string): StableBinding | undefined {
  const walletName = walletPolicyTarget(message);
  const signalText = walletPolicySignalText(
    compactNaturalRequest(message).toLowerCase(),
    walletName,
  );
  const binding: StableBinding = {
    ...(walletName === undefined ? {} : { wallet_name: walletName }),
    ...walletPolicySettings(signalText),
  };
  return Object.keys(binding).some((key) => key !== "wallet_name") ? binding : undefined;
}

interface TransferRoutingArguments extends StableBinding {
  source: string;
  source_private_balance?: string;
  destination: string;
  amount_native: string;
}

function topLevelFundingWalletReference(
  value: string | undefined,
): { reference: string; explicitWalletCue: boolean } | undefined {
  if (!value) return undefined;
  const compact = value
    .trim()
    .replace(/(?:(?:\s*[,;:]\s*|\s+)(?:please|now))+$/iu, "")
    .trim();
  const patterns = [
    {
      pattern:
        /^(?:(?:my|the)\s+)?(?:wallet|profile|account)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/iu,
      explicitWalletCue: true,
    },
    {
      pattern:
        /^(?:(?:my|the)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(?:wallet|profile|account)$/iu,
      explicitWalletCue: true,
    },
    {
      pattern: /^(?:(?:my|the)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/iu,
      explicitWalletCue: false,
    },
  ] as const;
  const ambiguous = new Set(["it", "main", "parent", "public", "that", "this"]);
  for (const { pattern, explicitWalletCue } of patterns) {
    const reference = privateBalanceReference(compact.match(pattern)?.[1]);
    if (reference && !ambiguous.has(reference.toLowerCase())) {
      return { reference, explicitWalletCue };
    }
  }
  return undefined;
}

function topLevelWalletFundingArguments(
  message: string,
): TransferRoutingArguments | undefined {
  const compact = compactNaturalRequest(message);
  const match = compact.match(
    /^(?:please\s+)?fund\s+(.{1,128}?)\s+with\s+((?:\d+(?:\.\d+)?|\.\d+))\s*(?:sepolia\s+)?eth\s+from\s+(.{1,128})$/iu,
  );
  const destination = topLevelFundingWalletReference(match?.[1]);
  const source = topLevelFundingWalletReference(match?.[3]);
  const capturedAmount = match?.[2];
  if (!source || !destination || !capturedAmount) return undefined;
  if (!source.explicitWalletCue || !destination.explicitWalletCue) return undefined;
  // "main" and explicit child/pocket clauses belong to private-balance
  // funding. The top-level interpretation is reserved for two concrete wallet
  // references in this natural "fund destination ... from source" wrapper.
  if (
    /\b(?:private[- ]balance|private\s+(?:pocket|subwallet)|pocket|child)\b/iu.test(compact) ||
    privateBalanceFundingSource(match?.[3]) === "$main"
  ) {
    return undefined;
  }
  return {
    source: source.reference,
    destination: destination.reference,
    amount_native: capturedAmount.startsWith(".") ? `0${capturedAmount}` : capturedAmount,
  };
}

function transferRoutingArguments(message: string): TransferRoutingArguments | undefined {
  const topLevelFunding = topLevelWalletFundingArguments(message);
  if (topLevelFunding) return topLevelFunding;
  const compact = message.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const amountMatch = compact.match(
    /(?<![a-z0-9_.])((?:\d+(?:\.\d+)?|\.\d+))\s*(?:sepolia\s+)?eth\b/iu,
  );
  const capturedAmount = amountMatch?.[1];
  if (!capturedAmount) return undefined;
  const amount = capturedAmount.startsWith(".") ? `0${capturedAmount}` : capturedAmount;

  // Remove the already parsed denomination before extracting from/to. This
  // keeps a decimal point from looking like sentence punctuation and prevents
  // an amount placed last ("to savings for 0.1 ETH") from becoming part of
  // the destination that the gate later pins over the model's arguments.
  const withoutAmount = (
    compact.slice(0, amountMatch.index) +
    " " +
    compact.slice((amountMatch.index ?? 0) + amountMatch[0].length)
  )
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim();
  const fromThenTo = withoutAmount.match(
    /\bfrom\s+(.{1,128}?)\s+to\s+(.{1,128})$/iu,
  );
  const toThenFrom = withoutAmount.match(
    /\bto\s+(.{1,128}?)\s+from\s+(.{1,128})$/iu,
  );
  const toOnly = fromThenTo || toThenFrom
    ? undefined
    : withoutAmount.match(/\bto\s+(.{1,128})$/iu);
  const cleanReference = (value: string | undefined): string | undefined => {
    const cleaned = value
      ?.trim()
      .replace(/^[,;:]+/gu, "")
      .replace(/\s+(?:for|amount(?:\s+of)?|worth)$/iu, "")
      .replace(/\s+(?:privately|publicly|confidentially)$/iu, "")
      .replace(/(?:(?:\s*[,;:]\s*)?\s+(?:please|now))+$/iu, "")
      .replace(/[,;:]+$/gu, "")
      .trim();
    return cleaned || undefined;
  };
  const rawSource = cleanReference(fromThenTo?.[1] ?? toThenFrom?.[2]) ??
    (toOnly ? "$selected" : undefined);
  const destination = cleanReference(fromThenTo?.[2] ?? toThenFrom?.[1] ?? toOnly?.[1]);
  if (!rawSource || !destination) return undefined;

  const nestedSource = regularPublicChangeSource(rawSource);
  const genericSelectedSource = /^(?:(?:my|the)\s+)?(?:active|current|selected)?\s*(?:private|main|primary)?\s*(?:wallet|profile|account|balance|funds?)$/iu
    .test(rawSource);
  const source = nestedSource?.source ?? (genericSelectedSource ? "$selected" : rawSource);

  return {
    source,
    ...(nestedSource === undefined
      ? {}
      : { source_private_balance: nestedSource.sourcePrivateBalance }),
    destination,
    amount_native: amount,
  };
}

function regularPublicChangeSource(
  sourceClause: string,
): { source: string; sourcePrivateBalance: string } | undefined {
  const pocket = "([A-Za-z0-9][A-Za-z0-9._-]*)";
  const child = "(?:private\\s+balance|private\\s+pocket|pocket)";
  const change = "(?:tracked\\s+)?public\\s+change";
  const patterns = [
    new RegExp(`^(.{1,128}?)(?:\\s+(?:wallet|profile|account))?['’]s\\s+${pocket}\\s+${child}(?:['’]s|\\s+)?(?:\\s*${change})?$`, "iu"),
    new RegExp(`^(?:the\\s+|my\\s+)?(?:${change}\\s+(?:in|under|of|from)\\s+)?${pocket}\\s+${child}(?:['’]s|\\s+)?(?:\\s*${change})?\\s+(?:under|in|of)\\s+(.{1,128})$`, "iu"),
    new RegExp(`^(?:the\\s+|my\\s+)?${child}\\s+${pocket}(?:['’]s|\\s+)?(?:\\s*${change})?\\s+(?:under|in|of)\\s+(.{1,128})$`, "iu"),
    new RegExp(`^(?:the\\s+|my\\s+)?${change}\\s+(?:in|under|of|from)\\s+${pocket}\\s+(?:under|in|of)\\s+(.{1,128})$`, "iu"),
    new RegExp(`^(.{1,128}?)\\s*/\\s*${pocket}(?:\\s+${child})?(?:['’]s|\\s+)?(?:\\s*${change})?$`, "iu"),
    new RegExp(`^(?:the\\s+|my\\s+)?${pocket}(?:\\s+${child})?(?:['’]s|\\s+)?(?:\\s*${change})?\\s+(?:under|in|of)\\s+(?:(?:the|my)\\s+)?(?:wallet|profile|account)\\s+(.{1,128})$`, "iu"),
  ];
  for (const [index, pattern] of patterns.entries()) {
    const match = sourceClause.match(pattern);
    if (!match) continue;
    const parent = (index === 0 || index === 4 ? match[1] : match[2])?.trim();
    const childName = (index === 0 || index === 4 ? match[2] : match[1])?.trim();
    const wrappedParent = parent?.match(
      /^(?:(?:my|the)\s+)?(?:wallet|profile|account)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})$|^(?:(?:my|the)\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(?:wallet|profile|account)$/iu,
    );
    const source = privateBalanceReference(wrappedParent?.[1] ?? wrappedParent?.[2]) ??
      deferredReference(parent);
    const sourcePrivateBalance = privateBalanceReference(childName);
    if (source && sourcePrivateBalance) return { source, sourcePrivateBalance };
  }

  // If the user names a pocket but no parent, the canonical source is the
  // already-selected wallet. Keep the pocket as its own field instead of
  // misinterpreting phrases such as "travel private balance" as a parent
  // wallet name.
  const selectedPatterns = [
    new RegExp(`^(?:the\\s+|my\\s+)?${pocket}\\s+${child}(?:['’]s|\\s+)?(?:\\s*${change})?$`, "iu"),
    new RegExp(`^(?:the\\s+|my\\s+)?${child}\\s+${pocket}(?:['’]s|\\s+)?(?:\\s*${change})?$`, "iu"),
    new RegExp(`^(?:the\\s+|my\\s+)?${pocket}\\s+${change}$`, "iu"),
    new RegExp(`^(?:the\\s+|my\\s+)?${change}\\s+(?:in|under|of|from)\\s+(?:(?:the|my)\\s+)?${pocket}(?:\\s+${child})?$`, "iu"),
  ];
  for (const pattern of selectedPatterns) {
    const match = sourceClause.match(pattern);
    const sourcePrivateBalance = privateBalanceReference(match?.[1]);
    if (sourcePrivateBalance) {
      return { source: "$selected", sourcePrivateBalance };
    }
  }
  return undefined;
}

function transferArgumentContext(message: string): string {
  const args = transferRoutingArguments(message);
  if (!args) return "";
  return ` Use exactly these routed arguments without reinterpretation: ${JSON.stringify(args)}. Preserve every explicit source, pocket, destination, and amount. When present, the explicit from-clause is the source; never replace it with $selected. $selected means the user did not name a source wallet.`;
}

function isCheckAgainRequest(message: unknown): message is string {
  if (typeof message !== "string" || message.length > 512) return false;
  const normalized = message
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
  return /^(?:please\s+)?check again(?:\s+please)?[.!?]*$/u.test(normalized) ||
    /^(?:can|could|would|will)\s+you\s+(?:please\s+)?check again(?:\s+please)?[.!?]*$/u
      .test(normalized) ||
    /^(?:i(?:['’]ve|\s+have)?\s+(?:sent|submitted|started)\s+it[,;.!?]\s*)check again(?:\s+please)?[.!?]*$/u
      .test(normalized) ||
    // Older wallet receipts asked users to "continue setup" even though that
    // phrase was not independently routable. Treat the narrow, standalone
    // wording as the same read-only status follow-up, never as authority to
    // start or repeat onboarding.
    /^(?:please\s+)?(?:continue|resume|check)\s+(?:(?:with\s+)?the\s+|with\s+)?setup(?:\s+please)?[.!?]*$/u
      .test(normalized) ||
    /^(?:can|could|would|will)\s+(?:we|you)\s+(?:please\s+)?(?:continue|resume|check)\s+(?:(?:with\s+)?the\s+|with\s+)?setup(?:\s+please)?[.!?]*$/u
      .test(normalized);
}

function routingContext(message: unknown): string | undefined {
  if (typeof message !== "string" || message.length > 4_000) return undefined;
  const normalized = message.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;

  // A user (or an operational recovery prompt) may name the exact read-only
  // getter. Keep this deliberately narrower than a generic `use <name>`
  // request so legal saved-wallet names continue to work when introduced as
  // a wallet/profile/account. Without this signal, the leading `Use` could be
  // mistaken for a saved-profile load because MCP tool names contain `_`.
  const explicitPrivateBalanceOperationStatusTool =
    /^(?:please\s+)?use\s+(?:(?:only|exactly|the|this)\s+)*(?:mcp__agent_boost__)?wallet_get_private_balance_operation(?:\s+tool)?(?=$|[.!?]|\s+(?:directly|now|to|with|for)\b)/u
      .test(normalized) ||
    /^(?:please\s+)?use\s+(?:(?:only|exactly)\s+)*(?:(?:the|this)\s+)?agent[ -]boost\s+tool\s+(?:mcp__agent_boost__)?wallet_get_private_balance_operation(?=$|[.!?]|\s+(?:directly|now|to|with|for)\b)/u
      .test(normalized);

  const routedArguments = transferRoutingArguments(message);
  const topLevelFundingRoute = topLevelWalletFundingArguments(message) !== undefined;
  const transferActionIntent = topLevelFundingRoute ||
    /^(?:please\s+)?(?:(?:can|could|would|will)\s+(?:we|you)\s+)?(?:send|transfer|pay|recover|unshield)\b/u.test(normalized) ||
    /^(?:please\s+)?(?:a\s+)?(?:regular|public|transparent|private|confidential|shielded|recovery|non-private|non-recovery)\s+(?:transfer|payment|send)\b/u.test(normalized) ||
    /^(?:please\s+)?(?:make|do)\s+(?:a\s+)?(?:(?:regular|public|transparent|private|confidential|shielded|recovery|non-private|non-recovery)\s+)?(?:transfer|payment)\b/u.test(normalized) ||
    /\b(?:i|we)\s+(?:(?:want|need)\s+(?:you\s+)?to|(?:would|['’]d)\s+like\s+(?:you\s+)?to)\s+(?:send|transfer|pay|recover|unshield)\b/u.test(normalized);
  const modeText = normalized
    .replace(/\bnon-private\b|\bnot\s+(?:a\s+)?private\b/gu, "regular")
    .replace(/\bnon-recovery\b|\bnot\s+(?:a\s+)?recovery\b/gu, "regular");
  const recoveryRoute = transferActionIntent &&
    /\b(?:recover|unshield)\b|\brecovery\s+(?:transfer|send|payment)\b|\b(?:send|pay|transfer)\b.{0,32}\b(?:using|via|as)\s+(?:a\s+)?recovery\b/u.test(modeText);
  const explicitPrivateRoute = transferActionIntent &&
    /\b(?:private|shielded|confidential)\s+(?:transfer|send|payment)\b|\b(?:send|pay|transfer)\b.{0,32}\bprivately\b/u.test(modeText);
  const fromPrivateRoute = transferActionIntent &&
    /\bfrom\s+(?:(?:the|my)\s+)?private\s+(?:wallet|account|balance|funds?|pocket)\b/u.test(modeText);
  const explicitRegularRoute = transferActionIntent && (
    topLevelFundingRoute ||
    /\b(?:regular|public|transparent)\b.{0,24}\b(?:transfer|send|payment)\b|\b(?:send|pay|transfer)\b.{0,32}\bpublicly\b/u.test(modeText) ||
    (routedArguments?.source_private_balance !== undefined &&
      /\bpublic\s+change\b/u.test(modeText))
  );
  // Explicit regular/public mode wins over an adjective in a source wallet
  // name and over the words "private balance" that identify the parent of a
  // tracked public-change account. A genuinely explicit "private transfer"
  // remains a conflicting mode and therefore routes nowhere.
  const namedPrivateBalanceSourceRoute = transferActionIntent &&
    routedArguments?.source_private_balance !== undefined;
  const privateRoute = explicitPrivateRoute ||
    ((fromPrivateRoute || namedPrivateBalanceSourceRoute) && !explicitRegularRoute);
  const explicitKinds = [recoveryRoute, privateRoute, explicitRegularRoute]
    .filter(Boolean).length;
  const namedSourceWallet = /\bfrom\s+(?:(?:my|the)\s+)?(?:(?:agent[ -]?boost|main|primary|active|current|[a-z0-9]+)\s+(?:wallet|profile|account|balance|funds?|pocket)\b|[a-z0-9]+(?:[_-][a-z0-9]+)+(?:\s+(?:wallet|profile|account|balance|funds?|pocket))?\b)/u
    .test(modeText);
  const unqualifiedWalletTransfer = transferActionIntent && explicitKinds === 0 &&
    namedSourceWallet && /\b(?:eth|sepolia|wallets?|payment|0x[0-9a-f]{40})\b/u.test(modeText);
  const transferKind = explicitKinds > 1
    ? undefined
    : recoveryRoute
      ? "recovery"
      : privateRoute
        ? "private"
        : explicitRegularRoute || unqualifiedWalletTransfer
          ? "regular"
          : undefined;
  if (transferKind === "regular") {
    return "Agent Boost routing for the actual user request: call wallet_preview_regular_transfer directly. This is the regular public transfer route. Do not call a private or recovery transfer tool, wallet setup, policy, context, egress, or saved-wallet inventory first. If the source needs changing, this preview tool returns the typed next step." + transferArgumentContext(message);
  }
  if (transferKind === "private") {
    return "Agent Boost routing for the actual user request: call wallet_preview_private_transfer directly. Do not substitute the regular or recovery route and do not call wallet setup, context, egress, or saved-wallet inventory first. If the source needs changing, this preview tool returns the typed next step." + transferArgumentContext(message);
  }
  if (transferKind === "recovery") {
    return "Agent Boost routing for the actual user request: call wallet_preview_recovery_transfer directly. Do not substitute the regular or private route and do not call wallet setup, context, egress, or saved-wallet inventory first. If the source needs changing, this preview tool returns the typed next step." + transferArgumentContext(message);
  }

  const authorizationArguments = walletAuthorizationArguments(message);
  if (authorizationArguments !== undefined) {
    return "Agent Boost routing for the actual user request: call wallet_plan_reauthorization directly" +
      (authorizationArguments.wallet_name === undefined
        ? " with no arguments for the active wallet"
        : ` with exactly these routed arguments: ${JSON.stringify(authorizationArguments)}`) +
      ". Return the signed authorization preview and end tool use for this assistant turn. " +
      "Do not load, switch, create, transfer from, or modify the policy of a wallet first.";
  }

  if (hasUnresolvedPrivateBalanceFundingTarget(message)) {
    return "Agent Boost routing for the actual user request: ask one concise clarification for which private balance should receive the funds. Do not infer a target from the pronoun and do not call any Agent Boost tool in this turn.";
  }

  const childActionIntent = /\b(?:create|add|make|set\s+up|fund|funding|top[- ]?up|deposit|rebalance|move)\b/u
    .test(normalized);
  const parsedPrivateBalanceFunding = childActionIntent
    ? privateBalanceFundingArguments(message)
    : undefined;
  const ambiguousPrivateBalancePolicy =
    ambiguousPrivateBalancePolicyShorthandArguments(message);
  if (ambiguousPrivateBalancePolicy) {
    return "Agent Boost routing for the actual user request: ask one concise clarification for which private balance policy should change. " +
      `Confirm whether ${JSON.stringify(ambiguousPrivateBalancePolicy.private_balance_name)} is a private balance under wallet ${JSON.stringify(ambiguousPrivateBalancePolicy.wallet_name)}. ` +
      "Do not claim the policy was applied and do not call any Agent Boost tool in this turn.";
  }
  const parsedPrivateBalancePolicyTarget = privateBalancePolicyTargetArguments(message);
  const privateBalanceIntent = /\b(?:private[- ]balance|private\s+(?:pocket|subwallet)|shielded\s+(?:balance|pocket))s?\b/u
    .test(normalized) ||
    explicitPrivateBalanceOperationStatusTool ||
    ((childActionIntent ||
      /\b(?:change|update|edit|set|modify|show|view|get|check|read)\b/u.test(normalized)) &&
      /\b(?:pocket|child)\b/u.test(normalized)) ||
    parsedPrivateBalanceFunding !== undefined ||
    parsedPrivateBalancePolicyTarget !== undefined;
  const privateBalancePolicy = privateBalanceIntent &&
    /\b(?:polic(?:y|ies)|permission|limits?|guardrails?|per[- ]send|sends?|payments?|expir(?:e|es|y)|enabl(?:e|ed)|disabl(?:e|ed))\b/u
      .test(normalized);
  const privateBalancePolicyActionText = privateBalancePolicySignalText(
    normalized,
    parsedPrivateBalancePolicyTarget,
  );
  const parsedPrivateBalancePolicySettings = walletPolicySettings(
    privateBalancePolicyActionText,
  );
  const hasPrivateBalancePolicySettings =
    Object.keys(parsedPrivateBalancePolicySettings).length > 0;
  const privateBalancePolicyMutation = privateBalancePolicy &&
    /\b(?:change|update|edit|set|modify|allow|permit|enable|disable)\b/u
      .test(privateBalancePolicyActionText);
  const privateBalancePolicyRead = privateBalancePolicy &&
    /\b(?:show|list|display|view|get|check|what\s+(?:is|are)|what's|current|read)\b/u
      .test(normalized);
  const privateBalanceSnapshotFields = normalized.replace(
    /\b(?:private[- ]balances?|shielded\s+balances?)\b/gu,
    " ",
  );
  const privateBalanceSnapshotRead = privateBalancePolicyRead &&
    !privateBalancePolicyMutation &&
    parsedPrivateBalancePolicyTarget !== undefined &&
    /\b(?:balances?|readiness|ready|availability|available)\b/u
      .test(privateBalanceSnapshotFields);
  const aggregatePrivateBalanceScope =
    /\b(?:all|every|each)\b[^.!?]{0,64}\b(?:private[- ]balances?|private\s+(?:pockets?|subwallets?)|shielded\s+(?:balances?|pockets?))\b/u
      .test(normalized) ||
    /\b(?:private[- ]balances|private\s+(?:pockets|subwallets)|shielded\s+(?:balances|pockets))\b/u
      .test(normalized);
  const walletGraphCue =
    /\b(?:wallet|wallets)\s+(?:tree|hierarchy|structure|map|overview)\b|\b(?:tree|hierarchy|map|overview)\s+(?:of|for)\s+(?:my\s+)?wallets?\b/u
      .test(normalized) ||
    /\bwhat\s+happened\s+to\b[^.!?]{0,48}\b(?:the\s+)?(?:fun\s+)?tree\s+structure\b[^.!?]{0,48}\b(?:my\s+)?wallets?\b/u
      .test(normalized) ||
    /\bwhere(?:\s+is|['’]s)\s+(?:(?:my|the)\s+)?(?:fun\s+)?tree\s+structure\b[^.!?]{0,48}\b(?:my\s+)?wallets?\b/u
      .test(normalized);
  const explicitWholeGraphScope =
    /\b(?:complete|full|whole)\b[^.!?]{0,64}\b(?:wallets?|tree|hierarchy|structure|map|overview)\b/u
      .test(normalized) ||
    /\b(?:all|every)\b[^.!?]{0,64}\b(?:wallets?|accounts?|balances?)\b/u
      .test(normalized);

  if (aggregatePrivateBalanceScope && privateBalancePolicyMutation) {
    return "Agent Boost routing for the actual user request: ask one concise clarification for which private balance policy should change. Bulk private-balance policy changes are not supported; request one exact child pocket and optional parent wallet. Do not call any Agent Boost tool in this turn.";
  }
  if (
    !privateBalancePolicyMutation &&
    ((walletGraphCue &&
      (parsedPrivateBalancePolicyTarget === undefined || explicitWholeGraphScope)) ||
      (aggregatePrivateBalanceScope && privateBalancePolicyRead))
  ) {
    return "Agent Boost routing for the actual user request: call wallet_get_tree directly and return its rendered wallet tree exactly. Do not call saved-wallet inventory, context, or setup first.";
  }
  if (privateBalanceSnapshotRead) {
    return "Agent Boost routing for the actual user request: call wallet_get_tree directly and return its rendered wallet tree exactly. This combined child-pocket read asks for balance, readiness, and policy together; do not narrow it to the policy-only tool or call saved-wallet inventory, context, or setup first.";
  }
  const privateBalanceOperationStatus = explicitPrivateBalanceOperationStatusTool ||
    (privateBalanceIntent || /\bprivate\s+funding\b/u.test(normalized)) && (
    /\b(?:status|progress|outcome|what\s+happened|check|reconcile|refresh)\b[^.!?]{0,80}\b(?:creat(?:e|ion)|fund(?:ing|ed)?|operation)\b/u
      .test(normalized) ||
    /\b(?:creat(?:e|ion)|fund(?:ing|ed)?|operation)\b[^.!?]{0,80}\b(?:status|progress|outcome|result|what\s+happened|check|reconcile|refresh)\b/u
      .test(normalized)
  );
  if (privateBalanceOperationStatus) {
    return "Agent Boost routing for the actual user request: call wallet_get_private_balance_operation directly with the exact internal request ID retained from the matching earlier result. This is a status read only. Never retry or replace an unresolved operation, reveal an ID, or ask the user for one.";
  }

  const createsParentWalletFirst = walletGraphCreationArguments(message) !== undefined;
  const privateBalanceCreation = privateBalanceIntent &&
    /\b(?:create|add|make|set\s+up)\b/u.test(normalized);
  const parsedPrivateBalanceCreation = privateBalanceCreation
    ? privateBalanceCreationArguments(message)
    : undefined;
  if (
    parsedPrivateBalanceCreation !== undefined &&
    !createsParentWalletFirst
  ) {
    return "Agent Boost routing for the actual user request: call wallet_preview_private_balance_create directly with the new child-pocket name and optional saved parent wallet. This is not a top-level wallet creation. Return the signed preview and end tool use for this assistant turn. Do not fund or otherwise mutate the new pocket in this same turn." +
      ` Use exactly these routed arguments: ${JSON.stringify(parsedPrivateBalanceCreation)}.`;
  }

  if (privateBalancePolicyMutation) {
    if (!parsedPrivateBalancePolicyTarget) {
      return "Agent Boost routing for the actual user request: ask one concise clarification for which private balance policy should change. Request one exact child pocket and optional parent wallet; do not invent a target or call an Agent Boost tool in this turn.";
    }
    if (!hasExplicitPrivateBalancePolicyScope(message, parsedPrivateBalancePolicyTarget)) {
      return "Agent Boost routing for the actual user request: ask one concise clarification for which private balance policy should change. " +
        `Confirm whether ${JSON.stringify(parsedPrivateBalancePolicyTarget.private_balance_name)} is a private balance` +
        (parsedPrivateBalancePolicyTarget.wallet_name === undefined
          ? ". "
          : ` under wallet ${JSON.stringify(parsedPrivateBalancePolicyTarget.wallet_name)}. `) +
        "Do not reinterpret an unrelated setting as a wallet mutation, claim the policy was applied, or call any Agent Boost tool in this turn.";
    }
    const argumentsJson = privateBalancePolicyArguments(message);
    if (!argumentsJson) {
      return "Agent Boost routing for the actual user request: ask one concise clarification for the private-balance policy setting to change for the named child (send count, per-send limit, total limit, expiry, or enabled state). Do not call any Agent Boost tool in this turn.";
    }
    return "Agent Boost routing for the actual user request: call wallet_preview_private_balance_policy_update directly for the named child pocket and optional parent wallet. Do not substitute the parent wallet policy. Return the signed preview and end tool use for this assistant turn." +
      ` Use exactly these routed arguments: ${JSON.stringify(argumentsJson)}.`;
  }
  if (privateBalancePolicyRead) {
    const argumentsJson = parsedPrivateBalancePolicyTarget;
    if (!argumentsJson) {
      return "Agent Boost routing for the actual user request: ask one concise clarification for which private balance policy to show. Request one exact child pocket and optional parent wallet; do not invent a target or call an Agent Boost tool in this turn.";
    }
    return "Agent Boost routing for the actual user request: call wallet_get_private_balance_policy directly for the named child pocket and optional parent wallet. Do not substitute the parent wallet policy or update anything." +
      ` Use exactly these routed arguments: ${JSON.stringify(argumentsJson)}.`;
  }
  if (privateBalancePolicy && hasPrivateBalancePolicySettings) {
    return "Agent Boost routing for the actual user request: ask one concise clarification for which private balance policy should change. The request includes policy-shaped settings but no syntactically distinct instruction to read or change a policy. Do not call any Agent Boost tool in this turn.";
  }

  const privateBalanceFunding = privateBalanceIntent &&
    /\b(?:fund|funding|top[- ]?up|deposit|rebalance|move)\b/u.test(normalized);
  if (privateBalanceFunding) {
    const argumentsJson = parsedPrivateBalanceFunding;
    return "Agent Boost routing for the actual user request: call wallet_preview_private_balance_fund directly. wallet_name is only the saved parent wallet; target_private_balance_name is the destination child pocket. Set source=$main only when the user chose that parent's main/public account; otherwise preserve the exact sibling private-pocket name as source. Do not use a regular, private-payment, or recovery transfer tool. Return the signed preview and end this assistant turn." +
      (argumentsJson ? ` Use exactly these routed arguments: ${JSON.stringify(argumentsJson)}.` : "");
  }

  if (privateBalanceCreation && !createsParentWalletFirst) {
    return "Agent Boost routing for the actual user request: call wallet_preview_private_balance_create directly with the new child-pocket name and optional saved parent wallet. This is not a top-level wallet creation. Return the signed preview and end tool use for this assistant turn." +
      (parsedPrivateBalanceCreation
        ? ` Use exactly these routed arguments: ${JSON.stringify(parsedPrivateBalanceCreation)}.`
        : "");
  }

  const compactOriginal = message.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const createArguments = walletCreationArguments(compactOriginal);
  if (createArguments) {
    return "Agent Boost routing for the actual user request: call wallet_create directly with " +
      `exactly these arguments: ${JSON.stringify(createArguments)}. This creates a new top-level ` +
      "saved wallet; do not reset, adopt, load, or create a private balance instead.";
  }
  if (createsParentWalletFirst) {
    return "Agent Boost routing for the actual user request: ask one concise clarification for the missing top-level wallet or private-balance friendly name. Do not invent either name and do not call any Agent Boost tool in this turn.";
  }
  const loadReference = savedWalletLoadReference(compactOriginal);
  if (loadReference !== undefined) {
    const argumentsJson = JSON.stringify({ wallet_name: loadReference.reference });
    return `Agent Boost routing for the actual user request: call wallet_preview_saved_profile_load directly and exactly once with arguments ${argumentsJson}. Pass this pinned wallet reference unchanged. This one call lists and resolves saved profiles internally; do not call wallet_list_saved_profiles first. It is read-only and either returns an exact load preview, an already-active no-op, or friendly-name choices. Never apply a load in this assistant turn.`;
  }
  if (/\b(?:list|show|find|what are)\b[^.!?]{0,48}\b(?:saved|existing|previous(?:ly)? set up)\b[^.!?]{0,24}\b(?:wallets?|profiles?)\b|\b(?:saved|existing)\s+(?:wallets?|profiles?)\b|\bwhich\s+(?:saved\s+)?(?:wallets|profiles)\s+can\s+i\s+(?:load|use|open|select)\b/u.test(normalized)) {
    return "Agent Boost routing for the actual user request: call wallet_list_saved_profiles directly. Do not create, adopt, or switch a wallet while listing.";
  }
  if (
    /\bwhat\s+happened\s+to\b[^.!?]{0,48}\b(?:the\s+)?(?:fun\s+)?tree\s+structure\b[^.!?]{0,48}\b(?:my\s+)?wallets?\b/u.test(normalized) ||
    /\bwhere(?:\s+is|['’]s)\s+(?:(?:my|the)\s+)?(?:fun\s+)?tree\s+structure\b[^.!?]{0,48}\b(?:my\s+)?wallets?\b/u.test(normalized) ||
    /\b(?:wallet|wallets)\s+(?:tree|hierarchy|structure|map|overview)\b|\b(?:tree|hierarchy|map|overview)\s+(?:of|for)\s+(?:my\s+)?wallets?\b/u.test(normalized) ||
    /\b(?:show|list|display)\b[^.!?]{0,64}\b(?:my\s+)?(?:agent[ -]?boost\s+)?wallets\b/u.test(normalized) ||
    /\b(?:show|list|display)\b[^.!?]{0,64}\b(?:my\s+)?(?:accounts?|balances?)\b/u.test(normalized) ||
    /\b(?:show|list|display|what\s+are)\b[^.!?]{0,64}\b(?:my\s+)?(?:private[- ]balances|private\s+pockets|private\s+subwallets)\b/u.test(normalized) ||
    /\b(?:all|every)\b[^.!?]{0,48}\b(?:wallets?|accounts?|balances?)\b/u.test(normalized) ||
    /\bwhat\s+(?:agent[ -]?boost\s+)?wallets\s+(?:do\s+i\s+have|are\s+there)\b/u.test(normalized)
  ) {
    return "Agent Boost routing for the actual user request: call wallet_get_tree directly and return its rendered wallet tree exactly. Do not call saved-wallet inventory, context, or setup first.";
  }
  const parsedWalletPolicyTarget = walletPolicyTarget(message);
  const walletPolicyActionText = walletPolicySignalText(
    normalized,
    parsedWalletPolicyTarget,
  );
  const parsedWalletPolicySettings = walletPolicySettings(walletPolicyActionText);
  const hasWalletPolicySettings = Object.keys(parsedWalletPolicySettings).length > 0;
  const hasWalletPolicyScope = parsedWalletPolicyTarget !== undefined ||
    /\b(?:wallet|profile)\b[^.!?]{0,48}\bpolic(?:y|ies)\b|\bpolic(?:y|ies)\b[^.!?]{0,48}\b(?:wallet|profile)\b/u
      .test(normalized);
  const walletLimitMutation =
    /\b(?:change|update|edit|set|modify)\b[^.!?]{0,48}\b(?:wallet|permission|limits?|guardrails?)\b[^.!?]{0,64}\b(?:sends?|payments?|per[- ]send|limits?|expir(?:e|es|y))\b/u
      .test(walletPolicyActionText) ||
    /\b(?:allow|permit)\b[^.!?]{0,64}\b(?:sends?|payments?)\b[^.!?]{0,48}\b(?:wallet|sepolia|eth)\b/u
      .test(walletPolicyActionText);
  if (
    walletLimitMutation ||
    /\b(?:change|update|edit|set|modify)\b[^.!?]{0,48}\bpolic(?:y|ies)\b|\bpolic(?:y|ies)\b[^.!?]{0,48}\b(?:change|update|edit|set|modify)\b/u
      .test(walletPolicyActionText)
  ) {
    const argumentsJson = walletPolicyArguments(message);
    if (!argumentsJson) {
      return "Agent Boost routing for the actual user request: ask one concise clarification for the wallet-policy setting to change (send count, per-send limit, total limit, expiry, or enabled state). Do not call any Agent Boost tool in this turn because no concrete setting was supplied.";
    }
    return "Agent Boost routing for the actual user request: call wallet_plan_policy_update directly with exactly these routed arguments: " +
      `${JSON.stringify(argumentsJson)}. Return the preview and end tool use for this assistant turn.`;
  }
  if (/\b(?:show|view|get|check|what is|what's|current)\b[^.!?]{0,48}\bpolic(?:y|ies)\b|\bpolic(?:y|ies)\b[^.!?]{0,32}\b(?:status|settings?|rules?)\b/u.test(normalized)) {
    return "Agent Boost routing for the actual user request: call wallet_get_policy directly" +
      (parsedWalletPolicyTarget
        ? ` with exactly these routed arguments: ${JSON.stringify({ wallet_name: parsedWalletPolicyTarget })}`
        : " with no arguments") +
      ". Do not update the policy unless the user explicitly requested a change.";
  }
  if (hasWalletPolicyScope && hasWalletPolicySettings) {
    return "Agent Boost routing for the actual user request: ask one concise clarification for the wallet-policy setting request. The message includes policy-shaped settings but no syntactically distinct instruction to read or change a policy. Do not call any Agent Boost tool in this turn.";
  }
  return undefined;
}

type PrivateBalanceOperationFamily = "creation" | "funding" | "policy";
type PrivateBalanceOperationStatusFamily = PrivateBalanceOperationFamily | "ambiguous";

function privateBalanceOperationStatusFamily(
  message: unknown,
): PrivateBalanceOperationStatusFamily | undefined {
  if (typeof message !== "string") return undefined;
  const normalized = message.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  const families: PrivateBalanceOperationFamily[] = [];
  if (/\b(?:private(?:[- ]balance)?\s+creat(?:ion|ed)|creat(?:ion|ed)\s+(?:request|operation|status))\b/u
    .test(normalized)) {
    families.push("creation");
  }
  if (/\b(?:private(?:[- ]balance)?\s+fund(?:ing|ed)|fund(?:ing|ed)\s+(?:private(?:[- ]balance)?\s+)?(?:request|operation|status)|rebalance(?:\s+(?:request|operation|status))?)\b/u
    .test(normalized)) {
    families.push("funding");
  }
  if (/\b(?:private(?:[- ]balance)?\s+policy|policy\s+(?:request|operation|status|update))\b/u
    .test(normalized)) {
    families.push("policy");
  }
  if (families.length === 0) return undefined;
  return families.length === 1 ? families[0] : "ambiguous";
}

function privateBalanceStatusBindingMatchesFamily(
  binding: StableBinding,
  family: PrivateBalanceOperationStatusFamily | undefined,
): boolean {
  if (family === undefined) return true;
  if (family === "ambiguous") return false;
  const value = nonEmptyString(binding.request_id) ?? nonEmptyString(binding.decision_id);
  if (!value) return false;
  const prefixes: Record<PrivateBalanceOperationFamily, RegExp> = {
    creation: /^(?:pbcr|pbc)_/u,
    funding: /^(?:pbfr|pbf)_/u,
    policy: /^(?:pbpr|pbp)_/u,
  };
  return prefixes[family].test(value);
}

function routedRequest(
  message: string,
  context: string,
): { tool: RoutedTool; binding: StableBinding; argumentsPinned: boolean } | undefined {
  if (context.includes("ask one concise clarification for which private balance policy")) {
    return { tool: "$clarify_private_balance_policy", binding: {}, argumentsPinned: true };
  }
  if (context.includes("ask one concise clarification for the private-balance policy setting")) {
    return { tool: "$clarify_private_balance_policy", binding: {}, argumentsPinned: true };
  }
  if (context.includes("ask one concise clarification for which private balance")) {
    return { tool: "$clarify_private_balance_fund", binding: {}, argumentsPinned: true };
  }
  if (context.includes("ask one concise clarification for the missing top-level wallet")) {
    return { tool: "$clarify_wallet_graph_create", binding: {}, argumentsPinned: true };
  }
  if (context.includes("ask one concise clarification for the wallet-policy setting")) {
    return { tool: "$clarify_wallet_policy", binding: {}, argumentsPinned: true };
  }
  if (context.includes("call wallet_get_tree directly")) {
    return { tool: "wallet_get_tree", binding: {}, argumentsPinned: true };
  }
  if (context.includes("call wallet_create directly")) {
    const binding = walletCreationArguments(message);
    return binding
      ? { tool: "wallet_create", binding, argumentsPinned: true }
      : { tool: "wallet_create", binding: {}, argumentsPinned: false };
  }
  if (context.includes("call wallet_plan_reauthorization directly")) {
    const binding = walletAuthorizationArguments(message);
    return binding === undefined
      ? undefined
      : { tool: "wallet_plan_reauthorization", binding, argumentsPinned: true };
  }
  if (context.includes("call wallet_preview_private_balance_create directly")) {
    const binding = privateBalanceCreationArguments(message);
    return binding
      ? { tool: "wallet_preview_private_balance_create", binding, argumentsPinned: true }
      : { tool: "wallet_preview_private_balance_create", binding: {}, argumentsPinned: false };
  }
  if (context.includes("call wallet_preview_private_balance_fund directly")) {
    const binding = privateBalanceFundingArguments(message);
    return binding
      ? { tool: "wallet_preview_private_balance_fund", binding, argumentsPinned: true }
      : { tool: "wallet_preview_private_balance_fund", binding: {}, argumentsPinned: false };
  }
  if (context.includes("call wallet_preview_private_balance_policy_update directly")) {
    const binding = privateBalancePolicyArguments(message);
    return binding
      ? {
        tool: "wallet_preview_private_balance_policy_update",
        binding,
        argumentsPinned: true,
      }
      : {
        tool: "wallet_preview_private_balance_policy_update",
        binding: {},
        argumentsPinned: false,
      };
  }
  if (context.includes("call wallet_get_private_balance_policy directly")) {
    const binding = privateBalancePolicyTargetArguments(message);
    return binding
      ? { tool: "wallet_get_private_balance_policy", binding, argumentsPinned: true }
      : { tool: "wallet_get_private_balance_policy", binding: {}, argumentsPinned: false };
  }
  for (const tool of [
    "wallet_preview_regular_transfer",
    "wallet_preview_private_transfer",
    "wallet_preview_recovery_transfer",
  ] as const) {
    if (!context.includes(`call ${tool} directly`)) continue;
    const binding = transferRoutingArguments(message);
    return binding
      ? { tool, binding, argumentsPinned: true }
      : { tool, binding: {}, argumentsPinned: false };
  }
  if (context.includes("call wallet_plan_policy_update directly")) {
    const binding = walletPolicyArguments(message);
    return binding
      ? { tool: "wallet_plan_policy_update", binding, argumentsPinned: true }
      : { tool: "wallet_plan_policy_update", binding: {}, argumentsPinned: false };
  }
  if (context.includes("call wallet_get_policy directly")) {
    const walletName = walletPolicyTarget(message);
    return {
      tool: "wallet_get_policy",
      binding: walletName ? { wallet_name: walletName } : {},
      argumentsPinned: true,
    };
  }
  return undefined;
}

async function handlePreLlmCall(
  record: JsonRecord,
  stateDirectory: string,
  identity: TurnIdentity | undefined,
  now: number,
  ttlMs: number,
): Promise<HermesTurnGateResponse> {
  await pruneExpiredState(stateDirectory, now);
  if (!identity) return {};

  // A hook retry or duplicate delivery must not leave a decision derived from
  // an older message for this same turn.
  await clearUserDecision(stateDirectory, identity);
  const userMessage = asRecord(record.extra)?.user_message;
  const pending = await readPendingContinuation(stateDirectory, identity, now);
  const decision = pending.status === "active"
    ? authenticatedUserDecision(userMessage, pending.value.tool)
    : undefined;
  if (
    decision !== undefined &&
    pending.status === "active" &&
    pending.value.preview_turn_hash !== turnHash(identity)
  ) {
    await publishUserDecision(
      stateDirectory,
      identity,
      pending.value,
      decision,
      now,
      ttlMs,
    );
    const deferred = await readDeferredTransfer(stateDirectory, identity, now);
    const deferredContext = deferred.status === "active"
      ? deferredContinuationContext(pending.value, deferred.value, decision)
      : "";
    return {
      context: continuationContext(pending.value, decision) + deferredContext,
    };
  }
  if (
    pending.status === "active" &&
    pending.value.preview_turn_hash !== turnHash(identity)
  ) {
    // A confirmation applies only to the first user turn after its preview.
    // Retire both the effect authority and any deferred multi-step transfer
    // context when that turn is not an unambiguous decision. Otherwise a bare
    // yes/no in an unrelated later conversation could revive a stale action.
    await Promise.all([
      clearContinuation(stateDirectory, identity),
      clearDeferredTransfer(stateDirectory, identity),
    ]);
  }

  if (isCheckAgainRequest(userMessage)) {
    const pendingDispatch = await readPendingDispatchStatus(
      stateDirectory,
      identity,
      now,
    );
    const pendingStatus = pendingDispatch.status === "absent"
      ? await readPendingStatusRead(stateDirectory, identity, now)
      : pendingDispatch;
    const originatingTurnHash = pendingStatus.status === "active"
      ? "dispatch_turn_hash" in pendingStatus.value
        ? pendingStatus.value.dispatch_turn_hash
        : pendingStatus.value.result_turn_hash
      : undefined;
    if (
      pendingStatus.status === "active" &&
      (!("state" in pendingStatus.value) || pendingStatus.value.state === "unresolved") &&
      originatingTurnHash !== turnHash(identity)
    ) {
      await publishRoutedTransfer(
        stateDirectory,
        identity,
        pendingStatus.value.tool,
        pendingStatus.value.binding,
        true,
        now,
        ttlMs,
      );
      return {
        context:
          "Agent Boost matched this exact status follow-up to one trusted unresolved " +
          "setup or operation from an earlier turn. Perform exactly one fresh read now: " +
          `call ${pendingStatus.value.tool} directly with exactly these arguments: ` +
          `${JSON.stringify(pendingStatus.value.binding)}. Do not answer from chat history, ` +
          "call a different Agent Boost tool, execute or retry the operation, create a " +
          "replacement, or reveal the internal setup/request ID. After the result, follow " +
          "only its current signed status and next-step instructions.",
      };
    }
    await publishRoutedTransfer(
      stateDirectory,
      identity,
      "$clarify_status_followup",
      {},
      true,
      now,
      ttlMs,
    );
    return {
      context:
        "Agent Boost cannot bind this status follow-up to a trusted unresolved setup or " +
        "operation from an earlier turn. Ask one concise clarification about which setup " +
        "or operation the user wants checked. Do not call any Agent Boost tool, do not " +
        "default to onboarding_start, and do not start, retry, or replace an operation.",
    };
  }

  const savedWalletSelection = await readSavedWalletSelection(
    stateDirectory,
    identity,
    now,
  );
  if (savedWalletSelection.status === "invalid") {
    // This state routes only a fresh read-only preview and carries no effect
    // authority, so discard corruption and fall back to ordinary routing.
    await clearSavedWalletSelection(stateDirectory, identity);
  } else if (savedWalletSelection.status === "active") {
    const walletName = selectedSavedWalletChoice(
      userMessage,
      savedWalletSelection.value.wallet_names,
    );
    if (walletName) {
      await publishRoutedSavedWalletChoice(
        stateDirectory,
        identity,
        walletName,
        now,
        ttlMs,
      );
      const argumentsJson = JSON.stringify({ wallet_name: walletName });
      return {
        context:
          "Agent Boost matched the user's reply to exactly one friendly name from " +
          "the preceding saved-wallet choices. Call wallet_preview_saved_profile_load " +
          `directly and exactly once with arguments ${argumentsJson}. This call is a ` +
          "read-only preview. Do not list wallets again, choose another name, apply the " +
          "load, or write user-facing text before the call. Show the signed preview and " +
          "end this assistant turn.",
      };
    }
  }

  const route = routingContext(userMessage);
  if (route === undefined) return {};
  if (route.includes("call wallet_get_private_balance_operation directly")) {
    const expectedFamily = privateBalanceOperationStatusFamily(userMessage);
    const pendingDispatch = await readPendingDispatchStatus(
      stateDirectory,
      identity,
      now,
    );
    const pendingStatus = pendingDispatch.status === "absent"
      ? await readPendingStatusRead(stateDirectory, identity, now)
      : pendingDispatch;
    const originatingTurnHash = pendingStatus.status === "active"
      ? "dispatch_turn_hash" in pendingStatus.value
        ? pendingStatus.value.dispatch_turn_hash
        : pendingStatus.value.result_turn_hash
      : undefined;
    if (
      pendingStatus.status === "active" &&
      pendingStatus.value.tool === "wallet_get_private_balance_operation" &&
      (!("state" in pendingStatus.value) || pendingStatus.value.state === "unresolved") &&
      privateBalanceStatusBindingMatchesFamily(
        pendingStatus.value.binding,
        expectedFamily,
      ) &&
      originatingTurnHash !== turnHash(identity)
    ) {
      await publishRoutedTransfer(
        stateDirectory,
        identity,
        "wallet_get_private_balance_operation",
        pendingStatus.value.binding,
        true,
        now,
        ttlMs,
      );
      return {
        context:
          "Agent Boost matched this private-balance status request to one trusted " +
          "unresolved operation from an earlier turn. Perform exactly one fresh " +
          "status read now: call wallet_get_private_balance_operation directly with " +
          `exactly these arguments: ${JSON.stringify(pendingStatus.value.binding)}. ` +
          "Do not answer from chat history, call another Agent Boost tool, execute or " +
          "retry the operation, create a replacement, or reveal the internal request " +
          "ID. After the result, follow only its current signed status.",
      };
    }
    await publishRoutedTransfer(
      stateDirectory,
      identity,
      "$clarify_status_followup",
      {},
      true,
      now,
      ttlMs,
    );
    return {
      context:
        "Agent Boost cannot bind this private-balance status request to a trusted " +
        "unresolved private-balance operation from an earlier turn. Ask one concise " +
        "clarification about which operation the user wants checked. Do not call any " +
        "Agent Boost tool, answer from chat history, start, retry, or replace an " +
        "operation.",
    };
  }
  const routedSavedWallet = typeof userMessage === "string" &&
      route.includes("call wallet_preview_saved_profile_load directly")
    ? savedWalletLoadReference(
      userMessage.normalize("NFKC").replace(/\s+/gu, " ").trim(),
    )
    : undefined;
  if (routedSavedWallet) {
    await publishRoutedSavedWalletChoice(
      stateDirectory,
      identity,
      routedSavedWallet.reference,
      now,
      ttlMs,
    );
  }
  const pinnedRequest = typeof userMessage === "string"
    ? routedRequest(userMessage, route)
    : undefined;
  if (pinnedRequest) {
    await publishRoutedTransfer(
      stateDirectory,
      identity,
      pinnedRequest.tool,
      pinnedRequest.binding,
      pinnedRequest.argumentsPinned,
      now,
      ttlMs,
    );
  }
  return { context: route };
}

export async function handleHermesTurnGatePayload(
  payload: unknown,
  options: HermesTurnGateOptions = {},
): Promise<HermesTurnGateResponse> {
  const record = asRecord(payload);
  if (!record) return identityUnavailableBlock();
  const event = nonEmptyString(record.hook_event_name);
  if (event !== "pre_tool_call" && event !== "post_tool_call" && event !== "pre_llm_call") {
    return {};
  }

  const stateDirectory = options.stateDirectory ?? hermesTurnGateStateDirectory();
  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid turn-gate clock");
  const ttlMs = positiveFiniteInteger(options.ttlMs, DEFAULT_TTL_MS);
  const identity = turnIdentity(record);

  if (event === "pre_llm_call") {
    const response = await handlePreLlmCall(
      record,
      stateDirectory,
      identity,
      now,
      ttlMs,
    );
    if (identity) {
      // Only the native plugin invokes this event in the managed integration.
      // Publish provenance after the gate completes so a crashed/malformed
      // pre-LLM invocation cannot leave an attestation that authorizes later
      // shell pre/post callbacks to touch root state.
      await publishRootTurn(stateDirectory, identity, now, ttlMs);
    }
    return response;
  }
  if (!identity) return identityUnavailableBlock();

  // Native Hermes pre-LLM hooks can identify a cache-parity review/side
  // question that deliberately shares the root session. The native adapter
  // records that exact session+turn before any tools run. Shell hook payloads
  // intentionally omit parent_session_id, so pre/post tool gates consult the
  // private tombstone before touching confirmation, route, or status state.
  // A corrupt tombstone remains fail-closed; only an absent/expired marker
  // permits the event to reach root-turn state.
  const nestedFork = await readNestedForkTurn(stateDirectory, identity, now);
  if (nestedFork.status !== "absent") {
    if (event === "pre_tool_call" && agentBoostInvocationTool(record)) {
      return nestedAgentBoostInvocationBlock();
    }
    return {};
  }
  const rootTurn = await readRootTurn(stateDirectory, identity, now);
  if (rootTurn.status !== "active") {
    if (event === "pre_tool_call" && agentBoostInvocationTool(record)) {
      return unclassifiedAgentBoostInvocationBlock();
    }
    return {};
  }

  if (event === "post_tool_call") {
    const trustedTool = trustedBoundaryProducerTool(record);
    const trustedStatusTool = trustedStatusProducerTool(record);
    const rawResult = asRecord(record.extra)?.result;
    const resultRecord = trustedTool === undefined
      ? undefined
      : topLevelToolResult(rawResult);
    const allowModeTransferExecution = resultRecord === undefined || trustedTool === undefined
      ? undefined
      : allowModeTransferExecutionFromResult(resultRecord, trustedTool);
    const statusResultRecord = trustedStatusTool === undefined
      ? undefined
      : topLevelToolResult(rawResult);
    const candidateStatusObservation = statusResultRecord === undefined || trustedStatusTool === undefined
      ? undefined
      : statusObservationFromResult(statusResultRecord, trustedStatusTool);
    const matchedStatusObservation = candidateStatusObservation && trustedStatusTool &&
        statusObservationMatchesInvocation(
          candidateStatusObservation,
          trustedStatusTool,
          toolInvocation(record),
        )
      ? candidateStatusObservation
      : undefined;
    const statusObservation = matchedStatusObservation && trustedStatusTool &&
        await statusObservationHasCurrentProvenance(
          stateDirectory,
          identity,
          matchedStatusObservation,
          trustedStatusTool,
          toolInvocation(record),
          now,
        )
      ? matchedStatusObservation
      : undefined;
    const noEffectResult = authenticatedNoEffectResult(resultRecord, trustedTool);
    const walletTreeResult = trustedStatusTool === "wallet_get_tree" &&
      authenticatedWalletTreeResult(statusResultRecord);
    const preview = trustedTool === undefined
      ? undefined
      : boundaryPreviewFromResult(rawResult);
    const savedSelection = resultRecord === undefined
      ? undefined
      : savedWalletSelectionFromResult(resultRecord);
    if (preview) {
      // Retire a previous-turn approval before publishing the new boundary so
      // interruption is fail-closed. The retirement is compare-and-retire:
      // a later same-turn post cannot erase the winning continuation.
      await retireSupersededContinuation(stateDirectory, identity, now);
      const wonBoundary = await publishBoundary(
        stateDirectory,
        identity,
        preview,
        now,
        ttlMs,
      );
      if (!wonBoundary) {
        // Another already-in-flight tool result won this assistant turn. Its
        // rendered preview, continuation, and deferred routing state are the
        // only state this turn may publish.
        await pruneExpiredState(stateDirectory, now);
        return {};
      }
      await options.onStateTransition?.("pending_continuation_retired");
      await options.onStateTransition?.("boundary_published");
    }
    if (trustedTool === "wallet_preview_saved_profile_load") {
      await clearRoutedSavedWalletChoice(stateDirectory, identity);
      if (savedSelection) {
        await publishSavedWalletSelection(
          stateDirectory,
          identity,
          savedSelection,
          now,
          ttlMs,
        );
      } else {
        await clearSavedWalletSelection(stateDirectory, identity);
      }
    } else if (preview) {
      // A different confirmation boundary supersedes a prior read-only choice.
      await clearSavedWalletSelection(stateDirectory, identity);
    }
    if (statusObservation?.state === "unresolved") {
      await publishPendingStatusRead(
        stateDirectory,
        identity,
        statusObservation.target,
        now,
        ttlMs,
      );
    } else if (statusObservation?.state === "terminal") {
      // Retain a bounded terminal tombstone. It is not routable, but prevents
      // a delayed unresolved result from resurrecting this operation.
      await publishPendingStatusRead(
        stateDirectory,
        identity,
        statusObservation.target,
        now,
        ttlMs,
        "terminal",
      );
    }
    if (statusObservation) {
      const pendingDispatch = await readPendingDispatchStatus(
        stateDirectory,
        identity,
        now,
      );
      if (
        pendingDispatch.status === "active" &&
        (dispatchMatchesInvocation(
          pendingDispatch.value,
          trustedStatusTool,
          toolInvocation(record),
        ) || sameStatusSubject(
            statusObservation.target,
            pendingDispatch.value,
            statusObservation.decisionId,
          ))
      ) {
        await clearPendingDispatchStatus(stateDirectory, identity);
      }
    }
    if (noEffectResult) {
      const pendingDispatch = await readPendingDispatchStatus(
        stateDirectory,
        identity,
        now,
      );
      if (
        pendingDispatch.status === "active" &&
        dispatchMatchesExactInvocation(
          pendingDispatch.value,
          identity,
          trustedTool,
          toolInvocation(record),
        )
      ) {
        // Omitted confirmation can be valid under an allow policy, so every
        // recoverable effect is staged before dispatch. Only a mirrored,
        // explicitly no-effect Agent Boost envelope for this exact invocation
        // can retire that provisional handle. A delayed result for another
        // dispatch may never clear the current recovery subject.
        await clearPendingDispatchStatus(stateDirectory, identity);
      }
    }
    if (walletTreeResult) {
      const pendingDispatch = await readPendingDispatchStatus(
        stateDirectory,
        identity,
        now,
      );
      if (
        pendingDispatch.status === "active" &&
        dispatchMatchesExactInvocation(
          pendingDispatch.value,
          identity,
          trustedStatusTool,
          toolInvocation(record),
        )
      ) {
        // wallet_get_tree uses the special verbatim model context rather than
        // the ordinary mirrored status envelope. Its signed rendering contract
        // is terminal for the exact staged tree reconciliation read.
        await clearPendingDispatchStatus(stateDirectory, identity);
      }
    }
    if (
      resultRecord &&
      authenticatedAgentBoostEnvelope(resultRecord) &&
      trustedTool &&
      trustedStatusTool === undefined
    ) {
      const pendingDispatch = await readPendingDispatchStatus(
        stateDirectory,
        identity,
        now,
      );
      if (
        pendingDispatch.status === "active" &&
        dispatchMatchesExactInvocation(
          pendingDispatch.value,
          identity,
          trustedTool,
          toolInvocation(record),
        )
      ) {
        // A trusted post result means Hermes received the authoritative effect
        // outcome, so the provisional no-post handle has served its purpose.
        // Unresolved status producers have already promoted it above.
        await clearPendingDispatchStatus(stateDirectory, identity);
      }
    }
    if (
      statusObservation?.releaseRoute === true &&
      trustedStatusTool &&
      STATUS_READ_TOOLS.has(trustedStatusTool as StatusReadTool)
    ) {
      const routedStatus = await readRoutedTransfer(stateDirectory, identity, now);
      const invocation = toolInvocation(record);
      if (
        routedStatus.status === "active" &&
        routedStatus.value.turn_hash === turnHash(identity) &&
        routedStatus.value.tool === trustedStatusTool &&
        invocation &&
        sameRoutedTransferArguments(invocation.input, routedStatus.value.binding) &&
        sameStatusSubject(statusObservation.target, {
          tool: routedStatus.value.tool as StatusReadTool,
          binding: routedStatus.value.binding,
        })
      ) {
        // Keep the exact route through pre_tool and the matching post_tool
        // result, then release it so private_ready setup can continue with
        // capabilities and the live wallet tree in this same assistant turn.
        await clearRoutedTransfer(stateDirectory, identity);
      }
    }
    const priorDeferred = await readDeferredTransfer(stateDirectory, identity, now);
    if (resultRecord) {
      const sourceSwitch = deferredTransferFromSourceSwitch(
        resultRecord,
        toolInvocation(record),
        trustedTool,
        identity,
        now,
        ttlMs,
      );
      const code = nonEmptyString(modelContextEnvelope(resultRecord)?.code);
      if (sourceSwitch) {
        await publishDeferredTransfer(stateDirectory, identity, sourceSwitch);
      } else if (
        code === "WALLET_REAUTHORIZATION_PLANNED" ||
        code === "WALLET_REAUTHORIZATION_CONFIRMATION_REQUIRED"
      ) {
        const promoted = priorDeferred.status === "active"
          ? promoteDeferredTransferForReauthorization(resultRecord, priorDeferred.value)
          : undefined;
        if (promoted) {
          await publishDeferredTransfer(stateDirectory, identity, promoted);
        } else {
          await clearDeferredTransfer(stateDirectory, identity);
        }
      } else if (code === "WALLET_REAUTHORIZATION_DENIED") {
        await clearDeferredTransfer(stateDirectory, identity);
      } else if (terminalTransferPreview(resultRecord)) {
        await clearDeferredTransfer(stateDirectory, identity);
      } else if (preview && priorDeferred.status === "active") {
        // Any unrelated hard boundary supersedes an unfinished deferred
        // transfer, just as it supersedes the prior confirmation preview.
        await clearDeferredTransfer(stateDirectory, identity);
      }
    }

    const completedInvocation = toolInvocation(record);
    const completedConfirmationTool = canonicalToolName(completedInvocation?.tool);
    if (
      completedInvocation &&
      (completedConfirmationTool === "wallet_apply_saved_profile_load" ||
        completedConfirmationTool === "wallet_apply_reauthorization") &&
      hermesBoolean(completedInvocation.input.user_confirmed) === false
    ) {
      await clearDeferredTransfer(stateDirectory, identity);
    }
    const transferPreviewProducer = trustedTool === "wallet_preview_regular_transfer" ||
      trustedTool === "wallet_plan_regular_transfer" ||
      trustedTool === "wallet_preview_private_transfer" ||
      trustedTool === "wallet_plan_private_payment" ||
      trustedTool === "wallet_preview_recovery_transfer" ||
      trustedTool === "wallet_plan_recovery_transfer";
    if (
      resultRecord &&
      transferPreviewProducer &&
      (allowModeTransferExecution !== undefined ||
        preview !== undefined ||
        validatedDeniedTransferPreview(resultRecord, trustedTool))
    ) {
      // A validated preview result consumes the original natural-language
      // route. Confirm mode has its independent hard boundary; allow mode gets
      // only the exact one-shot execute pin published below. Unknown or
      // malformed results keep the preview route fail-closed.
      await clearRoutedTransfer(stateDirectory, identity);
    }
    if (allowModeTransferExecution) {
      await publishAllowModeTransferExecution(
        stateDirectory,
        identity,
        allowModeTransferExecution.tool,
        allowModeTransferExecution.decisionId,
        now,
        ttlMs,
      );
    }
    if (preview?.continuation) {
      await publishContinuation(stateDirectory, identity, preview.continuation, now, ttlMs);
    }
    await pruneExpiredState(stateDirectory, now);
    return {};
  }

  const exactInvocationTool = agentBoostInvocationTool(record);
  const allowModeTransfer = await readAllowModeTransferExecution(
    stateDirectory,
    identity,
    now,
  );
  if (allowModeTransfer.status === "invalid" && exactInvocationTool) {
    return allowModeTransferBlock("invalid");
  }
  if (
    allowModeTransfer.status === "active" &&
    allowModeTransfer.value.state === "consumed" &&
    allowModeTransfer.value.preview_turn_hash === turnHash(identity) &&
    exactInvocationTool
  ) {
    // The exact allow-mode execute was already committed in this assistant
    // turn. Its post_tool observer is handled above, but no second pre_tool
    // invocation may run or stage a different status subject over the
    // original timeout-recovery handle.
    return allowModePostDispatchBlock();
  }

  const boundary = await readBoundary(stateDirectory, identity, now);
  if (boundary.status === "active") return boundaryBlock(boundary.value);
  if (boundary.status === "invalid") {
    return {
      action: "block",
      message:
        "Agent Boost could not validate the confirmation-boundary state for this turn. " +
        "The tool call was blocked and no wallet action was applied.",
    };
  }

  const routedWalletChoice = await readRoutedSavedWalletChoice(
    stateDirectory,
    identity,
    now,
  );
  if (routedWalletChoice.status === "invalid" && agentBoostInvocationTool(record)) {
    return {
      action: "block",
      message:
        "Agent Boost could not validate the pinned saved-wallet choice for this turn. " +
        "The tool call was blocked and no wallet was changed.",
    };
  }
  if (routedWalletChoice.status === "active") {
    if (routedWalletChoice.value.turn_hash !== turnHash(identity)) {
      return {
        action: "block",
        message:
          "Agent Boost rejected stale saved-wallet choice state. The tool call was " +
          "blocked and no wallet was changed.",
      };
    }
    const directive = routedSavedWalletChoiceDirective(record, routedWalletChoice.value);
    if (directive) return directive;
  }


  const routed = await readRoutedTransfer(stateDirectory, identity, now);
  if (routed.status === "invalid" && agentBoostInvocationTool(record)) {
    return {
      action: "block",
      message:
        "Agent Boost could not validate the pinned routing state for this explicit " +
        "transfer request. The tool call was blocked and no wallet action was applied.",
    };
  }
  if (routed.status === "active") {
    if (routed.value.turn_hash !== turnHash(identity)) {
      return {
        action: "block",
        message:
          "Agent Boost rejected stale pinned routing state. The tool call was blocked " +
          "and no wallet action was applied.",
      };
    }
    const directive = routedTransferDirective(record, routed.value);
    if (directive) return directive;
  }

  const invocation = toolInvocation(record);
  if (invocation?.invalidProtectedInput) return invalidProtectedInvocationBlock();
  if (
    allowModeTransfer.status === "active" &&
    allowModeTransfer.value.state === "active" &&
    exactInvocationTool &&
    (
      allowModeTransfer.value.preview_turn_hash !== turnHash(identity) ||
      exactInvocationTool !== allowModeTransfer.value.tool ||
      !invocation ||
      !sameRoutedTransferArguments(invocation.input, {
        decision_id: allowModeTransfer.value.decision_id,
      })
    )
  ) {
    return allowModeTransferBlock(
      allowModeTransfer.value.preview_turn_hash === turnHash(identity)
        ? "mismatch"
        : "stale",
    );
  }
  const confirmationTool = canonicalToolName(invocation?.tool);
  const confirmation = hermesBoolean(invocation?.input.user_confirmed);
  const binding = invocation && confirmationTool
    ? invocationBinding(confirmationTool, invocation.input)
    : undefined;
  const timeoutStatus = confirmation !== false && confirmationTool && binding
    ? timeoutRecoveryStatusTarget(confirmationTool, binding)
    : undefined;
  if (
    invocation &&
    confirmationTool &&
    confirmation !== undefined
  ) {
    const claimed = await claimMatchingContinuation(
      stateDirectory,
      identity,
      confirmationTool,
      binding,
      confirmation,
      now,
      confirmation && timeoutStatus && binding
        ? async () => publishPendingDispatchStatus(
            stateDirectory,
            identity,
            timeoutStatus,
            confirmationTool,
            binding,
            now,
            ttlMs,
          )
        : undefined,
    );
    if (claimed !== "allowed") return continuationBlock(claimed);
  } else if (timeoutStatus && confirmationTool && binding) {
    if (isTransferConfirmationTool(confirmationTool)) {
      const claimed = await claimAllowModeTransferExecution(
        stateDirectory,
        identity,
        exactInvocationTool,
        invocation?.input ?? {},
        now,
        async () => publishPendingDispatchStatus(
          stateDirectory,
          identity,
          timeoutStatus,
          confirmationTool,
          binding,
          now,
          ttlMs,
        ),
      );
      if (claimed !== "allowed") return allowModeTransferBlock(claimed);
    } else {
      // Non-transfer operations retain their existing allow-policy behavior.
      // Transfers require the stronger exact same-turn preview pin above.
      await publishPendingDispatchStatus(
        stateDirectory,
        identity,
        timeoutStatus,
        confirmationTool,
        binding,
        now,
        ttlMs,
      );
    }
  } else if (invocation) {
    const readTool = canonicalStatusReadTool(invocation.tool);
    const readBinding = readTool
      ? routedBinding(readTool, invocation.input, true)
      : undefined;
    const readTarget = readTool && readBinding
      ? statusReadTarget(readTool, readBinding)
      : undefined;
    const shouldStageRead = readTool !== "wallet_get_tree" || (
      routed.status === "active" &&
      routed.value.turn_hash === turnHash(identity) &&
      routed.value.tool === "wallet_get_tree"
    );
    if (readTool && readBinding && readTarget && shouldStageRead) {
      // A status read can itself time out. Staging its exact immutable binding
      // also prevents a delayed older read result from replacing a newer
      // subject's session-wide recovery handle.
      await publishPendingDispatchStatus(
        stateDirectory,
        identity,
        readTarget,
        readTool,
        readBinding,
        now,
        ttlMs,
      );
    }
  }
  return {};
}

async function readBoundedInput(input: AsyncIterable<unknown>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error("Hermes turn-gate hook input exceeded its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHermesTurnGate(
  options: HermesTurnGateIoOptions = {},
): Promise<void> {
  const maxInputBytes = positiveFiniteInteger(
    options.maxInputBytes,
    DEFAULT_MAX_INPUT_BYTES,
  );
  let response: HermesTurnGateResponse;
  try {
    const input = await readBoundedInput(
      options.stdin ?? (process.stdin as AsyncIterable<unknown>),
      maxInputBytes,
    );
    response = await handleHermesTurnGatePayload(JSON.parse(input), options);
  } catch {
    response = {
      action: "block",
      message:
        "Agent Boost could not validate this Hermes hook invocation, so the tool call " +
        "was blocked. No wallet action was applied.",
    };
  }
  (options.stdout ?? process.stdout).write(`${JSON.stringify(response)}\n`);
}
