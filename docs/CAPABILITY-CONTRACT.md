# Wallet capability contract

Agent Boost exposes a wallet-first MCP contract named
`org.agentboost.wallet/1.7`. It is Sepolia-only.

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
- regular operation: native ETH transfer from the selected main public account,
  with a conservative gas reserve and no private fallback;
- authority: a time-bounded set of Sepolia test payments under the effective local
  `allow`, `confirm`, or `deny` execution policy;
- default authority lifetime: seven days; expiry disables delegated execution,
  not wallet or balance access;
- default maximum: 10 sends, `1` ETH per send, `10` ETH total;
- conversational policy editing: count, per-send amount, total amount, expiry,
  and enabled state, with an exact preview and separate confirmation;
- a deterministic address-free wallet tree using profile names, with live
  public balances, a live active private balance, and clearly marked last-known
  inactive private balances;
- mainnet: unavailable;
- Ethereum JSON-RPC egress: Tor for Agent Boost and Kohaku, no direct fallback;
- covered public HTTPS egress: optional Shade Tree v4 explicit-fetch module,
  independently enrolled and never used as a direct fallback;
- general process egress: unavailable; Hermes is not blanket-routed.

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
no direct RPC fallback, and the absolute policy-editor bounds remain enforced
regardless of an override. The sane default and absolute ceiling are different:
advanced users may deliberately widen a disposable testnet policy without
creating any mainnet or arbitrary-signing path.

## Identifiers and amounts

- Chain IDs use CAIP-2.
- Account IDs use `eip155:11155111:0x…`.
- Native ETH uses CAIP-19 `eip155:11155111/slip44:60`.
- Authority-bearing amounts are canonical base-10 wei strings matching
  `^(0|[1-9][0-9]*)$`.
- Human ETH formatting is display-only and never enters the intent digest.
- Private-payment decision IDs begin `wd_` and request IDs begin `req_`;
  regular-transfer decision IDs begin `rwd_` and request IDs begin `rreq_`;
  policy decision IDs begin `wpd_`; setup IDs begin `setup_`.

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
  "presentation": {
    "version": "1.0",
    "kind": "confirmation",
    "title": "Confirm private test payment",
    "state": "pending",
    "fields": [],
    "next_action": "Show this plan, end the turn, then execute after a new user chat confirmation."
  },
  "data": {}
}
```

The MCP text content is deliberately not a second serialized copy. It is a
short presentation hint with the human amount, status, and next action. Some
Hermes versions prefer non-empty text and omit `structuredContent` from the
model result, so Agent Boost also mirrors the exact redacted envelope under the
vendor metadata key `_meta["org.agentboost/model-context"]`. Hermes preserves
that metadata for exact decisions. `WALLET_TREE` is the sole exception: because
it has no authority or continuation handles, this key contains only the
canonical rendered tree and a static direct-display contract. Clients should
treat all vendor metadata as agent-internal state and keep raw wei, phases,
digests, and identifiers out of ordinary replies.

`presentation` is an optional, non-authoritative rendering contract. It gives
clients a stable title, semantic state, real setup step, labeled fields, status
markers, warning, and next action without changing the authority-bearing
`data`. Setup uses three participant-facing steps. Under the default confirm
policy, Hermes shows the exact plan in chat, ends the turn, and treats the
user's next explicit approval message as confirmation. It then calls the
matching execution tool with `user_confirmed: true`; users never handle an
internal decision ID or leave the conversation for another interface. A
decline never executes the plan.

Known outcomes are `ready`, `blocked`, `awaiting_funding`, `executing`,
`submitted`, `confirmed`, `failed`, and `indeterminate`. Retry advice is
part of the contract. An unresolved side effect must never be replaced with a
new client request ID.

## Tools

The wallet contract above and covered-egress contract below share the stable
tool-result envelope but have separate manifest digests.

### `egress_capabilities`

No input. Returns `org.agentboost.egress/0.1`, GET/HEAD-only policy, resource
limits, fail-closed behavior, and the exact non-anonymity claim. It returns no
member, proof, Proxy, or operator material.

### `egress_status`

No input. Returns one redacted state: `disabled`, `not_installed`,
`needs_enrollment`, `starting`, `ready`, `degraded`, `exhausted`, or `failed`.
Readiness never implies that wallet RPC or all Hermes traffic uses Shade Tree.

### `egress_fetch`

```json
{"url":"https://example.com/data.json","method":"GET"}
```

Fetches public UTF-8 text or JSON over HTTPS port 443 through the authenticated
local Shade Tree Proxy. It accepts GET or HEAD, no request body, credentials,
cookies, arbitrary headers, IP literals, local names, or non-443 port. It
revalidates up to three redirects, stops at 1 MiB/30 seconds by default, verifies
destination TLS, and never falls back to direct or raw Tor egress. Returned
content is explicitly `untrusted_external`.

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

Accepts an optional ordinary Sepolia ETH decimal as `amount_native` for an
exact main-account affordability comparison. Refreshes and returns:

- main account address and CAIP account ID;
- that main account's current on-chain ETH as `balance_atomic`;
- `account_role: main_funding_source` and `controls_subaccounts: false`;
- setup phase;
- delegation amount, use, and expiry;
- observation timestamp and revision.
- live Tor RPC-route status and the absence of direct fallback.
- when requested, an `affordability_check` that reports only whether the main
  account numerically covers `amount_native`; private-payment spendability
  remains unknown until an exact recipient is planned.

It returns no seed, key, mnemonic, password, note, proof, raw signed
transaction, RPC URL, or arbitrary adapter output.

"Main" identifies the account that funds subaccounts. It conveys no control,
ownership, signing authority, recovery, or revocation rights over them, and
subaccount balances are not included in `balance_atomic`.
The MCP boundary rejects the response if any other field whose name contains
`balance` is introduced, including nested aggregate or private-pool balances.

### `wallet_get_tree`

No input. Returns one deterministic Markdown-safe Unicode tree for every
available wallet profile. Each profile folder contains sibling `main` and
`private` views. Main balances are refreshed from Sepolia; the active private
balance is refreshed from Kohaku; inactive private balances are explicitly
labeled `last known`.
Failed reads render `unavailable`, never a cached value presented as live or an
invented zero.

The tree keeps six decimal places for scanability. A longer dust tail is rounded
with an explicit `≈` marker, and a smaller nonzero value is shown as
`<0.000001`; the structured decimal remains exact.

The public tree includes friendly profile names and decimal Sepolia ETH only.
It excludes addresses, account IDs, wallet IDs, raw atomic values, secrets, and
aggregate totals. Folder indentation is organizational and does not imply
custody, ownership, recovery, revocation, or control.

The MCP compact text and presentation notice both carry the same canonical
rendered tree. Direct overview responses reproduce that text byte-for-byte;
Unicode box-drawing connectors and nonbreaking indentation prevent chat
Markdown renderers from converting branches into code spans or collapsing them.

### `wallet_manage_profiles`

No input. Returns registered profiles with friendly names, status, active and
authorization state, plus local Kohaku inventory entries that are not yet
registered. Each local entry is explicitly marked adoptable only when Kohaku
reports Sepolia. Inventory failure never hides registered profiles. Wallet IDs
are internal continuation handles and are excluded from compact user text.

`wallet_list` remains an additive compatibility alias for generic MCP clients
and returns the same `WALLET_LIST` envelope. Hermes omits that legacy name from
its allowlist and safely migrates older Agent Boost configuration to
`wallet_manage_profiles` so plain wallet-list wording cannot hit the flat
management inventory.

### `wallet_create` and `wallet_adopt_existing`

Both require confirmation, select the resulting profile, archive the prior
workflow, and leave signing disabled. Creation accepts one safe friendly name.
Adoption accepts the exact name of an already-local Kohaku Sepolia wallet; its
schema has no seed, password, private-key, or filesystem-path input.

### `wallet_select` and `wallet_archive`

Selection accepts a registered friendly `wallet_name` from
`wallet_manage_profiles`; an equivalent `name` alias and a friendly value in
`wallet_id` are tolerated for model compatibility. An internal `wallet_id`
remains accepted but is never a
user input. Selecting the already-active profile is an unconfirmed idempotent
read of current state and preserves active authorization. A real switch drains
active work, privately archives the current state, restores the selected
profile's durable onboarding state, advances its selection epoch, and deletes
stale authorization. Archived profiles become available when selected again.

Archival applies only to an inactive profile and retains encrypted Kohaku data,
private workflow state, and audit history. The active profile is rejected.

### `wallet_plan_reauthorization` and `wallet_reauthorize`

After selection, the planner creates a five-minute decision bound to the exact
active profile and new selection epoch. It previews count, per-send, total, and
expiry limits and cannot authorize signing. The apply tool requires separate
confirmation, compares live state to the plan, replaces prior authority, and
resets its spend and send counters. It moves no funds.

### `wallet_start_new_demo`

```json
{"user_confirmed": true}
```

Requires explicit user confirmation. It drains current onboarding and payment
work, archives the complete state with private local permissions, retains the
old Kohaku wallet, selects a new wallet profile, and starts a fresh funding
flow. It never rebroadcasts an unresolved request. The tool returns a public
archive identifier and a new QR; it does not return an archive path or secrets.

### `wallet_get_policy`

No input. Returns the active per-send limit, total limit, send count, used and
remaining sends, expiry, and enabled state without returning the address or any
balance. The policy is authority, not evidence of available funds.

### `wallet_plan_policy_update`

```json
{
  "max_payments": 10,
  "per_payment_limit_native": "1",
  "expires_in_hours": 168
}
```

Inputs are ordinary native-token decimal strings so the model does not convert
wei. Safe whole JSON numbers are also accepted. Since JSON parsing loses a
number's original lexical form, any intended fractional value must be a string;
parsed non-integers are rejected. Any subset may change. When count or per-send
amount changes and the total is omitted, the total is their product. An expired
permission is renewed for the default seven days when another setting changes.
The five-minute preview binds the complete current and proposed policies and
changes no wallet authority. Creating it durably supersedes any older pending
policy preview.

The controller rejects a proposal that erases already-spent amount or already-
used sends, exceeds the count/amount/expiry ceilings, or gives a total above the
count-times-per-send envelope.

### `wallet_apply_policy_update`

```json
{"decision_id":"<internal ID from the displayed preview>","user_confirmed":true}
```

The required internal `decision_id` names the exact displayed preview; it stays
in structured agent context and is never supplied by the user. The write
compares the live policy and used authority with that preview, then updates the
delegation atomically. Passing `user_confirmed:false` with the same ID durably
cancels that preview; it cannot later apply.
Repeating the same exact applied decision returns the same receipt. A concurrent
payment or policy change makes an unapplied preview stale. This tool never
transfers funds, changes chains, enables mainnet, or makes the main account
spendable through the private-payment route.

### `wallet_plan_regular_transfer`, `wallet_execute_regular_transfer`, and `wallet_get_regular_transfer_request`

A regular transfer is a public Sepolia ETH send from the selected wallet's
main account. Planning binds the exact recipient and ordinary-unit amount to a
five-minute immutable decision, checks the shared policy envelope, reads the
live main-account balance, and preserves the configured gas reserve. It never
routes to the private balance or falls back to the private-payment path.

Execution resolves recipient and amount only from that decision. Under the
default policy it requires a later chat confirmation; a decline durably cancels
the decision. One decision can create at most one durable request, even if a
caller changes `client_request_id`; retrying the same request ID returns the
original request. Immediately before signing, Agent Boost rechecks chain,
selection epoch, policy expiry and counters, kill switch, live balance, and gas
reserve. Authority remains consumed after a failed or uncertain handoff so an
automatic retry cannot duplicate the send.

The status tool reads and reconciles that exact request without rebroadcasting.
Only a successful receipt or recipient-balance delta can produce `confirmed`;
`submitted` and `indeterminate` remain explicitly unresolved.

### `wallet_plan_private_payment`

```json
{
  "recipient": "0x2222222222222222222222222222222222222222",
  "amount_native": "0.02"
}
```

The MCP boundary converts the ordinary Sepolia ETH decimal to wei internally.
The tool refreshes private spendable balance and checks setup readiness,
delegation enabled/expiry, payment-count use, per-payment and lifetime
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
`deny` blocks planning and execution. Execution atomically consumes one send
and its lifetime amount allowance before calling Kohaku. This is fail-safe: an
adapter failure or uncertain submission does not restore authority for an
automatic retry.

### `wallet_get_request`

```json
{"request_id": "req_…"}
```

Returns one durable, redacted request in `executing`, `submitted`,
`confirmed`, `failed`, or `indeterminate` state. For a nonterminal request, the
read also attempts reconciliation from a real transaction receipt or the
recipient-balance checkpoint persisted before execution. Reconciliation never
broadcasts. Internal checkpoints and attempt metadata are omitted from MCP.

### `wallet_plan_recovery_transfer`, `wallet_execute_recovery_transfer`, and `wallet_get_recovery_request`

Recovery is one exact-amount Sepolia operation, not a whole-wallet sweep and
not delegated-payment authority. The five-minute plan binds the active profile
and selection epoch, recipient, amount, private-balance snapshot, configured
denomination, fee reserve, remaining-balance estimate, and state revision.

Execution requires separate confirmation and consumes the durable request
before Kohaku is called. The recovered amount becomes publicly visible at the
recipient, while any remainder stays private. The status read preserves
`submitted` and `indeterminate` as unresolved and never broadcasts a
replacement.

## Model-visible authority

The agent may read wallet state and create plans. Its ability to cause bounded
Sepolia signatures and broadcasts is controlled by the effective local
execution policy. The built-in default is `confirm`; ordinary language or an
approval emoji can confirm the exact displayed plan. It cannot use the Agent
Boost interface to export keys, sign arbitrary calldata, change chain, change
protocol, change the fixed withdrawal behavior, bypass hard limits, or access
mainnet.

Policy-update confirmation is independent from payment confirmation. Approving
new limits does not approve a transfer, and approving a transfer cannot mutate
the policy.

`user_confirmed` is Hermes's attestation about the conversation. Agent Boost
does not independently hear or authenticate the user's speech, so this is a
bounded demo control rather than a separate approval factor.

For recoverable create, adopt, select, archive, and demo-reset actions, Hermes
also attests that the passed action and friendly name, when applicable, match
the exact lifecycle change it just showed. Agent Boost validates the supplied
action/name but does not persistently bind that preview. A lifecycle change
grants no signing authority: a distinct, immutable reauthorization plan is
still required, and every fund movement is bound to its own exact server plan.

MCP is not an OS sandbox. Same-user filesystem and shell access are outside this
tool contract; see the threat model.
