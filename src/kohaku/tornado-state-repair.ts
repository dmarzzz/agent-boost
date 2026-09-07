import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  constants as fsConstants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const WALLET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TORNADO_STORAGE_KEY_PREFIX = "tornado-cash-state-";
const SHADOW_DIRECTORY_PREFIX = ".agent-boost-tornado-repair-";
const STAGED_FILE_PREFIX = ".tc-storage.agent-boost-repair-";
const BACKUP_FILE_PREFIX = ".tc-storage.agent-boost-root-repair-";
const PBKDF2_ITERATIONS = 310_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const MAX_PASSWORD_BYTES = 64 * 1024;
const MAX_TORNADO_STORAGE_BYTES = 128 * 1024 * 1024;
const COPY_BUFFER_BYTES = 256 * 1024;
const CHECKPOINT_RE = /^(?:0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)|(?:0|[1-9][0-9]*))$/;
const TRANSACTION_HASH_QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;

export type TornadoStateRepairErrorCode =
  | "invalid-input"
  | "unsafe-live-state"
  | "invalid-encrypted-state"
  | "invalid-candidate-state"
  | "candidate-failed"
  | "concurrent-change"
  | "cleanup-failed"
  | "promotion-failed";

/**
 * Deliberately contains neither command output nor filesystem paths. Callers may
 * safely map the code to a narrow recovery decision without disclosing wallet
 * material that a candidate process included in an exception.
 */
export class TornadoStateRepairError extends Error {
  readonly code: TornadoStateRepairErrorCode;

  constructor(code: TornadoStateRepairErrorCode) {
    super(errorMessage(code));
    this.name = "TornadoStateRepairError";
    this.code = code;
  }
}

export interface TornadoStateRepairCandidateContext {
  /** Quarantined Kohaku dataDir. It contains only this wallet and artifacts. */
  readonly dataDir: string;
  readonly walletName: string;
  /** The original password file; its contents are never copied into the shadow. */
  readonly passwordFile: string;
  readonly tcStoragePath: string;
}

export interface TornadoStateRepairOptions<T> {
  readonly dataDir: string;
  readonly walletName: string;
  readonly passwordFile: string;
  /**
   * Run the exact failed operation in prepare/no-broadcast mode against the
   * supplied shadow dataDir. Resolving means the candidate is acceptable;
   * rejecting never changes the live wallet.
   */
  readonly runCandidate: (
    context: TornadoStateRepairCandidateContext,
  ) => Promise<T>;
}

interface EncryptedEnvelopeV1 {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface ParsedTornadoState {
  readonly state: Record<string, unknown>;
  readonly pools: Array<[string, Record<string, unknown>]>;
  readonly deposits: Map<string, Map<string, unknown>>;
  readonly withdrawals: Map<string, unknown>;
  readonly legacySecrets: unknown;
}

interface ParsedStore {
  readonly entries: Record<string, string>;
  readonly tornadoStates: Map<string, ParsedTornadoState>;
}

/**
 * Repairs a stale pinned-Kohaku Tornado event checkpoint transactionally.
 *
 * The callback runs only in a random, mode-0700 shadow. Its result is withheld
 * until the candidate store is authenticated, legacy private state is checked,
 * the original live ciphertext still matches its initial digest, an encrypted
 * mode-0600 backup is durable, and a same-directory atomic rename has committed.
 */
export async function repairTornadoStateWithShadow<T>(
  options: TornadoStateRepairOptions<T>,
): Promise<T> {
  const paths = await validateInputs(options);
  const originalCiphertext = await readRegularFileNoFollow(
    paths.tcStoragePath,
    MAX_TORNADO_STORAGE_BYTES,
    "unsafe-live-state",
  );
  const originalDigest = digest(originalCiphertext);
  const password = await readTrimmedPassword(paths.passwordFile);

  let originalStore: ParsedStore;
  let rewrittenCiphertext: Buffer;
  try {
    const envelope = parseEnvelope(originalCiphertext, "invalid-encrypted-state");
    const plaintext = decryptEnvelope(envelope, password, "invalid-encrypted-state");
    originalStore = parseStore(plaintext, "invalid-encrypted-state");
    const rewound = rewindPoolCheckpoints(originalStore);
    rewrittenCiphertext = encryptEnvelope(rewound, password, envelope.salt);
  } finally {
    password.fill(0);
  }

  let shadowDataDir: string | undefined;
  try {
    shadowDataDir = await mkdtemp(join(paths.dataDir, SHADOW_DIRECTORY_PREFIX));
    await chmod(shadowDataDir, 0o700);
    const shadowWalletDir = join(shadowDataDir, options.walletName);
    await copyDirectorySecure(paths.walletDir, shadowWalletDir, {
      skipNames: new Set(["tc-storage.json"]),
    });

    const liveArtifacts = join(paths.dataDir, "proving-artifacts");
    if (await pathExists(liveArtifacts)) {
      await requireDirectoryNoSymlink(liveArtifacts, "unsafe-live-state");
      await copyDirectorySecure(
        liveArtifacts,
        join(shadowDataDir, "proving-artifacts"),
        // These files are only ~tens of MiB in the pinned release. Copy them
        // so even a buggy candidate cannot mutate a shared hard-link inode.
        { skipNames: new Set() },
      );
    }

    const shadowTcStoragePath = join(shadowWalletDir, "tc-storage.json");
    await writeExclusiveFile(shadowTcStoragePath, rewrittenCiphertext, 0o600);

    let candidateResult: T;
    try {
      candidateResult = await options.runCandidate({
        dataDir: shadowDataDir,
        walletName: options.walletName,
        passwordFile: paths.passwordFile,
        tcStoragePath: shadowTcStoragePath,
      });
    } catch {
      throw new TornadoStateRepairError("candidate-failed");
    }

    const candidateCiphertext = await readRegularFileNoFollow(
      shadowTcStoragePath,
      MAX_TORNADO_STORAGE_BYTES,
      "invalid-candidate-state",
    );
    const candidatePassword = await readTrimmedPassword(paths.passwordFile);
    try {
      const candidateEnvelope = parseEnvelope(
        candidateCiphertext,
        "invalid-candidate-state",
      );
      const candidatePlaintext = decryptEnvelope(
        candidateEnvelope,
        candidatePassword,
        "invalid-candidate-state",
      );
      const candidateStore = parseStore(
        candidatePlaintext,
        "invalid-candidate-state",
      );
      validateCandidatePreservesState(originalStore, candidateStore);
    } finally {
      candidatePassword.fill(0);
    }

    await removeShadowExactly(shadowDataDir);
    shadowDataDir = undefined;

    await promoteCandidate({
      walletDir: paths.walletDir,
      tcStoragePath: paths.tcStoragePath,
      originalCiphertext,
      originalDigest,
      candidateCiphertext,
    });
    return candidateResult;
  } catch (error) {
    if (error instanceof TornadoStateRepairError) throw error;
    throw new TornadoStateRepairError("unsafe-live-state");
  } finally {
    if (shadowDataDir !== undefined) {
      await rm(shadowDataDir, { recursive: true, force: true }).catch(() => {});
    }
    originalCiphertext.fill(0);
    rewrittenCiphertext.fill(0);
  }
}

async function validateInputs<T>(options: TornadoStateRepairOptions<T>): Promise<{
  dataDir: string;
  walletDir: string;
  tcStoragePath: string;
  passwordFile: string;
}> {
  if (
    !WALLET_NAME_RE.test(options.walletName) ||
    options.walletName === "proving-artifacts" ||
    options.walletName === "public-sync-cache" ||
    typeof options.runCandidate !== "function"
  ) {
    throw new TornadoStateRepairError("invalid-input");
  }
  const dataDir = resolve(options.dataDir);
  const walletDir = join(dataDir, options.walletName);
  const tcStoragePath = join(walletDir, "tc-storage.json");
  const passwordFile = resolve(options.passwordFile);
  await requireDirectoryNoSymlink(dataDir, "unsafe-live-state");
  await requireDirectoryNoSymlink(walletDir, "unsafe-live-state");
  await requireRegularFileNoSymlink(tcStoragePath, "unsafe-live-state");
  await requireRegularFileNoSymlink(passwordFile, "unsafe-live-state");
  return { dataDir, walletDir, tcStoragePath, passwordFile };
}

function rewindPoolCheckpoints(store: ParsedStore): string {
  const rewritten: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [key, value] of Object.entries(store.entries)) {
    const tornadoState = store.tornadoStates.get(key);
    if (!tornadoState) {
      rewritten[key] = value;
      continue;
    }
    for (const [, pool] of tornadoState.pools) {
      pool.lastSyncedBlock = pool.registeredBlock;
    }
    rewritten[key] = JSON.stringify(tornadoState.state);
  }
  return JSON.stringify(rewritten);
}

function validateCandidatePreservesState(
  original: ParsedStore,
  candidate: ParsedStore,
): void {
  for (const [key, value] of Object.entries(original.entries)) {
    const originalTornado = original.tornadoStates.get(key);
    if (!Object.prototype.hasOwnProperty.call(candidate.entries, key)) {
      throw new TornadoStateRepairError("invalid-candidate-state");
    }
    if (!originalTornado) {
      if (candidate.entries[key] !== value) {
        throw new TornadoStateRepairError("invalid-candidate-state");
      }
      continue;
    }
    const candidateTornado = candidate.tornadoStates.get(key);
    if (
      !candidateTornado ||
      !isDeepStrictEqual(
        originalTornado.legacySecrets,
        candidateTornado.legacySecrets,
      )
    ) {
      throw new TornadoStateRepairError("invalid-candidate-state");
    }
    const candidatePools = new Map(candidateTornado.pools);
    for (const [poolKey, originalPool] of originalTornado.pools) {
      const candidatePool = candidatePools.get(poolKey);
      if (!candidatePool || !samePoolConfiguration(originalPool, candidatePool)) {
        throw new TornadoStateRepairError("invalid-candidate-state");
      }
    }
    assertNestedTupleRecordsPreserved(
      originalTornado.deposits,
      candidateTornado.deposits,
    );
    assertTupleRecordsPreserved(
      originalTornado.withdrawals,
      candidateTornado.withdrawals,
    );
  }
}

function samePoolConfiguration(
  original: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
): boolean {
  const { lastSyncedBlock: _originalCheckpoint, ...originalConfiguration } =
    original;
  const { lastSyncedBlock: _candidateCheckpoint, ...candidateConfiguration } =
    candidate;
  return isDeepStrictEqual(originalConfiguration, candidateConfiguration);
}

function parseStore(
  plaintext: string,
  errorCode: "invalid-encrypted-state" | "invalid-candidate-state",
): ParsedStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch {
    throw new TornadoStateRepairError(errorCode);
  }
  if (!isRecord(parsed)) {
    throw new TornadoStateRepairError(errorCode);
  }

  const entries: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const tornadoStates = new Map<string, ParsedTornadoState>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new TornadoStateRepairError(errorCode);
    }
    entries[key] = value;
    if (!key.startsWith(TORNADO_STORAGE_KEY_PREFIX)) continue;

    let stateValue: unknown;
    try {
      stateValue = JSON.parse(value) as unknown;
    } catch {
      throw new TornadoStateRepairError(errorCode);
    }
    if (!isRecord(stateValue) || !isRecord(stateValue.pools)) {
      throw new TornadoStateRepairError(errorCode);
    }
    const tuples = stateValue.pools.poolsTuples;
    if (!Array.isArray(tuples) || tuples.length === 0) {
      throw new TornadoStateRepairError(errorCode);
    }
    const pools: Array<[string, Record<string, unknown>]> = [];
    const seen = new Set<string>();
    for (const tuple of tuples) {
      if (
        !Array.isArray(tuple) ||
        tuple.length !== 2 ||
        typeof tuple[0] !== "string" ||
        !isRecord(tuple[1]) ||
        typeof tuple[1].registeredBlock !== "string" ||
        !CHECKPOINT_RE.test(tuple[1].registeredBlock) ||
        (tuple[1].lastSyncedBlock !== undefined &&
          (typeof tuple[1].lastSyncedBlock !== "string" ||
            !CHECKPOINT_RE.test(tuple[1].lastSyncedBlock))) ||
        seen.has(tuple[0])
      ) {
        throw new TornadoStateRepairError(errorCode);
      }
      seen.add(tuple[0]);
      pools.push([tuple[0], tuple[1]]);
    }
    tornadoStates.set(key, {
      state: stateValue,
      pools,
      deposits: parseNestedTupleRecords(
        stateValue.deposits,
        "depositsTuples",
        errorCode,
      ),
      withdrawals: parseTupleRecords(
        stateValue.withdrawals,
        "withdrawalsTuples",
        errorCode,
      ),
      legacySecrets: stateValue.legacySecrets,
    });
  }
  if (tornadoStates.size === 0) {
    throw new TornadoStateRepairError(errorCode);
  }
  return { entries, tornadoStates };
}

function parseNestedTupleRecords(
  container: unknown,
  field: string,
  errorCode: "invalid-encrypted-state" | "invalid-candidate-state",
): Map<string, Map<string, unknown>> {
  if (!isRecord(container)) {
    throw new TornadoStateRepairError(errorCode);
  }
  const outer = parseTupleRecords(container[field], undefined, errorCode);
  const result = new Map<string, Map<string, unknown>>();
  for (const [key, value] of outer) {
    result.set(key, parseTupleRecords(value, undefined, errorCode));
  }
  return result;
}

function parseTupleRecords(
  container: unknown,
  field: string | undefined,
  errorCode: "invalid-encrypted-state" | "invalid-candidate-state",
): Map<string, unknown> {
  const tuples = field === undefined
    ? container
    : isRecord(container)
      ? container[field]
      : undefined;
  if (!Array.isArray(tuples)) {
    throw new TornadoStateRepairError(errorCode);
  }
  const result = new Map<string, unknown>();
  for (const tuple of tuples) {
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 2 ||
      typeof tuple[0] !== "string" ||
      result.has(tuple[0])
    ) {
      throw new TornadoStateRepairError(errorCode);
    }
    result.set(tuple[0], tuple[1]);
  }
  return result;
}

function assertNestedTupleRecordsPreserved(
  original: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
  candidate: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
): void {
  for (const [pool, originalRecords] of original) {
    const candidateRecords = candidate.get(pool);
    if (!candidateRecords) {
      throw new TornadoStateRepairError("invalid-candidate-state");
    }
    assertTupleRecordsPreserved(originalRecords, candidateRecords);
  }
}

function assertTupleRecordsPreserved(
  original: ReadonlyMap<string, unknown>,
  candidate: ReadonlyMap<string, unknown>,
): void {
  for (const [key, value] of original) {
    if (
      !candidate.has(key) ||
      !isSemanticallyPreservedEvent(value, candidate.get(key))
    ) {
      throw new TornadoStateRepairError("invalid-candidate-state");
    }
  }
}

function isSemanticallyPreservedEvent(
  original: unknown,
  candidate: unknown,
): boolean {
  if (isDeepStrictEqual(original, candidate)) return true;
  if (!isRecord(original) || !isRecord(candidate)) return false;
  // Kohaku's bundled public sync seed uses 0x0 transaction hashes, while RPC
  // events use serialized (minimal-hex) hashes. A later Saga-covered replay
  // may also replace an RPC hash with 0x0. The commitment/nullifier tuple key
  // and every other event field bind identity, so permit only a canonical
  // nonzero hash to normalize to/from that explicit placeholder. Two different
  // nonzero hashes are never interchangeable.
  if (
    typeof original.transactionHash !== "string" ||
    !TRANSACTION_HASH_QUANTITY_RE.test(original.transactionHash) ||
    typeof candidate.transactionHash !== "string" ||
    !TRANSACTION_HASH_QUANTITY_RE.test(candidate.transactionHash) ||
    (original.transactionHash !== "0x0" && candidate.transactionHash !== "0x0")
  ) {
    return false;
  }
  const {
    transactionHash: _originalTransactionHash,
    ...originalWithoutTransactionHash
  } = original;
  const {
    transactionHash: _candidateTransactionHash,
    ...candidateWithoutTransactionHash
  } = candidate;
  return isDeepStrictEqual(
    originalWithoutTransactionHash,
    candidateWithoutTransactionHash,
  );
}

function parseEnvelope(
  data: Buffer,
  errorCode: "invalid-encrypted-state" | "invalid-candidate-state",
): EncryptedEnvelopeV1 {
  let value: unknown;
  try {
    value = JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    throw new TornadoStateRepairError(errorCode);
  }
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.salt !== "string" ||
    typeof value.iv !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.ciphertext !== "string"
  ) {
    throw new TornadoStateRepairError(errorCode);
  }
  const salt = decodeCanonicalBase64(value.salt, errorCode);
  const iv = decodeCanonicalBase64(value.iv, errorCode);
  const tag = decodeCanonicalBase64(value.tag, errorCode);
  const ciphertext = decodeCanonicalBase64(value.ciphertext, errorCode);
  if (
    salt.byteLength !== SALT_LENGTH ||
    iv.byteLength !== GCM_IV_LENGTH ||
    tag.byteLength !== GCM_TAG_LENGTH ||
    ciphertext.byteLength === 0
  ) {
    throw new TornadoStateRepairError(errorCode);
  }
  return {
    v: 1,
    salt: value.salt,
    iv: value.iv,
    tag: value.tag,
    ciphertext: value.ciphertext,
  };
}

function decryptEnvelope(
  envelope: EncryptedEnvelopeV1,
  password: Buffer,
  errorCode: "invalid-encrypted-state" | "invalid-candidate-state",
): string {
  const salt = Buffer.from(envelope.salt, "base64");
  const key = pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    "sha256",
  );
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
      { authTagLength: GCM_TAG_LENGTH },
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new TornadoStateRepairError(errorCode);
  } finally {
    key.fill(0);
  }
}

function encryptEnvelope(
  plaintext: string,
  password: Buffer,
  saltBase64: string,
): Buffer {
  const salt = Buffer.from(saltBase64, "base64");
  const key = pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    "sha256",
  );
  try {
    const iv = randomBytes(GCM_IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: GCM_TAG_LENGTH,
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const envelope: EncryptedEnvelopeV1 = {
      v: 1,
      salt: saltBase64,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    return Buffer.from(JSON.stringify(envelope, null, 2), "utf8");
  } finally {
    key.fill(0);
  }
}

async function promoteCandidate(input: {
  walletDir: string;
  tcStoragePath: string;
  originalCiphertext: Buffer;
  originalDigest: Buffer;
  candidateCiphertext: Buffer;
}): Promise<void> {
  await assertDigestUnchanged(input.tcStoragePath, input.originalDigest);
  const nonce = randomUUID().replaceAll("-", "");
  const backupPath = join(
    input.walletDir,
    `${BACKUP_FILE_PREFIX}${Date.now().toString()}-${nonce}.bak`,
  );
  const stagePath = join(input.walletDir, `${STAGED_FILE_PREFIX}${nonce}.tmp`);
  let committed = false;
  let backupWritten = false;
  try {
    await writeExclusiveFile(backupPath, input.originalCiphertext, 0o600);
    backupWritten = true;
    await writeExclusiveFile(stagePath, input.candidateCiphertext, 0o600);
    await assertDigestUnchanged(input.tcStoragePath, input.originalDigest);
    await syncDirectory(input.walletDir);
    await rename(stagePath, input.tcStoragePath);
    committed = true;
    await syncDirectory(input.walletDir).catch(() => {});
  } catch (error) {
    if (error instanceof TornadoStateRepairError) throw error;
    throw new TornadoStateRepairError("promotion-failed");
  } finally {
    if (!committed) {
      await rm(stagePath, { force: true }).catch(() => {});
      if (backupWritten) await rm(backupPath, { force: true }).catch(() => {});
    }
  }
}

async function assertDigestUnchanged(
  path: string,
  expected: Buffer,
): Promise<void> {
  let current: Buffer;
  try {
    current = await readRegularFileNoFollow(
      path,
      MAX_TORNADO_STORAGE_BYTES,
      "concurrent-change",
    );
  } catch {
    throw new TornadoStateRepairError("concurrent-change");
  }
  try {
    const currentDigest = digest(current);
    if (!timingSafeEqual(expected, currentDigest)) {
      throw new TornadoStateRepairError("concurrent-change");
    }
  } finally {
    current.fill(0);
  }
}

async function readTrimmedPassword(path: string): Promise<Buffer> {
  const bytes = await readRegularFileNoFollow(
    path,
    MAX_PASSWORD_BYTES,
    "unsafe-live-state",
  );
  const trimmed = Buffer.from(bytes.toString("utf8").trim(), "utf8");
  bytes.fill(0);
  if (trimmed.byteLength === 0) {
    throw new TornadoStateRepairError("invalid-input");
  }
  return trimmed;
}

async function readRegularFileNoFollow(
  path: string,
  maxBytes: number,
  errorCode: TornadoStateRepairErrorCode,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > maxBytes ||
      !Number.isSafeInteger(metadata.size)
    ) {
      throw new TornadoStateRepairError(errorCode);
    }
    const result = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < result.byteLength) {
      const { bytesRead } = await handle.read(
        result,
        offset,
        result.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) throw new TornadoStateRepairError(errorCode);
      offset += bytesRead;
    }
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(
      overflow,
      0,
      1,
      result.byteLength,
    );
    if (overflowBytes !== 0) throw new TornadoStateRepairError(errorCode);
    return result;
  } catch (error) {
    if (error instanceof TornadoStateRepairError) throw error;
    throw new TornadoStateRepairError(errorCode);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function copyDirectorySecure(
  source: string,
  destination: string,
  options: { skipNames: ReadonlySet<string> },
): Promise<void> {
  await requireDirectoryNoSymlink(source, "unsafe-live-state");
  await mkdir(destination, { mode: 0o700 });
  await chmod(destination, 0o700);
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (options.skipNames.has(entry.name)) continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const metadata = await lstat(sourcePath).catch(() => {
      throw new TornadoStateRepairError("unsafe-live-state");
    });
    if (metadata.isSymbolicLink()) {
      throw new TornadoStateRepairError("unsafe-live-state");
    }
    if (metadata.isDirectory()) {
      await copyDirectorySecure(sourcePath, destinationPath, options);
      continue;
    }
    if (!metadata.isFile()) {
      throw new TornadoStateRepairError("unsafe-live-state");
    }
    await copyRegularFileSecure(sourcePath, destinationPath);
  }
}

async function copyRegularFileSecure(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  let source;
  let destination;
  try {
    source = await open(
      sourcePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const initial = await source.stat();
    if (!initial.isFile() || !Number.isSafeInteger(initial.size)) {
      throw new TornadoStateRepairError("unsafe-live-state");
    }
    destination = await open(
      destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let offset = 0;
    while (offset < initial.size) {
      const length = Math.min(buffer.byteLength, initial.size - offset);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead === 0) {
        throw new TornadoStateRepairError("unsafe-live-state");
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          offset + written,
        );
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    const after = await source.stat();
    if (
      after.size !== initial.size ||
      after.mtimeMs !== initial.mtimeMs ||
      after.ctimeMs !== initial.ctimeMs
    ) {
      throw new TornadoStateRepairError("unsafe-live-state");
    }
    await destination.sync();
  } catch (error) {
    if (error instanceof TornadoStateRepairError) throw error;
    throw new TornadoStateRepairError("unsafe-live-state");
  } finally {
    await source?.close().catch(() => {});
    await destination?.close().catch(() => {});
  }
  await chmod(destinationPath, 0o600);
}

async function writeExclusiveFile(
  path: string,
  contents: Buffer,
  mode: number,
): Promise<void> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      mode,
    );
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  await chmod(path, mode);
}

async function removeShadowExactly(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: false });
    if (await pathExists(path)) {
      throw new Error("shadow remained");
    }
  } catch {
    throw new TornadoStateRepairError("cleanup-failed");
  }
}

async function requireDirectoryNoSymlink(
  path: string,
  errorCode: TornadoStateRepairErrorCode,
): Promise<void> {
  const metadata = await lstat(path).catch(() => {
    throw new TornadoStateRepairError(errorCode);
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TornadoStateRepairError(errorCode);
  }
}

async function requireRegularFileNoSymlink(
  path: string,
  errorCode: TornadoStateRepairErrorCode,
): Promise<void> {
  const metadata = await lstat(path).catch(() => {
    throw new TornadoStateRepairError(errorCode);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TornadoStateRepairError(errorCode);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== "ENOENT";
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function decodeCanonicalBase64(
  value: string,
  errorCode: "invalid-encrypted-state" | "invalid-candidate-state",
): Buffer {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new TornadoStateRepairError(errorCode);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new TornadoStateRepairError(errorCode);
  }
  return decoded;
}

function digest(contents: Buffer): Buffer {
  return createHash("sha256").update(contents).digest();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(code: TornadoStateRepairErrorCode): string {
  switch (code) {
    case "invalid-input":
      return "Tornado state repair input is invalid";
    case "unsafe-live-state":
      return "Tornado state repair refused unsafe wallet state";
    case "invalid-encrypted-state":
      return "Tornado state repair could not validate encrypted wallet state";
    case "invalid-candidate-state":
      return "Tornado state repair candidate state is invalid";
    case "candidate-failed":
      return "Tornado state repair candidate failed";
    case "concurrent-change":
      return "Tornado state repair stopped because wallet state changed concurrently";
    case "cleanup-failed":
      return "Tornado state repair could not securely remove its shadow";
    case "promotion-failed":
      return "Tornado state repair could not promote the validated candidate";
  }
}
