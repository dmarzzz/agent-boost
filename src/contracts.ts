export const SEPOLIA_CHAIN_ID = 11_155_111;
export const SEPOLIA_CAIP2 = "eip155:11155111";
export const DEFAULT_FUNDING_WEI = 200_000_000_000_000_000n;
export const DEFAULT_SHIELD_WEI = 100_000_000_000_000_000n;
export const DEFAULT_PAYMENT_LIMIT_WEI = 50_000_000_000_000_000n;

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
  expiresAt: string;
  enabled: boolean;
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
  error?: OnboardingRecord["error"];
}

export interface WalletAdapter {
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
  }): Promise<{ transactionHash?: string; confirmed?: boolean }>;
}

export interface ChainClient {
  assertSepolia(): Promise<void>;
  getBalanceWei(address: string): Promise<bigint>;
}
