import type {
  PrivateBroadcastCheckpoint,
  UserOperationReceiptEvidence,
  UserOperationReceiptStatus,
} from "./contracts.js";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function terminalUserOperationReceiptEvidence(input: {
  userOperationHash: string;
  receipt: UserOperationReceiptStatus;
  observedAt: string;
  storedTransactionHash?: string;
}): UserOperationReceiptEvidence | undefined {
  if (input.receipt.status === "pending") return undefined;
  if (!HASH_PATTERN.test(input.userOperationHash) ||
    !HASH_PATTERN.test(input.receipt.transactionHash) ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    (input.storedTransactionHash !== undefined &&
      input.storedTransactionHash.toLowerCase() !==
        input.receipt.transactionHash.toLowerCase())) {
    throw new Error("UserOperation terminal receipt evidence is invalid");
  }
  return {
    version: 1,
    status: input.receipt.status,
    userOperationHash: input.userOperationHash,
    transactionHash: input.receipt.transactionHash,
    observedAt: input.observedAt,
  };
}

/**
 * Revalidate durable evidence against both request hashes and the exact wallet
 * broadcast journal before it can drive another reconciliation attempt.
 */
export function assertUserOperationReceiptEvidenceMatches(input: {
  evidence: UserOperationReceiptEvidence;
  checkpoint: PrivateBroadcastCheckpoint;
  storedUserOperationHash?: string;
  storedTransactionHash?: string;
}): void {
  const evidence = input.evidence;
  if (evidence.version !== 1 ||
    (evidence.status !== "success" && evidence.status !== "reverted") ||
    !HASH_PATTERN.test(evidence.userOperationHash) ||
    !HASH_PATTERN.test(evidence.transactionHash) ||
    !Number.isFinite(Date.parse(evidence.observedAt)) ||
    evidence.userOperationHash.toLowerCase() !==
      input.checkpoint.userOperationHash.toLowerCase() ||
    (input.storedUserOperationHash !== undefined &&
      evidence.userOperationHash.toLowerCase() !==
        input.storedUserOperationHash.toLowerCase()) ||
    (input.storedTransactionHash !== undefined &&
      evidence.transactionHash.toLowerCase() !==
        input.storedTransactionHash.toLowerCase())) {
    throw new Error("UserOperation terminal receipt evidence does not match its checkpoint");
  }
}

/** Compare the immutable on-chain result, excluding when each observer saw it. */
export function sameUserOperationTerminalResult(
  left: UserOperationReceiptEvidence,
  right: UserOperationReceiptEvidence,
): boolean {
  return left.version === right.version &&
    left.status === right.status &&
    left.userOperationHash.toLowerCase() === right.userOperationHash.toLowerCase() &&
    left.transactionHash.toLowerCase() === right.transactionHash.toLowerCase();
}
