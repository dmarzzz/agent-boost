/**
 * Keep live-eval durable transfer fixtures compatible with production's
 * strict persisted schema. Friendly names are presentation-only and must be
 * rederived from the authoritative public recipient address after restart.
 */
export function assertAddressOnlyTransferRecord(record: object): void {
  if (
    Object.hasOwn(record, "recipientWalletName") ||
    Object.hasOwn(record, "sourceWalletName")
  ) {
    throw new Error("Eval durable transfer state contains a transient wallet label");
  }
}
