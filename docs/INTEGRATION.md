# Integration

This document defines the intended POC integration contract. Until the first
release is tagged, commands and schemas are design commitments rather than
working-install claims.

## Prerequisites

The first event build targets macOS on Apple silicon. The architecture also
targets Linux after the event build. The installer checks for:

- a supported host and sandbox mechanism;
- a local agent runtime;
- Node.js 22 or newer and a pinned Kohaku CLI build;
- Tor connectivity and an operator-supplied Shade Tree v4 access profile;
- an HTTPS Sepolia RPC endpoint supplied at runtime;
- a sandbox mechanism that denies the agent ambient network and operator-state
  access;
- separate agent and operator authority, either with distinct OS identities or
  cryptographic operator authentication.

`agent-boost doctor` reports each dependency, version, and remediation without
printing secret configuration.

## Initialize and start

```console
agent-boost init --network sepolia
agent-boost doctor --strict
agent-boost up
agent-boost status
```

`init` writes config under `~/.config/agent-boost/` and runtime state under
`~/.local/share/agent-boost/`. Re-running it is non-destructive. An existing
wallet is never replaced without an explicit, separately confirmed operation.

## Contract layers

Agent Boost deliberately separates three things:

1. The capability profile describes support, versions, chain scope, guarantees,
   and authority exclusions.
2. An optional agent-framework skill teaches the intended tool sequence.
3. The MCP server enforces policy, freshness, reservations, idempotency,
   approval, signing, and routing.

The profile and skill grant no authority. The agent may observe public wallet
facts and create review requests; only the operator control plane can unlock,
approve, reject, sign, or broadcast.

## Strict MCP integration

Generic MCP configuration:

```json
{
  "mcpServers": {
    "agent-boost": {
      "command": "/absolute/path/to/agent-boost",
      "args": ["mcp", "--mode", "dark"]
    }
  }
}
```

Start the agent inside a sandbox that denies ambient network, the Agent Boost
operator socket, wallet state, and adapter credentials. `agent-boost doctor
--strict` refuses to pass if its agent-sandbox canary opens a direct connection
or the operator control path.

### Hermes configuration

Hermes consumes Agent Boost as one stdio MCP server:

```yaml
mcp_servers:
  agent-boost:
    command: /absolute/path/to/agent-boost
    args: [mcp, --mode, dark, --contract-major, "1"]
    enabled: true
    supports_parallel_tool_calls: false
    tools:
      include:
        - capabilities
        - dark_fetch
        - wallet_get_context
        - wallet_plan_payment
        - wallet_create_receive
        - wallet_prepare_payment
        - wallet_get_request
      resources: false
      prompts: false
```

The example targets the deployed Hermes 0.16.0 compatibility floor. Current
Hermes can add `trust: untrusted` as a separate host confirmation layer, but
Agent Boost must not rely on that for signing approval.

Hermes-generated names changed across versions: 0.16.0 uses
`mcp_agent_boost_wallet_get_context`; current `main` uses
`mcp__agent_boost__wallet_get_context`. Agent Boost documents and allowlists the
native name `wallet_get_context`; the host prefix is an implementation detail.

Hermes exposes MCP descriptions and input schemas to the model but not output
schemas. Tool descriptions therefore repeat critical workflow semantics, and
results are self-describing structured JSON. `structuredContent` is still
useful to Hermes at call time and to other MCP hosts.

An optional project skill is supplied at
[`integrations/hermes/agent-boost/SKILL.md`](../integrations/hermes/agent-boost/SKILL.md).
It is choreography only and may be omitted without weakening enforcement.

## Capability profile

The model can call `capabilities`. Hosts can also read the mirror resource:

```text
agent-boost://capabilities/wallet/v1
```

The profile reports:

- schema and semantic versions plus a manifest digest;
- CAIP-2 chain scopes, CAIP-10 account format, and CAIP-19 asset format;
- supported payment, receive, and egress features;
- live wallet, egress, and private-RPC readiness;
- snapshot and execution-revalidation guarantees;
- agent-visible facts and explicit operator-only authority.

It contains no balance, private key, bearer token, or signing capability. Live
facts belong in context and planning results.

## Native tools

### `capabilities`

No input. Returns the versioned profile, manifest digest, mode, readiness, and
explicit fields such as `agent_can_sign: false` and
`agent_can_approve: false`.

Call once on integration startup, after a version/readiness change, or when a
tool returns `UNSUPPORTED_VERSION` or `FEATURE_UNSUPPORTED`. Routine payment
decisions do not depend on the model remembering this call; live planning
results carry the digest and relevant feature state.

### `dark_fetch`

```json
{
  "url": "https://example.com/data.json",
  "method": "GET",
  "headers": {"accept": "application/json"},
  "max_bytes": 1048576,
  "timeout_ms": 15000
}
```

The POC permits only `GET` and `HEAD` over `http` or `https`. It strips
hop-by-hop and credential headers, applies destination policy before DNS,
limits the result, marks content untrusted, and returns a redacted receipt ID.
Side-effecting HTTP requires a future separately governed tool.

### `wallet_get_context`

This is the read-only surface for general wallet-dependent reasoning:

```json
{
  "chain_id": "eip155:11155111",
  "asset_types": [
    "eip155:11155111/erc20:0x2222222222222222222222222222222222222222"
  ]
}
```

The result includes:

- account ID and public address;
- total, reserved, and spendable amount for requested assets and the native fee
  asset;
- pending reservations and request IDs;
- policy allowance and approval mode;
- block number/hash, observation time, expiry, and dark-route health;
- manifest digest and relevant runtime feature state.

It excludes seeds, private keys, viewing/spending secrets, unlock values,
approval credentials, raw signed transactions, and adapter credentials.

### `wallet_plan_payment`

This is the decision surface for one exact payment:

```json
{
  "chain_id": "eip155:11155111",
  "to_account_id": "eip155:11155111:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "asset_type": "eip155:11155111/erc20:0x2222222222222222222222222222222222222222",
  "amount_atomic": "10000000",
  "fee_ceiling": {
    "asset_type": "eip155:11155111/slip44:60",
    "amount_atomic": "30000000000000"
  }
}
```

All authority-bearing monetary values are canonical, non-negative atomic-unit
integer strings paired with a CAIP-19 asset identifier. Human-formatted decimal
amounts are display metadata and are excluded from intent digests. The result
returns the public account, principal and fee-asset balances, reservations,
estimated fee, policy decision, route health, freshness, and named checks.
The following result is abridged; every real response uses the complete
`tool-result-v1` envelope:

```json
{
  "outcome": "ready",
  "decision": {
    "decision_id": "wd_01J…",
    "intent_digest": "sha256:…",
    "decision": "allow",
    "can_afford": true,
    "expires_at": "2026-09-05T14:02:30Z",
    "grants_signing_authority": false
  },
  "checks": [
    {"name": "payment_asset_balance", "state": "pass"},
    {"name": "fee_asset_balance", "state": "pass"},
    {"name": "policy", "state": "pass"},
    {"name": "feature_support", "state": "pass"},
    {"name": "dark_route", "state": "pass"},
    {"name": "freshness", "state": "pass"}
  ],
  "blockers": []
}
```

Decision values are tri-state: `allow`, `deny`, or `indeterminate`.
`can_afford` is respectively `true`, `false`, or `null`. Missing fee, policy,
route, feature, or freshness data can never produce `allow`.

A blocked result identifies the exact asset and shortfall. Principal
affordability and authorization remain separate: a policy denial does not claim
the wallet lacks funds.

Planning creates no reservation. An untrusted agent cannot exhaust available
funds merely by asking questions.

### `wallet_prepare_payment`

```json
{
  "decision_id": "wd_01J…",
  "client_request_id": "hermes-message-847-payment-1"
}
```

The agent does not repeat the destination, asset, amount, chain, or fee ceiling.
Agent Boost resolves the immutable decision, refreshes state, rejects any
conflict, and atomically reserves principal, fee ceiling, and policy allowance.
It then creates an exact operator-review request. This result is also abridged;
every real response uses the complete `tool-result-v1` envelope:

```json
{
  "outcome": "awaiting_operator",
  "request_id": "req_01J…",
  "intent_digest": "sha256:…",
  "signed": false,
  "broadcast": false,
  "operator_action": {
    "kind": "inspect_and_approve",
    "channel": "local_control_plane"
  }
}
```

The stable client request ID provides cross-retry and cross-restart
idempotency. The same ID and same intent returns the original request; the same
ID with different intent returns `IDEMPOTENCY_CONFLICT`.

Preparation never signs or broadcasts. There is no agent-facing tool named
`approve`, `unlock`, `sign`, `broadcast`, `send_raw_transaction`, or
`export_key`.

### `wallet_create_receive`

```json
{
  "chain_id": "eip155:11155111",
  "acceptable_kinds": ["stealth_erc5564", "fresh_address"],
  "request_key": "funding-round-7"
}
```

The order expresses preference and explicit fallback permission. The result
echoes `selected_kind`, a public receive target, standard/scheme metadata, and
privacy limitations. Agent Boost never silently substitutes a weaker kind. A
single unsupported required kind returns `FEATURE_UNSUPPORTED`.

Repeated calls with the same request key return the same identifier. No
derivation, viewing, or spending secret is returned.

### `wallet_get_request`

```json
{"request_id": "req_01J…"}
```

Durable states are:

```text
awaiting_operator
approved
revalidating
executing
submitted
confirmed
rejected
expired
failed_before_submit
reconciling
indeterminate
```

The result includes `terminal` and `safe_to_resubmit`. `reconciling` and
`indeterminate` always return `safe_to_resubmit: false`. A client may poll with
bounded backoff, but `awaiting_operator` is a pause rather than a retry loop.

## Outcome and error contract

Expected domain states are successful structured results with `isError=false`,
a stable `outcome`, a stable `code`, and retry guidance. Examples include:

```text
INSUFFICIENT_ASSET
INSUFFICIENT_FEE_ASSET
POLICY_LIMIT
DECISION_EXPIRED
DECISION_CONFLICT
PRIVACY_ROUTE_UNAVAILABLE
FEATURE_UNSUPPORTED
OPERATOR_ACTION_REQUIRED
OPERATOR_REJECTED
AMBIGUOUS_SUBMISSION
```

These are not transport failures. Hermes turns MCP `isError=true` into its
generic tool-error path, so expected states must remain available for structured
branching. Malformed arguments, unknown tools, and unexpected internal faults
use MCP tool/protocol errors.

Every structured result is also serialized into a bounded text content block
for older clients. Tool annotations are accurate hints, never enforcement.

## Operator approval

```console
agent-boost requests
agent-boost inspect req_01J…
agent-boost approve req_01J…
# or
agent-boost reject req_01J… --reason "destination not expected"
```

`inspect` shows exact chain, source account, destination, asset, amount, fee
ceiling, adapter, and intent digest. Approval binds those immutable fields. Any
change expires the request and requires a new plan, request, and approval.

Wallet unlock is interactive:

```console
agent-boost wallet unlock
```

The unlock value is read from the operator terminal without echo. It is never a
flag, model-visible environment variable, MCP elicitation field, or chat
message. Hermes host confirmation and MCP elicitation may improve UX on newer
clients, but neither replaces the Agent Boost approval boundary.

## Compatibility wrapper

```console
agent-boost run --mode dark -- your-local-agent --its --usual --flags
```

The child receives loopback `HTTP_PROXY`, `HTTPS_PROXY`, and
`AGENT_BOOST_RPC_URL` values. Agent Boost removes known upstream RPC variables
and never passes adapter credentials or wallet state.

Proxy variables are advisory. Compatibility mode is fail-closed only when an
external sandbox also denies direct sockets and operator-state paths.

## Bootstrap test funds

```console
agent-boost wallet bootstrap --testnet
agent-boost wallet context
```

The bootstrap command derives a one-time Sepolia receive target and asks a
configured test sponsor for funds through dark egress. The sponsor and public
chain can still correlate destination, timing, amount, and source. This is a
testnet usability feature, not an anonymous-funding claim.

## Stop and recover

```console
agent-boost down
agent-boost up
agent-boost requests --pending
```

Shutdown stops new work, persists requests, and terminates adapters. On restart,
the sidecar reconciles every pending or ambiguous payment before permitting a
new request or replay. Re-broadcasting an identical signed transaction may be
safe; building and signing a replacement transaction is not automatic.

## Framework adapter checklist

An integration is conformant when it:

1. invokes MCP over stdio inside a restricted process boundary;
2. discovers or pins capability contract major version 1;
3. reads context before general wallet decisions and plans exact payments;
4. never asks the model for wallet unlock, approval, or key material;
5. treats `awaiting_operator`, `reconciling`, and `indeterminate` as pauses;
6. preserves client request and request IDs across retries/restarts;
7. does not reinterpret a dark-route failure as permission to use clearnet;
8. does not silently substitute an unrequested receive or payment feature;
9. bounds untrusted tool results before model context insertion;
10. independently prevents the agent from reaching operator state or network
    paths outside Agent Boost.
