import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const gate = await import("../scripts/lib/release-gate.mjs") as {
  assertNoPublicLeaks(value: unknown): void;
  buildIsolatedEnvironment(
    environment: NodeJS.ProcessEnv,
    paths: Record<string, string | number>,
  ): Record<string, string>;
  parseInstallerOutput(result: {
    exitCode: number;
    stdout: string;
    stderr: string;
  }): Record<string, unknown>;
  validateOnboardingResult(
    response: Record<string, unknown>,
    options?: { expectUiOpened?: boolean },
  ): {
    setupId: string;
    address: string;
    fundingUri: string;
    revision: number;
    qrSha256: string;
  };
  validateOnboardingStatus(
    response: Record<string, unknown>,
    expected: { setupId: string; address: string; fundingUri: string },
  ): void;
  validatePersistence(
    first: { setupId: string; address: string; fundingUri: string; revision: number },
    repeated: { setupId: string; address: string; fundingUri: string; revision: number },
    label?: string,
  ): void;
  verifyInstalledHermes(options: Record<string, unknown>): Promise<{
    executable: string;
    configPath: string;
    hermesVersion: string;
    kohakuCommit: string;
  }>;
};

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SETUP_ID = "setup_12345678";
const FUNDING_URI = `ethereum:${ADDRESS}@11155111?value=200000000000000000`;
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function delegation(): Record<string, unknown> {
  return {
    mode: "testnet_delegated",
    chainId: 11_155_111,
    perPaymentLimitWei: "50000000000000000",
    lifetimeLimitWei: "50000000000000000",
    spentWei: "0",
    expiresAt: "2026-09-02T00:00:00.000Z",
    enabled: true,
  };
}

function setup(revision = 3): Record<string, unknown> {
  return {
    version: 1,
    setupId: SETUP_ID,
    revision,
    phase: "awaiting_funding",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z",
    address: ADDRESS,
    publicBalanceWei: "0",
    privateBalanceWei: "0",
    requiredFundingWei: "200000000000000000",
    shieldAmountWei: "100000000000000000",
    delegation: delegation(),
  };
}

function publicSnapshot(revision = 3): Record<string, unknown> {
  const value = setup(revision);
  delete value.version;
  delete value.createdAt;
  delete value.updatedAt;
  value.rpcRoute = {
    mode: "tor",
    scope: "ethereum_json_rpc",
    status: "ready",
    directFallback: false,
  };
  return value;
}

function funding(qrAttached: boolean): Record<string, unknown> {
  return {
    chain_id: "eip155:11155111",
    network: "Sepolia",
    asset: "Sepolia ETH",
    address: ADDRESS,
    funding_uri: FUNDING_URI,
    remaining_amount_wei: "200000000000000000",
    remaining_amount_eth: "0.2",
    qr_attached: qrAttached,
  };
}

function envelope(data: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "org.agentboost.tool-result",
    schema_version: "1.0",
    manifest_digest: `sha256:${"a".repeat(64)}`,
    outcome: "awaiting_funding",
    code: "ONBOARDING_STARTED",
    retry: { mode: "wait", safe_with_same_arguments: true, after_ms: 2000 },
    data,
  };
}

function startResponse(revision = 3): Record<string, unknown> {
  const structuredContent = envelope({
    setup: setup(revision),
    public: publicSnapshot(revision),
    funding: funding(true),
    ui_opened: false,
  });
  return {
    structuredContent,
    content: [
      { type: "text", text: JSON.stringify(structuredContent) },
      { type: "image", data: PNG, mimeType: "image/png" },
    ],
  };
}

test("release gate accepts the exact public funding projection and PNG", () => {
  const snapshot = gate.validateOnboardingResult(startResponse(), {
    expectUiOpened: false,
  });
  assert.equal(snapshot.setupId, SETUP_ID);
  assert.equal(snapshot.address, ADDRESS);
  assert.equal(snapshot.fundingUri, FUNDING_URI);
  assert.equal(snapshot.revision, 3);
  assert.match(snapshot.qrSha256, /^[0-9a-f]{64}$/u);

  const status = envelope({ setup: setup(4), funding: funding(false) });
  status.code = "ONBOARDING_STATUS";
  gate.validateOnboardingStatus(
    { structuredContent: status, content: [{ type: "text", text: JSON.stringify(status) }] },
    snapshot,
  );
});

test("release gate rejects localhost, local paths, and schema expansion", () => {
  const localhost = startResponse();
  ((localhost.structuredContent as { data: { setup: Record<string, unknown> } }).data.setup)
    .uiUrl = "http://127.0.0.1:9183";
  assert.throws(
    () => gate.validateOnboardingResult(localhost),
    /unexpected public fields|loopback host/u,
  );

  assert.throws(
    () => gate.assertNoPublicLeaks({ message: "read /Users/demo/.wallet/state.json" }),
    /local filesystem path/u,
  );

  const expanded = startResponse();
  ((expanded.structuredContent as { data: { funding: Record<string, unknown> } }).data.funding)
    .debug = "not public";
  assert.throws(() => gate.validateOnboardingResult(expanded), /keys changed/u);
});

test("release gate requires retries and restarts to preserve the wallet", () => {
  const first = gate.validateOnboardingResult(startResponse(3));
  const repeated = gate.validateOnboardingResult(startResponse(5));
  gate.validatePersistence(first, repeated);
  assert.throws(
    () => gate.validatePersistence(first, { ...repeated, address: `0x${"2".repeat(40)}` }),
    /replaced the durable onboarding wallet/u,
  );
  assert.throws(
    () => gate.validatePersistence(first, { ...repeated, revision: 2 }),
    /revision backwards/u,
  );
});

test("isolated environment scrubs inherited Agent Boost and Node overrides", () => {
  const environment = gate.buildIsolatedEnvironment(
    {
      PATH: "/usr/bin",
      NODE_OPTIONS: "--require /tmp/injected.js",
      HERMES_HOME: "/home/user/.hermes",
      AGENT_BOOST_RPC_URL: "https://credential.invalid/token",
      SAFE_VALUE: "preserved",
    },
    {
      commandBin: "/gate/commands",
      prefix: "/gate/prefix",
      prefixBin: "/gate/prefix/bin",
      hermesHome: "/gate/hermes",
      kohakuInstallDir: "/gate/dependencies/kohaku-cli",
      shadeTreeInstallDir: "/gate/dependencies/shade-tree",
      stateDir: "/gate/state",
      torDataDir: "/gate/state/tor",
      kohakuDataDir: "/gate/state/kohaku",
      passwordFile: "/gate/state/secrets/kohaku-password",
      uiPort: 19001,
      torRpcPort: 19002,
      shadeTreeProxyPort: 19003,
    },
  );
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.AGENT_BOOST_RPC_URL, undefined);
  assert.equal(environment.HERMES_HOME, "/gate/hermes");
  assert.equal(environment.SAFE_VALUE, "preserved");
  assert.match(environment.PATH, /^\/gate\/commands/u);
});

test("release gate verifies isolated Hermes config and exact packaged skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-release-verify-"));
  const candidateRoot = join(root, "candidate");
  const hermesHome = join(root, "hermes");
  const executable = join(root, "prefix", "lib", "agent-boost", "dist", "cli.js");
  const configPath = join(hermesHome, "config.yaml");
  await mkdir(join(candidateRoot, "integrations", "hermes", "agent-boost-setup"), {
    recursive: true,
  });
  await mkdir(join(candidateRoot, "integrations", "hermes", "agent-boost"), {
    recursive: true,
  });
  await mkdir(join(hermesHome, "skills", "agent-boost-setup"), { recursive: true });
  await mkdir(join(hermesHome, "skills", "agent-boost"), { recursive: true });
  await mkdir(join(root, "prefix", "lib", "agent-boost", "dist"), { recursive: true });
  await writeFile(executable, "#!/usr/bin/env node\n", { mode: 0o755 });
  await chmod(executable, 0o755);
  for (const name of ["agent-boost-setup", "agent-boost"]) {
    const content = `---\nname: ${name}\n---\n`;
    await writeFile(join(candidateRoot, "integrations", "hermes", name, "SKILL.md"), content);
    await writeFile(join(hermesHome, "skills", name, "SKILL.md"), content);
  }
  await writeFile(
    configPath,
    [
      "mcp_servers:",
      "  agent-boost:",
      `    command: ${executable}`,
      "    args: [mcp, --mode, dark, --contract-major, '1']",
      "    enabled: true",
      "    timeout: 180",
      "    supports_parallel_tool_calls: false",
      "    tools:",
      "      include:",
      "        - capabilities",
      "        - onboarding_start",
      "        - onboarding_status",
      "        - wallet_get_context",
      "        - wallet_start_new_demo",
      "        - wallet_plan_private_payment",
      "        - wallet_execute_private_payment",
      "        - wallet_get_request",
      "        - egress_capabilities",
      "        - egress_status",
      "        - egress_fetch",
      "        - private_inference_capabilities",
      "        - private_inference_status",
      "        - private_inference_query",
      "      resources: false",
      "      prompts: false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const installed = await gate.verifyInstalledHermes({
    sandboxRoot: root,
    hermesHome,
    candidateRoot,
    installResult: {
      installed: true,
      agent_boost: { executable },
      kohaku: { commit: "fcf9defa4d5ff7f63222f1b3bbe2d30e631ceffd" },
      shade_tree: {
        version: "0.4.0",
        available: false,
        status: "unsupported",
      },
      hermes: {
        status: "configured",
        hermes_version: "Hermes 0.16.0\nProject: /private/local/hermes-checkout",
        result: {
          config_path: configPath,
          config_changed: true,
          skills: [
            {
              name: "agent-boost-setup",
              changed: true,
              path: join(hermesHome, "skills", "agent-boost-setup", "SKILL.md"),
            },
            {
              name: "agent-boost",
              changed: true,
              path: join(hermesHome, "skills", "agent-boost", "SKILL.md"),
            },
          ],
        },
      },
    },
  });
  assert.equal(installed.executable, await realpath(executable));
  assert.equal(installed.hermesVersion, "Hermes 0.16.0");
  assert.equal(await readFile(configPath, "utf8").then((value) => value.includes(executable)), true);
});

test("release gate refuses failed or non-JSON installer output", () => {
  assert.deepEqual(
    gate.parseInstallerOutput({
      exitCode: 0,
      stdout: 'node scripts/install.mjs\n{"installed":true}\n',
      stderr: "",
    }),
    { installed: true },
  );
  assert.throws(
    () => gate.parseInstallerOutput({ exitCode: 1, stdout: "", stderr: "build failed" }),
    /build failed/u,
  );
  assert.throws(
    () => gate.parseInstallerOutput({ exitCode: 0, stdout: "not-json", stderr: "" }),
    /JSON report/u,
  );
});
