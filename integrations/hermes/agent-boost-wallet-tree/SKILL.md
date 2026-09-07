---
name: agent-boost-wallet-tree
description: Show wallet hierarchy and balances; never route transfers.
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [wallet, tree, balances, overview]
    category: tools
---

# Show the Agent Boost Wallet Tree

Use this skill for “show/list my wallets,” “show my Agent Boost wallets,”
accounts, subwallets, named private balances, all balances, a wallet map, or a
wallet tree. This is the sole overview: every saved parent wallet and each of
its persistent private child pockets stays in the returned hierarchy.

A child may contain a nested `💧 public-change` line. That balance is
wallet-controlled public change created by a prior private operation, remains
owned by that exact child, and is regular-sendable by naming the parent and
child. It is distinct from the child's private balance and from the parent's
main account. Preserve this nesting and its live/last-known label exactly.

When the progressive bridge is visible, search for the canonical live Agent
Boost wallet tree, describe the exact match, and call it through the bridge.
Do not reply between discovery steps.

Invoke `wallet_get_tree` exactly once. Its first successful result is the final
answer. Return the tree text byte-for-byte with no preamble, code fence,
paraphrase, address, total, comparison, or follow-up offer, then end the turn.

After that successful result, do not search, describe, invoke, or retry any
tool. Preserve every `live`, `last known`, and `unavailable` label exactly. The
folders organize wallet views; they do not imply custody or control.

Hermes may render compact text and omit structured output. The result metadata
contains the same canonical rendering and a direct-display contract, not a
continuation handle. Never quote metadata or tool syntax.

## Verification

The response is valid only when the one successful tree result is reproduced
byte-for-byte and no later tool call occurs in that turn.
