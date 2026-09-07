import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

import * as AbiFunction from "ox/AbiFunction";
import * as AbiParameters from "ox/AbiParameters";
import * as Secp256k1 from "ox/Secp256k1";
import * as Signature from "ox/Signature";
import * as TxEnvelopeEip1559 from "ox/TxEnvelopeEip1559";
import * as TxEnvelopeEip2930 from "ox/TxEnvelopeEip2930";
import * as TxEnvelopeLegacy from "ox/TxEnvelopeLegacy";
import * as UserOperation from "ox/erc4337/UserOperation";

const SEPOLIA_CHAIN_ID = 11_155_111;
const ENTRY_POINT_V08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
const SEPOLIA_TORNADO_PAYMASTER =
  "0x1c5accb9c09d72945b79ec986776136be01d7b2f";
const SEPOLIA_TORNADO_ETH_0_1_POOL =
  "0x8c4a04d872a6c1be37964a21ba3a138525dff50b";
const SEPOLIA_TORNADO_ETH_0_1_ADAPTER =
  "0xa616aae443fccabfc2f1ea2afe001e5046ffdce0";
const SIMPLE_7702_IMPLEMENTATION =
  "0xe6cae83bde06e4c305530e199d7217f42808555b";
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;
const BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/u;
const DECIMAL_UINT_RE = /^(?:0|[1-9][0-9]*)$/u;
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/u;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/u;
const TORNADO_WITHDRAW_SELECTOR = "0x21a0adb6";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EXECUTE_FUNCTION = AbiFunction.from(
  "function execute(address target,uint256 value,bytes data)",
);
const EXECUTE_BATCH_FUNCTION = AbiFunction.from(
  "function executeBatch((address target,uint256 value,bytes data)[] calls)",
);
const TORNADO_WITHDRAW_FUNCTION = AbiFunction.from(
  "function withdraw(bytes proof,bytes32 root,bytes32 nullifierHash,address recipient,address relayer,uint256 fee,uint256 refund)",
);
const PAYMASTER_DATA_PARAMETERS = AbiParameters.from(
  "(address adapter, bytes adapterData)",
);
const TORNADO_SPONSOR_PARAMETERS = AbiParameters.from(
  "(bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee, uint256 refund)",
);
const USER_OPERATION_KEYS = [
  "callData",
  "callGasLimit",
  "eip7702Auth",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "nonce",
  "paymaster",
  "paymasterData",
  "paymasterPostOpGasLimit",
  "paymasterVerificationGasLimit",
  "preVerificationGas",
  "sender",
  "signature",
  "verificationGasLimit",
].sort();
const MAX_SAFE_TRANSACTION_NONCE = BigInt(Number.MAX_SAFE_INTEGER);

const allowedRaw = process.env.AGENT_BOOST_ALLOWED_RPC_URL;
let allowed;
try {
  allowed = new URL(allowedRaw ?? "");
} catch {
  throw new Error("Agent Boost Kohaku network guard requires its loopback RPC URL");
}

if (
  allowed.protocol !== "http:" ||
  allowed.hostname !== "127.0.0.1" ||
  allowed.port === "" ||
  !/^\/rpc\/[A-Za-z0-9_-]{43}$/u.test(allowed.pathname) ||
  allowed.username !== "" ||
  allowed.password !== "" ||
  allowed.search !== "" ||
  allowed.hash !== ""
) {
  throw new Error("Agent Boost Kohaku network guard rejected its RPC URL");
}

const journalConfig = parseJournalConfig();
const rawTransactionJournalConfig = parseRawTransactionJournalConfig();
if (journalConfig && rawTransactionJournalConfig) {
  throw new Error("Agent Boost broadcast journals are mutually exclusive");
}
const allowedUrl = allowed.toString();
const nativeFetch = globalThis.fetch.bind(globalThis);
const observedPendingNonces = new Map();

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExpectedCallPlan(raw) {
  if (raw.length > 131_072) {
    throw new Error("Agent Boost private broadcast call plan is too large");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Agent Boost private broadcast call plan is invalid JSON");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "directWithdrawals,gasFloors,maxFeeReserveWei,sponsor,tailCall,version,withdrawalAmountWei" ||
    value.version !== 1 ||
    typeof value.withdrawalAmountWei !== "string" ||
    !DECIMAL_UINT_RE.test(value.withdrawalAmountWei) ||
    typeof value.maxFeeReserveWei !== "string" ||
    !DECIMAL_UINT_RE.test(value.maxFeeReserveWei) ||
    !Array.isArray(value.directWithdrawals) ||
    !isRecord(value.gasFloors) ||
    !isRecord(value.sponsor) ||
    !isRecord(value.tailCall)
  ) {
    throw new Error("Agent Boost private broadcast call plan is malformed");
  }
  const withdrawalAmountWei = BigInt(value.withdrawalAmountWei);
  const maxFeeReserveWei = BigInt(value.maxFeeReserveWei);
  if (
    withdrawalAmountWei <= 0n ||
    maxFeeReserveWei <= 0n ||
    maxFeeReserveWei >= withdrawalAmountWei ||
    value.directWithdrawals.length > 1_024
  ) {
    throw new Error("Agent Boost private broadcast call plan has invalid limits");
  }
  const gasFloorKeys = [
    "callGasLimit",
    "paymasterPostOpGasLimit",
    "paymasterVerificationGasLimit",
    "preVerificationGas",
    "verificationGasLimit",
  ];
  if (Object.keys(value.gasFloors).sort().join(",") !== gasFloorKeys.join(",")) {
    throw new Error("Agent Boost private broadcast gas floors are malformed");
  }
  const gasFloors = {};
  for (const key of gasFloorKeys) {
    const floor = value.gasFloors[key];
    if (typeof floor !== "string" || !DECIMAL_UINT_RE.test(floor) || BigInt(floor) <= 0n) {
      throw new Error("Agent Boost private broadcast gas floors are malformed");
    }
    gasFloors[key] = BigInt(floor);
  }
  const seenNullifiers = new Set();
  const directWithdrawals = value.directWithdrawals.map((withdrawal) => {
    if (
      !isRecord(withdrawal) ||
      Object.keys(withdrawal).sort().join(",") !==
        "nullifierHash,poolAddress" ||
      typeof withdrawal.poolAddress !== "string" ||
      withdrawal.poolAddress.toLowerCase() !== SEPOLIA_TORNADO_ETH_0_1_POOL ||
      typeof withdrawal.nullifierHash !== "string" ||
      !BYTES32_RE.test(withdrawal.nullifierHash)
    ) {
      throw new Error("Agent Boost private broadcast direct withdrawal is malformed");
    }
    const nullifierHash = withdrawal.nullifierHash.toLowerCase();
    if (seenNullifiers.has(nullifierHash)) {
      throw new Error("Agent Boost private broadcast call plan repeats a nullifier");
    }
    seenNullifiers.add(nullifierHash);
    return {
      poolAddress: SEPOLIA_TORNADO_ETH_0_1_POOL,
      nullifierHash,
    };
  });
  if (
    Object.keys(value.sponsor).sort().join(",") !==
      "adapterAddress,nullifierHash" ||
    typeof value.sponsor.adapterAddress !== "string" ||
    value.sponsor.adapterAddress.toLowerCase() !==
      SEPOLIA_TORNADO_ETH_0_1_ADAPTER ||
    typeof value.sponsor.nullifierHash !== "string" ||
    !BYTES32_RE.test(value.sponsor.nullifierHash) ||
    /^0x0{64}$/u.test(value.sponsor.nullifierHash)
  ) {
    throw new Error("Agent Boost private broadcast sponsor is malformed");
  }
  const sponsorNullifierHash = value.sponsor.nullifierHash.toLowerCase();
  if (seenNullifiers.has(sponsorNullifierHash)) {
    throw new Error("Agent Boost private broadcast reused a sponsor nullifier");
  }
  const tailCall = value.tailCall;
  if (
    Object.keys(tailCall).sort().join(",") !== "data,target,valueWei" ||
    typeof tailCall.target !== "string" ||
    !ADDRESS_RE.test(tailCall.target) ||
    typeof tailCall.data !== "string" ||
    !BYTES_RE.test(tailCall.data) ||
    typeof tailCall.valueWei !== "string" ||
    !DECIMAL_UINT_RE.test(tailCall.valueWei)
  ) {
    throw new Error("Agent Boost private broadcast tail call is malformed");
  }
  const tailValueWei = BigInt(tailCall.valueWei);
  if (tailValueWei <= 0n || tailValueWei >= withdrawalAmountWei) {
    throw new Error("Agent Boost private broadcast tail value is invalid");
  }
  return {
    withdrawalAmountWei,
    maxFeeReserveWei,
    gasFloors,
    directWithdrawals,
    sponsor: {
      adapterAddress: SEPOLIA_TORNADO_ETH_0_1_ADAPTER,
      nullifierHash: sponsorNullifierHash,
    },
    tailCall: {
      target: tailCall.target.toLowerCase(),
      data: tailCall.data.toLowerCase(),
      valueWei: tailValueWei,
    },
  };
}

function parseJournalConfig() {
  const path = process.env.AGENT_BOOST_PRIVATE_BROADCAST_JOURNAL_PATH;
  const requestId = process.env.AGENT_BOOST_PRIVATE_BROADCAST_REQUEST_ID;
  const expectedSender =
    process.env.AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_SENDER;
  const expectedCallPlanRaw =
    process.env.AGENT_BOOST_PRIVATE_BROADCAST_EXPECTED_CALL_PLAN;
  const configured = [path, requestId, expectedSender, expectedCallPlanRaw].filter(
    (value) => value !== undefined,
  ).length;
  if (configured === 0) return undefined;
  if (
    configured !== 4 ||
    !path ||
    !requestId ||
    !expectedSender ||
    !expectedCallPlanRaw
  ) {
    throw new Error("Agent Boost private broadcast journal is incompletely configured");
  }
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new Error("Agent Boost private broadcast request ID is invalid");
  }
  if (!ADDRESS_RE.test(expectedSender)) {
    throw new Error("Agent Boost private broadcast sender is invalid");
  }
  if (!isAbsolute(path)) {
    throw new Error("Agent Boost private broadcast journal path must be absolute");
  }
  const expectedName = `${createHash("sha256").update(requestId).digest("hex")}.json`;
  if (basename(path) !== expectedName) {
    throw new Error("Agent Boost private broadcast journal path is not request-bound");
  }
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Agent Boost private broadcast journal directory is invalid");
  }
  return {
    path,
    requestId,
    expectedSender: expectedSender.toLowerCase(),
    expectedCallPlan: parseExpectedCallPlan(expectedCallPlanRaw),
  };
}

function parseRawTransactionIntent(raw) {
  if (raw.length > 4_096) {
    throw new Error("Agent Boost raw transaction intent is too large");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Agent Boost raw transaction intent is invalid JSON");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "data,from,maxFeeWei,maxGas,to,valueWei,version" ||
    value.version !== 1 ||
    typeof value.from !== "string" ||
    !ADDRESS_RE.test(value.from) ||
    typeof value.to !== "string" ||
    !ADDRESS_RE.test(value.to) ||
    typeof value.valueWei !== "string" ||
    !DECIMAL_UINT_RE.test(value.valueWei) ||
    typeof value.data !== "string" ||
    !BYTES_RE.test(value.data) ||
    typeof value.maxGas !== "string" ||
    !DECIMAL_UINT_RE.test(value.maxGas) ||
    typeof value.maxFeeWei !== "string" ||
    !DECIMAL_UINT_RE.test(value.maxFeeWei)
  ) {
    throw new Error("Agent Boost raw transaction intent is malformed");
  }
  const maxGas = BigInt(value.maxGas);
  const maxFeeWei = BigInt(value.maxFeeWei);
  if (BigInt(value.valueWei) <= 0n || maxGas <= 0n || maxFeeWei <= 0n) {
    throw new Error("Agent Boost raw transaction intent has invalid limits");
  }
  return {
    from: value.from.toLowerCase(),
    to: value.to.toLowerCase(),
    valueWei: BigInt(value.valueWei),
    data: value.data.toLowerCase(),
    maxGas,
    maxFeeWei,
  };
}

function parseRawTransactionJournalConfig() {
  const path = process.env.AGENT_BOOST_RAW_TRANSACTION_JOURNAL_PATH;
  const requestId = process.env.AGENT_BOOST_RAW_TRANSACTION_REQUEST_ID;
  const expectedIntentRaw =
    process.env.AGENT_BOOST_RAW_TRANSACTION_EXPECTED_INTENT;
  const configured = [path, requestId, expectedIntentRaw].filter(
    (value) => value !== undefined,
  ).length;
  if (configured === 0) return undefined;
  if (configured !== 3 || !path || !requestId || !expectedIntentRaw) {
    throw new Error(
      "Agent Boost raw transaction journal is incompletely configured",
    );
  }
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new Error("Agent Boost raw transaction request ID is invalid");
  }
  if (!isAbsolute(path)) {
    throw new Error("Agent Boost raw transaction journal path must be absolute");
  }
  const expectedName = `${createHash("sha256").update(requestId).digest("hex")}.json`;
  if (basename(path) !== expectedName) {
    throw new Error(
      "Agent Boost raw transaction journal path is not request-bound",
    );
  }
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(
      "Agent Boost raw transaction journal directory is invalid",
    );
  }
  return {
    path,
    requestId,
    expectedIntent: parseRawTransactionIntent(expectedIntentRaw),
  };
}

function requestedUrl(input) {
  return typeof input === "string"
    ? new URL(input).toString()
    : input instanceof URL
      ? input.toString()
      : new URL(input.url).toString();
}

function isKohakuLoopback(destination) {
  return (
    destination.protocol === "http:" &&
    destination.hostname === "127.0.0.1" &&
    destination.port !== "" &&
    destination.username === "" &&
    destination.password === "" &&
    destination.search === "" &&
    destination.hash === ""
  );
}

function isSepoliaPimlicoProxy(destination) {
  return (
    isKohakuLoopback(destination) &&
    destination.pathname === "/v2/11155111/rpc"
  );
}

function assertQuantity(value, label, { positive = false } = {}) {
  if (typeof value !== "string" || !QUANTITY_RE.test(value)) {
    throw new Error(`Agent Boost rejected a malformed ${label}`);
  }
  const parsed = BigInt(value);
  if (positive && parsed <= 0n) {
    throw new Error(`Agent Boost rejected a zero ${label}`);
  }
  return parsed;
}

function assertExactUserOperation(value, expectedSender) {
  if (!isRecord(value)) {
    throw new Error("Agent Boost rejected a malformed UserOperation");
  }
  if (Object.keys(value).sort().join(",") !== USER_OPERATION_KEYS.join(",")) {
    throw new Error("Agent Boost rejected unexpected UserOperation fields");
  }
  if (
    typeof value.sender !== "string" ||
    !ADDRESS_RE.test(value.sender) ||
    value.sender.toLowerCase() !== expectedSender
  ) {
    throw new Error("Agent Boost rejected a mismatched UserOperation sender");
  }
  if (
    typeof value.paymaster !== "string" ||
    value.paymaster.toLowerCase() !== SEPOLIA_TORNADO_PAYMASTER
  ) {
    throw new Error("Agent Boost rejected an unapproved UserOperation paymaster");
  }
  if (
    typeof value.callData !== "string" ||
    !BYTES_RE.test(value.callData) ||
    value.callData === "0x" ||
    typeof value.paymasterData !== "string" ||
    !BYTES_RE.test(value.paymasterData) ||
    value.paymasterData === "0x" ||
    typeof value.signature !== "string" ||
    !SIGNATURE_RE.test(value.signature)
  ) {
    throw new Error("Agent Boost rejected malformed UserOperation bytes");
  }
  const nonce = assertQuantity(value.nonce, "UserOperation nonce");
  if (nonce !== 0n) {
    throw new Error("Agent Boost rejected a nonzero UserOperation nonce");
  }
  assertQuantity(value.callGasLimit, "UserOperation call gas", { positive: true });
  assertQuantity(value.verificationGasLimit, "UserOperation verification gas", {
    positive: true,
  });
  assertQuantity(value.preVerificationGas, "UserOperation pre-verification gas", {
    positive: true,
  });
  assertQuantity(
    value.paymasterVerificationGasLimit,
    "UserOperation paymaster verification gas",
    { positive: true },
  );
  assertQuantity(
    value.paymasterPostOpGasLimit,
    "UserOperation paymaster post-op gas",
    { positive: true },
  );
  const maxFee = assertQuantity(value.maxFeePerGas, "UserOperation max fee", {
    positive: true,
  });
  const priorityFee = assertQuantity(
    value.maxPriorityFeePerGas,
    "UserOperation priority fee",
    { positive: true },
  );
  if (priorityFee > maxFee) {
    throw new Error("Agent Boost rejected an invalid UserOperation gas price");
  }
  const authorization = value.eip7702Auth;
  if (
    !isRecord(authorization) ||
    Object.keys(authorization).sort().join(",") !==
      "address,chainId,nonce,r,s,yParity" ||
    typeof authorization.address !== "string" ||
    authorization.address.toLowerCase() !== SIMPLE_7702_IMPLEMENTATION ||
    authorization.chainId !== "0xaa36a7" ||
    authorization.nonce !== "0x0" ||
    typeof authorization.r !== "string" ||
    !BYTES32_RE.test(authorization.r) ||
    typeof authorization.s !== "string" ||
    !BYTES32_RE.test(authorization.s) ||
    !["0x0", "0x1", "0x00", "0x01"].includes(authorization.yParity)
  ) {
    throw new Error("Agent Boost rejected a malformed EIP-7702 authorization");
  }
  return value;
}

function assertUserOperationGasFloors(value, expected) {
  for (const [key, label] of [
    ["callGasLimit", "call gas"],
    ["verificationGasLimit", "verification gas"],
    ["preVerificationGas", "pre-verification gas"],
    ["paymasterVerificationGasLimit", "paymaster verification gas"],
    ["paymasterPostOpGasLimit", "paymaster post-op gas"],
  ]) {
    const actual = assertQuantity(value[key], `UserOperation ${label}`, {
      positive: true,
    });
    if (actual < expected[key]) {
      throw new Error(
        "Agent Boost rejected UserOperation gas limits below the approved preparation",
      );
    }
  }
}

function decodeAccountCalls(callData) {
  try {
    const selector = callData.slice(0, 10).toLowerCase();
    if (selector === TORNADO_WITHDRAW_SELECTOR) {
      throw new Error("direct Tornado withdrawal cannot be an account entry call");
    }
    if (selector === AbiFunction.getSelector(EXECUTE_FUNCTION)) {
      const [target, value, data] = AbiFunction.decodeData(
        EXECUTE_FUNCTION,
        callData,
      );
      return [{
        target: target.toLowerCase(),
        value,
        data: data.toLowerCase(),
      }];
    }
    if (selector === AbiFunction.getSelector(EXECUTE_BATCH_FUNCTION)) {
      const [calls] = AbiFunction.decodeData(EXECUTE_BATCH_FUNCTION, callData);
      return calls.map((call) => ({
        target: call.target.toLowerCase(),
        value: call.value,
        data: call.data.toLowerCase(),
      }));
    }
  } catch (error) {
    throw new Error("invalid account calldata", { cause: error });
  }
  throw new Error("unapproved account call selector");
}

function assertDirectWithdrawal(call, sender, expected) {
  if (
    !call ||
    call.target !== expected.poolAddress ||
    call.value !== 0n ||
    call.data.slice(0, 10) !== TORNADO_WITHDRAW_SELECTOR
  ) {
    throw new Error("direct withdrawal call changed");
  }
  const [proof, root, nullifierHash, recipient, relayer, fee, refund] =
    AbiFunction.decodeData(TORNADO_WITHDRAW_FUNCTION, call.data);
  if (
    proof === "0x" ||
    !BYTES32_RE.test(root) ||
    !BYTES32_RE.test(nullifierHash) ||
    nullifierHash.toLowerCase() !== expected.nullifierHash ||
    recipient.toLowerCase() !== sender ||
    relayer.toLowerCase() !== ZERO_ADDRESS ||
    fee !== 0n ||
    refund !== 0n
  ) {
    throw new Error("direct withdrawal arguments changed");
  }
}

function assertApprovedCallPlan(callData, sender, expected) {
  try {
    // The second Kohaku invocation regenerates proofs, Merkle roots, and the
    // fee-derived self-change amount. Everything else stays plan-bound.
    const calls = decodeAccountCalls(callData);
    const directCount = expected.directWithdrawals.length;
    if (calls.length < directCount + 1 || calls.length > directCount + 2) {
      throw new Error("call count changed");
    }
    for (let index = 0; index < directCount; index += 1) {
      assertDirectWithdrawal(
        calls[index],
        sender,
        expected.directWithdrawals[index],
      );
    }
    const remainder = calls.slice(directCount);
    let privateChange;
    if (remainder.length === 2) {
      const change = remainder[0];
      if (
        change.target !== sender ||
        change.data !== "0x" ||
        change.value <= 0n
      ) {
        throw new Error("private change call changed");
      }
      privateChange = change;
    }
    const tail = remainder.at(-1);
    if (
      !tail ||
      tail.target !== expected.tailCall.target ||
      tail.data !== expected.tailCall.data ||
      tail.value !== expected.tailCall.valueWei
    ) {
      throw new Error("requested tail call changed");
    }
    const totalCallValueWei = calls.reduce(
      (total, call) => total + call.value,
      0n,
    );
    const actualFeeReserveWei =
      expected.withdrawalAmountWei - totalCallValueWei;
    if (
      actualFeeReserveWei <= 0n ||
      actualFeeReserveWei > expected.maxFeeReserveWei
    ) {
      throw new Error("paymaster fee reserve exceeds the approved cap");
    }
    // A value CALL back to the same 7702 sender is balance-neutral. Still cap
    // sponsorship so the post-withdrawal balance can fund it and the tail.
    const largestRequiredBalanceWei = privateChange !== undefined &&
        privateChange.value > tail.value
      ? privateChange.value
      : tail.value;
    const safeSponsorshipFeeWei =
      expected.withdrawalAmountWei - largestRequiredBalanceWei;
    if (safeSponsorshipFeeWei <= 0n) {
      throw new Error("paymaster sponsorship leaves insufficient call balance");
    }
    return safeSponsorshipFeeWei;
  } catch (error) {
    throw new Error(
      "Agent Boost rejected UserOperation callData that changed after the approved dry run",
      { cause: error },
    );
  }
}

function assertApprovedPaymasterData(
  paymasterData,
  sender,
  expected,
  safeSponsorshipFeeWei,
  approvedMaxFeeReserveWei,
) {
  try {
    const [{ adapter: adapterAddress, adapterData }] = AbiParameters.decode(
      PAYMASTER_DATA_PARAMETERS,
      paymasterData,
    );
    const [{ proof, root, nullifierHash, recipient, relayer, fee, refund }] =
      AbiParameters.decode(TORNADO_SPONSOR_PARAMETERS, adapterData);
    if (
      AbiParameters.encode(PAYMASTER_DATA_PARAMETERS, [{
        adapter: adapterAddress,
        adapterData,
      }]).toLowerCase() !== paymasterData.toLowerCase() ||
      AbiParameters.encode(TORNADO_SPONSOR_PARAMETERS, [{
        proof,
        root,
        nullifierHash,
        recipient,
        relayer,
        fee,
        refund,
      }]).toLowerCase() !== adapterData.toLowerCase() ||
      adapterAddress.toLowerCase() !== expected.adapterAddress ||
      proof === "0x" ||
      !BYTES32_RE.test(root) ||
      !BYTES32_RE.test(nullifierHash) ||
      nullifierHash.toLowerCase() !== expected.nullifierHash ||
      recipient.toLowerCase() !== sender ||
      relayer.toLowerCase() !== SEPOLIA_TORNADO_PAYMASTER ||
      fee <= 0n ||
      fee > safeSponsorshipFeeWei ||
      fee > approvedMaxFeeReserveWei ||
      refund !== 0n
    ) {
      throw new Error("sponsored Tornado withdrawal changed");
    }
  } catch (error) {
    throw new Error(
      "Agent Boost rejected UserOperation paymasterData that changed after the approved dry run",
      { cause: error },
    );
  }
}

function decodeSignedRawTransaction(serialized) {
  if (
    typeof serialized !== "string" ||
    !BYTES_RE.test(serialized) ||
    serialized.length < 4 ||
    serialized.length > 262_146
  ) {
    throw new Error("malformed signed transaction bytes");
  }
  let envelope;
  let transactionType;
  let getSignPayload;
  let hash;
  const prefix = serialized.slice(0, 4).toLowerCase();
  if (prefix === "0x02") {
    envelope = TxEnvelopeEip1559.deserialize(serialized);
    transactionType = "eip1559";
    getSignPayload = TxEnvelopeEip1559.getSignPayload;
    hash = TxEnvelopeEip1559.hash;
  } else if (prefix === "0x01") {
    envelope = TxEnvelopeEip2930.deserialize(serialized);
    transactionType = "eip2930";
    getSignPayload = TxEnvelopeEip2930.getSignPayload;
    hash = TxEnvelopeEip2930.hash;
  } else if (Number.parseInt(prefix.slice(2), 16) >= 0xc0) {
    envelope = TxEnvelopeLegacy.deserialize(serialized);
    transactionType = "legacy";
    getSignPayload = TxEnvelopeLegacy.getSignPayload;
    hash = TxEnvelopeLegacy.hash;
  } else {
    throw new Error("unapproved transaction envelope type");
  }
  const signature = Signature.extract(envelope);
  if (!signature || signature.yParity === undefined) {
    throw new Error("unsigned transaction envelope");
  }
  Signature.assert(signature);
  const from = Secp256k1.recoverAddress({
    payload: getSignPayload(envelope),
    signature,
  }).toLowerCase();
  if (
    envelope.chainId !== SEPOLIA_CHAIN_ID ||
    typeof envelope.nonce !== "bigint" ||
    envelope.nonce < 0n ||
    envelope.nonce > MAX_SAFE_TRANSACTION_NONCE ||
    typeof envelope.gas !== "bigint" ||
    envelope.gas <= 0n ||
    typeof envelope.to !== "string" ||
    !ADDRESS_RE.test(envelope.to) ||
    typeof (envelope.value ?? 0n) !== "bigint" ||
    typeof (envelope.data ?? "0x") !== "string" ||
    !BYTES_RE.test(envelope.data ?? "0x")
  ) {
    throw new Error("malformed Sepolia transaction envelope");
  }
  if (
    transactionType !== "legacy" &&
    envelope.accessList !== undefined &&
    (!Array.isArray(envelope.accessList) || envelope.accessList.length !== 0)
  ) {
    throw new Error("nonempty access list");
  }
  let feePerGas;
  if (transactionType === "eip1559") {
    if (
      typeof envelope.maxFeePerGas !== "bigint" ||
      envelope.maxFeePerGas <= 0n ||
      typeof envelope.maxPriorityFeePerGas !== "bigint" ||
      envelope.maxPriorityFeePerGas < 0n ||
      envelope.maxPriorityFeePerGas > envelope.maxFeePerGas
    ) {
      throw new Error("unsafe dynamic transaction fees");
    }
    feePerGas = envelope.maxFeePerGas;
  } else {
    if (typeof envelope.gasPrice !== "bigint" || envelope.gasPrice <= 0n) {
      throw new Error("unsafe transaction gas price");
    }
    feePerGas = envelope.gasPrice;
  }
  return {
    transactionHash: hash(envelope).toLowerCase(),
    transactionType,
    from,
    to: envelope.to.toLowerCase(),
    valueWei: envelope.value ?? 0n,
    data: (envelope.data ?? "0x").toLowerCase(),
    nonce: envelope.nonce,
    gas: envelope.gas,
    feePerGas,
  };
}

function assertApprovedRawTransaction(transaction, expected) {
  const pendingNonce = observedPendingNonces.get(expected.from);
  if (pendingNonce === undefined) {
    throw new Error("missing a stable pending nonce observation");
  }
  if (
    transaction.from !== expected.from ||
    transaction.to !== expected.to ||
    transaction.valueWei !== expected.valueWei ||
    transaction.data !== expected.data
  ) {
    throw new Error("signed transaction changed the approved call");
  }
  if (transaction.nonce !== pendingNonce) {
    throw new Error("signed transaction changed the pending nonce");
  }
  if (transaction.gas > expected.maxGas) {
    throw new Error("signed transaction gas exceeds the approved ceiling");
  }
  if (transaction.gas * transaction.feePerGas > expected.maxFeeWei) {
    throw new Error("signed transaction fee exceeds the approved reserve");
  }
}

function userOperationHash(value) {
  const rpc = {
    sender: value.sender,
    nonce: value.nonce,
    callData: value.callData,
    callGasLimit: value.callGasLimit,
    verificationGasLimit: value.verificationGasLimit,
    preVerificationGas: value.preVerificationGas,
    maxFeePerGas: value.maxFeePerGas,
    maxPriorityFeePerGas: value.maxPriorityFeePerGas,
    paymaster: value.paymaster,
    paymasterVerificationGasLimit: value.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: value.paymasterPostOpGasLimit,
    paymasterData: value.paymasterData,
    signature: value.signature,
  };
  return UserOperation.hash(UserOperation.fromRpc(rpc), {
    chainId: SEPOLIA_CHAIN_ID,
    entryPointAddress: ENTRY_POINT_V08,
    entryPointVersion: "0.8",
  });
}

function writeJournal(path, checkpoint) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fileDescriptor;
  try {
    fileDescriptor = openSync(tempPath, "wx", 0o600);
    writeFileSync(fileDescriptor, `${JSON.stringify(checkpoint)}\n`, "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    linkSync(tempPath, path);
    const directoryDescriptor = openSync(dirname(path), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function requestBody(input, init) {
  const request = new Request(input, init);
  if (request.method !== "POST") return undefined;
  const text = await request.clone().text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function assertExpectedBroadcastMode(input, init) {
  const payload = await requestBody(input, init);
  const sendEntries = rpcEntries(payload).filter(
    (entry) => isRecord(entry) && typeof entry.method === "string" &&
      /^(?:eth|wallet)_send/iu.test(entry.method),
  );
  if (sendEntries.length === 0) return;
  const expectedMethod = journalConfig
    ? "eth_sendUserOperation"
    : rawTransactionJournalConfig
      ? "eth_sendRawTransaction"
      : undefined;
  if (
    expectedMethod === undefined ||
    sendEntries.some((entry) => entry.method !== expectedMethod)
  ) {
    throw new Error(
      "Agent Boost rejected a broadcast method outside the active journal mode",
    );
  }
}

async function journalActualPrivateSend(input, init) {
  if (!journalConfig) return;
  const destination = new URL(requestedUrl(input));
  const payload = await requestBody(input, init);
  const containsSend = Array.isArray(payload)
    ? payload.some((entry) => isRecord(entry) && entry.method === "eth_sendUserOperation")
    : isRecord(payload) && payload.method === "eth_sendUserOperation";
  if (!containsSend) return;
  if (!isSepoliaPimlicoProxy(destination)) {
    throw new Error("Agent Boost rejected a private broadcast outside Sepolia Pimlico");
  }
  if (
    !isRecord(payload) ||
    payload.jsonrpc !== "2.0" ||
    !Array.isArray(payload.params) ||
    payload.params.length !== 2
  ) {
    throw new Error("Agent Boost rejected a malformed private broadcast request");
  }
  const [rawUserOperation, rawEntryPoint] = payload.params;
  if (
    typeof rawEntryPoint !== "string" ||
    rawEntryPoint.toLowerCase() !== ENTRY_POINT_V08
  ) {
    throw new Error("Agent Boost rejected a non-v0.8 EntryPoint");
  }
  const exactUserOperation = assertExactUserOperation(
    rawUserOperation,
    journalConfig.expectedSender,
  );
  assertUserOperationGasFloors(
    exactUserOperation,
    journalConfig.expectedCallPlan.gasFloors,
  );
  const safeSponsorshipFeeWei = assertApprovedCallPlan(
    exactUserOperation.callData,
    journalConfig.expectedSender,
    journalConfig.expectedCallPlan,
  );
  assertApprovedPaymasterData(
    exactUserOperation.paymasterData,
    journalConfig.expectedSender,
    journalConfig.expectedCallPlan.sponsor,
    safeSponsorshipFeeWei,
    journalConfig.expectedCallPlan.maxFeeReserveWei,
  );
  const hash = userOperationHash(exactUserOperation);
  writeJournal(journalConfig.path, {
    version: 1,
    requestId: journalConfig.requestId,
    userOperationHash: hash,
    sender: exactUserOperation.sender.toLowerCase(),
    entryPointAddress: ENTRY_POINT_V08,
    journaledAt: new Date().toISOString(),
  });
}

function rpcEntries(payload) {
  return Array.isArray(payload) ? payload : [payload];
}

function responseForRequest(responsePayload, request) {
  return rpcEntries(responsePayload).find(
    (candidate) =>
      isRecord(candidate) &&
      Object.hasOwn(candidate, "id") &&
      candidate.id === request.id,
  );
}

async function observePendingTransactionNonces(input, init, response) {
  const config = rawTransactionJournalConfig;
  if (!config || requestedUrl(input) !== allowedUrl) return;
  const payload = await requestBody(input, init);
  const requests = rpcEntries(payload).filter((entry) =>
    isRecord(entry) &&
    entry.method === "eth_getTransactionCount" &&
    Array.isArray(entry.params) &&
    entry.params.length === 2 &&
    typeof entry.params[0] === "string" &&
    entry.params[0].toLowerCase() === config.expectedIntent.from &&
    entry.params[1] === "pending"
  );
  if (requests.length === 0) return;
  let responsePayload;
  try {
    responsePayload = await response.clone().json();
  } catch {
    return;
  }
  for (const request of requests) {
    const matchingResponse = responseForRequest(responsePayload, request);
    if (!matchingResponse) continue;
    try {
      const nonce = assertQuantity(
        matchingResponse.result,
        "pending transaction nonce",
      );
      if (nonce <= MAX_SAFE_TRANSACTION_NONCE) {
        observedPendingNonces.set(config.expectedIntent.from, nonce);
      }
    } catch {
      // A malformed or failed nonce read cannot authorize a later send.
    }
  }
}

async function journalActualRawTransactionSend(input, init) {
  const config = rawTransactionJournalConfig;
  if (!config) return;
  const requested = requestedUrl(input);
  const payload = await requestBody(input, init);
  const entries = rpcEntries(payload);
  const sendEntries = entries.filter(
    (entry) => isRecord(entry) && typeof entry.method === "string" &&
      /^(?:eth|wallet)_send/iu.test(entry.method),
  );
  if (sendEntries.length === 0) return;
  if (
    requested !== allowedUrl ||
    !isRecord(payload) ||
    sendEntries.length !== 1 ||
    sendEntries[0] !== payload ||
    payload.method !== "eth_sendRawTransaction" ||
    payload.jsonrpc !== "2.0" ||
    !Array.isArray(payload.params) ||
    payload.params.length !== 1 ||
    typeof payload.params[0] !== "string"
  ) {
    throw new Error(
      "Agent Boost rejected a malformed or batched raw transaction broadcast",
    );
  }
  let transaction;
  try {
    transaction = decodeSignedRawTransaction(payload.params[0]);
    assertApprovedRawTransaction(transaction, config.expectedIntent);
  } catch (error) {
    throw new Error(
      "Agent Boost rejected a signed transaction that changed after the approved dry run",
      { cause: error },
    );
  }
  writeJournal(config.path, {
    version: 1,
    requestId: config.requestId,
    transactionHash: transaction.transactionHash,
    from: transaction.from,
    to: transaction.to,
    valueWei: transaction.valueWei.toString(),
    data: transaction.data,
    chainId: SEPOLIA_CHAIN_ID,
    nonce: transaction.nonce.toString(),
    gas: transaction.gas.toString(),
    transactionType: transaction.transactionType,
    journaledAt: new Date().toISOString(),
  });
}

function guardedNativeFetch(input, init) {
  const requested = requestedUrl(input);
  const destination = new URL(requested);
  if (requested !== allowedUrl && !isKohakuLoopback(destination)) {
    return Promise.reject(new Error("Agent Boost blocked a direct Kohaku network fetch"));
  }
  return nativeFetch(input, init);
}

let installedFetch = guardedNativeFetch;
Object.defineProperty(globalThis, "fetch", {
  configurable: false,
  enumerable: true,
  get() {
    return installedFetch;
  },
  // Pinned Kohaku captures guardedNativeFetch as its clearnet transport, then
  // assigns its Tor-aware wrapper. Interpose on that assignment so the exact
  // request is durably journaled before the wrapper reaches the local proxy.
  set(value) {
    if (typeof value !== "function") {
      throw new TypeError("Agent Boost rejected an invalid Kohaku fetch wrapper");
    }
    installedFetch = async function agentBoostJournaledFetch(input, init) {
      await assertExpectedBroadcastMode(input, init);
      await journalActualPrivateSend(input, init);
      await journalActualRawTransactionSend(input, init);
      const response = await value.call(this, input, init);
      await observePendingTransactionNonces(input, init, response);
      return response;
    };
  },
});
