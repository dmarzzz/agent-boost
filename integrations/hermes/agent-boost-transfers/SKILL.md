---
name: agent-boost-transfers
description: Handle explicit regular, private, or recovery transfers.
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [wallet, payments, transfers, recovery]
    category: tools
---

# Preview Agent Boost Transfers

Create a regular-public, private-payment, or exact-recovery preview. Never
execute it or substitute routes.

## Hermes tool discovery

When the progressive bridge is visible, search for one exact canonical preview
name, describe that match, then invoke it through `tool_call`. Never put wallet
adjectives into the query or search for prerequisites. Do not reply between
those steps or call a catalog-listed name directly.

Preserve exact decision state; never quote metadata, identifiers, or tool names.
If search reports Agent Boost, continue.

## Resolve intent before tools

- “Regular,” “public,” “non-private,” or “from main” means the regular route.
- An unqualified “transfer” from a named wallet, profile, or main account also
  means the regular route.
- “Fund wallet beta with 0.35 ETH from wallet alpha” is a regular public
  transfer from alpha's main account to beta's main/public receiving account.
  The explicit wallet wrappers distinguish it from funding a child pocket.
- A regular/public transfer explicitly from `<parent>/<pocket>`, a named
  pocket's public change, or a named private balance under a parent spends that
  pocket's tracked public-change account. It does not spend private notes.
- “Private,” “shielded,” or “from private” means the private route.
- “Recover” or “unshield” an exact amount to a public recipient means recovery;
  it is not a whole-wallet sweep.
- If the user says only “send” and the source is unclear, ask whether they want
  a regular public transfer or a private payment.

A friendly profile name does not change an explicitly stated route. “Private”
alone selects neither private mode nor a child pocket. “Can we transfer 0.1 ETH to my new
private wallet from the agent boost wallet?” is regular from the parent's main. Pass natural
profile phrases for internal resolution without listing wallets or addresses.

Require one exact Sepolia ETH amount and destination before any transfer tool,
including `capabilities`. The destination may be an address or saved-wallet
name. If either is missing, ask only for that detail and preserve what is known.
Never invent an amount from “small,” ask for atomic units, or make the user
repeat a known value.

For every transfer mode, put the address or saved-wallet name in the required `destination` field;
Agent Boost resolves names to main/public receiving accounts. Never ask the user for a saved
wallet's address, substitute its private pocket, or reveal the resolved address
unless requested. Put an explicitly named source wallet in the
required `source` field. For a regular transfer funded by a
named pocket's tracked public change, `source_private_balance` is the exact
child name. Use its parent wallet as `source` when the user named it; when only
the child or its public change was named, use the reserved literal `$selected`.
Omit the optional pocket field (or use `$main`) for the parent's main account.
Never infer a child merely because a wallet name contains “private,” and never
guess a parent. These fields are tool inputs.

Pass fractional amounts as unchanged decimal strings in `amount_native`. Safe
whole numbers such as `66` may be JSON numbers. Never convert amounts to wei or
use fractional JSON numbers.

## Regular public transfer preview

Call `wallet_preview_regular_transfer` directly with required `source`,
`destination`, `amount_native`, and the optional pocket field only as defined
above. The planner resolves names, refreshes the chosen public account, reserves
gas, and checks parent and pocket limits. Do not add a preliminary read.

For an allowed confirm plan, show exactly:

```text
**Confirm regular testnet transfer**
**Amount:** <amount> Sepolia ETH
**To:** <full address OR friendly name — main/public receiving account>
**From:** <parent> main public account OR <parent>/<pocket> public change
**Network:** Sepolia testnet · no monetary value
**Privacy:** Public on-chain transfer
**Next:** Reply ✅ to approve or ✕ to cancel.
```

## Private payment preview

Call `wallet_preview_private_transfer` with required `source`, `destination`,
and `amount_native`. It validates private spendability. Do not add
`capabilities`, balance, or saved-wallet reads unless a returned blocker requires
fresh diagnosis. A positive main balance never proves private spendability.

If the result is `USE_RECOVERY_TRANSFER`, the named destination is the active
source wallet's own main account. Preserve its exact amount and friendly name,
create an exact recovery preview in this same turn, and present only that
recovery preview. A regular transfer to the same source main is blocked instead;
do not change its route.

For an allowed confirm plan, show exactly:

```text
**Confirm private test payment**
**Amount:** <amount> Sepolia ETH
**To:** <full address OR friendly name — main/public receiving account>
**Network:** Sepolia testnet · no monetary value
**Visibility:** On-chain activity remains visible
**Next:** Reply ✅ to approve or ✕ to cancel.
```

## Exact recovery preview

Call `wallet_preview_recovery_transfer` with required `source`, `destination`,
and unchanged `amount_native`. Recovery to the source wallet's own main is
valid. Use the plan's accounting
fields; never describe only the recipient amount as leaving the private balance.
One full private denomination is consumed, while the exact recipient amount and
the wallet-controlled remainder before fees become public. Fee reserve is a
minimum inside that public remainder. Label the post-recovery private balance as
an estimate.

For an allowed confirm plan, show exactly:

```text
**Confirm recovery transfer**
**Private denomination consumed:** <denomination> Sepolia ETH
**Recipient receives publicly:** <amount> Sepolia ETH
**To:** <full address OR friendly name — main/public receiving account>
**Public remainder before fees:** <denomination minus recipient amount> Sepolia ETH
**Minimum fee reserve:** <fee reserve> Sepolia ETH
**Estimated private balance after:** <remaining private balance> Sepolia ETH
**Network:** Sepolia testnet · no monetary value
**Next:** Reply ✅ to approve or ✕ to cancel.
```

## Named source needs a switch

If any planner returns `REGULAR_TRANSFER_SOURCE_SWITCH_REQUIRED`,
`PRIVATE_PAYMENT_SOURCE_SWITCH_REQUIRED`, or
`RECOVERY_TRANSFER_SOURCE_SWITCH_REQUIRED`, its typed result is the complete
source-switch preview. Preserve the returned transfer mode, `amount_native`,
canonical source name, and exactly one of `recipient` or
`recipient_wallet_name`. Also preserve `source_private_balance` when present;
never drop or replace it after the switch or reauthorization. Show the returned
friendly source and destination and end with a distinct switch confirmation:

```text
**Confirm source-wallet switch**
**From:** <friendly source name>[ / <private-balance name> public change]
**Transfer kept:** <mode> · <amount> Sepolia ETH to <address OR friendly name — main/public receiving account>
Switching archives the workflow. Valid authorization remains.
Missing, expired, disabled, or exhausted grants need reauthorization. Nothing sent.
**Next:** Reply ✅ to switch or ✕ to cancel.
```

This is a hard turn boundary. Do not call a saved-wallet inventory, switch,
authorization, or transfer tool again in this assistant turn. The later reply
belongs to `agent-boost-wallet-actions`. After an approved switch, that skill
completes any separately confirmed authorization, then recreates this exact
transfer preview without asking for known details. Switch, authorization, and
send remain three distinct confirmations.

## Stop after planning

Branch only on the returned decision and blockers. Under `deny`, report the
blocker without an approval prompt. Under `allow`, load `agent-boost-confirm`
after the plan and let it execute that exact decision immediately without
asking the user; the local policy already authorized it.

For a `confirm` preview, make it the final response and end the turn. Do not
search, describe, or invoke another Agent Boost tool. The next user reply
belongs to `agent-boost-confirm`; do not load that skill in the preview turn. A
changed amount, recipient, or mode requires a new preview.

Keep responses compact. Hide wei, IDs, raw phases, protocol detail, and tool
syntax. Never request or expose keys, passwords, seeds, or signing material.
Agent Boost is Sepolia-only and for valueless test assets.

## Verification

For a `confirm` decision, one preview is final and no execution occurs.
For `allow` with `userConfirmationRequired: false`, `agent-boost-confirm` executes
the exact plan and reports status in the same assistant turn.
