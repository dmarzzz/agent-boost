---
name: agent-boost
description: Fallback router for ambiguous Agent Boost wallet requests.
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [wallet, privacy, payments, routing]
    category: tools
---

# Route Agent Boost

This is Agent Boost's lightweight entry point. Load exactly one specialist for
the user's current intent.

## Choose the specialist

Wallet-management intent takes precedence over plural wording. Requests to
load, switch, adopt, select, archive, or authorize belong to
`agent-boost-wallets`. Use the tree specialist only for an overview, map,
hierarchy, accounts, or balances without a management action.

Transfer intent takes precedence over every adjective inside a wallet name.
If the user explicitly says regular, private, or recovery transfer, load
`agent-boost-transfers` immediately. In “regular transfer … to my new private
wallet,” **regular** is the route and **new private wallet** is a saved-profile
destination; do not create a wallet, choose a private payment, inspect the tree,
or read policy first.

A regular/public send from `<parent>/<pocket>` belongs to
`agent-boost-transfers`: the child selects public change. With no parent named,
use the selected wallet.
Never infer a child from “private” in a top-level wallet name.
“Fund wallet beta with 0.35 ETH from wallet alpha” also belongs to transfers;
explicit wallet wrappers mean a regular main-to-main send. Bare child names or
an explicit private-balance/pocket cue belong to child funding instead.

- Load `agent-boost-setup` for install, setup, initial funding, setup status,
  or a clearly requested fresh demo wallet.
- Load `agent-boost-wallet-tree` to show wallets, child private balances,
  all balances, a hierarchy, map, or tree.
- Load `agent-boost-wallets` to load, switch, create, adopt, select, archive, or
  inspect a saved wallet; create or fund a named child private balance; or read
  a current main-account balance.
  The exact request “Load agent-boost.” is a saved-wallet request.
- Load `agent-boost-policy` to inspect or change wallet-wide or named
  private-balance limits, expiry, or enabled state.
- Load `agent-boost-transfers` to start a regular, private, or exact recovery
  transfer. This skill creates the preview and then stops.
- Load `agent-boost-wallet-actions` only for a later reply to a wallet switch,
  create, adopt, archive, or fresh-demo preview.
- Load `agent-boost-authorize` only for a later reply to a wallet-authorization
  preview.
- Load `agent-boost-confirm` only for a later reply to a transfer, policy,
  private-balance creation, or private-balance funding preview.
- Load `agent-boost-covered-web` for a public HTTPS read through covered
  egress.

Use `skill_view` with the exact specialist name before calling an Agent Boost
tool. Do not load unrelated specialists. If one request genuinely spans two
intents, finish the first safe boundary before loading the second.

A confirmation-only message belongs to the specialist for the immediately
preceding preview. A bare yes never authorizes a different or newly planned
action.

## Tool availability

Agent Boost may appear behind Hermes's progressive tool bridge. If search
reports its source, follow the specialist's discovery choreography; do not
claim the integration is unavailable.

If Agent Boost is absent from search, ask for one refresh: `/reload-skills`
then `/reload-mcp` locally, or `!reload-skills` then `!reload-mcp` over Matrix.
A single Hermes restart is the alternative. Do not edit configuration or ask
the user to run internal wallet commands.

## Boundaries

Agent Boost is Sepolia-only and for valueless test assets. The sidecar owns
balances, conversion, limits, durable decisions, idempotency, signing, and
status. Never request or expose a seed, private key, password, decision ID,
request ID, or signing material.
