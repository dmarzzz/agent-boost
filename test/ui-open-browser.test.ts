import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { ChildProcess, spawn } from "node:child_process";

import { openVisibleBrowser } from "../src/ui/index.js";

function successfulSpawn(calls: Array<{ command: string; args: readonly string[] }>): typeof spawn {
  return ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => child;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as typeof spawn;
}

describe("visible browser opener", () => {
  it("opens the loopback page with the native macOS command and no shell", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    assert.equal(await openVisibleBrowser("http://127.0.0.1:4123", {
      platform: "darwin",
      spawnProcess: successfulSpawn(calls),
    }), true);
    assert.deepEqual(calls, [{ command: "open", args: ["http://127.0.0.1:4123/"] }]);
  });

  it("uses xdg-open only when Linux has a graphical session", async () => {
    const graphicalCalls: Array<{ command: string; args: readonly string[] }> = [];
    assert.equal(await openVisibleBrowser("http://localhost:4123", {
      platform: "linux",
      env: { DISPLAY: ":0" },
      spawnProcess: successfulSpawn(graphicalCalls),
    }), true);
    assert.equal(graphicalCalls[0]?.command, "xdg-open");

    const headlessCalls: Array<{ command: string; args: readonly string[] }> = [];
    assert.equal(await openVisibleBrowser("http://localhost:4123", {
      platform: "linux",
      env: {},
      spawnProcess: successfulSpawn(headlessCalls),
    }), false);
    assert.equal(headlessCalls.length, 0);
  });

  it("refuses remote or malformed URLs", async () => {
    assert.equal(await openVisibleBrowser("https://example.com"), false);
    assert.equal(await openVisibleBrowser("not a URL"), false);
  });
});
