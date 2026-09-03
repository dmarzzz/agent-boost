import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import type {
  OnboardingRecord,
  PaymentPlan,
  PaymentRequest,
  PolicyUpdatePlan,
  RecoveryTransferPlan,
  RecoveryTransferRequest,
  WalletProfileOrigin,
  WalletProfileRecord,
  WalletPolicySnapshot,
  WalletReauthorizationPlan,
} from "../contracts.js";

export interface StateDocument {
  version: 2;
  wallet?: {
    activeWalletId: string;
    activeName: string;
    profiles: Record<string, WalletProfileRecord>;
  };
  onboarding?: OnboardingRecord;
  plans: Record<string, PaymentPlan>;
  policyPlans: Record<string, PolicyUpdatePlan>;
  requests: Record<string, PaymentRequest>;
  recoveryPlans: Record<string, RecoveryTransferPlan>;
  recoveryRequests: Record<string, RecoveryTransferRequest>;
  reauthorizationPlans: Record<string, WalletReauthorizationPlan>;
}

interface LegacyPolicyUpdatePlan extends Omit<PolicyUpdatePlan, "wallet"> {
  wallet?: PolicyUpdatePlan["wallet"];
}

interface LegacyStateDocument {
  version: 1;
  wallet?: { activeName: string };
  onboarding?: OnboardingRecord;
  plans?: Record<string, PaymentPlan>;
  policyPlans?: Record<string, LegacyPolicyUpdatePlan>;
  requests?: Record<string, PaymentRequest>;
}

const EMPTY_STATE: StateDocument = {
  version: 2,
  plans: {},
  policyPlans: {},
  requests: {},
  recoveryPlans: {},
  recoveryRequests: {},
  reauthorizationPlans: {},
};

const idSchema = z.string().min(1).max(300);
const walletNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const atomicSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const timestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "invalid timestamp",
);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const transactionHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const selectionSchema = z.object({
  walletId: idSchema,
  walletName: walletNameSchema,
  selectionEpoch: z.number().int().safe().positive(),
}).strict();
const authorizationSchema = selectionSchema.extend({
  authorizationId: z.string().regex(/^auth_[A-Za-z0-9-]+$/),
}).strict();
const delegationSchema = z.object({
  mode: z.literal("testnet_delegated"),
  chainId: z.literal(11_155_111),
  perPaymentLimitWei: atomicSchema,
  lifetimeLimitWei: atomicSchema,
  spentWei: atomicSchema,
  maxPayments: z.number().int().safe().positive(),
  expiresAt: timestampSchema,
  enabled: z.boolean(),
}).strict();
const legacyDelegationSchema = delegationSchema.extend({
  maxPayments: z.number().int().safe().positive().optional(),
}).strict();
const onboardingBase = {
  version: z.literal(1),
  setupId: idSchema,
  revision: z.number().int().safe().nonnegative(),
  phase: z.enum([
    "not_started", "creating_wallet", "preparing_privacy", "awaiting_funding",
    "funding_pending", "funded_public", "shielding", "private_ready", "failed",
  ]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  address: addressSchema.optional(),
  publicBalanceWei: atomicSchema,
  privateBalanceWei: atomicSchema,
  requiredFundingWei: atomicSchema,
  shieldAmountWei: atomicSchema,
  uiUrl: z.string().min(1).optional(),
  uiOpened: z.boolean().optional(),
  error: z.object({
    code: idSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }).strict().optional(),
};
const onboardingSchema = z.object({ ...onboardingBase, delegation: delegationSchema }).strict();
const legacyOnboardingSchema = z.object({
  ...onboardingBase,
  delegation: legacyDelegationSchema,
}).strict();
const confirmationSchema = z.object({
  method: z.enum(["adapter", "recipient_balance_delta", "transaction_receipt"]),
  checkedAt: timestampSchema,
}).strict();
const reconciliationSchema = z.object({
  attempts: z.number().int().safe().nonnegative(),
  checkedAt: timestampSchema,
}).strict();
const requestErrorSchema = z.object({ code: idSchema, message: z.string().min(1) }).strict();
const paymentPlanBase = {
  version: z.literal(1),
  decisionId: idSchema,
  recipient: addressSchema,
  amountWei: atomicSchema,
  intentDigest: digestSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  decision: z.enum(["allow", "deny", "indeterminate"]),
  blockers: z.array(idSchema),
  approval: z.object({
    action: z.enum(["allow", "confirm", "deny"]),
    userConfirmationRequired: z.boolean(),
  }).strict(),
};
const paymentPlanSchema = z.object({
  ...paymentPlanBase,
  authorization: authorizationSchema,
}).strict();
const legacyPaymentPlanSchema = z.object({
  ...paymentPlanBase,
  authorization: authorizationSchema.optional(),
}).strict();
const paymentRequestBase = {
  version: z.literal(1),
  requestId: idSchema,
  clientRequestId: idSchema,
  decisionId: idSchema,
  recipient: addressSchema,
  amountWei: atomicSchema,
  phase: z.enum(["planned", "executing", "submitted", "confirmed", "failed", "indeterminate"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  transactionHash: transactionHashSchema.optional(),
  userOperationHash: transactionHashSchema.optional(),
  confirmation: confirmationSchema.optional(),
  recipientBalanceBeforeWei: atomicSchema.optional(),
  reconciliation: reconciliationSchema.optional(),
  error: requestErrorSchema.optional(),
};
const paymentRequestSchema = z.object({
  ...paymentRequestBase,
  authorization: authorizationSchema,
}).strict();
const legacyPaymentRequestSchema = z.object({
  ...paymentRequestBase,
  authorization: authorizationSchema.optional(),
}).strict();
const policySnapshotSchema = delegationSchema.extend({
  paymentsUsed: z.number().int().safe().nonnegative(),
  paymentsRemaining: z.number().int().safe().nonnegative(),
}).strict();
const legacyPolicySnapshotSchema = legacyDelegationSchema.extend({
  paymentsUsed: z.number().int().safe().nonnegative(),
  paymentsRemaining: z.number().int().safe().nonnegative(),
}).strict();
const policyPlanBase = {
  version: z.literal(1),
  decisionId: idSchema,
  authorizationId: z.string().regex(/^auth_[A-Za-z0-9-]+$/).optional(),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  decision: z.enum(["allow", "deny"]),
  blockers: z.array(idSchema),
  approval: z.object({ action: z.literal("confirm"), userConfirmationRequired: z.literal(true) }).strict(),
  appliedAt: timestampSchema.optional(),
};
const policyPlanSchema = z.object({
  ...policyPlanBase,
  wallet: selectionSchema,
  current: policySnapshotSchema,
  proposed: policySnapshotSchema,
  appliedPolicy: policySnapshotSchema.optional(),
}).strict();
const legacyPolicyPlanSchema = z.object({
  ...policyPlanBase,
  wallet: selectionSchema.optional(),
  current: legacyPolicySnapshotSchema,
  proposed: legacyPolicySnapshotSchema,
  appliedPolicy: legacyPolicySnapshotSchema.optional(),
}).strict();
const recoveryPlanSchema = z.object({
  version: z.literal(1), decisionId: idSchema, wallet: selectionSchema,
  recipient: addressSchema, amountWei: atomicSchema, withdrawalAmountWei: atomicSchema,
  feeReserveWei: atomicSchema, maxRecipientAmountWei: atomicSchema,
  privateBalanceSnapshotWei: atomicSchema,
  remainingPrivateBalanceEstimateWei: atomicSchema,
  balanceRevision: z.number().int().safe().nonnegative(),
  scope: z.literal("single_tornado_denomination"),
  feeModel: z.literal("reserved_from_wallet_controlled_remainder"),
  intentDigest: digestSchema, createdAt: timestampSchema, expiresAt: timestampSchema,
  decision: z.enum(["allow", "deny"]), blockers: z.array(idSchema),
  approval: z.object({ action: z.literal("confirm"), userConfirmationRequired: z.literal(true) }).strict(),
  consumedByRequestId: idSchema.optional(),
}).strict();
const recoveryRequestSchema = z.object({
  version: z.literal(1), requestId: idSchema, clientRequestId: idSchema,
  decisionId: idSchema, wallet: selectionSchema, recipient: addressSchema,
  amountWei: atomicSchema, withdrawalAmountWei: atomicSchema, feeReserveWei: atomicSchema,
  remainingPrivateBalanceEstimateWei: atomicSchema,
  scope: z.literal("single_tornado_denomination"),
  feeModel: z.literal("reserved_from_wallet_controlled_remainder"),
  phase: z.enum(["executing", "submitted", "confirmed", "failed", "indeterminate"]),
  createdAt: timestampSchema, updatedAt: timestampSchema,
  transactionHash: transactionHashSchema.optional(), userOperationHash: transactionHashSchema.optional(),
  confirmation: confirmationSchema.optional(), recipientBalanceBeforeWei: atomicSchema.optional(),
  reconciliation: reconciliationSchema.optional(), error: requestErrorSchema.optional(),
}).strict();
const reauthorizationPlanSchema = z.object({
  version: z.literal(1), decisionId: idSchema, wallet: selectionSchema,
  priorAuthorizationId: z.string().regex(/^auth_[A-Za-z0-9-]+$/).optional(),
  currentPolicy: policySnapshotSchema,
  proposedPolicy: policySnapshotSchema,
  authorizationEffect: z.literal("replace"),
  counterEffect: z.literal("reset_spend_and_payment_count"),
  intentDigest: digestSchema, createdAt: timestampSchema, expiresAt: timestampSchema,
  decision: z.enum(["allow", "deny"]), blockers: z.array(idSchema),
  approval: z.object({ action: z.literal("confirm"), userConfirmationRequired: z.literal(true) }).strict(),
  appliedAt: timestampSchema.optional(),
  appliedAuthorizationId: z.string().regex(/^auth_[A-Za-z0-9-]+$/).optional(),
}).strict();
const walletProfileSchema = z.object({
  version: z.literal(1), walletId: idSchema, name: walletNameSchema,
  origin: z.enum(["created", "adopted", "discovered"]),
  status: z.enum(["available", "archived"]), createdAt: timestampSchema,
  updatedAt: timestampSchema, lastSelectedAt: timestampSchema.optional(),
  selectionEpoch: z.number().int().safe().nonnegative(),
  authorizationId: z.string().regex(/^auth_[A-Za-z0-9-]+$/).optional(),
  archiveIds: z.array(idSchema), onboarding: onboardingSchema.optional(),
}).strict();
const stateSchema = z.object({
  version: z.literal(2),
  wallet: z.object({
    activeWalletId: idSchema,
    activeName: walletNameSchema,
    profiles: z.record(z.string(), walletProfileSchema),
  }).strict().optional(),
  onboarding: onboardingSchema.optional(),
  plans: z.record(z.string(), paymentPlanSchema),
  policyPlans: z.record(z.string(), policyPlanSchema),
  requests: z.record(z.string(), paymentRequestSchema),
  recoveryPlans: z.record(z.string(), recoveryPlanSchema),
  recoveryRequests: z.record(z.string(), recoveryRequestSchema),
  reauthorizationPlans: z.record(z.string(), reauthorizationPlanSchema),
}).strict();
const legacyStateSchema = z.object({
  version: z.literal(1),
  wallet: z.object({ activeName: walletNameSchema }).strict().optional(),
  onboarding: legacyOnboardingSchema.optional(),
  plans: z.record(z.string(), legacyPaymentPlanSchema).optional(),
  policyPlans: z.record(z.string(), legacyPolicyPlanSchema).optional(),
  requests: z.record(z.string(), legacyPaymentRequestSchema).optional(),
}).strict();

function isLegacyState(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as { version?: unknown }).version === 1;
}

function parseState(value: unknown): StateDocument {
  const normalized = normalizeVersion2Value(value);
  return stateSchema.parse(normalized) as StateDocument;
}

function normalizeVersion2Value(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = structuredClone(value) as Record<string, unknown>;
  if (normalized.version !== 2) return normalized;
  for (const key of [
    "plans",
    "policyPlans",
    "requests",
    "recoveryPlans",
    "recoveryRequests",
    "reauthorizationPlans",
  ]) {
    normalized[key] ??= {};
  }
  normalizeOnboardingValue(normalized.onboarding);
  const wallet = normalized.wallet;
  if (wallet && typeof wallet === "object" && !Array.isArray(wallet)) {
    const profiles = (wallet as Record<string, unknown>).profiles;
    if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
      for (const profile of Object.values(profiles)) {
        if (profile && typeof profile === "object" && !Array.isArray(profile)) {
          normalizeOnboardingValue((profile as Record<string, unknown>).onboarding);
        }
      }
    }
  }
  return normalized;
}

function normalizeOnboardingValue(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const delegation = (value as Record<string, unknown>).delegation;
  if (!delegation || typeof delegation !== "object" || Array.isArray(delegation)) return;
  (delegation as Record<string, unknown>).maxPayments ??= 1;
}

function parseLegacyState(value: unknown): LegacyStateDocument {
  const parsed = legacyStateSchema.parse(value);
  if (parsed.onboarding && parsed.onboarding.delegation.maxPayments === undefined) {
    parsed.onboarding.delegation.maxPayments = 1;
  }
  for (const plan of Object.values(parsed.policyPlans ?? {})) {
    plan.current.maxPayments ??= 1;
    plan.proposed.maxPayments ??= 1;
  }
  return parsed as unknown as LegacyStateDocument;
}

function cloneState(state: StateDocument): StateDocument {
  return structuredClone(state);
}

export class StateStore {
  readonly #path: string;
  readonly #stateDir: string;
  readonly #defaultWalletName: string;
  readonly #events = new EventEmitter();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string, defaultWalletName = "agent-boost") {
    this.#stateDir = stateDir;
    this.#defaultWalletName = defaultWalletName;
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
      const raw = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isLegacyState(parsed)) {
        const migrated = migrateV1(parseLegacyState(parsed), this.#defaultWalletName);
        validateState(migrated);
        await this.#write(migrated);
      } else {
        const state = parseState(parsed);
        ensureWalletRegistryForState(state, this.#defaultWalletName);
        validateState(state);
        if (JSON.stringify(state) !== JSON.stringify(parsed)) await this.#write(state);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#write(EMPTY_STATE);
    }
  }

  async read(): Promise<StateDocument> {
    const raw = await readFile(this.#path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const state = isLegacyState(parsed)
      ? migrateV1(parseLegacyState(parsed), this.#defaultWalletName)
      : parseState(parsed);
    ensureWalletRegistryForState(state, this.#defaultWalletName);
    validateState(state);
    return state;
  }

  async update(
    mutator: (draft: StateDocument) => void | Promise<void>,
  ): Promise<StateDocument> {
    const operation = this.#queue.then(async () => {
      const draft = cloneState(await this.read());
      await mutator(draft);
      ensureWalletRegistryForState(draft, this.#defaultWalletName);
      syncActiveOnboarding(draft);
      validateState(draft);
      await this.#write(draft);
      this.#events.emit("change", cloneState(draft));
      return cloneState(draft);
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async ensureWalletProfile(defaultName: string): Promise<string> {
    const state = await this.update((draft) => {
      if (draft.wallet) return;
      const now = new Date().toISOString();
      const profile = createWalletProfile(defaultName, "created", now, 1, true);
      if (draft.onboarding) profile.onboarding = draft.onboarding;
      draft.wallet = {
        activeWalletId: profile.walletId,
        activeName: profile.name,
        profiles: { [profile.walletId]: profile },
      };
      bindLegacyHistory(draft, profile);
    });
    return state.wallet!.activeName;
  }

  async registerManagedWallet(
    name: string,
    origin: WalletProfileOrigin = "created",
  ): Promise<WalletProfileRecord> {
    let walletId = "";
    const state = await this.update((draft) => {
      if (!draft.wallet) throw new Error("WALLET_REGISTRY_MISSING");
      const existing = findProfileByName(draft.wallet.profiles, name);
      if (existing) {
        walletId = existing.walletId;
        return;
      }
      const profile = createWalletProfile(
        name,
        origin,
        new Date().toISOString(),
        0,
        false,
      );
      walletId = profile.walletId;
      draft.wallet.profiles[profile.walletId] = profile;
    });
    return state.wallet!.profiles[walletId]!;
  }

  async activeWalletProfile(): Promise<WalletProfileRecord> {
    const state = await this.read();
    const profile = state.wallet?.profiles[state.wallet.activeWalletId];
    if (!profile) throw new Error("ACTIVE_WALLET_PROFILE_MISSING");
    return profile;
  }

  async archiveWalletProfile(walletId: string): Promise<WalletProfileRecord> {
    let result: WalletProfileRecord | undefined;
    await this.update((draft) => {
      if (!draft.wallet) throw new Error("WALLET_REGISTRY_MISSING");
      const profile = draft.wallet.profiles[walletId];
      if (!profile) throw new Error("WALLET_NOT_FOUND");
      if (draft.wallet.activeWalletId === walletId) {
        throw new Error("ACTIVE_WALLET_CANNOT_BE_ARCHIVED");
      }
      profile.status = "archived";
      profile.updatedAt = new Date().toISOString();
      result = structuredClone(profile);
    });
    return result!;
  }

  async activateWalletProfile(walletId: string): Promise<{
    changed: boolean;
    archiveId?: string;
    profile: WalletProfileRecord;
    current: StateDocument;
  }> {
    const operation = this.#queue.then(async () => {
      const current = await this.read();
      if (!current.wallet) throw new Error("WALLET_REGISTRY_MISSING");
      const target = current.wallet.profiles[walletId];
      if (!target) throw new Error("WALLET_NOT_FOUND");
      if (current.wallet.activeWalletId === walletId) {
        return { changed: false, profile: structuredClone(target), current };
      }

      syncActiveOnboarding(current);
      const archiveId = await this.#archiveState(current);
      const prior = current.wallet.profiles[current.wallet.activeWalletId]!;
      prior.archiveIds.push(archiveId);
      prior.updatedAt = new Date().toISOString();

      const now = new Date().toISOString();
      target.status = "available";
      target.selectionEpoch += 1;
      delete target.authorizationId;
      target.lastSelectedAt = now;
      target.updatedAt = now;
      if (target.onboarding) {
        target.onboarding.delegation.enabled = false;
        target.onboarding.revision += 1;
        target.onboarding.updatedAt = now;
      }
      current.wallet.activeWalletId = target.walletId;
      current.wallet.activeName = target.name;
      if (target.onboarding) current.onboarding = structuredClone(target.onboarding);
      else delete current.onboarding;
      validateState(current);
      await this.#write(current);
      this.#events.emit("change", cloneState(current));
      return {
        changed: true,
        archiveId,
        profile: structuredClone(target),
        current: cloneState(current),
      };
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async storeReauthorizationPlan(plan: WalletReauthorizationPlan): Promise<void> {
    await this.update((draft) => {
      draft.reauthorizationPlans[plan.decisionId] = plan;
    });
  }

  async applyReauthorizationPlan(
    decisionId: string,
  ): Promise<{ profile: WalletProfileRecord; onboarding: OnboardingRecord }> {
    let result: { profile: WalletProfileRecord; onboarding: OnboardingRecord } | undefined;
    await this.update((draft) => {
      if (!draft.wallet || !draft.onboarding) throw new Error("WALLET_SETUP_NOT_STARTED");
      const profile = draft.wallet.profiles[draft.wallet.activeWalletId];
      const plan = draft.reauthorizationPlans[decisionId];
      if (!profile || !plan) throw new Error("REAUTHORIZATION_DECISION_NOT_FOUND");
      if (plan.appliedAt) {
        if (!plan.appliedAuthorizationId ||
          profile.authorizationId !== plan.appliedAuthorizationId) {
          throw new Error("REAUTHORIZATION_RECEIPT_STALE");
        }
        result = {
          profile: structuredClone(profile),
          onboarding: structuredClone(draft.onboarding),
        };
        return;
      }
      if (plan.wallet.walletId !== profile.walletId ||
        plan.wallet.walletName !== profile.name ||
        plan.wallet.selectionEpoch !== profile.selectionEpoch) {
        throw new Error("WALLET_SELECTION_CHANGED");
      }
      const now = new Date();
      if (new Date(plan.expiresAt).getTime() <= now.getTime()) {
        throw new Error("REAUTHORIZATION_DECISION_EXPIRED");
      }
      if (profile.authorizationId !== plan.priorAuthorizationId) {
        throw new Error("REAUTHORIZATION_AUTHORITY_CHANGED");
      }
      const livePolicy = walletPolicySnapshot(
        draft.onboarding,
        countAuthorizationRequests(draft, profile.authorizationId),
      );
      if (!samePolicySnapshot(livePolicy, plan.currentPolicy)) {
        throw new Error("REAUTHORIZATION_POLICY_CHANGED");
      }
      profile.authorizationId = `auth_${randomUUID()}`;
      profile.updatedAt = now.toISOString();
      const {
        paymentsUsed: _paymentsUsed,
        paymentsRemaining: _paymentsRemaining,
        ...delegation
      } = plan.proposedPolicy;
      draft.onboarding.delegation = delegation;
      draft.onboarding.revision += 1;
      draft.onboarding.updatedAt = now.toISOString();
      plan.appliedAt = now.toISOString();
      plan.appliedAuthorizationId = profile.authorizationId;
      result = {
        profile: structuredClone(profile),
        onboarding: structuredClone(draft.onboarding),
      };
    });
    return result!;
  }

  async archiveAndReset(newWalletName: string): Promise<{
    archiveId: string;
    previous: StateDocument;
    current: StateDocument;
  }> {
    const operation = this.#queue.then(async () => {
      const previous = await this.read();
      if (!previous.wallet) throw new Error("WALLET_REGISTRY_MISSING");
      syncActiveOnboarding(previous);
      const archiveId = await this.#archiveState(previous);
      const archived = cloneState(previous);
      const prior = previous.wallet.profiles[previous.wallet.activeWalletId]!;
      prior.archiveIds.push(archiveId);
      prior.updatedAt = new Date().toISOString();
      let target = findProfileByName(previous.wallet.profiles, newWalletName);
      if (!target) {
        target = createWalletProfile(
          newWalletName,
          "created",
          new Date().toISOString(),
          1,
          false,
        );
        previous.wallet.profiles[target.walletId] = target;
      } else {
        target.selectionEpoch += 1;
        delete target.authorizationId;
        target.status = "available";
        target.updatedAt = new Date().toISOString();
      }
      previous.wallet.activeWalletId = target.walletId;
      previous.wallet.activeName = target.name;
      delete previous.onboarding;
      validateState(previous);
      await this.#write(previous);
      this.#events.emit("change", cloneState(previous));
      return { archiveId, previous: archived, current: cloneState(previous) };
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
        if (state.onboarding && state.onboarding.revision > sinceRevision) finish(state.onboarding);
      };
      this.#events.on("change", listener);
      void this.read().then(
        (state) => {
          if ((state.onboarding && state.onboarding.revision > sinceRevision) || waitMs === 0) {
            finish(state.onboarding);
            return;
          }
          timer = setTimeout(() => {
            void this.read().then((latest) => finish(latest.onboarding), () => finish(undefined));
          }, waitMs);
        },
        () => finish(undefined),
      );
    });
  }

  async #archiveState(state: StateDocument): Promise<string> {
    const archiveId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
    const archiveDir = join(this.#stateDir, "archives", archiveId);
    await mkdir(archiveDir, { recursive: true, mode: 0o700 });
    await chmod(archiveDir, 0o700);
    await this.#writePath(join(archiveDir, "state.json"), state);
    return archiveId;
  }

  async #write(state: StateDocument): Promise<void> {
    await this.#writePath(this.#path, state);
  }

  async #writePath(path: string, state: StateDocument): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o600);
    await rename(temp, path);
    await chmod(path, 0o600);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

function migrateV1(
  legacy: LegacyStateDocument,
  defaultWalletName: string,
): StateDocument {
  const state: StateDocument = {
    version: 2,
    ...(legacy.onboarding ? { onboarding: structuredClone(legacy.onboarding) } : {}),
    plans: legacy.plans ?? {},
    policyPlans: structuredClone(legacy.policyPlans ?? {}) as Record<string, PolicyUpdatePlan>,
    requests: legacy.requests ?? {},
    recoveryPlans: {},
    recoveryRequests: {},
    reauthorizationPlans: {},
  };
  if (legacy.wallet || legacy.onboarding ||
    Object.keys(legacy.plans ?? {}).length > 0 ||
    Object.keys(legacy.policyPlans ?? {}).length > 0 ||
    Object.keys(legacy.requests ?? {}).length > 0) {
    const now = new Date().toISOString();
    const profile = createWalletProfile(
      legacy.wallet?.activeName ?? defaultWalletName,
      "created",
      now,
      1,
      true,
    );
    if (state.onboarding) profile.onboarding = state.onboarding;
    state.wallet = {
      activeWalletId: profile.walletId,
      activeName: profile.name,
      profiles: { [profile.walletId]: profile },
    };
    bindLegacyHistory(state, profile);
  }
  return state;
}

function bindLegacyHistory(state: StateDocument, profile: WalletProfileRecord): void {
  if (!profile.authorizationId) return;
  const authorization = {
    walletId: profile.walletId,
    walletName: profile.name,
    selectionEpoch: profile.selectionEpoch,
    authorizationId: profile.authorizationId,
  };
  for (const [decisionId, plan] of Object.entries(state.plans)) {
    plan.authorization ??= authorization;
    // A v1 digest did not commit the wallet, selection epoch, or authorization.
    // Keep the record for audit/reconciliation, but it can never authorize a
    // post-migration broadcast.
    plan.decision = "deny";
    if (!plan.blockers.includes("STATE_MIGRATION_REPLAN_REQUIRED")) {
      plan.blockers.push("STATE_MIGRATION_REPLAN_REQUIRED");
    }
    plan.approval = {
      action: "deny",
      userConfirmationRequired: false,
    };
    if (plan.decisionId !== decisionId) {
      throw new Error("Legacy payment plan map key is invalid");
    }
  }
  for (const request of Object.values(state.requests)) {
    request.authorization ??= authorization;
    if (state.plans[request.decisionId]) continue;
    state.plans[request.decisionId] = {
      version: 1,
      decisionId: request.decisionId,
      recipient: request.recipient,
      amountWei: request.amountWei,
      authorization,
      intentDigest: `sha256:${"0".repeat(64)}`,
      createdAt: request.createdAt,
      expiresAt: request.createdAt,
      decision: "deny",
      blockers: ["STATE_MIGRATION_REPLAN_REQUIRED"],
      approval: { action: "deny", userConfirmationRequired: false },
    };
  }
  for (const plan of Object.values(state.policyPlans)) {
    plan.wallet ??= {
      walletId: profile.walletId,
      walletName: profile.name,
      selectionEpoch: profile.selectionEpoch,
    };
    if (plan.appliedAt) {
      plan.appliedPolicy ??= structuredClone(plan.proposed);
    } else {
      plan.decision = "deny";
      if (!plan.blockers.includes("STATE_MIGRATION_REPLAN_REQUIRED")) {
        plan.blockers.push("STATE_MIGRATION_REPLAN_REQUIRED");
      }
    }
  }
}

function syncActiveOnboarding(state: StateDocument): void {
  if (!state.wallet) return;
  const profile = state.wallet.profiles[state.wallet.activeWalletId];
  if (!profile) return;
  if (state.onboarding) profile.onboarding = structuredClone(state.onboarding);
  else delete profile.onboarding;
}

function ensureWalletRegistryForState(
  state: StateDocument,
  defaultWalletName: string,
): void {
  if (state.wallet || !hasWalletBoundState(state)) return;
  const now = new Date().toISOString();
  const profile = createWalletProfile(defaultWalletName, "created", now, 1, true);
  if (state.onboarding) profile.onboarding = structuredClone(state.onboarding);
  state.wallet = {
    activeWalletId: profile.walletId,
    activeName: profile.name,
    profiles: { [profile.walletId]: profile },
  };
  bindLegacyHistory(state, profile);
}

function hasWalletBoundState(state: StateDocument): boolean {
  return Boolean(
    state.onboarding ||
    Object.keys(state.plans).length ||
    Object.keys(state.policyPlans).length ||
    Object.keys(state.requests).length ||
    Object.keys(state.recoveryPlans).length ||
    Object.keys(state.recoveryRequests).length ||
    Object.keys(state.reauthorizationPlans).length
  );
}

function validateState(state: StateDocument): void {
  if (state.version !== 2 || !state.plans || !state.requests ||
    !state.policyPlans || !state.recoveryPlans || !state.recoveryRequests ||
    !state.reauthorizationPlans) {
    throw new Error("Unsupported or corrupt Agent Boost state document");
  }
  if (!state.wallet) {
    if (state.onboarding || Object.keys(state.plans).length ||
      Object.keys(state.requests).length || Object.keys(state.recoveryPlans).length ||
      Object.keys(state.recoveryRequests).length ||
      Object.keys(state.reauthorizationPlans).length || Object.keys(state.policyPlans).length) {
      throw new Error("Wallet-bound state exists without a wallet registry");
    }
    return;
  }
  const active = state.wallet.profiles[state.wallet.activeWalletId];
  if (!active || active.name !== state.wallet.activeName || active.status === "archived") {
    throw new Error("Active wallet registry reference is invalid");
  }
  if (!sameOnboarding(state.onboarding, active.onboarding)) {
    throw new Error("Active wallet onboarding state is inconsistent");
  }
  if (state.onboarding?.delegation.enabled && !active.authorizationId) {
    throw new Error("Enabled delegation has no active wallet authorization");
  }
  const names = new Set<string>();
  for (const [walletId, profile] of Object.entries(state.wallet.profiles)) {
    if (walletId !== profile.walletId || names.has(profile.name) || profile.selectionEpoch < 0) {
      throw new Error("Wallet registry is corrupt");
    }
    names.add(profile.name);
  }
  const validateAuthorization = (value: { authorization?: { walletId: string; walletName: string; selectionEpoch: number; authorizationId: string } }): void => {
    const binding = value.authorization;
    if (!binding) throw new Error("Wallet authority binding is missing");
    const profile = state.wallet!.profiles[binding.walletId];
    if (!profile || profile.name !== binding.walletName ||
      binding.selectionEpoch < 1 || binding.selectionEpoch > profile.selectionEpoch ||
      !binding.authorizationId.startsWith("auth_")) {
      throw new Error("Wallet authority binding is invalid");
    }
  };
  for (const [decisionId, plan] of Object.entries(state.plans)) {
    if (decisionId !== plan.decisionId) throw new Error("Payment plan map key is invalid");
    validateAuthorization(plan);
  }
  for (const [requestId, request] of Object.entries(state.requests)) {
    if (requestId !== request.requestId) throw new Error("Payment request map key is invalid");
    validateAuthorization(request);
    const plan = state.plans[request.decisionId];
    if (!plan || !sameAuthorizationBinding(plan.authorization, request.authorization) ||
      plan.recipient !== request.recipient || plan.amountWei !== request.amountWei) {
      throw new Error("Payment request plan reference is invalid");
    }
  }
  const validateSelection = (value: { wallet: { walletId: string; walletName: string; selectionEpoch: number } }): void => {
    const profile = state.wallet!.profiles[value.wallet.walletId];
    if (!profile || profile.name !== value.wallet.walletName ||
      value.wallet.selectionEpoch < 1 || value.wallet.selectionEpoch > profile.selectionEpoch) {
      throw new Error("Wallet selection binding is invalid");
    }
  };
  for (const [decisionId, plan] of Object.entries(state.recoveryPlans)) {
    if (decisionId !== plan.decisionId) throw new Error("Recovery plan map key is invalid");
    validateSelection(plan);
  }
  for (const [requestId, request] of Object.entries(state.recoveryRequests)) {
    if (requestId !== request.requestId) throw new Error("Recovery request map key is invalid");
    validateSelection(request);
    const plan = state.recoveryPlans[request.decisionId];
    if (!plan || !sameSelectionBinding(plan.wallet, request.wallet) ||
      plan.recipient !== request.recipient || plan.amountWei !== request.amountWei ||
      (plan.consumedByRequestId !== undefined && plan.consumedByRequestId !== request.requestId)) {
      throw new Error("Recovery request plan reference is invalid");
    }
  }
  for (const [decisionId, plan] of Object.entries(state.policyPlans)) {
    if (decisionId !== plan.decisionId) throw new Error("Policy plan map key is invalid");
    validateSelection(plan);
    if (plan.authorizationId !== undefined && !plan.authorizationId.startsWith("auth_")) {
      throw new Error("Policy authorization binding is invalid");
    }
  }
  for (const [decisionId, plan] of Object.entries(state.reauthorizationPlans)) {
    if (decisionId !== plan.decisionId) {
      throw new Error("Reauthorization plan map key is invalid");
    }
    validateSelection(plan);
  }
}

function sameOnboarding(
  left: OnboardingRecord | undefined,
  right: OnboardingRecord | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function sameSelectionBinding(
  left: { walletId: string; walletName: string; selectionEpoch: number },
  right: { walletId: string; walletName: string; selectionEpoch: number },
): boolean {
  return left.walletId === right.walletId && left.walletName === right.walletName &&
    left.selectionEpoch === right.selectionEpoch;
}

function sameAuthorizationBinding(
  left: { walletId: string; walletName: string; selectionEpoch: number; authorizationId: string },
  right: { walletId: string; walletName: string; selectionEpoch: number; authorizationId: string },
): boolean {
  return sameSelectionBinding(left, right) && left.authorizationId === right.authorizationId;
}

function countAuthorizationRequests(
  state: StateDocument,
  authorizationId: string | undefined,
): number {
  if (!authorizationId) return 0;
  return Object.values(state.requests).filter(
    (request) => request.authorization.authorizationId === authorizationId,
  ).length;
}

function walletPolicySnapshot(
  onboarding: OnboardingRecord,
  paymentsUsed: number,
): WalletPolicySnapshot {
  return {
    ...onboarding.delegation,
    paymentsUsed,
    paymentsRemaining: Math.max(0, onboarding.delegation.maxPayments - paymentsUsed),
  };
}

function samePolicySnapshot(
  left: WalletPolicySnapshot,
  right: WalletPolicySnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createWalletProfile(
  name: string,
  origin: WalletProfileOrigin,
  now: string,
  selectionEpoch: number,
  authorized: boolean,
): WalletProfileRecord {
  return {
    version: 1,
    walletId: `wallet_${randomUUID()}`,
    name,
    origin,
    status: "available",
    createdAt: now,
    updatedAt: now,
    ...(selectionEpoch > 0 ? { lastSelectedAt: now } : {}),
    selectionEpoch,
    ...(authorized ? { authorizationId: `auth_${randomUUID()}` } : {}),
    archiveIds: [],
  };
}

function findProfileByName(
  profiles: Record<string, WalletProfileRecord>,
  name: string,
): WalletProfileRecord | undefined {
  return Object.values(profiles).find((profile) => profile.name === name);
}
