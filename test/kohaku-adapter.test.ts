import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { KohakuWalletAdapter } from "../src/kohaku/adapter.js";
import { SpawnCommandRunner } from "../src/kohaku/runner.js";
import type {
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from "../src/kohaku/runner.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"ab".repeat(32)}`;

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

describe("KohakuWalletAdapter", () => {
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
    assert.equal(address, ADDRESS);
    assert.equal(runner.maxActive, 1);
  });

  it("shields and pays exactly via unshield --next plus a value tail-call", async () => {
    const runner = new FakeRunner((invocation) => {
      if (command(invocation) === "shield") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ transactions: [{ type: "shield", hash: TX_HASH }] }),
          stderr: "",
        };
      }
      if (command(invocation) === "unshield") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ explorerHash: TX_HASH }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${command(invocation)}`);
    });
    const { adapter } = await fixture(runner);

    assert.deepEqual(await adapter.shieldWei(100_000_000_000_000_000n), {
      transactionHash: TX_HASH,
    });
    assert.deepEqual(
      await adapter.executePrivatePayment({
        recipient: RECIPIENT,
        amountWei: 20_000_000_000_000_000n,
      }),
      { transactionHash: TX_HASH },
    );

    const shield = runner.calls.find((call) => command(call) === "shield")!;
    assert.equal(shield.args.includes("--rpc-url"), false);
    assert.equal(shield.env?.RPC_URL, "https://sepolia.example.invalid/rpc-token");
    assert.deepEqual(
      shield.args.slice(shield.args.indexOf("--amount-wei"), shield.args.indexOf("--amount-wei") + 2),
      ["--amount-wei", "100000000000000000"],
    );
    const unshield = runner.calls.find((call) => command(call) === "unshield")!;
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

  it("rejects invalid recipients and payment values before running Kohaku", async () => {
    const runner = new FakeRunner(() => ({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    }));
    const { adapter } = await fixture(runner);

    await assert.rejects(
      adapter.executePrivatePayment({ recipient: "not-an-address", amountWei: 1n }),
      /Ethereum address/,
    );
    await assert.rejects(
      adapter.executePrivatePayment({ recipient: RECIPIENT, amountWei: 0n }),
      /positive/,
    );
    await assert.rejects(
      adapter.executePrivatePayment({
        recipient: RECIPIENT,
        amountWei: 100_000_000_000_000_000n,
      }),
      /smaller than the Tornado withdrawal/,
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
});
