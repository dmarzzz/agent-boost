# Architecture

Agent Boost is a local, wallet-first sidecar between Hermes and Kohaku. It owns
the agent-facing contract, durable workflow state, delegated-spend policy,
onboarding UI, and redacted results. Kohaku owns wallet derivation, encrypted
seed storage, Tornado proving, signing, and broadcast.

## Components

| Component | Responsibility |
| --- | --- |
| Hermes | Conversation, exact readback, verbal confirmation, MCP orchestration |
| Agent Boost MCP server | Schemas, policy, state, idempotency, UI lifecycle |
| Onboarding UI | Read-only loopback QR, address, funding and shield progress |
| Kohaku adapter | Wallet operations through fixed, non-shell argv |
| Tor RPC route | Embedded Arti client, fixed HTTPS origin, remote DNS, no direct fallback |
| Loopback RPC relay | Random-path JSON-RPC bridge from Kohaku to the Tor route |
| Sepolia RPC client | Tor-routed chain assertion and live public balance reads |
| State store | Atomic durable setup, plan, request, delegation, wallet-profile, and archive records |

The first release contains no general agent egress or operator approval
dashboard. Its proxy is narrowly limited to the configured Sepolia RPC origin.

## Local surfaces

- MCP: stdio only;
- onboarding page: `127.0.0.1:9183` by default;
- runtime ownership lock: exclusive `127.0.0.1:9184` bind;
- authenticated fixed-origin RPC relay: `127.0.0.1:9185` by default;
- state: `~/.local/share/agent-boost` by default.

The UI server rejects non-loopback Host headers, cross-site browser requests,
methods other than GET/HEAD, and framing. It uses no remote assets and returns
only an explicit public snapshot.

## Onboarding state machine

```text
not_started
  → creating_wallet
  → preparing_privacy
  → awaiting_funding
  → funding_pending
  → funded_public
  → shielding
  → private_ready

any active phase → failed
```

The wallet and fresh funding address are created before the QR appears.
Proving-artifact preparation continues while the user funds. The watcher polls
the exact address until the configured target arrives, persists `shielding`
before invoking Kohaku, and waits for the private spendable balance rather than
assuming a returned hash means readiness.

On restart:

- wallet creation and privacy preparation resume;
- funding states resume address polling;
- `shielding` resumes private-balance polling without automatically sending a
  duplicate shield.

This favors avoiding duplicate side effects. A crash after persisting
`shielding` but before Kohaku receives the command may require operator
diagnosis rather than an automatic retry.

## Payment flow

```text
wallet_get_context
  → live funding-address + aggregate public + private spendable balances
  → wallet_plan_private_payment(recipient, amount)
  → verbal confirmation of immutable plan
  → wallet_execute_private_payment(decision_id, stable client ID)
  → Kohaku unshield --next + exact value tail call
  → submitted
  → transaction receipt or recipient balance delta verified
  → confirmed
```

The plan checks balance and policy but creates no side effect. Immediately
before signing, execution asserts Sepolia again, refreshes the spendable
private balance, and rechecks the kill switch, delegation chain, expiry,
per-payment limit, lifetime limit, and one-payment rule. It then writes an
`executing` request and consumes the allowance before invoking Kohaku. This
The recipient's pre-execution balance is stored in that same durable request
before the adapter call. This prevents a crash or error from making a possibly
submitted payment look safely repeatable and makes later read-only
reconciliation possible. UserOperation and transaction hashes are separate
fields; only a true transaction hash is queried as a transaction receipt.

Kohaku's Tornado path withdraws the configured `0.1` ETH note to the next
wallet-controlled EIP-7702 account. The recipient payment is an exact tail call;
the paymaster fee and remaining change are separate from the recipient amount.

## Live balance semantics

The initial funding address and Kohaku wallet total are different concepts after
shielding or unshielding. Agent Boost reports both:

- `funding_address_eth_atomic`: live balance at the address shown in the QR;
- `public_wallet_total_atomic`: aggregate ETH across Kohaku public accounts;
- `private_payment_spendable_atomic`: spendable Tornado ETH.

Payment planning refreshes the private value again, so Hermes cannot authorize
from a remembered or merely total balance.

## Filesystem and subprocess behavior

- directories are created or corrected to `0700`;
- state, wallet, secret, and provenance files are corrected to `0600`;
- state writes flush a unique temporary file, atomically rename it, and flush
  the containing directory;
- the password is generated locally and passed to Kohaku by file path;
- Kohaku invocations use argv arrays with `shell: false`;
- the RPC URL is supplied through the child environment rather than argv;
- Kohaku receives only the random authenticated loopback relay URL, never the
  upstream provider URL;
- inherited proxy variables and `KOHAKU_WITHOUT_TOR` are removed;
- a child-process fetch guard permits loopback only and blocks Kohaku's built-in
  public RPC fallback candidates;
- the random relay token is redacted from Kohaku's traffic log after each call;
- a process-shared loopback lock prevents concurrent wallet runtimes;
- output and execution time are bounded;
- operations are serialized by Kohaku data directory, including wallet-profile
  changes.

A confirmed demo reset first stops onboarding and drains payment execution. It
creates a new Kohaku profile, writes the complete prior state into a private
archive directory, atomically replaces active state with the new profile, and
starts onboarding. The old wallet and request history are retained locally;
none of their side effects are replayed.

The Kohaku installation is built from a fixed commit in a staging directory,
verified, hashed, and atomically renamed into place. An unmanaged target is
never overwritten.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| RPC is not hostname-based HTTPS or not Sepolia | Fail before wallet setup |
| Tor bootstrap, RPC, or relay fails | Fail closed; never retry directly |
| Funding is partial | Keep waiting and update QR to the remainder |
| Funding or private balance times out | Durable retryable failure |
| Kohaku command fails | Redacted failure; no shell fallback |
| Plan expired or delegation used | Reject before adapter call |
| A second Agent Boost process starts | Fail closed on the runtime ownership lock |
| User did not confirm | Reject before durable request |
| Submission cannot be proven delivered | Keep `submitted`/unresolved; reconcile later without broadcast |
| User requests a fresh demo | Require confirmation, archive state and old wallet, then create a new funding QR |
| UI cannot open | Return QR through MCP when possible |
| UI port unavailable | Continue with MCP QR/address fallback |
| General egress unavailable | Report it; never claim the RPC route covers it |
