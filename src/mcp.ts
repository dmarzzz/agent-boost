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
      { type: "text", text: JSON.stringify(structured) },
      ...(qrPngBase64
        ? [{ type: "image" as const, data: qrPngBase64, mimeType: "image/png" }]
        : []),
    ],
  };
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
        "Idempotently create or resume a disposable Sepolia wallet, open the local QR funding page when possible, and begin privacy preparation. Never replaces an existing wallet.",
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
              setup: started.record,
              public: started.snapshot,
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
            { setup: record },
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
        "Read the disposable Sepolia wallet address, public/private balances, setup state, and bounded delegated-spend policy. Returns no seed, key, password, or raw note material.",
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
        "Evaluate one exact native-ETH payment from the prepared private balance. amount_atomic is wei. Planning never executes or reserves a payment. Read exact terms and limitations back to the user before execution.",
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
        "Execute one unexpired allow decision under the setup-time Sepolia-only delegation. Call only after reading back recipient, amount, fee limitations, privacy limitations, and receiving explicit verbal confirmation. This tool can cause signing and broadcast within the reported testnet limits.",
      inputSchema: z.object({
        decision_id: z.string().startsWith("wd_"),
        client_request_id: z.string().min(8).max(200),
        user_confirmed: z.boolean(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ decision_id, client_request_id, user_confirmed }) => {
      try {
        const request = await runtime.executePrivatePayment({
          decisionId: decision_id,
          clientRequestId: client_request_id,
          userConfirmed: user_confirmed,
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
