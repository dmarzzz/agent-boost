import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  repairTornadoStateWithShadow,
  TornadoStateRepairError,
} from "../src/kohaku/tornado-state-repair.js";

const PASSWORD = "correct horse battery staple";
const WALLET_NAME = "primary";
const STORE_KEY =
  "tornado-cash-state-11155111-123456789012345678901234567890";
const OTHER_STORE_KEY = "privacy-pool-state-11155111-987654321";
const POOL_A = "0x8c4a04d872a6c1be37964a21ba3a138525dff50b";
const POOL_B = "0x8cc930096b4df705a007c4a039bdfa1320ed2508";
const REPAIR_SHADOW_PREFIX = ".agent-boost-tornado-repair-";
const BACKUP_PREFIX = ".tc-storage.agent-boost-root-repair-";

type JsonRecord = Record<string, unknown>;

interface Fixture {
  root: string;
  dataDir: string;
  walletDir: string;
  tcStoragePath: string;
  passwordFile: string;
  originalCiphertext: Buffer;
  originalStore: Record<string, string>;
}

describe("transactional pinned-Kohaku Tornado state repair", () => {
  it("replays only in a secure shadow, preserves records, and promotes with an encrypted backup", async (t) => {
    const fixture = await createFixture(t);
    const sentinel = { prepared: true };
    let callbackReturned = false;

    const result = await repairTornadoStateWithShadow({
      dataDir: fixture.dataDir,
      walletName: WALLET_NAME,
      passwordFile: fixture.passwordFile,
      runCandidate: async (context) => {
        assert.match(context.dataDir, new RegExp(`${REPAIR_SHADOW_PREFIX}[^/]+$`));
        assert.equal(context.walletName, WALLET_NAME);
        assert.equal(context.passwordFile, fixture.passwordFile);
        assert.equal(
          await readFile(join(context.dataDir, WALLET_NAME, ".wallet-type"), "utf8"),
          "mnemonic\n",
        );
        assert.equal(
          await readFile(
            join(context.dataDir, "proving-artifacts", "nested", "witness.bin"),
            "utf8",
          ),
          "immutable proving data",
        );
        await writeFile(
          join(context.dataDir, "proving-artifacts", "nested", "witness.bin"),
          "candidate-only mutation",
          { mode: 0o600 },
        );
        assert.equal(
          await readFile(
            join(fixture.dataDir, "proving-artifacts", "nested", "witness.bin"),
            "utf8",
          ),
          "immutable proving data",
        );
        await assert.rejects(
          readFile(join(context.dataDir, "public-sync-cache", "cache.bin")),
        );

        const shadowStore = decryptStore(await readFile(context.tcStoragePath));
        const rewound = parseTornadoState(shadowStore);
        const original = parseTornadoState(fixture.originalStore);
        const rewoundPools = poolMap(rewound);
        assert.equal(rewoundPools.get(POOL_A)?.lastSyncedBlock, "0x555d20");
        assert.equal(rewoundPools.get(POOL_B)?.lastSyncedBlock, "0x555d21");
        assert.equal((rewound.sync as JsonRecord).lastSyncedBlock, "0xb19710");
        assert.deepEqual(rewound.legacySecrets, original.legacySecrets);
        assert.deepEqual(rewound.deposits, original.deposits);
        assert.deepEqual(rewound.withdrawals, original.withdrawals);
        assert.equal(shadowStore[OTHER_STORE_KEY], fixture.originalStore[OTHER_STORE_KEY]);

        const syncedPools = poolMap(rewound);
        for (const pool of syncedPools.values()) pool.lastSyncedBlock = "0xc0ffee";
        const depositPools = new Map(
          (rewound.deposits as JsonRecord).depositsTuples as Array<
            [string, Array<[string, unknown]>]
          >,
        );
        depositPools.get(POOL_A)?.push([
          "0xnew-commitment",
          { commitment: "0xnew-commitment", leafIndex: "0x2", blockNumber: "0xc0ffee" },
        ]);
        const priorDeposit = depositPools.get(POOL_A)?.[0]?.[1] as JsonRecord;
        priorDeposit.transactionHash = "0xabc";
        const withdrawals = new Map(
          (rewound.withdrawals as JsonRecord).withdrawalsTuples as Array<
            [string, JsonRecord]
          >,
        );
        withdrawals.get("0xold-nullifier-hash")!.transactionHash = "0x0";
        (rewound.sync as JsonRecord).lastSyncedBlock = "0xc0ffee";
        shadowStore[STORE_KEY] = JSON.stringify(rewound);
        await writeFile(context.tcStoragePath, encryptStore(shadowStore), {
          mode: 0o600,
        });
        callbackReturned = true;
        return sentinel;
      },
    });

    assert.equal(callbackReturned, true);
    assert.strictEqual(result, sentinel);
    const promotedBytes = await readFile(fixture.tcStoragePath);
    assert.notDeepEqual(promotedBytes, fixture.originalCiphertext);
    const promoted = parseTornadoState(decryptStore(promotedBytes));
    assert.equal(poolMap(promoted).get(POOL_A)?.lastSyncedBlock, "0xc0ffee");
    assert.deepEqual(
      promoted.legacySecrets,
      parseTornadoState(fixture.originalStore).legacySecrets,
    );
    const promotedDeposits = new Map(
      (promoted.deposits as JsonRecord).depositsTuples as Array<
        [string, Array<[string, JsonRecord]>]
      >,
    );
    assert.equal(
      promotedDeposits.get(POOL_A)?.[0]?.[1].transactionHash,
      "0xabc",
    );
    const promotedWithdrawals = new Map(
      (promoted.withdrawals as JsonRecord).withdrawalsTuples as Array<
        [string, JsonRecord]
      >,
    );
    assert.equal(
      promotedWithdrawals.get("0xold-nullifier-hash")?.transactionHash,
      "0x0",
    );
    assert.equal((await stat(fixture.tcStoragePath)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(
        join(fixture.dataDir, "proving-artifacts", "nested", "witness.bin"),
        "utf8",
      ),
      "immutable proving data",
    );

    const walletEntries = await readdir(fixture.walletDir);
    const backups = walletEntries.filter((name) => name.startsWith(BACKUP_PREFIX));
    assert.equal(backups.length, 1);
    const backupPath = join(fixture.walletDir, backups[0]!);
    assert.deepEqual(await readFile(backupPath), fixture.originalCiphertext);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    await assertNoTransientFiles(fixture);
  });

  it("keeps live bytes unchanged and leaks no candidate output when the shadow run fails", async (t) => {
    const fixture = await createFixture(t);
    await assert.rejects(
      repairTornadoStateWithShadow({
        dataDir: fixture.dataDir,
        walletName: WALLET_NAME,
        passwordFile: fixture.passwordFile,
        runCandidate: async () => {
          throw new Error("secret stdout and private note material");
        },
      }),
      (error: unknown) => {
        assertRepairError(error, "candidate-failed");
        assert.doesNotMatch((error as Error).message, /secret|private note/i);
        return true;
      },
    );
    assert.deepEqual(await readFile(fixture.tcStoragePath), fixture.originalCiphertext);
    await assertNoTransientFiles(fixture);
  });

  it("rejects candidates that lose or mutate prior private state", async (t) => {
    for (const lost of [
      "deposit",
      "withdrawal",
      "legacy",
      "event-field",
      "invalid-hash",
      "hash-substitution",
      "pool-config",
    ] as const) {
      await t.test(lost, async (subtest) => {
        const fixture = await createFixture(subtest);
        await assert.rejects(
          repairTornadoStateWithShadow({
            dataDir: fixture.dataDir,
            walletName: WALLET_NAME,
            passwordFile: fixture.passwordFile,
            runCandidate: async ({ tcStoragePath }) => {
              const store = decryptStore(await readFile(tcStoragePath));
              const state = parseTornadoState(store);
              if (lost === "deposit") {
                (state.deposits as JsonRecord).depositsTuples = [];
              } else if (lost === "withdrawal") {
                (state.withdrawals as JsonRecord).withdrawalsTuples = [];
              } else if (lost === "legacy") {
                state.legacySecrets = { byPool: [] };
              } else if (lost === "pool-config") {
                poolMap(state).get(POOL_A)!.denomination = "0x1";
              } else if (lost === "hash-substitution") {
                const withdrawals = new Map(
                  (state.withdrawals as JsonRecord).withdrawalsTuples as Array<
                    [string, JsonRecord]
                  >,
                );
                withdrawals.get("0xold-nullifier-hash")!.transactionHash =
                  "0x456";
              } else {
                const deposits = new Map(
                  (state.deposits as JsonRecord).depositsTuples as Array<
                    [string, Array<[string, JsonRecord]>]
                  >,
                );
                const record = deposits.get(POOL_A)![0]![1];
                if (lost === "event-field") record.blockNumber = "0xdead";
                else record.transactionHash = "0x00";
              }
              store[STORE_KEY] = JSON.stringify(state);
              await writeFile(tcStoragePath, encryptStore(store), { mode: 0o600 });
              return "must-not-return";
            },
          }),
          (error: unknown) => {
            assertRepairError(error, "invalid-candidate-state");
            return true;
          },
        );
        assert.deepEqual(await readFile(fixture.tcStoragePath), fixture.originalCiphertext);
        await assertNoTransientFiles(fixture);
      });
    }
  });

  it("uses a ciphertext digest CAS and never overwrites a concurrent live update", async (t) => {
    const fixture = await createFixture(t);
    const concurrentStore = structuredClone(fixture.originalStore);
    concurrentStore["concurrent-writer"] = JSON.stringify({ marker: "winner" });
    const concurrentCiphertext = encryptStore(concurrentStore);

    await assert.rejects(
      repairTornadoStateWithShadow({
        dataDir: fixture.dataDir,
        walletName: WALLET_NAME,
        passwordFile: fixture.passwordFile,
        runCandidate: async ({ tcStoragePath }) => {
          const candidate = decryptStore(await readFile(tcStoragePath));
          await writeFile(tcStoragePath, encryptStore(candidate), { mode: 0o600 });
          await writeFile(fixture.tcStoragePath, concurrentCiphertext, { mode: 0o600 });
          return "must-not-return";
        },
      }),
      (error: unknown) => {
        assertRepairError(error, "concurrent-change");
        return true;
      },
    );
    assert.deepEqual(await readFile(fixture.tcStoragePath), concurrentCiphertext);
    await assertNoTransientFiles(fixture);
  });

  it("rejects malformed and symlinked live or candidate state without touching live bytes", async (t) => {
    await t.test("malformed encrypted envelope", async (subtest) => {
      const fixture = await createFixture(subtest);
      const malformed = Buffer.from('{"v":1,"salt":"not-base64"}\n');
      await writeFile(fixture.tcStoragePath, malformed, { mode: 0o600 });
      let called = false;
      await assert.rejects(
        repairTornadoStateWithShadow({
          dataDir: fixture.dataDir,
          walletName: WALLET_NAME,
          passwordFile: fixture.passwordFile,
          runCandidate: async () => {
            called = true;
          },
        }),
        (error: unknown) => {
          assertRepairError(error, "invalid-encrypted-state");
          return true;
        },
      );
      assert.equal(called, false);
      assert.deepEqual(await readFile(fixture.tcStoragePath), malformed);
      await assertNoTransientFiles(fixture);
    });

    await t.test("live tc-storage symlink", async (subtest) => {
      const fixture = await createFixture(subtest);
      const target = join(fixture.root, "outside-tc-storage.json");
      await writeFile(target, fixture.originalCiphertext, { mode: 0o600 });
      await rm(fixture.tcStoragePath);
      await symlink(target, fixture.tcStoragePath);
      await assert.rejects(
        repairTornadoStateWithShadow({
          dataDir: fixture.dataDir,
          walletName: WALLET_NAME,
          passwordFile: fixture.passwordFile,
          runCandidate: async () => "must-not-run",
        }),
        (error: unknown) => {
          assertRepairError(error, "unsafe-live-state");
          return true;
        },
      );
      assert.equal((await lstat(fixture.tcStoragePath)).isSymbolicLink(), true);
      assert.deepEqual(await readFile(target), fixture.originalCiphertext);
      await assertNoTransientFiles(fixture);
    });

    await t.test("candidate tc-storage symlink", async (subtest) => {
      const fixture = await createFixture(subtest);
      const externalCandidate = join(fixture.root, "external-candidate.json");
      await writeFile(externalCandidate, fixture.originalCiphertext, { mode: 0o600 });
      await assert.rejects(
        repairTornadoStateWithShadow({
          dataDir: fixture.dataDir,
          walletName: WALLET_NAME,
          passwordFile: fixture.passwordFile,
          runCandidate: async ({ tcStoragePath }) => {
            await rm(tcStoragePath);
            await symlink(externalCandidate, tcStoragePath);
            return "must-not-return";
          },
        }),
        (error: unknown) => {
          assertRepairError(error, "invalid-candidate-state");
          return true;
        },
      );
      assert.deepEqual(await readFile(fixture.tcStoragePath), fixture.originalCiphertext);
      assert.deepEqual(await readFile(externalCandidate), fixture.originalCiphertext);
      await assertNoTransientFiles(fixture);
    });
  });
});

async function createFixture(t: { after(callback: () => Promise<void>): void }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-tornado-repair-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const walletDir = join(dataDir, WALLET_NAME);
  const passwordFile = join(root, "password.txt");
  const tcStoragePath = join(walletDir, "tc-storage.json");
  await mkdir(walletDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  await chmod(walletDir, 0o700);
  await writeFile(passwordFile, `  ${PASSWORD} \r\n`, { mode: 0o600 });
  await writeFile(join(walletDir, ".wallet-type"), "mnemonic\n", { mode: 0o600 });
  await writeFile(join(walletDir, ".encrypted-seed"), "opaque identity\n", {
    mode: 0o600,
  });
  await mkdir(join(dataDir, "proving-artifacts", "nested"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(dataDir, "proving-artifacts", "nested", "witness.bin"),
    "immutable proving data",
    { mode: 0o600 },
  );
  await mkdir(join(dataDir, "public-sync-cache"), { mode: 0o700 });
  await writeFile(join(dataDir, "public-sync-cache", "cache.bin"), "stale cache", {
    mode: 0o600,
  });

  const originalState: JsonRecord = {
    protocolConfig: { chainId: "0xaa36a7" },
    pools: {
      poolsTuples: [
        [
          POOL_A,
          {
            address: POOL_A,
            registeredBlock: "0x555d20",
            lastSyncedBlock: "0xb19710",
            denomination: "0x16345785d8a0000",
          },
        ],
        [
          POOL_B,
          {
            address: POOL_B,
            registeredBlock: "0x555d21",
            lastSyncedBlock: "0xb19710",
            denomination: "0xde0b6b3a7640000",
          },
        ],
      ],
    },
    deposits: {
      depositsTuples: [
        [
          POOL_A,
          [
            [
              "0xold-commitment",
              {
                commitment: "0xold-commitment",
                leafIndex: "0x1",
                blockNumber: "0x600000",
                transactionHash: "0x0",
              },
            ],
          ],
        ],
      ],
    },
    withdrawals: {
      withdrawalsTuples: [
        [
          "0xold-nullifier-hash",
          {
            nullifierHash: "0xold-nullifier-hash",
            blockNumber: "0x700000",
            transactionHash: "0x123",
          },
        ],
      ],
    },
    legacySecrets: {
      byPool: [
        [
          POOL_A,
          [
            {
              commitment: "0xold-commitment",
              nullifier: "0xprivate-nullifier",
              salt: "0xprivate-salt",
            },
          ],
        ],
      ],
    },
    sync: {
      lastSyncedBlock: "0xb19710",
      relayerRegistrySyncedBlock: "0xb19700",
    },
    untouched: { keep: [1, 2, 3] },
  };
  const originalStore = {
    [STORE_KEY]: JSON.stringify(originalState),
    [OTHER_STORE_KEY]: JSON.stringify({ ppv1: "must remain byte-identical" }),
  };
  const originalCiphertext = encryptStore(originalStore);
  await writeFile(tcStoragePath, originalCiphertext, { mode: 0o600 });
  return {
    root,
    dataDir,
    walletDir,
    tcStoragePath,
    passwordFile,
    originalCiphertext,
    originalStore,
  };
}

function encryptStore(store: Record<string, string>): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(PASSWORD, salt, 310_000, 32, "sha256");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(store), "utf8"),
      cipher.final(),
    ]);
    return Buffer.from(
      JSON.stringify(
        {
          v: 1,
          salt: salt.toString("base64"),
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
        },
        null,
        2,
      ),
    );
  } finally {
    key.fill(0);
  }
}

function decryptStore(ciphertext: Buffer): Record<string, string> {
  const envelope = JSON.parse(ciphertext.toString("utf8")) as {
    salt: string;
    iv: string;
    tag: string;
    ciphertext: string;
  };
  const key = pbkdf2Sync(
    PASSWORD,
    Buffer.from(envelope.salt, "base64"),
    310_000,
    32,
    "sha256",
  );
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as Record<string, string>;
  } finally {
    key.fill(0);
  }
}

function parseTornadoState(store: Record<string, string>): JsonRecord {
  return JSON.parse(store[STORE_KEY]!) as JsonRecord;
}

function poolMap(state: JsonRecord): Map<string, JsonRecord> {
  return new Map(
    ((state.pools as JsonRecord).poolsTuples as Array<[string, JsonRecord]>),
  );
}

function assertRepairError(
  error: unknown,
  code: TornadoStateRepairError["code"],
): asserts error is TornadoStateRepairError {
  assert.ok(error instanceof TornadoStateRepairError);
  assert.equal(error.code, code);
}

async function assertNoTransientFiles(fixture: Fixture): Promise<void> {
  const dataEntries = await readdir(fixture.dataDir);
  assert.equal(
    dataEntries.some((name) => name.startsWith(REPAIR_SHADOW_PREFIX)),
    false,
  );
  const walletEntries = await readdir(fixture.walletDir);
  assert.equal(
    walletEntries.some((name) => name.startsWith(".tc-storage.agent-boost-repair-")),
    false,
  );
  const backups = walletEntries.filter((name) => name.startsWith(BACKUP_PREFIX));
  if (backups.length > 0) {
    assert.equal(backups.length, 1);
  }
}
