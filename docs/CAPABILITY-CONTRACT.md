# Capability contract

Agent Boost capability documents are descriptive compatibility profiles. They
are not bearer capabilities and grant no signing, approval, network-bypass, or
administrative authority.

## Discovery

The profile is available through the native read-only `capabilities` tool and as
the MCP resource:

```text
agent-boost://capabilities/wallet/v1
```

Hermes integrations use the tool because MCP resources are not automatically
inserted into the model context. Other MCP hosts may prefer the resource for
application-controlled discovery. Live context and plan results carry the
manifest digest and relevant readiness so cached support cannot masquerade as
current health.

The schema and example are:

- [`wallet-capability-v1.schema.json`](../spec/wallet-capability-v1.schema.json)
- [`wallet-capability-v1.example.json`](../spec/wallet-capability-v1.example.json)
- [`tool-result-v1.schema.json`](../spec/tool-result-v1.schema.json)

## Versioning

- The resource URI major version controls breaking document changes.
- `schema_version` controls the profile's JSON shape.
- `capability.version` controls Agent Boost wallet semantics.
- MCP protocol negotiation remains independent.
- A minor version may add optional fields and features.
- A breaking change uses `/v2` and requires explicit integration configuration;
  an active client is never silently upgraded across majors.

## Identifier rules

- Networks use CAIP-2, such as `eip155:11155111`.
- Accounts use CAIP-10, such as `eip155:11155111:0x…`.
- Assets use CAIP-19, such as `eip155:11155111/slip44:60` or an ERC-20 asset.
- Symbols and friendly names are display metadata only.
- Authority-bearing monetary quantities are canonical, non-negative atomic-unit
  integer strings paired with a CAIP-19 asset identifier, never JSON numbers.
- Human-formatted decimal amounts are display metadata only and are excluded
  from intent digests and approval equality checks.
- ERC-5564 stealth receive targets include their scheme metadata.

## Authority rules

The agent may read capabilities/context, plan a payment, prepare a review
request, create an idempotent receive target, fetch read-only content through
dark egress, and inspect request status.

The agent cannot unlock, approve, reject, sign, broadcast, export keys, obtain
raw signed transactions, or reach the operator control socket. Tool annotations,
Hermes trust prompts, skills, and capability text are not enforcement.

## Result rules

Expected wallet and routing states return a successful structured result with a
stable outcome/code/retry envelope. This keeps insufficient funds, policy
denials, route failure, stale decisions, operator waits, and reconciliation
available for agent branching without mislabeling them as protocol failure.

Malformed calls, unknown tools, and unexpected internal faults use MCP errors.
Every result is bounded, redacted, and represented in both structured content
and serialized text for client compatibility.

## Payment handoff

`wallet_plan_payment` canonicalizes exact terms, including `amount_atomic` and a
fee-ceiling object containing `asset_type` plus `amount_atomic`, and returns an
opaque decision ID. Atomic-unit strings match `^(0|[1-9][0-9]*)$`; leading
zeros, signs, decimal points, grouping, and exponent notation are invalid.
`wallet_prepare_payment` accepts the decision ID and a stable client request ID,
not a second copy of the payment terms. Preparation revalidates and atomically
reserves; it never signs.

A plan/decision ID:

- expires quickly;
- creates no reservation;
- binds an exact digest;
- cannot be mutated;
- cannot approve, sign, or broadcast;
- becomes invalid when relevant state changes.

The operator approves the immutable request digest through the separate control
plane. Signing revalidates state and rejects any term or fee-ceiling mutation.
