import { EventEmitter } from "node:events";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  OnboardingRecord,
  PaymentPlan,
  PaymentRequest,
} from "../contracts.js";

export interface StateDocument {
  version: 1;
  onboarding?: OnboardingRecord;
  plans: Record<string, PaymentPlan>;
  requests: Record<string, PaymentRequest>;
}

const EMPTY_STATE: StateDocument = {
  version: 1,
  plans: {},
  requests: {},
};

function cloneState(state: StateDocument): StateDocument {
  return structuredClone(state);
}

export class StateStore {
  readonly #path: string;
  readonly #events = new EventEmitter();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.#path = join(stateDir, "state.json");
    this.#events.setMaxListeners(100);
  }

  get path(): string {
    return this.#path;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700);
    try {
      await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#write(EMPTY_STATE);
    }
  }

  async read(): Promise<StateDocument> {
    const raw = await readFile(this.#path, "utf8");
    const parsed = JSON.parse(raw) as StateDocument;
    if (parsed.version !== 1 || !parsed.plans || !parsed.requests) {
      throw new Error("Unsupported or corrupt Agent Boost state document");
    }
    return parsed;
  }

  async update(
    mutator: (draft: StateDocument) => void | Promise<void>,
  ): Promise<StateDocument> {
    const operation = this.#queue.then(async () => {
      const current = await this.read();
      const draft = cloneState(current);
      await mutator(draft);
      await this.#write(draft);
      this.#events.emit("change", cloneState(draft));
      return cloneState(draft);
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async waitForOnboardingRevision(
    sinceRevision: number,
    waitMs: number,
  ): Promise<OnboardingRecord | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (value: OnboardingRecord | undefined): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.#events.off("change", listener);
        resolve(value);
      };
      const listener = (state: StateDocument): void => {
        if (state.onboarding && state.onboarding.revision > sinceRevision) {
          finish(state.onboarding);
        }
      };
      this.#events.on("change", listener);
      void this.read().then(
        (state) => {
          if (
            (state.onboarding && state.onboarding.revision > sinceRevision) ||
            waitMs === 0
          ) {
            finish(state.onboarding);
            return;
          }
          timer = setTimeout(() => {
            void this.read().then(
              (latest) => finish(latest.onboarding),
              () => finish(undefined),
            );
          }, waitMs);
        },
        () => finish(undefined),
      );
    });
  }

  async #write(state: StateDocument): Promise<void> {
    const temp = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o600);
    await rename(temp, this.#path);
    await chmod(this.#path, 0o600);
    const directory = await open(dirname(this.#path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
