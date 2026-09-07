# Tools

Agent Boost is an MCP server. Hermes calls its user-facing tools over stdio.
Every result is a structured envelope carrying an outcome (`ready`, `blocked`,
`awaiting_funding`, `executing`, `submitted`, `confirmed`, `failed`, or
`indeterminate`), retry advice, and public facts only. No result is a bearer
token: every limit is enforced from durable local state, not from what the
agent was told.

## Wallet transfers and identity

How a payment works, in the order the tools are called:

1. `onboarding_start` creates or resumes one disposable Sepolia wallet, derives
   a fresh public address, opens the loopback funding page with an EIP-681 QR,
   watches for funding, and shields `0.1` ETH through Kohaku on its own.
2. `onboarding_status` long-polls the durable setup by revision through
   `creating_wallet`, `preparing_privacy`, `awaiting_funding`,
   `funding_pending`, `funded_public`, `shielding`, and `private_ready`.
3. `wallet_get_main_balance` refreshes the main account address and its exact
   on-chain balance, delegation state, and live Tor route status.
4. `wallet_get_tree` renders every available wallet profile as one canonical,
   address-free folder tree with exact wallet/private-balance policies and
   honest balance/policy freshness labels.
5. `wallet_list_saved_profiles`, `wallet_preview_saved_profile_load`,
   `wallet_apply_saved_profile_load`, `wallet_create`, `wallet_adopt_existing`,
   and `wallet_archive` provide the complete local profile lifecycle. Loading
   a prior profile restores its durable setup and disables stale signing. When
   that profile is private-ready, the canonical apply result also contains the
   next immutable reauthorization preview. Only the later
   `wallet_apply_reauthorization` confirmation grants fresh authority;
   `wallet_plan_reauthorization` remains the standalone fallback when no
   bundled preview is available. The preview tool also handles natural generic
   references such as “my old wallet”: it either resolves the sole inactive
   eligible profile or returns friendly-name choices in the same call.
6. `wallet_get_policy`, `wallet_plan_policy_update`, and
   `wallet_apply_policy_update` let the user inspect and change send count,
   per-send amount, total amount, expiry, and enabled state in conversation.
   Every preview has immutable terms and a five-minute lifetime; applying one
   is separately confirmed, bounded, and idempotent. A newer preview supersedes
   an older pending one. Applying changes authority only; it never moves funds.
7. The private-balance create, fund, policy, and operation-status tools manage
   durable named child pockets inside the selected or explicitly named parent
   wallet. A wallet may contain multiple isolated pockets. Funding accepts the
   parent main account or a named sibling pocket; every mutation uses an exact
   preview, a later chat confirmation, and an idempotent request. Policy reads,
   previews, cancellations, and applies can target a child under an inactive
   saved parent without changing the active wallet.
8. `wallet_preview_regular_transfer` requires a source (`$selected` or an exact
   saved-wallet name), a destination (raw address or saved-wallet name), and an
   exact ordinary Sepolia ETH amount. By default it uses main; optional
   `source_private_balance` selects wallet-controlled public change nested
   beneath that pocket. It validates one concrete source account against a conservative gas
   reserve, and the shared delegated limits. Its matching execute and status
   tools remain strictly on the public transfer path.
9. `wallet_preview_private_transfer` requires the same friendly `source`,
   `destination`, and `amount_native` shape as the regular preview, converts the
   amount internally, and validates the exact value
   against readiness, the active count and amount limits, and balance. It returns a
   five-minute immutable plan with a SHA-256 digest over chain, recipient,
   asset, amount, and operation. Plans never sign, submit, or reserve funds.
10. `wallet_execute_private_transfer` takes the internal decision ID after Hermes
   has shown the exact plan and received a new explicit chat confirmation.
   Hermes passes that approval as `user_confirmed: true`; the user never handles
   the ID or leaves the conversation. Execution atomically consumes one send and
   its amount allowance before Kohaku is called. Recipient and amount always
   come from the plan. An uncertain outcome never restores authority for an
   automatic retry. The canonical execution call immediately performs one
   no-rebroadcast verification read and normally returns the verified durable
   status itself.
11. `wallet_get_private_transfer_request` remains available for a later manual
    status check, including after an execution result whose bundled verification
    was unavailable. Reconciliation never rebroadcasts.
12. `wallet_preview_recovery_transfer`, `wallet_execute_recovery_transfer`, and
    `wallet_get_recovery_request` provide a separately confirmed exact-amount
    recovery path. Consent and receipts show the full private denomination
    consumed, exact public recipient amount, public remainder before fees,
    minimum fee reserve, and estimated post-recovery private balance. It is not
    a sweep, and unresolved execution is never retried.

All three canonical transfer previews use the same required `source`,
`destination`, and `amount_native` fields. The hidden legacy planners retain
the older mutually exclusive `recipient` or `recipient_wallet_name` shape. A
unique friendly reference is matched safely across
case and spaces, hyphens, or underscores; optional “my” or “the” and trailing “wallet”
tokens are ignored symmetrically for the query and saved name. It is then resolved inside Agent Boost to
that saved profile's Sepolia **main/public receiving account**—never its private
pocket. Wallet listings and trees remain address-free. The canonical `source`
is `$selected` only when the user did not name one. A named source is resolved
and loaded inside the requested operation; no preliminary inventory or load
call is needed, and an existing valid authorization is preserved. Unknown,
archived, ambiguous, non-Sepolia, and addressless profiles fail with typed
results.

`wallet_start_new_demo` archives the current wallet with private permissions
and starts a fresh funding flow. It needs explicit confirmation and returns a
public archive ID and a new QR, never a path or a secret. Create, adopt, and
start-new-demo previews return `expected_active_wallet_name` plus
`expected_active_selection_epoch`; the later approval or cancellation must echo
both so a different active wallet makes the preview stale instead of changing
the wrong workflow.

| Tool | Input | Returns |
| --- | --- | --- |
| `onboarding_start` | none | setup ID, phase, funding address, QR |
| `onboarding_status` | `setup_id`, `since_revision`, `wait_ms` | latest durable state, or waits for a newer revision |
| `wallet_get_main_balance` | optional `amount_native` affordability comparison | main address and live balance, delegation, route status |
| `wallet_get_context` | same as `wallet_get_main_balance` | deprecated compatibility alias; Hermes does not expose it |
| `wallet_get_tree` | none | address-free profile tree, decimal balances, exact parent/child policies, freshness labels |
| `wallet_preview_private_balance_create` | child `private_balance_name`, optional parent `wallet_name` | immutable preview for a new isolated named pocket |
| `wallet_apply_private_balance_create` | exact internal `decision_id`, later chat confirmation, optional stable request ID | physically creates the pocket's Kohaku wallet once and returns durable status |
| `wallet_preview_private_balance_fund` | optional parent `wallet_name`, source `$main` or sibling pocket name, target pocket, exact `amount_native` | exact main-to-private or private-to-private funding preview |
| `wallet_apply_private_balance_fund` | exact internal `decision_id`, later chat confirmation, optional stable request ID | executes once and returns exact-receipt-backed funding status |
| `wallet_get_private_balance_operation` | exact internal `request_id` retained from creation or funding | later no-rebroadcast status for the same operation |
| `wallet_get_private_balance_policy` | optional parent and exact child-pocket name | that pocket's current limits, use, expiry, and enabled state without switching wallets |
| `wallet_preview_private_balance_policy_update` | target pocket plus any bounded policy changes | immutable pocket-policy preview without switching wallets; never moves funds |
| `wallet_apply_private_balance_policy_update` | exact internal `decision_id`, later chat confirmation, optional stable request ID | idempotently applies only that exact parent/child binding without switching wallets |
| `wallet_list_saved_profiles` | none | registered profiles with setup/authorization state, plus unregistered local Kohaku wallets that may be adopted |
| `wallet_get_saved_profiles` | same as `wallet_list_saved_profiles` | deprecated compatibility alias; Hermes does not expose it |
| `wallet_manage_profiles` | none | deprecated compatibility alias; Hermes does not expose it |
| `wallet_list` | none | older compatibility alias; Hermes does not expose it |
| `wallet_create` | friendly `name`, chat confirmation, and the preview's `expected_active_wallet_name` plus `expected_active_selection_epoch` | newly selected named wallet and setup state; a stale or unbound approval changes nothing |
| `wallet_adopt_existing` | exact local `name`, chat confirmation, and the preview's `expected_active_wallet_name` plus `expected_active_selection_epoch` | registered and selected Sepolia wallet; never accepts secrets or paths, and a stale or unbound approval changes nothing |
| `wallet_preview_saved_profile_load` | one human-friendly `wallet_name` reference such as `agent-boost`, “my agent boost wallet,” or “my old wallet” | uniquely resolved already-active state, an authoritative load preview, or a typed friendly-name choice when a generic reference matches several inactive profiles; never mutates and is never a transfer prerequisite |
| `wallet_apply_saved_profile_load` | exact preview `wallet_name`, `expected_active_wallet_name`, `expected_active_selection_epoch`, and later-turn `user_confirmed` | cancellation or restored profile state; a private-ready switch that needs authority returns its reauthorization preview in this same result, while stale or unbound approval changes nothing |
| `wallet_switch_saved_profile` | legacy flexible wallet reference and confirmation | deprecated compatibility alias; Hermes does not expose it |
| `wallet_select` | same wallet reference and confirmation; preview binding remains optional for legacy callers | deprecated compatibility alias; Hermes does not expose it |
| `wallet_archive` | friendly `wallet_name` (`name` and friendly `wallet_id` tolerated), chat confirmation | retained inactive profile marked archived |
| `wallet_plan_reauthorization` | none | standalone/fallback exact fresh-authority preview bound to the active wallet and selection epoch |
| `wallet_apply_reauthorization` | exact `decision_id` from either reauthorization-preview path, confirmation | fresh authorization and reset send/spend counters |
| `wallet_reauthorize` | same as `wallet_apply_reauthorization` | deprecated compatibility alias; Hermes does not expose it |
| `wallet_get_policy` | none | active send count, amount limits, use, expiry, enabled state |
| `wallet_plan_policy_update` | any of `max_payments`, `per_payment_limit_native`, `lifetime_limit_native`, `expires_in_hours`, `enabled`; observed `count` and `per_send_amount` aliases are normalized | `wpd_` preview with current and proposed policies |
| `wallet_apply_policy_update` | exact internal `decision_id`, `user_confirmed` | idempotent receipt for the named policy preview |
| `wallet_preview_regular_transfer` | required `source`, `destination`, and `amount_native`; optional `source_private_balance` names public change under that pocket, while `$main` or omission uses main | `rwd_` exact public-source decision, balance snapshot, gas reserve, and expiry |
| `wallet_plan_regular_transfer` | legacy mutually exclusive recipient fields, optional named wallet and pocket-public-change source, and `amount_native` | deprecated compatibility adapter; Hermes does not expose it |
| `wallet_execute_regular_transfer` | internal `decision_id`, `user_confirmed` from the follow-up chat approval, optional stable request ID | executes once, performs one no-rebroadcast verification read, and normally returns the redacted public-transfer status |
| `wallet_get_regular_transfer_request` | `request_id` | later/manual redacted public-transfer status without execution or rebroadcast |
| `wallet_preview_private_transfer` | required `source`, `destination`, and `amount_native`; use `$selected` only when the user did not name a source | `wd_` decision, digest, expiry, and confirmation requirement; a private-to-own-main intent routes to recovery |
| `wallet_plan_private_payment` | legacy mutually exclusive recipient fields, optional named source, and `amount_native` | deprecated compatibility adapter; Hermes does not expose it |
| `wallet_execute_private_transfer` | internal `decision_id`, `user_confirmed` from the follow-up chat approval, optional stable request ID | executes once, performs one no-rebroadcast verification read, and normally returns the redacted private-transfer status |
| `wallet_execute_private_payment` | same as `wallet_execute_private_transfer` | deprecated compatibility alias; Hermes does not expose it |
| `wallet_get_private_transfer_request` | `request_id` | later/manual redacted request state without execution or rebroadcast |
| `wallet_get_private_payment_request` | same as `wallet_get_private_transfer_request` | deprecated compatibility alias; Hermes does not expose it |
| `wallet_get_request` | same as `wallet_get_private_transfer_request` | older compatibility alias; Hermes does not expose it |
| `wallet_preview_recovery_transfer` | required `source`, `destination`, and `amount_native`; use `$selected` only when the user did not name a source | exact-amount recovery decision with full denomination, recipient, public-remainder/fee-reserve, and post-recovery private-balance accounting |
| `wallet_plan_recovery_transfer` | legacy mutually exclusive recipient fields, optional named source, and `amount_native` | deprecated compatibility adapter; Hermes does not expose it |
| `wallet_execute_recovery_transfer` | internal `decision_id`, `user_confirmed` from the follow-up chat approval, optional stable request ID | executes once, performs one no-rebroadcast verification read, and normally returns the redacted recovery status |
| `wallet_get_recovery_request` | `request_id` | later/manual redacted recovery status without execution or rebroadcast |
| `wallet_start_new_demo` | `user_confirmed` plus the preview's `expected_active_wallet_name` and `expected_active_selection_epoch` | archive ID, new setup, new QR; a stale or unbound approval changes nothing |

## Covered egress

After a Grove operator enrolls the installation, `egress_fetch` sends one
explicit public HTTPS GET or HEAD through the authenticated loopback Shade Tree
Proxy: embedded Arti, one RLN proof per CONNECT tunnel, up to three revalidated
redirects, 1 MiB and 30 seconds by default, destination TLS verified, and no
direct or raw-Tor fallback. Only the requested URL is covered; wallet RPC and
all other Hermes traffic keep their own routes. Content comes back marked
`untrusted_external`.

| Tool | Input | Returns |
| --- | --- | --- |
| `egress_capabilities` | none | `org.agentboost.egress/0.1` contract, limits, the exact non-anonymity claim |
| `egress_status` | none | one redacted state: `disabled`, `not_installed`, `needs_enrollment`, `starting`, `ready`, `degraded`, `exhausted`, or `failed` |
| `egress_fetch` | `url`, `method` | status, headers, and body of one public HTTPS read |

## Contract

`capabilities` takes no input and returns `org.agentboost.wallet/1.8`: chain and
asset IDs, funding target, amount caps, the effective execution policy, live
readiness, and `guarantees_anonymity: false`. It grants nothing. The same
document is available as the resource `agent-boost://capabilities/wallet/v1`.

## What the agent gets, and what stays behind

| Hermes can read | Not returned through Agent Boost tools |
| --- | --- |
| Sepolia address and chain ID | Seed phrase and private keys |
| Live funding-address balance | Kohaku wallet password |
| Active delegation limits, expiry, and use | Raw Tornado notes and proofs |
| Policy previews and update receipts | Raw signed transactions |
| Payment plan, request, and confirmation state | RPC URL and local filesystem paths |
| Public transaction references | Arbitrary Kohaku command execution |
