# Threat model

Agent Boost is an unaudited Sepolia demonstration. Its goal is to reduce secret
exposure in an agent tool interface and constrain one testnet payment—not to
provide a production custody boundary or guaranteed anonymity.

## Protected data

- Kohaku seed and derived private keys;
- local wallet password;
- raw Tornado notes and proof material;
- credential-bearing RPC URLs;
- arbitrary signing authority;
- durable request/idempotency state.

Public Sepolia addresses, balances, transaction references, setup progress, and
delegation limits are intentionally visible to Hermes. They are inputs to
correct decision-making, not secrets.

## Security goals

1. Agent Boost tools never return a seed, key, password, note, proof, or raw
   signed transaction.
2. Wallet commands are a fixed allowlist with validated fields and no shell.
3. Mainnet and non-Sepolia RPC endpoints are rejected.
4. Payment terms cannot change between plan and execution.
5. A payment requires an exact in-chat preview followed by a new explicit user
   confirmation, and stays within a one-use, expiring amount delegation.
6. Stable client IDs prevent ordinary retries from double-executing.
7. Uncertain side effects fail safe and do not restore payment authority.
8. The onboarding UI is local, read-only, and exposes only the public funding
   projection.
9. Files and directories use private local permissions.
10. Only one Agent Boost process can own the local wallet runtime at a time.
11. All Agent Boost and Kohaku Ethereum JSON-RPC uses the fixed Tor route with
    remote hostname resolution and no direct fallback.
12. Restart/status reconciliation can only observe receipts or balances; it
    cannot rebroadcast an unresolved request.
13. A Hermes fallback model cannot satisfy its own chat confirmation: the turn
    gate requires exact provenance from a preview in an earlier user turn and
    consumes it once.
14. Shared-session review/task forks cannot authenticate, consume, or render a
    root conversation's pending continuation.

## Important non-goals

### Same-user isolation

Hermes and Agent Boost normally run under the same OS account in this POC. A
Hermes agent with unrestricted terminal and filesystem access could read the
encrypted Kohaku wallet and the local password file, or inspect another
same-user process. MCP omission and skill instructions do not prevent this.

Do not use this build as protection against a malicious or fully privileged
local agent. A real-value design needs a separate service identity,
hardware-backed signer, or cryptographic authorization unavailable to the agent.

### Guaranteed anonymity

Sepolia funding is public. Shielding removes the direct deposit/withdrawal link,
but amount, timing, protocol usage, a small anonymity set, the funder, the
recipient, RPC observation, and cross-session behavior can enable correlation.
The recipient is public after payment.

Agent Boost routes its own and Kohaku's Ethereum JSON-RPC through embedded Tor.
Kohaku separately routes supported non-RPC privacy traffic through its own Tor
client. An enrolled `egress_fetch` can send one bounded public HTTPS read
through Shade Tree, but this is not anonymous general egress: Hermes,
Matrix/model traffic, the funding transaction, on-chain actions, and other
process traffic remain outside that request. The Shade Tree node observes the
target hostname/port and traffic metadata, and a global observer may correlate
timing despite Tor.

### Real-value safety

The wallet stack has not been audited. There is no seed export, whole-wallet
sweep, hardware signer,
multi-party approval, production fee policy, chain reorganization handling, or
formal verification. The event boundary is disposable, valueless Sepolia ETH.

## Attacks and mitigations

| Attack or failure | Current mitigation | Residual risk |
| --- | --- | --- |
| Prompt asks for mainnet payment | Hard-coded Sepolia client and capability | Same-user shell could bypass Agent Boost entirely |
| Prompt changes recipient after approval | Decision binds exact recipient/amount | User may verbally confirm misleading text |
| Hermes or the MCP host falsely reports approval | Exact plan binding, `user_confirmed` gate, and bounded delegation | Chat confirmation is host-attested, not independent speaker authentication |
| Faulty model rebinds a recoverable wallet lifecycle approval to another action or friendly name | Typed preview metadata plus the Hermes turn gate binds the exact tool/name/selection epoch across user turns and consumes it once; lifecycle changes grant no signing authority | The hook is host-local enforcement, not independent speaker authentication; a malicious same-user process can bypass it |
| Tool retry duplicates payment | Stable client ID plus atomic one-request-per-decision enforcement | Failures before any durable request exists remain retryable |
| Weak model answers “check again” from stale chat state or chooses a mutation | Trusted unresolved results publish a private expiring status handle; the turn gate and native adapter pin one exact getter and arguments, with no setup or execution fallback | A status handle expires and then requires a new explicit operation-specific read request |
| Shell injection through recipient/path | Address/path validation and `shell: false` | Vulnerabilities in Node or Kohaku remain |
| Secret appears in MCP output | Explicit public projections, stable adapter errors, URL/path redaction, and no raw upstream stderr | Same-user process inspection remains possible |
| Concurrent MCP processes race signing | Exclusive loopback runtime-ownership lock | A local denial of service can occupy the lock port |
| QR is framed or fetched remotely | Loopback bind, host/origin checks, CSP, no-store | Other same-user local processes can connect |
| Shield is duplicated after restart | Persist `shielding`, then poll private balance | Crash before adapter receives command can stall setup |
| UserOperation hash is mistaken for a transaction | Distinct durable fields; only explicit transaction hashes enter receipt lookup | Upstream adapter output changes could require parser updates |
| Hash is mistaken for delivery | Only a successful exact transaction/UserOperation receipt bound to the durable request and expected sender confirms a journaled broadcast | RPC receipt integrity and chain reorganization handling remain external assumptions |
| Demo reset loses an unresolved request | Explicit confirmation plus complete private state archive; old Kohaku wallet retained | Same-user deletion or disk loss can still destroy the archive |
| RPC observer correlates activity | HTTPS through Tor, remote DNS, fixed-origin fail-closed relay | Provider no longer sees the machine IP, but still sees exit IP, methods, addresses, payloads, and timing |
| Local process abuses RPC relay | Loopback bind, random 256-bit path, exact Host/path, required-method allowlist, size/concurrency limits, post-call traffic-log redaction | Same-UID process/env inspection is not a custody boundary |
| Tor becomes unavailable | No global-fetch/direct retry; route becomes failed | Operations stop; an ambiguous broadcast remains unresolved |
| Covered fetch targets local infrastructure | URL policy rejects IP literals/local names; Shade Tree nodes validate all DNS answers against private/reserved ranges | A future node-policy regression or DNS attack remains an upstream risk |
| Covered response prompt-injects Hermes | Response is labeled `untrusted_external`; Hermes skill treats it as data | Model instruction hierarchy is not an OS sandbox |
| Shade Tree member slot is reused | Forward-only crash-safe cursor is burned before proof; corrupt/locked/rollback state fails closed | Deleting/restoring state outside Agent Boost can create slashable reuse |
| Shade Tree or Grove is unavailable | Explicit fetch returns degraded/failed/exhausted and has no direct fallback | The requested read is unavailable until recovery or epoch advance |
| Dependency supply-chain drift | Commit pin, lockfile install, local hashes | Initial Git/npm fetch still trusts upstream transport/registries |

## Logging and storage

Agent Boost stores public addresses, balances, policy, plan digests, request
state, and public transaction/UserOperation references. It does not intentionally
store model prompts, verbal transcripts, RPC credentials, or raw signed
transactions.

Wallet state and the password file are local and required for unattended demo
operation. Deleting them destroys recovery through Agent Boost. Back them up
only if you understand that doing so preserves a disposable test wallet; never
reuse them for real value.

## Release boundary

The POC may be demonstrated only when:

- `agent-boost doctor` confirms Node, pinned Kohaku, a Tor-observed exit, and
  Sepolia RPC through Tor;
- tests and build pass;
- the operator funds only the QR's Sepolia address;
- the user hears the privacy and valueless-funds limitations;
- payment is at or below the configured maximum;
- the exact recipient and amount receive verbal confirmation;
- no claim of guaranteed anonymity, general private egress, or production
  custody is made.

The recipient and amount are resolved from the decision rather than accepted
again. Execution reasserts Sepolia and refreshes private balance, then
atomically consumes one send and its lifetime amount allowance before calling
Kohaku.
This is fail-safe: an adapter failure or uncertain submission does not restore
authority for an automatic retry.

Wallet policy changes are also plan-bound and confirmation-gated. They cannot
erase historical spend or send attempts, exceed absolute Sepolia testnet
ceilings, enable mainnet, alter a recipient, or move balances between accounts.
