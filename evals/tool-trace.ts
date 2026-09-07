export interface ModelVisibleToolCallTrace {
  turn: number;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Extract one model-visible MCP tool-call attempt at the transport boundary.
 * This runs before tool lookup, input validation, or a runtime method, so
 * rejected and unknown calls remain visible to the live-eval grader.
 */
export function modelVisibleToolCallTrace(
  message: unknown,
  turn: number,
): ModelVisibleToolCallTrace | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const request = message as {
    method?: unknown;
    params?: { name?: unknown; arguments?: unknown };
  };
  if (request.method !== "tools/call" || typeof request.params?.name !== "string") {
    return undefined;
  }
  const rawArguments = request.params.arguments;
  const publicArguments = rawArguments !== null && typeof rawArguments === "object" &&
      !Array.isArray(rawArguments)
    ? rawArguments as Record<string, unknown>
    : {};
  return {
    turn,
    name: request.params.name,
    arguments: publicArguments,
  };
}
