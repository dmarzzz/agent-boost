# Hermes integration

Agent Boost is a stdio MCP server plus a modular Hermes skill bundle. The
one-time installer places the executable and pinned Kohaku dependency locally,
copies the complete version-matched bundle into the active Hermes profile,
adds one conflict-safe MCP entry, defaults Hermes's narrow tool-use enforcement
on and three broader competing guidance controls off when the operator has not
chosen values, keeps the small toolset eager when the operator has not chosen a
tool-search mode, installs the native pre-LLM bridge plus supported pre/post
tool turn-gate hooks with exact approvals, tests both shell hooks, validates
the native plugin, and runs `hermes mcp test agent-boost`.

## Supported hosts

- macOS arm64;
- macOS x86_64;
- Ubuntu 24.04 arm64;
- Node.js 22 or newer;
- Hermes 0.21.0 or a compatible later release.

```console
make install
agent-boost doctor
```

The installer never replaces an unrecognized or customized `agent-boost` MCP
entry. It can migrate a prior exact managed entry to the newly resolved
executable, removing the retired exact managed pre-LLM shell hook and approval
plus only the corresponding stale tool hooks and approvals. It preserves
unrelated plugin settings, hooks, and approvals. It creates timestamped backups
before changing existing Hermes config, hook allowlist, or skill files. Repeat
installation with the same content is idempotent.

Restart Hermes once and begin a fresh conversation; skill/MCP reload commands
do not register newly configured plugins or hooks. Use `/new` locally or `!new` over
Matrix after the restart. The fresh session prevents facts and behavioral
assumptions from the prior contract surviving an upgrade; the old transcript
remains in Hermes history.

## Generated MCP configuration

```yaml
agent:
  tool_use_enforcement: true
  execution_guidance: false
  task_completion_guidance: false
  parallel_tool_call_guidance: false
  system_prompt: |-
    [BEGIN AGENT BOOST MANAGED ROUTING]
    Agent Boost wallet rules:
    - An unqualified transfer from a named wallet, profile, or main account is regular/public. For an explicit regular/public send from <parent>/<pocket>, put the parent in source and the child in source_private_balance; if only the pocket or its public change is named, use $selected as source and that child name in source_private_balance. It remains regular, not private. The word private inside a saved-wallet friendly name never selects private mode or a child pocket; only an explicit private, shielded, from-private, recovery, or unshield request does. Route mode first: regular/public -> wallet_preview_regular_transfer; private/shielded -> wallet_preview_private_transfer; recovery/private-to-main -> wallet_preview_recovery_transfer. Do this even when the source is named or inactive; never list or load it first. Treat destination names as lookups; never infer wallet creation.
    - A private balance is a named child pocket under one saved wallet, not another top-level wallet. Use wallet_preview_private_balance_create to add one, wallet_preview_private_balance_fund to fund one, and the private-balance policy tools for its own limits. For funding, wallet_name is the parent; source=$main means that parent's public account, otherwise source is an exact sibling pocket name. Its nested public-change balance stays under that child and is regular-sendable. Use wallet_get_tree for the overview.
    - Any preview or result that asks for approval ends this assistant turn. Continue only after a later actual user turn; all approval happens through that chat reply, never an app, popup, or other confirmation surface. Never manufacture, quote, simulate, or impersonate user input.
    - Never put raw tool/function-call syntax (including <function> tags) or internal tool, decision, or request IDs in user-facing text.
    - A canonical transfer execution performs one no-rebroadcast verification read itself and returns the final, unresolved, or explicitly unverified state. Do not add another tool call in that assistant turn. A matching wallet_get_*_request tool is only for a later user status request; never execute again to check.
    - When the latest trusted Agent Boost result requested a status follow-up, a fresh user message such as check again starts a new read-only turn. Perform exactly one fresh read for that matching setup or unresolved operation; never answer from an older balance, phase, or tree. Repeating a read across user turns is allowed and required. This never permits repeating an execute, apply, create, fund, shield, or broadcast action.
    [END AGENT BOOST MANAGED ROUTING]

mcp_discovery_timeout: 60
mcp_single_query_discovery_timeout: 60

tools:
  tool_search:
    enabled: off

display:
  busy_input_mode: queue

plugins:
  enabled:
    - agent-boost-output-guard
  entries:
    agent-boost-output-guard:
      settings:
        turn_gate_executable: /absolute/path/to/agent-boost

hooks_auto_accept: false

hooks:
  pre_tool_call:
    - matcher: .*
      command: /absolute/path/to/agent-boost hermes-turn-gate
      timeout: 5
      fail_closed: true
  post_tool_call:
    - matcher: (?:mcp__agent_boost__.*|tool_call)
      command: /absolute/path/to/agent-boost hermes-turn-gate
      timeout: 5

mcp_servers:
  agent-boost:
    command: /absolute/path/to/agent-boost
    args: [mcp, --mode, dark, --contract-major, "1"]
    enabled: true
    timeout: 360
    supports_parallel_tool_calls: false
    tools:
      include:
        - capabilities
        - onboarding_start
        - onboarding_status
        - wallet_get_main_balance
        - wallet_list_saved_profiles
        - wallet_get_tree
        - wallet_preview_private_balance_create
        - wallet_apply_private_balance_create
        - wallet_preview_private_balance_fund
        - wallet_apply_private_balance_fund
        - wallet_get_private_balance_operation
        - wallet_get_private_balance_policy
        - wallet_preview_private_balance_policy_update
        - wallet_apply_private_balance_policy_update
        - wallet_create
        - wallet_adopt_existing
        - wallet_preview_saved_profile_load
        - wallet_apply_saved_profile_load
        - wallet_archive
        - wallet_plan_reauthorization
        - wallet_apply_reauthorization
        - wallet_get_policy
        - wallet_plan_policy_update
        - wallet_apply_policy_update
        - wallet_start_new_demo
        - wallet_preview_regular_transfer
        - wallet_execute_regular_transfer
        - wallet_get_regular_transfer_request
        - wallet_preview_private_transfer
        - wallet_execute_private_transfer
        - wallet_get_private_transfer_request
        - wallet_preview_recovery_transfer
        - wallet_execute_recovery_transfer
        - wallet_get_recovery_request
        - egress_capabilities
        - egress_status
        - egress_fetch
      resources: false
      prompts: false
```

The six-minute MCP deadline is intentional. A first private-wallet operation
may need to rebuild Kohaku's Tor guard state before it can return its durable
receipt; a shorter bridge deadline can abandon an operation that subsequently
finishes successfully. Agent Boost operations remain internally bounded and
idempotent, and later status checks never rebroadcast them.

The narrow `tool_use_enforcement` setting defaults to `true` when absent so a
weak model cannot replace a required call with prose. The other three generic
guidance settings default to `false` because their keep-working/read-back
instructions can compete with Agent Boost's preview and confirmation turn
boundaries. Each setting is handled independently, and every explicit operator
value is preserved.

The installer never enables `hooks_auto_accept`. It preserves false/absent and
refuses an effectively true value rather than weakening approval for unrelated
hooks. The allowlist retains unrelated fields and approvals while adding only
the exact pre-tool and post-tool turn-gate approvals shown above. The native
plugin receives the separately configured exact absolute executable path; it
does not parse a shell command or search `PATH` before invoking the pre-LLM gate.

`tools.tool_search.enabled: off` is likewise an Agent Boost integration
default, applied only when that value is absent. It keeps the allowlisted Agent
Boost schemas eager, avoiding a search/describe round trip on this curated
integration catalog. Eager `off` is the supported reliability setting for this
small allowlist. The native confirmation adapter fails closed and pins a
well-formed action through Hermes's generic `tool_call` bridge when an operator
explicitly keeps Tool Search enabled, but Hermes validates the bridge's inner
schema before middleware can repair malformed model arguments. Tool Search is
therefore safe but less completion-reliable for weaker models. The installer
preserves explicit `on`, `off`, or `auto` values, the legacy boolean form,
sibling tool-search tuning, and unrelated Hermes configuration.

The native names above are the stable contract. Any prefix Hermes adds to a
model-visible tool name is a host implementation detail.

## Why the contract has three layers

Canonical tool names carry one concrete intent: `preview` versus `execute`,
`regular` versus `private` versus `recovery`, and `get_tree` versus
`list_saved_profiles`. Descriptions state both when to use a tool and when not to
use it. Required, narrow schemas make the model supply the whole intent in one
shape. Older names remain callable only as hidden compatibility adapters, so a
weak model does not have to choose between synonyms.

Skills handle natural-language routing, short multi-turn sequences, and recovery
instructions. They are not the authority boundary. In particular, Matrix does
not have the CLI's per-message `--skills` preload, so correctness cannot depend
on a specialist already being loaded: canonical names and descriptions remain
self-routing in the eager catalog, while the small router can load a specialist
with `skill_view` when useful.

The Hermes turn gate is the enforcement layer for conversational consent. The
native plugin calls the pre-LLM gate with the real user message and full Hermes
session provenance. Shared-session review/task forks are marked privately and
excluded without consuming the root turn. A preview result carries a typed
continuation binding; the post-tool hook records
it in private, hashed, expiring session state. The post hook is restricted to
Agent Boost results, while the fail-closed pre hook matches every tool so a
preview ends all further tool use in that assistant turn, including terminal,
search, skill, and other-server calls. On a later user turn the native pre-LLM
bridge authenticates the reply, and the pre-tool hook accepts
`user_confirmed: true` or `false` only with the exact tool and stable binding,
then consumes it once. Thus an overeager fallback model cannot turn its own
preview into user approval or route around the stop through another tool. Agent
Boost still independently binds policy and transfer effects to immutable
durable plans. The native execution fence also rejects any redundant tool call
after a signed preview boundary or terminal receipt in the same user turn, so a
weak model cannot follow a cancellation with an unnecessary status read.

Status follow-ups use a separate read-only continuation. A trusted unresolved
Agent Boost result stores the exact setup revision or request ID privately; a
later “check again” turn pins one matching getter and its arguments through the
turn gate and native adapter. The handle never falls back to setup or execution,
does not exist in unrelated sessions, and is refreshed or cleared only by the
matching signed status result. This prevents stale chat prose without turning a
read retry into a transaction retry.

## Skill split

`agent-boost` is a short dependency-free router. It remains discoverable when
the MCP child is unavailable, selects one intent specialist with `skill_view`,
and retains the refresh path without loading the former 31 KB branching manual.
The specialists are deliberately ungated too: Hermes calculates available
toolsets after deferring Tool Search entries, so gating recovery guidance on the
MCP can make that guidance disappear precisely when discovery fails.

The installed specialists are:

- `agent-boost-setup` for setup, funding, and readiness;
- `agent-boost-wallet-tree` for the single-call byte-exact live tree;
- `agent-boost-wallets` for saved profiles and main-balance reads;
- `agent-boost-policy` for current limits and policy previews;
- `agent-boost-transfers` for regular, private, and recovery previews;
- `agent-boost-wallet-actions` for later wallet lifecycle confirmations;
- `agent-boost-authorize` for later wallet-authorization confirmation;
- `agent-boost-confirm` for later policy and transfer decisions;
- `agent-boost-covered-web` for covered public HTTPS reads.

Planning skills intentionally omit their apply and execute tool names. They
show one exact preview and end the assistant turn. A later user reply loads a
small confirmation specialist that applies only the immediately preceding
decision. The wallet-tree specialist contains only the tree tool and stops
after its first successful result. This reduces prompt competition on weaker
models while preserving distinct switch, authorization, transfer, and policy
confirmations.

When a transfer names a saved destination, Hermes passes its friendly name and
Agent Boost resolves the profile's main/public receiving account. Hermes never
asks the user to look up that address or exposes the resolved address unless it
was explicitly requested. A named source is passed to the planner too. If it is
inactive, the typed planner result is the complete switch preview and a hard
turn boundary: no inventory, switch, authorization, or retry occurs in that
turn.

The original mode, amount, source name, and destination reference survive the
confirmed switch and separate authorization. After each approved prerequisite
Hermes automatically advances to the next preview, but switch approval never
doubles as authorization approval and authorization approval never doubles as
transfer approval.

The skills are choreography. Sepolia enforcement, adjustable hard ceilings,
expiry, payment-count use, balance checks, policy-plan binding, and idempotency
are enforced in Agent Boost.

Policy editing uses `wallet_get_policy`, `wallet_plan_policy_update`, and
`wallet_apply_policy_update`. The user speaks in native-token decimals; the MCP
boundary converts decimal strings exactly. Because JSON parsing erases a
number's original spelling, any intended fractional amount must be a string;
parsed non-integers are rejected, while safe whole-number values such as `66`
are accepted. The preview says explicitly that authority is not liquidity:
applying it does not move the main balance into the private payment pocket or
approve a payment.

## Onboarding

`onboarding_start` creates or resumes a durable setup. It returns:

- `data.setup`: the full public setup record;
- `data.public`: the public UI-safe projection;
- `data.ui_opened`: whether a graphical browser was opened;
- a branded dark-mode MCP PNG card when an address is ready and a headless
  fallback is needed. Its QR scan field remains muted, high-contrast, and
  uninterrupted with conventional dark-on-light polarity.

On graphical macOS or Linux, the page opens at a loopback URL. On headless
Linux, Hermes should display the returned image. The page is read-only; the only
human action is sending Sepolia ETH from a separate wallet.

In the reference Matrix conversation, Hermes sends the funding instruction,
bare address, and QR as separate events. The address event contains no label or
formatting so a mobile user can copy the complete message directly.

`onboarding_status` accepts the exact `setup_id`, optional
`since_revision`, and optional `wait_ms` up to 90 seconds. Revisions advance
only for meaningful state changes, so a long-poll does not consume Hermes tool
turns while funding is unchanged.

## Payment execution

`wallet_preview_private_transfer` accepts the same route-first shape as the
regular and recovery previews:

```json
{
  "source": "$selected",
  "destination": "0x2222222222222222222222222222222222222222",
  "amount_native": "0.02"
}
```

Agent Boost converts the ordinary Sepolia ETH decimal to wei internally.
Planning refreshes Kohaku's private balance, reads the durable delegation, and
returns `allow` or `deny` with explicit blockers. It creates no transaction.

`wallet_execute_private_transfer` accepts only the returned decision ID, a
stable client request ID, and the confirmation attestation. It never accepts a
second copy of the recipient or amount. Under the default policy, Hermes shows
the exact structured receipt in chat and ends the turn. A new explicit user
approval causes Hermes to call the execution tool with `user_confirmed: true`;
Agent Boost never invokes advertised MCP elicitation for this flow. An omitted
attestation stays pending in chat. The boolean is Hermes's attestation, not
independent speaker authentication. A decline never executes. A repeat with the
same client ID and decision returns the original request; a conflicting repeat
is rejected.

Each canonical transfer execution performs exactly one matching status read
after it creates or recovers the durable request. The read cannot rebroadcast,
and the execution call normally returns the resulting `*_STATUS` directly. If
verification is unavailable, the result remains the truthful durable request
with `verification_unavailable: true`; use the standalone status tool later
without calling execution again.

Recoverable create, adopt, select, archive, and demo-reset actions first return
a typed no-effect preview. The Hermes turn gate persists its exact action,
friendly name, and active-selection binding in private expiring state, then
accepts one matching approval or rejection only after a later user message. A
lifecycle change does not grant signing authority. Reauthorization and every
transfer use distinct immutable Agent Boost plans, so a lifecycle confirmation
cannot itself authorize or move funds.

The execution tool can cause signing and broadcast. The authority is constrained
to the active count, per-send, total, and expiry policy, with non-adjustable
Sepolia and testnet ceilings. A submitted result is not confirmed. Agent Boost
distinguishes a Kohaku UserOperation hash from a transaction hash and durably
journals each private UserOperation before the adapter may broadcast it. Once
that journal exists, only the exact successful transaction/UserOperation
receipt, bound to the durable request and expected sender, can confirm it;
recipient balance movement is never delivery evidence. Otherwise Agent Boost
preserves submitted or indeterminate state and reconciles on restart/status
reads without rebroadcast.

`wallet_start_new_demo` is the explicit reset path. After ordinary user
confirmation it archives current state, keeps the prior Kohaku wallet, creates
a new wallet profile, and returns a fresh funding QR. `onboarding_start` alone
always resumes the current wallet.

`wallet_list_saved_profiles` is the selection inventory. It returns registered
profiles and, when Kohaku inventory is healthy, local unregistered wallets with an explicit
Sepolia adoption flag. Hermes speaks only friendly names; internal wallet IDs
stay in structured model context. Every standalone load starts with
`wallet_preview_saved_profile_load`, which resolves human wording such as “my
agent boost wallet” or “my old wallet” against the live inventory itself. A sole
eligible inactive profile becomes the switch preview in that same call; several
matches produce a typed friendly-name choice without a separate inventory tool
hop. On the next turn, an exact friendly-name reply is pinned to one
`wallet_preview_saved_profile_load` call for that name. A
later user decision uses `wallet_apply_saved_profile_load`, which restores an
inactive target's durable setup, advances its selection epoch, and disables
prior authority. The apply call must return the active friendly name and
selection epoch preserved from its preview; Agent Boost atomically rejects
missing or stale bindings without changing wallets. Previewing the already-active
profile is an authorization-preserving no-op. When a restored profile is
private-ready and needs fresh authority, the canonical apply result also
contains the immutable reauthorization preview. Hermes shows that result and
ends the turn instead of making a second planning call.
The installer migrates older `wallet_list` and `wallet_manage_profiles`
allowlist entries to `wallet_list_saved_profiles`, `wallet_get_context` to
`wallet_get_main_balance`, and `wallet_get_request` to
`wallet_get_private_transfer_request`. It also migrates `wallet_select` to
`wallet_preview_saved_profile_load` plus `wallet_apply_saved_profile_load`, and
`wallet_reauthorize` to
`wallet_apply_reauthorization`. These old names remain only as generic MCP
compatibility aliases and are not exposed to Hermes discovery.
`wallet_plan_reauthorization` remains the standalone fallback if an active
wallet needs authority and no preview was bundled with the load result. A
separately confirmed `wallet_apply_reauthorization` mints fresh bounded
authority before another transfer can be planned. An archived profile retains
encrypted data and can be made available by selecting it later.

## Process and state lifetime

Hermes launches Agent Boost as an MCP child. Each launch:

- opens the durable state with private permissions;
- acquires the exclusive loopback runtime-ownership lock;
- bootstraps embedded Tor and verifies the Sepolia chain through it;
- starts the authenticated fixed-origin loopback RPC relay for Kohaku;
- starts the authenticated Shade Tree loopback Proxy only when a complete,
  owner-only Grove enrollment profile is present;
- restores the persisted active wallet profile before resuming work;
- resumes an unfinished funding or shield workflow;
- starts the loopback UI only when onboarding requests it;
- serializes Kohaku calls for the wallet;
- shuts down the watcher and UI when MCP closes.

There is no background daemon or administrative TCP API. The fixed-origin
loopback JSON-RPC relay has a random path, accepts POST only, and can reach only
the configured HTTPS Sepolia RPC through Tor. The separate optional Shade Tree
Proxy accepts authenticated CONNECT and is reachable through the bounded
`egress_fetch` tool only; it is not injected into Hermes process-wide proxy
settings. See [Covered egress](COVERED-EGRESS.md).

## Troubleshooting

```console
agent-boost doctor
agent-boost status
agent-boost install-hermes
make install-kohaku
```

`doctor` verifies Node, pinned Kohaku provenance and executable, a Tor-observed
exit, the Sepolia chain ID through that Tor path, Hermes availability, and the
redacted covered-egress lifecycle. It warns when Shade Tree is unsupported or
needs operator enrollment and never implies that general Hermes traffic is
covered.
