import { createServer, type Server } from "node:net";

export const AGENT_BOOST_RUNTIME_LOCK_PORT = 9_184;

/**
 * A process-shared ownership lock for the single local Agent Boost state and
 * Kohaku wallet. A loopback TCP bind is released by the OS on crashes, unlike
 * a PID file, and cannot be acquired by two processes at once.
 */
export class RuntimeLock {
  readonly #host = "127.0.0.1";
  readonly #port: number;
  #server: Server | undefined;

  constructor(port = AGENT_BOOST_RUNTIME_LOCK_PORT) {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error("Runtime lock port must be between 1 and 65535");
    }
    this.#port = port;
  }

  async acquire(): Promise<void> {
    if (this.#server) return;
    const server = createServer();
    server.on("connection", (socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          server.off("listening", onListening);
          if (error.code === "EADDRINUSE") {
            reject(
              new Error(
                "Another Agent Boost process already owns the local wallet runtime",
              ),
            );
            return;
          }
          reject(new Error("Agent Boost could not acquire its local runtime lock"));
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({
          host: this.#host,
          port: this.#port,
          exclusive: true,
        });
      });
      this.#server = server;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  async release(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
