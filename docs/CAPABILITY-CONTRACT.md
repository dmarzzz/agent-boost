# Wallet capability contract

Agent Boost exposes a wallet-first MCP contract named
`org.agentboost.wallet/1.2`. It is Sepolia-only.

The capability document is available through the read-only `capabilities`
tool and the resource:

```text
agent-boost://capabilities/wallet/v1
```

The document describes support and live readiness. It is not a bearer token.
Actual authority is enforced from durable local state.

## Scope

- Chain: `eip155:11155111`;
- asset: `eip155:11155111/slip44:60`;
- funding target: `0.2` ETH by default;
- shield protocol: Tornado through the pinned Kohaku adapter;
- private operation: unshield to the next wallet account with an exact value
  tail call;
- authority: one time-bounded Sepolia test payment under the effective local
  `allow`, `confirm`, or `deny` execution policy;
- default maximum: `0.05` ETH;
- mainnet: unavailable;
- Ethereum JSON-RPC egress: Tor for Agent Boost and Kohaku, no direct fallback;
- general agent egress: unavailable; Shade Tree is the next module.

The accurate privacy claim is “privacy-improving shielded Sepolia test
payment.” The capability document explicitly sets
`guarantees_anonymity: false`, `funding_source_private: false`, and a scoped
`rpc_egress` object. That object says Tor hides the origin IP from the RPC
provider but does not hide methods, addresses, payloads, or timing from it.

## Layered security

The capability exposes `security.default`, `security.overrides`, and
`security.effective`. Built-in rules allow wallet reads and payment planning,
and require confirmation for payment execution. The local
`AGENT_BOOST_PAYMENT_APPROVAL` override can set payment execution to `allow`,
`confirm`, or `deny`.

`security.hard_limits` is not mergeable: Sepolia-only operation, no mainnet,
no direct RPC fallback, the amount caps, and the one-payment lifetime remain
enforced regardless of an override.

## Identifiers and amounts

- Chain IDs use CAIP-2.
- Account IDs use `eip155:11155111:0x…`.
- Native ETH uses CAIP-19 `eip155:11155111/slip44:60`.
- Authority-bearing amounts are canonical base-10 wei strings matching
  `^(0|[1-9][0-9]*)$`.
- Human ETH formatting is display-only and never enters the intent digest.
- Decision IDs begin `wd_`; request IDs begin `req_`; setup IDs begin
  `setup_`.

## Result envelope and presentation

Every expected result appears in MCP `structuredContent`:

```json
{
  "schema": "org.agentboost.tool-result",
  "schema_version": "1.0",
  "manifest_digest": "sha256:…",
  "outcome": "ready",
  "code": "CAPABILITIES",
  "retry": {
    "mode": "never",
    "safe_with_same_arguments": false
  },
  "data": {}
}
```

The MCP text content is deliberately not a second serialized copy. It is a
short presentation hint with the human amount, status, and next action. Hermes
uses the structured content for exact decisions while keeping raw wei, phases,
digests, and identifiers out of ordinary replies.

Known outcomes are `ready`, `blocked`, `awaiting_funding`, `executing`,
`submitted`, `confirmed`, `failed`, and `indeterminate`. Retry advice is
part of the contract. An unresolved side effect must never be replaced with a
new client request ID.

## Tools

### `capabilities`

No input. Returns the static contract and dynamic readiness. It grants no new
authority.

### `onboarding_start`

No input. Creates or resumes a disposable wallet setup. It may create encrypted
wallet state, derive a fresh public address, open the local funding page,
download proving material, watch Sepolia funding, and automatically submit the
configured shield transaction.

Repeated calls resume the durable setup. They do not replace the Kohaku seed.

### `onboarding_status`

```json
{
  "setup_id": "setup_…",
  "since_revision": 4,
  "wait_ms": 90000
}
```

Returns the latest durable state or waits for a greater revision. Only
`private_ready` with `privateBalanceWei >= shieldAmountWei`, plus a fresh
`readiness.rpc_egress: ready` capability result, means setup is complete.

### `wallet_get_context`

No input. Refreshes and returns:

- funding address and CAIP account ID;
- current funding-address ETH;
- Kohaku's current aggregate public-wallet ETH;
- current private-payment spendable ETH;
- setup phase;
- delegation amount, use, and expiry;
- observation timestamp and revision.
- live Tor RPC-route status and the absence of direct fallback.

It returns no seed, key, mnemonic, password, note, proof, raw signed
transaction, RPC URL, or arbitrary adapter output.

### `wallet_plan_private_payment`

```json
{
  "recipient": "0x2222222222222222222222222222222222222222",
  "amount_atomic": "20000000000000000"
}
```

The tool refreshes private spendable balance and checks setup readiness,
delegation enabled/expiry, one-payment lifetime use, per-payment and lifetime
limits, and private balance. It returns a five-minute immutable decision with a
SHA-256 digest over chain, recipient, asset, amount, and operation. The plan
also reports whether the effective security policy requires user confirmation.

Plans do not sign, submit, or reserve funds.

### `wallet_execute_private_payment`

```json
{
  "decision_id": "wd_…",
  "user_confirmed": true
}
```

The recipient and amount are resolved from the decision rather than accepted
again. `client_request_id` is optional; Agent Boost derives the stable
`hermes:<decision_id>` value when omitted. The default `confirm` policy requires
`user_confirmed: true`; an explicit local `allow` override does not, while
`deny` blocks planning and execution. Execution atomically consumes the
one-payment/lifetime delegation before calling Kohaku. This is fail-safe: an
adapter failure or uncertain submission does not restore authority for an
automatic retry.

### `wallet_get_request`

```json
{"request_id": "req_…"}
```

Returns one durable, redacted request in `executing`, `submitted`,
`confirmed`, `failed`, or `indeterminate` state.

## Model-visible authority

The agent may read wallet state and create plans. Its ability to cause one
bounded Sepolia signature and broadcast is controlled by the effective local
execution policy. The built-in default is `confirm`; ordinary language or an
approval emoji can confirm the exact displayed plan. It cannot use the Agent
Boost interface to export keys, sign arbitrary calldata, change chain, change
protocol, change the fixed withdrawal behavior, bypass hard limits, or access
mainnet.

`user_confirmed` is Hermes's attestation about the conversation. Agent Boost
does not independently hear or authenticate the user's speech, so this is a
bounded demo control rather than a separate approval factor.

MCP is not an OS sandbox. Same-user filesystem and shell access are outside this
tool contract; see the threat model.
