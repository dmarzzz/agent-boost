import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect as connectTcp, type Socket } from "node:net";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { ShadeTreeEgress, assertCoveredContentType, validateCoveredUrl } from "../src/shade-tree/index.js";
import { fetchThroughShadeTreeProxy } from "../src/shade-tree/http.js";

const installer = await import("../scripts/lib/shade-tree-install.mjs") as {
  assessShadeTreeHost(platform: string, arch: string): {
    supported: boolean;
    label: string;
    asset?: string;
    sha256?: string;
  };
  installPinnedShadeTree(options: Record<string, unknown>): Promise<Record<string, unknown>>;
};

test("covered egress accepts only public HTTPS port 443 targets", () => {
  assert.equal(validateCoveredUrl("https://example.com/data.json?q=1").hostname, "example.com");
  assert.equal(validateCoveredUrl("https://example.com:443/").port, "");
  for (const target of [
    "http://example.com/",
    "https://user:secret@example.com/",
    "https://example.com:8443/",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://metadata.internal/",
    "https://service.local/",
    "https://gateway.onion/",
    "https://singlelabel/",
    "https://example.com/data?api_key=secret",
    "https://example.com/data?access_token=secret",
  ]) {
    assert.throws(() => validateCoveredUrl(target), /COVERED_EGRESS_/u, target);
  }
});

test("covered egress accepts text and JSON but rejects opaque binary types", () => {
  assert.equal(assertCoveredContentType("application/json; charset=utf-8"), "application/json");
  assert.equal(assertCoveredContentType("application/problem+json"), "application/problem+json");
  assert.equal(assertCoveredContentType("text/plain"), "text/plain");
  assert.throws(() => assertCoveredContentType("application/octet-stream"), /CONTENT_DENIED/u);
});

test("missing live client fails closed without affecting wallet runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-shade-missing-"));
  const egress = new ShadeTreeEgress(loadConfig({ AGENT_BOOST_STATE_DIR: root }, root));
  await egress.start();
  assert.equal((await egress.status()).status, "not_installed");
  await assert.rejects(
    egress.fetch({ url: "https://example.com/" }),
    /SHADE_TREE_NOT_INSTALLED/u,
  );
  await egress.stop();
});

test("Shade Tree shipping matrix is honest about macOS Intel", () => {
  assert.equal(installer.assessShadeTreeHost("linux", "arm64").supported, true);
  assert.equal(installer.assessShadeTreeHost("darwin", "arm64").supported, true);
  const intel = installer.assessShadeTreeHost("darwin", "x64");
  assert.equal(intel.supported, false);
  assert.match(intel.label, /no live binary/u);
});

test("pinned Shade Tree installer verifies bytes, installs atomically, and reuses exact state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-shade-install-"));
  const installDir = join(root, "shade-tree");
  const bytes = Buffer.from("fake pinned shade tree live binary");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const hostPin = {
    supported: true,
    label: "test host",
    asset: "shade-tree-test-live",
    sha256,
  };
  const calls: string[][] = [];
  const runCommand = async (executable: string, args: string[]) => {
    calls.push([executable, ...args]);
    return { exitCode: 0, stdout: "shade-tree 0.4.0\n", stderr: "" };
  };
  const first = await installer.installPinnedShadeTree({
    installDir,
    platform: "linux",
    arch: "arm64",
    hostPin,
    runCommand,
    download: async () => bytes,
  });
  assert.equal(first.installed, true);
  assert.equal(first.available, true);
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(installDir, "bin", "shade-tree")))
      .digest("hex"),
    sha256,
  );
  await chmod(join(installDir, "bin", "shade-tree"), 0o755);
  const second = await installer.installPinnedShadeTree({
    installDir,
    platform: "linux",
    arch: "arm64",
    hostPin,
    runCommand,
    download: async () => {
      throw new Error("exact install should be reused");
    },
  });
  assert.equal(second.reused, true);
  assert.equal(calls.length, 2);
});

test("pinned Shade Tree installer rejects a release digest mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boost-shade-tamper-"));
  await assert.rejects(
    installer.installPinnedShadeTree({
      installDir: join(root, "shade-tree"),
      platform: "linux",
      arch: "arm64",
      hostPin: {
        supported: true,
        label: "test host",
        asset: "shade-tree-test-live",
        sha256: "0".repeat(64),
      },
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      download: async () => Buffer.from("tampered"),
    }),
    /digest mismatch/u,
  );
});

test(
  "live HTTP adapter smoke speaks authenticated CONNECT and verifies destination TLS",
  { skip: process.env.AGENT_BOOST_LIVE_HTTP_TEST !== "1" },
  async () => {
    const token = "a".repeat(43);
    const clients = new Set<Socket>();
    const proxy = createServer((client) => {
      clients.add(client);
      client.once("close", () => clients.delete(client));
      let request = Buffer.alloc(0);
      client.on("data", function onData(chunk: Buffer) {
        request = Buffer.concat([request, chunk]);
        const end = request.indexOf("\r\n\r\n");
        if (end === -1) return;
        client.off("data", onData);
        const header = request.subarray(0, end).toString("latin1");
        const target = /^CONNECT ([^ ]+) HTTP\/1\.1/mu.exec(header)?.[1];
        const expected = Buffer.from(`shade-tree:${token}`).toString("base64");
        assert.match(header, new RegExp(`Proxy-Authorization: Basic ${expected}`, "u"));
        assert.equal(target, "example.com:443");
        const upstream = connectTcp({ host: "example.com", port: 443 }, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.setTimeout(10_000, () => upstream.destroy(new Error("upstream timeout")));
        client.once("close", () => upstream.destroy());
        upstream.on("error", (error) => client.destroy(error));
      });
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    assert.ok(address && typeof address === "object");
    try {
      const result = await fetchThroughShadeTreeProxy(
        "https://example.com/",
        "GET",
        {
          host: "127.0.0.1",
          port: address.port,
          token,
          timeoutMs: 15_000,
          maxBytes: 128 * 1024,
          maxRedirects: 0,
        },
      );
      assert.equal(result.status, 200);
      assert.equal(result.route, "shade-tree");
      assert.match(result.body, /Example Domain/u);
    } finally {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  },
);
