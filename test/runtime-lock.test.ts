import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";

import {
  AGENT_BOOST_RUNTIME_LOCK_PORT,
  RuntimeLock,
} from "../src/state/runtime-lock.js";

test("runtime lock permits exactly one process owner and is reusable after release", async () => {
  const first = new RuntimeLock();
  const second = new RuntimeLock();
  await first.acquire();
  try {
    await assert.rejects(second.acquire(), /already owns/);
    const socket = createConnection({
      host: "127.0.0.1",
      port: AGENT_BOOST_RUNTIME_LOCK_PORT,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("close", () => resolve());
      socket.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
        else reject(error);
      });
    });
  } finally {
    await first.release();
  }

  await second.acquire();
  await second.release();
  await second.release();
});
