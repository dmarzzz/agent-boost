# Wallet capability contract

Agent Boost exposes a wallet-first MCP contract named
`org.agentboost.wallet/1.0`. It is Sepolia-only.

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
- authority: one verbally confirmed, time-bounded Sepolia test payment;
- default maximum: `0.05` ETH;
- mainnet: unavailable;
- private egress: unavailable.

The accurate privacy claim is “privacy-improving shielded Sepolia test
payment.” The capability document explicitly sets
`guarantees_anonymity: false`, `rpc_egress_private: false`, and
`funding_source_private: false`.

## Identifiers and amounts

- Chain IDs use CAIP-2.
- Account IDs use `eip155:11155111:0x…`.
- Native ETH uses CAIP-19 `eip155:11155111/slip44:60`.
- Authority-bearing amounts are canonical base-10 wei strings matching
  `^(0|[1-9][0-9]*)$`.
- Human ETH formatting is display-only and never enters the intent digest.
- Decision IDs begin `wd_`; request IDs begin `req_`; setup IDs begin
  `setup_`.

## Result envelope

Every expected result appears in both MCP `structuredContent` and a JSON text
content block:

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
`private_ready` with `privateBalanceWei >= shieldAmountWei` means setup is
complete.

### `wallet_get_context`

No input. Refreshes and returns:

- funding address and CAIP account ID;
- current funding-address ETH;
- Kohaku's current aggregate public-wallet ETH;
- current private-payment spendable ETH;
- setup phase;
- delegation amount, use, and expiry;
- observation timestamp and revision.

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
SHA-256 digest over chain, recipient, asset, amount, and operation.

Plans do not sign, submit, or reserve funds.

### `wallet_execute_private_payment`

```json
{
  "decision_id": "wd_…",
  "client_request_id": "hermes:wd_…",
  "user_confirmed": true
}
```

The recipient and amount are resolved from the decision rather than accepted
again. Execution atomically consumes the one-payment/lifetime delegation before
calling Kohaku. This is fail-safe: an adapter failure or uncertain submission
does not restore authority for an automatic retry.

### `wallet_get_request`

```json
{"request_id": "req_…"}
```

Returns one durable, redacted request in `executing`, `submitted`,
`confirmed`, `failed`, or `indeterminate` state.

## Model-visible authority

The agent may read wallet state, create plans, and—with exact verbal
confirmation—cause one bounded Sepolia signature and broadcast. It cannot use
the Agent Boost interface to export keys, sign arbitrary calldata, change
chain, change protocol, change the fixed withdrawal behavior, bypass policy, or
access mainnet.

`user_confirmed` is Hermes's attestation about the conversation. Agent Boost
does not independently hear or authenticate the user's speech, so this is a
bounded demo control rather than a separate approval factor.

MCP is not an OS sandbox. Same-user filesystem and shell access are outside this
tool contract; see the threat model.
