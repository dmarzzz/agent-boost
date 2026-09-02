import { createHash } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type {
  OnboardingRecord,
  PaymentPlan,
  PaymentRequest,
  PublicOnboardingSnapshot,
} from "./contracts.js";
import { buildSepoliaFundingUri } from "./ui/index.js";

export interface AgentBoostRuntime {
  capabilities(): Promise<Record<string, unknown>>;
  startOnboarding(): Promise<{
    record: OnboardingRecord;
    snapshot: PublicOnboardingSnapshot;
    uiOpened: boolean;
    qrPngBase64?: string;
  }>;
  onboardingStatus(input: {
    setupId: string;
    sinceRevision?: number;
    waitMs?: number;
  }): Promise<OnboardingRecord>;
  walletContext(): Promise<Record<string, unknown>>;
  planPrivatePayment(input: {
    recipient: string;
    amountWei: string;
  }): Promise<PaymentPlan>;
  executePrivatePayment(input: {
    decisionId: string;
    clientRequestId: string;
    userConfirmed: boolean;
  }): Promise<PaymentRequest>;
  getRequest(requestId: string): Promise<PaymentRequest>;
}

type Outcome =
  | "ready"
  | "blocked"
  | "awaiting_funding"
  | "executing"
  | "submitted"
  | "confirmed"
  | "failed"
  | "indeterminate";

function manifestDigest(capabilities: Record<string, unknown>): string {
  const { readiness: _readiness, ...manifest } = capabilities;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex")}`;
}

function envelope(
  digest: string,
  outcome: Outcome,
  code: string,
  data: Record<string, unknown>,
  retry: {
    mode: "never" | "wait" | "refresh_plan";
    safeWithSameArguments: boolean;
    afterMs?: number;
  } = { mode: "never", safeWithSameArguments: false },
): Record<string, unknown> {
  return {
    schema: "org.agentboost.tool-result",
    schema_version: "1.0",
    manifest_digest: digest,
    outcome,
    code,
    retry: {
      mode: retry.mode,
      safe_with_same_arguments: retry.safeWithSameArguments,
      ...(retry.afterMs === undefined ? {} : { after_ms: retry.afterMs }),
    },
    data,
  };
}

function result(
  structured: Record<string, unknown>,
  qrPngBase64?: string,
): CallToolResult {
  return {
    structuredContent: structured,
    content: [
      { type: "text", text: compactToolText(structured) },
      ...(qrPngBase64
        ? [{ type: "image" as const, data: qrPngBase64, mimeType: "image/png" }]
        : []),
    ],
  };
}

function compactToolText(structured: Record<string, unknown>): string {
  const code = typeof structured.code === "string" ? structured.code : "RESULT";
  const outcome = typeof structured.outcome === "string" ? structured.outcome : "unknown";
  const data = asRecord(structured.data);

  if (code === "REQUEST_BLOCKED") {
    const message = stringField(data, "message") ?? "The request was blocked.";
    return `Agent Boost blocked this request: ${message}`;
  }

  if (code === "CAPABILITIES") {
    const security = asRecord(data.security);
    const effective = asRecord(security.effective);
    const approval = stringField(effective, "payment.execute") ?? "confirm";
    return `Sepolia-only capabilities loaded. Payment execution policy: ${approval}. Use structuredContent for exact reasoning; keep the user-facing answer concise.`;
  }

  if (code === "ONBOARDING_STARTED" || code === "ONBOARDING_STATUS") {
    const setup = asRecord(data.setup);
    const funding = asRecord(data.funding);
    const phase = stringField(setup, "phase") ?? outcome;
    const remaining = stringField(funding, "remaining_amount_eth");
    const address = stringField(funding, "address") ?? stringField(setup, "address");
    if (remaining && remaining !== "0" && address) {
      return `Funding needed: ${remaining} Sepolia ETH to ${address}. A QR is attached when available. After sending, the user can reply ✅ or say sent.`;
    }
    if (phase === "private_ready") {
      const privateBalance = stringField(setup, "privateBalanceWei");
      const amount = privateBalance ? formatEthWei(BigInt(privateBalance)) : "unknown";
      return `Setup ready. Private spendable test balance: ${amount} Sepolia ETH. Reply with one concise confirmation.`;
    }
    return `Setup status: ${phase}. Use the structured status internally and give the user only the next action.`;
  }

  if (code === "WALLET_CONTEXT") {
    const balances = asRecord(data.balances);
    const privateBalance = stringField(balances, "private_payment_spendable_atomic");
    const amount = privateBalance ? formatEthWei(BigInt(privateBalance)) : "unknown";
    const phase = stringField(data, "setup_phase") ?? "unknown";
    return `Wallet status: ${phase}. Private spendable test balance: ${amount} Sepolia ETH. Do not expose raw atomic values unless asked.`;
  }

  if (code === "PAYMENT_PLANNED" || code === "PAYMENT_DENIED") {
    const plan = asRecord(data.plan);
    const recipient = stringField(plan, "recipient") ?? "unknown recipient";
    const amountWei = stringField(plan, "amountWei");
    const amount = amountWei ? formatEthWei(BigInt(amountWei)) : "unknown";
    const approval = asRecord(plan.approval);
    const confirmationRequired = approval.userConfirmationRequired === true;
    if (code === "PAYMENT_DENIED") {
      return `Payment plan blocked for ${amount} Sepolia ETH to ${recipient}. Explain the blocker concisely; do not show internal IDs.`;
    }
    return confirmationRequired
      ? `Payment ready for approval: ${amount} Sepolia ETH to ${recipient}. Ask the user to reply ✅, yes, or send it. The agent—not the user—must call the execution tool after approval.`
      : `Payment approved by the active local policy: ${amount} Sepolia ETH to ${recipient}. The agent may execute it now within the hard delegation limits.`;
  }

  if (code === "PAYMENT_REQUEST" || code === "PAYMENT_STATUS") {
    const request = asRecord(data.request);
    const phase = stringField(request, "phase") ?? outcome;
    const recipient = stringField(request, "recipient") ?? "the recipient";
    const amountWei = stringField(request, "amountWei");
    const amount = amountWei ? formatEthWei(BigInt(amountWei)) : "unknown";
    if (phase === "confirmed") {
      return `Payment confirmed: ${amount} Sepolia ETH to ${recipient}. Keep the receipt concise.`;
    }
    if (phase === "failed") {
      return `Payment failed: ${amount} Sepolia ETH to ${recipient}. Do not retry without a new user request.`;
    }
    return `Payment is not confirmed (${phase}). Call wallet_get_request with the structured requestId. Never infer success from balances and never retry execution with a new ID.`;
  }

  return `Agent Boost result: ${outcome}. Use structuredContent internally and show only the user's next action.`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function domainError(digest: string, error: unknown): CallToolResult {
  const message = redactPublicMessage(
    error instanceof Error ? error.message : String(error),
  );
  return result(
    envelope(digest, "blocked", "REQUEST_BLOCKED", {
      message: message.slice(0, 500),
    }),
  );
}

export function redactPublicMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(
      /(^|[\s("'`])\/(?:Users|home|private|tmp|var|etc|opt|root|run)\/[^\s"'`<>)]*/giu,
      "$1[redacted-path]",
    )
    .slice(0, 500);
}

function onboardingOutcome(record: OnboardingRecord): Outcome {
  if (record.phase === "private_ready") return "ready";
  if (record.phase === "failed") return "failed";
  if (
    record.phase === "awaiting_funding" ||
    record.phase === "funding_pending"
  ) {
    return "awaiting_funding";
  }
  return "executing";
}

function publicOnboardingState(
  record: OnboardingRecord | PublicOnboardingSnapshot,
): Record<string, unknown> {
  const publicState: Record<string, unknown> = { ...record };
  delete publicState.uiUrl;
  delete publicState.uiOpened;
  return publicState;
}

function formatEthWei(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n;
  const fractional = (wei % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/u, "");
  return fractional ? `${whole.toString()}.${fractional}` : whole.toString();
}

function fundingDetails(
  record: OnboardingRecord | PublicOnboardingSnapshot,
  qrAttached: boolean,
): Record<string, unknown> {
  const required = BigInt(record.requiredFundingWei);
  const publicBalance = BigInt(record.publicBalanceWei);
  const remaining = required > publicBalance ? required - publicBalance : 0n;
  return {
    chain_id: "eip155:11155111",
    network: "Sepolia",
    asset: "Sepolia ETH",
    ...(record.address ? { address: record.address } : {}),
    ...(record.address && remaining > 0n
      ? { funding_uri: buildSepoliaFundingUri(record.address, remaining.toString()) }
      : {}),
    remaining_amount_wei: remaining.toString(),
    remaining_amount_eth: formatEthWei(remaining),
    qr_attached: qrAttached,
  };
}

function requestOutcome(request: PaymentRequest): Outcome {
  if (request.phase === "planned") return "ready";
  return request.phase;
}

export async function createMcpServer(
  runtime: AgentBoostRuntime,
): Promise<McpServer> {
  const capabilities = await runtime.capabilities();
  const digest = manifestDigest(capabilities);
  const server = new McpServer(
    { name: "agent-boost", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.registerTool(
    "capabilities",
    {
      title: "Agent Boost capabilities",
      description:
        "Read the Sepolia wallet contract, live feature readiness, delegated testnet limits, and explicit privacy exclusions. This grants no authority.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      result(
        envelope(digest, "ready", "CAPABILITIES", await runtime.capabilities()),
      ),
  );

  server.registerTool(
    "onboarding_start",
    {
      title: "Start private-wallet onboarding",
      description:
        "Idempotently create or resume a disposable Sepolia wallet, return a funding QR with an exact address and amount fallback, and optionally open a host-local page. Never replaces an existing wallet.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        const started = await runtime.startOnboarding();
        return result(
          envelope(
            digest,
            onboardingOutcome(started.record),
            "ONBOARDING_STARTED",
            {
              setup: publicOnboardingState(started.record),
              public: publicOnboardingState(started.snapshot),
              funding: fundingDetails(started.snapshot, Boolean(started.qrPngBase64)),
              ui_opened: started.uiOpened,
            },
            { mode: "wait", safeWithSameArguments: true, afterMs: 2_000 },
          ),
          started.qrPngBase64,
        );
      } catch (error) {
        return domainError(digest, error);
      }
    },
  );

  server.registerTool(
    "onboarding_status",
    {
      title: "Wait for onboarding progress",
      description:
        "Return or long-poll durable wallet setup state. Use the setup ID from onboarding_start. private_ready means 0.1 Sepolia ETH is spendable through the selected privacy protocol.",
      inputSchema: z.object({
        setup_id: z.string().min(8),
        since_revision: z.number().int().min(0).optional(),
        wait_ms: z.number().int().min(0).max(90_000).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ setup_id, since_revision, wait_ms }) => {
      try {
        const record = await runtime.onboardingStatus({
          setupId: setup_id,
          ...(since_revision === undefined ? {} : { sinceRevision: since_revision }),
          ...(wait_ms === undefined ? {} : { waitMs: wait_ms }),
        });
        return result(
          envelope(
            digest,
            onboardingOutcome(record),
            "ONBOARDING_STATUS",
            {
              setup: publicOnboardingState(record),
              funding: fundingDetails(record, false),
            },
            record.phase === "private_ready" || record.phase === "failed"
              ? { mode: "never", safeWithSameArguments: false }
              : { mode: "wait", safeWithSameArguments: true, afterMs: 2_000 },
          ),
        );
      } catch (error) {
        return domainError(digest, error);
      }
    },
  );

  server.registerTool(
    "wallet_get_context",
    {
      title: "Read wallet context",
      description:
        "Read the disposable Sepolia wallet address, public/private balances, setup state, active security policy, and bounded delegated-spend policy. The agent calls this silently for reasoning and keeps the user response concise. Returns no seed, key, password, or raw note material.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return result(
          envelope(digest, "ready", "WALLET_CONTEXT", await runtime.walletContext()),
        );
      } catch (error) {
        return domainError(digest, error);
      }
    },
  );

  server.registerTool(
    "wallet_plan_private_payment",
    {
      title: "Plan a shielded Sepolia test payment",
      description:
        "The agent—not the user—calls this to prepare one exact native-ETH payment from the private test balance. amount_atomic is wei. Planning never executes. Return a short human readback and, when the active policy requires it, accept ordinary approval such as yes, send it, or ✅. Never ask the user to type an MCP command or identifier.",
      inputSchema: z.object({
        recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        amount_atomic: z.string().regex(/^(0|[1-9][0-9]*)$/),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ recipient, amount_atomic }) => {
      try {
        const plan = await runtime.planPrivatePayment({
          recipient,
          amountWei: amount_atomic,
        });
        return result(
          envelope(
            digest,
            plan.decision === "allow" ? "ready" : "blocked",
            plan.decision === "allow" ? "PAYMENT_PLANNED" : "PAYMENT_DENIED",
            { plan },
            plan.decision === "allow"
              ? { mode: "never", safeWithSameArguments: false }
              : { mode: "refresh_plan", safeWithSameArguments: true },
          ),
        );
      } catch (error) {
        return domainError(digest, error);
      }
    },
  );

  server.registerTool(
    "wallet_execute_private_payment",
    {
      title: "Execute a bounded shielded Sepolia test payment",
      description:
        "The agent—not the user—calls this for one unexpired allow decision. Under the default confirm policy, call after the user approves the exact displayed plan using ordinary language or an approval emoji. Under an allow override, confirmation is not required. Hard Sepolia delegation limits always apply. Never ask the user to supply tool syntax, IDs, or booleans.",
      inputSchema: z.object({
        decision_id: z.string().startsWith("wd_"),
        client_request_id: z.string().min(8).max(200).optional().describe(
          "Optional stable idempotency key. Omit to derive one from decision_id; the user never supplies this.",
        ),
        user_confirmed: z.boolean().optional().describe(
          "Set true after the user approves the exact displayed plan. Omit under a local allow override.",
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ decision_id, client_request_id, user_confirmed }) => {
      try {
        const request = await runtime.executePrivatePayment({
          decisionId: decision_id,
          clientRequestId: client_request_id ?? `hermes:${decision_id}`,
          userConfirmed: user_confirmed ?? false,
        });
        return result(
          envelope(
            digest,
            requestOutcome(request),
            "PAYMENT_REQUEST",
            { request },
            request.phase === "executing" || request.phase === "submitted"
              ? { mode: "wait", safeWithSameArguments: true, afterMs: 3_000 }
              : { mode: "never", safeWithSameArguments: false },
          ),
        );
      } catch (error) {
        return domainError(digest, error);
      }
    },
  );

  server.registerTool(
    "wallet_get_request",
    {
      title: "Read private-payment request status",
      description:
        "Read durable redacted request state. submitted is not confirmed; indeterminate must not be retried with a new client request ID.",
      inputSchema: z.object({ request_id: z.string().startsWith("req_") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ request_id }) => {
      try {
        const request = await runtime.getRequest(request_id);
        return result(
          envelope(digest, requestOutcome(request), "PAYMENT_STATUS", { request }),
        );
      } catch (error) {
        return domainError(digest, error);
      }
    },
  );

  server.registerResource(
    "wallet-capability-v1",
    "agent-boost://capabilities/wallet/v1",
    {
      title: "Agent Boost wallet capability v1",
      description: "Descriptive Sepolia wallet support and authority limits.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            ...(await runtime.capabilities()),
            manifest_digest: digest,
          }),
        },
      ],
    }),
  );

  return server;
}

export async function runStdioMcp(runtime: AgentBoostRuntime): Promise<void> {
  const server = await createMcpServer(runtime);
  const closed = new Promise<void>((resolve, reject) => {
    server.server.onclose = resolve;
    server.server.onerror = reject;
  });
  await server.connect(new StdioServerTransport());
  await closed;
}
