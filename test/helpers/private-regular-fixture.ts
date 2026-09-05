import type {
  PrivateBalanceBinding,
  RegularTransferRequest,
} from "../../src/contracts.js";
import { StateStore } from "../../src/state/store.js";

const RECIPIENT = "0x2222222222222222222222222222222222222222";
const PUBLIC_CHANGE = "0x7777777777777777777777777777777777777777";
const CREATED_AT = new Date(1_000).toISOString();
const EXPIRES_AT = new Date(86_400_000).toISOString();
const PAYMENT_TRANSACTION_HASH = `0x${"79".repeat(32)}`;
const REGULAR_TRANSACTION_HASH = `0x${"7a".repeat(32)}`;

/**
 * Installs a schema-valid historical regular send without exercising the
 * regular-transfer controller. Pocket sources include a confirmed private
 * payment solely to provide durable provenance for their tracked public-change
 * account.
 */
export async function seedRegularRequestFixture(
  store: StateStore,
  input: {
    suffix: string;
    phase: "confirmed" | "submitted" | "failed";
    privateBalanceId?: string;
    amountWei?: string;
  },
): Promise<{
  requestId: string;
  privateBalanceId?: string;
  provenancePaymentCount: number;
}> {
  const profile = await store.activeWalletProfile();
  if (!profile.authorizationId) throw new Error("fixture wallet is not authorized");
  const privateBalanceId = input.privateBalanceId;
  const pocket = privateBalanceId === undefined
    ? undefined
    : profile.privateBalances[privateBalanceId];
  if (privateBalanceId !== undefined && !pocket) {
    throw new Error("fixture private balance is missing");
  }
  const authorization = {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
    authorizationId: profile.authorizationId,
  };
  const sourcePrivateBalance: PrivateBalanceBinding | undefined = pocket
    ? {
        walletId: profile.walletId,
        walletName: profile.name,
        selectionEpoch: profile.selectionEpoch,
        privateBalanceId: pocket.privateBalanceId,
        privateBalanceName: pocket.name,
        backendWalletName: pocket.backendWalletName,
        privateBalanceRevision: pocket.revision,
      }
    : undefined;
  const amountWei = input.amountWei ?? "1";
  const decisionId = `rwd_fixture_${input.suffix}`;
  const requestId = `rreq_fixture_${input.suffix}`;
  const provenanceDecisionId = `wd_change_${input.suffix}`;
  const provenanceRequestId = `req_change_${input.suffix}`;
  let provenancePaymentCount = 0;

  await store.update((draft) => {
    const currentProfile = draft.wallet?.profiles[authorization.walletId];
    if (!currentProfile) throw new Error("fixture wallet profile disappeared");
    const currentPocket = privateBalanceId === undefined
      ? undefined
      : currentProfile.privateBalances[privateBalanceId];
    if (privateBalanceId !== undefined && !currentPocket) {
      throw new Error("fixture private balance disappeared");
    }

    if (currentPocket && !currentPocket.publicChangeAccounts?.[PUBLIC_CHANGE]) {
      const privateBalanceRevision = currentPocket.revision;
      draft.plans[provenanceDecisionId] = {
        version: 1,
        decisionId: provenanceDecisionId,
        recipient: RECIPIENT,
        amountWei: "1",
        authorization,
        privateBalanceId: currentPocket.privateBalanceId,
        privateBalanceRevision,
        privateBalanceDebitWei: "1",
        intentDigest: `sha256:${"7".repeat(64)}`,
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        decision: "allow",
        blockers: [],
        approval: { action: "confirm", userConfirmationRequired: true },
      };
      draft.requests[provenanceRequestId] = {
        version: 1,
        requestId: provenanceRequestId,
        clientRequestId: `fixture:${input.suffix}:change`,
        decisionId: provenanceDecisionId,
        recipient: RECIPIENT,
        amountWei: "1",
        authorization,
        privateBalanceId: currentPocket.privateBalanceId,
        privateBalanceRevision,
        privateBalanceDebitWei: "1",
        publicChangeWei: "100",
        phase: "confirmed",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        transactionHash: PAYMENT_TRANSACTION_HASH,
        confirmation: { method: "adapter", checkedAt: CREATED_AT },
      };
      currentPocket.publicChangeAccounts ??= {};
      currentPocket.publicChangeAccounts[PUBLIC_CHANGE] = {
        version: 1,
        address: PUBLIC_CHANGE,
        balanceWei: "100",
        sourceRequestId: provenanceRequestId,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      };
      provenancePaymentCount = 1;
    }

    draft.regularPlans[decisionId] = {
      version: 1,
      decisionId,
      recipient: RECIPIENT,
      amountWei,
      mainBalanceSnapshotWei: "100",
      gasReserveWei: "1",
      authorization,
      ...(sourcePrivateBalance
        ? { sourcePrivateBalance, sourcePublicAddress: PUBLIC_CHANGE }
        : {}),
      intentDigest: `sha256:${"8".repeat(64)}`,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      decision: "allow",
      blockers: [],
      approval: { action: "confirm", userConfirmationRequired: true },
    };
    const request: RegularTransferRequest = {
      version: 1,
      requestId,
      clientRequestId: `fixture:${input.suffix}:regular`,
      decisionId,
      recipient: RECIPIENT,
      amountWei,
      gasReserveWei: "1",
      authorization,
      ...(sourcePrivateBalance
        ? {
            sourcePrivateBalance,
            sourcePublicAddress: PUBLIC_CHANGE,
            sourcePublicBalanceBeforeWei: "100",
            privatePolicySpendDebitedAt: CREATED_AT,
            ...(input.phase === "failed"
              ? { privatePolicySpendRestoredAt: CREATED_AT }
              : {}),
          }
        : {}),
      phase: input.phase,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      broadcastStartedAt: CREATED_AT,
      policySpendDebitedAt: CREATED_AT,
      ...(input.phase === "failed"
        ? { policySpendRestoredAt: CREATED_AT }
        : {}),
      transactionHash: REGULAR_TRANSACTION_HASH,
      ...(input.phase === "confirmed"
        ? { confirmation: { method: "transaction_receipt" as const, checkedAt: CREATED_AT } }
        : {}),
    };
    draft.regularRequests[requestId] = request;
  });

  return {
    requestId,
    ...(privateBalanceId === undefined ? {} : { privateBalanceId }),
    provenancePaymentCount,
  };
}
