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

export type WalletProfileOrigin = "created" | "adopted" | "discovered";

export interface WalletProfileRecord {
  version: 1;
  walletId: string;
  name: string;
  origin: WalletProfileOrigin;
  status: "available" | "archived";
  createdAt: string;
  updatedAt: string;
  lastSelectedAt?: string;
  selectionEpoch: number;
  authorizationId?: string;
  /** Private state archive identifiers. Paths are never returned through MCP. */
  archiveIds: string[];
  /** Last durable workflow state for this wallet, including while inactive. */
  onboarding?: OnboardingRecord;
}

export interface WalletSelectionBinding {
  walletId: string;
  walletName: string;
  selectionEpoch: number;
}

export interface WalletAuthorizationBinding extends WalletSelectionBinding {
  authorizationId: string;
}

export interface WalletInventoryItem {
  name: string;
  network: "sepolia" | "mainnet" | "unknown";
}

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

export interface WalletTreeSnapshot {
  version: 1;
  chainId: typeof SEPOLIA_CHAIN_ID;
  network: "Sepolia";
  observedAt: string;
  profiles: WalletTreeProfile[];
  archivedProfiles: number;
  relationship: {
    type: "profile_container";
    impliesControl: false;
  };
}

export interface WalletTreeProfile {
  shortName: string;
  active: boolean;
  setupPhase: OnboardingPhase;
  main: WalletTreeAccount & {
    shortName: "main";
    role: "main_funding_source";
  };
  subwallets: Array<WalletTreeAccount & {
    shortName: "private";
    role: "private_payment_pocket";
  }>;
}

export interface WalletTreeAccount {
  balanceWei?: string;
  status: "ready" | "preparing" | "not_created" | "unavailable";
  freshness: "live" | "last_known" | "unavailable";
}

export interface PolicyUpdatePlan {
  version: 1;
  decisionId: string;
  wallet: WalletSelectionBinding;
  /** Authority in effect when this decision was planned, if any. */
  authorizationId?: string;
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
  appliedPolicy?: WalletPolicySnapshot;
}

export interface PolicyUpdateReceipt {
  version: 1;
  decisionId: string;
  wallet: WalletSelectionBinding;
  appliedAt: string;
  policy: WalletPolicySnapshot;
  authorizationEffect: "preserved";
  counterEffect: "preserved";
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
  authorization: WalletAuthorizationBinding;
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
  authorization: WalletAuthorizationBinding;
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

export interface RecoveryTransferPlan {
  version: 1;
  decisionId: string;
  wallet: WalletSelectionBinding;
  recipient: string;
  /** Exact amount sent by the wallet-controlled tail call. */
  amountWei: string;
  /** One configured Tornado denomination consumed by this operation. */
  withdrawalAmountWei: string;
  /** Conservative amount left outside the tail call for paymaster fees. */
  feeReserveWei: string;
  maxRecipientAmountWei: string;
  privateBalanceSnapshotWei: string;
  remainingPrivateBalanceEstimateWei: string;
  balanceRevision: number;
  scope: "single_tornado_denomination";
  feeModel: "reserved_from_wallet_controlled_remainder";
  intentDigest: string;
  createdAt: string;
  expiresAt: string;
  decision: "allow" | "deny";
  blockers: string[];
  approval: {
    action: "confirm";
    userConfirmationRequired: true;
  };
  consumedByRequestId?: string;
}

export interface RecoveryTransferRequest {
  version: 1;
  requestId: string;
  clientRequestId: string;
  decisionId: string;
  wallet: WalletSelectionBinding;
  recipient: string;
  amountWei: string;
  withdrawalAmountWei: string;
  feeReserveWei: string;
  remainingPrivateBalanceEstimateWei: string;
  scope: "single_tornado_denomination";
  feeModel: "reserved_from_wallet_controlled_remainder";
  phase: Exclude<PaymentPhase, "planned">;
  createdAt: string;
  updatedAt: string;
  transactionHash?: string;
  userOperationHash?: string;
  confirmation?: PaymentRequest["confirmation"];
  /** Internal reconciliation checkpoint. Omitted from MCP responses. */
  recipientBalanceBeforeWei?: string;
  /** Internal reconciliation bookkeeping. Omitted from MCP responses. */
  reconciliation?: PaymentRequest["reconciliation"];
  error?: PaymentRequest["error"];
}

export interface WalletReauthorizationPlan {
  version: 1;
  decisionId: string;
  wallet: WalletSelectionBinding;
  priorAuthorizationId?: string;
  currentPolicy: WalletPolicySnapshot;
  proposedPolicy: WalletPolicySnapshot;
  authorizationEffect: "replace";
  counterEffect: "reset_spend_and_payment_count";
  intentDigest: string;
  createdAt: string;
  expiresAt: string;
  decision: "allow" | "deny";
  blockers: string[];
  approval: { action: "confirm"; userConfirmationRequired: true };
  appliedAt?: string;
  appliedAuthorizationId?: string;
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
  /** Enumerate public wallet metadata only. */
  listWallets?(): Promise<WalletInventoryItem[]>;
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
  /** Recover an exact amount through a fresh wallet-controlled account + tail call. */
  executeRecoveryTransfer?(input: {
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
