---
name: agent-boost-wallets
description: Create or load wallets and manage named child balances.
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [wallet, balances, profiles, lifecycle]
    category: tools
---

# Manage Agent Boost Wallets

Manage saved wallets or named private children, or read the main balance.
Plural overviews belong to `agent-boost-wallet-tree`.

## Hermes tool discovery

With Tool Search, search the exact canonical name, describe that match, then
invoke it through `tool_call`; never reply between those steps or directly call
a catalog-only name. Use `wallet_preview_saved_profile_load` for explicit loads,
including “my old wallet”; `wallet_list_saved_profiles` only for inventory,
adoption, or archive; `wallet_plan_reauthorization` only for an independent
authorize request; and `wallet_get_main_balance` only for a main-balance
question. For named authorization, pass exact `wallet_name`; never load instead.
Do not search by “old,” “previous,” or a friendly name, preread the tree, or
create a wallet.

For a child, use `wallet_preview_private_balance_create` or
`wallet_preview_private_balance_fund`. “Check again” reads the matching status
once with the retained request ID; never ask for the ID or repeat a mutation.

Without `structuredContent`, preserve exact state from
`_meta["org.agentboost/model-context"]` without quoting metadata or IDs. Never
guess an ID, expose tool names, or suggest reload after a successful search.

## Read the main balance

For a current balance or affordability question, call
`wallet_get_main_balance`; history and onboarding are not balance sources. Pass
a comparison unchanged as `amount_native`. Quote `Main account balance:`, omit
the address unless requested, and never convert atomic values. This is not a
private-spendability proof or required transfer preflight.

## Preview standalone wallet authorization

For an independent authorize request, call `wallet_plan_reauthorization`
directly. Pass an exact supplied `wallet_name`; omit it only for the active,
current, or selected wallet. Never load/select as a substitute or authorize a
different active wallet. If inactive, relay the signed load-first result and
stop. Otherwise show its wallet, count, per-send and total limits, and expiry,
then end the turn. A later approval belongs to `agent-boost-authorize`;
planning grants no authority and moves no funds.

## Load one named saved wallet

For a request such as “Load saved-wallet,” “load my agent boost wallet,” or
“load my old wallet,” call
`wallet_preview_saved_profile_load` directly with only the user's friendly
wording in `wallet_name`; the tool resolves it and returns the exact canonical
name or a typed friendly-name choice. Do not list profiles first: the preview
tool performs the live resolution itself. A transfer that merely names a
source wallet is not a load request and belongs to `agent-boost-transfers`.

If the result is `WALLET_PROFILE_SELECTION_REQUIRED`, copy its concise signed
friendly-name question as the entire response and stop. Do not choose the first
profile or make another tool call in that turn.

If the result says the requested profile is already active and authorized,
say it is already loaded and ready under its current limits. Do not ask for
confirmation or reauthorize it. For one inactive registered profile, its
confirmation-required result is the authoritative preview. Show exactly this
and end the turn:

```text
**Confirm wallet switch**
**Wallet:** <friendly name>
This archives the current workflow. Valid stored bounded authorization is preserved.
Only missing, expired, disabled, or exhausted authorization needs separate reauthorization.
**Next:** Reply ✅ to switch or ✕ to cancel.
```

Add no caveat, alternative, or follow-up question after this block. Preserve
its `expected_active_wallet_name` and `expected_active_selection_epoch`
internally. The later reply belongs to `agent-boost-wallet-actions`. When an
approved private-ready load needs fresh authority, its apply result already
contains the next authorization preview; Hermes must not insert another
planning call.

## List or discover saved wallets

1. Call `wallet_list_saved_profiles` only for an explicit inventory, adoption,
   or archive request. Use friendly `name` values in chat and
   internal IDs only in tool calls. It may also return safe-to-adopt local
   Sepolia wallets by friendly name; never request a seed, key, password, or
   path.
2. For “old,” “previous,” “already set up,” or “load” requests, call
   `wallet_preview_saved_profile_load` directly. It gives registered profiles
   priority over adoptable local wallets, resolves the sole inactive eligible
   profile, or returns friendly-name choices. With two or more eligible
   profiles, show only those friendly names and stop. Never choose the first
   profile.

For a safe-to-adopt local wallet, call `wallet_adopt_existing` with its exact
friendly `name` and omit `user_confirmed`. Show its confirmation preview and
preserve `expected_active_wallet_name` and `expected_active_selection_epoch`
internally. Do not retry with confirmation in this turn. The next user reply
belongs to `agent-boost-wallet-actions`.

## Preview create, archive, or reset

- For a named wallet, obtain a friendly name if absent, then call
  `wallet_create` with that exact `name` and omit `user_confirmed`. Its
  confirmation-required result is the preview. Explain that creation selects
  it, archives the current workflow, starts setup, and later needs its own
  authorization. Preserve its `expected_active_wallet_name` and
  `expected_active_selection_epoch` internally. Ask for confirmation and end
  the turn.

If one request says to create a top-level wallet and then add a named private
balance under it, start with only the exact top-level `wallet_create` preview.
Wallet creation, setup, child creation, and child funding are separate durable
boundaries; never create the child on the old active wallet or auto-run a later
clause across one of those boundaries.
- To archive, first call `wallet_list_saved_profiles`. Only an inactive profile
  may be archived. Then call `wallet_archive` with its exact `wallet_name` and
  omit `user_confirmed`. Use its confirmation-required result as the preview.
  Show the exact friendly name and explain that encrypted wallet data, private
  state, and audit history remain recoverable. Ask for confirmation and end the
  turn.
- For an explicit start-over or fresh disposable demo request, explain that the
  current workflow and unresolved request will be archived, the old Kohaku
  wallet remains local, and fresh Sepolia funding is required. Call
  `wallet_start_new_demo` with an empty object and omit `user_confirmed`. Use
  its confirmation-required result as the preview, preserve its
  `expected_active_wallet_name` and `expected_active_selection_epoch`
  internally, ask for confirmation, and end the turn.

Each preview turn makes exactly one lifecycle preview call; this creates no
wallet effect and gives Hermes a typed hard boundary. Never call the matching
apply action in that same turn. The later reply belongs to
`agent-boost-wallet-actions`. Create, adopt, switch, archive, reset, and
authorization are distinct confirmations. Assistant text is never user
confirmation.

## Create or fund a private balance

To add a persistent private child under a saved wallet, call
`wallet_preview_private_balance_create` with its friendly
`private_balance_name` and optional parent `wallet_name`. A named parent is
loaded internally. This does not create a top-level wallet or move funds. Show
the signed preview and stop; creation and funding are separate confirmations.

To fund a child, call `wallet_preview_private_balance_fund` with the target,
one exact Sepolia ETH amount, and optional parent. Set `source: $main` only
when the user chose that parent's main/public account. When they chose another
private balance, pass that sibling's exact friendly name as `source`; never use
the parent name there. The preview states the full source debit, target credit,
fee/remainder behavior, and privacy tradeoff. Copy it and stop.

Do not list or read the tree first when names are supplied. Both previews are
hard turn boundaries. Their later approval or rejection belongs to
`agent-boost-confirm`, which applies the retained decision exactly once.

## Conversation style and safety

Keep ordinary replies to a headline plus at most three short lines. Use **✓**
complete, **◌** working, **!** needs attention, and **✕** failed or cancelled.
Use bold sentence-case headings and end pending state with one bold **Next:**
line. Hide wei, internal phases, timestamps, IDs, and tool syntax.

This is Sepolia-only and for valueless test assets. The sidecar owns facts,
policy, durable transitions, signing, and secrets. Authorization may expire;
the encrypted wallet, balance reads, and funds do not.
