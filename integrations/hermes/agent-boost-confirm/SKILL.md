---
name: agent-boost-confirm
description: Approve or cancel Agent Boost policy and transfer previews.
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [wallet, confirmation, payments, policy]
    category: tools
---

# Resolve an Agent Boost Preview

## First action

Before writing any user-facing text, invoke the exact apply or execute tool and
exact arguments supplied by trusted Agent Boost turn context. The tool call is
the response action: a text-only acknowledgement cannot apply or cancel
anything and must never claim an action was sent, submitted, applied, started,
or cancelled.

Use this skill in exactly one of two situations:

- a new user reply is resolving the immediately preceding transfer, policy,
  private-balance creation, or private-balance funding preview after that
  preview turn ended; or
- `agent-boost-transfers` just produced a transfer plan whose returned approval
  action is `allow` and whose user-confirmation requirement is false.

The second path is an immediate same-turn continuation authorized by the local
policy, not a preview or a simulated user reply. It applies only to transfer
plans; policy changes and wallet authorization always require a later user
message. In either path, resolve exactly that decision and never create a
replacement plan in this skill.

Approval includes yes, send it, go ahead, approved, confirm, do it, proceed,
✅, 👍, or equivalent. Rejection includes no, cancel, stop, ✕, or equivalent.
If the reply changes any amount, recipient, mode, limits, expiry, enabled state,
wallet, or action, do not apply the old preview; return to the matching planning
skill for a new preview.

If the preceding transfer preview used a saved-wallet friendly destination,
keep that friendly label in the final receipt. Do not replace it with the
internally resolved address unless the user explicitly asks. The bound plan's
address remains execution authority; the conversational label is presentation
context only and must never be used to rewrite the pending decision.

Every rejection call carries `user_confirmed: false`; never leave its pending
decision live with a text-only acknowledgement.

When the progressive bridge is visible, search for the exact apply or execute
capability matching the preceding preview, describe it, and invoke it through
`tool_call`. Do not reply between discovery steps or call a catalog-listed name
directly. Preserve exact IDs from `structuredContent` or
`_meta["org.agentboost/model-context"]`. Never guess, rewrite, expose, or ask
the user for an ID or tool name.

## Wallet policy

For a policy preview, call `wallet_apply_policy_update` with the exact pending
decision and `user_confirmed: true` for approval or `false` for rejection. Do
not read policy first and do not replan.

After `POLICY_UPDATED`, copy the returned four-line user-facing block verbatim
as the entire final response. Preserve the header, `Status:` label, values, and
no-funds-moved statement; do not paraphrase or add an explanation. Use exactly:

```text
✅ Permission updated
Status: <Enabled or Disabled>
<count> sends · <per-send> Sepolia ETH max each · <total> Sepolia ETH total
No funds moved.
```

After rejection, use exactly:

```text
✕ Permission change cancelled
Existing wallet limits are unchanged.
No funds moved.
```

For a named private-balance policy preview, call
`wallet_apply_private_balance_policy_update` with the exact pending decision
and matching confirmation value. Copy its signed final block. It changes only
that child; do not read or apply the parent policy.

## Private-balance lifecycle

For a creation preview, call `wallet_apply_private_balance_create` with the
exact pending decision and matching confirmation value. Created means the
named isolated child is persistent and usable but unfunded. Failed or
unresolved is not created; never create a replacement while unresolved.

For a funding preview, call `wallet_apply_private_balance_fund` exactly once.
Its signed result is the final answer for this turn. Only `confirmed` means the
target was funded. `submitted` or `indeterminate` must not be retried or
replaced; a later status request uses `wallet_get_private_balance_operation`
with the retained request ID. Never reveal or ask the user for that ID.

Creation, funding, and policy are separate confirmations. A creation approval
cannot also fund the child, and a funding approval cannot change its policy.

## Regular public transfer

Call `wallet_execute_regular_transfer` for the exact pending decision with the
matching `user_confirmed` value. Always omit `client_request_id`. On rejection,
report that the regular transfer was cancelled and nothing was sent.

On approval, the execution call performs one no-rebroadcast verification read
and normally returns `REGULAR_TRANSFER_STATUS`. Report **✓ Regular transfer
sent** only for `confirmed`; report failed or unresolved state honestly and
never create a replacement. If bundled verification was unavailable, report
the signed unverified state and stop; `wallet_get_regular_transfer_request` is
only for a later user status request. Never execute again to check.

## Private payment

Call `wallet_execute_private_transfer` for the exact pending decision with the
matching `user_confirmed` value. Always omit `client_request_id`. For
`PAYMENT_CANCELLED`, report **✕ Payment cancelled** and that nothing was sent.

On approval, the execution call performs one no-rebroadcast verification read
and normally returns `PAYMENT_STATUS`. Report **✓ Sent** only for `confirmed`.
For `submitted` or `indeterminate`, say **! Not confirmed yet** and that it is
unsafe to retry. For `failed`, say **✕ Not sent** and give the single actionable
reason. If bundled verification was unavailable, report the signed unverified
state and stop; `wallet_get_private_transfer_request` is only for a later user
status request. Never execute again to check.

## Exact recovery transfer

Call `wallet_execute_recovery_transfer` for the exact pending decision with the
matching `user_confirmed` value. On rejection, report **✕ Recovery cancelled**
and that nothing was signed, submitted, or sent.

On approval, the execution call performs one no-rebroadcast verification read
and normally returns `RECOVERY_STATUS`. Report **✓ Recovery confirmed** only
for `confirmed`. If bundled verification was unavailable, report the signed
unverified state and stop; `wallet_get_recovery_request` is only for a later
user status request. Never execute again to check. The receipt must repeat the full private
denomination consumed, exact amount the recipient received publicly, public
remainder before fees, minimum fee reserve, and estimated private balance after
recovery. Never describe only the recipient amount as leaving the private
balance. Submitted or indeterminate recovery is unresolved and must not be
replaced or retried.

For a confirmed recovery, use:

```text
**✓ Recovery confirmed**
**Private denomination consumed:** <denomination> Sepolia ETH
**Recipient received publicly:** <amount> Sepolia ETH
**To:** <full address OR friendly name — main/public receiving account>
**Public remainder before fees:** <denomination minus recipient amount> Sepolia ETH
**Minimum fee reserve:** <fee reserve> Sepolia ETH
**Estimated private balance after:** <remaining private balance> Sepolia ETH
```

## Shared safety

Under a preceding `allow` plan, apply the exact plan without
`user_confirmed`. Under `deny`, no action is allowed. No policy can bypass
Sepolia-only operation, Tor fail-closed routing, delegation limits, expiry, or
adapter readiness.

Never infer success from a balance change, allowance use, a missing note, or
elapsed time. Never use a terminal or alternate network route around a failure.
Hide wei, IDs, raw phases, protocol detail, and tool syntax. Never request or
expose a seed, private key, password, or signing material.

## Verification

Policy completes only on its matching terminal applied result. A transfer
completes only on `confirmed` from the matching execution or status tool for
the same request. Submitted or indeterminate state is unresolved and never
authorizes a replacement.
