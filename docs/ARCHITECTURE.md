# Architecture

Agent Boost is designed as a local control plane between an untrusted agent
runtime and two privacy adapters. It owns policy, approval, lifecycle, and
redacted receipts. It delegates wallet cryptography to Kohaku and proof-gated
Tor egress to Shade Tree.

## Design rules

1. Keep secrets and signing authority outside the agent process while exposing
   the public wallet state an agent needs to make decisions.
2. Give the agent intent-level capabilities instead of adapter shells.
3. Bind data-plane listeners to loopback and isolate the operator control plane
   from the agent with a separate OS identity/sandbox boundary or cryptographic
   operator authentication.
4. Route wallet RPC through the same private egress boundary as dark HTTP.
5. Fail dark requests closed; never retry on clearnet.
6. Keep adapter implementations replaceable behind a stable tool contract.
7. Record enough metadata to debug a request without storing its secret inputs
   or body content.

## Process boundaries

| Process | Trust | Responsibilities |
| --- | --- | --- |
| Agent runtime | Untrusted for secrets | Chooses tools and supplies bounded intents |
| Agent-facing MCP process | Untrusted for operator authority | Validates schemas and forwards bounded intents |
| Agent Boost sidecar | Trusted local control plane | Policy, plans, reservations, request state, approvals, receipts, routing |
| Kohaku adapter | Trusted wallet boundary | Encrypted key state, receive derivation, signing |
| Shade Tree adapter | Trusted transport boundary | Proof-gated Tor transport and egress health |
| Operator CLI | Trusted human control | Unlock, inspect, approve, reject, stop |

The host kernel and operator identity are trusted in the POC. The agent identity
is not trusted with operator files or sockets. A process with access to the
operator's memory, wallet state, or authenticated control socket is outside the
security model.

## Local interfaces

### Agent-facing

- MCP over stdio is the strict interface. It exposes bounded tools and no
  administrative actions.
- `127.0.0.1:9181` is an HTTP CONNECT proxy for compatibility mode.
- `127.0.0.1:9182` is an Ethereum JSON-RPC forwarder. The wallet adapter may
  reach an upstream RPC provider only through this listener.

### Operator-facing

Administrative commands use
`~/.local/share/agent-boost/agent-boost.sock`, created inside the operator
boundary. Unlock material is accepted interactively and is neither passed in
arguments nor written to receipts.

File mode `0600` is not a boundary when Hermes and Agent Boost share a UID. The
release gate requires a distinct Agent Boost service identity with the socket
and state paths hidden from the agent sandbox, or cryptographic operator
authentication that the agent cannot obtain.

There is no administrative TCP API in the POC.

## Request state machine

```text
payment intent
  → planned (read-only, no reservation)
  → prepared (fresh validation + atomic reservation)
  → awaiting_operator
  → approved
  → revalidating
  → executing
  → submitted
  → confirmed

awaiting_operator → rejected | expired
revalidating      → failed_before_submit
submitted         → reconciling → confirmed | indeterminate
```

Read-only operations such as `capabilities`, `wallet_get_context`, and
`wallet_plan_payment` create no reservation. A plan ID is a short-lived
reference to immutable terms, not signing authority. `wallet_prepare_payment`
revalidates and reserves atomically. Request IDs are durable and execution is
idempotent: after a restart, Agent Boost reconciles a possibly broadcast
transaction before allowing any replacement.

## Dark fetch flow

```text
agent
  → MCP dark_fetch or loopback proxy
  → request validation and destination policy
  → Shade Tree loopback proxy
  → Tor circuit / Grove egress
  → destination
  → redacted receipt + response
```

Strict mode places the agent in an external network sandbox so the Agent Boost
tool is its only network capability. Compatibility mode cannot provide that
property by environment injection alone.

## Wallet flow

```text
agent
  → wallet_get_context (general reasoning)
  → address + total / reserved / spendable balances + policy + route health
  → wallet_plan_payment(exact terms)
  → proxied chain reads
  → principal + fee balances + checks / blockers + decision ID
  → wallet_prepare_payment(decision ID, stable client request ID)
  → fresh balance / fee / nonce / policy / route validation
  → atomic principal / fee-ceiling / policy reservation
  → exact operator approval for signing
  → Kohaku adapter
  → Agent Boost JSON-RPC forwarder
  → Shade Tree
  → HTTPS upstream RPC / Sepolia
```

The Kohaku subprocess receives a loopback RPC URL. Direct outbound RPC and
plaintext upstream RPC are rejected by the POC sandbox, network policy, and RPC
forwarder. The HTTPS requirement keeps a Grove node from reading or modifying
JSON-RPC payloads. `doctor` runs a canary through the complete path before
wallet network operations are enabled. The decision ID binds the exact intent
and observation, but execution always revalidates fresh state before signing.

## Adapter contract

Adapters are supervised child processes with a versioned, structured protocol.
The POC contract requires:

- a startup capability handshake;
- health and readiness states;
- request and response size limits;
- deadlines and cancellation;
- structured error codes with no secret values;
- clean shutdown and forced termination;
- exact supported network and feature reporting.

An adapter cannot weaken the sidecar policy. For example, the wallet adapter
cannot bypass approval, and the egress adapter cannot authorize a clearnet
fallback.

## Receipt shape

```json
{
  "request_id": "req_01J…",
  "created_at": "2026-09-05T14:02:00Z",
  "mode": "dark",
  "capability": "wallet_prepare_payment",
  "destination": "ethereum:sepolia",
  "adapter": "kohaku",
  "approval": "approved",
  "result": "broadcast",
  "transaction_hash": "0x…"
}
```

Receipts omit prompts, HTTP bodies, response bodies, authentication headers,
wallet secrets, unlock material, and full destination paths by default.

## Failure behavior

| Failure | Required behavior |
| --- | --- |
| Shade Tree not ready | Reject dark request before connection |
| Egress lost mid-request | Fail; do not replay on clearnet |
| RPC route canary fails | Disable wallet network operations |
| Kohaku locked | Return `OPERATOR_ACTION_REQUIRED` without accepting unlock data from the agent |
| Approval rejected or expired | Produce no signature |
| Sidecar restarts after ambiguous broadcast | Hold reservation and reconcile by request ID; do not build a replacement |
| Receipt store unavailable | Reject new side effects |
| Agent can reach operator socket/state | Fail `doctor --strict`; do not enable wallet actions |

## Configuration and state

The public [example configuration](../agent-boost.example.toml) contains paths
and policy only. Adapter credentials, RPC credentials, and wallet unlock
material stay in protected local state or interactive input.

Expected permissions:

```text
~/.config/agent-boost/             0700
~/.config/agent-boost/config.toml  0600
~/.local/share/agent-boost/        0700
```
