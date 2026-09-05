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
/** Conservative native balance held back so a regular ETH transfer can pay gas. */
export const REGULAR_TRANSFER_GAS_RESERVE_WEI = 1_000_000_000_000_000n;
/**
 * Bounded native fee reserve for the substantially larger Tornado deposit call.
 * The signed transaction is independently constrained by this ceiling and the
 * deposit-specific gas limit before the network guard permits a broadcast.
 */
export const TORNADO_DEPOSIT_GAS_RESERVE_WEI = 10_000_000_000_000_000n;

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
  /** Stable private pockets, each backed by an isolated Kohaku wallet profile. */
  privateBalances: Record<string, PrivateBalanceRecord>;
  /** Default private pocket used when a caller omits a pocket name. */
  defaultPrivateBalanceId: string;
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

export interface PublicChangeAccountRecord {
  version: 1;
  address: string;
  balanceWei: string;
  sourceRequestId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateBalanceRecord {
  version: 1;
  privateBalanceId: string;
  name: string;
  /** Internal Kohaku profile backing this pocket. Never expose through MCP. */
  backendWalletName: string;
  status: "available" | "archived";
  /** Last-known actual private balance reported by this pocket's backend profile. */
  balanceWei: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Per-pocket limit checked inside the profile's wallet-wide aggregate policy. */
  delegation: DelegationPolicy;
  /** Wallet-controlled public leftovers, keyed by lowercase address. */
  publicChangeAccounts?: Record<string, PublicChangeAccountRecord>;
}

export interface PrivateBalanceBinding extends WalletSelectionBinding {
  privateBalanceId: string;
  privateBalanceName: string;
  /** Internal Kohaku profile name. Never expose through MCP. */
  backendWalletName: string;
  privateBalanceRevision: number;
}

export interface PrivateBalanceCreationPlan {
  version: 1;
  decisionId: string;
  wallet: WalletSelectionBinding;
  walletOnboardingRevision: number;
  privateBalanceId: string;
  privateBalanceName: string;
  /** Reserved internal Kohaku profile name. Never expose through MCP. */
  backendWalletName: string;
  initialPolicy: DelegationPolicy;
  intentDigest: string;
  createdAt: string;
  expiresAt: string;
  decision: "allow" | "deny";
  blockers: string[];
  approval: { action: "confirm"; userConfirmationRequired: true };
  cancelledAt?: string;
  consumedByRequestId?: string;
  appliedAt?: string;
}

export interface PrivateBalanceCreationRequest {
  version: 1;
  requestId: string;
  clientRequestId: string;
  decisionId: string;
  privateBalance: PrivateBalanceBinding;
  phase: "creating" | "created" | "failed" | "indeterminate";
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  error?: { code: string; message: string };
}

export type PrivateBalanceFundingRoute = "shield_from_main" | "rebalance_private";

export interface PrivateBalanceFundingPlan {
  version: 1;
  decisionId: string;
  sourceWallet: WalletSelectionBinding;
  targetWallet: WalletSelectionBinding;
  route: PrivateBalanceFundingRoute;
  sourcePrivateBalance?: PrivateBalanceBinding;
  targetPrivateBalance: PrivateBalanceBinding;
  amountWei: string;
  mainBalanceSnapshotWei: string;
  gasReserveWei: string;
  shieldDenominationWei: string;
  /** Full source denomination consumed by rebalance_private. */
  withdrawalAmountWei?: string;
  aggregatePrivateBalanceSnapshotWei: string;
  sourcePrivateBalanceSnapshotWei?: string;
  targetPrivateBalanceSnapshotWei: string;
  /** Executor that must submit the prepared deposit call. Never expose through MCP. */
  sourceExecutorAddress: string;
  /** Prepared target note commitment. Never expose through MCP. */
  targetCommitment: string;
  /** Exact prepared deposit call. Never expose through MCP. */
  preparedDepositCall: { to: string; data: string; valueWei: string };
  intentDigest: string;
  createdAt: string;
  expiresAt: string;
  decision: "allow" | "deny";
  blockers: string[];
  approval: { action: "confirm"; userConfirmationRequired: true };
  cancelledAt?: string;
  consumedByRequestId?: string;
  appliedAt?: string;
}

export interface PrivateBalanceFundingRequest {
  version: 1;
  requestId: string;
  clientRequestId: string;
  decisionId: string;
  sourceWallet: WalletSelectionBinding;
  targetWallet: WalletSelectionBinding;
  route: PrivateBalanceFundingRoute;
  sourcePrivateBalance?: PrivateBalanceBinding;
  targetPrivateBalance: PrivateBalanceBinding;
  amountWei: string;
  aggregatePrivateBalanceBeforeWei: string;
  aggregatePrivateBalanceAfterWei?: string;
  sourcePrivateBalanceBeforeWei?: string;
  sourcePrivateBalanceAfterWei?: string;
  /** Safe snapshot of wallet-controlled public change retained by the source pocket. */
  sourcePublicChangeWei?: string;
  targetPrivateBalanceBeforeWei: string;
  targetPrivateBalanceAfterWei?: string;
  /** Prepared target note commitment. Never expose through MCP. */
  targetCommitment: string;
  /** Exact prepared deposit call. Never expose through MCP. */
  preparedDepositCall: { to: string; data: string; valueWei: string };
  phase: "executing" | "submitted" | "confirmed" | "failed" | "indeterminate";
  createdAt: string;
  updatedAt: string;
  /** Durable checkpoint written before control enters a potentially broadcasting adapter. */
  broadcastStartedAt?: string;
  transactionHash?: string;
  userOperationHash?: string;
  confirmation?: {
    method:
      | "adapter"
      | "private_balance_delta"
      | "transaction_receipt"
      | "user_operation_receipt";
    checkedAt: string;
  };
  reconciliation?: { attempts: number; checkedAt: string };
  appliedAt?: string;
  error?: { code: string; message: string };
}

export interface PrivateBalancePolicyUpdatePlan {
  version: 1;
  decisionId: string;
  privateBalance: PrivateBalanceBinding;
  current: WalletPolicySnapshot;
  proposed: WalletPolicySnapshot;
  intentDigest: string;
  createdAt: string;
  expiresAt: string;
  decision: "allow" | "deny";
  blockers: string[];
  approval: { action: "confirm"; userConfirmationRequired: true };
  cancelledAt?: string;
  consumedByRequestId?: string;
  appliedAt?: string;
  appliedPolicy?: WalletPolicySnapshot;
}

export interface PrivateBalancePolicyUpdateRequest {
  version: 1;
  requestId: string;
  clientRequestId: string;
  decisionId: string;
  privateBalance: PrivateBalanceBinding;
  phase: "applying" | "applied" | "failed";
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  policy?: WalletPolicySnapshot;
  error?: { code: string; message: string };
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
  /** Wallet-wide send policy; absent only before a profile has been initialized. */
  policy?: WalletTreePolicySnapshot;
  main: WalletTreeAccount & {
    shortName: "main";
    role: "main_funding_source";
  };
  subwallets: Array<WalletTreeAccount & {
    shortName: string;
    role: "private_payment_pocket";
    policy: WalletTreePolicySnapshot;
  }>;
}

/**
 * Exact durable policy state carried by the tree. Inactive-profile policy
 * state is deliberately labeled last-known instead of being presented as a
 * live observation of that profile's backend wallet.
 */
export interface WalletTreePolicySnapshot extends WalletPolicySnapshot {
  freshness: "current" | "last_known";
}

export interface WalletTreeAccount {
  balanceWei?: string;
  /** Address-free aggregate of wallet-controlled public leftovers for a pocket. */
  publicChangeWei?: string;
  publicChangeFreshness?: "live" | "last_known";
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
  /** Internal exact call prepared before the initial shield is handed off. */
  shieldPreparedDepositCall?: { to: string; data: string; valueWei: string };
  /** Internal durable controller checkpoint written before broadcast. */
  shieldBroadcastStartedAt?: string;
  /** Exact EOA transaction recovered from the pre-network journal. */
  shieldTransactionHash?: string;
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
  /** Physical private-pocket source. Required in durable v3 state. */
  privateBalanceId?: string;
  /** Source pocket revision bound when this plan was stored. */
  privateBalanceRevision?: number;
  /** Full private denomination debited even when the recipient amount is smaller. */
  privateBalanceDebitWei?: string;
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
  /** Physical private-pocket source. Required in durable v3 state. */
  privateBalanceId?: string;
  /** Source pocket revision bound when this request was stored. */
  privateBalanceRevision?: number;
  /** Full private denomination debited even when the recipient amount is smaller. */
  privateBalanceDebitWei?: string;
  /** Durable balance reservation timestamp. Required once a debit is reserved. */
  privateBalanceDebitedAt?: string;
  /** Exact-once restoration timestamp after a definitive failed broadcast. */
  privateBalanceRestoredAt?: string;
  /** Safe snapshot of wallet-controlled public change retained after execution. */
  publicChangeWei?: string;
  phase: PaymentPhase;
  createdAt: string;
  updatedAt: string;
  /** Internal durable checkpoint set immediately before the adapter broadcasts. */
  broadcastStartedAt?: string;
  transactionHash?: string;
  userOperationHash?: string;
  confirmation?: {
    method:
      | "adapter"
      | "recipient_balance_delta"
      | "transaction_receipt"
      | "user_operation_receipt";
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

export interface RegularTransferPlan {
  version: 1;
  decisionId: string;
  recipient: string;
  amountWei: string;
  mainBalanceSnapshotWei: string;
  gasReserveWei: string;
  authorization: WalletAuthorizationBinding;
  /** Pocket whose wallet-controlled public change funds this transfer. */
  sourcePrivateBalance?: PrivateBalanceBinding;
  /** Internal exact wallet-controlled public account. Never expose through MCP. */
  sourcePublicAddress?: string;
  intentDigest: string;
  createdAt: string;
  expiresAt: string;
  decision: "allow" | "deny";
  blockers: string[];
  approval: {
    action: PaymentApproval;
    userConfirmationRequired: boolean;
  };
}

export interface RegularTransferRequest {
  version: 1;
  requestId: string;
  clientRequestId: string;
  decisionId: string;
  recipient: string;
  amountWei: string;
  gasReserveWei: string;
  authorization: WalletAuthorizationBinding;
  sourcePrivateBalance?: PrivateBalanceBinding;
  /** Internal exact wallet-controlled public account. Never expose through MCP. */
  sourcePublicAddress?: string;
  sourcePublicBalanceBeforeWei?: string;
  sourcePublicBalanceAfterWei?: string;
  phase: Exclude<PaymentPhase, "planned">;
  createdAt: string;
  updatedAt: string;
  /** Internal durable checkpoint set immediately before the adapter broadcasts. */
  broadcastStartedAt?: string;
  /** Internal exact-once aggregate-policy reservation bookkeeping. */
  policySpendDebitedAt?: string;
  policySpendRestoredAt?: string;
  privatePolicySpendDebitedAt?: string;
  privatePolicySpendRestoredAt?: string;
  transactionHash?: string;
  confirmation?: PaymentRequest["confirmation"];
  /** Internal reconciliation checkpoint. Omitted from MCP responses. */
  recipientBalanceBeforeWei?: string;
  /** Internal reconciliation bookkeeping. Omitted from MCP responses. */
  reconciliation?: PaymentRequest["reconciliation"];
  error?: PaymentRequest["error"];
}

export interface RecoveryTransferPlan {
  version: 1;
  decisionId: string;
  wallet: WalletSelectionBinding;
  /** Physical private-pocket source. Required in durable v3 state. */
  privateBalanceId?: string;
  /** Source pocket revision bound when this plan was stored. */
  privateBalanceRevision?: number;
  /** Full private denomination debited by this recovery. */
  privateBalanceDebitWei?: string;
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
  /** Physical private-pocket source. Required in durable v3 state. */
  privateBalanceId?: string;
  /** Source pocket revision bound when this request was stored. */
  privateBalanceRevision?: number;
  /** Full private denomination debited by this recovery. */
  privateBalanceDebitWei?: string;
  /** Durable balance reservation timestamp. Required once a debit is reserved. */
  privateBalanceDebitedAt?: string;
  /** Exact-once restoration timestamp after a definitive failed broadcast. */
  privateBalanceRestoredAt?: string;
  /** Safe snapshot of wallet-controlled public change retained after execution. */
  publicChangeWei?: string;
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
  /** Internal durable checkpoint set immediately before the adapter broadcasts. */
  broadcastStartedAt?: string;
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
  /** Ensure one explicitly named backend without mutating the selected wallet. */
  ensureBackendWallet?(walletName: string): Promise<void>;
  /** Sync one explicitly named backend and return its spendable Tornado ETH. */
  syncBackendWallet?(walletName: string): Promise<bigint>;
  nextFreshAddress(): Promise<string>;
  /** Peek without consuming the explicitly named backend's next HD address. */
  peekNextFreshAddressForWallet?(walletName: string): Promise<string>;
  prewarmPrivacy(): Promise<void>;
  shieldWei(amountWei: bigint, input: {
    sourceAddress: string;
    /** Reuse the first durable preparation after a safe pre-network retry. */
    preparedDepositCall?: { to: string; data: string; valueWei: string };
    /** Stable setup-derived identity for exact crash recovery. */
    broadcastRequestId: string;
    /** Persist the exact prepared deposit before any network handoff. */
    beforeBroadcast: (
      preparedDepositCall: { to: string; data: string; valueWei: string },
    ) => Promise<void>;
  }): Promise<{
    transactionHash?: string;
    confirmed?: boolean;
  }>;
  getPrivateBalanceWei(): Promise<bigint>;
  getPrivateBalanceWeiForWallet?(walletName: string): Promise<bigint>;
  getBalanceSnapshot?(): Promise<{
    publicBalanceWei: bigint;
    privateBalanceWei: bigint;
  }>;
  getBalanceSnapshotForWallet?(walletName: string): Promise<{
    publicBalanceWei: bigint;
    privateBalanceWei: bigint;
  }>;
  executePrivatePayment(input: {
    recipient: string;
    amountWei: bigint;
    /** Stable request identity used to recover the exact UserOperation after a crash. */
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash?: string;
    userOperationHash?: string;
    confirmed?: boolean;
  }>;
  executePrivatePaymentFromWallet?(walletName: string, input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash?: string;
    userOperationHash?: string;
    confirmed?: boolean;
  }>;
  /** Send native Sepolia ETH directly from the selected main public account. */
  executeRegularTransfer?(input: {
    /** Exact selected main account that must sign the transaction. */
    sourceAddress: string;
    recipient: string;
    amountWei: bigint;
    /** Stable request identity used to recover the exact signed transaction. */
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash?: string;
    confirmed?: boolean;
  }>;
  /** Send Sepolia ETH from a named pocket's persisted public change account. */
  executeRegularTransferFromWallet?(walletName: string, input: {
    sourceAddress: string;
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash?: string;
    confirmed?: boolean;
  }>;
  /** Recover an exact amount through a fresh wallet-controlled account + tail call. */
  executeRecoveryTransfer?(input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash?: string;
    userOperationHash?: string;
    confirmed?: boolean;
  }>;
  executeRecoveryTransferFromWallet?(walletName: string, input: {
    recipient: string;
    amountWei: bigint;
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash?: string;
    userOperationHash?: string;
    confirmed?: boolean;
  }>;
  /** Prepare one allowlisted Sepolia Tornado ETH deposit owned by a target backend. */
  prepareTornadoEthDeposit?(input: {
    targetWalletName: string;
    executorAddress: string;
    amountWei: bigint;
  }): Promise<{
    targetCommitment: string;
    preparedDepositCall: { to: string; data: string; valueWei: string };
  }>;
  /** Execute an adapter-prepared Tornado deposit from a named public account. */
  executePreparedMainDeposit?(input: {
    sourceWalletName: string;
    sourceExecutorAddress: string;
    preparedDepositCall: { to: string; data: string; valueWei: string };
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash?: string;
    confirmed?: boolean;
  }>;
  /** Atomically unshield full notes and tail-call one allowlisted target deposit. */
  executePrivateRebalance?(input: {
    sourceWalletName: string;
    /** Plan-bound result of peekNextFreshAddressForWallet. */
    sourceExecutorAddress: string;
    withdrawalAmountWei: bigint;
    preparedDepositCall: { to: string; data: string; valueWei: string };
    broadcastRequestId: string;
    beforeBroadcast: () => Promise<void>;
  }): Promise<{
    transactionHash?: string;
    userOperationHash?: string;
    confirmed?: boolean;
  }>;
  /** Read the durable checkpoint written immediately before the bundler send. */
  getPrivateBroadcastCheckpoint?(
    requestId: string,
  ): Promise<PrivateBroadcastCheckpoint | undefined>;
  /** Read the exact EOA transaction journaled before JSON-RPC handoff. */
  getRawTransactionBroadcastCheckpoint?(
    requestId: string,
  ): Promise<RawTransactionBroadcastCheckpoint | undefined>;
  /** Persist the exact wallet-controlled `--next` sender after receipt recovery. */
  ensurePrivateChangeAccount?(
    walletName: string,
    expectedAddress: string,
  ): Promise<void>;
}

export interface PrivateBroadcastCheckpoint {
  version: 1;
  requestId: string;
  userOperationHash: string;
  sender: string;
  entryPointAddress: string;
  journaledAt: string;
}

export interface RawTransactionBroadcastCheckpoint {
  version: 1;
  requestId: string;
  transactionHash: string;
  from: string;
  to: string;
  valueWei: string;
  data: string;
  chainId: typeof SEPOLIA_CHAIN_ID;
  nonce: string;
  gas: string;
  transactionType: "legacy" | "eip2930" | "eip1559";
  journaledAt: string;
}

export type TransactionReceiptStatus = "pending" | "success" | "reverted";

export type UserOperationReceiptStatus =
  | { status: "pending" }
  | {
      status: Exclude<TransactionReceiptStatus, "pending">;
      transactionHash: string;
    };

export interface ChainClient {
  assertSepolia(): Promise<void>;
  getBalanceWei(address: string): Promise<bigint>;
  getTransactionReceiptStatus?(
    transactionHash: string,
  ): Promise<TransactionReceiptStatus>;
  /** Resolve an ERC-4337 v0.8 UserOperation from its exact on-chain event. */
  getUserOperationReceiptStatus?(
    userOperationHash: string,
    expectedSender?: string,
  ): Promise<UserOperationReceiptStatus>;
}
