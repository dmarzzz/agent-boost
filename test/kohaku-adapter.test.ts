import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import * as AbiFunction from "ox/AbiFunction";
import * as AbiParameters from "ox/AbiParameters";
import * as Address from "ox/Address";
import * as Hash from "ox/Hash";
import * as Secp256k1 from "ox/Secp256k1";
import * as TxEnvelopeEip1559 from "ox/TxEnvelopeEip1559";
import * as TxEnvelopeEip2930 from "ox/TxEnvelopeEip2930";
import * as TxEnvelopeLegacy from "ox/TxEnvelopeLegacy";
import * as UserOperation from "ox/erc4337/UserOperation";

import {
  DEFAULT_SHIELD_WEI,
  REGULAR_TRANSFER_GAS_RESERVE_WEI,
  TORNADO_DEPOSIT_GAS_RESERVE_WEI,
} from "../src/contracts.js";
import { WalletExecutionError } from "../src/errors.js";
import { KohakuWalletAdapter } from "../src/kohaku/adapter.js";
import { SpawnCommandRunner } from "../src/kohaku/runner.js";
import type {
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from "../src/kohaku/runner.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const OTHER_ADDRESS = "0x3333333333333333333333333333333333333333";
const TX_HASH = `0x${"ab".repeat(32)}`;
const USER_OPERATION_HASH = `0x${"cd".repeat(32)}`;
const TORNADO_POOL = "0x8c4a04d872a6c1be37964a21ba3a138525dff50b";
const TORNADO_ADAPTER = "0xa616aAE443FCCABfc2F1EA2Afe001E5046FFDCe0";
const TORNADO_PAYMASTER = "0x1c5aCCb9c09D72945b79EC986776136bE01d7B2F";
const ENTRY_POINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const SIMPLE_7702_IMPLEMENTATION =
  "0xe6Cae83BdE06E4c305530e199D7217f42808555B";
const ESTIMATED_PRIVATE_FEE_WEI = 1_000_000_000_000_000n;
const MAX_PRIVATE_PAYMASTER_FEE_RESERVE_WEI = 10_000_000_000_000_000n;
const TOR_GUARD_STATE_CORRUPTION_LINE =
  "Bootstrap failed: tor: corrupted data in persistent state: Error setting up the guard manager";
const TOR_CACHE_RECOVERY_HINT = "Try: kohaku clear-tor-cache";
const TOR_GUARD_STATE_CORRUPTION_OUTPUT =
  `${TOR_GUARD_STATE_CORRUPTION_LINE}\n${TOR_CACHE_RECOVERY_HINT}\n`;
const OBSERVED_LIVE_TORNADO_DEPOSIT_FEE_WEI = 1_230_473_586_707_504n;
const COMMITMENT = `0x${"12".repeat(32)}`;
const DEPOSIT_DATA: `0x${string}` = `0xb214faa5${COMMITMENT.slice(2)}`;
const DEPOSIT_CALL = {
  to: TORNADO_POOL,
  data: DEPOSIT_DATA,
  valueWei: DEFAULT_SHIELD_WEI.toString(),
};
const RAW_TRANSACTION_PRIVATE_KEY =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;
const RAW_TRANSACTION_SIGNER = Address.fromPublicKey(
  Secp256k1.getPublicKey({ privateKey: RAW_TRANSACTION_PRIVATE_KEY }),
).toLowerCase();
const CHECKPOINT_BROADCAST = async (): Promise<void> => {};
const EXECUTE_BATCH = AbiFunction.from(
  "function executeBatch((address target,uint256 value,bytes data)[] calls)",
);
const WITHDRAW = AbiFunction.from(
  "function withdraw(bytes proof,bytes32 root,bytes32 nullifierHash,address recipient,address relayer,uint256 fee,uint256 refund)",
);
const PAYMASTER_DATA_PARAMETERS = AbiParameters.from(
  "(address adapter, bytes adapterData)",
);
const TORNADO_SPONSOR_PARAMETERS = AbiParameters.from(
  "(bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee, uint256 refund)",
);
const SPONSOR_NULLIFIER = `0x${"aa".repeat(32)}` as const;

function tornadoPaymasterData(input: {
  adapterAddress?: `0x${string}`;
  proof?: `0x${string}`;
  root?: `0x${string}`;
  nullifierHash?: `0x${string}`;
  recipient?: `0x${string}`;
  relayer?: `0x${string}`;
  feeWei?: bigint;
  refundWei?: bigint;
} = {}): `0x${string}` {
  const adapterData = AbiParameters.encode(TORNADO_SPONSOR_PARAMETERS, [{
    proof: input.proof ?? "0x1234",
    root: input.root ?? `0x${"bb".repeat(32)}`,
    nullifierHash: input.nullifierHash ?? SPONSOR_NULLIFIER,
    recipient: input.recipient ?? ADDRESS,
    relayer: input.relayer ?? TORNADO_PAYMASTER,
    fee: input.feeWei ?? ESTIMATED_PRIVATE_FEE_WEI,
    refund: input.refundWei ?? 0n,
  }]);
  return AbiParameters.encode(PAYMASTER_DATA_PARAMETERS, [{
    adapter: input.adapterAddress ?? TORNADO_ADAPTER,
    adapterData,
  }]);
}

type TestAccountCall = {
  target: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
};

function encodedBatch(calls: readonly TestAccountCall[]): `0x${string}` {
  return AbiFunction.encodeData(EXECUTE_BATCH, [[...calls]]);
}

function serializedUserOperation(
  callData: `0x${string}`,
  sender: `0x${string}` = ADDRESS,
) {
  return {
    sender,
    nonce: "0x0",
    callData,
    callGasLimit: "0x5208",
    verificationGasLimit: "0x186a0",
    preVerificationGas: "0xc350",
    maxFeePerGas: "0x77359400",
    maxPriorityFeePerGas: "0x3b9aca00",
    paymaster: TORNADO_PAYMASTER,
    paymasterVerificationGasLimit: "0xc350",
    paymasterPostOpGasLimit: "0xc350",
    paymasterData: tornadoPaymasterData({ recipient: sender }),
    signature: `0x${"44".repeat(65)}`,
    eip7702Auth: {
      address: SIMPLE_7702_IMPLEMENTATION,
      chainId: "0xaa36a7",
      nonce: "0x0",
      r: `0x${"55".repeat(32)}`,
      s: `0x${"66".repeat(32)}`,
      yParity: "0x0",
    },
  };
}

function exactUserOperationHash(
  operation: ReturnType<typeof serializedUserOperation>,
): string {
  const { eip7702Auth: _authorization, ...rpc } = operation;
  return UserOperation.hash(
    UserOperation.fromRpc(rpc as UserOperation.Rpc<"0.8">),
    {
      chainId: 11_155_111,
      entryPointAddress: ENTRY_POINT,
      entryPointVersion: "0.8",
    },
  );
}

function privatePreparation(input: {
  sender?: `0x${string}`;
  withdrawalAmountWei: bigint;
  calls: readonly TestAccountCall[];
  estimatedFeeWei?: bigint;
}): string {
  const sender = input.sender ?? ADDRESS;
  return JSON.stringify({
    mode: "prepare",
    protocol: "tornado",
    recipient: sender,
    token: "ETH",
    amountWei: input.withdrawalAmountWei.toString(),
    amountFormatted: "test",
    fees: {
      kind: "tornado-paymaster",
      estimatedMax: (input.estimatedFeeWei ?? ESTIMATED_PRIVATE_FEE_WEI).toString(),
      asset: "ETH",
    },
    privateOperation: {
      __type: "privateOperation",
      withdrawals: [{
        mode: "paymaster",
        proof: { proof: "0x1234", args: [] },
        poolAddress: BigInt(TORNADO_POOL).toString(),
        isERC20: false,
        paymasterAddress: TORNADO_PAYMASTER,
        entryPointAddress: ENTRY_POINT,
        bundlerUrl: "http://127.0.0.1:12345/v2/11155111/rpc",
        userOperation: serializedUserOperation(encodedBatch(input.calls), sender),
      }],
    },
  });
}

function privatePaymentPreparation(
  recipient: `0x${string}` = RECIPIENT,
  amountWei = 20_000_000_000_000_000n,
): string {
  const paddedFee = ESTIMATED_PRIVATE_FEE_WEI * 23n / 20n;
  return privatePreparation({
    withdrawalAmountWei: DEFAULT_SHIELD_WEI,
    calls: [
      {
        target: ADDRESS,
        data: "0x",
        value: DEFAULT_SHIELD_WEI - amountWei - paddedFee,
      },
      { target: recipient, data: "0x", value: amountWei },
    ],
  });
}

function privateRebalancePreparation(
  withdrawalAmountWei = DEFAULT_SHIELD_WEI * 2n,
  estimatedFeeWei = ESTIMATED_PRIVATE_FEE_WEI,
): string {
  const paddedFee = estimatedFeeWei * 23n / 20n;
  const directWithdraw = AbiFunction.encodeData(WITHDRAW, [
    "0x1234",
    `0x${"77".repeat(32)}`,
    `0x${"88".repeat(32)}`,
    ADDRESS,
    "0x0000000000000000000000000000000000000000",
    0n,
    0n,
  ]);
  return privatePreparation({
    withdrawalAmountWei,
    estimatedFeeWei,
    calls: [
      { target: TORNADO_POOL, data: directWithdraw, value: 0n },
      {
        target: ADDRESS,
        data: "0x",
        value: withdrawalAmountWei - DEFAULT_SHIELD_WEI - paddedFee,
      },
      {
        target: TORNADO_POOL,
        data: DEPOSIT_DATA,
        value: DEFAULT_SHIELD_WEI,
      },
    ],
  });
}

function userOperationFromPreparation(
  preparationStdout: string,
): ReturnType<typeof serializedUserOperation> {
  const preparation = JSON.parse(preparationStdout) as {
    privateOperation: { withdrawals: Array<{
      userOperation: ReturnType<typeof serializedUserOperation>;
    }> };
  };
  return preparation.privateOperation.withdrawals[0]!.userOperation;
}

function alterLastPreparedCall(
  operation: ReturnType<typeof serializedUserOperation>,
  replacement: Partial<TestAccountCall>,
): ReturnType<typeof serializedUserOperation> {
  const [calls] = AbiFunction.decodeData(EXECUTE_BATCH, operation.callData);
  assert.ok(calls.length > 0);
  return {
    ...operation,
    callData: encodedBatch(calls.map((call, index) => ({
      target: index === calls.length - 1 && replacement.target !== undefined
        ? replacement.target
        : call.target,
      value: index === calls.length - 1 && replacement.value !== undefined
        ? replacement.value
        : call.value,
      data: index === calls.length - 1 && replacement.data !== undefined
        ? replacement.data
        : call.data,
    }))),
  };
}

function alterPrivateChangeValue(
  operation: ReturnType<typeof serializedUserOperation>,
  deltaWei: bigint,
): ReturnType<typeof serializedUserOperation> {
  const [calls] = AbiFunction.decodeData(EXECUTE_BATCH, operation.callData);
  const changeIndex = calls.findIndex((call, index) =>
    index < calls.length - 1 &&
    call.target.toLowerCase() === operation.sender.toLowerCase() &&
    call.data === "0x" &&
    call.value > 0n
  );
  assert.notEqual(changeIndex, -1);
  const changedValue = calls[changeIndex]!.value + deltaWei;
  assert.ok(changedValue > 0n);
  return {
    ...operation,
    callData: encodedBatch(calls.map((call, index) => ({
      target: call.target,
      value: index === changeIndex ? changedValue : call.value,
      data: call.data,
    }))),
  };
}

function setPrivateFeeReserve(
  operation: ReturnType<typeof serializedUserOperation>,
  withdrawalAmountWei: bigint,
  feeReserveWei: bigint,
): ReturnType<typeof serializedUserOperation> {
  const [calls] = AbiFunction.decodeData(EXECUTE_BATCH, operation.callData);
  const currentReserveWei = withdrawalAmountWei - calls.reduce(
    (total, call) => total + call.value,
    0n,
  );
  return alterPrivateChangeValue(
    operation,
    currentReserveWei - feeReserveWei,
  );
}

function alterDirectWithdrawalProofAndRoot(
  operation: ReturnType<typeof serializedUserOperation>,
  replacementNullifierHash?: `0x${string}`,
): ReturnType<typeof serializedUserOperation> {
  const [calls] = AbiFunction.decodeData(EXECUTE_BATCH, operation.callData);
  const directIndex = calls.findIndex((call) =>
    call.data.slice(0, 10).toLowerCase() === "0x21a0adb6"
  );
  assert.notEqual(directIndex, -1);
  const directCall = calls[directIndex]!;
  const [, , nullifierHash, recipient, relayer, fee, refund] =
    AbiFunction.decodeData(WITHDRAW, directCall.data);
  const changedData = AbiFunction.encodeData(WITHDRAW, [
    "0xabcd",
    `0x${"99".repeat(32)}`,
    replacementNullifierHash ?? nullifierHash,
    recipient,
    relayer,
    fee,
    refund,
  ]);
  return {
    ...operation,
    callData: encodedBatch(calls.map((call, index) => ({
      target: call.target,
      value: call.value,
      data: index === directIndex ? changedData : call.data,
    }))),
  };
}

function alterDirectWithdrawalPool(
  operation: ReturnType<typeof serializedUserOperation>,
  poolAddress: `0x${string}`,
): ReturnType<typeof serializedUserOperation> {
  const [calls] = AbiFunction.decodeData(EXECUTE_BATCH, operation.callData);
  const directIndex = calls.findIndex((call) =>
    call.data.slice(0, 10).toLowerCase() === "0x21a0adb6"
  );
  assert.notEqual(directIndex, -1);
  return {
    ...operation,
    callData: encodedBatch(calls.map((call, index) => ({
      target: index === directIndex ? poolAddress : call.target,
      value: call.value,
      data: call.data,
    }))),
  };
}

function alterPaymasterSponsorship(
  operation: ReturnType<typeof serializedUserOperation>,
  replacement: {
    adapterAddress?: `0x${string}`;
    proof?: `0x${string}`;
    root?: `0x${string}`;
    nullifierHash?: `0x${string}`;
    recipient?: `0x${string}`;
    relayer?: `0x${string}`;
    feeWei?: bigint;
    refundWei?: bigint;
  },
): ReturnType<typeof serializedUserOperation> {
  const [{ adapter, adapterData }] = AbiParameters.decode(
    PAYMASTER_DATA_PARAMETERS,
    operation.paymasterData,
  );
  const [{ proof, root, nullifierHash, recipient, relayer, fee, refund }] =
    AbiParameters.decode(TORNADO_SPONSOR_PARAMETERS, adapterData);
  return {
    ...operation,
    paymasterData: tornadoPaymasterData({
      adapterAddress: replacement.adapterAddress ?? adapter,
      proof: replacement.proof ?? proof,
      root: replacement.root ?? root,
      nullifierHash: replacement.nullifierHash ?? nullifierHash,
      recipient: replacement.recipient ?? recipient,
      relayer: replacement.relayer ?? relayer,
      feeWei: replacement.feeWei ?? fee,
      refundWei: replacement.refundWei ?? refund,
    }),
  };
}

function appendTrailingPaymasterBytes(
  operation: ReturnType<typeof serializedUserOperation>,
  location: "outer" | "inner",
): ReturnType<typeof serializedUserOperation> {
  if (location === "outer") {
    return {
      ...operation,
      paymasterData: `${operation.paymasterData}00` as `0x${string}`,
    };
  }
  const [{ adapter, adapterData }] = AbiParameters.decode(
    PAYMASTER_DATA_PARAMETERS,
    operation.paymasterData,
  );
  return {
    ...operation,
    paymasterData: AbiParameters.encode(PAYMASTER_DATA_PARAMETERS, [{
      adapter,
      adapterData: `${adapterData}00` as `0x${string}`,
    }]),
  };
}

type UserOperationGasLimitKey =
  | "callGasLimit"
  | "verificationGasLimit"
  | "preVerificationGas"
  | "paymasterVerificationGasLimit"
  | "paymasterPostOpGasLimit";

function setUserOperationGasLimit(
  operation: ReturnType<typeof serializedUserOperation>,
  key: UserOperationGasLimitKey,
  value: bigint,
): ReturnType<typeof serializedUserOperation> {
  assert.ok(value > 0n);
  return {
    ...operation,
    [key]: `0x${value.toString(16)}`,
  };
}

function callPlanFromPreparation(preparationStdout: string) {
  const preparation = JSON.parse(preparationStdout) as {
    amountWei: string;
    privateOperation: { withdrawals: Array<{
      userOperation: ReturnType<typeof serializedUserOperation>;
    }> };
  };
  const operation = preparation.privateOperation.withdrawals[0]!.userOperation;
  const [calls] = AbiFunction.decodeData(EXECUTE_BATCH, operation.callData);
  const [{ adapter, adapterData }] = AbiParameters.decode(
    PAYMASTER_DATA_PARAMETERS,
    operation.paymasterData,
  );
  const [{ nullifierHash: sponsorNullifierHash }] = AbiParameters.decode(
    TORNADO_SPONSOR_PARAMETERS,
    adapterData,
  );
  const directWithdrawals = [];
  for (const call of calls) {
    if (call.data.slice(0, 10).toLowerCase() !== "0x21a0adb6") break;
    const [, , nullifierHash] = AbiFunction.decodeData(WITHDRAW, call.data);
    directWithdrawals.push({
      poolAddress: call.target.toLowerCase(),
      nullifierHash: nullifierHash.toLowerCase(),
    });
  }
  const tailCall = calls.at(-1)!;
  const withdrawalAmountWei = BigInt(preparation.amountWei);
  const availableFeeReserveWei = withdrawalAmountWei - tailCall.value;
  const maxFeeReserveWei = availableFeeReserveWei <
      MAX_PRIVATE_PAYMASTER_FEE_RESERVE_WEI
    ? availableFeeReserveWei
    : MAX_PRIVATE_PAYMASTER_FEE_RESERVE_WEI;
  return {
    version: 1,
    withdrawalAmountWei: preparation.amountWei,
    maxFeeReserveWei: maxFeeReserveWei.toString(),
    gasFloors: {
      callGasLimit: BigInt(operation.callGasLimit).toString(),
      verificationGasLimit: "1",
      preVerificationGas: "1",
      paymasterVerificationGasLimit: "1",
      paymasterPostOpGasLimit:
        BigInt(operation.paymasterPostOpGasLimit).toString(),
    },
    directWithdrawals,
    sponsor: {
      adapterAddress: adapter.toLowerCase(),
      nullifierHash: sponsorNullifierHash.toLowerCase(),
    },
    tailCall: {
      target: tailCall.target.toLowerCase(),
      data: tailCall.data.toLowerCase(),
      valueWei: tailCall.value.toString(),
    },
  };
}

function signedRawTransaction(input: {
  privateKey?: `0x${string}`;
  chainId?: number;
  nonce?: bigint;
  to?: `0x${string}`;
  valueWei?: bigint;
  data?: `0x${string}`;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
} = {}): `0x${string}` {
  const envelope = {
    type: "eip1559" as const,
    chainId: input.chainId ?? 11_155_111,
    nonce: input.nonce ?? 7n,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas ?? 1_000_000n,
    maxFeePerGas: input.maxFeePerGas ?? 2_000_000n,
    gas: input.gas ?? 21_000n,
    to: input.to ?? RECIPIENT,
    value: input.valueWei ?? 3n,
    data: input.data ?? "0x",
    accessList: [],
  };
  const signature = Secp256k1.sign({
    payload: TxEnvelopeEip1559.getSignPayload(envelope),
    privateKey: input.privateKey ?? RAW_TRANSACTION_PRIVATE_KEY,
  });
  return TxEnvelopeEip1559.serialize(
    TxEnvelopeEip1559.from(envelope, { signature }),
  ) as `0x${string}`;
}

function signedStandardRawTransaction(
  transactionType: "legacy" | "eip2930",
): `0x${string}` {
  const common = {
    chainId: 11_155_111,
    nonce: 7n,
    gasPrice: 2_000_000n,
    gas: 21_000n,
    to: RECIPIENT as `0x${string}`,
    value: 3n,
    data: "0x" as const,
  };
  if (transactionType === "legacy") {
    const envelope = { ...common, type: "legacy" as const };
    const signature = Secp256k1.sign({
      payload: TxEnvelopeLegacy.getSignPayload(envelope),
      privateKey: RAW_TRANSACTION_PRIVATE_KEY,
    });
    return TxEnvelopeLegacy.serialize(envelope, { signature }) as `0x${string}`;
  }
  const envelope = {
    ...common,
    type: "eip2930" as const,
    accessList: [],
  };
  const signature = Secp256k1.sign({
    payload: TxEnvelopeEip2930.getSignPayload(envelope),
    privateKey: RAW_TRANSACTION_PRIVATE_KEY,
  });
  return TxEnvelopeEip2930.serialize(envelope, { signature }) as `0x${string}`;
}

function rawTransactionHash(serialized: `0x${string}`): string {
  return Hash.keccak256(serialized);
}

async function runGuardedRawTransactionSend(input: {
  requestId: string;
  actualRawTransaction: `0x${string}`;
  expectedFrom?: string;
  expectedTo?: string;
  expectedValueWei?: string;
  expectedData?: string;
  expectedMaxGas?: string;
  expectedMaxFeeWei?: string;
  pendingNonce?: string;
  delegateFailure?: string;
  batchSend?: boolean;
}): Promise<{ result: CommandResult; journalPath: string }> {
  const runner = new SpawnCommandRunner({ defaultTimeoutMs: 5_000 });
  const root = await mkdtemp(join(tmpdir(), "agent-boost-raw-journal-guard-"));
  const journalDirectory = join(root, "journal");
  await mkdir(journalDirectory, { mode: 0o700 });
  const journalPath = join(
    journalDirectory,
    `${createHash("sha256").update(input.requestId).digest("hex")}.json`,
  );
  const allowedRpcUrl = `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`;
  const nonceBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getTransactionCount",
    params: [input.expectedFrom ?? RAW_TRANSACTION_SIGNER, "pending"],
  });
  const sendRequest = {
    jsonrpc: "2.0",
    id: 2,
    method: "eth_sendRawTransaction",
    params: [input.actualRawTransaction],
  };
  const sendBody = JSON.stringify(
    input.batchSend ? [sendRequest, { ...sendRequest, id: 3 }] : sendRequest,
  );
  const guard = new URL(
    "../src/kohaku/network-guard.mjs",
    import.meta.url,
  ).href;
  const script = [
    "const { existsSync } = await import('node:fs');",
    "globalThis.fetch = async (_input, init) => {",
    "  const body = JSON.parse(init.body);",
    "  if (body.method === 'eth_getTransactionCount') {",
    "    return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:process.env.TEST_PENDING_NONCE}), {status:200});",
    "  }",
    "  if (!existsSync(process.env.AGENT_BOOST_RAW_TRANSACTION_JOURNAL_PATH)) throw new Error('journal missing before delegate');",
    "  process.stdout.write('delegated');",
    "  if (process.env.TEST_DELEGATE_FAILURE) throw new Error(process.env.TEST_DELEGATE_FAILURE);",
    "  return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:'ok'}), {status:200});",
    "};",
    "await fetch(process.env.TEST_RPC_URL, {method:'POST',body:process.env.TEST_NONCE_BODY});",
    "await fetch(process.env.TEST_RPC_URL, {method:'POST',body:process.env.TEST_SEND_BODY})",
    "  .catch((error) => process.stdout.write(error.message));",
  ].join("\n");
  const result = await runner.run({
    executable: process.execPath,
    args: ["--input-type=module", "-e", script],
    env: {
      AGENT_BOOST_ALLOWED_RPC_URL: allowedRpcUrl,
      AGENT_BOOST_RAW_TRANSACTION_JOURNAL_PATH: journalPath,
      AGENT_BOOST_RAW_TRANSACTION_REQUEST_ID: input.requestId,
      AGENT_BOOST_RAW_TRANSACTION_EXPECTED_INTENT: JSON.stringify({
        version: 1,
        from: input.expectedFrom ?? RAW_TRANSACTION_SIGNER,
        to: input.expectedTo ?? RECIPIENT,
        valueWei: input.expectedValueWei ?? "3",
        data: input.expectedData ?? "0x",
        maxGas: input.expectedMaxGas ?? "100000",
        maxFeeWei: input.expectedMaxFeeWei ??
          REGULAR_TRANSFER_GAS_RESERVE_WEI.toString(),
      }),
      NODE_OPTIONS: `--import=${guard}`,
      TEST_RPC_URL: allowedRpcUrl,
      TEST_NONCE_BODY: nonceBody,
      TEST_SEND_BODY: sendBody,
      TEST_PENDING_NONCE: input.pendingNonce ?? "0x7",
      ...(input.delegateFailure
        ? { TEST_DELEGATE_FAILURE: input.delegateFailure }
        : {}),
    },
  });
  return { result, journalPath };
}

async function runGuardedWrongBroadcastMode(input: {
  mode: "none" | "private" | "raw";
  method: "eth_sendRawTransaction" | "eth_sendUserOperation";
}): Promise<{ result: CommandResult; journalPath: string }> {
  const runner = new SpawnCommandRunner({ defaultTimeoutMs: 5_000 });
  const root = await mkdtemp(join(tmpdir(), "agent-boost-wrong-mode-"));
  const journalDirectory = join(root, "journal");
  await mkdir(journalDirectory, { mode: 0o700 });
  const requestId = `req-${input.mode}-${input.method}`;
  const journalPath = join(
    journalDirectory,
    `${createHash("sha256").update(requestId).digest("hex")}.json`,
  );
  const allowedRpcUrl = `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`;
  const preparation = privatePaymentPreparation();
  const body = input.method === "eth_sendRawTransaction"
    ? JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: input.method,
        params: [signedRawTransaction()],
      })
    : JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: input.method,
        params: [userOperationFromPreparation(preparation), ENTRY_POINT],
      });
  const targetUrl = input.method === "eth_sendRawTransaction"
    ? allowedRpcUrl
    : "http://127.0.0.1:32123/v2/11155111/rpc";
  const guard = new URL("../src/kohaku/network-guard.mjs", import.meta.url).href;
  const script = [
    "globalThis.fetch = async () => { process.stdout.write('delegated'); return new Response('{}'); };",
    "await fetch(process.env.TEST_RPC_URL, {method:'POST',body:process.env.TEST_RPC_BODY})",
    "  .catch((error) => process.stdout.write(error.message));",
  ].join("\n");
  const privateEnv = input.mode === "private"
    ? {
        AGENT_BOOST_PRIVATE_BROADCAST_JOURNAL_PATH: journalPath,
        AGENT_BOOST_PRIVATE_BROADCAST_REQUEST_ID: requestId,
        AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_SENDER: ADDRESS,
        AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_CALL_PLAN:
          JSON.stringify(callPlanFromPreparation(preparation)),
      }
    : {};
  const rawEnv = input.mode === "raw"
    ? {
        AGENT_BOOST_RAW_TRANSACTION_JOURNAL_PATH: journalPath,
        AGENT_BOOST_RAW_TRANSACTION_REQUEST_ID: requestId,
        AGENT_BOOST_RAW_TRANSACTION_EXPECTED_INTENT: JSON.stringify({
          version: 1,
          from: RAW_TRANSACTION_SIGNER,
          to: RECIPIENT,
          valueWei: "3",
          data: "0x",
          maxGas: "100000",
          maxFeeWei: "1000000000000000",
        }),
      }
    : {};
  const result = await runner.run({
    executable: process.execPath,
    args: ["--input-type=module", "-e", script],
    env: {
      AGENT_BOOST_ALLOWED_RPC_URL: allowedRpcUrl,
      NODE_OPTIONS: `--import=${guard}`,
      TEST_RPC_URL: targetUrl,
      TEST_RPC_BODY: body,
      ...privateEnv,
      ...rawEnv,
    },
  });
  return { result, journalPath };
}

async function runGuardedPrivateSend(input: {
  requestId: string;
  preparation: string;
  actualOperation: ReturnType<typeof serializedUserOperation>;
}): Promise<{
  result: CommandResult;
  journalPath: string;
}> {
  const runner = new SpawnCommandRunner({ defaultTimeoutMs: 5_000 });
  const root = await mkdtemp(join(tmpdir(), "agent-boost-journal-guard-"));
  const journalDirectory = join(root, "journal");
  await mkdir(journalDirectory, { mode: 0o700 });
  const journalPath = join(
    journalDirectory,
    `${createHash("sha256").update(input.requestId).digest("hex")}.json`,
  );
  const rpcBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendUserOperation",
    params: [input.actualOperation, ENTRY_POINT],
  });
  const guard = new URL(
    "../src/kohaku/network-guard.mjs",
    import.meta.url,
  ).href;
  const script = [
    "const { existsSync } = await import('node:fs');",
    "globalThis.fetch = async () => {",
    "  if (!existsSync(process.env.AGENT_BOOST_PRIVATE_BROADCAST_JOURNAL_PATH)) throw new Error('journal missing before delegate');",
    "  process.stdout.write('delegated');",
    "  return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:'ok'}), {status:200});",
    "};",
    "await fetch('http://127.0.0.1:32123/v2/11155111/rpc', {method:'POST',body:process.env.TEST_RPC_BODY})",
    "  .catch((error) => process.stdout.write(error.message));",
  ].join("\n");
  const result = await runner.run({
    executable: process.execPath,
    args: ["--input-type=module", "-e", script],
    env: {
      AGENT_BOOST_ALLOWED_RPC_URL:
        `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`,
      AGENT_BOOST_PRIVATE_BROADCAST_JOURNAL_PATH: journalPath,
      AGENT_BOOST_PRIVATE_BROADCAST_REQUEST_ID: input.requestId,
      AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_SENDER: ADDRESS,
      AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_CALL_PLAN:
        JSON.stringify(callPlanFromPreparation(input.preparation)),
      NODE_OPTIONS: `--import=${guard}`,
      TEST_RPC_BODY: rpcBody,
    },
  });
  return { result, journalPath };
}

async function writeBroadcastJournal(
  invocation: CommandInvocation,
  preparationStdout: string,
): Promise<string> {
  const path = invocation.env?.AGENT_BOOST_PRIVATE_BROADCAST_JOURNAL_PATH;
  const requestId = invocation.env?.AGENT_BOOST_PRIVATE_BROADCAST_REQUEST_ID;
  const expectedSender =
    invocation.env?.AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_SENDER;
  const expectedCallPlan =
    invocation.env?.AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_CALL_PLAN;
  assert.equal(typeof path, "string");
  assert.equal(typeof requestId, "string");
  assert.equal(typeof expectedSender, "string");
  assert.equal(typeof expectedCallPlan, "string");
  const prepared = JSON.parse(preparationStdout) as {
    privateOperation: { withdrawals: Array<{
      userOperation: ReturnType<typeof serializedUserOperation>;
    }> };
  };
  const hash = exactUserOperationHash(
    prepared.privateOperation.withdrawals[0]!.userOperation,
  );
  assert.deepEqual(
    JSON.parse(expectedCallPlan!),
    callPlanFromPreparation(preparationStdout),
  );
  await writeFile(path!, `${JSON.stringify({
    version: 1,
    requestId,
    userOperationHash: hash,
    sender: expectedSender!.toLowerCase(),
    entryPointAddress: ENTRY_POINT.toLowerCase(),
    journaledAt: "2026-09-04T12:00:00.000Z",
  })}\n`, { mode: 0o600 });
  return hash;
}

async function writeRawTransactionBroadcastJournal(
  invocation: CommandInvocation,
  transactionHash = TX_HASH,
): Promise<void> {
  const path = invocation.env?.AGENT_BOOST_RAW_TRANSACTION_JOURNAL_PATH;
  const requestId = invocation.env?.AGENT_BOOST_RAW_TRANSACTION_REQUEST_ID;
  const expectedIntentRaw =
    invocation.env?.AGENT_BOOST_RAW_TRANSACTION_EXPECTED_INTENT;
  assert.equal(typeof path, "string");
  assert.equal(typeof requestId, "string");
  assert.equal(typeof expectedIntentRaw, "string");
  const expected = JSON.parse(expectedIntentRaw!) as {
    version: 1;
    from: string;
    to: string;
    valueWei: string;
    data: string;
    maxGas: string;
    maxFeeWei: string;
  };
  assert.equal(expected.version, 1);
  assert.equal(
    expected.maxFeeWei,
    (expected.data === "0x"
      ? REGULAR_TRANSFER_GAS_RESERVE_WEI
      : TORNADO_DEPOSIT_GAS_RESERVE_WEI).toString(),
  );
  await writeFile(path!, `${JSON.stringify({
    version: 1,
    requestId,
    transactionHash,
    from: expected.from,
    to: expected.to,
    valueWei: expected.valueWei,
    data: expected.data,
    chainId: 11_155_111,
    nonce: "0",
    gas: expected.data === "0x" ? "21000" : "1000000",
    transactionType: "eip1559",
    journaledAt: "2026-09-04T12:00:00.000Z",
  })}\n`, { mode: 0o600 });
}

function regularTransferPreparation(input: {
  sourceAddress?: string;
  recipient?: string;
  amountWei?: bigint;
  estimatedFeeWei?: bigint;
} = {}): string {
  const sourceAddress = input.sourceAddress ?? ADDRESS;
  const recipient = input.recipient ?? RECIPIENT;
  const amountWei = input.amountWei ?? 66_000_000_000_000_000_000n;
  return JSON.stringify({
    stealth: false,
    recipient,
    amount: amountWei.toString(),
    token: "eth",
    fees: {
      kind: "network-gas",
      estimatedMax: (input.estimatedFeeWei ??
        REGULAR_TRANSFER_GAS_RESERVE_WEI).toString(),
      asset: "ETH",
    },
    transactions: [{
      data: "0x",
      to: recipient,
      from: sourceAddress,
      value: amountWei.toString(),
    }],
  });
}

class FakeRunner implements CommandRunner {
  readonly calls: CommandInvocation[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    private readonly handler: (
      invocation: CommandInvocation,
    ) => Promise<CommandResult> | CommandResult,
  ) {}

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.calls.push(invocation);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.handler(invocation);
    } finally {
      this.active -= 1;
    }
  }
}

async function fixture(runner: CommandRunner): Promise<{
  adapter: KohakuWalletAdapter;
  dataDir: string;
  passwordFile: string;
  secret: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-kohaku-test-"));
  const dataDir = join(root, "kohaku");
  const passwordFile = join(root, "secrets", "password");
  const secret = "this-is-the-secret-not-the-path";
  await mkdir(join(root, "secrets"), { recursive: true, mode: 0o755 });
  await writeFile(passwordFile, secret, { mode: 0o644 });
  return {
    adapter: new KohakuWalletAdapter({
      dataDir,
      walletName: "agent-boost",
      passwordFile,
      rpcUrl: "https://sepolia.example.invalid/rpc-token",
      runner,
    }),
    dataDir,
    passwordFile,
    secret,
  };
}

function command(invocation: CommandInvocation): string {
  return invocation.args[0] ?? "";
}

function mainDepositDryRun(input: {
  executorAddress?: string;
  estimatedFeeWei?: bigint;
} = {}): string {
  const executorAddress = input.executorAddress ?? ADDRESS;
  const estimatedFeeWei = input.estimatedFeeWei ?? REGULAR_TRANSFER_GAS_RESERVE_WEI;
  return JSON.stringify({
    from: executorAddress,
    fees: {
      kind: "network-gas",
      estimatedMax: estimatedFeeWei.toString(),
      estimatedMaxFormatted: "test fixture",
      asset: "ETH",
    },
    transactions: [{
      data: DEPOSIT_DATA,
      to: TORNADO_POOL,
      from: executorAddress,
      value: DEFAULT_SHIELD_WEI.toString(),
    }],
  });
}

describe("KohakuWalletAdapter", () => {
  it("accepts only HTTPS or the authenticated Agent Boost loopback RPC relay", () => {
    const base = {
      dataDir: "/tmp/agent-boost-kohaku",
      walletName: "agent-boost",
      passwordFile: "/tmp/agent-boost-password",
    };
    assert.doesNotThrow(() => new KohakuWalletAdapter({
      ...base,
      rpcUrl: `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`,
    }));
    for (const rpcUrl of [
      `http://localhost:9185/rpc/${"a".repeat(43)}`,
      `http://127.0.0.1:9185/rpc/${"a".repeat(42)}`,
      "http://rpc.example.invalid",
    ]) {
      assert.throws(
        () => new KohakuWalletAdapter({ ...base, rpcUrl }),
        /HTTPS or an authenticated Agent Boost loopback relay/,
      );
    }
  });

  it("creates a Sepolia wallet idempotently and passes only the password path", async () => {
    let exists = false;
    const runner = new FakeRunner(async (invocation) => {
      if (command(invocation) === "list-wallets") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            wallets: exists ? { "agent-boost": { mainnet: false } } : {},
          }),
          stderr: "",
        };
      }
      if (command(invocation) === "create-wallet") {
        exists = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command(invocation)}`);
    });
    const { adapter, passwordFile, secret } = await fixture(runner);

    await adapter.ensureWallet();
    await adapter.ensureWallet();

    assert.equal(
      runner.calls.filter((call) => command(call) === "create-wallet").length,
      1,
    );
    const create = runner.calls.find((call) => command(call) === "create-wallet")!;
    const passwordIndex = create.args.indexOf("--password");
    assert.equal(create.args[passwordIndex + 1], passwordFile);
    assert.equal(create.args.includes(secret), false);
    assert.equal(create.args.includes("--testnet"), true);
    assert.equal(create.args.includes("--non-interactive"), true);
    assert.equal(create.args.includes("--rpc-url"), false);
    assert.equal(
      create.args.some((argument) => argument.includes("rpc-token")),
      false,
    );
    assert.equal(
      create.env?.RPC_URL,
      "https://sepolia.example.invalid/rpc-token",
    );
    assert.equal(create.env?.AGENT_BOOST_ALLOWED_RPC_URL, create.env?.RPC_URL);
    assert.match(create.env?.NODE_OPTIONS ?? "", /network-guard\.mjs/);
  });

  it("can select a fresh validated wallet profile for a new demo", async () => {
    const runner = new FakeRunner(async (invocation) => {
      if (command(invocation) === "list-wallets") {
        return { exitCode: 0, stdout: '{"wallets":{}}', stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const { adapter } = await fixture(runner);
    adapter.selectWallet("agent-boost-new-demo");
    await adapter.ensureWallet();
    const create = runner.calls.find((call) => command(call) === "create-wallet");
    assert.equal(create?.args[1], "agent-boost-new-demo");
    assert.throws(() => adapter.selectWallet("../escape"), /wallet name/);
  });

  it("redacts the live relay token from Kohaku's persistent traffic log", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-boost-kohaku-log-"));
    const dataDir = join(root, "kohaku");
    const passwordFile = join(root, "secrets", "password");
    const token = "a".repeat(43);
    await mkdir(join(root, "secrets"), { recursive: true });
    await writeFile(passwordFile, "password", { mode: 0o600 });
    const runner = new FakeRunner(async (invocation) => {
      if (command(invocation) === "list-wallets") {
        return { exitCode: 0, stdout: '{"wallets":{}}', stderr: "" };
      }
      await mkdir(join(dataDir, "agent-boost"), { recursive: true });
      await writeFile(
        join(dataDir, "agent-boost", "network-traffic.ndjson"),
        `${JSON.stringify({ url: `http://127.0.0.1:9185/rpc/${token}` })}\n`,
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const adapter = new KohakuWalletAdapter({
      dataDir,
      walletName: "agent-boost",
      passwordFile,
      rpcUrl: `http://127.0.0.1:9185/rpc/${token}`,
      runner,
    });
    await adapter.ensureWallet();
    const log = await readFile(
      join(dataDir, "agent-boost", "network-traffic.ndjson"),
      "utf8",
    );
    assert.doesNotMatch(log, new RegExp(token, "u"));
    assert.match(log, /<redacted>/);
  });

  it("hardens wallet directories to 0700 and files to 0600", async () => {
    let dataDir = "";
    const runner = new FakeRunner(async (invocation) => {
      if (command(invocation) === "list-wallets") {
        return { exitCode: 0, stdout: '{"wallets":{}}', stderr: "" };
      }
      if (command(invocation) === "create-wallet") {
        const walletDir = join(dataDir, "agent-boost");
        await mkdir(walletDir, { recursive: true, mode: 0o755 });
        await writeFile(join(walletDir, "wallet.json"), "encrypted", {
          mode: 0o644,
        });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command(invocation)}`);
    });
    const created = await fixture(runner);
    dataDir = created.dataDir;

    await created.adapter.ensureWallet();

    assert.equal((await stat(created.dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(created.passwordFile)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(created.dataDir, "agent-boost"))).mode & 0o777,
      0o700,
    );
    assert.equal(
      (await stat(join(created.dataDir, "agent-boost", "wallet.json"))).mode &
        0o777,
      0o600,
    );
  });

  it("repairs the exact Tor guard-state corruption and retries a balances read once", async () => {
    let balanceAttempts = 0;
    const runner = new FakeRunner((invocation) => {
      if (command(invocation) === "clear-tor-cache") {
        return { exitCode: 0, stdout: "cleared\n", stderr: "" };
      }
      assert.equal(command(invocation), "balances");
      balanceAttempts += 1;
      if (balanceAttempts === 1) {
        return {
          exitCode: 1,
          stdout: TOR_GUARD_STATE_CORRUPTION_OUTPUT,
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          public_balances_aggregated: [{
            symbol: "ETH",
            raw_token_holdings: "300000000000000000",
          }],
          private_balances: {
            tornado: [{
              symbol: "ETH",
              raw_token_holdings: DEFAULT_SHIELD_WEI.toString(),
              status: "spendable",
            }],
          },
        }),
        stderr: "",
      };
    });
    const { adapter, dataDir } = await fixture(runner);

    assert.deepEqual(await adapter.getBalanceSnapshot(), {
      publicBalanceWei: 300_000_000_000_000_000n,
      privateBalanceWei: DEFAULT_SHIELD_WEI,
    });
    assert.deepEqual(
      runner.calls.map(command),
      ["balances", "clear-tor-cache", "balances"],
    );
    assert.deepEqual(runner.calls[1]?.args, [
      "clear-tor-cache",
      "--dataDir",
      dataDir,
      "--non-interactive",
    ]);
    assert.equal(runner.calls[1]?.env, undefined);
    assert.deepEqual(runner.calls[2]?.args, runner.calls[0]?.args);
    assert.deepEqual(runner.calls[2]?.env, runner.calls[0]?.env);
    assert.equal(
      runner.calls.every((invocation) =>
        !invocation.args.includes("--without-tor")
      ),
      true,
    );
    assert.equal(
      runner.calls[2]?.env?.AGENT_BOOST_ALLOWED_RPC_URL,
      "https://sepolia.example.invalid/rpc-token",
    );
    assert.match(runner.calls[2]?.env?.NODE_OPTIONS ?? "", /network-guard\.mjs/u);
  });

  it("recovers a non-consuming fresh-address peek but preserves its no-RPC boundary", async () => {
    let peekAttempts = 0;
    const runner = new FakeRunner((invocation) => {
      if (command(invocation) === "clear-tor-cache") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      assert.equal(command(invocation), "next-fresh-address");
      assert.equal(invocation.args.includes("--peek"), true);
      peekAttempts += 1;
      return peekAttempts === 1
        ? {
            exitCode: 1,
            stdout: TOR_GUARD_STATE_CORRUPTION_OUTPUT,
            stderr: "",
          }
        : { exitCode: 0, stdout: `${ADDRESS}\n`, stderr: "" };
    });
    const { adapter } = await fixture(runner);

    assert.equal(
      await adapter.peekNextFreshAddressForWallet("agent-boost"),
      ADDRESS,
    );
    assert.deepEqual(
      runner.calls.map(command),
      ["next-fresh-address", "clear-tor-cache", "next-fresh-address"],
    );
    assert.equal(runner.calls.every((invocation) => invocation.env === undefined), true);
  });

  it("makes only one Tor cache recovery attempt and never leaks command output", async () => {
    const privateOutput = "wallet-secret-and-private-diagnostic";
    let balanceAttempts = 0;
    const runner = new FakeRunner((invocation) => {
      if (command(invocation) === "clear-tor-cache") {
        return { exitCode: 0, stdout: "cleared\n", stderr: "" };
      }
      assert.equal(command(invocation), "balances");
      balanceAttempts += 1;
      return {
        exitCode: balanceAttempts === 1 ? 17 : 23,
        stdout: `${TOR_GUARD_STATE_CORRUPTION_OUTPUT}${privateOutput}\n`,
        stderr: `${privateOutput}-stderr`,
      };
    });
    const { adapter } = await fixture(runner);

    await assert.rejects(adapter.getBalanceSnapshot(), (error: unknown) => {
      const rendered = String(error);
      assert.match(rendered, /balances failed with exit code 23/u);
      assert.doesNotMatch(
        rendered,
        /wallet-secret|private-diagnostic|corrupted data|clear-tor-cache/u,
      );
      return true;
    });
    assert.deepEqual(
      runner.calls.map(command),
      ["balances", "clear-tor-cache", "balances"],
    );
    assert.equal(
      runner.calls.filter((invocation) =>
        command(invocation) === "clear-tor-cache"
      ).length,
      1,
    );
  });

  it("does not retry the read when clearing the Tor cache fails", async () => {
    const runner = new FakeRunner((invocation) => {
      if (command(invocation) === "clear-tor-cache") {
        return {
          exitCode: 29,
          stdout: "clear-cache-private-output",
          stderr: "clear-cache-secret",
        };
      }
      assert.equal(command(invocation), "balances");
      return {
        exitCode: 19,
        stdout: TOR_GUARD_STATE_CORRUPTION_OUTPUT,
        stderr: "",
      };
    });
    const { adapter } = await fixture(runner);

    await assert.rejects(adapter.getBalanceSnapshot(), (error: unknown) => {
      assert.match(String(error), /balances failed with exit code 19/u);
      assert.doesNotMatch(String(error), /private-output|secret/u);
      return true;
    });
    assert.deepEqual(
      runner.calls.map(command),
      ["balances", "clear-tor-cache"],
    );
  });

  it("ignores unrelated and near-match Tor failures", async () => {
    const unrelatedOutputs = [
      `${TOR_GUARD_STATE_CORRUPTION_LINE}\n`,
      `${TOR_CACHE_RECOVERY_HINT}\n`,
      `Bootstrap failed: tor: corrupted data in persistent state: Error setting up a guard manager\n${TOR_CACHE_RECOVERY_HINT}\n`,
      `prefix: ${TOR_GUARD_STATE_CORRUPTION_LINE}\n${TOR_CACHE_RECOVERY_HINT}\n`,
      `${TOR_CACHE_RECOVERY_HINT}\n${TOR_GUARD_STATE_CORRUPTION_LINE}\n`,
      `${TOR_GUARD_STATE_CORRUPTION_LINE}\nunrelated detail\n${TOR_CACHE_RECOVERY_HINT}\n`,
    ];

    for (const stdout of unrelatedOutputs) {
      const runner = new FakeRunner(() => ({
        exitCode: 31,
        stdout,
        stderr: "unrelated-private-output",
      }));
      const { adapter } = await fixture(runner);
      await assert.rejects(adapter.getBalanceSnapshot(), (error: unknown) => {
        assert.match(String(error), /balances failed with exit code 31/u);
        assert.doesNotMatch(String(error), /unrelated-private-output/u);
        return true;
      });
      assert.deepEqual(runner.calls.map(command), ["balances"]);
    }

    const splitRunner = new FakeRunner(() => ({
      exitCode: 31,
      stdout: `${TOR_GUARD_STATE_CORRUPTION_LINE}\n`,
      stderr: `${TOR_CACHE_RECOVERY_HINT}\n`,
    }));
    const splitFixture = await fixture(splitRunner);
    await assert.rejects(
      splitFixture.adapter.getBalanceSnapshot(),
      /balances failed with exit code 31/u,
    );
    assert.deepEqual(splitRunner.calls.map(command), ["balances"]);
  });

  it("never retries stateful non-broadcast commands after Tor corruption", async () => {
    const addressRunner = new FakeRunner(() => ({
      exitCode: 37,
      stdout: TOR_GUARD_STATE_CORRUPTION_OUTPUT,
      stderr: "address-state-private-output",
    }));
    const addressFixture = await fixture(addressRunner);
    await assert.rejects(
      addressFixture.adapter.nextFreshAddress(),
      /next-fresh-address failed with exit code 37/u,
    );
    assert.deepEqual(addressRunner.calls.map(command), ["next-fresh-address"]);
    assert.equal(addressRunner.calls[0]?.args.includes("--peek"), false);

    let checkpointCalls = 0;
    const transferRunner = new FakeRunner(() => ({
      exitCode: 41,
      stdout: TOR_GUARD_STATE_CORRUPTION_OUTPUT,
      stderr: "transfer-private-output",
    }));
    const transferFixture = await fixture(transferRunner);
    await assert.rejects(
      transferFixture.adapter.executeRegularTransfer({
        sourceAddress: ADDRESS,
        recipient: RECIPIENT,
        amountWei: 3n,
        broadcastRequestId: "req-tor-dry-run-no-retry",
        beforeBroadcast: async () => {
          checkpointCalls += 1;
        },
      }),
      /transfer failed with exit code 41/u,
    );
    assert.equal(checkpointCalls, 0);
    assert.deepEqual(transferRunner.calls.map(command), ["transfer"]);
    assert.equal(transferRunner.calls[0]?.args.includes("--broadcast"), false);
  });

  it("never clears or retries after a broadcast invocation has started", async () => {
    let checkpointCalls = 0;
    const runner = new FakeRunner((invocation) => {
      assert.equal(command(invocation), "transfer");
      if (!invocation.args.includes("--broadcast")) {
        return {
          exitCode: 0,
          stdout: regularTransferPreparation({ amountWei: 3n }),
          stderr: "",
        };
      }
      return {
        exitCode: 43,
        stdout: TOR_GUARD_STATE_CORRUPTION_OUTPUT,
        stderr: "broadcast-private-output",
      };
    });
    const { adapter } = await fixture(runner);

    await assert.rejects(
      adapter.executeRegularTransfer({
        sourceAddress: ADDRESS,
        recipient: RECIPIENT,
        amountWei: 3n,
        broadcastRequestId: "req-tor-broadcast-no-retry",
        beforeBroadcast: async () => {
          checkpointCalls += 1;
        },
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.match(String(error), /transfer failed with exit code 43/u);
        assert.doesNotMatch(
          String(error),
          /broadcast-private-output|corrupted data|clear-tor-cache/u,
        );
        return true;
      },
    );
    assert.equal(checkpointCalls, 1);
    assert.deepEqual(runner.calls.map(command), ["transfer", "transfer"]);
    assert.equal(runner.calls[1]?.args.includes("--broadcast"), true);
    assert.equal(
      runner.calls.some((invocation) =>
        command(invocation) === "clear-tor-cache"
      ),
      false,
    );
  });

  it("prewarms only Tornado artifacts and uses a persisted fresh address", async () => {
    const runner = new FakeRunner((invocation) => {
      if (command(invocation) === "next-fresh-address") {
        return { exitCode: 0, stdout: `${ADDRESS}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    });
    const { adapter } = await fixture(runner);

    await adapter.prewarmPrivacy();
    assert.equal(await adapter.nextFreshAddress(), ADDRESS);

    const prewarm = runner.calls.find((call) => command(call) === "fetch-artifacts")!;
    assert.equal(prewarm.args.includes("--tornado"), true);
    assert.equal(prewarm.args.includes("--without-tor"), false);
    const fresh = runner.calls.find(
      (call) => command(call) === "next-fresh-address",
    )!;
    assert.equal(fresh.args.includes("--peek"), false);
    assert.equal(fresh.args.includes("--rpc-url"), false);
  });

  it("uses explicit backend names for ensure, sync, and non-consuming address peeks", async () => {
    const runner = new FakeRunner((invocation) => {
      if (command(invocation) === "list-wallets") {
        return {
          exitCode: 0,
          stdout: '{"wallets":{"pocket-two":{"mainnet":false}}}',
          stderr: "",
        };
      }
      if (command(invocation) === "balances") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            public_balances_aggregated: [],
            private_balances: {
              tornado: [{
                symbol: "ETH",
                raw_token_holdings: DEFAULT_SHIELD_WEI.toString(),
                status: "spendable",
              }],
            },
          }),
          stderr: "",
        };
      }
      if (command(invocation) === "next-fresh-address") {
        return { exitCode: 0, stdout: ADDRESS, stderr: "" };
      }
      throw new Error(`Unexpected command: ${command(invocation)}`);
    });
    const { adapter } = await fixture(runner);

    await adapter.ensureBackendWallet("pocket-two");
    assert.equal(await adapter.syncBackendWallet("pocket-two"), DEFAULT_SHIELD_WEI);
    assert.equal(
      await adapter.getPrivateBalanceWeiForWallet("pocket-two"),
      DEFAULT_SHIELD_WEI,
    );
    assert.equal(
      await adapter.peekNextFreshAddressForWallet("pocket-two"),
      ADDRESS,
    );

    const namedCalls = runner.calls.filter((call) =>
      ["balances", "next-fresh-address"].includes(command(call))
    );
    assert.equal(
      namedCalls.every((call) => call.args[call.args.indexOf("--wallet") + 1] === "pocket-two"),
      true,
    );
    const peek = namedCalls.find(
      (call) => command(call) === "next-fresh-address",
    );
    assert.equal(peek?.args.includes("--peek"), true);
    assert.throws(
      () => adapter.ensureBackendWallet("../pocket"),
      /wallet name/,
    );
  });

  it("recovers the exact private change account across persisted and crash paths", async () => {
    const persistedRunner = new FakeRunner((invocation) => {
      assert.equal(command(invocation), "balances");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          public_account_indexes_by_address: { [ADDRESS]: 2 },
        }),
        stderr: "",
      };
    });
    const persisted = await fixture(persistedRunner);
    await persisted.adapter.ensurePrivateChangeAccount("pocket-two", ADDRESS);
    assert.equal(persistedRunner.calls.length, 1);

    const crashRunner = new FakeRunner((invocation) => {
      if (command(invocation) === "balances") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ public_account_indexes_by_address: {} }),
          stderr: "",
        };
      }
      assert.equal(command(invocation), "next-fresh-address");
      return { exitCode: 0, stdout: ADDRESS, stderr: "" };
    });
    const crashed = await fixture(crashRunner);
    await crashed.adapter.ensurePrivateChangeAccount("pocket-two", ADDRESS);
    assert.deepEqual(
      crashRunner.calls.map((call) => [
        command(call),
        call.args.includes("--peek"),
      ]),
      [["balances", false], ["next-fresh-address", true], ["next-fresh-address", false]],
    );

    const mismatchRunner = new FakeRunner((invocation) => {
      if (command(invocation) === "balances") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ public_account_indexes_by_address: {} }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: RECIPIENT, stderr: "" };
    });
    const mismatch = await fixture(mismatchRunner);
    await assert.rejects(
      mismatch.adapter.ensurePrivateChangeAccount("pocket-two", ADDRESS),
      /exact next-address evidence/,
    );
    assert.equal(mismatchRunner.calls.length, 2);
    assert.equal(mismatchRunner.calls[1]?.args.includes("--peek"), true);
  });

  it("prepares exactly one pinned Tornado deposit without broadcasting", async () => {
    const runner = new FakeRunner((invocation) => {
      assert.equal(command(invocation), "shield");
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          fees: {
            kind: "network-gas",
            estimatedMax: "0",
            estimatedMaxFormatted: "0 ETH",
            asset: "ETH",
          },
          transactions: [{
            to: TORNADO_POOL,
            data: DEPOSIT_DATA,
            from: ADDRESS,
            value: DEFAULT_SHIELD_WEI.toString(),
          }],
        })}\n`,
        stderr: "",
      };
    });
    const { adapter, passwordFile } = await fixture(runner);

    assert.deepEqual(
      await adapter.prepareTornadoEthDeposit({
        targetWalletName: "pocket-two",
        executorAddress: ADDRESS,
        amountWei: DEFAULT_SHIELD_WEI,
      }),
      {
        targetCommitment: COMMITMENT,
        preparedDepositCall: DEPOSIT_CALL,
      },
    );

    assert.deepEqual(runner.calls[0]?.args, [
      "shield",
      "--wallet", "pocket-two",
      "--password", passwordFile,
      "--dataDir", runner.calls[0]?.args[6]!,
      "--non-interactive",
      "--protocol", "tornado",
      "--from", ADDRESS,
      "--amount-wei", DEFAULT_SHIELD_WEI.toString(),
      "--skip-sim",
    ]);
    assert.equal(runner.calls[0]?.args.includes("--broadcast"), false);
  });

  it("rejects malformed shield output and deposit-call injection", async () => {
    const malformedOutputs = [
      {
        transactions: [{
          to: RECIPIENT,
          data: DEPOSIT_DATA,
          from: ADDRESS,
          value: DEFAULT_SHIELD_WEI.toString(),
        }],
      },
      {
        transactions: [{
          to: TORNADO_POOL,
          data: `0xdeadbeef${COMMITMENT.slice(2)}`,
          from: ADDRESS,
          value: DEFAULT_SHIELD_WEI.toString(),
        }],
      },
      {
        transactions: [{
          to: TORNADO_POOL,
          data: DEPOSIT_DATA,
          from: RECIPIENT,
          value: DEFAULT_SHIELD_WEI.toString(),
        }],
      },
      {
        transactions: [{
          to: TORNADO_POOL,
          data: DEPOSIT_DATA,
          from: ADDRESS,
          value: DEFAULT_SHIELD_WEI.toString(),
          injected: true,
        }],
      },
    ];

    for (const payload of malformedOutputs) {
      const runner = new FakeRunner(() => ({
        exitCode: 0,
        stdout: JSON.stringify(payload),
        stderr: "",
      }));
      const { adapter } = await fixture(runner);
      await assert.rejects(
        adapter.prepareTornadoEthDeposit({
          targetWalletName: "pocket-two",
          executorAddress: ADDRESS,
          amountWei: DEFAULT_SHIELD_WEI,
        }),
        /Kohaku|Tornado|unexpected|unapproved|deposit/,
      );
    }

    const runner = new FakeRunner(() => ({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    }));
    const { adapter } = await fixture(runner);
    await assert.rejects(
      adapter.prepareTornadoEthDeposit({
        targetWalletName: "pocket,two",
        executorAddress: ADDRESS,
        amountWei: DEFAULT_SHIELD_WEI,
      }),
      /wallet name/,
    );
    await assert.rejects(
      adapter.prepareTornadoEthDeposit({
        targetWalletName: "pocket-two",
        executorAddress: `${ADDRESS},${RECIPIENT}`,
        amountWei: DEFAULT_SHIELD_WEI,
      }),
      /executor/,
    );
    await assert.rejects(
      adapter.prepareTornadoEthDeposit({
        targetWalletName: "pocket-two",
        executorAddress: ADDRESS,
        amountWei: DEFAULT_SHIELD_WEI * 2n,
      }),
      /pinned.*denomination/,
    );
    assert.equal(runner.calls.length, 0);
  });

  it("parses only spendable Tornado ETH and serializes commands per wallet", async () => {
    const runner = new FakeRunner(async (invocation) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (command(invocation) === "balances") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            public_balances_aggregated: [
              {
                symbol: "ETH",
                raw_token_holdings: "300000000000000000",
              },
            ],
            private_balances: {
              tornado: [
                {
                  symbol: "ETH",
                  raw_token_holdings: "100000000000000000",
                  status: "spendable",
                },
                {
                  symbol: "ETH (pending)",
                  raw_token_holdings: "200000000000000000",
                  status: "pending",
                },
                {
                  symbol: "DAI",
                  raw_token_holdings: "999",
                  status: "spendable",
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      if (command(invocation) === "next-fresh-address") {
        return { exitCode: 0, stdout: ADDRESS, stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    });
    const { adapter } = await fixture(runner);

    const [balances, address] = await Promise.all([
      adapter.getBalanceSnapshot(),
      adapter.nextFreshAddress(),
      adapter.prewarmPrivacy(),
    ]);

    assert.deepEqual(balances, {
      publicBalanceWei: 300_000_000_000_000_000n,
      privateBalanceWei: 100_000_000_000_000_000n,
    });
    const balanceCall = runner.calls.find((call) => command(call) === "balances")!;
    assert.equal(balanceCall.args.includes("--skip-stealth-scan"), false);
    assert.equal(address, ADDRESS);
    assert.equal(runner.maxActive, 1);
  });

  it("journals an exact onboarding shield then pays via unshield --next", async () => {
    const preparedPayment = privatePaymentPreparation();
    const runner = new FakeRunner(async (invocation) => {
      if (command(invocation) === "shield") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            transactions: [{
              to: TORNADO_POOL,
              data: DEPOSIT_DATA,
              from: ADDRESS,
              value: DEFAULT_SHIELD_WEI.toString(),
            }],
          }),
          stderr: "",
        };
      }
      if (command(invocation) === "transact-raw") {
        if (!invocation.args.includes("--broadcast")) {
          return { exitCode: 0, stdout: mainDepositDryRun(), stderr: "" };
        }
        await writeRawTransactionBroadcastJournal(invocation);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command(invocation) === "unshield") {
        if (!invocation.args.includes("--broadcast")) {
          return { exitCode: 0, stdout: preparedPayment, stderr: "" };
        }
        const userOperationHash = await writeBroadcastJournal(
          invocation,
          preparedPayment,
        );
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            explorerHash: userOperationHash,
            relay: { userOpHash: userOperationHash },
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${command(invocation)}`);
    });
    const { adapter } = await fixture(runner);
    let shieldCheckpointCalls = 0;

    assert.deepEqual(
      await adapter.shieldWei(DEFAULT_SHIELD_WEI, {
        sourceAddress: ADDRESS,
        broadcastRequestId: "onboarding-shield:test-setup",
        beforeBroadcast: async (preparedDepositCall) => {
          shieldCheckpointCalls += 1;
          assert.deepEqual(preparedDepositCall, DEPOSIT_CALL);
        },
      }),
      { transactionHash: TX_HASH },
    );
    assert.equal(shieldCheckpointCalls, 1);
    assert.deepEqual(
      await adapter.executePrivatePayment({
        recipient: RECIPIENT,
        amountWei: 20_000_000_000_000_000n,
        broadcastRequestId: "req-private-payment",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      { userOperationHash: exactUserOperationHash(
        serializedUserOperation(encodedBatch([
          {
            target: ADDRESS,
            data: "0x",
            value: 78_850_000_000_000_000n,
          },
          {
            target: RECIPIENT,
            data: "0x",
            value: 20_000_000_000_000_000n,
          },
        ])),
      ) },
    );

    const shield = runner.calls.find((call) => command(call) === "shield")!;
    assert.equal(shield.args.includes("--rpc-url"), false);
    assert.equal(shield.env?.RPC_URL, "https://sepolia.example.invalid/rpc-token");
    assert.equal(shield.args.includes("--broadcast"), false);
    assert.equal(shield.args.includes("--skip-sim"), true);
    assert.deepEqual(
      shield.args.slice(shield.args.indexOf("--amount-wei"), shield.args.indexOf("--amount-wei") + 2),
      ["--amount-wei", "100000000000000000"],
    );
    const shieldBroadcast = runner.calls.find(
      (call) => command(call) === "transact-raw" && call.args.includes("--broadcast"),
    )!;
    assert.equal(
      shieldBroadcast.env?.AGENT_BOOST_RAW_TRANSACTION_REQUEST_ID,
      "onboarding-shield:test-setup",
    );
    assert.deepEqual(
      shieldBroadcast.args.slice(shieldBroadcast.args.indexOf("--targets")),
      [
        "--targets", TORNADO_POOL,
        "--payloads", DEPOSIT_DATA,
        "--values", DEFAULT_SHIELD_WEI.toString(),
        "--broadcast",
      ],
    );
    const unshield = runner.calls.find(
      (call) => command(call) === "unshield" && call.args.includes("--broadcast"),
    )!;
    assert.equal(unshield.args.includes("--next"), true);
    assert.equal(unshield.args.includes("--broadcast"), true);
    assert.equal(
      unshield.args[unshield.args.indexOf("--tail-calls") + 1],
      `${RECIPIENT}:0x:20000000000000000`,
    );
    assert.equal(
      unshield.args[unshield.args.indexOf("--amount-wei") + 1],
      "100000000000000000",
    );
  });

  it("accepts the live and ceiling Tornado deposit fee quotes", async (t) => {
    for (const [label, estimatedFeeWei] of [
      ["observed-live", OBSERVED_LIVE_TORNADO_DEPOSIT_FEE_WEI],
      ["exact-cap", TORNADO_DEPOSIT_GAS_RESERVE_WEI],
    ] as const) {
      await t.test(label, async () => {
        let checkpointCalls = 0;
        const runner = new FakeRunner(async (invocation) => {
          if (command(invocation) === "shield") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                transactions: [{
                  to: TORNADO_POOL,
                  data: DEPOSIT_DATA,
                  from: ADDRESS,
                  value: DEFAULT_SHIELD_WEI.toString(),
                }],
              }),
              stderr: "",
            };
          }
          assert.equal(command(invocation), "transact-raw");
          if (!invocation.args.includes("--broadcast")) {
            return {
              exitCode: 0,
              stdout: mainDepositDryRun({ estimatedFeeWei }),
              stderr: "",
            };
          }
          await writeRawTransactionBroadcastJournal(invocation);
          return {
            exitCode: 0,
            stdout: JSON.stringify({ transactions: [{ hash: TX_HASH }] }),
            stderr: "",
          };
        });
        const { adapter } = await fixture(runner);

        assert.deepEqual(
          await adapter.shieldWei(DEFAULT_SHIELD_WEI, {
            sourceAddress: ADDRESS,
            broadcastRequestId: `onboarding-shield:${label}`,
            beforeBroadcast: async () => {
              checkpointCalls += 1;
            },
          }),
          { transactionHash: TX_HASH },
        );
        assert.equal(checkpointCalls, 1);
        assert.equal(
          runner.calls.filter((call) => call.args.includes("--broadcast")).length,
          1,
        );
        const expectedIntent = JSON.parse(
          runner.calls.at(-1)?.env?.AGENT_BOOST_RAW_TRANSACTION_EXPECTED_INTENT ?? "null",
        ) as { maxFeeWei?: string } | null;
        assert.equal(
          expectedIntent?.maxFeeWei,
          TORNADO_DEPOSIT_GAS_RESERVE_WEI.toString(),
        );
      });
    }
  });

  it("rejects zero and over-cap Tornado deposit quotes before checkpoint or broadcast", async (t) => {
    for (const [label, estimatedFeeWei] of [
      ["zero", 0n],
      ["cap-plus-one", TORNADO_DEPOSIT_GAS_RESERVE_WEI + 1n],
    ] as const) {
      await t.test(label, async () => {
        let checkpointCalls = 0;
        const runner = new FakeRunner((invocation) => {
          if (command(invocation) === "shield") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                transactions: [{
                  to: TORNADO_POOL,
                  data: DEPOSIT_DATA,
                  from: ADDRESS,
                  value: DEFAULT_SHIELD_WEI.toString(),
                }],
              }),
              stderr: "",
            };
          }
          if (invocation.args.includes("--broadcast")) {
            throw new Error("unexpected broadcast");
          }
          return {
            exitCode: 0,
            stdout: mainDepositDryRun({ estimatedFeeWei }),
            stderr: "",
          };
        });
        const { adapter } = await fixture(runner);

        await assert.rejects(
          adapter.shieldWei(DEFAULT_SHIELD_WEI, {
            sourceAddress: ADDRESS,
            broadcastRequestId: `onboarding-shield:invalid-${label}`,
            beforeBroadcast: async () => {
              checkpointCalls += 1;
            },
          }),
          (error: unknown) => {
            assert.equal(error instanceof WalletExecutionError, true);
            assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
            assert.match(String(error), /invalid fee quote/u);
            return true;
          },
        );
        assert.equal(checkpointCalls, 0);
        assert.equal(
          runner.calls.some((call) => call.args.includes("--broadcast")),
          false,
        );
      });
    }
  });

  it("reuses a durable onboarding shield preparation after a pre-network failure", async () => {
    const runner = new FakeRunner(async (invocation) => {
      if (command(invocation) === "shield") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            transactions: [{
              to: TORNADO_POOL,
              data: DEPOSIT_DATA,
              from: ADDRESS,
              value: DEFAULT_SHIELD_WEI.toString(),
            }],
          }),
          stderr: "",
        };
      }
      if (!invocation.args.includes("--broadcast")) {
        return { exitCode: 0, stdout: mainDepositDryRun(), stderr: "" };
      }
      await writeRawTransactionBroadcastJournal(invocation);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const { adapter } = await fixture(runner);
    let durableCall:
      | { to: string; data: string; valueWei: string }
      | undefined;
    const request = {
      sourceAddress: ADDRESS,
      broadcastRequestId: "onboarding-shield:stable-retry",
    };

    await assert.rejects(
      adapter.shieldWei(DEFAULT_SHIELD_WEI, {
        ...request,
        beforeBroadcast: async (preparedDepositCall) => {
          durableCall = preparedDepositCall;
          throw new Error("state write interrupted before network handoff");
        },
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
        return true;
      },
    );
    assert.deepEqual(durableCall, DEPOSIT_CALL);

    assert.deepEqual(
      await adapter.shieldWei(DEFAULT_SHIELD_WEI, {
        ...request,
        preparedDepositCall: durableCall,
        beforeBroadcast: async (preparedDepositCall) => {
          assert.deepEqual(preparedDepositCall, durableCall);
        },
      }),
      { transactionHash: TX_HASH },
    );
    assert.equal(
      runner.calls.filter((invocation) => command(invocation) === "shield").length,
      1,
    );
    assert.equal(
      runner.calls.filter((invocation) => command(invocation) === "transact-raw")
        .length,
      3,
    );
  });

  it("rejects a private dry-run that changes the exact recipient tail call", async () => {
    let checkpointCalls = 0;
    const runner = new FakeRunner(() => ({
      exitCode: 0,
      stdout: privatePaymentPreparation(ADDRESS),
      stderr: "",
    }));
    const { adapter } = await fixture(runner);

    await assert.rejects(
      adapter.executePrivatePayment({
        recipient: RECIPIENT,
        amountWei: 20_000_000_000_000_000n,
        broadcastRequestId: "req-tampered-private-tail",
        beforeBroadcast: async () => {
          checkpointCalls += 1;
        },
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
        assert.match(String(error), /requested tail call/);
        return true;
      },
    );
    assert.equal(checkpointCalls, 0);
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0]?.args.includes("--broadcast"), false);
  });

  it("rejects malformed or over-budget prepared sponsorship before broadcast", async (t) => {
    const cases: Array<[
      string,
      Parameters<typeof alterPaymasterSponsorship>[1],
    ]> = [
      ["adapter", { adapterAddress: OTHER_ADDRESS }],
      ["nullifier", { nullifierHash: `0x${"00".repeat(32)}` }],
      ["recipient", { recipient: OTHER_ADDRESS }],
      ["relayer", { relayer: OTHER_ADDRESS }],
      ["refund", { refundWei: 1n }],
      ["zero-fee", { feeWei: 0n }],
      [
        "fee",
        { feeWei: ESTIMATED_PRIVATE_FEE_WEI * 23n / 20n + 1n },
      ],
    ];
    for (const [label, replacement] of cases) {
      await t.test(label, async () => {
        const preparation = JSON.parse(privatePaymentPreparation()) as {
          privateOperation: { withdrawals: Array<{
            userOperation: ReturnType<typeof serializedUserOperation>;
          }> };
        };
        const withdrawal = preparation.privateOperation.withdrawals[0]!;
        withdrawal.userOperation = alterPaymasterSponsorship(
          withdrawal.userOperation,
          replacement,
        );
        let checkpointCalls = 0;
        const runner = new FakeRunner(() => ({
          exitCode: 0,
          stdout: JSON.stringify(preparation),
          stderr: "",
        }));
        const { adapter } = await fixture(runner);

        await assert.rejects(
          adapter.executePrivatePayment({
            recipient: RECIPIENT,
            amountWei: 20_000_000_000_000_000n,
            broadcastRequestId: `req-tampered-prepared-sponsor-${label}`,
            beforeBroadcast: async () => {
              checkpointCalls += 1;
            },
          }),
          (error: unknown) => {
            assert.equal(error instanceof WalletExecutionError, true);
            assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
            assert.match(String(error), /sponsor|sponsorship/u);
            return true;
          },
        );
        assert.equal(checkpointCalls, 0);
        assert.equal(runner.calls.length, 1);
        assert.equal(runner.calls[0]?.args.includes("--broadcast"), false);
      });
    }
  });

  it("preflights and journals recovery from an explicitly named pocket", async () => {
    const preparedRecovery = privatePaymentPreparation();
    let exactHash = "";
    const runner = new FakeRunner(async (invocation) => {
      if (!invocation.args.includes("--broadcast")) {
        return { exitCode: 0, stdout: preparedRecovery, stderr: "" };
      }
      exactHash = await writeBroadcastJournal(invocation, preparedRecovery);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ relay: { userOpHash: exactHash } }),
        stderr: "",
      };
    });
    const { adapter } = await fixture(runner);

    assert.deepEqual(
      await adapter.executeRecoveryTransferFromWallet("recovery-pocket", {
        recipient: RECIPIENT,
        amountWei: 20_000_000_000_000_000n,
        broadcastRequestId: "req-private-recovery",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      { userOperationHash: exactHash },
    );
    assert.equal(runner.calls.length, 2);
    assert.equal(
      runner.calls.every((call) =>
        call.args[call.args.indexOf("--wallet") + 1] === "recovery-pocket"
      ),
      true,
    );
  });

  it("executes only the exact allowlisted prepared deposit from a named main account", async () => {
    const runner = new FakeRunner(async (invocation) => {
      assert.equal(command(invocation), "transact-raw");
      if (!invocation.args.includes("--broadcast")) {
        return {
          exitCode: 0,
          stdout: mainDepositDryRun(),
          stderr: "",
        };
      }
      await writeRawTransactionBroadcastJournal(invocation);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          from: ADDRESS,
          transactions: [{ index: 0, hash: TX_HASH }],
        }),
        stderr: "",
      };
    });
    const { adapter } = await fixture(runner);

    assert.deepEqual(
      await adapter.executePreparedMainDeposit({
        sourceWalletName: "source-main",
        sourceExecutorAddress: ADDRESS,
        preparedDepositCall: DEPOSIT_CALL,
        broadcastRequestId: "req-main-deposit-exact",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      { transactionHash: TX_HASH },
    );

    assert.equal(runner.calls.length, 2);
    for (const [index, call] of runner.calls.entries()) {
      assert.equal(call.args[call.args.indexOf("--wallet") + 1], "source-main");
      assert.deepEqual(
        call.args.slice(call.args.indexOf("--from")),
        [
          "--from", ADDRESS,
          "--targets", TORNADO_POOL,
          "--payloads", DEPOSIT_DATA,
          "--values", DEFAULT_SHIELD_WEI.toString(),
          ...(index === 1 ? ["--broadcast"] : []),
        ],
      );
    }
  });

  it("syncs a target backend through the path that discovers its just-deposited note", async () => {
    let deposited = false;
    const runner = new FakeRunner(async (invocation) => {
      if (command(invocation) === "shield") {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            fees: {
              kind: "network-gas",
              estimatedMax: "0",
              estimatedMaxFormatted: "0 ETH",
              asset: "ETH",
            },
            transactions: [{
              data: DEPOSIT_DATA,
              to: TORNADO_POOL,
              from: ADDRESS,
              value: DEFAULT_SHIELD_WEI.toString(),
            }],
          })}\n`,
          stderr: "",
        };
      }
      if (command(invocation) === "transact-raw") {
        if (!invocation.args.includes("--broadcast")) {
          return {
            exitCode: 0,
            stdout: mainDepositDryRun(),
            stderr: "",
          };
        }
        await writeRawTransactionBroadcastJournal(invocation);
        deposited = true;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ transactions: [{ hash: TX_HASH }] }),
          stderr: "",
        };
      }
      if (command(invocation) === "balances") {
        assert.equal(deposited, true);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            public_balances_aggregated: [],
            private_balances: {
              tornado: [{
                symbol: "ETH",
                raw_token_holdings: DEFAULT_SHIELD_WEI.toString(),
                status: "spendable",
              }],
            },
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${command(invocation)}`);
    });
    const { adapter } = await fixture(runner);

    const prepared = await adapter.prepareTornadoEthDeposit({
      targetWalletName: "target-pocket",
      executorAddress: ADDRESS,
      amountWei: DEFAULT_SHIELD_WEI,
    });
    await adapter.executePreparedMainDeposit({
      sourceWalletName: "source-main",
      sourceExecutorAddress: ADDRESS,
      preparedDepositCall: prepared.preparedDepositCall,
      broadcastRequestId: "req-main-deposit-sync",
      beforeBroadcast: CHECKPOINT_BROADCAST,
    });
    assert.equal(
      await adapter.syncBackendWallet("target-pocket"),
      DEFAULT_SHIELD_WEI,
    );

    const balanceCall = runner.calls.find(
      (call) => command(call) === "balances",
    )!;
    assert.equal(
      balanceCall.args[balanceCall.args.indexOf("--wallet") + 1],
      "target-pocket",
    );
    assert.deepEqual(
      balanceCall.args.slice(balanceCall.args.indexOf("--include")),
      ["--include", "tornado"],
    );
  });

  it("rejects arbitrary prepared-call targets, calldata, values, and fields", async () => {
    const runner = new FakeRunner(() => ({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    }));
    const { adapter } = await fixture(runner);
    const invalidCalls = [
      { ...DEPOSIT_CALL, to: RECIPIENT },
      { ...DEPOSIT_CALL, data: `${DEPOSIT_DATA},${RECIPIENT}:0x:1` },
      { ...DEPOSIT_CALL, data: `0xa9059cbb${"00".repeat(32)}` },
      { ...DEPOSIT_CALL, valueWei: "1" },
      { ...DEPOSIT_CALL, unexpected: "call" },
    ];

    for (const preparedDepositCall of invalidCalls) {
      await assert.rejects(
        adapter.executePreparedMainDeposit({
          sourceWalletName: "source-main",
          sourceExecutorAddress: ADDRESS,
          preparedDepositCall,
          broadcastRequestId: "req-invalid-main-deposit-call",
          beforeBroadcast: CHECKPOINT_BROADCAST,
        }),
        /deposit|pool|calldata|denomination|unexpected/,
      );
    }
    await assert.rejects(
      adapter.executePreparedMainDeposit({
        sourceWalletName: "source-main",
        sourceExecutorAddress: "0",
        preparedDepositCall: DEPOSIT_CALL,
        broadcastRequestId: "req-invalid-main-executor",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
        assert.match(String(error), /executor/);
        return true;
      },
    );
    await assert.rejects(
      adapter.executePreparedMainDeposit({
        sourceWalletName: "source-main;$(touch /tmp/agent-boost-injected)",
        sourceExecutorAddress: ADDRESS,
        preparedDepositCall: DEPOSIT_CALL,
        broadcastRequestId: "req-invalid-main-wallet",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      /wallet name/,
    );
    await assert.rejects(
      adapter.executePreparedMainDeposit({
        sourceWalletName: "source-main",
        sourceExecutorAddress: "$(malicious-executor)",
        preparedDepositCall: DEPOSIT_CALL,
        broadcastRequestId: "req-malicious-main-executor",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      /executor/,
    );
    assert.equal(runner.calls.length, 0);
  });

  it("preflights then broadcasts a full-note private rebalance with the exact tail call", async () => {
    const withdrawalAmountWei = DEFAULT_SHIELD_WEI * 2n;
    const preparedRebalance = privateRebalancePreparation(withdrawalAmountWei);
    let exactHash = "";
    const runner = new FakeRunner(async (invocation) => {
      if (command(invocation) === "next-fresh-address") {
        return { exitCode: 0, stdout: ADDRESS, stderr: "" };
      }
      if (command(invocation) === "unshield") {
        if (!invocation.args.includes("--broadcast")) {
          return {
            exitCode: 0,
            stdout: preparedRebalance,
            stderr: "",
          };
        }
        exactHash = await writeBroadcastJournal(invocation, preparedRebalance);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            mode: "broadcast",
            protocol: "tornado",
            relay: { userOpHash: exactHash },
            receipt: { transactionHash: TX_HASH },
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${command(invocation)}`);
    });
    const { adapter } = await fixture(runner);

    assert.deepEqual(
      await adapter.executePrivateRebalance({
        sourceWalletName: "source-pocket",
        sourceExecutorAddress: ADDRESS,
        withdrawalAmountWei,
        preparedDepositCall: DEPOSIT_CALL,
        broadcastRequestId: "req-private-rebalance",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      {
        transactionHash: TX_HASH,
        userOperationHash: exactHash,
      },
    );

    assert.deepEqual(
      runner.calls.map((call) => command(call)),
      ["next-fresh-address", "unshield", "unshield"],
    );
    assert.equal(runner.calls[0]?.args.includes("--peek"), true);
    const [prepare, broadcast] = runner.calls.slice(1);
    assert.equal(prepare?.args.includes("--broadcast"), false);
    assert.equal(broadcast?.args.at(-1), "--broadcast");
    for (const invocation of [prepare!, broadcast!]) {
      assert.equal(
        invocation.args[invocation.args.indexOf("--wallet") + 1],
        "source-pocket",
      );
      assert.equal(
        invocation.args[invocation.args.indexOf("--amount-wei") + 1],
        withdrawalAmountWei.toString(),
      );
      assert.equal(
        invocation.args[invocation.args.indexOf("--tail-calls") + 1],
        `${TORNADO_POOL}:${DEPOSIT_DATA}:${DEFAULT_SHIELD_WEI.toString()}`,
      );
    }
  });

  it("rejects one-note and underquoted private rebalances before broadcast", async () => {
    const noCallRunner = new FakeRunner(() => ({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    }));
    const noCallFixture = await fixture(noCallRunner);
    await assert.rejects(
      noCallFixture.adapter.executePrivateRebalance({
        sourceWalletName: "source-pocket",
        sourceExecutorAddress: ADDRESS,
        withdrawalAmountWei: DEFAULT_SHIELD_WEI,
        preparedDepositCall: DEPOSIT_CALL,
        broadcastRequestId: "req-one-note-rebalance",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
        assert.match(String(error), /additional full denomination.*paymaster fee/);
        return true;
      },
    );
    assert.equal(noCallRunner.calls.length, 0);

    const withdrawalAmountWei = DEFAULT_SHIELD_WEI * 2n;
    const underquotedPayload = JSON.parse(
      privateRebalancePreparation(withdrawalAmountWei),
    ) as { fees: { estimatedMax: string } };
    underquotedPayload.fees.estimatedMax = DEFAULT_SHIELD_WEI.toString();
    const underquoted = new FakeRunner((invocation) => {
      if (command(invocation) === "next-fresh-address") {
        return { exitCode: 0, stdout: ADDRESS, stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(underquotedPayload),
        stderr: "",
      };
    });
    const underquotedFixture = await fixture(underquoted);
    await assert.rejects(
      underquotedFixture.adapter.executePrivateRebalance({
        sourceWalletName: "source-pocket",
        sourceExecutorAddress: ADDRESS,
        withdrawalAmountWei,
        preparedDepositCall: DEPOSIT_CALL,
        broadcastRequestId: "req-underquoted-rebalance",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
        assert.match(String(error), /insufficient.*padded paymaster fee/);
        return true;
      },
    );
    assert.equal(
      underquoted.calls.some((call) => call.args.includes("--broadcast")),
      false,
    );
  });

  it("rejects a stale plan-bound rebalance executor before preparing or broadcasting", async () => {
    const runner = new FakeRunner((invocation) => {
      assert.equal(command(invocation), "next-fresh-address");
      return { exitCode: 0, stdout: RECIPIENT, stderr: "" };
    });
    const { adapter } = await fixture(runner);

    await assert.rejects(
      adapter.executePrivateRebalance({
        sourceWalletName: "source-pocket",
        sourceExecutorAddress: ADDRESS,
        withdrawalAmountWei: DEFAULT_SHIELD_WEI * 2n,
        preparedDepositCall: DEPOSIT_CALL,
        broadcastRequestId: "req-stale-rebalance",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
        assert.match(String(error), /plan is stale.*executor changed/);
        return true;
      },
    );
    assert.deepEqual(
      runner.calls.map((call) => command(call)),
      ["next-fresh-address"],
    );
  });

  it("marks main-deposit dry-run failures as definitely pre-broadcast", async () => {
    const runner = new FakeRunner(() => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ...JSON.parse(mainDepositDryRun()),
        transactions: [{
          data: DEPOSIT_DATA,
          to: RECIPIENT,
          from: ADDRESS,
          value: DEFAULT_SHIELD_WEI.toString(),
        }],
      }),
      stderr: "",
    }));
    const { adapter } = await fixture(runner);

    await assert.rejects(
      adapter.executePreparedMainDeposit({
        sourceWalletName: "source-main",
        sourceExecutorAddress: ADDRESS,
        preparedDepositCall: DEPOSIT_CALL,
        broadcastRequestId: "req-main-deposit-dry-failure",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
        return true;
      },
    );
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0]?.args.includes("--broadcast"), false);
  });

  it("marks failures after invoking either broadcast command as indeterminate", async () => {
    const mainRunner = new FakeRunner(async (invocation) => {
      if (!invocation.args.includes("--broadcast")) {
        return {
          exitCode: 0,
          stdout: mainDepositDryRun(),
          stderr: "",
        };
      }
      await writeRawTransactionBroadcastJournal(invocation);
      return {
        exitCode: 0,
        stdout: "not-json-after-send",
        stderr: "",
      };
    });
    const mainFixture = await fixture(mainRunner);
    await assert.rejects(
      mainFixture.adapter.executePreparedMainDeposit({
        sourceWalletName: "source-main",
        sourceExecutorAddress: ADDRESS,
        preparedDepositCall: DEPOSIT_CALL,
        broadcastRequestId: "req-main-deposit-broadcast-failure",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, true);
        return true;
      },
    );
    assert.equal(mainRunner.calls[0]?.args.includes("--broadcast"), false);
    assert.equal(mainRunner.calls[1]?.args.includes("--broadcast"), true);

    const withdrawalAmountWei = DEFAULT_SHIELD_WEI * 2n;
    const preparedRebalance = privateRebalancePreparation(withdrawalAmountWei);
    const privateRunner = new FakeRunner(async (invocation) => {
      if (command(invocation) === "next-fresh-address") {
        return { exitCode: 0, stdout: ADDRESS, stderr: "" };
      }
      if (!invocation.args.includes("--broadcast")) {
        return {
          exitCode: 0,
          stdout: preparedRebalance,
          stderr: "",
        };
      }
      await writeBroadcastJournal(invocation, preparedRebalance);
      return { exitCode: 2, stdout: "", stderr: "private diagnostic" };
    });
    const privateFixture = await fixture(privateRunner);
    await assert.rejects(
      privateFixture.adapter.executePrivateRebalance({
        sourceWalletName: "source-pocket",
        sourceExecutorAddress: ADDRESS,
        withdrawalAmountWei,
        preparedDepositCall: DEPOSIT_CALL,
        broadcastRequestId: "req-failing-rebalance",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, true);
        assert.doesNotMatch(String(error), /private diagnostic/);
        return true;
      },
    );
    assert.equal(
      privateRunner.calls.at(-1)?.args.includes("--broadcast"),
      true,
    );
  });

  it("classifies a semantic guard rejection with no journal as definitely pre-broadcast", async () => {
    const preparedPayment = privatePaymentPreparation();
    const runner = new FakeRunner(async (invocation) => {
      if (!invocation.args.includes("--broadcast")) {
        return { exitCode: 0, stdout: preparedPayment, stderr: "" };
      }
      return {
        exitCode: 2,
        stdout: "",
        stderr:
          "Agent Boost rejected UserOperation callData that changed after the approved dry run",
      };
    });
    const { adapter } = await fixture(runner);

    await assert.rejects(
      adapter.executePrivatePayment({
        recipient: RECIPIENT,
        amountWei: 20_000_000_000_000_000n,
        broadcastRequestId: "req-definite-pre-send-failure",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal(
          (error as WalletExecutionError).code,
          "KOHAKU_PREBROADCAST_FAILED",
        );
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
        return true;
      },
    );
    assert.equal(runner.calls.length, 2);
    assert.equal(
      await adapter.getPrivateBroadcastCheckpoint(
        "req-definite-pre-send-failure",
      ),
      undefined,
    );
  });

  it("recovers the exact UserOperation when Kohaku loses broadcast stdout", async () => {
    const preparedPayment = privatePaymentPreparation();
    let exactHash = "";
    const runner = new FakeRunner(async (invocation) => {
      if (!invocation.args.includes("--broadcast")) {
        return { exitCode: 0, stdout: preparedPayment, stderr: "" };
      }
      exactHash = await writeBroadcastJournal(invocation, preparedPayment);
      return { exitCode: 0, stdout: "{}", stderr: "" };
    });
    const { adapter } = await fixture(runner);
    const execute = () => adapter.executePrivatePayment({
      recipient: RECIPIENT,
      amountWei: 20_000_000_000_000_000n,
      broadcastRequestId: "req-missing-private-stdout",
      beforeBroadcast: CHECKPOINT_BROADCAST,
    });

    assert.deepEqual(await execute(), { userOperationHash: exactHash });
    await assert.rejects(execute(), (error: unknown) => {
      assert.equal(error instanceof WalletExecutionError, true);
      assert.equal((error as WalletExecutionError).mayHaveBroadcast, true);
      assert.match(String(error), /already has a durable UserOperation/);
      return true;
    });
    assert.equal(runner.calls.length, 2);
  });

  it("keeps user-operation and transaction identifiers distinct", async () => {
    const transactionHash = `0x${"ef".repeat(32)}`;
    const preparedPayment = privatePaymentPreparation();
    let userOperationHash = "";
    const runner = new FakeRunner(async (invocation) => {
      if (!invocation.args.includes("--broadcast")) {
        return { exitCode: 0, stdout: preparedPayment, stderr: "" };
      }
      userOperationHash = await writeBroadcastJournal(
        invocation,
        preparedPayment,
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          explorerHash: userOperationHash,
          relay: { userOpHash: userOperationHash },
          receipt: { transactionHash },
        }),
        stderr: "",
      };
    });
    const { adapter } = await fixture(runner);

    assert.deepEqual(
      await adapter.executePrivatePayment({
        recipient: RECIPIENT,
        amountWei: 20_000_000_000_000_000n,
        broadcastRequestId: "req-distinct-identifiers",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      { transactionHash, userOperationHash },
    );
    assert.deepEqual(
      await adapter.getPrivateBroadcastCheckpoint("req-distinct-identifiers"),
      {
        version: 1,
        requestId: "req-distinct-identifiers",
        userOperationHash,
        sender: ADDRESS,
        entryPointAddress: ENTRY_POINT.toLowerCase(),
        journaledAt: "2026-09-04T12:00:00.000Z",
      },
    );
    const journalPath = runner.calls.at(-1)?.env
      ?.AGENT_BOOST_PRIVATE_BROADCAST_JOURNAL_PATH;
    assert.equal(typeof journalPath, "string");
    assert.equal((await stat(journalPath!)).mode & 0o777, 0o600);
  });

  it("executes a regular ETH transfer from the selected main account", async () => {
    const runner = new FakeRunner(async (invocation) => {
      assert.equal(command(invocation), "transfer");
      if (!invocation.args.includes("--broadcast")) {
        return {
          exitCode: 0,
          stdout: regularTransferPreparation(),
          stderr: "",
        };
      }
      await writeRawTransactionBroadcastJournal(invocation);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ hashes: [TX_HASH] }),
        stderr: "",
      };
    });
    const { adapter, passwordFile } = await fixture(runner);

    assert.deepEqual(
      await adapter.executeRegularTransfer({
        sourceAddress: ADDRESS,
        recipient: RECIPIENT,
        amountWei: 66_000_000_000_000_000_000n,
        broadcastRequestId: "req-main-regular-transfer",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      { transactionHash: TX_HASH },
    );

    assert.equal(runner.calls.length, 2);
    const transfer = runner.calls[1]!;
    assert.deepEqual(
      transfer.args,
      [
        "transfer",
        "--wallet", "agent-boost",
        "--password", passwordFile,
        "--dataDir", transfer.args[6]!,
        "--non-interactive",
        "--from", "0",
        "--to", RECIPIENT,
        "--token", "eth",
        "--amount-wei", "66000000000000000000",
        "--broadcast",
      ],
    );
    assert.equal(transfer.env?.RPC_URL, "https://sepolia.example.invalid/rpc-token");
    assert.equal(transfer.args.includes("--without-tor"), false);
    assert.equal(runner.calls[0]?.args.includes("--broadcast"), false);
  });

  it("keeps the regular-transfer fee ceiling at its original reserve", async () => {
    let checkpointCalls = 0;
    const runner = new FakeRunner((invocation) => {
      if (invocation.args.includes("--broadcast")) {
        throw new Error("unexpected broadcast");
      }
      return {
        exitCode: 0,
        stdout: regularTransferPreparation({
          amountWei: 3n,
          estimatedFeeWei: REGULAR_TRANSFER_GAS_RESERVE_WEI + 1n,
        }),
        stderr: "",
      };
    });
    const { adapter } = await fixture(runner);

    await assert.rejects(
      adapter.executeRegularTransfer({
        sourceAddress: ADDRESS,
        recipient: RECIPIENT,
        amountWei: 3n,
        broadcastRequestId: "req-regular-fee-cap-unchanged",
        beforeBroadcast: async () => {
          checkpointCalls += 1;
        },
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
        assert.match(String(error), /invalid fee quote/u);
        return true;
      },
    );
    assert.equal(checkpointCalls, 0);
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0]?.args.includes("--broadcast"), false);
  });

  it("recovers a journaled regular transaction with no stdout and refuses rebroadcast", async () => {
    const runner = new FakeRunner(async (invocation) => {
      if (!invocation.args.includes("--broadcast")) {
        return {
          exitCode: 0,
          stdout: regularTransferPreparation({ amountWei: 3n }),
          stderr: "",
        };
      }
      await writeRawTransactionBroadcastJournal(invocation);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const { adapter } = await fixture(runner);
    const execute = () => adapter.executeRegularTransfer({
      sourceAddress: ADDRESS,
      recipient: RECIPIENT,
      amountWei: 3n,
      broadcastRequestId: "rreq-missing-raw-stdout",
      beforeBroadcast: CHECKPOINT_BROADCAST,
    });

    assert.deepEqual(await execute(), { transactionHash: TX_HASH });
    await assert.rejects(execute(), (error: unknown) => {
      assert.equal(error instanceof WalletExecutionError, true);
      assert.equal((error as WalletExecutionError).mayHaveBroadcast, true);
      assert.match(String(error), /already has a durable checkpoint/u);
      return true;
    });
    assert.equal(runner.calls.length, 2);
    assert.deepEqual(
      await adapter.getRawTransactionBroadcastCheckpoint(
        "rreq-missing-raw-stdout",
      ),
      {
        version: 1,
        requestId: "rreq-missing-raw-stdout",
        transactionHash: TX_HASH,
        from: ADDRESS,
        to: RECIPIENT,
        valueWei: "3",
        data: "0x",
        chainId: 11_155_111,
        nonce: "0",
        gas: "21000",
        transactionType: "eip1559",
        journaledAt: "2026-09-04T12:00:00.000Z",
      },
    );
  });

  it("preflights a regular transfer from an exact pocket change account", async () => {
    let checkpointCalls = 0;
    const runner = new FakeRunner(async (invocation) => {
      if (!invocation.args.includes("--broadcast")) {
        return {
          exitCode: 0,
          stdout: regularTransferPreparation({
            sourceAddress: ADDRESS,
            amountWei: 3n,
          }),
          stderr: "",
        };
      }
      await writeRawTransactionBroadcastJournal(invocation);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ transactionHash: TX_HASH }),
        stderr: "",
      };
    });
    const { adapter } = await fixture(runner);

    assert.deepEqual(
      await adapter.executeRegularTransferFromWallet("pocket-two", {
        sourceAddress: ADDRESS,
        recipient: RECIPIENT,
        amountWei: 3n,
        broadcastRequestId: "req-pocket-regular-transfer",
        beforeBroadcast: async () => {
          checkpointCalls += 1;
        },
      }),
      { transactionHash: TX_HASH },
    );
    assert.equal(checkpointCalls, 1);
    assert.equal(runner.calls.length, 2);
    for (const invocation of runner.calls) {
      assert.equal(
        invocation.args[invocation.args.indexOf("--wallet") + 1],
        "pocket-two",
      );
      assert.equal(
        invocation.args[invocation.args.indexOf("--from") + 1],
        ADDRESS,
      );
    }

    const tampered = new FakeRunner(() => ({
      exitCode: 0,
      stdout: regularTransferPreparation({
        sourceAddress: OTHER_ADDRESS,
        amountWei: 3n,
      }),
      stderr: "",
    }));
    const tamperedFixture = await fixture(tampered);
    await assert.rejects(
      tamperedFixture.adapter.executeRegularTransferFromWallet("pocket-two", {
        sourceAddress: ADDRESS,
        recipient: RECIPIENT,
        amountWei: 3n,
        broadcastRequestId: "req-pocket-regular-tampered",
        beforeBroadcast: async () => {
          checkpointCalls += 1;
        },
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
        assert.match(String(error), /changed the exact transfer/);
        return true;
      },
    );
    assert.equal(checkpointCalls, 1);
    assert.equal(tampered.calls.length, 1);
  });

  it("classifies regular-transfer failures around the broadcast boundary", async () => {
    let checkpointCalls = 0;
    const dryRunFailure = new FakeRunner(() => ({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    }));
    const dryRunFixture = await fixture(dryRunFailure);
    await assert.rejects(
      dryRunFixture.adapter.executeRegularTransfer({
        sourceAddress: ADDRESS,
        recipient: RECIPIENT,
        amountWei: 3n,
        broadcastRequestId: "req-regular-dry-run-failure",
        beforeBroadcast: async () => {
          checkpointCalls += 1;
        },
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
        return true;
      },
    );
    assert.equal(checkpointCalls, 0);
    assert.equal(dryRunFailure.calls.length, 1);

    const guardRejection = new FakeRunner((invocation) =>
      invocation.args.includes("--broadcast")
        ? { exitCode: 2, stdout: "", stderr: "semantic guard rejection" }
        : {
            exitCode: 0,
            stdout: regularTransferPreparation({ amountWei: 3n }),
            stderr: "",
          }
    );
    const guardRejectionFixture = await fixture(guardRejection);
    await assert.rejects(
      guardRejectionFixture.adapter.executeRegularTransfer({
        sourceAddress: ADDRESS,
        recipient: RECIPIENT,
        amountWei: 3n,
        broadcastRequestId: "req-regular-guard-rejection",
        beforeBroadcast: async () => {
          checkpointCalls += 1;
        },
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, false);
        return true;
      },
    );
    assert.equal(checkpointCalls, 1);

    const broadcastFailure = new FakeRunner(async (invocation) => {
      if (!invocation.args.includes("--broadcast")) {
        return {
          exitCode: 0,
          stdout: regularTransferPreparation({ amountWei: 3n }),
          stderr: "",
        };
      }
      await writeRawTransactionBroadcastJournal(invocation);
      return { exitCode: 2, stdout: "", stderr: "after launch" };
    });
    const broadcastFixture = await fixture(broadcastFailure);
    await assert.rejects(
      broadcastFixture.adapter.executeRegularTransfer({
        sourceAddress: ADDRESS,
        recipient: RECIPIENT,
        amountWei: 3n,
        broadcastRequestId: "req-regular-broadcast-failure",
        beforeBroadcast: async () => {
          checkpointCalls += 1;
        },
      }),
      (error: unknown) => {
        assert.equal(error instanceof WalletExecutionError, true);
        assert.equal((error as WalletExecutionError).mayHaveBroadcast, true);
        return true;
      },
    );
    assert.equal(checkpointCalls, 2);
    assert.equal(broadcastFailure.calls.length, 2);
  });

  it("rejects invalid recipients and payment values before running Kohaku", async () => {
    const runner = new FakeRunner(() => ({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    }));
    const { adapter } = await fixture(runner);

    await assert.rejects(
      adapter.executePrivatePayment({
        recipient: "not-an-address",
        amountWei: 1n,
        broadcastRequestId: "req-invalid-recipient",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      /Ethereum address/,
    );
    await assert.rejects(
      adapter.executePrivatePayment({
        recipient: RECIPIENT,
        amountWei: 0n,
        broadcastRequestId: "req-zero-payment",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      /positive/,
    );
    await assert.rejects(
      adapter.executePrivatePayment({
        recipient: RECIPIENT,
        amountWei: 100_000_000_000_000_000n,
        broadcastRequestId: "req-oversized-payment",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      /smaller than the Tornado withdrawal/,
    );
    await assert.rejects(
      adapter.executeRegularTransfer({
        sourceAddress: ADDRESS,
        recipient: "not-an-address",
        amountWei: 1n,
        broadcastRequestId: "req-invalid-regular-recipient",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      /Ethereum address/,
    );
    await assert.rejects(
      adapter.executeRegularTransfer({
        sourceAddress: ADDRESS,
        recipient: RECIPIENT,
        amountWei: 0n,
        broadcastRequestId: "req-zero-regular-transfer",
        beforeBroadcast: CHECKPOINT_BROADCAST,
      }),
      /positive/,
    );
    assert.equal(runner.calls.length, 0);
  });

  it("rejects mainnet wallets and command failures", async () => {
    const mainnet = new FakeRunner(() => ({
      exitCode: 0,
      stdout: '{"wallets":{"agent-boost":{"mainnet":true}}}',
      stderr: "",
    }));
    const mainnetFixture = await fixture(mainnet);
    await assert.rejects(mainnetFixture.adapter.ensureWallet(), /not marked as Sepolia/);

    const failing = new FakeRunner(() => ({
      exitCode: 2,
      stdout: "",
      stderr:
        "controlled failure https://sepolia.example.invalid/rpc-token /private/wallet/path",
    }));
    const failingFixture = await fixture(failing);
    await assert.rejects(
      failingFixture.adapter.nextFreshAddress(),
      (failure: unknown) => {
        assert.match(String(failure), /failed with exit code 2/);
        assert.doesNotMatch(
          String(failure),
          /controlled failure|rpc-token|private/,
        );
        return true;
      },
    );
  });
});

describe("SpawnCommandRunner", () => {
  it("passes metacharacters as literal argv without invoking a shell", async () => {
    const runner = new SpawnCommandRunner({ defaultTimeoutMs: 5_000 });
    const literal = "$(this-is-not-a-command); echo still-an-argument";
    const result = await runner.run({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        literal,
      ],
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), [literal]);
  });

  it("scrubs inherited proxy, RPC, and Kohaku Tor-disable environment variables", async () => {
    const runner = new SpawnCommandRunner({ defaultTimeoutMs: 5_000 });
    const previous = {
      KOHAKU_WITHOUT_TOR: process.env.KOHAKU_WITHOUT_TOR,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      https_proxy: process.env.https_proxy,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      AGENT_BOOST_RPC_URL: process.env.AGENT_BOOST_RPC_URL,
      RPC_URL: process.env.RPC_URL,
      AGENT_BOOST_ALLOWED_RPC_URL: process.env.AGENT_BOOST_ALLOWED_RPC_URL,
    };
    process.env.KOHAKU_WITHOUT_TOR = "1";
    process.env.HTTPS_PROXY = "http://direct-fallback.invalid";
    process.env.https_proxy = "http://lowercase-fallback.invalid";
    process.env.NODE_OPTIONS = "--use-env-proxy";
    process.env.AGENT_BOOST_RPC_URL = "https://credential.invalid/secret";
    process.env.RPC_URL = "https://inherited-rpc.invalid/secret";
    process.env.AGENT_BOOST_ALLOWED_RPC_URL = "https://inherited-allow.invalid/secret";
    try {
      const result = await runner.run({
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({disabled:process.env.KOHAKU_WITHOUT_TOR,proxy:process.env.HTTPS_PROXY,lower:process.env.https_proxy,nodeOptions:process.env.NODE_OPTIONS,upstream:process.env.AGENT_BOOST_RPC_URL,rpc:process.env.RPC_URL,allowed:process.env.AGENT_BOOST_ALLOWED_RPC_URL}))",
        ],
        env: {
          RPC_URL: `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`,
          AGENT_BOOST_ALLOWED_RPC_URL: `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`,
        },
      });
      assert.deepEqual(JSON.parse(result.stdout), {
        rpc: `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`,
        allowed: `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`,
      });
    } finally {
      if (previous.KOHAKU_WITHOUT_TOR === undefined) delete process.env.KOHAKU_WITHOUT_TOR;
      else process.env.KOHAKU_WITHOUT_TOR = previous.KOHAKU_WITHOUT_TOR;
      if (previous.HTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous.HTTPS_PROXY;
      if (previous.https_proxy === undefined) delete process.env.https_proxy;
      else process.env.https_proxy = previous.https_proxy;
      if (previous.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous.NODE_OPTIONS;
      if (previous.AGENT_BOOST_RPC_URL === undefined) delete process.env.AGENT_BOOST_RPC_URL;
      else process.env.AGENT_BOOST_RPC_URL = previous.AGENT_BOOST_RPC_URL;
      if (previous.RPC_URL === undefined) delete process.env.RPC_URL;
      else process.env.RPC_URL = previous.RPC_URL;
      if (previous.AGENT_BOOST_ALLOWED_RPC_URL === undefined) {
        delete process.env.AGENT_BOOST_ALLOWED_RPC_URL;
      } else {
        process.env.AGENT_BOOST_ALLOWED_RPC_URL = previous.AGENT_BOOST_ALLOWED_RPC_URL;
      }
    }
  });

  it("loads the Kohaku guard and blocks a public fallback fetch", async () => {
    const runner = new SpawnCommandRunner({ defaultTimeoutMs: 5_000 });
    const allowed = `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`;
    const guard = new URL("../src/kohaku/network-guard.mjs", import.meta.url).href;
    const result = await runner.run({
      executable: process.execPath,
      args: [
        "-e",
        "fetch('https://ethereum-sepolia-rpc.publicnode.com').then(()=>process.exit(2)).catch((error)=>process.stdout.write(error.message))",
      ],
      env: {
        AGENT_BOOST_ALLOWED_RPC_URL: allowed,
        NODE_OPTIONS: `--import=${guard}`,
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "Agent Boost blocked a direct Kohaku network fetch");
  });

  it("lets Kohaku install its Tor wrapper while its captured clearnet fetch stays guarded", async () => {
    const runner = new SpawnCommandRunner({ defaultTimeoutMs: 5_000 });
    const allowed = `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`;
    const guard = new URL("../src/kohaku/network-guard.mjs", import.meta.url).href;
    const script = [
      "const clearnetFetch = globalThis.fetch;",
      "globalThis.fetch = async (input, init) => clearnetFetch(input, init);",
      "fetch('https://ethereum-sepolia-rpc.publicnode.com')",
      "  .then(() => process.exit(2))",
      "  .catch((error) => process.stdout.write(error.message));",
    ].join("\n");
    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", script],
      env: {
        AGENT_BOOST_ALLOWED_RPC_URL: allowed,
        NODE_OPTIONS: `--import=${guard}`,
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "Agent Boost blocked a direct Kohaku network fetch");
  });

  it("fails closed for broadcasts outside the active journal mode", async (t) => {
    const scenarios = [
      { mode: "none", method: "eth_sendRawTransaction" },
      { mode: "private", method: "eth_sendRawTransaction" },
      { mode: "raw", method: "eth_sendUserOperation" },
    ] as const;
    for (const scenario of scenarios) {
      await t.test(`${scenario.mode}:${scenario.method}`, async () => {
        const { result, journalPath } = await runGuardedWrongBroadcastMode(
          scenario,
        );
        assert.equal(result.exitCode, 0);
        assert.equal(
          result.stdout,
          "Agent Boost rejected a broadcast method outside the active journal mode",
        );
        await assert.rejects(stat(journalPath), { code: "ENOENT" });
      });
    }
  });

  it("binds and journals an exact signed Sepolia transaction before network handoff", async () => {
    const rawTransaction = signedRawTransaction();
    const { result, journalPath } = await runGuardedRawTransactionSend({
      requestId: "rreq-exact-raw-send",
      actualRawTransaction: rawTransaction,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "delegated");
    assert.deepEqual(JSON.parse(await readFile(journalPath, "utf8")), {
      version: 1,
      requestId: "rreq-exact-raw-send",
      transactionHash: rawTransactionHash(rawTransaction),
      from: RAW_TRANSACTION_SIGNER,
      to: RECIPIENT,
      valueWei: "3",
      data: "0x",
      chainId: 11_155_111,
      nonce: "7",
      gas: "21000",
      transactionType: "eip1559",
      journaledAt: JSON.parse(await readFile(journalPath, "utf8")).journaledAt,
    });
    assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
  });

  it("allows only deposit-bound raw fees between the regular and Tornado ceilings", async () => {
    const gas = 1_000_000n;
    const withinDepositCap = signedRawTransaction({
      to: TORNADO_POOL,
      valueWei: DEFAULT_SHIELD_WEI,
      data: DEPOSIT_DATA,
      gas,
      maxFeePerGas: REGULAR_TRANSFER_GAS_RESERVE_WEI / gas + 1n,
    });
    const allowed = await runGuardedRawTransactionSend({
      requestId: "rreq-tornado-fee-between-caps",
      actualRawTransaction: withinDepositCap,
      expectedTo: TORNADO_POOL,
      expectedValueWei: DEFAULT_SHIELD_WEI.toString(),
      expectedData: DEPOSIT_DATA,
      expectedMaxGas: "3000000",
      expectedMaxFeeWei: TORNADO_DEPOSIT_GAS_RESERVE_WEI.toString(),
    });
    assert.equal(allowed.result.exitCode, 0);
    assert.equal(allowed.result.stdout, "delegated");
    assert.equal(
      (JSON.parse(await readFile(allowed.journalPath, "utf8")) as {
        transactionHash: string;
      }).transactionHash,
      rawTransactionHash(withinDepositCap),
    );

    const aboveDepositCap = signedRawTransaction({
      to: TORNADO_POOL,
      valueWei: DEFAULT_SHIELD_WEI,
      data: DEPOSIT_DATA,
      gas,
      maxFeePerGas: TORNADO_DEPOSIT_GAS_RESERVE_WEI / gas + 1n,
    });
    const rejected = await runGuardedRawTransactionSend({
      requestId: "rreq-tornado-fee-above-cap",
      actualRawTransaction: aboveDepositCap,
      expectedTo: TORNADO_POOL,
      expectedValueWei: DEFAULT_SHIELD_WEI.toString(),
      expectedData: DEPOSIT_DATA,
      expectedMaxGas: "3000000",
      expectedMaxFeeWei: TORNADO_DEPOSIT_GAS_RESERVE_WEI.toString(),
    });
    assert.equal(rejected.result.exitCode, 0);
    assert.match(
      rejected.result.stdout,
      /rejected a signed transaction that changed after the approved dry run/u,
    );
    await assert.rejects(readFile(rejected.journalPath, "utf8"), /ENOENT/u);
  });

  it("rejects a Tornado deposit above its gas ceiling before journal or handoff", async () => {
    const overGasDeposit = signedRawTransaction({
      to: TORNADO_POOL,
      valueWei: DEFAULT_SHIELD_WEI,
      data: DEPOSIT_DATA,
      gas: 3_000_001n,
    });
    const { result, journalPath } = await runGuardedRawTransactionSend({
      requestId: "rreq-tornado-gas-above-cap",
      actualRawTransaction: overGasDeposit,
      expectedTo: TORNADO_POOL,
      expectedValueWei: DEFAULT_SHIELD_WEI.toString(),
      expectedData: DEPOSIT_DATA,
      expectedMaxGas: "3000000",
      expectedMaxFeeWei: TORNADO_DEPOSIT_GAS_RESERVE_WEI.toString(),
    });

    assert.equal(result.exitCode, 0);
    assert.match(
      result.stdout,
      /rejected a signed transaction that changed after the approved dry run/u,
    );
    assert.doesNotMatch(result.stdout, /delegated/u);
    await assert.rejects(readFile(journalPath, "utf8"), /ENOENT/u);
  });

  for (const transactionType of ["legacy", "eip2930"] as const) {
    it(`binds a safe signed ${transactionType} Sepolia transaction`, async () => {
      const rawTransaction = signedStandardRawTransaction(transactionType);
      const { result, journalPath } = await runGuardedRawTransactionSend({
        requestId: `rreq-exact-${transactionType}-send`,
        actualRawTransaction: rawTransaction,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "delegated");
      const checkpoint = JSON.parse(await readFile(journalPath, "utf8")) as {
        transactionHash: string;
        transactionType: string;
      };
      assert.equal(checkpoint.transactionHash, rawTransactionHash(rawTransaction));
      assert.equal(checkpoint.transactionType, transactionType);
    });
  }

  it("rejects signed raw transaction intent tampering before journal or handoff", async (t) => {
    const otherKey =
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;
    const cases: Array<[string, `0x${string}`]> = [
      ["from", signedRawTransaction({ privateKey: otherKey })],
      ["to", signedRawTransaction({ to: OTHER_ADDRESS })],
      ["value", signedRawTransaction({ valueWei: 4n })],
      ["data", signedRawTransaction({ data: "0x12" })],
      ["chain", signedRawTransaction({ chainId: 1 })],
      ["nonce", signedRawTransaction({ nonce: 8n })],
      ["gas", signedRawTransaction({ gas: 100_001n })],
      ["fee", signedRawTransaction({ maxFeePerGas: 100_000_000_000n })],
    ];
    for (const [label, actualRawTransaction] of cases) {
      await t.test(label, async () => {
        const { result, journalPath } = await runGuardedRawTransactionSend({
          requestId: `rreq-tampered-${label}`,
          actualRawTransaction,
        });
        assert.equal(result.exitCode, 0);
        assert.match(
          result.stdout,
          /rejected a signed transaction that changed after the approved dry run/u,
        );
        await assert.rejects(readFile(journalPath, "utf8"), /ENOENT/u);
      });
    }
  });

  it("rejects a batch containing multiple raw transaction sends", async () => {
    const { result, journalPath } = await runGuardedRawTransactionSend({
      requestId: "rreq-batched-raw-send",
      actualRawTransaction: signedRawTransaction(),
      batchSend: true,
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /malformed or batched raw transaction broadcast/u);
    await assert.rejects(readFile(journalPath, "utf8"), /ENOENT/u);
  });

  it("retains the exact transaction hash when the provider fails after handoff", async () => {
    const rawTransaction = signedRawTransaction({
      to: TORNADO_POOL,
      valueWei: DEFAULT_SHIELD_WEI,
      data: DEPOSIT_DATA,
      gas: 1_000_000n,
    });
    const { result, journalPath } = await runGuardedRawTransactionSend({
      requestId: "pbfr-provider-timeout-after-send",
      actualRawTransaction: rawTransaction,
      expectedTo: TORNADO_POOL,
      expectedValueWei: DEFAULT_SHIELD_WEI.toString(),
      expectedData: DEPOSIT_DATA,
      expectedMaxGas: "3000000",
      delegateFailure: "provider timed out after network handoff",
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^delegatedprovider timed out/u);
    const checkpoint = JSON.parse(await readFile(journalPath, "utf8")) as {
      transactionHash: string;
      data: string;
    };
    assert.equal(checkpoint.transactionHash, rawTransactionHash(rawTransaction));
    assert.equal(checkpoint.data, DEPOSIT_DATA.toLowerCase());
  });

  it("journals the exact v0.8 UserOperation before delegating the actual Pimlico send", async () => {
    const runner = new SpawnCommandRunner({ defaultTimeoutMs: 5_000 });
    const root = await mkdtemp(join(tmpdir(), "agent-boost-journal-guard-"));
    const journalDirectory = join(root, "journal");
    await mkdir(journalDirectory, { mode: 0o700 });
    const requestId = "req-network-guard-send";
    const journalPath = join(
      journalDirectory,
      `${createHash("sha256").update(requestId).digest("hex")}.json`,
    );
    const preparationStdout = privatePaymentPreparation();
    const preparation = JSON.parse(preparationStdout) as {
      privateOperation: { withdrawals: Array<{
        userOperation: ReturnType<typeof serializedUserOperation>;
      }> };
    };
    const operation = preparation.privateOperation.withdrawals[0]!.userOperation;
    const expectedHash = exactUserOperationHash(operation);
    const rpcBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendUserOperation",
      params: [operation, ENTRY_POINT],
    });
    const guard = new URL("../src/kohaku/network-guard.mjs", import.meta.url).href;
    const script = [
      "const { existsSync } = await import('node:fs');",
      "globalThis.fetch = async () => {",
      "  if (!existsSync(process.env.AGENT_BOOST_PRIVATE_BROADCAST_JOURNAL_PATH)) throw new Error('journal missing before delegate');",
      "  process.stdout.write('delegated');",
      "  return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:'ok'}), {status:200});",
      "};",
      "await fetch('http://127.0.0.1:32123/v2/11155111/rpc', {method:'POST',headers:{'content-type':'application/json'},body:process.env.TEST_RPC_BODY});",
    ].join("\n");
    const result = await runner.run({
      executable: process.execPath,
      args: ["--input-type=module", "-e", script],
      env: {
        AGENT_BOOST_ALLOWED_RPC_URL:
          `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`,
        AGENT_BOOST_PRIVATE_BROADCAST_JOURNAL_PATH: journalPath,
        AGENT_BOOST_PRIVATE_BROADCAST_REQUEST_ID: requestId,
        AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_SENDER: ADDRESS,
        AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_CALL_PLAN:
          JSON.stringify(callPlanFromPreparation(preparationStdout)),
        NODE_OPTIONS: `--import=${guard}`,
        TEST_RPC_BODY: rpcBody,
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "delegated");
    assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(journalPath, "utf8")), {
      version: 1,
      requestId,
      userOperationHash: expectedHash,
      sender: ADDRESS,
      entryPointAddress: ENTRY_POINT.toLowerCase(),
      journaledAt: JSON.parse(await readFile(journalPath, "utf8")).journaledAt,
    });
    assert.equal(
      new Date(
        (JSON.parse(await readFile(journalPath, "utf8")) as { journaledAt: string })
          .journaledAt,
      ).toISOString(),
      (JSON.parse(await readFile(journalPath, "utf8")) as { journaledAt: string })
        .journaledAt,
    );
  });

  it("allows safe non-execution gas decreases and upward UserOperation gas drift", async (t) => {
    const preparation = privatePaymentPreparation();
    const approved = userOperationFromPreparation(preparation);
    await t.test("non-execution gas fields may drift down", async () => {
      let actualOperation = alterPaymasterSponsorship(approved, {
        proof: "0xabcd",
        root: `0x${"cc".repeat(32)}`,
      });
      for (const key of [
        "verificationGasLimit",
        "preVerificationGas",
        "paymasterVerificationGasLimit",
      ] as const) {
        actualOperation = setUserOperationGasLimit(
          actualOperation,
          key,
          1n,
        );
      }
      const { result, journalPath } = await runGuardedPrivateSend({
        requestId: "req-network-guard-validation-gas-downward-drift",
        preparation,
        actualOperation,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "delegated");
      assert.equal(
        (JSON.parse(await readFile(journalPath, "utf8")) as {
          userOperationHash: string;
        }).userOperationHash,
        exactUserOperationHash(actualOperation),
      );
    });
    await t.test("fresh estimation may drift up", async () => {
      let actualOperation = approved;
      for (const key of [
        "callGasLimit",
        "verificationGasLimit",
        "preVerificationGas",
        "paymasterVerificationGasLimit",
        "paymasterPostOpGasLimit",
      ] as const) {
        actualOperation = setUserOperationGasLimit(
          actualOperation,
          key,
          BigInt(actualOperation[key]) + 1n,
        );
      }
      const { result } = await runGuardedPrivateSend({
        requestId: "req-network-guard-upward-gas-drift",
        preparation,
        actualOperation,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "delegated");
    });
  });

  it("rejects downward UserOperation gas-limit drift before handoff", async (t) => {
    const preparation = privatePaymentPreparation();
    const approved = userOperationFromPreparation(preparation);
    const floors = callPlanFromPreparation(preparation).gasFloors;
    for (const key of [
      "callGasLimit",
      "paymasterPostOpGasLimit",
    ] as const) {
      await t.test(key, async () => {
        const { result, journalPath } = await runGuardedPrivateSend({
          requestId: `req-network-guard-downward-${key}`,
          preparation,
          actualOperation: setUserOperationGasLimit(
            approved,
            key,
            BigInt(floors[key]) - 1n,
          ),
        });
        assert.equal(result.exitCode, 0);
        assert.equal(
          result.stdout,
          "Agent Boost rejected UserOperation gas limits below the approved preparation",
        );
        await assert.rejects(stat(journalPath), { code: "ENOENT" });
      });
    }
  });

  it("allows canonical sponsor proof, root, and bounded fee drift", async () => {
    const preparation = privatePaymentPreparation();
    const actualOperation = alterPaymasterSponsorship(
      userOperationFromPreparation(preparation),
      {
        proof: "0xabcd",
        root: `0x${"cc".repeat(32)}`,
        feeWei: ESTIMATED_PRIVATE_FEE_WEI + 1n,
      },
    );
    const { result, journalPath } = await runGuardedPrivateSend({
      requestId: "req-network-guard-sponsor-drift",
      preparation,
      actualOperation,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "delegated");
    assert.equal(
      (JSON.parse(await readFile(journalPath, "utf8")) as {
        userOperationHash: string;
      }).userOperationHash,
      exactUserOperationHash(actualOperation),
    );
  });

  it("rejects changed sponsor semantics before journaling or delegation", async (t) => {
    const preparation = privatePaymentPreparation();
    const approved = userOperationFromPreparation(preparation);
    const approvedReserveWei = ESTIMATED_PRIVATE_FEE_WEI * 23n / 20n;
    const cases: Array<[
      string,
      Parameters<typeof alterPaymasterSponsorship>[1],
    ]> = [
      ["adapter", { adapterAddress: OTHER_ADDRESS }],
      ["nullifier", { nullifierHash: `0x${"dd".repeat(32)}` }],
      ["recipient", { recipient: OTHER_ADDRESS }],
      ["relayer", { relayer: OTHER_ADDRESS }],
      ["refund", { refundWei: 1n }],
      ["zero fee", { feeWei: 0n }],
      ["fee over actual reserve", { feeWei: approvedReserveWei + 1n }],
    ];
    for (const [label, replacement] of cases) {
      await t.test(label, async () => {
        const { result, journalPath } = await runGuardedPrivateSend({
          requestId: `req-network-guard-sponsor-${label.replaceAll(" ", "-")}`,
          preparation,
          actualOperation: alterPaymasterSponsorship(approved, replacement),
        });
        assert.equal(result.exitCode, 0);
        assert.equal(
          result.stdout,
          "Agent Boost rejected UserOperation paymasterData that changed after the approved dry run",
        );
        await assert.rejects(stat(journalPath), { code: "ENOENT" });
      });
    }
  });

  it("rejects noncanonical trailing sponsor bytes", async (t) => {
    const preparation = privatePaymentPreparation();
    const approved = userOperationFromPreparation(preparation);
    for (const location of ["outer", "inner"] as const) {
      await t.test(location, async () => {
        const { result, journalPath } = await runGuardedPrivateSend({
          requestId: `req-network-guard-sponsor-trailing-${location}`,
          preparation,
          actualOperation: appendTrailingPaymasterBytes(approved, location),
        });
        assert.equal(result.exitCode, 0);
        assert.equal(
          result.stdout,
          "Agent Boost rejected UserOperation paymasterData that changed after the approved dry run",
        );
        await assert.rejects(stat(journalPath), { code: "ENOENT" });
      });
    }
  });

  for (const scenario of [
    {
      label: "private payment",
      requestId: "req-network-guard-payment-fee-drift",
      preparation: privatePaymentPreparation(),
    },
    {
      label: "private recovery",
      requestId: "req-network-guard-recovery-fee-drift",
      preparation: privatePaymentPreparation(
        OTHER_ADDRESS,
        30_000_000_000_000_000n,
      ),
    },
  ]) {
    it(`allows lower fee reserve for ${scenario.label} without changing its exact tail`, async () => {
      const actualOperation = alterPrivateChangeValue(
        userOperationFromPreparation(scenario.preparation),
        1n,
      );
      const { result, journalPath } = await runGuardedPrivateSend({
        requestId: scenario.requestId,
        preparation: scenario.preparation,
        actualOperation,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "delegated");
      assert.equal(
        (JSON.parse(await readFile(journalPath, "utf8")) as {
          userOperationHash: string;
        }).userOperationHash,
        exactUserOperationHash(actualOperation),
      );
    });
  }

  it("allows rebalance proof, root, and lower-fee drift while binding its nullifier and deposit tail", async () => {
    const preparation = privateRebalancePreparation();
    const actualOperation = alterPrivateChangeValue(
      alterDirectWithdrawalProofAndRoot(
        userOperationFromPreparation(preparation),
      ),
      1n,
    );
    const { result, journalPath } = await runGuardedPrivateSend({
      requestId: "req-network-guard-rebalance-legitimate-drift",
      preparation,
      actualOperation,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "delegated");
    assert.equal(
      (JSON.parse(await readFile(journalPath, "utf8")) as {
        userOperationHash: string;
      }).userOperationHash,
      exactUserOperationHash(actualOperation),
    );
  });

  it("allows upward fee-quote drift within the fixed private paymaster cap", async () => {
    const preparation = privateRebalancePreparation();
    const approvedReserveWei =
      ESTIMATED_PRIVATE_FEE_WEI * 23n / 20n;
    const actualOperation = setPrivateFeeReserve(
      userOperationFromPreparation(preparation),
      DEFAULT_SHIELD_WEI * 2n,
      approvedReserveWei + 1n,
    );
    const { result, journalPath } = await runGuardedPrivateSend({
      requestId: "req-network-guard-fee-upward-drift",
      preparation,
      actualOperation,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "delegated");
    assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
  });

  for (const scenario of [
    {
      label: "private payment",
      requestId: "req-network-guard-payment-fee-cap",
      preparation: privatePaymentPreparation(),
    },
    {
      label: "private recovery",
      requestId: "req-network-guard-recovery-fee-cap",
      preparation: privatePaymentPreparation(
        OTHER_ADDRESS,
        30_000_000_000_000_000n,
      ),
    },
    {
      label: "private rebalance",
      requestId: "req-network-guard-rebalance-fee-cap",
      preparation: privateRebalancePreparation(),
    },
  ]) {
    it(`blocks a larger-than-approved fee reserve for ${scenario.label}`, async () => {
      const plan = callPlanFromPreparation(scenario.preparation);
      const actualOperation = setPrivateFeeReserve(
        userOperationFromPreparation(scenario.preparation),
        BigInt(plan.withdrawalAmountWei),
        BigInt(plan.maxFeeReserveWei) + 1n,
      );
      const { result, journalPath } = await runGuardedPrivateSend({
        requestId: scenario.requestId,
        preparation: scenario.preparation,
        actualOperation,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(
        result.stdout,
        "Agent Boost rejected UserOperation callData that changed after the approved dry run",
      );
      await assert.rejects(stat(journalPath), { code: "ENOENT" });
    });
  }

  it("blocks a rebalance that swaps an approved direct-withdraw nullifier", async () => {
    const preparation = privateRebalancePreparation();
    const actualOperation = alterDirectWithdrawalProofAndRoot(
      userOperationFromPreparation(preparation),
      `0x${"aa".repeat(32)}`,
    );
    const { result, journalPath } = await runGuardedPrivateSend({
      requestId: "req-network-guard-rebalance-nullifier",
      preparation,
      actualOperation,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(
      result.stdout,
      "Agent Boost rejected UserOperation callData that changed after the approved dry run",
    );
    await assert.rejects(stat(journalPath), { code: "ENOENT" });
  });

  it("blocks a rebalance that swaps the fixed Tornado pool", async () => {
    const preparation = privateRebalancePreparation();
    const { result, journalPath } = await runGuardedPrivateSend({
      requestId: "req-network-guard-rebalance-pool",
      preparation,
      actualOperation: alterDirectWithdrawalPool(
        userOperationFromPreparation(preparation),
        OTHER_ADDRESS,
      ),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(
      result.stdout,
      "Agent Boost rejected UserOperation callData that changed after the approved dry run",
    );
    await assert.rejects(stat(journalPath), { code: "ENOENT" });
  });

  for (const scenario of [
    {
      label: "private payment",
      requestId: "req-network-guard-payment-calldata",
      preparation: privatePaymentPreparation(),
      alter: (operation: ReturnType<typeof serializedUserOperation>) =>
        alterLastPreparedCall(operation, { target: OTHER_ADDRESS }),
    },
    {
      label: "private recovery",
      requestId: "req-network-guard-recovery-calldata",
      preparation: privatePaymentPreparation(
        OTHER_ADDRESS,
        30_000_000_000_000_000n,
      ),
      alter: (operation: ReturnType<typeof serializedUserOperation>) =>
        alterLastPreparedCall(operation, {
          value: 30_000_000_000_000_001n,
        }),
    },
    {
      label: "private rebalance",
      requestId: "req-network-guard-rebalance-calldata",
      preparation: privateRebalancePreparation(),
      alter: (operation: ReturnType<typeof serializedUserOperation>) =>
        alterLastPreparedCall(operation, {
          data: `0xb214faa5${"34".repeat(32)}`,
        }),
    },
  ]) {
    it(`blocks altered actual callData for ${scenario.label} before journaling or delegation`, async () => {
      const runner = new SpawnCommandRunner({ defaultTimeoutMs: 5_000 });
      const root = await mkdtemp(join(tmpdir(), "agent-boost-journal-guard-"));
      const journalDirectory = join(root, "journal");
      await mkdir(journalDirectory, { mode: 0o700 });
      const journalPath = join(
        journalDirectory,
        `${createHash("sha256").update(scenario.requestId).digest("hex")}.json`,
      );
      const approvedOperation = userOperationFromPreparation(
        scenario.preparation,
      );
      const actualOperation = scenario.alter(approvedOperation);
      const rpcBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendUserOperation",
        params: [actualOperation, ENTRY_POINT],
      });
      const guard = new URL(
        "../src/kohaku/network-guard.mjs",
        import.meta.url,
      ).href;
      const script = [
        "globalThis.fetch = async () => { process.stdout.write('delegated'); return new Response('{}'); };",
        "await fetch('http://127.0.0.1:32123/v2/11155111/rpc', {method:'POST',body:process.env.TEST_RPC_BODY})",
        "  .then(() => process.exit(2))",
        "  .catch((error) => process.stdout.write(error.message));",
      ].join("\n");
      const result = await runner.run({
        executable: process.execPath,
        args: ["--input-type=module", "-e", script],
        env: {
          AGENT_BOOST_ALLOWED_RPC_URL:
            `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`,
          AGENT_BOOST_PRIVATE_BROADCAST_JOURNAL_PATH: journalPath,
          AGENT_BOOST_PRIVATE_BROADCAST_REQUEST_ID: scenario.requestId,
          AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_SENDER: ADDRESS,
          AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_CALL_PLAN:
            JSON.stringify(callPlanFromPreparation(scenario.preparation)),
          NODE_OPTIONS: `--import=${guard}`,
          TEST_RPC_BODY: rpcBody,
        },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(
        result.stdout,
        "Agent Boost rejected UserOperation callData that changed after the approved dry run",
      );
      await assert.rejects(stat(journalPath), { code: "ENOENT" });
    });
  }

  it("blocks a mismatched actual-send sender before delegation or journaling", async () => {
    const runner = new SpawnCommandRunner({ defaultTimeoutMs: 5_000 });
    const root = await mkdtemp(join(tmpdir(), "agent-boost-journal-guard-"));
    const journalDirectory = join(root, "journal");
    await mkdir(journalDirectory, { mode: 0o700 });
    const requestId = "req-network-guard-mismatch";
    const journalPath = join(
      journalDirectory,
      `${createHash("sha256").update(requestId).digest("hex")}.json`,
    );
    const preparationStdout = privatePaymentPreparation();
    const preparation = JSON.parse(preparationStdout) as {
      privateOperation: { withdrawals: Array<{
        userOperation: ReturnType<typeof serializedUserOperation>;
      }> };
    };
    const rpcBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendUserOperation",
      params: [preparation.privateOperation.withdrawals[0]!.userOperation, ENTRY_POINT],
    });
    const guard = new URL("../src/kohaku/network-guard.mjs", import.meta.url).href;
    const script = [
      "globalThis.fetch = async () => { process.stdout.write('delegated'); return new Response('{}'); };",
      "await fetch('http://127.0.0.1:32123/v2/11155111/rpc', {method:'POST',body:process.env.TEST_RPC_BODY})",
      "  .then(() => process.exit(2))",
      "  .catch((error) => process.stdout.write(error.message));",
    ].join("\n");
    const result = await runner.run({
      executable: process.execPath,
      args: ["--input-type=module", "-e", script],
      env: {
        AGENT_BOOST_ALLOWED_RPC_URL:
          `http://127.0.0.1:9185/rpc/${"a".repeat(43)}`,
        AGENT_BOOST_PRIVATE_BROADCAST_JOURNAL_PATH: journalPath,
        AGENT_BOOST_PRIVATE_BROADCAST_REQUEST_ID: requestId,
        AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_SENDER: OTHER_ADDRESS,
        AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_CALL_PLAN:
          JSON.stringify(callPlanFromPreparation(preparationStdout)),
        NODE_OPTIONS: `--import=${guard}`,
        TEST_RPC_BODY: rpcBody,
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "Agent Boost rejected a mismatched UserOperation sender");
    await assert.rejects(stat(journalPath), { code: "ENOENT" });
  });
});
