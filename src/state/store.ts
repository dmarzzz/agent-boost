import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type {
  DelegationPolicy,
  OnboardingRecord,
  PaymentPlan,
  PaymentRequest,
  PolicyUpdatePlan,
  PrivateBalanceBinding,
  PrivateBalanceCreationPlan,
  PrivateBalanceCreationRequest,
  PrivateBalanceFundingPlan,
  PrivateBalanceFundingRequest,
  PrivateBalancePolicyUpdatePlan,
  PrivateBalancePolicyUpdateRequest,
  PrivateBalanceRecord,
  RegularTransferPlan,
  RegularTransferRequest,
  RecoveryTransferPlan,
  RecoveryTransferRequest,
  WalletProfileOrigin,
  WalletProfileRecord,
  WalletPolicySnapshot,
  WalletReauthorizationPlan,
} from "../contracts.js";

export interface StateDocument {
  version: 3;
  wallet?: {
    activeWalletId: string;
    activeName: string;
    profiles: Record<string, WalletProfileRecord>;
  };
  onboarding?: OnboardingRecord;
  plans: Record<string, PaymentPlan>;
  policyPlans: Record<string, PolicyUpdatePlan>;
  requests: Record<string, PaymentRequest>;
  regularPlans: Record<string, RegularTransferPlan>;
  regularRequests: Record<string, RegularTransferRequest>;
  recoveryPlans: Record<string, RecoveryTransferPlan>;
  recoveryRequests: Record<string, RecoveryTransferRequest>;
  reauthorizationPlans: Record<string, WalletReauthorizationPlan>;
  privateBalanceCreationPlans: Record<string, PrivateBalanceCreationPlan>;
  privateBalanceCreationRequests: Record<string, PrivateBalanceCreationRequest>;
  privateBalanceFundingPlans: Record<string, PrivateBalanceFundingPlan>;
  privateBalanceFundingRequests: Record<string, PrivateBalanceFundingRequest>;
  privateBalancePolicyUpdatePlans: Record<string, PrivateBalancePolicyUpdatePlan>;
  privateBalancePolicyUpdateRequests: Record<string, PrivateBalancePolicyUpdateRequest>;
}

type Version2WalletProfileRecord = Omit<
  WalletProfileRecord,
  "privateBalances" | "defaultPrivateBalanceId"
>;

interface Version2StateDocument {
  version: 2;
  wallet?: {
    activeWalletId: string;
    activeName: string;
    profiles: Record<string, Version2WalletProfileRecord>;
  };
  onboarding?: OnboardingRecord;
  plans: Record<string, PaymentPlan>;
  policyPlans: Record<string, PolicyUpdatePlan>;
  requests: Record<string, PaymentRequest>;
  regularPlans: Record<string, RegularTransferPlan>;
  regularRequests: Record<string, RegularTransferRequest>;
  recoveryPlans: Record<string, RecoveryTransferPlan>;
  recoveryRequests: Record<string, RecoveryTransferRequest>;
  reauthorizationPlans: Record<string, WalletReauthorizationPlan>;
}

interface LegacyPolicyUpdatePlan extends Omit<PolicyUpdatePlan, "wallet"> {
  wallet?: PolicyUpdatePlan["wallet"];
}

interface LegacyPaymentPlan extends Omit<PaymentPlan, "authorization" | "approval"> {
  authorization?: PaymentPlan["authorization"];
  approval?: PaymentPlan["approval"];
}

interface LegacyStateDocument {
  version: 1;
  wallet?: { activeName: string };
  onboarding?: OnboardingRecord;
  plans?: Record<string, LegacyPaymentPlan>;
  policyPlans?: Record<string, LegacyPolicyUpdatePlan>;
  requests?: Record<string, PaymentRequest>;
}

const EMPTY_STATE: StateDocument = {
  version: 3,
  plans: {},
  policyPlans: {},
  requests: {},
  regularPlans: {},
  regularRequests: {},
  recoveryPlans: {},
  recoveryRequests: {},
  reauthorizationPlans: {},
  privateBalanceCreationPlans: {},
  privateBalanceCreationRequests: {},
  privateBalanceFundingPlans: {},
  privateBalanceFundingRequests: {},
  privateBalancePolicyUpdatePlans: {},
  privateBalancePolicyUpdateRequests: {},
};

const idSchema = z.string().min(1).max(300);
const walletNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const atomicSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const positiveAtomicSchema = atomicSchema.refine((value) => BigInt(value) > 0n);
const timestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "invalid timestamp",
);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const transactionHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const SEPOLIA_TORNADO_ETH_0_1_POOL =
  "0x8c4a04d872a6c1be37964a21ba3a138525dff50b";
const TORNADO_DEPOSIT_CALL_PATTERN = /^0xb214faa5([0-9a-f]{64})$/;
const preparedDepositCallSchema = z.object({
  to: addressSchema,
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  valueWei: positiveAtomicSchema,
}).strict();
const selectionSchema = z.object({
  walletId: idSchema,
  walletName: walletNameSchema,
  selectionEpoch: z.number().int().safe().positive(),
}).strict();
const authorizationSchema = selectionSchema.extend({
  authorizationId: z.string().regex(/^auth_[A-Za-z0-9-]+$/),
}).strict();
const privateBalanceBindingSchema = selectionSchema.extend({
  privateBalanceId: idSchema,
  privateBalanceName: walletNameSchema,
  backendWalletName: walletNameSchema,
  privateBalanceRevision: z.number().int().safe().nonnegative(),
}).strict();
const delegationSchema = z.object({
  mode: z.literal("testnet_delegated"),
  chainId: z.literal(11_155_111),
  perPaymentLimitWei: atomicSchema,
  lifetimeLimitWei: atomicSchema,
  spentWei: atomicSchema,
  maxPayments: z.number().int().safe().positive(),
  expiresAt: timestampSchema,
  enabled: z.boolean(),
}).strict();
const publicChangeAccountSchema = z.object({
  version: z.literal(1),
  address: addressSchema,
  balanceWei: atomicSchema,
  sourceRequestId: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
const privateBalanceSchema = z.object({
  version: z.literal(1),
  privateBalanceId: idSchema,
  name: walletNameSchema,
  backendWalletName: walletNameSchema,
  status: z.enum(["available", "archived"]),
  balanceWei: atomicSchema,
  revision: z.number().int().safe().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  delegation: delegationSchema,
  publicChangeAccounts: z.record(z.string(), publicChangeAccountSchema).optional(),
}).strict();
const legacyDelegationSchema = delegationSchema.extend({
  maxPayments: z.number().int().safe().positive().optional(),
}).strict();
const onboardingBase = {
  version: z.literal(1),
  setupId: idSchema,
  revision: z.number().int().safe().nonnegative(),
  phase: z.enum([
    "not_started", "creating_wallet", "preparing_privacy", "awaiting_funding",
    "funding_pending", "funded_public", "shielding", "private_ready", "failed",
  ]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  address: addressSchema.optional(),
  publicBalanceWei: atomicSchema,
  privateBalanceWei: atomicSchema,
  requiredFundingWei: atomicSchema,
  shieldAmountWei: atomicSchema,
  shieldPreparedDepositCall: preparedDepositCallSchema.optional(),
  shieldBroadcastStartedAt: timestampSchema.optional(),
  shieldTransactionHash: transactionHashSchema.optional(),
  uiUrl: z.string().min(1).optional(),
  uiOpened: z.boolean().optional(),
  error: z.object({
    code: idSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }).strict().optional(),
};

function validateOnboardingShieldCheckpoint(
  onboarding: {
    shieldAmountWei: string;
    shieldPreparedDepositCall?:
      | { to: string; data: string; valueWei: string }
      | undefined;
    shieldBroadcastStartedAt?: string | undefined;
    shieldTransactionHash?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  const call = onboarding.shieldPreparedDepositCall;
  if (call) {
    const commitment = TORNADO_DEPOSIT_CALL_PATTERN.exec(call.data)?.[1];
    if (
      call.to !== SEPOLIA_TORNADO_ETH_0_1_POOL ||
      call.data !== call.data.toLowerCase() ||
      !commitment ||
      /^0{64}$/u.test(commitment) ||
      call.valueWei !== onboarding.shieldAmountWei
    ) {
      context.addIssue({
        code: "custom",
        path: ["shieldPreparedDepositCall"],
        message: "onboarding shield preparation is not canonical",
      });
    }
  }
  if (
    (onboarding.shieldBroadcastStartedAt !== undefined ||
      onboarding.shieldTransactionHash !== undefined) &&
    call === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["shieldPreparedDepositCall"],
      message: "onboarding shield broadcast requires its exact preparation",
    });
  }
  if (
    onboarding.shieldTransactionHash !== undefined &&
    (onboarding.shieldBroadcastStartedAt === undefined ||
      onboarding.shieldTransactionHash !==
        onboarding.shieldTransactionHash.toLowerCase())
  ) {
    context.addIssue({
      code: "custom",
      path: ["shieldTransactionHash"],
      message: "onboarding shield transaction checkpoint is not canonical",
    });
  }
}

const onboardingSchema = z.object({
  ...onboardingBase,
  delegation: delegationSchema,
}).strict().superRefine(validateOnboardingShieldCheckpoint);
const legacyOnboardingSchema = z.object({
  ...onboardingBase,
  delegation: legacyDelegationSchema,
}).strict();
const confirmationSchema = z.object({
  method: z.enum([
    "adapter",
    "recipient_balance_delta",
    "transaction_receipt",
    "user_operation_receipt",
  ]),
  checkedAt: timestampSchema,
}).strict();
const reconciliationSchema = z.object({
  attempts: z.number().int().safe().nonnegative(),
  checkedAt: timestampSchema,
}).strict();
const requestErrorSchema = z.object({ code: idSchema, message: z.string().min(1) }).strict();
const paymentPlanBase = {
  version: z.literal(1),
  decisionId: idSchema,
  recipient: addressSchema,
  amountWei: atomicSchema,
  intentDigest: digestSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  decision: z.enum(["allow", "deny", "indeterminate"]),
  blockers: z.array(idSchema),
};
const paymentApprovalSchema = z.object({
  action: z.enum(["allow", "confirm", "deny"]),
  userConfirmationRequired: z.boolean(),
}).strict();
const paymentPlanSchema = z.object({
  ...paymentPlanBase,
  approval: paymentApprovalSchema,
  authorization: authorizationSchema,
  privateBalanceId: idSchema,
  privateBalanceRevision: z.number().int().safe().nonnegative(),
  privateBalanceDebitWei: positiveAtomicSchema,
}).strict();
const version2PaymentPlanSchema = z.object({
  ...paymentPlanBase,
  approval: paymentApprovalSchema,
  authorization: authorizationSchema,
}).strict();
const legacyPaymentPlanSchema = z.object({
  ...paymentPlanBase,
  approval: paymentApprovalSchema.optional(),
  authorization: authorizationSchema.optional(),
}).strict();
const paymentRequestBase = {
  version: z.literal(1),
  requestId: idSchema,
  clientRequestId: idSchema,
  decisionId: idSchema,
  recipient: addressSchema,
  amountWei: atomicSchema,
  phase: z.enum(["planned", "executing", "submitted", "confirmed", "failed", "indeterminate"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  broadcastStartedAt: timestampSchema.optional(),
  transactionHash: transactionHashSchema.optional(),
  userOperationHash: transactionHashSchema.optional(),
  confirmation: confirmationSchema.optional(),
  recipientBalanceBeforeWei: atomicSchema.optional(),
  reconciliation: reconciliationSchema.optional(),
  error: requestErrorSchema.optional(),
};
const paymentRequestSchema = z.object({
  ...paymentRequestBase,
  authorization: authorizationSchema,
  privateBalanceId: idSchema,
  privateBalanceRevision: z.number().int().safe().nonnegative(),
  privateBalanceDebitWei: positiveAtomicSchema,
  privateBalanceDebitedAt: timestampSchema.optional(),
  privateBalanceRestoredAt: timestampSchema.optional(),
  publicChangeWei: atomicSchema.optional(),
}).strict();
const version2PaymentRequestSchema = z.object({
  ...paymentRequestBase,
  authorization: authorizationSchema,
}).strict();
const legacyPaymentRequestSchema = z.object({
  ...paymentRequestBase,
  authorization: authorizationSchema.optional(),
}).strict();
const regularTransferPlanSchema = z.object({
  version: z.literal(1),
  decisionId: idSchema,
  recipient: addressSchema,
  amountWei: atomicSchema,
  mainBalanceSnapshotWei: atomicSchema,
  gasReserveWei: atomicSchema,
  authorization: authorizationSchema,
  sourcePrivateBalance: privateBalanceBindingSchema.optional(),
  sourcePublicAddress: addressSchema.optional(),
  intentDigest: digestSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  decision: z.enum(["allow", "deny"]),
  blockers: z.array(idSchema),
  approval: paymentApprovalSchema,
}).strict().superRefine((plan, context) => {
  if ((plan.sourcePrivateBalance === undefined) !==
    (plan.sourcePublicAddress === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["sourcePublicAddress"],
      message: "Pocket-sourced regular transfer requires both source bindings",
    });
  }
});
const regularTransferRequestSchema = z.object({
  version: z.literal(1),
  requestId: idSchema,
  clientRequestId: idSchema,
  decisionId: idSchema,
  recipient: addressSchema,
  amountWei: atomicSchema,
  gasReserveWei: atomicSchema,
  authorization: authorizationSchema,
  sourcePrivateBalance: privateBalanceBindingSchema.optional(),
  sourcePublicAddress: addressSchema.optional(),
  sourcePublicBalanceBeforeWei: atomicSchema.optional(),
  sourcePublicBalanceAfterWei: atomicSchema.optional(),
  phase: z.enum(["executing", "submitted", "confirmed", "failed", "indeterminate"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  broadcastStartedAt: timestampSchema.optional(),
  policySpendDebitedAt: timestampSchema.optional(),
  policySpendRestoredAt: timestampSchema.optional(),
  privatePolicySpendDebitedAt: timestampSchema.optional(),
  privatePolicySpendRestoredAt: timestampSchema.optional(),
  transactionHash: transactionHashSchema.optional(),
  confirmation: confirmationSchema.optional(),
  recipientBalanceBeforeWei: atomicSchema.optional(),
  reconciliation: reconciliationSchema.optional(),
  error: requestErrorSchema.optional(),
}).strict().superRefine((request, context) => {
  if ((request.sourcePrivateBalance === undefined) !==
    (request.sourcePublicAddress === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["sourcePublicAddress"],
      message: "Pocket-sourced regular transfer requires both source bindings",
    });
  }
  if (!request.sourcePrivateBalance && (
    request.sourcePublicBalanceBeforeWei !== undefined ||
    request.sourcePublicBalanceAfterWei !== undefined ||
    request.privatePolicySpendDebitedAt !== undefined ||
    request.privatePolicySpendRestoredAt !== undefined
  )) {
    context.addIssue({
      code: "custom",
      path: ["sourcePrivateBalance"],
      message: "Main regular transfer cannot contain pocket-source bookkeeping",
    });
  }
  if (request.privatePolicySpendRestoredAt && !request.privatePolicySpendDebitedAt) {
    context.addIssue({
      code: "custom",
      path: ["privatePolicySpendRestoredAt"],
      message: "Private policy spend cannot be restored before it is debited",
    });
  }
});
const policySnapshotSchema = delegationSchema.extend({
  paymentsUsed: z.number().int().safe().nonnegative(),
  paymentsRemaining: z.number().int().safe().nonnegative(),
}).strict();
const legacyPolicySnapshotSchema = legacyDelegationSchema.extend({
  paymentsUsed: z.number().int().safe().nonnegative(),
  paymentsRemaining: z.number().int().safe().nonnegative(),
}).strict();
const policyPlanBase = {
  version: z.literal(1),
  decisionId: idSchema,
  authorizationId: z.string().regex(/^auth_[A-Za-z0-9-]+$/).optional(),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  decision: z.enum(["allow", "deny"]),
  blockers: z.array(idSchema),
  approval: z.object({ action: z.literal("confirm"), userConfirmationRequired: z.literal(true) }).strict(),
  appliedAt: timestampSchema.optional(),
};
const policyPlanSchema = z.object({
  ...policyPlanBase,
  wallet: selectionSchema,
  current: policySnapshotSchema,
  proposed: policySnapshotSchema,
  appliedPolicy: policySnapshotSchema.optional(),
}).strict();
const legacyPolicyPlanSchema = z.object({
  ...policyPlanBase,
  wallet: selectionSchema.optional(),
  current: legacyPolicySnapshotSchema,
  proposed: legacyPolicySnapshotSchema,
  appliedPolicy: legacyPolicySnapshotSchema.optional(),
}).strict();
const recoveryPlanBase = {
  version: z.literal(1), decisionId: idSchema, wallet: selectionSchema,
  recipient: addressSchema, amountWei: atomicSchema, withdrawalAmountWei: atomicSchema,
  feeReserveWei: atomicSchema, maxRecipientAmountWei: atomicSchema,
  privateBalanceSnapshotWei: atomicSchema,
  remainingPrivateBalanceEstimateWei: atomicSchema,
  balanceRevision: z.number().int().safe().nonnegative(),
  scope: z.literal("single_tornado_denomination"),
  feeModel: z.literal("reserved_from_wallet_controlled_remainder"),
  intentDigest: digestSchema, createdAt: timestampSchema, expiresAt: timestampSchema,
  decision: z.enum(["allow", "deny"]), blockers: z.array(idSchema),
  approval: z.object({ action: z.literal("confirm"), userConfirmationRequired: z.literal(true) }).strict(),
  consumedByRequestId: idSchema.optional(),
};
const recoveryPlanSchema = z.object({
  ...recoveryPlanBase,
  privateBalanceId: idSchema,
  privateBalanceRevision: z.number().int().safe().nonnegative(),
  privateBalanceDebitWei: positiveAtomicSchema,
}).strict();
const version2RecoveryPlanSchema = z.object(recoveryPlanBase).strict();
const recoveryRequestBase = {
  version: z.literal(1), requestId: idSchema, clientRequestId: idSchema,
  decisionId: idSchema, wallet: selectionSchema, recipient: addressSchema,
  amountWei: atomicSchema, withdrawalAmountWei: atomicSchema, feeReserveWei: atomicSchema,
  remainingPrivateBalanceEstimateWei: atomicSchema,
  scope: z.literal("single_tornado_denomination"),
  feeModel: z.literal("reserved_from_wallet_controlled_remainder"),
  phase: z.enum(["executing", "submitted", "confirmed", "failed", "indeterminate"]),
  createdAt: timestampSchema, updatedAt: timestampSchema,
  broadcastStartedAt: timestampSchema.optional(),
  transactionHash: transactionHashSchema.optional(), userOperationHash: transactionHashSchema.optional(),
  confirmation: confirmationSchema.optional(), recipientBalanceBeforeWei: atomicSchema.optional(),
  reconciliation: reconciliationSchema.optional(), error: requestErrorSchema.optional(),
};
const recoveryRequestSchema = z.object({
  ...recoveryRequestBase,
  privateBalanceId: idSchema,
  privateBalanceRevision: z.number().int().safe().nonnegative(),
  privateBalanceDebitWei: positiveAtomicSchema,
  privateBalanceDebitedAt: timestampSchema.optional(),
  privateBalanceRestoredAt: timestampSchema.optional(),
  publicChangeWei: atomicSchema.optional(),
}).strict();
const version2RecoveryRequestSchema = z.object(recoveryRequestBase).strict();
const reauthorizationPlanSchema = z.object({
  version: z.literal(1), decisionId: idSchema, wallet: selectionSchema,
  priorAuthorizationId: z.string().regex(/^auth_[A-Za-z0-9-]+$/).optional(),
  currentPolicy: policySnapshotSchema,
  proposedPolicy: policySnapshotSchema,
  authorizationEffect: z.literal("replace"),
  counterEffect: z.literal("reset_spend_and_payment_count"),
  intentDigest: digestSchema, createdAt: timestampSchema, expiresAt: timestampSchema,
  decision: z.enum(["allow", "deny"]), blockers: z.array(idSchema),
  approval: z.object({ action: z.literal("confirm"), userConfirmationRequired: z.literal(true) }).strict(),
  appliedAt: timestampSchema.optional(),
  appliedAuthorizationId: z.string().regex(/^auth_[A-Za-z0-9-]+$/).optional(),
}).strict();
const privateBalanceApprovalSchema = z.object({
  action: z.literal("confirm"),
  userConfirmationRequired: z.literal(true),
}).strict();
const privateBalanceCreationPlanSchema = z.object({
  version: z.literal(1), decisionId: idSchema, wallet: selectionSchema,
  walletOnboardingRevision: z.number().int().safe().nonnegative(),
  privateBalanceId: idSchema, privateBalanceName: walletNameSchema,
  backendWalletName: walletNameSchema,
  initialPolicy: delegationSchema, intentDigest: digestSchema,
  createdAt: timestampSchema, expiresAt: timestampSchema,
  decision: z.enum(["allow", "deny"]), blockers: z.array(idSchema),
  approval: privateBalanceApprovalSchema, cancelledAt: timestampSchema.optional(),
  consumedByRequestId: idSchema.optional(), appliedAt: timestampSchema.optional(),
}).strict();
const privateBalanceCreationRequestSchema = z.object({
  version: z.literal(1), requestId: idSchema, clientRequestId: idSchema,
  decisionId: idSchema, privateBalance: privateBalanceBindingSchema,
  phase: z.enum(["creating", "created", "failed", "indeterminate"]),
  createdAt: timestampSchema, updatedAt: timestampSchema,
  appliedAt: timestampSchema.optional(), error: requestErrorSchema.optional(),
}).strict();
const privateBalanceFundingRouteSchema = z.enum([
  "shield_from_main",
  "rebalance_private",
]);
const privateBalanceFundingPlanSchema = z.object({
  version: z.literal(1), decisionId: idSchema,
  sourceWallet: selectionSchema, targetWallet: selectionSchema,
  route: privateBalanceFundingRouteSchema,
  sourcePrivateBalance: privateBalanceBindingSchema.optional(),
  targetPrivateBalance: privateBalanceBindingSchema,
  amountWei: positiveAtomicSchema, mainBalanceSnapshotWei: atomicSchema,
  gasReserveWei: atomicSchema, shieldDenominationWei: positiveAtomicSchema,
  withdrawalAmountWei: positiveAtomicSchema.optional(),
  aggregatePrivateBalanceSnapshotWei: atomicSchema,
  sourcePrivateBalanceSnapshotWei: atomicSchema.optional(),
  targetPrivateBalanceSnapshotWei: atomicSchema,
  sourceExecutorAddress: addressSchema, targetCommitment: idSchema,
  preparedDepositCall: preparedDepositCallSchema, intentDigest: digestSchema,
  createdAt: timestampSchema, expiresAt: timestampSchema,
  decision: z.enum(["allow", "deny"]), blockers: z.array(idSchema),
  approval: privateBalanceApprovalSchema, cancelledAt: timestampSchema.optional(),
  consumedByRequestId: idSchema.optional(), appliedAt: timestampSchema.optional(),
}).strict().superRefine((plan, context) => {
  if (plan.route === "rebalance_private" && !plan.sourcePrivateBalance) {
    context.addIssue({
      code: "custom",
      path: ["sourcePrivateBalance"],
      message: "rebalance_private requires a source private balance",
    });
  }
  if (plan.route === "rebalance_private" && !plan.withdrawalAmountWei) {
    context.addIssue({
      code: "custom",
      path: ["withdrawalAmountWei"],
      message: "rebalance_private requires a withdrawal amount",
    });
  }
  if (plan.route === "shield_from_main" && plan.sourcePrivateBalance) {
    context.addIssue({
      code: "custom",
      path: ["sourcePrivateBalance"],
      message: "shield_from_main cannot name a source private balance",
    });
  }
  if (plan.route === "shield_from_main" && plan.withdrawalAmountWei) {
    context.addIssue({
      code: "custom",
      path: ["withdrawalAmountWei"],
      message: "shield_from_main cannot include a withdrawal amount",
    });
  }
});
const privateBalanceFundingConfirmationSchema = z.object({
  method: z.enum([
    "adapter",
    "private_balance_delta",
    "transaction_receipt",
    "user_operation_receipt",
  ]),
  checkedAt: timestampSchema,
}).strict();
const privateBalanceFundingRequestSchema = z.object({
  version: z.literal(1), requestId: idSchema, clientRequestId: idSchema,
  decisionId: idSchema, sourceWallet: selectionSchema, targetWallet: selectionSchema,
  route: privateBalanceFundingRouteSchema,
  sourcePrivateBalance: privateBalanceBindingSchema.optional(),
  targetPrivateBalance: privateBalanceBindingSchema,
  amountWei: positiveAtomicSchema,
  aggregatePrivateBalanceBeforeWei: atomicSchema,
  aggregatePrivateBalanceAfterWei: atomicSchema.optional(),
  sourcePrivateBalanceBeforeWei: atomicSchema.optional(),
  sourcePrivateBalanceAfterWei: atomicSchema.optional(),
  targetPrivateBalanceBeforeWei: atomicSchema,
  targetPrivateBalanceAfterWei: atomicSchema.optional(),
  targetCommitment: idSchema, preparedDepositCall: preparedDepositCallSchema,
  phase: z.enum(["executing", "submitted", "confirmed", "failed", "indeterminate"]),
  createdAt: timestampSchema, updatedAt: timestampSchema,
  broadcastStartedAt: timestampSchema.optional(),
  transactionHash: transactionHashSchema.optional(),
  userOperationHash: transactionHashSchema.optional(),
  sourcePublicChangeWei: atomicSchema.optional(),
  confirmation: privateBalanceFundingConfirmationSchema.optional(),
  reconciliation: reconciliationSchema.optional(), appliedAt: timestampSchema.optional(),
  error: requestErrorSchema.optional(),
}).strict().superRefine((request, context) => {
  if (request.route === "rebalance_private" && !request.sourcePrivateBalance) {
    context.addIssue({
      code: "custom",
      path: ["sourcePrivateBalance"],
      message: "rebalance_private requires a source private balance",
    });
  }
  if (request.route === "shield_from_main" && request.sourcePrivateBalance) {
    context.addIssue({
      code: "custom",
      path: ["sourcePrivateBalance"],
      message: "shield_from_main cannot name a source private balance",
    });
  }
});
const privateBalancePolicyUpdatePlanSchema = z.object({
  version: z.literal(1), decisionId: idSchema,
  privateBalance: privateBalanceBindingSchema,
  current: policySnapshotSchema, proposed: policySnapshotSchema,
  intentDigest: digestSchema, createdAt: timestampSchema, expiresAt: timestampSchema,
  decision: z.enum(["allow", "deny"]), blockers: z.array(idSchema),
  approval: privateBalanceApprovalSchema, cancelledAt: timestampSchema.optional(),
  consumedByRequestId: idSchema.optional(), appliedAt: timestampSchema.optional(),
  appliedPolicy: policySnapshotSchema.optional(),
}).strict();
const privateBalancePolicyUpdateRequestSchema = z.object({
  version: z.literal(1), requestId: idSchema, clientRequestId: idSchema,
  decisionId: idSchema, privateBalance: privateBalanceBindingSchema,
  phase: z.enum(["applying", "applied", "failed"]),
  createdAt: timestampSchema, updatedAt: timestampSchema,
  appliedAt: timestampSchema.optional(), policy: policySnapshotSchema.optional(),
  error: requestErrorSchema.optional(),
}).strict();
const walletProfileBase = {
  version: z.literal(1), walletId: idSchema, name: walletNameSchema,
  origin: z.enum(["created", "adopted", "discovered"]),
  status: z.enum(["available", "archived"]), createdAt: timestampSchema,
  updatedAt: timestampSchema, lastSelectedAt: timestampSchema.optional(),
  selectionEpoch: z.number().int().safe().nonnegative(),
  authorizationId: z.string().regex(/^auth_[A-Za-z0-9-]+$/).optional(),
  archiveIds: z.array(idSchema), onboarding: onboardingSchema.optional(),
};
const version2WalletProfileSchema = z.object(walletProfileBase).strict();
const walletProfileSchema = z.object({
  ...walletProfileBase,
  privateBalances: z.record(z.string(), privateBalanceSchema),
  defaultPrivateBalanceId: idSchema,
}).strict();
const version2StateSchema = z.object({
  version: z.literal(2),
  wallet: z.object({
    activeWalletId: idSchema,
    activeName: walletNameSchema,
    profiles: z.record(z.string(), version2WalletProfileSchema),
  }).strict().optional(),
  onboarding: onboardingSchema.optional(),
  plans: z.record(z.string(), version2PaymentPlanSchema),
  policyPlans: z.record(z.string(), policyPlanSchema),
  requests: z.record(z.string(), version2PaymentRequestSchema),
  regularPlans: z.record(z.string(), regularTransferPlanSchema),
  regularRequests: z.record(z.string(), regularTransferRequestSchema),
  recoveryPlans: z.record(z.string(), version2RecoveryPlanSchema),
  recoveryRequests: z.record(z.string(), version2RecoveryRequestSchema),
  reauthorizationPlans: z.record(z.string(), reauthorizationPlanSchema),
}).strict();
const stateSchema = z.object({
  version: z.literal(3),
  wallet: z.object({
    activeWalletId: idSchema,
    activeName: walletNameSchema,
    profiles: z.record(z.string(), walletProfileSchema),
  }).strict().optional(),
  onboarding: onboardingSchema.optional(),
  plans: z.record(z.string(), paymentPlanSchema),
  policyPlans: z.record(z.string(), policyPlanSchema),
  requests: z.record(z.string(), paymentRequestSchema),
  regularPlans: z.record(z.string(), regularTransferPlanSchema),
  regularRequests: z.record(z.string(), regularTransferRequestSchema),
  recoveryPlans: z.record(z.string(), recoveryPlanSchema),
  recoveryRequests: z.record(z.string(), recoveryRequestSchema),
  reauthorizationPlans: z.record(z.string(), reauthorizationPlanSchema),
  privateBalanceCreationPlans: z.record(z.string(), privateBalanceCreationPlanSchema),
  privateBalanceCreationRequests: z.record(z.string(), privateBalanceCreationRequestSchema),
  privateBalanceFundingPlans: z.record(z.string(), privateBalanceFundingPlanSchema),
  privateBalanceFundingRequests: z.record(z.string(), privateBalanceFundingRequestSchema),
  privateBalancePolicyUpdatePlans: z.record(z.string(), privateBalancePolicyUpdatePlanSchema),
  privateBalancePolicyUpdateRequests: z.record(z.string(), privateBalancePolicyUpdateRequestSchema),
}).strict();
const legacyStateSchema = z.object({
  version: z.literal(1),
  wallet: z.object({ activeName: walletNameSchema }).strict().optional(),
  onboarding: legacyOnboardingSchema.optional(),
  plans: z.record(z.string(), legacyPaymentPlanSchema).optional(),
  policyPlans: z.record(z.string(), legacyPolicyPlanSchema).optional(),
  requests: z.record(z.string(), legacyPaymentRequestSchema).optional(),
}).strict();

function isStateVersion(value: unknown, version: number): boolean {
  return typeof value === "object" && value !== null &&
    (value as { version?: unknown }).version === version;
}

function parseState(value: unknown): StateDocument {
  const normalized = normalizeVersion3Value(value);
  return stateSchema.parse(normalized) as StateDocument;
}

function parseVersion2State(value: unknown): Version2StateDocument {
  const normalized = normalizeVersion2Value(value);
  return version2StateSchema.parse(normalized) as Version2StateDocument;
}

function normalizeVersion3Value(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = structuredClone(value) as Record<string, unknown>;
  if (normalized.version !== 3) return normalized;
  for (const key of [
    "plans",
    "policyPlans",
    "requests",
    "regularPlans",
    "regularRequests",
    "recoveryPlans",
    "recoveryRequests",
    "reauthorizationPlans",
    "privateBalanceCreationPlans",
    "privateBalanceCreationRequests",
    "privateBalanceFundingPlans",
    "privateBalanceFundingRequests",
    "privateBalancePolicyUpdatePlans",
    "privateBalancePolicyUpdateRequests",
  ]) {
    normalized[key] ??= {};
  }
  normalizeOnboardingValue(normalized.onboarding);
  const wallet = normalized.wallet;
  if (wallet && typeof wallet === "object" && !Array.isArray(wallet)) {
    const profiles = (wallet as Record<string, unknown>).profiles;
    if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
      for (const profile of Object.values(profiles)) {
        if (profile && typeof profile === "object" && !Array.isArray(profile)) {
          const profileRecord = profile as Record<string, unknown>;
          normalizeOnboardingValue(profileRecord.onboarding);
        }
      }
    }
  }
  return normalized;
}

function normalizeVersion2Value(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = structuredClone(value) as Record<string, unknown>;
  if (normalized.version !== 2) return normalized;
  for (const key of [
    "plans",
    "policyPlans",
    "requests",
    "regularPlans",
    "regularRequests",
    "recoveryPlans",
    "recoveryRequests",
    "reauthorizationPlans",
  ]) {
    normalized[key] ??= {};
  }
  normalizeOnboardingValue(normalized.onboarding);
  const wallet = normalized.wallet;
  if (wallet && typeof wallet === "object" && !Array.isArray(wallet)) {
    const profiles = (wallet as Record<string, unknown>).profiles;
    if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
      for (const profile of Object.values(profiles)) {
        if (profile && typeof profile === "object" && !Array.isArray(profile)) {
          normalizeOnboardingValue((profile as Record<string, unknown>).onboarding);
        }
      }
    }
  }
  return normalized;
}

function normalizeOnboardingValue(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const delegation = (value as Record<string, unknown>).delegation;
  if (!delegation || typeof delegation !== "object" || Array.isArray(delegation)) return;
  (delegation as Record<string, unknown>).maxPayments ??= 1;
}

function parseLegacyState(value: unknown): LegacyStateDocument {
  const parsed = legacyStateSchema.parse(value);
  if (parsed.onboarding && parsed.onboarding.delegation.maxPayments === undefined) {
    parsed.onboarding.delegation.maxPayments = 1;
  }
  for (const plan of Object.values(parsed.policyPlans ?? {})) {
    plan.current.maxPayments ??= 1;
    plan.proposed.maxPayments ??= 1;
    if (plan.appliedPolicy) plan.appliedPolicy.maxPayments ??= 1;
  }
  return parsed as unknown as LegacyStateDocument;
}

function cloneState(state: StateDocument): StateDocument {
  return structuredClone(state);
}

export class StateStore {
  readonly #path: string;
  readonly #stateDir: string;
  readonly #defaultWalletName: string;
  readonly #events = new EventEmitter();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string, defaultWalletName = "agent-boost") {
    this.#stateDir = stateDir;
    this.#defaultWalletName = defaultWalletName;
    this.#path = join(stateDir, "state.json");
    this.#events.setMaxListeners(100);
  }

  get path(): string {
    return this.#path;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700);
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isStateVersion(parsed, 1) || isStateVersion(parsed, 2)) {
        const version2 = isStateVersion(parsed, 1)
          ? migrateV1(parseLegacyState(parsed), this.#defaultWalletName)
          : parseVersion2State(parsed);
        const migrated = migrateV2(version2);
        validateState(migrated);
        await this.#write(migrated);
      } else {
        const state = parseState(parsed);
        ensureWalletRegistryForState(state, this.#defaultWalletName);
        validateState(state);
        if (JSON.stringify(state) !== JSON.stringify(parsed)) await this.#write(state);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#write(EMPTY_STATE);
    }
  }

  async read(): Promise<StateDocument> {
    const raw = await readFile(this.#path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const state = isStateVersion(parsed, 1)
      ? migrateV2(migrateV1(parseLegacyState(parsed), this.#defaultWalletName))
      : isStateVersion(parsed, 2)
        ? migrateV2(parseVersion2State(parsed))
        : parseState(parsed);
    ensureWalletRegistryForState(state, this.#defaultWalletName);
    validateState(state);
    return state;
  }

  async update(
    mutator: (draft: StateDocument) => void | Promise<void>,
  ): Promise<StateDocument> {
    const operation = this.#queue.then(async () => {
      const current = await this.read();
      const draft = cloneState(current);
      await mutator(draft);
      ensureWalletRegistryForState(draft, this.#defaultWalletName);
      syncActiveOnboarding(draft);
      bindDefaultPrivateBalances(draft);
      validateState(draft);
      validateStateTransition(current, draft);
      await this.#write(draft);
      this.#events.emit("change", cloneState(draft));
      return cloneState(draft);
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async ensureWalletProfile(defaultName: string): Promise<string> {
    const state = await this.update((draft) => {
      if (draft.wallet) return;
      const now = new Date().toISOString();
      const profile = createWalletProfile(defaultName, "created", now, 1, true);
      if (draft.onboarding) profile.onboarding = draft.onboarding;
      draft.wallet = {
        activeWalletId: profile.walletId,
        activeName: profile.name,
        profiles: { [profile.walletId]: profile },
      };
      bindLegacyHistory(draft, profile);
    });
    return state.wallet!.activeName;
  }

  async registerManagedWallet(
    name: string,
    origin: WalletProfileOrigin = "created",
  ): Promise<WalletProfileRecord> {
    let walletId = "";
    const state = await this.update((draft) => {
      if (!draft.wallet) throw new Error("WALLET_REGISTRY_MISSING");
      const existing = findProfileByName(draft.wallet.profiles, name);
      if (existing) {
        walletId = existing.walletId;
        return;
      }
      const profile = createWalletProfile(
        name,
        origin,
        new Date().toISOString(),
        0,
        false,
      );
      walletId = profile.walletId;
      draft.wallet.profiles[profile.walletId] = profile;
    });
    return state.wallet!.profiles[walletId]!;
  }

  async activeWalletProfile(): Promise<WalletProfileRecord> {
    const state = await this.read();
    const profile = state.wallet?.profiles[state.wallet.activeWalletId];
    if (!profile) throw new Error("ACTIVE_WALLET_PROFILE_MISSING");
    return profile;
  }

  async archiveWalletProfile(walletId: string): Promise<WalletProfileRecord> {
    let result: WalletProfileRecord | undefined;
    await this.update((draft) => {
      if (!draft.wallet) throw new Error("WALLET_REGISTRY_MISSING");
      const profile = draft.wallet.profiles[walletId];
      if (!profile) throw new Error("WALLET_NOT_FOUND");
      if (draft.wallet.activeWalletId === walletId) {
        throw new Error("ACTIVE_WALLET_CANNOT_BE_ARCHIVED");
      }
      profile.status = "archived";
      profile.updatedAt = new Date().toISOString();
      result = structuredClone(profile);
    });
    return result!;
  }

  async activateWalletProfile(walletId: string): Promise<{
    changed: boolean;
    archiveId?: string;
    profile: WalletProfileRecord;
    current: StateDocument;
  }> {
    const operation = this.#queue.then(async () => {
      const current = await this.read();
      if (!current.wallet) throw new Error("WALLET_REGISTRY_MISSING");
      const target = current.wallet.profiles[walletId];
      if (!target) throw new Error("WALLET_NOT_FOUND");
      if (current.wallet.activeWalletId === walletId) {
        return { changed: false, profile: structuredClone(target), current };
      }

      syncActiveOnboarding(current);
      const archiveId = await this.#archiveState(current);
      const prior = current.wallet.profiles[current.wallet.activeWalletId]!;
      prior.archiveIds.push(archiveId);
      prior.updatedAt = new Date().toISOString();

      const now = new Date().toISOString();
      target.status = "available";
      target.selectionEpoch += 1;
      target.lastSelectedAt = now;
      target.updatedAt = now;
      if (target.onboarding?.delegation.enabled && !target.authorizationId) {
        target.onboarding.delegation.enabled = false;
        target.onboarding.revision += 1;
        target.onboarding.updatedAt = now;
        for (const pocket of Object.values(target.privateBalances)) {
          if (pocket.delegation.enabled) {
            pocket.delegation.enabled = false;
            pocket.revision += 1;
            pocket.updatedAt = now;
          }
        }
      }
      current.wallet.activeWalletId = target.walletId;
      current.wallet.activeName = target.name;
      if (target.onboarding) current.onboarding = structuredClone(target.onboarding);
      else delete current.onboarding;
      validateState(current);
      await this.#write(current);
      this.#events.emit("change", cloneState(current));
      return {
        changed: true,
        archiveId,
        profile: structuredClone(target),
        current: cloneState(current),
      };
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async storeReauthorizationPlan(plan: WalletReauthorizationPlan): Promise<void> {
    await this.update((draft) => {
      draft.reauthorizationPlans[plan.decisionId] = plan;
    });
  }

  async cancelReauthorizationPlan(decisionId: string): Promise<WalletReauthorizationPlan> {
    const state = await this.update((draft) => {
      const plan = draft.reauthorizationPlans[decisionId];
      if (!plan) throw new Error("REAUTHORIZATION_DECISION_NOT_FOUND");
      if (plan.appliedAt) throw new Error("REAUTHORIZATION_DECISION_ALREADY_APPLIED");
      plan.decision = "deny";
      if (!plan.blockers.includes("USER_CANCELLED")) plan.blockers.push("USER_CANCELLED");
    });
    return state.reauthorizationPlans[decisionId]!;
  }

  async applyReauthorizationPlan(
    decisionId: string,
  ): Promise<{ profile: WalletProfileRecord; onboarding: OnboardingRecord }> {
    let result: { profile: WalletProfileRecord; onboarding: OnboardingRecord } | undefined;
    await this.update((draft) => {
      if (!draft.wallet || !draft.onboarding) throw new Error("WALLET_SETUP_NOT_STARTED");
      const profile = draft.wallet.profiles[draft.wallet.activeWalletId];
      const plan = draft.reauthorizationPlans[decisionId];
      if (!profile || !plan) throw new Error("REAUTHORIZATION_DECISION_NOT_FOUND");
      if (plan.blockers.includes("USER_CANCELLED")) {
        throw new Error("REAUTHORIZATION_DECISION_CANCELLED");
      }
      if (plan.appliedAt) {
        if (!plan.appliedAuthorizationId ||
          profile.authorizationId !== plan.appliedAuthorizationId) {
          throw new Error("REAUTHORIZATION_RECEIPT_STALE");
        }
        result = {
          profile: structuredClone(profile),
          onboarding: structuredClone(draft.onboarding),
        };
        return;
      }
      if (plan.wallet.walletId !== profile.walletId ||
        plan.wallet.walletName !== profile.name ||
        plan.wallet.selectionEpoch !== profile.selectionEpoch) {
        throw new Error("WALLET_SELECTION_CHANGED");
      }
      const now = new Date();
      if (new Date(plan.expiresAt).getTime() <= now.getTime()) {
        throw new Error("REAUTHORIZATION_DECISION_EXPIRED");
      }
      if (profile.authorizationId !== plan.priorAuthorizationId) {
        throw new Error("REAUTHORIZATION_AUTHORITY_CHANGED");
      }
      const livePolicy = walletPolicySnapshot(
        draft.onboarding,
        countAuthorizationRequests(draft, profile.authorizationId),
      );
      if (!samePolicySnapshot(livePolicy, plan.currentPolicy)) {
        throw new Error("REAUTHORIZATION_POLICY_CHANGED");
      }
      invalidatePendingPrivatePolicyPlansForReauthorization(
        draft,
        profile.walletId,
      );
      profile.authorizationId = `auth_${randomUUID()}`;
      profile.updatedAt = now.toISOString();
      const {
        paymentsUsed: _paymentsUsed,
        paymentsRemaining: _paymentsRemaining,
        ...delegation
      } = plan.proposedPolicy;
      draft.onboarding.delegation = delegation;
      draft.onboarding.revision += 1;
      draft.onboarding.updatedAt = now.toISOString();
      inheritUnmanagedPrivatePoliciesOnReauthorization(
        draft,
        profile,
        delegation,
        now.toISOString(),
      );
      plan.appliedAt = now.toISOString();
      plan.appliedAuthorizationId = profile.authorizationId;
      result = {
        profile: structuredClone(profile),
        onboarding: structuredClone(draft.onboarding),
      };
    });
    return result!;
  }

  async archiveAndReset(newWalletName: string): Promise<{
    archiveId: string;
    previous: StateDocument;
    current: StateDocument;
  }> {
    const operation = this.#queue.then(async () => {
      const previous = await this.read();
      if (!previous.wallet) throw new Error("WALLET_REGISTRY_MISSING");
      syncActiveOnboarding(previous);
      const archiveId = await this.#archiveState(previous);
      const archived = cloneState(previous);
      const prior = previous.wallet.profiles[previous.wallet.activeWalletId]!;
      prior.archiveIds.push(archiveId);
      prior.updatedAt = new Date().toISOString();
      let target = findProfileByName(previous.wallet.profiles, newWalletName);
      if (!target) {
        target = createWalletProfile(
          newWalletName,
          "created",
          new Date().toISOString(),
          1,
          false,
        );
        previous.wallet.profiles[target.walletId] = target;
      } else {
        target.selectionEpoch += 1;
        delete target.authorizationId;
        target.status = "available";
        target.updatedAt = new Date().toISOString();
      }
      previous.wallet.activeWalletId = target.walletId;
      previous.wallet.activeName = target.name;
      delete previous.onboarding;
      validateState(previous);
      await this.#write(previous);
      this.#events.emit("change", cloneState(previous));
      return { archiveId, previous: archived, current: cloneState(previous) };
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async waitForOnboardingRevision(
    sinceRevision: number,
    waitMs: number,
  ): Promise<OnboardingRecord | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (value: OnboardingRecord | undefined): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.#events.off("change", listener);
        resolve(value);
      };
      const listener = (state: StateDocument): void => {
        if (state.onboarding && state.onboarding.revision > sinceRevision) finish(state.onboarding);
      };
      this.#events.on("change", listener);
      void this.read().then(
        (state) => {
          if ((state.onboarding && state.onboarding.revision > sinceRevision) || waitMs === 0) {
            finish(state.onboarding);
            return;
          }
          timer = setTimeout(() => {
            void this.read().then((latest) => finish(latest.onboarding), () => finish(undefined));
          }, waitMs);
        },
        () => finish(undefined),
      );
    });
  }

  async #archiveState(state: StateDocument): Promise<string> {
    const archiveId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
    const archiveDir = join(this.#stateDir, "archives", archiveId);
    await mkdir(archiveDir, { recursive: true, mode: 0o700 });
    await chmod(archiveDir, 0o700);
    await this.#writePath(join(archiveDir, "state.json"), state);
    return archiveId;
  }

  async #write(state: StateDocument): Promise<void> {
    await this.#writePath(this.#path, state);
  }

  async #writePath(path: string, state: StateDocument): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o600);
    await rename(temp, path);
    await chmod(path, 0o600);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

function migrateV1(
  legacy: LegacyStateDocument,
  defaultWalletName: string,
): Version2StateDocument {
  const state: Version2StateDocument = {
    version: 2,
    ...(legacy.onboarding ? { onboarding: structuredClone(legacy.onboarding) } : {}),
    plans: structuredClone(legacy.plans ?? {}) as Record<string, PaymentPlan>,
    policyPlans: structuredClone(legacy.policyPlans ?? {}) as Record<string, PolicyUpdatePlan>,
    requests: legacy.requests ?? {},
    regularPlans: {},
    regularRequests: {},
    recoveryPlans: {},
    recoveryRequests: {},
    reauthorizationPlans: {},
  };
  if (legacy.wallet || legacy.onboarding ||
    Object.keys(legacy.plans ?? {}).length > 0 ||
    Object.keys(legacy.policyPlans ?? {}).length > 0 ||
    Object.keys(legacy.requests ?? {}).length > 0) {
    const now = new Date().toISOString();
    const profile = createVersion2WalletProfile(
      legacy.wallet?.activeName ?? defaultWalletName,
      "created",
      now,
      1,
      true,
    );
    if (state.onboarding) profile.onboarding = state.onboarding;
    state.wallet = {
      activeWalletId: profile.walletId,
      activeName: profile.name,
      profiles: { [profile.walletId]: profile },
    };
    bindLegacyHistory(state, profile);
  }
  return state;
}

function migrateV2(version2: Version2StateDocument): StateDocument {
  const profiles = Object.fromEntries(
    Object.entries(version2.wallet?.profiles ?? {}).map(([walletId, profile]) => {
      const migrated = migrateVersion2WalletProfile(profile);
      return [walletId, migrated];
    }),
  );
  const state: StateDocument = {
    version: 3,
    ...(version2.onboarding
      ? { onboarding: structuredClone(version2.onboarding) }
      : {}),
    ...(version2.wallet
      ? { wallet: {
        activeWalletId: version2.wallet.activeWalletId,
        activeName: version2.wallet.activeName,
        profiles,
      } }
      : {}),
    plans: structuredClone(version2.plans),
    policyPlans: structuredClone(version2.policyPlans),
    requests: structuredClone(version2.requests),
    regularPlans: structuredClone(version2.regularPlans),
    regularRequests: structuredClone(version2.regularRequests),
    recoveryPlans: structuredClone(version2.recoveryPlans),
    recoveryRequests: structuredClone(version2.recoveryRequests),
    reauthorizationPlans: structuredClone(version2.reauthorizationPlans),
    privateBalanceCreationPlans: {},
    privateBalanceCreationRequests: {},
    privateBalanceFundingPlans: {},
    privateBalanceFundingRequests: {},
    privateBalancePolicyUpdatePlans: {},
    privateBalancePolicyUpdateRequests: {},
  };

  // Version 2 had no durable pre-broadcast checkpoint. Every unresolved
  // legacy execution is therefore conservatively treated as possibly
  // broadcast, even when the CLI failed before returning an identifier. This
  // prevents a v3 restart from restoring reserved authority or funds and then
  // permitting a duplicate send. Fresh v3 executions only receive this field
  // at the adapter's final pre-broadcast boundary.
  for (const request of [
    ...Object.values(state.requests),
    ...Object.values(state.regularRequests),
    ...Object.values(state.recoveryRequests),
  ]) {
    if (
      request.phase === "executing" ||
      request.phase === "submitted" ||
      request.phase === "indeterminate"
    ) {
      request.broadcastStartedAt ??= request.updatedAt || request.createdAt;
    }
  }

  // Tag consumed legacy plans as well as unapplied ones. v2 unresolved
  // requests have no durable debit/spend marker, so the tag is the persistent
  // provenance used to grandfather already-existing conflicts without letting
  // a newly-created v3 request omit its reservation marker.
  for (const request of Object.values(state.requests)) {
    const plan = state.plans[request.decisionId];
    if (plan && !plan.blockers.includes("STATE_MIGRATION_REPLAN_REQUIRED")) {
      plan.blockers.push("STATE_MIGRATION_REPLAN_REQUIRED");
    }
  }
  for (const request of Object.values(state.regularRequests)) {
    const plan = state.regularPlans[request.decisionId];
    if (plan && !plan.blockers.includes("STATE_MIGRATION_REPLAN_REQUIRED")) {
      plan.blockers.push("STATE_MIGRATION_REPLAN_REQUIRED");
    }
  }
  for (const request of Object.values(state.recoveryRequests)) {
    const plan = state.recoveryPlans[request.decisionId];
    if (plan && !plan.blockers.includes("STATE_MIGRATION_REPLAN_REQUIRED")) {
      plan.blockers.push("STATE_MIGRATION_REPLAN_REQUIRED");
    }
  }

  // Version-2 private/recovery digests did not bind a physical pocket or its
  // full denomination debit. Preserve their audit/reconciliation records, but
  // never allow an unapplied legacy decision to authorize a v3 broadcast.
  for (const plan of Object.values(state.plans)) {
    if (!Object.values(state.requests).some(
      (request) => request.decisionId === plan.decisionId,
    )) {
      plan.decision = "deny";
      if (!plan.blockers.includes("STATE_MIGRATION_REPLAN_REQUIRED")) {
        plan.blockers.push("STATE_MIGRATION_REPLAN_REQUIRED");
      }
      plan.approval = { action: "deny", userConfirmationRequired: false };
    }
  }
  for (const plan of Object.values(state.recoveryPlans)) {
    if (!plan.consumedByRequestId && !Object.values(state.recoveryRequests).some(
      (request) => request.decisionId === plan.decisionId,
    )) {
      plan.decision = "deny";
      if (!plan.blockers.includes("STATE_MIGRATION_REPLAN_REQUIRED")) {
        plan.blockers.push("STATE_MIGRATION_REPLAN_REQUIRED");
      }
    }
  }
  bindDefaultPrivateBalances(state);
  return state;
}

function bindLegacyHistory(
  state: Version2StateDocument | StateDocument,
  profile: Version2WalletProfileRecord | WalletProfileRecord,
): void {
  if (!profile.authorizationId) return;
  const authorization = {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
    authorizationId: profile.authorizationId,
  };
  for (const [decisionId, plan] of Object.entries(state.plans)) {
    plan.authorization ??= authorization;
    // A v1 digest did not commit the wallet, selection epoch, or authorization.
    // Keep the record for audit/reconciliation, but it can never authorize a
    // post-migration broadcast.
    plan.decision = "deny";
    if (!plan.blockers.includes("STATE_MIGRATION_REPLAN_REQUIRED")) {
      plan.blockers.push("STATE_MIGRATION_REPLAN_REQUIRED");
    }
    plan.approval = {
      action: "deny",
      userConfirmationRequired: false,
    };
    if (plan.decisionId !== decisionId) {
      throw new Error("Legacy payment plan map key is invalid");
    }
  }
  for (const request of Object.values(state.requests)) {
    request.authorization ??= authorization;
    if (state.plans[request.decisionId]) continue;
    state.plans[request.decisionId] = {
      version: 1,
      decisionId: request.decisionId,
      recipient: request.recipient,
      amountWei: request.amountWei,
      authorization,
      intentDigest: `sha256:${"0".repeat(64)}`,
      createdAt: request.createdAt,
      expiresAt: request.createdAt,
      decision: "deny",
      blockers: ["STATE_MIGRATION_REPLAN_REQUIRED"],
      approval: { action: "deny", userConfirmationRequired: false },
    };
  }
  for (const plan of Object.values(state.policyPlans)) {
    plan.wallet ??= {
      walletId: profile.walletId,
      walletName: profile.name,
      selectionEpoch: profile.selectionEpoch,
    };
    if (plan.appliedAt) {
      plan.appliedPolicy ??= structuredClone(plan.proposed);
    } else {
      plan.decision = "deny";
      if (!plan.blockers.includes("STATE_MIGRATION_REPLAN_REQUIRED")) {
        plan.blockers.push("STATE_MIGRATION_REPLAN_REQUIRED");
      }
    }
  }
}

function syncActiveOnboarding(state: StateDocument): void {
  if (!state.wallet) return;
  const profile = state.wallet.profiles[state.wallet.activeWalletId];
  if (!profile) return;
  const priorDelegation = profile.onboarding?.delegation;
  if (state.onboarding) {
    profile.onboarding = structuredClone(state.onboarding);
  } else {
    delete profile.onboarding;
  }
  for (const walletProfile of Object.values(state.wallet.profiles)) {
    const aggregatePolicyChanged = walletProfile.walletId === profile.walletId &&
      priorDelegation !== undefined && walletProfile.onboarding !== undefined &&
      !sameDelegation(priorDelegation, walletProfile.onboarding.delegation);
    syncProfilePrivateBalanceAuthority(walletProfile, aggregatePolicyChanged);
  }
}

function syncProfilePrivateBalanceAuthority(
  profile: WalletProfileRecord,
  clampToAggregate: boolean,
): void {
  const onboarding = profile.onboarding;
  if (!onboarding) return;
  const defaultPocket = profile.privateBalances[profile.defaultPrivateBalanceId];
  const singleDefaultBackend = Object.keys(profile.privateBalances).length === 1 &&
    defaultPocket?.backendWalletName === profile.name;

  for (const pocket of Object.values(profile.privateBalances)) {
    let changed = false;
    const uninitializedPolicy = pocket.privateBalanceId === profile.defaultPrivateBalanceId &&
      pocket.revision === 0 && !pocket.delegation.enabled &&
      pocket.delegation.perPaymentLimitWei === "0" &&
      pocket.delegation.lifetimeLimitWei === "0";
    if (singleDefaultBackend && pocket.privateBalanceId === profile.defaultPrivateBalanceId &&
      pocket.balanceWei !== onboarding.privateBalanceWei) {
      pocket.balanceWei = onboarding.privateBalanceWei;
      changed = true;
    }
    if (uninitializedPolicy && !sameDelegation(pocket.delegation, onboarding.delegation)) {
      pocket.delegation = structuredClone(onboarding.delegation);
      changed = true;
    }
    if (clampToAggregate) {
      const clamped = clampPrivatePolicyToAggregate(pocket.delegation, onboarding.delegation);
      if (!sameDelegation(pocket.delegation, clamped)) {
        pocket.delegation = clamped;
        changed = true;
      }
    }
    if (changed) {
      pocket.revision += 1;
      pocket.updatedAt = onboarding.updatedAt;
    }
  }
}

function inheritUnmanagedPrivatePoliciesOnReauthorization(
  state: StateDocument,
  profile: WalletProfileRecord,
  delegation: DelegationPolicy,
  updatedAt: string,
): void {
  // Any applied child-policy update makes that pocket independently managed.
  // Keep its explicit limits/disable/expiry durable across wallet renewals;
  // syncActiveOnboarding will only clamp it to the newly authorized aggregate.
  // Every other pocket inherits the complete fresh delegation, including the
  // reset spend counter and renewed expiry.
  const explicitlyManaged = new Set(
    Object.values(state.privateBalancePolicyUpdateRequests)
      .filter((request) => request.phase === "applied" &&
        request.privateBalance.walletId === profile.walletId)
      .map((request) => request.privateBalance.privateBalanceId),
  );
  for (const pocket of Object.values(profile.privateBalances)) {
    if (explicitlyManaged.has(pocket.privateBalanceId)) continue;
    if (sameDelegation(pocket.delegation, delegation)) continue;
    pocket.delegation = structuredClone(delegation);
    pocket.revision += 1;
    pocket.updatedAt = updatedAt;
  }
}

function invalidatePendingPrivatePolicyPlansForReauthorization(
  state: StateDocument,
  walletId: string,
): void {
  for (const plan of Object.values(state.privateBalancePolicyUpdatePlans)) {
    if (plan.privateBalance.walletId !== walletId || plan.appliedAt ||
      plan.consumedByRequestId) {
      continue;
    }
    plan.decision = "deny";
    if (!plan.blockers.includes("WALLET_REAUTHORIZED_REFRESH_PLAN")) {
      plan.blockers.push("WALLET_REAUTHORIZED_REFRESH_PLAN");
    }
  }
}

function bindDefaultPrivateBalances(state: StateDocument): void {
  if (!state.wallet) return;

  const privateBalanceForWallet = (
    walletId: string,
    privateBalanceId?: string,
  ): PrivateBalanceRecord => {
    const profile = state.wallet!.profiles[walletId];
    const resolvedPrivateBalanceId = privateBalanceId ?? profile?.defaultPrivateBalanceId;
    const pocket = resolvedPrivateBalanceId
      ? profile?.privateBalances[resolvedPrivateBalanceId]
      : undefined;
    if (!profile || !pocket) throw new Error("Private balance is missing");
    return pocket;
  };
  const debitForWallet = (walletId: string, fallback: string): string => {
    const configured = state.wallet!.profiles[walletId]?.onboarding?.shieldAmountWei;
    if (configured && BigInt(configured) > 0n) return configured;
    if (BigInt(fallback) > 0n) return fallback;
    throw new Error("Private balance debit must be positive");
  };

  for (const plan of Object.values(state.plans)) {
    const pocket = privateBalanceForWallet(
      plan.authorization.walletId,
      plan.privateBalanceId,
    );
    plan.privateBalanceId ??= pocket.privateBalanceId;
    plan.privateBalanceRevision ??= pocket.revision;
    plan.privateBalanceDebitWei ??= debitForWallet(
      plan.authorization.walletId,
      plan.amountWei,
    );
  }
  for (const request of Object.values(state.requests)) {
    const plan = state.plans[request.decisionId];
    const pocket = privateBalanceForWallet(
      request.authorization.walletId,
      request.privateBalanceId ?? plan?.privateBalanceId,
    );
    request.privateBalanceId ??= plan?.privateBalanceId ?? pocket.privateBalanceId;
    request.privateBalanceRevision ??= plan?.privateBalanceRevision ?? pocket.revision;
    request.privateBalanceDebitWei ??= plan?.privateBalanceDebitWei ?? debitForWallet(
      request.authorization.walletId,
      request.amountWei,
    );
  }
  for (const plan of Object.values(state.recoveryPlans)) {
    const pocket = privateBalanceForWallet(plan.wallet.walletId, plan.privateBalanceId);
    plan.privateBalanceId ??= pocket.privateBalanceId;
    plan.privateBalanceRevision ??= pocket.revision;
    plan.privateBalanceDebitWei ??= plan.withdrawalAmountWei;
  }
  for (const request of Object.values(state.recoveryRequests)) {
    const plan = state.recoveryPlans[request.decisionId];
    const pocket = privateBalanceForWallet(
      request.wallet.walletId,
      request.privateBalanceId ?? plan?.privateBalanceId,
    );
    request.privateBalanceId ??= plan?.privateBalanceId ?? pocket.privateBalanceId;
    request.privateBalanceRevision ??= plan?.privateBalanceRevision ?? pocket.revision;
    request.privateBalanceDebitWei ??= plan?.privateBalanceDebitWei ?? request.withdrawalAmountWei;
  }
}

function ensureWalletRegistryForState(
  state: StateDocument,
  defaultWalletName: string,
): void {
  if (state.wallet || !hasWalletBoundState(state)) return;
  const now = new Date().toISOString();
  const profile = createWalletProfile(defaultWalletName, "created", now, 1, true);
  if (state.onboarding) profile.onboarding = structuredClone(state.onboarding);
  state.wallet = {
    activeWalletId: profile.walletId,
    activeName: profile.name,
    profiles: { [profile.walletId]: profile },
  };
  bindLegacyHistory(state, profile);
}

function hasWalletBoundState(state: StateDocument): boolean {
  return Boolean(
    state.onboarding ||
    Object.keys(state.plans).length ||
    Object.keys(state.policyPlans).length ||
    Object.keys(state.requests).length ||
    Object.keys(state.regularPlans).length ||
    Object.keys(state.regularRequests).length ||
    Object.keys(state.recoveryPlans).length ||
    Object.keys(state.recoveryRequests).length ||
    Object.keys(state.reauthorizationPlans).length ||
    Object.keys(state.privateBalanceCreationPlans).length ||
    Object.keys(state.privateBalanceCreationRequests).length ||
    Object.keys(state.privateBalanceFundingPlans).length ||
    Object.keys(state.privateBalanceFundingRequests).length ||
    Object.keys(state.privateBalancePolicyUpdatePlans).length ||
    Object.keys(state.privateBalancePolicyUpdateRequests).length
  );
}

function validateState(state: StateDocument): void {
  if (state.version !== 3 || !state.plans || !state.requests ||
    !state.regularPlans || !state.regularRequests ||
    !state.policyPlans || !state.recoveryPlans || !state.recoveryRequests ||
    !state.reauthorizationPlans || !state.privateBalanceCreationPlans ||
    !state.privateBalanceCreationRequests || !state.privateBalanceFundingPlans ||
    !state.privateBalanceFundingRequests || !state.privateBalancePolicyUpdatePlans ||
    !state.privateBalancePolicyUpdateRequests) {
    throw new Error("Unsupported or corrupt Agent Boost state document");
  }
  if (!state.wallet) {
    if (hasWalletBoundState(state)) {
      throw new Error("Wallet-bound state exists without a wallet registry");
    }
    return;
  }
  const active = state.wallet.profiles[state.wallet.activeWalletId];
  if (!active || active.name !== state.wallet.activeName || active.status === "archived") {
    throw new Error("Active wallet registry reference is invalid");
  }
  if (!sameOnboarding(state.onboarding, active.onboarding)) {
    throw new Error("Active wallet onboarding state is inconsistent");
  }
  if (state.onboarding?.delegation.enabled && !active.authorizationId) {
    throw new Error("Enabled delegation has no active wallet authorization");
  }
  const names = new Set<string>();
  const backendWalletNames = new Set<string>();
  const publicChangeAddresses = new Set<string>();
  const publicChangeSourceRequestIds = new Set<string>();
  for (const [walletId, profile] of Object.entries(state.wallet.profiles)) {
    if (walletId !== profile.walletId || names.has(profile.name) || profile.selectionEpoch < 0) {
      throw new Error("Wallet registry is corrupt");
    }
    names.add(profile.name);
    if (profile.onboarding) {
      validatePolicyEnvelope(profile.onboarding.delegation, "Wallet policy");
    }
    const defaultPocket = profile.privateBalances[profile.defaultPrivateBalanceId];
    if (!defaultPocket || defaultPocket.status !== "available") {
      throw new Error("Default private balance reference is invalid");
    }
    const pocketNames = new Set<string>();
    for (const [privateBalanceId, pocket] of Object.entries(profile.privateBalances)) {
      if (privateBalanceId !== pocket.privateBalanceId) {
        throw new Error("Private balance map key is invalid");
      }
      const pocketName = pocket.name.toLowerCase();
      if (pocketNames.has(pocketName)) {
        throw new Error("Private balance names must be unique per wallet");
      }
      pocketNames.add(pocketName);
      const backendWalletName = pocket.backendWalletName.toLowerCase();
      if (pocket.privateBalanceId !== profile.defaultPrivateBalanceId &&
        backendWalletName === profile.name.toLowerCase()) {
        throw new Error("Only the default private balance may use its parent backend wallet");
      }
      if (backendWalletNames.has(backendWalletName)) {
        throw new Error("Private balance backend wallet names must be globally unique");
      }
      backendWalletNames.add(backendWalletName);
      validatePrivatePolicyCap(pocket.delegation, profile.onboarding?.delegation);
      for (const [addressKey, account] of Object.entries(
        pocket.publicChangeAccounts ?? {},
      )) {
        const normalizedAddress = account.address.toLowerCase();
        if (addressKey !== normalizedAddress || addressKey !== addressKey.toLowerCase()) {
          throw new Error("Public change account map key must be its lowercase address");
        }
        if (publicChangeAddresses.has(normalizedAddress)) {
          throw new Error("Public change account addresses must be globally unique");
        }
        publicChangeAddresses.add(normalizedAddress);
        if (publicChangeSourceRequestIds.has(account.sourceRequestId)) {
          throw new Error("Public change source request IDs must be globally unique");
        }
        publicChangeSourceRequestIds.add(account.sourceRequestId);
        if (Date.parse(account.updatedAt) < Date.parse(account.createdAt)) {
          throw new Error("Public change account timestamps are inconsistent");
        }
        if (!publicChangeSourceMatches(state, profile, pocket, account.sourceRequestId)) {
          throw new Error("Public change account source request binding is invalid");
        }
      }
    }
  }
  const validateSelection = (binding: {
    walletId: string;
    walletName: string;
    selectionEpoch: number;
  }): WalletProfileRecord => {
    const profile = state.wallet!.profiles[binding.walletId];
    if (!profile || profile.name !== binding.walletName ||
      binding.selectionEpoch < 1 || binding.selectionEpoch > profile.selectionEpoch) {
      throw new Error("Wallet selection binding is invalid");
    }
    return profile;
  };
  const validateAuthorization = (value: { authorization?: {
    walletId: string;
    walletName: string;
    selectionEpoch: number;
    authorizationId: string;
  } }): WalletProfileRecord => {
    const binding = value.authorization;
    if (!binding) throw new Error("Wallet authority binding is missing");
    const profile = validateSelection(binding);
    if (!binding.authorizationId.startsWith("auth_")) {
      throw new Error("Wallet authority binding is invalid");
    }
    return profile;
  };
  const validatePrivateBalance = (
    binding: PrivateBalanceBinding,
    exactRevision: boolean,
  ): PrivateBalanceRecord => {
    const profile = validateSelection(binding);
    const pocket = profile.privateBalances[binding.privateBalanceId];
    if (!pocket || pocket.name !== binding.privateBalanceName ||
      pocket.backendWalletName !== binding.backendWalletName ||
      binding.privateBalanceRevision > pocket.revision ||
      (exactRevision && binding.privateBalanceRevision !== pocket.revision)) {
      throw new Error("Private balance binding is invalid");
    }
    return pocket;
  };
  const validateFlatPrivateBalance = (
    walletId: string,
    privateBalanceId: string | undefined,
    revision: number | undefined,
    exactRevision: boolean,
  ): PrivateBalanceRecord => {
    if (!privateBalanceId || revision === undefined) {
      throw new Error("Private balance binding is missing");
    }
    const pocket = state.wallet!.profiles[walletId]?.privateBalances[privateBalanceId];
    if (!pocket || revision > pocket.revision || (exactRevision && revision !== pocket.revision)) {
      throw new Error("Private balance binding is invalid");
    }
    return pocket;
  };
  for (const [decisionId, plan] of Object.entries(state.plans)) {
    if (decisionId !== plan.decisionId) throw new Error("Payment plan map key is invalid");
    const profile = validateAuthorization(plan);
    validateFlatPrivateBalance(
      profile.walletId,
      plan.privateBalanceId,
      plan.privateBalanceRevision,
      false,
    );
    if (!plan.privateBalanceDebitWei || BigInt(plan.privateBalanceDebitWei) <= 0n) {
      throw new Error("Payment private balance debit is invalid");
    }
  }
  for (const [requestId, request] of Object.entries(state.requests)) {
    if (requestId !== request.requestId) throw new Error("Payment request map key is invalid");
    const profile = validateAuthorization(request);
    validateFlatPrivateBalance(
      profile.walletId,
      request.privateBalanceId,
      request.privateBalanceRevision,
      false,
    );
    const plan = state.plans[request.decisionId];
    if (!plan || !sameAuthorizationBinding(plan.authorization, request.authorization) ||
      plan.recipient !== request.recipient || plan.amountWei !== request.amountWei ||
      plan.privateBalanceId !== request.privateBalanceId ||
      plan.privateBalanceRevision !== request.privateBalanceRevision ||
      plan.privateBalanceDebitWei !== request.privateBalanceDebitWei) {
      throw new Error("Payment request plan reference is invalid");
    }
    validatePrivateDebitRestoration(request);
  }
  for (const [decisionId, plan] of Object.entries(state.regularPlans)) {
    if (decisionId !== plan.decisionId) {
      throw new Error("Regular transfer plan map key is invalid");
    }
    const profile = validateAuthorization(plan);
    validateRegularTransferSource(
      profile,
      plan.authorization,
      plan.sourcePrivateBalance,
      plan.sourcePublicAddress,
      validatePrivateBalance,
    );
  }
  for (const [requestId, request] of Object.entries(state.regularRequests)) {
    if (requestId !== request.requestId) {
      throw new Error("Regular transfer request map key is invalid");
    }
    const profile = validateAuthorization(request);
    const plan = state.regularPlans[request.decisionId];
    if (!plan || !sameAuthorizationBinding(plan.authorization, request.authorization) ||
      plan.recipient !== request.recipient || plan.amountWei !== request.amountWei ||
      plan.gasReserveWei !== request.gasReserveWei ||
      !sameOptionalPrivateBalanceBinding(
        plan.sourcePrivateBalance,
        request.sourcePrivateBalance,
      ) || plan.sourcePublicAddress !== request.sourcePublicAddress ||
      (request.sourcePrivateBalance &&
        request.sourcePublicBalanceBeforeWei !== plan.mainBalanceSnapshotWei)) {
      throw new Error("Regular transfer request plan reference is invalid");
    }
    validateRegularTransferSource(
      profile,
      request.authorization,
      request.sourcePrivateBalance,
      request.sourcePublicAddress,
      validatePrivateBalance,
    );
    validateRegularSpendRestoration(request);
  }
  for (const [decisionId, plan] of Object.entries(state.recoveryPlans)) {
    if (decisionId !== plan.decisionId) throw new Error("Recovery plan map key is invalid");
    const profile = validateSelection(plan.wallet);
    validateFlatPrivateBalance(
      profile.walletId,
      plan.privateBalanceId,
      plan.privateBalanceRevision,
      false,
    );
    if (!plan.privateBalanceDebitWei || BigInt(plan.privateBalanceDebitWei) <= 0n) {
      throw new Error("Recovery private balance debit is invalid");
    }
  }
  for (const [requestId, request] of Object.entries(state.recoveryRequests)) {
    if (requestId !== request.requestId) throw new Error("Recovery request map key is invalid");
    const profile = validateSelection(request.wallet);
    validateFlatPrivateBalance(
      profile.walletId,
      request.privateBalanceId,
      request.privateBalanceRevision,
      false,
    );
    const plan = state.recoveryPlans[request.decisionId];
    if (!plan || !sameSelectionBinding(plan.wallet, request.wallet) ||
      plan.recipient !== request.recipient || plan.amountWei !== request.amountWei ||
      plan.privateBalanceId !== request.privateBalanceId ||
      plan.privateBalanceRevision !== request.privateBalanceRevision ||
      plan.privateBalanceDebitWei !== request.privateBalanceDebitWei ||
      (plan.consumedByRequestId !== undefined && plan.consumedByRequestId !== request.requestId)) {
      throw new Error("Recovery request plan reference is invalid");
    }
    validatePrivateDebitRestoration(request);
  }
  for (const [decisionId, plan] of Object.entries(state.policyPlans)) {
    if (decisionId !== plan.decisionId) throw new Error("Policy plan map key is invalid");
    validateSelection(plan.wallet);
    if (plan.authorizationId !== undefined && !plan.authorizationId.startsWith("auth_")) {
      throw new Error("Policy authorization binding is invalid");
    }
  }
  for (const [decisionId, plan] of Object.entries(state.reauthorizationPlans)) {
    if (decisionId !== plan.decisionId) {
      throw new Error("Reauthorization plan map key is invalid");
    }
    validateSelection(plan.wallet);
  }

  validatePrivateBalanceCreationState(state, validateSelection, validatePrivateBalance,
    backendWalletNames);
  validatePrivateBalanceFundingState(state, validateSelection, validatePrivateBalance);
  validatePrivateBalancePolicyState(state, validatePrivateBalance);
  validateUniqueClientRequestIds(state.privateBalanceCreationRequests);
  validateUniqueClientRequestIds(state.privateBalanceFundingRequests);
  validateUniqueClientRequestIds(state.privateBalancePolicyUpdateRequests);
  validatePublicChangeRequestReceipts(state);
  validateUnresolvedResourceUniqueness(state);
}

function validateRegularTransferSource(
  profile: WalletProfileRecord,
  authorization: {
    walletId: string;
    walletName: string;
    selectionEpoch: number;
  },
  sourcePrivateBalance: PrivateBalanceBinding | undefined,
  sourcePublicAddress: string | undefined,
  validatePrivateBalance: (
    binding: PrivateBalanceBinding,
    exactRevision: boolean,
  ) => PrivateBalanceRecord,
): void {
  if (!sourcePrivateBalance && !sourcePublicAddress) return;
  if (!sourcePrivateBalance || !sourcePublicAddress ||
    !sameSelectionBinding(sourcePrivateBalance, authorization) ||
    sourcePrivateBalance.walletId !== profile.walletId) {
    throw new Error("Regular transfer pocket source binding is invalid");
  }
  const pocket = validatePrivateBalance(sourcePrivateBalance, false);
  const account = pocket.publicChangeAccounts?.[sourcePublicAddress.toLowerCase()];
  if (!account || account.address.toLowerCase() !== sourcePublicAddress.toLowerCase()) {
    throw new Error("Regular transfer public change source is not tracked");
  }
}

function validatePrivateBalanceCreationState(
  state: StateDocument,
  validateSelection: (binding: PrivateBalanceCreationPlan["wallet"]) => WalletProfileRecord,
  validatePrivateBalance: (
    binding: PrivateBalanceBinding,
    exactRevision: boolean,
  ) => PrivateBalanceRecord,
  persistedBackendWalletNames: Set<string>,
): void {
  const reservedBackendWalletNames = new Set(persistedBackendWalletNames);
  for (const [decisionId, plan] of Object.entries(state.privateBalanceCreationPlans)) {
    if (decisionId !== plan.decisionId) {
      throw new Error("Private balance creation plan map key is invalid");
    }
    const profile = validateSelection(plan.wallet);
    const request = Object.values(state.privateBalanceCreationRequests).find(
      (candidate) => candidate.decisionId === plan.decisionId,
    );
    if (plan.consumedByRequestId !== undefined &&
      plan.consumedByRequestId !== request?.requestId) {
      throw new Error("Private balance creation plan receipt is invalid");
    }
    if (request) {
      const record = profile.privateBalances[plan.privateBalanceId];
      if (record && (record.name !== plan.privateBalanceName ||
        record.backendWalletName !== plan.backendWalletName)) {
        throw new Error("Private balance creation record is invalid");
      }
      if (!record && request.phase !== "failed") {
        const backendWalletName = plan.backendWalletName.toLowerCase();
        if (backendWalletName === profile.name.toLowerCase() ||
          reservedBackendWalletNames.has(backendWalletName)) {
          throw new Error("Private balance creation backend wallet is already in use");
        }
        reservedBackendWalletNames.add(backendWalletName);
      }
      continue;
    }
    if (plan.decision !== "allow" || plan.cancelledAt || plan.appliedAt) continue;
    const backendWalletName = plan.backendWalletName.toLowerCase();
    if (backendWalletName === profile.name.toLowerCase() ||
      reservedBackendWalletNames.has(backendWalletName)) {
      throw new Error("Private balance creation backend wallet is already in use");
    }
    reservedBackendWalletNames.add(backendWalletName);
  }

  for (const [requestId, request] of Object.entries(state.privateBalanceCreationRequests)) {
    if (requestId !== request.requestId) {
      throw new Error("Private balance creation request map key is invalid");
    }
    const plan = state.privateBalanceCreationPlans[request.decisionId];
    if (!plan || plan.consumedByRequestId !== request.requestId ||
      !sameSelectionBinding(plan.wallet, request.privateBalance) ||
      plan.privateBalanceId !== request.privateBalance.privateBalanceId ||
      plan.privateBalanceName !== request.privateBalance.privateBalanceName ||
      plan.backendWalletName !== request.privateBalance.backendWalletName) {
      throw new Error("Private balance creation request plan reference is invalid");
    }
    const profile = state.wallet!.profiles[plan.wallet.walletId]!;
    const record = profile.privateBalances[plan.privateBalanceId];
    if (request.phase === "created" || request.appliedAt) {
      validatePrivateBalance(request.privateBalance, false);
      if (!record || record.revision < request.privateBalance.privateBalanceRevision) {
        throw new Error("Created private balance record is missing");
      }
    } else if (record) {
      validatePrivateBalance(request.privateBalance, false);
    }
  }
}

function validatePrivateBalanceFundingState(
  state: StateDocument,
  validateSelection: (binding: PrivateBalanceFundingPlan["sourceWallet"]) => WalletProfileRecord,
  validatePrivateBalance: (
    binding: PrivateBalanceBinding,
    exactRevision: boolean,
  ) => PrivateBalanceRecord,
): void {
  const unresolvedTargets = new Set<string>();
  const reserveTarget = (binding: PrivateBalanceBinding): void => {
    const key = `${binding.walletId}:${binding.privateBalanceId}`;
    if (unresolvedTargets.has(key)) {
      throw new Error("Private balance already has unresolved funding");
    }
    unresolvedTargets.add(key);
  };

  for (const [decisionId, plan] of Object.entries(state.privateBalanceFundingPlans)) {
    if (decisionId !== plan.decisionId) {
      throw new Error("Private balance funding plan map key is invalid");
    }
    validateSelection(plan.sourceWallet);
    validateSelection(plan.targetWallet);
    if (plan.targetPrivateBalance.walletId !== plan.targetWallet.walletId ||
      !sameSelectionBinding(plan.targetPrivateBalance, plan.targetWallet)) {
      throw new Error("Private balance funding target wallet is invalid");
    }
    validatePrivateBalance(plan.targetPrivateBalance, false);
    if (plan.route === "rebalance_private") {
      if (!plan.sourcePrivateBalance ||
        plan.sourcePrivateBalance.walletId !== plan.sourceWallet.walletId ||
        !sameSelectionBinding(plan.sourcePrivateBalance, plan.sourceWallet)) {
        throw new Error("Private balance funding source wallet is invalid");
      }
      validatePrivateBalance(plan.sourcePrivateBalance, false);
      if (plan.sourcePrivateBalance.walletId === plan.targetPrivateBalance.walletId &&
        plan.sourcePrivateBalance.privateBalanceId === plan.targetPrivateBalance.privateBalanceId) {
        throw new Error("Private balance cannot fund itself");
      }
    }
    const request = plan.consumedByRequestId
      ? state.privateBalanceFundingRequests[plan.consumedByRequestId]
      : undefined;
    if (plan.consumedByRequestId && request?.decisionId !== plan.decisionId) {
      throw new Error("Private balance funding plan receipt is invalid");
    }
  }

  const unresolvedPhases = new Set<PrivateBalanceFundingRequest["phase"]>([
    "executing", "submitted", "indeterminate",
  ]);
  for (const [requestId, request] of Object.entries(state.privateBalanceFundingRequests)) {
    if (requestId !== request.requestId) {
      throw new Error("Private balance funding request map key is invalid");
    }
    const plan = state.privateBalanceFundingPlans[request.decisionId];
    if (!plan || plan.consumedByRequestId !== request.requestId ||
      request.route !== plan.route || request.amountWei !== plan.amountWei ||
      !sameSelectionBinding(request.sourceWallet, plan.sourceWallet) ||
      !sameSelectionBinding(request.targetWallet, plan.targetWallet) ||
      !sameOptionalPrivateBalanceBinding(
        request.sourcePrivateBalance,
        plan.sourcePrivateBalance,
      ) || !samePrivateBalanceBinding(
        request.targetPrivateBalance,
        plan.targetPrivateBalance,
      ) || request.aggregatePrivateBalanceBeforeWei !==
        plan.aggregatePrivateBalanceSnapshotWei ||
      request.sourcePrivateBalanceBeforeWei !==
        plan.sourcePrivateBalanceSnapshotWei ||
      request.targetPrivateBalanceBeforeWei !==
        plan.targetPrivateBalanceSnapshotWei ||
      request.targetCommitment !== plan.targetCommitment ||
      !samePreparedDepositCall(request.preparedDepositCall, plan.preparedDepositCall)) {
      throw new Error("Private balance funding request plan reference is invalid");
    }
    validatePrivateBalance(request.targetPrivateBalance, false);
    if (request.sourcePrivateBalance) {
      validatePrivateBalance(request.sourcePrivateBalance, false);
    }
    if (unresolvedPhases.has(request.phase)) reserveTarget(request.targetPrivateBalance);
  }
}

function validatePrivateBalancePolicyState(
  state: StateDocument,
  validatePrivateBalance: (
    binding: PrivateBalanceBinding,
    exactRevision: boolean,
  ) => PrivateBalanceRecord,
): void {
  for (const [decisionId, plan] of Object.entries(state.privateBalancePolicyUpdatePlans)) {
    if (decisionId !== plan.decisionId) {
      throw new Error("Private balance policy plan map key is invalid");
    }
    const request = plan.consumedByRequestId
      ? state.privateBalancePolicyUpdateRequests[plan.consumedByRequestId]
      : undefined;
    validatePrivateBalance(plan.privateBalance, false);
    validatePolicySnapshot(plan.current);
    validatePolicySnapshot(plan.proposed);
    if (plan.appliedPolicy) {
      validatePolicySnapshot(plan.appliedPolicy);
      if (!samePolicySnapshot(plan.appliedPolicy, plan.proposed)) {
        throw new Error("Private balance applied policy is invalid");
      }
    }
    if (plan.consumedByRequestId && request?.decisionId !== plan.decisionId) {
      throw new Error("Private balance policy plan receipt is invalid");
    }
  }
  for (const [requestId, request] of Object.entries(state.privateBalancePolicyUpdateRequests)) {
    if (requestId !== request.requestId) {
      throw new Error("Private balance policy request map key is invalid");
    }
    const plan = state.privateBalancePolicyUpdatePlans[request.decisionId];
    if (!plan || plan.consumedByRequestId !== request.requestId ||
      !samePrivateBalanceBinding(plan.privateBalance, request.privateBalance)) {
      throw new Error("Private balance policy request plan reference is invalid");
    }
    validatePrivateBalance(request.privateBalance, false);
    if (request.policy) {
      validatePolicySnapshot(request.policy);
      if (!samePolicySnapshot(request.policy, plan.proposed)) {
        throw new Error("Private balance policy receipt is invalid");
      }
    }
  }
}

function validatePrivatePolicyCap(
  policy: DelegationPolicy,
  aggregate: DelegationPolicy | undefined,
): void {
  validatePolicyEnvelope(policy, "Private balance policy");
  if (!policy.enabled) return;
  if (!aggregate) {
    throw new Error("Private balance policy has no wallet-wide authority");
  }
  if (BigInt(policy.perPaymentLimitWei) > BigInt(aggregate.perPaymentLimitWei) ||
    BigInt(policy.lifetimeLimitWei) > BigInt(aggregate.lifetimeLimitWei) ||
    BigInt(policy.spentWei) > BigInt(aggregate.spentWei) ||
    policy.maxPayments > aggregate.maxPayments ||
    Date.parse(policy.expiresAt) > Date.parse(aggregate.expiresAt) ||
    (policy.enabled && !aggregate.enabled)) {
    throw new Error("Private balance policy expands wallet-wide authority");
  }
}

function validatePolicyEnvelope(
  policy: DelegationPolicy,
  label: string,
): void {
  const lifetime = BigInt(policy.lifetimeLimitWei);
  const spent = BigInt(policy.spentWei);
  if (spent > lifetime) {
    throw new Error(`${label} spent amount exceeds its lifetime limit`);
  }
  const paymentEnvelope = BigInt(policy.perPaymentLimitWei) *
    BigInt(policy.maxPayments);
  if (lifetime > paymentEnvelope && lifetime !== spent) {
    throw new Error(`${label} lifetime exceeds its payment envelope`);
  }
}

function validatePolicySnapshot(policy: WalletPolicySnapshot): void {
  const expectedRemaining = Math.max(0, policy.maxPayments - policy.paymentsUsed);
  if (policy.paymentsRemaining !== expectedRemaining) {
    throw new Error("Private balance policy counters are inconsistent");
  }
}

function validatePrivateDebitRestoration(value: {
  phase: string;
  privateBalanceDebitedAt?: string;
  privateBalanceRestoredAt?: string;
}): void {
  if (value.privateBalanceRestoredAt && !value.privateBalanceDebitedAt) {
    throw new Error("Private balance cannot be restored before it is debited");
  }
  if (value.privateBalanceRestoredAt && value.phase !== "failed") {
    throw new Error("Private balance can only be restored for a failed request");
  }
  if (value.privateBalanceDebitedAt && value.privateBalanceRestoredAt &&
    Date.parse(value.privateBalanceRestoredAt) < Date.parse(value.privateBalanceDebitedAt)) {
    throw new Error("Private balance restoration timestamp cannot precede its debit");
  }
}

function validateRegularSpendRestoration(request: RegularTransferRequest): void {
  if (request.policySpendRestoredAt && !request.policySpendDebitedAt) {
    throw new Error("Regular transfer policy spend cannot be restored before it is debited");
  }
  if (request.privatePolicySpendRestoredAt && !request.privatePolicySpendDebitedAt) {
    throw new Error("Private policy spend cannot be restored before it is debited");
  }
  if (request.policySpendRestoredAt && request.phase !== "failed" ||
    request.privatePolicySpendRestoredAt && request.phase !== "failed") {
    throw new Error("Regular transfer policy spend can only be restored for a failed request");
  }
  if (request.policySpendDebitedAt && request.policySpendRestoredAt &&
    Date.parse(request.policySpendRestoredAt) < Date.parse(request.policySpendDebitedAt)) {
    throw new Error("Regular transfer policy restoration timestamp cannot precede its debit");
  }
  if (request.privatePolicySpendDebitedAt && request.privatePolicySpendRestoredAt &&
    Date.parse(request.privatePolicySpendRestoredAt) <
      Date.parse(request.privatePolicySpendDebitedAt)) {
    throw new Error("Private policy restoration timestamp cannot precede its debit");
  }
  if (request.sourcePrivateBalance &&
    ((request.policySpendDebitedAt === undefined) !==
      (request.privatePolicySpendDebitedAt === undefined) ||
      (request.policySpendRestoredAt === undefined) !==
      (request.privatePolicySpendRestoredAt === undefined))) {
    throw new Error("Pocket-sourced transfer policy reservations are inconsistent");
  }
}

function validateUniqueClientRequestIds(
  requests: Record<string, { clientRequestId: string }>,
): void {
  const clientRequestIds = new Set<string>();
  for (const request of Object.values(requests)) {
    if (clientRequestIds.has(request.clientRequestId)) {
      throw new Error("Private balance client request ID is not unique");
    }
    clientRequestIds.add(request.clientRequestId);
  }
}

function publicChangeSourceMatches(
  state: StateDocument,
  profile: WalletProfileRecord,
  pocket: PrivateBalanceRecord,
  sourceRequestId: string,
): boolean {
  const payment = state.requests[sourceRequestId];
  if (payment) {
    return payment.phase === "confirmed" && payment.publicChangeWei !== undefined &&
      payment.authorization.walletId === profile.walletId &&
      payment.privateBalanceId === pocket.privateBalanceId;
  }
  const recovery = state.recoveryRequests[sourceRequestId];
  if (recovery) {
    return recovery.phase === "confirmed" && recovery.publicChangeWei !== undefined &&
      recovery.wallet.walletId === profile.walletId &&
      recovery.privateBalanceId === pocket.privateBalanceId;
  }
  const funding = state.privateBalanceFundingRequests[sourceRequestId];
  return funding?.phase === "confirmed" &&
    funding.sourcePublicChangeWei !== undefined &&
    funding.route === "rebalance_private" &&
    funding.sourcePrivateBalance?.walletId === profile.walletId &&
    funding.sourcePrivateBalance.privateBalanceId === pocket.privateBalanceId;
}

function validatePublicChangeRequestReceipts(state: StateDocument): void {
  const sourceRequestIds = new Set<string>();
  for (const profile of Object.values(state.wallet?.profiles ?? {})) {
    for (const pocket of Object.values(profile.privateBalances)) {
      for (const account of Object.values(pocket.publicChangeAccounts ?? {})) {
        sourceRequestIds.add(account.sourceRequestId);
      }
    }
  }
  for (const request of Object.values(state.requests)) {
    if (request.publicChangeWei !== undefined && !sourceRequestIds.has(request.requestId)) {
      throw new Error("Payment public change receipt has no tracked account");
    }
  }
  for (const request of Object.values(state.recoveryRequests)) {
    if (request.publicChangeWei !== undefined && !sourceRequestIds.has(request.requestId)) {
      throw new Error("Recovery public change receipt has no tracked account");
    }
  }
  for (const request of Object.values(state.privateBalanceFundingRequests)) {
    if (request.sourcePublicChangeWei !== undefined && !sourceRequestIds.has(request.requestId)) {
      throw new Error("Funding public change receipt has no tracked account");
    }
  }
}

type DurableResourceOwner = {
  kind: "payment" | "recovery" | "regular_transfer" | "private_balance_funding";
  requestId: string;
  /** v2 requests predate durable reservation markers and are grandfathered read-only. */
  legacyUnmarked: boolean;
};

/**
 * A request which may already have reached a broadcaster owns every balance it
 * could consume until reconciliation reaches a terminal phase. Keep the
 * durable invariant aligned with the controller-side conflict checks so a
 * restart cannot load two independent workflows which both believe they own
 * the same pocket or main account.
 */
function validateUnresolvedResourceUniqueness(state: StateDocument): void {
  const owners = new Map<string, DurableResourceOwner>();
  const reserve = (resource: string, owner: DurableResourceOwner): void => {
    const existing = owners.get(resource);
    if (existing) {
      if (existing.legacyUnmarked && owner.legacyUnmarked) return;
      throw new Error(
        `Wallet resource has conflicting unresolved requests: ${existing.kind} ` +
        `${existing.requestId} and ${owner.kind} ${owner.requestId}`,
      );
    }
    owners.set(resource, owner);
  };
  const unresolved = (phase: string): boolean =>
    phase === "executing" || phase === "submitted" || phase === "indeterminate";
  const privateResource = (walletId: string, privateBalanceId: string): string =>
    `private:${walletId}:${privateBalanceId}`;
  const mainResource = (walletId: string): string => `main:${walletId}`;
  const publicChangeResource = (walletId: string, address: string): string =>
    `public-change:${walletId}:${address.toLowerCase()}`;

  for (const request of Object.values(state.requests)) {
    if (!unresolved(request.phase)) continue;
    reserve(
      privateResource(request.authorization.walletId, request.privateBalanceId!),
      {
        kind: "payment",
        requestId: request.requestId,
        legacyUnmarked: request.privateBalanceDebitedAt === undefined &&
          hasLegacyMigrationBlocker(state.plans[request.decisionId]),
      },
    );
  }
  for (const request of Object.values(state.recoveryRequests)) {
    if (!unresolved(request.phase)) continue;
    reserve(
      privateResource(request.wallet.walletId, request.privateBalanceId!),
      {
        kind: "recovery",
        requestId: request.requestId,
        legacyUnmarked: request.privateBalanceDebitedAt === undefined &&
          hasLegacyMigrationBlocker(state.recoveryPlans[request.decisionId]),
      },
    );
  }
  for (const request of Object.values(state.regularRequests)) {
    if (!unresolved(request.phase)) continue;
    const owner: DurableResourceOwner = {
      kind: "regular_transfer",
      requestId: request.requestId,
      legacyUnmarked: !request.sourcePrivateBalance &&
        request.policySpendDebitedAt === undefined &&
        hasLegacyMigrationBlocker(state.regularPlans[request.decisionId]),
    };
    if (request.sourcePrivateBalance && request.sourcePublicAddress) {
      reserve(
        privateResource(
          request.sourcePrivateBalance.walletId,
          request.sourcePrivateBalance.privateBalanceId,
        ),
        owner,
      );
      reserve(
        publicChangeResource(
          request.sourcePrivateBalance.walletId,
          request.sourcePublicAddress,
        ),
        owner,
      );
    } else {
      reserve(mainResource(request.authorization.walletId), owner);
    }
  }
  for (const request of Object.values(state.privateBalanceFundingRequests)) {
    if (!unresolved(request.phase)) continue;
    const owner: DurableResourceOwner = {
      kind: "private_balance_funding",
      requestId: request.requestId,
      legacyUnmarked: false,
    };
    reserve(
      privateResource(
        request.targetPrivateBalance.walletId,
        request.targetPrivateBalance.privateBalanceId,
      ),
      owner,
    );
    if (request.route === "shield_from_main") {
      reserve(mainResource(request.sourceWallet.walletId), owner);
    } else if (request.sourcePrivateBalance) {
      reserve(
        privateResource(
          request.sourcePrivateBalance.walletId,
          request.sourcePrivateBalance.privateBalanceId,
        ),
        owner,
      );
    }
  }
}

function hasLegacyMigrationBlocker(
  plan: { blockers: string[] } | undefined,
): boolean {
  return plan?.blockers.includes("STATE_MIGRATION_REPLAN_REQUIRED") ?? false;
}

function validateStateTransition(previous: StateDocument, next: StateDocument): void {
  if (
    previous.wallet?.activeWalletId === next.wallet?.activeWalletId
  ) {
    validateOnboardingCheckpointTransition(
      previous.onboarding,
      next.onboarding,
    );
  }
  for (const [walletId, previousProfile] of Object.entries(previous.wallet?.profiles ?? {})) {
    const nextProfile = next.wallet?.profiles[walletId];
    if (!nextProfile) throw new Error("Wallet profiles cannot be deleted");
    validateOnboardingCheckpointTransition(
      previousProfile.onboarding,
      nextProfile.onboarding,
    );
    for (const [privateBalanceId, previousPocket] of Object.entries(
      previousProfile.privateBalances,
    )) {
      const nextPocket = nextProfile.privateBalances[privateBalanceId];
      if (!nextPocket) throw new Error("Private balances cannot be deleted");
      if (nextPocket.backendWalletName !== previousPocket.backendWalletName) {
        throw new Error("Private balance backend wallet is immutable");
      }
      for (const [address, previousAccount] of Object.entries(
        previousPocket.publicChangeAccounts ?? {},
      )) {
        const nextAccount = nextPocket.publicChangeAccounts?.[address];
        if (!nextAccount) throw new Error("Public change accounts cannot be deleted");
        if (nextAccount.version !== previousAccount.version ||
          nextAccount.address !== previousAccount.address ||
          nextAccount.sourceRequestId !== previousAccount.sourceRequestId ||
          nextAccount.createdAt !== previousAccount.createdAt) {
          throw new Error("Public change account identity is immutable");
        }
        if (Date.parse(nextAccount.updatedAt) < Date.parse(previousAccount.updatedAt)) {
          throw new Error("Public change account updatedAt cannot regress");
        }
      }
    }
  }
  for (const [decisionId, previousPlan] of Object.entries(
    previous.privateBalanceFundingPlans,
  )) {
    const nextPlan = next.privateBalanceFundingPlans[decisionId];
    if (!nextPlan || previousPlan.targetCommitment !== nextPlan.targetCommitment ||
      previousPlan.sourceExecutorAddress !== nextPlan.sourceExecutorAddress ||
      !samePreparedDepositCall(
        previousPlan.preparedDepositCall,
        nextPlan.preparedDepositCall,
      )) {
      throw new Error("Private balance funding plan execution target is immutable");
    }
  }
  for (const [requestId, previousRequest] of Object.entries(
    previous.privateBalanceFundingRequests,
  )) {
    const nextRequest = next.privateBalanceFundingRequests[requestId];
    if (!nextRequest || previousRequest.targetCommitment !== nextRequest.targetCommitment ||
      !samePreparedDepositCall(
        previousRequest.preparedDepositCall,
        nextRequest.preparedDepositCall,
      )) {
      throw new Error("Private balance funding request execution target is immutable");
    }
  }

  assertImmutableCollectionCore(
    "Payment plan",
    previous.plans,
    next.plans,
    ["decision", "blockers"],
  );
  assertImmutableCollectionCore(
    "Policy plan",
    previous.policyPlans,
    next.policyPlans,
    ["decision", "blockers", "appliedAt", "appliedPolicy"],
  );
  assertImmutableCollectionCore(
    "Regular transfer plan",
    previous.regularPlans,
    next.regularPlans,
    ["decision", "blockers"],
  );
  assertImmutableCollectionCore(
    "Recovery plan",
    previous.recoveryPlans,
    next.recoveryPlans,
    ["decision", "blockers", "consumedByRequestId"],
  );
  assertImmutableCollectionCore(
    "Reauthorization plan",
    previous.reauthorizationPlans,
    next.reauthorizationPlans,
    ["decision", "blockers", "appliedAt", "appliedAuthorizationId"],
  );
  assertImmutableCollectionCore(
    "Private balance creation plan",
    previous.privateBalanceCreationPlans,
    next.privateBalanceCreationPlans,
    ["decision", "blockers", "cancelledAt", "consumedByRequestId", "appliedAt"],
  );
  assertImmutableCollectionCore(
    "Private balance funding plan",
    previous.privateBalanceFundingPlans,
    next.privateBalanceFundingPlans,
    ["decision", "blockers", "cancelledAt", "consumedByRequestId", "appliedAt"],
  );
  assertImmutableCollectionCore(
    "Private balance policy plan",
    previous.privateBalancePolicyUpdatePlans,
    next.privateBalancePolicyUpdatePlans,
    [
      "decision",
      "blockers",
      "cancelledAt",
      "consumedByRequestId",
      "appliedAt",
      "appliedPolicy",
    ],
  );

  assertImmutableCollectionCore(
    "Payment request",
    previous.requests,
    next.requests,
    [
      "phase", "updatedAt", "broadcastStartedAt", "transactionHash",
      "userOperationHash", "confirmation", "recipientBalanceBeforeWei",
      "reconciliation", "error", "privateBalanceDebitedAt",
      "privateBalanceRestoredAt", "publicChangeWei",
    ],
  );
  assertImmutableCollectionCore(
    "Regular transfer request",
    previous.regularRequests,
    next.regularRequests,
    [
      "phase", "updatedAt", "broadcastStartedAt", "policySpendDebitedAt",
      "policySpendRestoredAt", "transactionHash", "confirmation",
      "recipientBalanceBeforeWei", "reconciliation", "error",
      "sourcePublicBalanceAfterWei", "privatePolicySpendDebitedAt",
      "privatePolicySpendRestoredAt",
    ],
  );
  assertImmutableCollectionCore(
    "Recovery request",
    previous.recoveryRequests,
    next.recoveryRequests,
    [
      "phase", "updatedAt", "broadcastStartedAt", "transactionHash",
      "userOperationHash", "confirmation", "recipientBalanceBeforeWei",
      "reconciliation", "error", "privateBalanceDebitedAt",
      "privateBalanceRestoredAt", "publicChangeWei",
    ],
  );
  assertImmutableCollectionCore(
    "Private balance creation request",
    previous.privateBalanceCreationRequests,
    next.privateBalanceCreationRequests,
    ["phase", "updatedAt", "appliedAt", "error", "privateBalance"],
  );
  assertImmutableCollectionCore(
    "Private balance funding request",
    previous.privateBalanceFundingRequests,
    next.privateBalanceFundingRequests,
    [
      "phase", "updatedAt", "broadcastStartedAt", "transactionHash",
      "userOperationHash", "confirmation", "reconciliation", "appliedAt",
      "error", "aggregatePrivateBalanceAfterWei", "sourcePrivateBalanceAfterWei",
      "targetPrivateBalanceAfterWei", "sourcePublicChangeWei",
    ],
  );
  assertImmutableCollectionCore(
    "Private balance policy request",
    previous.privateBalancePolicyUpdateRequests,
    next.privateBalancePolicyUpdateRequests,
    ["phase", "updatedAt", "appliedAt", "policy", "error"],
  );

  validateRequestTransitions(previous.requests, next.requests, {
    label: "Payment request",
    terminalPhases: ["confirmed", "failed"],
    appendOnlyFields: [
      "broadcastStartedAt", "privateBalanceDebitedAt", "privateBalanceRestoredAt",
      "confirmation", "publicChangeWei",
    ],
    hashFields: ["transactionHash", "userOperationHash"],
  });
  validateRequestTransitions(previous.regularRequests, next.regularRequests, {
    label: "Regular transfer request",
    terminalPhases: ["confirmed", "failed"],
    appendOnlyFields: [
      "broadcastStartedAt", "policySpendDebitedAt", "policySpendRestoredAt",
      "privatePolicySpendDebitedAt", "privatePolicySpendRestoredAt",
      "sourcePublicBalanceAfterWei", "confirmation",
    ],
    hashFields: ["transactionHash"],
  });
  validateRequestTransitions(previous.recoveryRequests, next.recoveryRequests, {
    label: "Recovery request",
    terminalPhases: ["confirmed", "failed"],
    appendOnlyFields: [
      "broadcastStartedAt", "privateBalanceDebitedAt", "privateBalanceRestoredAt",
      "confirmation", "publicChangeWei",
    ],
    hashFields: ["transactionHash", "userOperationHash"],
  });
  validateRequestTransitions(
    previous.privateBalanceCreationRequests,
    next.privateBalanceCreationRequests,
    {
      label: "Private balance creation request",
      terminalPhases: ["created", "failed"],
      appendOnlyFields: ["appliedAt"],
      hashFields: [],
    },
  );
  validateCreationRequestBindings(
    previous.privateBalanceCreationRequests,
    next.privateBalanceCreationRequests,
  );
  validateRequestTransitions(
    previous.privateBalanceFundingRequests,
    next.privateBalanceFundingRequests,
    {
      label: "Private balance funding request",
      terminalPhases: ["confirmed", "failed"],
      appendOnlyFields: [
        "broadcastStartedAt", "confirmation", "appliedAt", "sourcePublicChangeWei",
      ],
      hashFields: ["transactionHash", "userOperationHash"],
    },
  );
  validateRequestTransitions(
    previous.privateBalancePolicyUpdateRequests,
    next.privateBalancePolicyUpdateRequests,
    {
      label: "Private balance policy request",
      terminalPhases: ["applied", "failed"],
      appendOnlyFields: ["appliedAt", "policy"],
      hashFields: [],
    },
  );

  validatePlanReceiptMarkers(previous.recoveryPlans, next.recoveryPlans, "Recovery plan");
  validatePlanReceiptMarkers(
    previous.privateBalanceCreationPlans,
    next.privateBalanceCreationPlans,
    "Private balance creation plan",
  );
  validatePlanReceiptMarkers(
    previous.privateBalanceFundingPlans,
    next.privateBalanceFundingPlans,
    "Private balance funding plan",
  );
  validatePlanReceiptMarkers(
    previous.privateBalancePolicyUpdatePlans,
    next.privateBalancePolicyUpdatePlans,
    "Private balance policy plan",
  );
  validateAppendOnlyFields(
    previous.policyPlans,
    next.policyPlans,
    "Policy plan",
    ["appliedAt", "appliedPolicy"],
  );
  validateAppendOnlyFields(
    previous.reauthorizationPlans,
    next.reauthorizationPlans,
    "Reauthorization plan",
    ["appliedAt", "appliedAuthorizationId"],
  );
  validateNewReservationMarkers(previous, next);
}

function validateOnboardingCheckpointTransition(
  previous: OnboardingRecord | undefined,
  next: OnboardingRecord | undefined,
): void {
  if (
    !previous ||
    (previous.shieldPreparedDepositCall === undefined &&
      previous.shieldBroadcastStartedAt === undefined &&
      previous.shieldTransactionHash === undefined)
  ) {
    return;
  }
  if (!next || next.setupId !== previous.setupId) {
    throw new Error("Onboarding shield checkpoint cannot be removed or rebound");
  }
  assertAppendOnlyField(
    previous,
    next,
    "shieldPreparedDepositCall",
    "Onboarding shield checkpoint",
    false,
  );
  assertAppendOnlyField(
    previous,
    next,
    "shieldBroadcastStartedAt",
    "Onboarding shield checkpoint",
    false,
  );
  assertAppendOnlyField(
    previous,
    next,
    "shieldTransactionHash",
    "Onboarding shield checkpoint",
    true,
  );
}

function assertImmutableCollectionCore<T extends object>(
  label: string,
  previous: Record<string, T>,
  next: Record<string, T>,
  mutableFields: readonly string[],
): void {
  for (const [id, previousValue] of Object.entries(previous)) {
    const nextValue = next[id];
    if (!nextValue) throw new Error(`${label} records cannot be deleted`);
    if (!isDeepStrictEqual(
      immutableProjection(previousValue, mutableFields),
      immutableProjection(nextValue, mutableFields),
    )) {
      throw new Error(`${label} core binding is immutable`);
    }
  }
}

function immutableProjection(
  value: object,
  mutableFields: readonly string[],
): Record<string, unknown> {
  const projection = structuredClone(value) as Record<string, unknown>;
  for (const field of mutableFields) delete projection[field];
  return projection;
}

function validateRequestTransitions<T extends object & { phase: string }>(
  previous: Record<string, T>,
  next: Record<string, T>,
  options: {
    label: string;
    terminalPhases: readonly string[];
    appendOnlyFields: readonly string[];
    hashFields: readonly string[];
  },
): void {
  const terminal = new Set(options.terminalPhases);
  for (const [id, previousValue] of Object.entries(previous)) {
    const nextValue = next[id];
    if (!nextValue) throw new Error(`${options.label} records cannot be deleted`);
    if (terminal.has(previousValue.phase) && nextValue.phase !== previousValue.phase) {
      throw new Error(`${options.label} terminal phase cannot regress or change`);
    }
    for (const field of options.appendOnlyFields) {
      assertAppendOnlyField(previousValue, nextValue, field, options.label, false);
    }
    for (const field of options.hashFields) {
      assertAppendOnlyField(previousValue, nextValue, field, options.label, true);
    }
  }
}

function validateCreationRequestBindings(
  previous: Record<string, PrivateBalanceCreationRequest>,
  next: Record<string, PrivateBalanceCreationRequest>,
): void {
  for (const [requestId, previousRequest] of Object.entries(previous)) {
    const nextRequest = next[requestId];
    if (!nextRequest) throw new Error("Private balance creation request records cannot be deleted");
    const previousBinding = previousRequest.privateBalance;
    const nextBinding = nextRequest.privateBalance;
    if (!sameSelectionBinding(previousBinding, nextBinding) ||
      previousBinding.privateBalanceId !== nextBinding.privateBalanceId ||
      previousBinding.privateBalanceName !== nextBinding.privateBalanceName ||
      previousBinding.backendWalletName !== nextBinding.backendWalletName ||
      nextBinding.privateBalanceRevision < previousBinding.privateBalanceRevision ||
      (previousRequest.phase === "created" &&
        nextBinding.privateBalanceRevision !== previousBinding.privateBalanceRevision)) {
      throw new Error("Private balance creation request core binding is immutable");
    }
  }
}

function validatePlanReceiptMarkers<T extends object>(
  previous: Record<string, T>,
  next: Record<string, T>,
  label: string,
): void {
  validateAppendOnlyFields(previous, next, label, [
    "cancelledAt",
    "consumedByRequestId",
    "appliedAt",
  ]);
}

function validateAppendOnlyFields<T extends object>(
  previous: Record<string, T>,
  next: Record<string, T>,
  label: string,
  fields: readonly string[],
): void {
  for (const [id, previousValue] of Object.entries(previous)) {
    const nextValue = next[id];
    if (!nextValue) throw new Error(`${label} records cannot be deleted`);
    for (const field of fields) {
      assertAppendOnlyField(previousValue, nextValue, field, label, false);
    }
  }
}

function assertAppendOnlyField(
  previous: object,
  next: object,
  field: string,
  label: string,
  caseInsensitiveHex: boolean,
): void {
  const previousValue = (previous as Record<string, unknown>)[field];
  if (previousValue === undefined) return;
  const nextValue = (next as Record<string, unknown>)[field];
  const unchanged = caseInsensitiveHex &&
      typeof previousValue === "string" && typeof nextValue === "string"
    ? previousValue.toLowerCase() === nextValue.toLowerCase()
    : isDeepStrictEqual(previousValue, nextValue);
  if (!unchanged) {
    throw new Error(`${label} ${field} cannot be removed or changed`);
  }
}

function validateNewReservationMarkers(
  previous: StateDocument,
  next: StateDocument,
): void {
  const unresolved = (phase: string): boolean =>
    phase === "executing" || phase === "submitted" || phase === "indeterminate";
  for (const [requestId, request] of Object.entries(next.requests)) {
    const prior = previous.requests[requestId];
    if (unresolved(request.phase) && (!prior || !unresolved(prior.phase)) &&
      !request.privateBalanceDebitedAt &&
      !hasLegacyMigrationBlocker(next.plans[request.decisionId])) {
      throw new Error("New unresolved payment request requires a durable debit marker");
    }
  }
  for (const [requestId, request] of Object.entries(next.recoveryRequests)) {
    const prior = previous.recoveryRequests[requestId];
    if (unresolved(request.phase) && (!prior || !unresolved(prior.phase)) &&
      !request.privateBalanceDebitedAt &&
      !hasLegacyMigrationBlocker(next.recoveryPlans[request.decisionId])) {
      throw new Error("New unresolved recovery request requires a durable debit marker");
    }
  }
  for (const [requestId, request] of Object.entries(next.regularRequests)) {
    const prior = previous.regularRequests[requestId];
    if (unresolved(request.phase) && (!prior || !unresolved(prior.phase)) &&
      !request.policySpendDebitedAt &&
      !hasLegacyMigrationBlocker(next.regularPlans[request.decisionId])) {
      throw new Error("New unresolved regular transfer requires a durable spend marker");
    }
    if (request.sourcePrivateBalance && unresolved(request.phase) &&
      (!prior || !unresolved(prior.phase)) && !request.privatePolicySpendDebitedAt) {
      throw new Error(
        "New unresolved pocket-sourced transfer requires a durable private-policy marker",
      );
    }
  }
}

function sameOnboarding(
  left: OnboardingRecord | undefined,
  right: OnboardingRecord | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function sameSelectionBinding(
  left: { walletId: string; walletName: string; selectionEpoch: number },
  right: { walletId: string; walletName: string; selectionEpoch: number },
): boolean {
  return left.walletId === right.walletId && left.walletName === right.walletName &&
    left.selectionEpoch === right.selectionEpoch;
}

function sameAuthorizationBinding(
  left: { walletId: string; walletName: string; selectionEpoch: number; authorizationId: string },
  right: { walletId: string; walletName: string; selectionEpoch: number; authorizationId: string },
): boolean {
  return sameSelectionBinding(left, right) && left.authorizationId === right.authorizationId;
}

function samePrivateBalanceBinding(
  left: PrivateBalanceBinding,
  right: PrivateBalanceBinding,
): boolean {
  return sameSelectionBinding(left, right) &&
    left.privateBalanceId === right.privateBalanceId &&
    left.privateBalanceName === right.privateBalanceName &&
    left.backendWalletName === right.backendWalletName &&
    left.privateBalanceRevision === right.privateBalanceRevision;
}

function sameOptionalPrivateBalanceBinding(
  left: PrivateBalanceBinding | undefined,
  right: PrivateBalanceBinding | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && samePrivateBalanceBinding(left, right);
}

function samePreparedDepositCall(
  left: { to: string; data: string; valueWei: string },
  right: { to: string; data: string; valueWei: string },
): boolean {
  return left.to === right.to && left.data === right.data &&
    left.valueWei === right.valueWei;
}

function countAuthorizationRequests(
  state: StateDocument,
  authorizationId: string | undefined,
): number {
  if (!authorizationId) return 0;
  return Object.values(state.requests).filter(
    (request) => request.phase !== "failed" &&
      request.authorization.authorizationId === authorizationId,
  ).length + Object.values(state.regularRequests).filter(
    (request) => request.phase !== "failed" &&
      request.authorization.authorizationId === authorizationId,
  ).length;
}

function walletPolicySnapshot(
  onboarding: OnboardingRecord,
  paymentsUsed: number,
): WalletPolicySnapshot {
  return {
    ...onboarding.delegation,
    paymentsUsed,
    paymentsRemaining: Math.max(0, onboarding.delegation.maxPayments - paymentsUsed),
  };
}

function samePolicySnapshot(
  left: WalletPolicySnapshot,
  right: WalletPolicySnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createWalletProfile(
  name: string,
  origin: WalletProfileOrigin,
  now: string,
  selectionEpoch: number,
  authorized: boolean,
): WalletProfileRecord {
  const walletId = `wallet_${randomUUID()}`;
  const defaultPrivateBalanceId = defaultPrivateBalanceIdForWallet(walletId);
  return {
    version: 1,
    walletId,
    name,
    origin,
    status: "available",
    createdAt: now,
    updatedAt: now,
    ...(selectionEpoch > 0 ? { lastSelectedAt: now } : {}),
    selectionEpoch,
    ...(authorized ? { authorizationId: `auth_${randomUUID()}` } : {}),
    archiveIds: [],
    privateBalances: {
      [defaultPrivateBalanceId]: createDefaultPrivateBalance(
        defaultPrivateBalanceId,
        name,
        now,
      ),
    },
    defaultPrivateBalanceId,
  };
}

function createVersion2WalletProfile(
  name: string,
  origin: WalletProfileOrigin,
  now: string,
  selectionEpoch: number,
  authorized: boolean,
): Version2WalletProfileRecord {
  return {
    version: 1,
    walletId: `wallet_${randomUUID()}`,
    name,
    origin,
    status: "available",
    createdAt: now,
    updatedAt: now,
    ...(selectionEpoch > 0 ? { lastSelectedAt: now } : {}),
    selectionEpoch,
    ...(authorized ? { authorizationId: `auth_${randomUUID()}` } : {}),
    archiveIds: [],
  };
}

function migrateVersion2WalletProfile(
  profile: Version2WalletProfileRecord,
): WalletProfileRecord {
  const defaultPrivateBalanceId = defaultPrivateBalanceIdForWallet(profile.walletId);
  const migrated = createDefaultPrivateBalance(
    defaultPrivateBalanceId,
    profile.name,
    profile.createdAt,
    profile.updatedAt,
  );
  // Keep the exact v2 projection stable on disk. Public-change tracking did
  // not exist in v2, and all readers treat an omitted map as empty.
  delete migrated.publicChangeAccounts;
  if (profile.onboarding) {
    migrated.balanceWei = profile.onboarding.privateBalanceWei;
    migrated.revision = profile.onboarding.revision;
    migrated.updatedAt = profile.onboarding.updatedAt;
    migrated.delegation = structuredClone(profile.onboarding.delegation);
  }
  return {
    ...structuredClone(profile),
    privateBalances: { [defaultPrivateBalanceId]: migrated },
    defaultPrivateBalanceId,
  };
}

function defaultPrivateBalanceIdForWallet(walletId: string): string {
  return `private_${walletId}`;
}

function createDefaultPrivateBalance(
  privateBalanceId: string,
  backendWalletName: string,
  createdAt: string,
  updatedAt = createdAt,
): PrivateBalanceRecord {
  return {
    version: 1,
    privateBalanceId,
    name: "private",
    backendWalletName,
    status: "available",
    balanceWei: "0",
    revision: 0,
    createdAt,
    updatedAt,
    delegation: safeDisabledPrivateBalancePolicy(updatedAt),
    publicChangeAccounts: {},
  };
}

function safeDisabledPrivateBalancePolicy(expiresAt: string): DelegationPolicy {
  return {
    mode: "testnet_delegated",
    chainId: 11_155_111,
    perPaymentLimitWei: "0",
    lifetimeLimitWei: "0",
    spentWei: "0",
    maxPayments: 1,
    expiresAt,
    enabled: false,
  };
}

function sameDelegation(left: DelegationPolicy, right: DelegationPolicy): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clampPrivatePolicyToAggregate(
  policy: DelegationPolicy,
  aggregate: DelegationPolicy,
): DelegationPolicy {
  const perPaymentLimitWei = minAtomic(
    policy.perPaymentLimitWei,
    aggregate.perPaymentLimitWei,
  );
  const maxPayments = Math.min(policy.maxPayments, aggregate.maxPayments);
  const spentWei = minAtomic(policy.spentWei, aggregate.spentWei);
  const paymentEnvelopeWei = (
    BigInt(perPaymentLimitWei) * BigInt(maxPayments)
  ).toString();
  // A default or unmanaged pocket inherits the aggregate policy verbatim.
  // Only independently managed children need their own internal envelope
  // tightened after the aggregate changes.
  const boundedLifetimeWei = sameDelegation(policy, aggregate)
    ? minAtomic(policy.lifetimeLimitWei, aggregate.lifetimeLimitWei)
    : minAtomic(
        policy.lifetimeLimitWei,
        aggregate.lifetimeLimitWei,
        paymentEnvelopeWei,
      );
  const lifetimeLimitWei = maxAtomic(spentWei, boundedLifetimeWei);
  return {
    ...policy,
    perPaymentLimitWei,
    lifetimeLimitWei,
    spentWei,
    maxPayments,
    expiresAt: Date.parse(policy.expiresAt) <= Date.parse(aggregate.expiresAt)
      ? policy.expiresAt
      : aggregate.expiresAt,
    enabled: policy.enabled && aggregate.enabled,
  };
}

function minAtomic(...values: string[]): string {
  return values.reduce((minimum, value) =>
    BigInt(value) < BigInt(minimum) ? value : minimum);
}

function maxAtomic(...values: string[]): string {
  return values.reduce((maximum, value) =>
    BigInt(value) > BigInt(maximum) ? value : maximum);
}

function findProfileByName(
  profiles: Record<string, WalletProfileRecord>,
  name: string,
): WalletProfileRecord | undefined {
  return Object.values(profiles).find((profile) => profile.name === name);
}
