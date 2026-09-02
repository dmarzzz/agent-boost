# Tools

Agent Boost is an MCP server. Hermes calls the eleven tools below over stdio.
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
3. `wallet_get_context` refreshes the address, funding balance, aggregate
   public ETH, private spendable ETH, delegation limit and expiry, and the live
   Tor route status.
4. `wallet_plan_private_payment` validates one recipient and one exact amount
   (a canonical wei string) against readiness, delegation, the one-payment
   rule, and balance, then returns a five-minute immutable plan with a SHA-256
   digest over chain, recipient, asset, amount, and operation. Plans never
   sign, submit, or reserve funds.
5. `wallet_execute_private_payment` takes the decision ID and the user's
   confirmation, atomically consumes the one-payment delegation, and only then
   calls Kohaku. Recipient and amount come from the plan, never from the call.
   An uncertain outcome never restores authority for an automatic retry.
6. `wallet_get_request` reads the durable, redacted result and reconciles a
   non-terminal request from a real receipt or the recipient-balance checkpoint.
   Reconciliation never rebroadcasts.

`wallet_start_new_demo` archives the current wallet with private permissions
and starts a fresh funding flow. It needs explicit confirmation and returns a
public archive ID and a new QR, never a path or a secret.

| Tool | Input | Returns |
| --- | --- | --- |
| `onboarding_start` | none | setup ID, phase, funding address, QR |
| `onboarding_status` | `setup_id`, `since_revision`, `wait_ms` | latest durable state, or waits for a newer revision |
| `wallet_get_context` | none | address, balances, delegation, route status |
| `wallet_plan_private_payment` | `recipient`, `amount_atomic` | `wd_` decision, digest, expiry, whether confirmation is required |
| `wallet_execute_private_payment` | `decision_id`, `user_confirmed` | `req_` request in `executing` or later |
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

`capabilities` takes no input and returns `org.agentboost.wallet/1.3`: chain and
asset IDs, funding target, amount caps, the effective execution policy, live
readiness, and `guarantees_anonymity: false`. It grants nothing. The same
document is available as the resource `agent-boost://capabilities/wallet/v1`.

## What the agent gets, and what stays behind

| Hermes can read | Not returned through Agent Boost tools |
| --- | --- |
| Sepolia address and chain ID | Seed phrase and private keys |
| Live funding-address balance | Kohaku wallet password |
| Live aggregate public-wallet ETH | Raw Tornado notes and proofs |
| Live private-payment spendable ETH | Raw signed transactions |
| Delegation limits, expiry, and use | RPC URL and local filesystem paths |
| Plan, request, and confirmation state | Arbitrary Kohaku command execution |
