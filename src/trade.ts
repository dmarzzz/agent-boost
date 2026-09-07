import { SEPOLIA_CAIP2 } from "./contracts.js";

export const TRADE_CONTRACT = "org.agentboost.trade/0.1" as const;
export const TRADE_RESOURCE_URI = "agent-boost://capabilities/trade/v1" as const;

export type TradeMode = "regular" | "private";
export type TradeAction = "plan" | "execute" | "status";

export interface TradeIntent {
  version: 1;
  operation: "swap_exact_in";
  mode: TradeMode;
  chainId: typeof SEPOLIA_CAIP2;
  sellAssetId: string;
  buyAssetId: string;
  sellAmountAtomic: string;
  maxSlippageBps: number;
  recipient: string;
}

export interface TradeCapabilities {
  [key: string]: unknown;
  contract: typeof TRADE_CONTRACT;
  status: "not_configured";
  chain_id: typeof SEPOLIA_CAIP2;
  network_name: "Sepolia";
  operation: "swap_exact_in";
  mainnet_available: false;
  modes: {
    regular: {
      status: "not_configured";
      venue: null;
      quote_available: false;
      execution_available: false;
      signing_available: false;
      reason_code: "SEPOLIA_SWAP_VENUE_NOT_CONFIGURED";
    };
    private: {
      status: "not_configured";
      venue: null;
      quote_available: false;
      execution_available: false;
      signing_available: false;
      privacy_design_status: "not_selected";
      privacy_claim_available: false;
      regular_fallback_allowed: false;
      reason_code: "PRIVATE_SWAP_DESIGN_NOT_SELECTED";
    };
  };
  hard_limits: {
    allowed_chain_ids: [typeof SEPOLIA_CAIP2];
    cross_chain_available: false;
    automatic_mode_fallback: false;
    network_requests_enabled: false;
    signing_enabled: false;
    transaction_submission_enabled: false;
  };
  readiness: {
    regular: "not_configured";
    private: "not_configured";
    active_venue_count: 0;
  };
}

export interface TradeUnavailable {
  [key: string]: unknown;
  status: "not_configured";
  requested_action: TradeAction;
  requested_mode: TradeMode;
  chain_id: typeof SEPOLIA_CAIP2;
  reason_code:
    | "SEPOLIA_SWAP_VENUE_NOT_CONFIGURED"
    | "PRIVATE_SWAP_DESIGN_NOT_SELECTED";
  message: string;
  setup_required: string[];
  effects: {
    state_changed: false;
    network_request_attempted: false;
    quote_requested: false;
    approval_requested: false;
    signature_requested: false;
    transaction_submitted: false;
  };
  intent?: TradeIntent;
  decision_id?: string;
  request_id?: string;
}

const REGULAR_SETUP_REQUIRED = [
  "select_sepolia_swap_venue",
  "define_quote_validation_policy",
  "define_token_approval_policy",
  "implement_signing_and_submission_adapter",
  "implement_durable_reconciliation",
];

const PRIVATE_SETUP_REQUIRED = [
  "select_private_swap_design_and_venue",
  "define_private_swap_threat_model",
  "define_private_asset_and_fee_flow",
  "implement_private_signing_and_submission_adapter",
  "implement_durable_reconciliation",
];

export function tradeCapabilities(): TradeCapabilities {
  return {
    contract: TRADE_CONTRACT,
    status: "not_configured",
    chain_id: SEPOLIA_CAIP2,
    network_name: "Sepolia",
    operation: "swap_exact_in",
    mainnet_available: false,
    modes: {
      regular: {
        status: "not_configured",
        venue: null,
        quote_available: false,
        execution_available: false,
        signing_available: false,
        reason_code: "SEPOLIA_SWAP_VENUE_NOT_CONFIGURED",
      },
      private: {
        status: "not_configured",
        venue: null,
        quote_available: false,
        execution_available: false,
        signing_available: false,
        privacy_design_status: "not_selected",
        privacy_claim_available: false,
        regular_fallback_allowed: false,
        reason_code: "PRIVATE_SWAP_DESIGN_NOT_SELECTED",
      },
    },
    hard_limits: {
      allowed_chain_ids: [SEPOLIA_CAIP2],
      cross_chain_available: false,
      automatic_mode_fallback: false,
      network_requests_enabled: false,
      signing_enabled: false,
      transaction_submission_enabled: false,
    },
    readiness: {
      regular: "not_configured",
      private: "not_configured",
      active_venue_count: 0,
    },
  };
}

export function tradeNotConfigured(input: {
  action: TradeAction;
  mode: TradeMode;
  intent?: TradeIntent;
  decisionId?: string;
  requestId?: string;
}): TradeUnavailable {
  const isPrivate = input.mode === "private";
  return {
    status: "not_configured",
    requested_action: input.action,
    requested_mode: input.mode,
    chain_id: SEPOLIA_CAIP2,
    reason_code: isPrivate
      ? "PRIVATE_SWAP_DESIGN_NOT_SELECTED"
      : "SEPOLIA_SWAP_VENUE_NOT_CONFIGURED",
    message: isPrivate
      ? "Private Sepolia trading is not set up yet."
      : "Regular Sepolia trading is not set up yet.",
    setup_required: [
      ...(isPrivate ? PRIVATE_SETUP_REQUIRED : REGULAR_SETUP_REQUIRED),
    ],
    effects: {
      state_changed: false,
      network_request_attempted: false,
      quote_requested: false,
      approval_requested: false,
      signature_requested: false,
      transaction_submitted: false,
    },
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    ...(input.decisionId === undefined ? {} : { decision_id: input.decisionId }),
    ...(input.requestId === undefined ? {} : { request_id: input.requestId }),
  };
}
