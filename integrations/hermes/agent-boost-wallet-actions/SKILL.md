---
name: agent-boost-wallet-actions
description: Confirm a saved-wallet switch, creation, archive, or reset.
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [wallet, confirmation, lifecycle]
    category: tools
---

# Confirm an Agent Boost Wallet Action

Use this skill only for the user's later reply to the immediately preceding
wallet switch, transfer-source switch, adoption, creation, archive, or
fresh-demo preview. It does not handle a transfer send, policy, or
wallet-authorization preview.

When the progressive bridge is visible, search for the one exact wallet action
from the preceding preview, describe it, and invoke it through the bridge. Do
not reply between discovery steps. Preserve exact friendly names and internal
state from the preceding result; never expose tool names, identifiers, or a
selection epoch. Every switch, adoption, creation, and fresh-demo preview
returns an internal `expected_active_wallet_name` plus
`expected_active_selection_epoch`; preserve both exactly for approval or
rejection. A transfer-source switch uses the same binding from its preview.

A clear approval includes yes, switch, create it, go ahead, approved, confirm,
do it, proceed, ✅, 👍, or equivalent. Assistant preview text is not approval.
A changed target or action requires a new preview.

## Resolve the pending wallet action

- For a saved registered wallet, including a transfer planner's typed
  source-switch preview, call `wallet_apply_saved_profile_load` with the exact
  `wallet_name`, preserved `expected_active_wallet_name`, preserved
  `expected_active_selection_epoch`, and `user_confirmed: true`. On rejection
  call the same tool with those exact bindings and `user_confirmed: false`,
  then report **✕ Wallet switch cancelled** and `Nothing changed.` A
  source-switch preview already resolved the canonical friendly name and
  binding, so do not repeat an inventory read. If Agent Boost says the preview
  is stale, report that nothing changed and stop; never retry that approval.
- For a safe local unregistered wallet, call `wallet_adopt_existing` with its
  exact friendly `name`, preserved `expected_active_wallet_name`, preserved
  `expected_active_selection_epoch`, and `user_confirmed: true`. On rejection
  call the same tool with the same name and exact bindings plus
  `user_confirmed: false`, then say nothing changed.
- For a named new wallet, call `wallet_create` with the exact friendly `name`
  plus the preserved `expected_active_wallet_name` and
  `expected_active_selection_epoch`, then set `user_confirmed: true`. On
  rejection call the same tool with the same name and exact bindings plus
  `user_confirmed: false`, then say nothing changed.
- For an inactive profile archive, call `wallet_archive` with the exact
  `wallet_name` and `user_confirmed: true`. On rejection call the same tool with
  the same `wallet_name` and `user_confirmed: false`, then say nothing changed.
- For a fresh disposable demo, call `wallet_start_new_demo` with
  preserved `expected_active_wallet_name`, preserved
  `expected_active_selection_epoch`, and `user_confirmed: true`; on rejection
  call it with both exact bindings and `user_confirmed: false` so the pending
  reset is cancelled.

Selection restores durable setup and request state. The canonical
`wallet_apply_saved_profile_load` also creates the next immutable
reauthorization preview when the restored profile is `private_ready` and needs
fresh authority. This planning is part of the one load call; it grants no
authority and moves no funds. Branch on the returned result:

- On `WALLET_REAUTHORIZATION_PLANNED`, the load succeeded and the returned
  authorization preview is complete. Do not call
  `wallet_plan_reauthorization`, repeat the load, or make another tool call.
  Preserve any original transfer intent, show the preview, and stop.
- On `WALLET_REAUTHORIZATION_DENIED`, the load succeeded but fresh authority is
  blocked. Explain the blocker and stop; do not ask the user to approve it.
- On `WALLET_SELECTED` with `authorization_required: false`, say the wallet is
  selected with active bounded authorization. If the original request included
  an exact transfer from this source, load `agent-boost-transfers`, create that
  transfer preview from the preserved mode, `amount_native`, exact
  `source_wallet_name`, and exactly one preserved destination field
  (`recipient` or `recipient_wallet_name`), then stop; otherwise report the selection and
  stop. Never ask for or reveal a named recipient's resolved address.
- On the exceptional `WALLET_SELECTED` fallback with
  `authorization_required: true` and `setup_phase: private_ready`, call
  `wallet_plan_reauthorization` once only when the result explicitly says that
  the automatic preview was unavailable. Show that preview and stop.

Render the bundled or fallback authorization preview as:

```text
**Authorize wallet transfers**
**Wallet:** <friendly name>
**Permission:** Up to <count> regular or private sends
**Limits:** <per-send> Sepolia ETH each · <total> Sepolia ETH total
**Expires:** <friendly expiry>
This resets the prior spend and send counters. No funds move.
<If a transfer is waiting: **Pending next:** <mode> · <amount> Sepolia ETH to <friendly destination or address>.>
**Next:** Reply ✅ to authorize or ✕ to cancel.
```

Planning grants no authority. Keep the original transfer mode, amount, canonical
source name, and destination reference bound to this pending sequence. After
this preview do not search, describe, or invoke another Agent Boost tool. The
next user reply belongs to `agent-boost-authorize`; do not load that skill now.
Wallet-switch approval never doubles as authorization approval.

If authorization is required before setup is `private_ready`, call
`onboarding_start` to resume and follow `agent-boost-setup` before an
authorization preview.

For a fresh demo success, present the returned funding amount, address, and QR
using the `agent-boost-setup` conversation contract. Never display a local URL.

## Verification

Report an action complete only after its exact tool returns the matching
successful result. A reauthorization preview is pending, not complete, and is
the final output of its turn.
