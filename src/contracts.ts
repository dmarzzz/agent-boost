export const SEPOLIA_CHAIN_ID = 11_155_111;
export const SEPOLIA_CAIP2 = "eip155:11155111";
export const DEFAULT_FUNDING_WEI = 200_000_000_000_000_000n;
export const DEFAULT_SHIELD_WEI = 100_000_000_000_000_000n;
export const DEFAULT_PAYMENT_LIMIT_WEI = 1_000_000_000_000_000_000n;
export const DEFAULT_MAX_PAYMENTS = 10;
export const DEFAULT_LIFETIME_LIMIT_WEI =
  DEFAULT_PAYMENT_LIMIT_WEI * BigInt(DEFAULT_MAX_PAYMENTS);
export const MAX_POLICY_PAYMENT_LIMIT_WEI = 100_000_000_000_000_000_000n;
export const MAX_POLICY_PAYMENTS = 100;
export const MAX_POLICY_LIFETIME_LIMIT_WEI =
  MAX_POLICY_PAYMENT_LIMIT_WEI * BigInt(MAX_POLICY_PAYMENTS);
export const MAX_POLICY_TTL_MS = 30 * 24 * 60 * 60_000;

export type PaymentApproval = "allow" | "confirm" | "deny";

export type OnboardingPhase =
  | "not_started"
  | "creating_wallet"
  | "preparing_privacy"
  | "awaiting_funding"
  | "funding_pending"
  | "funded_public"
  | "shielding"
  | "private_ready"
  | "failed";

export type PaymentPhase =
  | "planned"
  | "executing"
  | "submitted"
  | "confirmed"
  | "failed"
  | "indeterminate";

export interface DelegationPolicy {
  mode: "testnet_delegated";
  chainId: typeof SEPOLIA_CHAIN_ID;
  perPaymentLimitWei: string;
  lifetimeLimitWei: string;
  spentWei: string;
  maxPayments: number;
  expiresAt: string;
  enabled: boolean;
}

export interface WalletPolicySnapshot extends DelegationPolicy {
  paymentsUsed: number;
  paymentsRemaining: number;
}

export interface PolicyUpdatePlan {
  version: 1;
  decisionId: string;
  createdAt: string;
  expiresAt: string;
  current: WalletPolicySnapshot;
  proposed: WalletPolicySnapshot;
  decision: "allow" | "deny";
  blockers: string[];
  approval: {
    action: "confirm";
    userConfirmationRequired: true;
  };
  appliedAt?: string;
}

export interface PolicyUpdateReceipt {
  version: 1;
  decisionId: string;
  appliedAt: string;
  policy: WalletPolicySnapshot;
}

export interface OnboardingRecord {
  version: 1;
  setupId: string;
  revision: number;
  phase: OnboardingPhase;
  createdAt: string;
  updatedAt: string;
  address?: string;
  publicBalanceWei: string;
  privateBalanceWei: string;
  requiredFundingWei: string;
  shieldAmountWei: string;
  uiUrl?: string;
  uiOpened?: boolean;
  delegation: DelegationPolicy;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface PaymentPlan {
  version: 1;
  decisionId: string;
  recipient: string;
  amountWei: string;
  intentDigest: string;
  createdAt: string;
  expiresAt: string;
  decision: "allow" | "deny" | "indeterminate";
  blockers: string[];
  approval: {
    action: PaymentApproval;
    userConfirmationRequired: boolean;
  };
}

export interface PaymentRequest {
  version: 1;
  requestId: string;
  clientRequestId: string;
  decisionId: string;
  recipient: string;
  amountWei: string;
  phase: PaymentPhase;
  createdAt: string;
  updatedAt: string;
  transactionHash?: string;
  userOperationHash?: string;
  confirmation?: {
    method: "adapter" | "recipient_balance_delta" | "transaction_receipt";
    checkedAt: string;
  };
  /** Internal reconciliation checkpoint. Omitted from MCP responses. */
  recipientBalanceBeforeWei?: string;
  /** Internal reconciliation bookkeeping. Omitted from MCP responses. */
  reconciliation?: {
    attempts: number;
    checkedAt: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface PublicOnboardingSnapshot {
  setupId: string;
  revision: number;
  phase: OnboardingPhase;
  address?: string;
  publicBalanceWei: string;
  privateBalanceWei: string;
  requiredFundingWei: string;
  shieldAmountWei: string;
  qrDataUrl?: string;
  delegation: DelegationPolicy;
  rpcRoute?: {
    mode: "tor";
    scope: "ethereum_json_rpc";
    status: "starting" | "ready" | "failed" | "closed";
    directFallback: false;
  };
  error?: OnboardingRecord["error"];
}

export interface WalletAdapter {
  /** Select an existing or not-yet-created local wallet profile. */
  selectWallet?(walletName: string): void;
  ensureWallet(): Promise<void>;
  nextFreshAddress(): Promise<string>;
  prewarmPrivacy(): Promise<void>;
  shieldWei(amountWei: bigint): Promise<{
    transactionHash?: string;
    confirmed?: boolean;
  }>;
  getPrivateBalanceWei(): Promise<bigint>;
  getBalanceSnapshot?(): Promise<{
    publicBalanceWei: bigint;
    privateBalanceWei: bigint;
  }>;
  executePrivatePayment(input: {
    recipient: string;
    amountWei: bigint;
  }): Promise<{
    transactionHash?: string;
    userOperationHash?: string;
    confirmed?: boolean;
  }>;
}

export type TransactionReceiptStatus = "pending" | "success" | "reverted";

export interface ChainClient {
  assertSepolia(): Promise<void>;
  getBalanceWei(address: string): Promise<bigint>;
  getTransactionReceiptStatus?(
    transactionHash: string,
  ): Promise<TransactionReceiptStatus>;
}
