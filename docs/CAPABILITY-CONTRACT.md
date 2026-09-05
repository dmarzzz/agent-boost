# Wallet capability contract

Agent Boost exposes a wallet-first MCP contract named
`org.agentboost.wallet/1.8`. It is Sepolia-only.

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
- regular operation: native ETH transfer from the selected main public account
  or one wallet-controlled public-change account nested beneath a named private
  balance, with a conservative gas reserve and no private fallback;
- authority: a time-bounded set of Sepolia test payments under the effective local
  `allow`, `confirm`, or `deny` execution policy;
- default authority lifetime: seven days; expiry disables delegated execution,
  not wallet or balance access;
- default maximum: 10 sends, `1` ETH per send, `10` ETH total;
- conversational policy editing: count, per-send amount, total amount, expiry,
  and enabled state, with an exact preview and separate confirmation;
- multiple persistent named private balances per saved wallet, each with its
  own physical Kohaku wallet and independently editable policy;
- confirmed main-to-private funding and sibling private-to-private rebalancing,
  with whole-denomination accounting and no ledger-only transfers;
- a deterministic address-free wallet tree using profile names, with live
  public balances, named private balances, and nested regular-sendable public
  change, with clearly marked live or last-known freshness;
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

Exact chat cards are also signed under
`_meta["org.agentboost/user-facing-output"]`. A verified regular, private, or
recovery status marks that rendering `complete_turn: true`; the Hermes adapter
uses the receipt verbatim even when execution and verification were two tool
calls, so model-added success claims or filler cannot replace authoritative
status.

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

### `wallet_get_main_balance`

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

`wallet_get_context` remains an additive compatibility alias for generic MCP
clients. Hermes omits it from discovery and safely migrates older allowlists to
`wallet_get_main_balance`.

### `wallet_get_tree`

No input. Returns one deterministic Markdown-safe Unicode tree for every
available wallet profile. Each profile folder contains its exact wallet-wide
policy plus sibling `main` and named private-balance views. Every private
balance contains its own exact policy and, when present, nested public change.
Policy summaries include enabled state, maximum/used/remaining sends, exact
per-send/total/spent decimal amounts, and UTC expiry. Main balances are
refreshed from Sepolia and active private balances from Kohaku; inactive
private balances and policies are explicitly labeled `last known`.
Failed reads render `unavailable`, never a cached value presented as live or an
invented zero.

The tree keeps six decimal places for scanability. A longer dust tail is rounded
with an explicit `≈` marker, and a smaller nonzero value is shown as
`<0.000001`; the structured decimal remains exact.

The public tree includes friendly profile names, decimal Sepolia ETH, and
redacted policy summaries only. It excludes addresses, account IDs, wallet IDs,
authorization IDs, raw atomic values, secrets, and balance aggregates. Policy
freshness is `current` for the active profile and `last_known` for inactive
profiles; the latter is the exact durable snapshot retained when that profile
was inactive, not a claimed live backend observation. Folder indentation is
organizational and does not imply custody, ownership, recovery, revocation, or
control.

The MCP compact text and presentation notice both carry the same canonical
rendered tree. Direct overview responses reproduce that text byte-for-byte;
Unicode box-drawing connectors and nonbreaking indentation prevent chat
Markdown renderers from converting branches into code spans or collapsing them.

### `wallet_list_saved_profiles`

No input. Returns registered profiles with friendly names, status, active and
authorization state, plus local Kohaku inventory entries that are not yet
registered. Each local entry is explicitly marked adoptable only when Kohaku
reports Sepolia. Inventory failure never hides registered profiles. Wallet IDs
are internal continuation handles and are excluded from compact user text.

`wallet_get_saved_profiles`, `wallet_manage_profiles`, and `wallet_list` remain additive compatibility aliases
for generic MCP clients and return the same `WALLET_LIST` envelope. Hermes omits
both legacy names from its allowlist and safely migrates older Agent Boost
configuration to `wallet_list_saved_profiles` so plain wallet-list wording cannot
hit the flat management inventory.

### `wallet_create` and `wallet_adopt_existing`

Both require confirmation, select the resulting profile, archive the prior
workflow, and leave signing disabled. Creation accepts one safe friendly name.
Adoption accepts the exact name of an already-local Kohaku Sepolia wallet; its
schema has no seed, password, private-key, or filesystem-path input.

### `wallet_preview_saved_profile_load`, `wallet_apply_saved_profile_load`, and `wallet_archive`

The preview accepts only an exact registered friendly `wallet_name`; it needs
no inventory read for an explicit named load and is never a transfer
prerequisite. The later apply call must include the preview's exact
`expected_active_wallet_name` and `expected_active_selection_epoch`. Agent Boost
checks that pair atomically under the wallet-operation lock before selection;
missing or stale canonical approval changes nothing and requires a fresh
preview. Previewing the already-active profile is an idempotent
read of current state and preserves active authorization. A real switch drains
active work, privately archives the current state, restores the selected
profile's durable onboarding state, advances its selection epoch, and deletes
stale authorization. If the restored profile is `private_ready` and needs fresh
authority, this same canonical apply call creates and returns the immutable
reauthorization preview as its final result. The preview does not grant signing
authority. Archived profiles become available when selected again.

`wallet_switch_saved_profile` and `wallet_select` remain additive compatibility
aliases for generic MCP clients, including callers that predate preview
bindings. Hermes omits them from discovery and safely expands older allowlists
to the dedicated preview and apply tools.

Archival applies only to an inactive profile and retains encrypted Kohaku data,
private workflow state, and audit history. The active profile is rejected.

### `wallet_plan_reauthorization` and `wallet_apply_reauthorization`

For a canonical private-ready saved-profile switch, the apply-load tool invokes
the planner internally and returns its five-minute decision bound to the exact
active profile and new selection epoch. `wallet_plan_reauthorization` remains
available as a standalone fallback when an active wallet needs authority but no
preview was bundled with the load result. Either path previews count, per-send,
total, and expiry limits and cannot authorize signing. The apply tool requires
separate confirmation, compares live state to the plan, replaces prior
authority, and resets its spend and send counters. It moves no funds.

`wallet_reauthorize` remains an additive compatibility alias for generic MCP
clients. Hermes omits it from discovery and safely migrates older allowlists to
`wallet_apply_reauthorization`.

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

### Named private-balance lifecycle

Each saved wallet may retain multiple named private balances. Every child is a
physically isolated Kohaku wallet, not a label over one shared ledger. Creating
one uses `wallet_preview_private_balance_create` followed, after a later chat
approval, by `wallet_apply_private_balance_create`; creation is idempotent,
persists across parent-wallet switches and process restarts, and does not fund
the child.

Funding uses `wallet_preview_private_balance_fund` and
`wallet_apply_private_balance_fund`. `source: "$main"` prepares one exact public
deposit from the parent main account. A named sibling source consumes whole
private denominations and atomically tail-calls the exact deposit into the
target; any public remainder before the dynamic fee is retained under the
source pocket as wallet-controlled public change. A pocket never funds itself,
unresolved activity locks every bound source and target, and an execution is
never replaced or automatically rebroadcast. `wallet_get_private_balance_operation`
reconciles the same durable create or fund request.

Each child also has an independent send policy. Its read, preview, and apply
tools are `wallet_get_private_balance_policy`,
`wallet_preview_private_balance_policy_update`, and
`wallet_apply_private_balance_policy_update`. The same immutable preview,
later-turn confirmation, stale-revision rejection, cancellation, and
idempotency rules used for the parent policy apply to exactly the named child.
Pocket counters include private payments and regular sends from that pocket's
public change; changing one policy never changes a sibling or its parent.

### Named transfer participants

Every regular, private-payment, and recovery planner accepts exactly one of:

```json
{"recipient":"0x2222222222222222222222222222222222222222","amount_native":"0.1"}
```

```json
{
  "source_wallet_name":"agent boost wallet",
  "recipient_wallet_name":"my new private wallet",
  "amount_native":"0.1"
}
```

`recipient_wallet_name` is resolved against registered profiles before any
generic account wording is interpreted. Exact names win; otherwise case is
ignored, spaces, hyphens, and underscores are equivalent, and optional “my” or
trailing “wallet” tokens are stripped from both the reference and saved name
when that produces one unique match. The canonical friendly name remains in the preview. The
resolved destination is always that profile's known Sepolia main/public
receiving address, never its private pocket, and the address is not added to
wallet trees or profile listings. Unknown, ambiguous, archived, non-Sepolia,
and addressless profiles return typed failures. A regular transfer back to the
same source main account is rejected; a private payment to the active profile's
own main account returns `USE_RECOVERY_TRANSFER`; exact recovery to that main
account remains valid.

`source_wallet_name` is optional and must only reflect a source the user named.
The canonical task-level preview resolves and loads that saved profile itself,
so Hermes must not list, load, recreate, or fetch balances first. Selection
preserves a still-valid authorization and restores all durable child pockets;
an unavailable, archived, or ambiguous source fails with a typed result. Older
clients may still encounter the additive `*_SOURCE_SWITCH_REQUIRED`
compatibility boundary, whose exact arguments remain pinned across a switch or
reauthorization continuation.

Friendly labels are transient MCP/runtime presentation data. The resolved raw
address remains authoritative in durable plans and requests. State format 3
migrates older format-2 profiles into a retained default private balance and
keeps legacy unresolved work non-executable unless it has exact evidence.

### `wallet_preview_regular_transfer`, `wallet_execute_regular_transfer`, and `wallet_get_regular_transfer_request`

A regular transfer is a public Sepolia ETH send. Main is the default source.
When the user names `source_private_balance`, the source is one concrete
wallet-controlled public-change account recorded beneath that pocket after an
exact private-operation receipt. Planning binds the exact recipient, source
kind, pocket revision, hidden source account, and ordinary-unit amount to a
five-minute immutable decision. It checks both the parent and pocket policy
envelopes, reads the live source balance, and preserves the configured gas
reserve. It never spends shielded value directly or falls back to the
private-payment path.

The model-facing preview contract is deliberately flat and complete:

```json
{
  "source": "agent-boost",
  "source_private_balance": "$main",
  "destination": "new_private_wallet",
  "amount_native": "0.1"
}
```

The three common keys are required; `source_private_balance` is optional and
uses `"$main"` or omission for main. A named pocket selects its public change,
not its shielded balance. Use the reserved `"$selected"` source only when the
user did not name a parent wallet. A legacy `wallet_plan_regular_transfer` adapter
retains the older optional/mutually-exclusive input shape for existing MCP
callers, but Hermes does not expose both overlapping planners.

Execution resolves recipient and amount only from that decision. Under the
default policy it requires a later chat confirmation; a decline durably cancels
the decision. One decision can create at most one durable request, even if a
caller changes `client_request_id`; retrying the same request ID returns the
original request. Immediately before signing, Agent Boost rechecks chain,
selection epoch, policy expiry and counters, kill switch, live balance, and gas
reserve. Authority remains consumed after a failed or uncertain handoff so an
automatic retry cannot duplicate the send.

One tracked public-change account must individually cover amount plus gas.
Agent Boost never fabricates an aggregate sender: if value is split across
several accounts it returns `PRIVATE_BALANCE_PUBLIC_CHANGE_FRAGMENTED`; failed
RPC reads return an unavailable blocker. A send to the parent main account is
valid, while a send back to the exact selected source account is rejected.

The canonical execution call then performs one status read internally and
normally returns the verified status in the same MCP result. That read never
rebroadcasts. If the read itself is unavailable, execution truthfully returns
the durable request with `verification_unavailable: true`; the separate status
tool can be used later without executing again. Only a successful transaction
receipt can produce `confirmed`; recipient balance movement is never delivery
evidence. `submitted` and `indeterminate` remain explicitly unresolved.

### `wallet_preview_private_transfer`

```json
{
  "source": "$selected",
  "destination": "0x2222222222222222222222222222222222222222",
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

`wallet_plan_private_payment` remains an additive compatibility alias with the
older split recipient fields. Hermes omits it from discovery.

### `wallet_execute_private_transfer`

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

The canonical execution call performs one immediate no-rebroadcast status read
and normally returns `PAYMENT_STATUS`. If that read is unavailable or does not
match the just-created request, it returns the original durable request marked
`verification_unavailable` rather than implying execution failed. The
standalone status call remains a later/manual reconciliation path.

### `wallet_get_private_transfer_request`

```json
{"request_id": "req_…"}
```

Returns one durable, redacted request in `executing`, `submitted`,
`confirmed`, `failed`, or `indeterminate` state. For a nonterminal request, the
read also attempts reconciliation from the exact UserOperation or transaction
receipt persisted for that request. Recipient balance movement alone never
confirms delivery. Reconciliation never broadcasts. Internal checkpoints and
attempt metadata are omitted from MCP.

`wallet_get_request` remains an additive compatibility alias for generic MCP
clients. Hermes omits it from discovery and safely migrates older allowlists to
`wallet_get_private_transfer_request`. The older
`wallet_execute_private_payment` and `wallet_get_private_payment_request`
names remain additive compatibility aliases and are hidden from Hermes.

### `wallet_preview_recovery_transfer`, `wallet_execute_recovery_transfer`, and `wallet_get_recovery_request`

Recovery is one exact-amount Sepolia operation, not a whole-wallet sweep and
not delegated-payment authority. The five-minute plan binds the active profile
and selection epoch, recipient, amount, private-balance snapshot, configured
denomination, fee reserve, remaining-balance estimate, and state revision.

Execution requires separate confirmation and consumes the durable request
before Kohaku is called. One full configured private denomination is consumed.
The exact requested amount reaches the public recipient; the difference becomes
a wallet-controlled public remainder for fees, subject to the plan's minimum
fee reserve. After the exact successful sender-bound receipt, Agent Boost
records the refreshed remainder as public change beneath the source private
balance; that account is visible in the address-free tree and may be selected
later for a regular public transfer. Only the balance beyond the consumed
denomination stays private, as shown by the plan's estimated post-recovery
private balance. The canonical execution call performs one immediate status
read and normally returns that status. The read preserves `submitted` and
`indeterminate` as unresolved and never broadcasts a replacement; a separate
status call remains available for later/manual reconciliation.

`wallet_plan_recovery_transfer` remains an additive compatibility alias with
the older split recipient fields. Hermes omits it from discovery.

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
the exact lifecycle change it just showed. A typed result tells the Hermes turn
gate which exact tool, friendly name, and active-selection epoch may continue.
The gate stores that binding privately, requires a later user turn, and consumes
one matching approval or rejection atomically. A lifecycle change grants no
signing authority: a distinct, immutable reauthorization plan is still
required. The canonical saved-profile apply result may create and return that
plan automatically, but applying it still requires a later user turn. Every
fund movement is bound to its own exact server plan.

MCP is not an OS sandbox. Same-user filesystem and shell access are outside this
tool contract; see the threat model.
