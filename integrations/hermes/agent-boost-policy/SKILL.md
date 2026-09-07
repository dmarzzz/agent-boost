---
name: agent-boost-policy
description: Inspect or preview Agent Boost wallet transfer limits.
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [wallet, policy, permissions, limits]
    category: tools
---

# Agent Boost Wallet Policy

Use this skill to inspect or preview changes to wallet-wide or named
private-balance send count, per-send amount, lifetime total, expiry, or enabled
state. It never applies a preview. A policy changes bounded signing authority;
it never moves funds or approves a transfer.

## Hermes tool discovery

When `tool_search`, `tool_describe`, and `tool_call` are visible, search for the
exact canonical name: `wallet_get_policy` for a read or
`wallet_plan_policy_update` for a change. Describe that match, then invoke it
through `tool_call`. Do not search using the entire user utterance or for a
wallet tree/balance first. Do not reply between those steps or call a
catalog-listed name directly.

Preserve exact internal state from `structuredContent` or
`_meta["org.agentboost/model-context"]`; never quote metadata or an identifier.
If search reports Agent Boost, continue instead of giving reload instructions.
Never expose tool names to the user.

For one named child pocket, use `wallet_get_private_balance_policy` for a read
or `wallet_preview_private_balance_policy_update` for a change. Pass its exact
`private_balance_name` and optional parent `wallet_name`; do not substitute the
parent wallet policy. The parent is resolved internally. Reads, previews,
cancellations, and applies target that exact saved parent and child without
switching the active wallet. A later apply fails closed if either binding or
policy changed after the preview.

## Inspect current permission

Call `wallet_get_policy` and answer in Sepolia ETH, not wei. When the user names
a parent wallet, pass that exact friendly name as `wallet_name`; the read must
not switch the active wallet. Include sends used and remaining when returned.
Use live tool values rather than remembered limits.
For a named private balance, call its dedicated read instead and preserve its
friendly name in the answer.

## Preview a change

**Hard turn boundary:** the change request and decision are separate user turns.
In the request turn call only `wallet_plan_policy_update` for wallet-wide
limits or `wallet_preview_private_balance_policy_update` for one named child.
Pass an explicitly named parent as `wallet_name`. Wallet-wide planning and
applying target that saved profile without switching the active wallet. A
child-policy operation behaves the same way: it does not load or select the
parent, and the policy change remains scoped to that one child.
Show its preview as the final response and stop. No tool call may follow the
planned result in that assistant turn. Only a new user message begins the
decision turn.

If the user asks to change a policy but supplies none of the settings below,
ask one concise question about what they want changed. Do not call a policy
tool with empty arguments and do not invent defaults.

Use ordinary decimal values and preserve settings the user did not mention.
Canonical inputs are:

- `max_payments` for send count;
- `per_payment_limit_native` for each-send Sepolia ETH;
- `lifetime_limit_native` for the total;
- `expires_in_hours` for duration;
- `enabled` for the kill switch.

For example, “10 sends of up to 1 Sepolia ETH each” means
`max_payments: 10, per_payment_limit_native: "1"`. Do not read the current
policy first or ask the user to repeat supplied values. If count or per-send
amount changes and no total was requested, the planner intentionally makes the
total their product.

For an allowed preview, the entire final response must copy the returned
user-facing block exactly, including the header, `Status:` label, values, and
approval prompt. Do not paraphrase it into prose. The shape is:

```text
🔐 New wallet permission
Status: <Enabled or Disabled>
Up to <count> sends (regular or private)
<per-send> Sepolia ETH max each · <total> Sepolia ETH total
<duration or expiry in friendly words>

This changes the guardrails—not where funds live.
Reply ✅ or say yes to approve.
```

This is not a receipt. Do not use a success mark or say updated, applied, or
successful before a later result proves it. If a main balance was discussed,
add `Your main balance will not move into the private pocket.`

A private-balance preview must name the child and say it changes only that
child. Parent and sibling policies remain unchanged. Copy its returned block
exactly; do not merge it with a wallet-wide preview.

End the turn immediately after the preview. Do not search, describe, or invoke
another Agent Boost tool. The next user reply belongs to
`agent-boost-confirm`; do not load that skill in the preview turn.

The default is 10 sends shared by regular and private transfers, up to 1
Sepolia ETH each and 10 Sepolia ETH total for seven days. Adjustable testnet
bounds come only from the tool. Never call them mainnet support or recommend
raising them without a user request.

## Safety and verification

Agent Boost is Sepolia-only and for valueless test assets. Never request or
expose a seed, key, password, decision ID, or signing material. The sidecar owns
decimal conversion, hard ceilings, counters, expiry, durable cancellation, and
policy binding.

A plan is only a preview. This skill is complete when the preview is shown as
the final response and no later tool call occurs in that assistant turn.
