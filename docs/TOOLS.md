# Tools

Agent Boost is an MCP server. Hermes calls its user-facing tools over stdio.
Every result is a structured envelope carrying an outcome (`ready`, `blocked`,
`awaiting_funding`, `executing`, `submitted`, `confirmed`, `failed`, or
`indeterminate`), retry advice, and public facts only. No result is a bearer
token: every limit is enforced from durable local state, not from what the
agent was told.

## Private payment and identity

How a payment works, in the order the tools are called:

1. `onboarding_start` creates or resumes one disposable Sepolia wallet, derives
   a fresh public address, opens the loopback funding page with an EIP-681 QR,
   watches for funding, and shields `0.1` ETH through Kohaku on its own.
2. `onboarding_status` long-polls the durable setup by revision through
   `creating_wallet`, `preparing_privacy`, `awaiting_funding`,
   `funding_pending`, `funded_public`, `shielding`, and `private_ready`.
3. `wallet_get_context` refreshes the main account address and its exact
   on-chain balance, delegation state, and live Tor route status.
4. `wallet_get_tree` renders every available wallet profile as one canonical,
   address-free folder tree with honest balance freshness labels.
5. `wallet_get_policy`, `wallet_plan_policy_update`, and
   `wallet_apply_policy_update` let the user inspect and change send count,
   per-send amount, total amount, expiry, and enabled state in conversation.
   Every update is immutable, five-minute, separately confirmed, bounded, and
   idempotent. It changes authority only; it never moves funds.
6. `wallet_plan_private_payment` validates one recipient and one exact amount
   (a canonical wei string) against readiness, the active count and amount
   limits, and balance, then returns a five-minute immutable plan with a SHA-256
   digest over chain, recipient, asset, amount, and operation. Plans never
   sign, submit, or reserve funds.
7. `wallet_execute_private_payment` takes the decision ID and asks a capable MCP
   client for one native **Approve** or **Cancel** decision. Acceptance atomically
   consumes one send and its amount allowance before Kohaku is called. If the client
   cannot elicit, the tool returns a structured receipt for Hermes to read back
   and accepts `user_confirmed: true` only on the retry. Recipient and amount
   always come from the plan. An uncertain outcome never restores authority for
   an automatic retry.
8. `wallet_get_request` reads the durable, redacted result and reconciles a
   non-terminal request from a real receipt or the recipient-balance checkpoint.
   Reconciliation never rebroadcasts.

`wallet_start_new_demo` archives the current wallet with private permissions
and starts a fresh funding flow. It needs explicit confirmation and returns a
public archive ID and a new QR, never a path or a secret.

| Tool | Input | Returns |
| --- | --- | --- |
| `onboarding_start` | none | setup ID, phase, funding address, QR |
| `onboarding_status` | `setup_id`, `since_revision`, `wait_ms` | latest durable state, or waits for a newer revision |
| `wallet_get_context` | optional `amount_native` affordability comparison | main address and live balance, delegation, route status |
| `wallet_get_tree` | none | address-free profile tree, decimal balances, freshness labels |
| `wallet_get_policy` | none | active send count, amount limits, use, expiry, enabled state |
| `wallet_plan_policy_update` | any of `max_payments`, `per_payment_limit_native`, `lifetime_limit_native`, `expires_in_hours`, `enabled` | `wpd_` preview with current and proposed policies |
| `wallet_apply_policy_update` | `user_confirmed`; optional exact `decision_id` | idempotent receipt for the latest or named policy preview |
| `wallet_plan_private_payment` | `recipient`, `amount_native` in ordinary Sepolia ETH | `wd_` decision, digest, expiry, whether confirmation is required |
| `wallet_execute_private_payment` | `decision_id`, `client_request_id`, optional `user_confirmed` fallback | native confirmation, cancellation, fallback receipt, or a `req_` request in `executing` or later |
| `wallet_get_request` | `request_id` | one redacted request state |
| `wallet_start_new_demo` | `user_confirmed` | archive ID, new setup, new QR |

## Anonymous egress

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

`capabilities` takes no input and returns `org.agentboost.wallet/1.5`: chain and
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
