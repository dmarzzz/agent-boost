export type AgentBoostRequestErrorCode =
  | "RECIPIENT_PRIVATE_ACCOUNT_UNSUPPORTED"
  | "RECIPIENT_WALLET_AMBIGUOUS"
  | "RECIPIENT_WALLET_ARCHIVED"
  | "RECIPIENT_WALLET_MAIN_ADDRESS_UNAVAILABLE"
  | "RECIPIENT_WALLET_NETWORK_UNSUPPORTED"
  | "RECIPIENT_WALLET_NOT_FOUND"
  | "REGULAR_TRANSFER_SELF_SEND_BLOCKED"
  | "SOURCE_WALLET_AMBIGUOUS"
  | "SOURCE_WALLET_ARCHIVED"
  | "SOURCE_WALLET_LOAD_UNAVAILABLE"
  | "SOURCE_WALLET_NETWORK_UNSUPPORTED"
  | "SOURCE_WALLET_NOT_FOUND"
  | "SOURCE_WALLET_SWITCH_REQUIRED"
  | "TRANSFER_RECIPIENT_REFERENCE_CONFLICT"
  | "USE_RECOVERY_TRANSFER"
  | "WALLET_LIFECYCLE_BINDING_REQUIRED"
  | "WALLET_LIFECYCLE_PREVIEW_STALE"
  | "WALLET_PROFILE_AMBIGUOUS"
  | "WALLET_PROFILE_NOT_FOUND"
  | "WALLET_PROFILE_REFERENCE_CONFLICT"
  | "WALLET_PROFILE_SELECTION_REQUIRED"
  | "WALLET_REAUTHORIZATION_REQUIRES_ACTIVE_WALLET"
  | "WALLET_SWITCH_BINDING_REQUIRED"
  | "WALLET_SWITCH_PREVIEW_STALE";

/**
 * A fail-closed request error whose code and redacted details are safe to pass
 * through the MCP envelope. Secrets and private material must never be placed
 * in `details`; a user-supplied public recipient may be retained only when it
 * is required to show and resume an exact transfer or source-switch preview.
 */
export class AgentBoostRequestError extends Error {
  readonly code: AgentBoostRequestErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: AgentBoostRequestErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AgentBoostRequestError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Preserves the point at which wallet execution failed. Callers may release a
 * reservation only when `mayHaveBroadcast` is false; otherwise they must
 * reconcile the chain before retrying.
 */
export class WalletExecutionError extends Error {
  readonly code: string;
  readonly mayHaveBroadcast: boolean;

  constructor(
    code: string,
    message: string,
    options: { mayHaveBroadcast: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WalletExecutionError";
    this.code = code;
    this.mayHaveBroadcast = options.mayHaveBroadcast;
  }
}
