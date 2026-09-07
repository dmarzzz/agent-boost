---
name: agent-boost-authorize
description: Resolve an Agent Boost wallet authorization preview.
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [wallet, authorization, confirmation]
    category: tools
---

# Resolve Wallet Authorization

Use this skill only for a new user reply to the immediately preceding wallet
authorization preview. That preview may have been returned directly by a
confirmed `wallet_apply_saved_profile_load` or by the standalone fallback
planner. The preview turn has ended. Resolve that exact decision; never create
a replacement authorization plan in this turn.

Approval includes yes, authorize, go ahead, approved, confirm, proceed, ✅, 👍,
or equivalent. Rejection includes no, cancel, stop, ✕, or equivalent. A changed
wallet or permission requires a new preview.

When the progressive bridge is visible, search for the wallet authorization
apply capability, describe it, and invoke it through `tool_call`. Do not reply
between discovery steps or call a catalog-listed name directly. Preserve the
exact decision from `structuredContent` or
`_meta["org.agentboost/model-context"]`. Never guess, rewrite, expose, or ask
the user for an identifier or tool name.

Call `wallet_apply_reauthorization` with the exact pending decision and
`user_confirmed: true` for approval or `false` for rejection. Do not restart
setup or replan authorization.

On rejection, report that no authority was granted and stop. On
`WALLET_REAUTHORIZED`, report **✓ Wallet authorized**, the friendly name, and
`No funds moved.`

If the original request included an exact regular, private, or recovery
transfer from this saved wallet, keep its supplied mode, `amount_native`, exact
`source_wallet_name`, and exactly one destination field: `recipient` for a raw
address or `recipient_wallet_name` for a saved friendly name. After
authorization succeeds, load `agent-boost-transfers`, create the matching
transfer preview automatically, and stop. Do not ask for known details again or
reveal a named recipient's resolved address. Authorization approval never
doubles as transfer approval; the user must reply again to the new transfer
preview.

After producing that transfer preview, do not search, describe, or invoke
another Agent Boost tool. Never request or expose a seed, private key, password,
decision ID, or signing material. Agent Boost is Sepolia-only and for valueless
test assets.

## Verification

Authorization is complete only on `WALLET_REAUTHORIZED` for the exact pending
decision. Any chained transfer remains a preview until its own later reply.
