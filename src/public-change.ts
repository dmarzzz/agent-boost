import type {
  ChainClient,
  PrivateBroadcastCheckpoint,
  PrivateBalanceRecord,
  PublicChangeAccountRecord,
  RawTransactionBroadcastCheckpoint,
  WalletAdapter,
  WalletProfileRecord,
} from "./contracts.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ENTRY_POINT_V08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
const SEPOLIA_CHAIN_ID = 11_155_111;
const DECIMAL_UINT_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const HEX_BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;

export async function matchingPrivateBroadcastCheckpoint(input: {
  wallet: WalletAdapter;
  requestId: string;
  storedUserOperationHash?: string;
}): Promise<PrivateBroadcastCheckpoint | undefined> {
  if (!input.wallet.getPrivateBroadcastCheckpoint) return undefined;
  const checkpoint = await input.wallet.getPrivateBroadcastCheckpoint(
    input.requestId,
  );
  if (!checkpoint) return undefined;
  if (
    checkpoint.requestId !== input.requestId ||
    !HASH_PATTERN.test(checkpoint.userOperationHash) ||
    !ADDRESS_PATTERN.test(checkpoint.sender) ||
    checkpoint.entryPointAddress.toLowerCase() !== ENTRY_POINT_V08 ||
    (input.storedUserOperationHash !== undefined &&
      input.storedUserOperationHash.toLowerCase() !==
        checkpoint.userOperationHash.toLowerCase())
  ) {
    throw new Error("PRIVATE_BROADCAST_CHECKPOINT_MISMATCH");
  }
  return checkpoint;
}

export async function matchingRawTransactionBroadcastCheckpoint(input: {
  wallet: WalletAdapter;
  requestId: string;
  expectedFrom: string;
  expectedTo: string;
  expectedValueWei: string;
  expectedData: string;
  storedTransactionHash?: string;
}): Promise<RawTransactionBroadcastCheckpoint | undefined> {
  if (!input.wallet.getRawTransactionBroadcastCheckpoint) return undefined;
  const checkpoint = await input.wallet.getRawTransactionBroadcastCheckpoint(
    input.requestId,
  );
  if (!checkpoint) return undefined;
  if (
    checkpoint.requestId !== input.requestId ||
    !HASH_PATTERN.test(checkpoint.transactionHash) ||
    !ADDRESS_PATTERN.test(checkpoint.from) ||
    checkpoint.from.toLowerCase() !== input.expectedFrom.toLowerCase() ||
    !ADDRESS_PATTERN.test(checkpoint.to) ||
    checkpoint.to.toLowerCase() !== input.expectedTo.toLowerCase() ||
    !DECIMAL_UINT_PATTERN.test(checkpoint.valueWei) ||
    checkpoint.valueWei !== input.expectedValueWei ||
    !HEX_BYTES_PATTERN.test(checkpoint.data) ||
    checkpoint.data.toLowerCase() !== input.expectedData.toLowerCase() ||
    checkpoint.chainId !== SEPOLIA_CHAIN_ID ||
    !DECIMAL_UINT_PATTERN.test(checkpoint.nonce) ||
    !DECIMAL_UINT_PATTERN.test(checkpoint.gas) ||
    BigInt(checkpoint.gas) <= 0n ||
    !["legacy", "eip2930", "eip1559"].includes(checkpoint.transactionType) ||
    (input.storedTransactionHash !== undefined &&
      input.storedTransactionHash.toLowerCase() !==
        checkpoint.transactionHash.toLowerCase())
  ) {
    throw new Error("RAW_TRANSACTION_BROADCAST_CHECKPOINT_MISMATCH");
  }
  return checkpoint;
}

export async function observeConfirmedPublicChange(input: {
  wallet: WalletAdapter;
  chain: ChainClient;
  backendWalletName: string;
  checkpoint: PrivateBroadcastCheckpoint;
}): Promise<bigint> {
  if (input.wallet.ensurePrivateChangeAccount) {
    await input.wallet.ensurePrivateChangeAccount(
      input.backendWalletName,
      input.checkpoint.sender,
    );
  }
  return input.chain.getBalanceWei(input.checkpoint.sender);
}

export function publicChangeBalanceWei(
  privateBalance: PrivateBalanceRecord,
): bigint {
  return Object.values(privateBalance.publicChangeAccounts ?? {}).reduce(
    (total, account) => total + BigInt(account.balanceWei),
    0n,
  );
}

export function selectPublicChangeAccount(
  privateBalance: PrivateBalanceRecord,
  requiredWei: bigint,
): PublicChangeAccountRecord | undefined {
  if (requiredWei <= 0n) throw new Error("PUBLIC_CHANGE_REQUIRED_AMOUNT_INVALID");
  return Object.values(privateBalance.publicChangeAccounts ?? {})
    .filter((account) => BigInt(account.balanceWei) >= requiredWei)
    .sort((left, right) => {
      const leftBalance = BigInt(left.balanceWei);
      const rightBalance = BigInt(right.balanceWei);
      if (leftBalance !== rightBalance) return leftBalance < rightBalance ? -1 : 1;
      const created = left.createdAt.localeCompare(right.createdAt);
      return created !== 0 ? created : left.address.localeCompare(right.address);
    })[0];
}

export function recordPublicChangeAccount(input: {
  profile: WalletProfileRecord;
  privateBalanceId: string;
  sourceRequestId: string;
  address: string;
  balanceWei: bigint;
  observedAt: string;
}): void {
  const privateBalance = input.profile.privateBalances[input.privateBalanceId];
  if (!privateBalance) throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_TARGET_MISSING");
  if (!ADDRESS_PATTERN.test(input.address)) {
    throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_ADDRESS_INVALID");
  }
  if (input.balanceWei < 0n) {
    throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_BALANCE_INVALID");
  }
  const key = input.address.toLowerCase();
  const accounts = privateBalance.publicChangeAccounts ??= {};
  const existing = accounts[key];
  if (existing) {
    if (existing.address.toLowerCase() !== key) {
      throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_BINDING_CHANGED");
    }
    if (existing.balanceWei === input.balanceWei.toString()) return;
    existing.balanceWei = input.balanceWei.toString();
    existing.updatedAt = input.observedAt;
  } else {
    accounts[key] = {
      version: 1,
      address: input.address,
      balanceWei: input.balanceWei.toString(),
      sourceRequestId: input.sourceRequestId,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
    };
  }
  privateBalance.revision += 1;
  privateBalance.updatedAt = input.observedAt;
  input.profile.updatedAt = input.observedAt;
}

export function refreshPublicChangeAccount(input: {
  profile: WalletProfileRecord;
  privateBalanceId: string;
  address: string;
  balanceWei: bigint;
  observedAt: string;
}): void {
  const privateBalance = input.profile.privateBalances[input.privateBalanceId];
  const key = input.address.toLowerCase();
  const account = privateBalance?.publicChangeAccounts?.[key];
  if (!privateBalance || !account || account.address.toLowerCase() !== key) {
    throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_ACCOUNT_MISSING");
  }
  if (input.balanceWei < 0n) {
    throw new Error("PRIVATE_BALANCE_PUBLIC_CHANGE_BALANCE_INVALID");
  }
  if (account.balanceWei === input.balanceWei.toString()) return;
  account.balanceWei = input.balanceWei.toString();
  account.updatedAt = input.observedAt;
  privateBalance.revision += 1;
  privateBalance.updatedAt = input.observedAt;
  input.profile.updatedAt = input.observedAt;
}
