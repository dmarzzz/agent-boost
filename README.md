![Agent Boost — a local agent core and its dark sidecar](assets/agent-boost-hero.png)

# Agent Boost

**Dark mode for your agent.**

Agent Boost is a local, wallet-first privacy sidecar for AI agents. This proof
of concept gives a Hermes agent the public wallet facts it needs to reason—its
Sepolia address, live balances, setup state, and remaining allowance—while
keeping seed phrases, private keys, wallet passwords, and raw privacy notes out
of MCP results and the model conversation. Its Sepolia JSON-RPC path is routed
through embedded Tor for both Agent Boost and Kohaku, with no direct fallback.

The current build demonstrates one complete wallet path and adds a separately
enrolled covered-egress module:

1. Hermes asks Agent Boost to create a disposable Sepolia wallet.
2. Agent Boost bootstraps Tor, verifies Sepolia through it, and opens a local
   funding page with an exact QR code and address.
3. An event operator sends approximately `0.2` valueless Sepolia ETH.
4. Agent Boost automatically shields `0.1` Sepolia ETH through Kohaku.
5. The user asks Hermes to send one shielded test payment.
6. Hermes reads the live balance, plans the exact transfer, reads the terms
   back, and waits for verbal confirmation.
7. Agent Boost signs and submits within a Sepolia-only, one-payment delegation.

When a Grove operator has enrolled the installation, Hermes can also make an
explicit public HTTPS GET or HEAD request through Shade Tree. That path is
independent of wallet RPC: it uses an authenticated loopback Proxy, embedded
Arti, and a fresh RLN proof per CONNECT tunnel. It never falls back to a direct
connection and never blanket-routes Hermes or its model/Matrix traffic.

No terminal is needed after the one-time installation. On a graphical local
machine, the funding page opens in the browser. On a headless host, Agent Boost
returns the QR image through MCP so Hermes can present it in chat.

> [!WARNING]
> Agent Boost, Kohaku, and the embedded `tor-js` client are unaudited research software. This release is
> Sepolia-only and intended for disposable test funds. Sepolia ETH has no
> monetary or redeemable value. Never send mainnet assets, real value, or a
> wallet you care about.

## Install

Supported hosts:

- macOS on Apple silicon;
- macOS on Intel;
- Ubuntu 24.04 on ARM64.

Every change runs the same clean-tarball install smoke on native GitHub runners
for Ubuntu 24.04 ARM64, macOS ARM64, and macOS Intel. The smoke installs into an
empty prefix, starts the packaged executable, loads runtime configuration,
checks both Hermes skills, and rejects private planning material in the package.

Prerequisites are Git, Node.js 22 or newer, npm, and a working Hermes install.
No system Tor installation is required; the POC embeds Arti through `tor-js`.
The installer builds the repository, installs Agent Boost under `~/.local`,
fetches and verifies the pinned Kohaku commit, installs the checksummed Shade
Tree v0.4.0 live client where upstream publishes one, and configures the active
Hermes profile without replacing a conflicting MCP entry. Covered egress is
currently supported on Ubuntu ARM64 and macOS Apple silicon. The wallet remains
supported on macOS Intel, but Shade Tree v0.4.0 has no Intel live binary; the
installer reports that limitation instead of substituting an unproved route.

```console
git clone https://github.com/dmarzzz/agent-boost.git
cd agent-boost
make install
```

The default executables and state paths are:

```text
~/.local/bin/agent-boost
~/.local/share/agent-boost/dependencies/kohaku-cli/
~/.local/share/agent-boost/dependencies/shade-tree/
~/.local/share/agent-boost/state.json
~/.local/share/agent-boost/kohaku/
~/.local/share/agent-boost/tor/
~/.local/share/agent-boost/secrets/kohaku-password
~/.local/share/agent-boost/shade-tree/profile/
~/.local/share/agent-boost/shade-tree/slots/
```

If the installer says `~/.local/bin` is not on `PATH`, add it before continuing.
The installer prints the exact conversational handoff. Restart Hermes once,
then tell it:

> Set up Agent Boost for me.

Hermes creates the wallet, presents the exact address and QR, and asks you to
reply with ✅ or say `sent` after sending the displayed Sepolia ETH. No terminal
or MCP command is needed after installation.

To run an optional host diagnostic before the demo:

```console
agent-boost doctor
```

If Hermes was not available during installation, configure it later with:

```console
agent-boost install-hermes
```

In an already-running Hermes conversation, the no-restart alternative is
`/reload-skills` followed by `/reload-mcp` locally, or `!reload-skills`
followed by `!reload-mcp` over Matrix.

The installer pins Kohaku to commit
[`fcf9defa4d5ff7f63222f1b3bbe2d30e631ceffd`](https://github.com/kassandraoftroy/kohaku-cli/commit/fcf9defa4d5ff7f63222f1b3bbe2d30e631ceffd)
and records local SHA-256 provenance for its lockfile, launcher, and compiled
bundle. A managed installation is reused only when its pin and hashes still
match.

Shade Tree is pinned to release
[`v0.4.0`](https://github.com/dmarzzz/shade-tree-node/releases/tag/v0.4.0)
at commit
[`db074e4e75daf87b50fd52bda5378c9d04ce6c4d`](https://github.com/dmarzzz/shade-tree-node/commit/db074e4e75daf87b50fd52bda5378c9d04ce6c4d).
Agent Boost verifies the platform SHA-256 during installation and again before
launch. The binary alone does not grant Grove access: an operator must admit a
locally generated identity and provision the exact matching member set and
trust-pinned discovery values. Until then Hermes reports `needs_enrollment`;
wallet setup and payments continue to work.

The Kohaku runtime is currently large: roughly 0.8 GiB after production
pruning, before proving artifacts. Its pinned production dependency tree also
reports 44 known npm advisories (38 moderate and 6 high) as of this release
candidate. That unresolved upstream risk is another reason this build is
strictly disposable-testnet software.

## Run the demo

### 1. Set up the wallet

Tell Hermes:

> Set up Agent Boost for me.

Hermes calls `onboarding_start`. Agent Boost creates or resumes one durable
Sepolia setup and opens the funding page. The page shows an EIP-681 QR code for
the exact remaining amount, the full address, public funding progress, and
private-balance progress. When Hermes needs to carry the QR into the
conversation, Agent Boost returns it in a branded dark-sidecar card while
preserving a conventional high-contrast scan field.

Scan the QR and send the amount shown—normally `0.2` Sepolia ETH. Then reply
with ✅ or tell Hermes you sent it. Partial funding is supported: the funding
page and a resumed QR automatically use the remaining amount. Do not send ETH
on mainnet or another network.

After your acknowledgement, Hermes uses bounded status checks without flooding
or holding the conversation in an open-ended loop:

```text
creating_wallet
  → preparing_privacy
  → awaiting_funding
  → funding_pending
  → funded_public
  → shielding
  → private_ready
```

When `private_ready` appears, at least `0.1` Sepolia ETH is spendable through
the configured private-payment path. Hermes also rechecks that
`readiness.rpc_egress` is `ready` before declaring setup complete.

### 2. Send one test payment

Tell Hermes, for example:

> Send 0.02 Sepolia ETH privately to
> 0x2222222222222222222222222222222222222222.

Hermes reads current wallet context and creates a short-lived plan itself. It
shows the exact Sepolia ETH amount, full recipient address, and a short testnet
privacy warning. Under the default security policy, reply ✅, `yes`, or `send
it` to approve. Hermes owns the MCP calls, decision IDs, atomic units, and
idempotency key; the user never types them.

Agent Boost does not listen to the conversation itself. Hermes reports the
user's confirmation with `user_confirmed: true`; this is a conversational demo
control, not independent authentication or an out-of-band approval channel.

After confirmation, Hermes executes the immutable plan with a stable request
ID. The default policy permits:

- Sepolia only (`eip155:11155111`);
- native test ETH only;
- at most `0.05` ETH;
- one payment for the lifetime of the setup;
- execution within seven days of setup;
- no mainnet path.

Agent Boost asks Kohaku to unshield the `0.1` ETH note to a fresh
wallet-controlled account and append the exact recipient transfer as a tail
call. Kohaku waits for UserOperation inclusion. Agent Boost stores a recipient
balance checkpoint before handing execution authority to Kohaku and keeps a
UserOperation hash distinct from an Ethereum transaction hash. It reports
`confirmed` only from Kohaku's explicit confirmation, a successful transaction
receipt, or a sufficient recipient-balance delta. Submitted and interrupted
requests are reconciled on restart and status reads without broadcasting again.
If concrete evidence is unavailable, the durable result remains `submitted` or
`indeterminate` rather than guessing.

The seven-day deadline applies to delegated Agent Boost execution, not to the
wallet, address, or funds. Address and balance reads remain available after it
expires. This POC currently blocks new Agent Boost transfers under an expired
delegation; the planned multi-wallet release requires an explicit
reauthorization and confirmed recovery-transfer path before it ships. Never
interpret expiry as deletion or loss of access to the encrypted wallet.

### Start a fresh demo

Tell Hermes that you want to start a new demo wallet. Hermes summarizes that
the current demo will be archived and asks for ordinary confirmation. After you
approve, `wallet_start_new_demo` drains in-flight work, archives the complete
state under the private local state directory, retains the previous Kohaku
wallet, creates a new wallet profile, and presents a fresh funding QR. An
unresolved prior payment is archived exactly as observed and is never retried.

### Fetch public data through covered egress

After the installation has been admitted to a Shade Tree Grove, tell Hermes,
for example:

> Fetch https://example.com/data.json through covered egress.

Hermes checks `egress_status`, then calls `egress_fetch` itself. Users never
handle a Proxy URL, auth token, identity secret, member set, or terminal
command. The first release permits public DNS names over HTTPS port 443, GET or
HEAD, at most three redirects, UTF-8 text/JSON responses up to 1 MiB, and a
30-second request deadline. It sends no credentials, cookies, request body, or
custom headers. Every redirect is revalidated and every returned body is
marked `untrusted_external` so content cannot become agent instructions.

This is accurately described as privacy-improving covered HTTPS egress, not an
anonymity guarantee. The destination sees a Shade Tree node address. The node
sees the destination hostname, port, timing, lifetime, and traffic volume;
end-to-end TLS hides the path, query, and body from the node. A global observer
may still correlate timing. See [Covered egress](docs/COVERED-EGRESS.md).

### Query a confidential model

Agent Boost can expose an opt-in `private_inference_query` tool backed by the
[Dstack private AI gateway / ACI](https://github.com/Dstack-TEE/private-ai-gateway).
The in-process client verifies the remote TEE, restricts requests to a local
model allowlist, and returns an answer only after its response receipt verifies.
There is no ordinary-provider fallback.

This protects the explicit second inference from infrastructure outside the
verified TEE. It does not make the existing Hermes conversation private:
Hermes's primary model sees normal MCP arguments and the returned answer, and
the route does not hide origin IP or timing. See the
[product requirements](docs/PRIVATE-INFERENCE.md) and
[provider roadmap](docs/PRIVATE-INFERENCE-PROVIDERS.md) for the full boundary,
hosted-versus-self-hosted deployment, and future zkAPI/OpenAnonymity adapters.

### Layered security policy

Agent Boost ships with built-in defaults and merges explicit local overrides
on top:

```text
default:  wallet.read=allow, payment.plan=allow, payment.execute=confirm
override: AGENT_BOOST_PAYMENT_APPROVAL=allow|confirm|deny
effective: reported by the capabilities and payment-plan tools
```

`confirm` is the default. `allow` permits automatic execution only inside the
existing Sepolia delegation; `deny` locks payment execution. No override can
enable mainnet, direct RPC fallback, exceed the per-payment or lifetime caps,
extend an expired delegation, or bypass adapter readiness.

### Conversation evals

The reviewable golden flows in [`evals/ideal-flows.json`](evals/ideal-flows.json)
cover setup and QR funding, ambiguous-amount clarification, natural approval,
confirmed and indeterminate outcomes, and the local `allow`/`deny` overrides.
Run them without a wallet, network call, or model invocation:

```sh
npm run eval
```

The eval runner replays each ideal tool trace through the real MCP server using
an in-memory fake wallet. It checks structured outcomes, compact MCP hints,
maximum visible response length, QR presence, and forbidden leakage such as
tool names, internal IDs, booleans, wei, or signing material. See
[`evals/README.md`](evals/README.md) for the boundary between this deterministic
contract eval and a live Hermes model eval.

Run the same conversations through a real Hermes model and the fake MCP runtime
in a disposable profile:

```sh
npm run eval:live -- --hermes "$(command -v hermes)" --provider <provider> --model <model>
```

This opt-in eval grades visible response length/content and the exact tool trace.
It cannot touch a wallet, Tor, Sepolia, or the user's normal Hermes sessions,
memory, rules, or MCP configuration.

## What Hermes can see

The agent needs state to make decisions, so address and balance visibility is
intentional.

| Hermes can read | Not returned through Agent Boost tools |
| --- | --- |
| Sepolia address and chain ID | Seed phrase and private keys |
| Live funding-address balance | Kohaku wallet password |
| Live aggregate public-wallet ETH | Raw Tornado notes and proofs |
| Live private-payment spendable ETH | Raw signed transactions |
| Delegation limits, expiry, and use | RPC URL and local filesystem paths |
| Plan, request, and confirmation state | Arbitrary Kohaku command execution |

The MCP surface contains eleven native tools:

| Tool | Purpose |
| --- | --- |
| `capabilities` | Contract, live readiness, policy, and privacy limits |
| `onboarding_start` | Create or resume setup and open/present funding UI |
| `onboarding_status` | Long-poll durable setup progress by revision |
| `wallet_get_context` | Refresh address, balances, and delegation state |
| `wallet_start_new_demo` | Confirm, archive, and create a fresh demo wallet |
| `wallet_plan_private_payment` | Validate one exact recipient and wei amount |
| `wallet_execute_private_payment` | Execute a confirmed, unexpired plan |
| `wallet_get_request` | Read durable redacted request state |
| `egress_capabilities` | Read the explicit covered-fetch contract and limits |
| `egress_status` | Read redacted install, enrollment, and route readiness |
| `egress_fetch` | Fetch public HTTPS text/JSON with no direct fallback |

All monetary authority values use canonical integer strings in wei. Plans are
read-only, expire after five minutes, and bind recipient plus amount in a
SHA-256 intent digest. Execution revalidates setup, private balance, the
Sepolia chain ID, configured execution limit, one-payment rule, lifetime
allowance, expiry, and idempotency before invoking Kohaku.

## Architecture

```mermaid
flowchart LR
    U[User] <-->|conversation and verbal approval| H[Hermes]
    H <-->|MCP over stdio| A[Agent Boost sidecar]
    A -->|loopback-only funding page| UI[QR onboarding UI]
    A -->|bounded argv + random loopback RPC URL| K[Kohaku CLI]
    A -->|fixed-origin JSON-RPC| T[Embedded Tor / Arti]
    K -->|JSON-RPC via authenticated relay| T
    K -->|supported protocol HTTP via its Tor client| E[(Sepolia + protocol services)]
    T -->|HTTPS JSON-RPC through Tor| E
    A -->|explicit HTTPS GET or HEAD| S[Shade Tree authenticated Proxy]
    S -->|embedded Arti + RLN-proved CONNECT| W[(Public HTTPS destination)]
    O[Event operator] -->|scan QR and fund| E
    A -->|address, balances, policy, status| H
```

Agent Boost starts as the Hermes MCP child process and resumes its durable local
state after restarts. The onboarding web server binds only to `127.0.0.1`
(default port `9183`), accepts only loopback hosts and same-origin requests, and
serves a read-only UI with a restrictive Content Security Policy. Port `9180`
is deliberately reserved so this POC cannot collide with an older local
service. A separate exclusive loopback bind on port `9184` is a crash-safe
process ownership lock; a second Agent Boost process fails closed instead of
sharing the wallet. A fixed-destination JSON-RPC relay binds to `127.0.0.1:9185`
with a random 256-bit path token. It accepts JSON-RPC POST only, forwards only
to the configured HTTPS Sepolia origin through Tor, and has no direct retry.
The optional Shade Tree Proxy binds separately to `127.0.0.1:9186`, requires a
fresh in-memory 256-bit authentication token, and is reachable only through the
three bounded egress tools. Its member identity stays in owner-only local
files; its forward-only slot cursor is persisted separately and is never reset
or rewound to reclaim capacity.

Local state writes are flushed and atomically renamed. Agent Boost directories
are hardened to `0700` and state, password, wallet, and provenance files to
`0600`. Kohaku commands run without a shell, are serialized per wallet, pass
only the authenticated loopback relay through the child environment rather
than the upstream RPC URL or argv, and never return raw upstream stderr through
MCP. Inherited proxy variables and Kohaku's Tor-disable switch are scrubbed.
A child-process network guard rejects Kohaku's built-in public RPC fallbacks;
only loopback fetches are allowed, including Kohaku's own Tor-backed Pimlico
relay. Kohaku's traffic log is scrubbed of the live Agent Boost relay token
after every invocation.

See [Integration](docs/INTEGRATION.md),
[Capability contract](docs/CAPABILITY-CONTRACT.md),
[Architecture](docs/ARCHITECTURE.md), and
[Threat model](docs/THREAT-MODEL.md) for the exact boundaries.

## Privacy claims and limits

The accurate claim for this POC is:

> A privacy-improving, shielded Sepolia test payment.

It is not a guarantee of anonymity.

- Initial funding is public. The funder, destination, amount, and timing are
  visible on Sepolia.
- Shielding and later unshielding break the direct deposit/withdrawal link, but
  timing, amounts, a small testnet anonymity set, and protocol activity may
  still correlate them.
- Agent Boost and Kohaku route Ethereum JSON-RPC over Tor with remote hostname
  resolution and no direct fallback. This hides the machine's origin IP from
  the RPC provider, but the provider still sees RPC methods, wallet addresses,
  payloads, and timing.
- Kohaku separately uses Tor for supported privacy-protocol HTTP traffic.
  Explicit `egress_fetch` calls can use Shade Tree after enrollment. Hermes,
  model-provider, Matrix, browser, and all other process traffic remain outside
  that covered request.
- A fresh or stealth address alone does not hide its funding transaction.
- Demo reset archives prior state and retains old Kohaku wallet data locally,
  but Agent Boost still has no seed export or guided wallet-recovery UX.
- Recipient-balance-delta confirmation proves delivery of at least the amount;
  it is not cryptographic attribution when unrelated concurrent transfers are
  possible.

Shade Tree cover is a research-preview, explicitly invoked module. It does not
change the wallet RPC route and it is never presented as whole-agent privacy.

## Local security boundary

Agent Boost keeps secrets out of tool results, prompts, command arguments, and
normal logs. That is useful, but it is not an operating-system custody boundary
when Hermes and Agent Boost run as the same user. A locally privileged agent
with unrestricted shell and filesystem access could read both the encrypted
Kohaku wallet and its local password file. The Hermes skills tell the agent not
to do this; instructions are not enforcement.

For this POC, the practical safety boundary is disposable Sepolia-only funds,
a maximum one-time payment, no mainnet configuration, and explicit verbal
confirmation. A future real-value release would require a separate service
identity or hardware/cryptographic signer that the agent process cannot access.
The confirmation boolean is supplied by Hermes, so a compromised Hermes has
the same authority as a falsely confirmed conversation within these limits.

## Configuration

The POC is deliberately small and uses environment variables rather than a
secret-bearing repository config.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_BOOST_RPC_URL` | Public HTTPS Sepolia RPC | Fixed Tor-routed endpoint; hostname and HTTPS required |
| `AGENT_BOOST_UI_PORT` | `9183` | Loopback funding page port; `9180`, `9184`, and `9185` forbidden |
| `AGENT_BOOST_TOR_RPC_PORT` | `9185` | Authenticated fixed-origin loopback relay for Kohaku |
| `AGENT_BOOST_TOR_DATA_DIR` | `$AGENT_BOOST_STATE_DIR/tor` | Private embedded-Tor cache namespace |
| `AGENT_BOOST_TOR_BOOTSTRAP_TIMEOUT_MS` | `120000` | Fail-closed Tor startup deadline |
| `AGENT_BOOST_FUNDING_WEI` | `200000000000000000` | Requested initial funding |
| `AGENT_BOOST_SHIELD_WEI` | `100000000000000000` | Tornado shield/note amount |
| `AGENT_BOOST_PAYMENT_LIMIT_WEI` | `50000000000000000` | One-payment maximum |
| `AGENT_BOOST_DELEGATION_TTL_MS` | `604800000` | Delegated execution lifetime (seven days) |
| `AGENT_BOOST_OPEN_UI` | `true` | Attempt to open a graphical browser |
| `AGENT_BOOST_EXECUTE` | `true` | Enable bounded testnet execution |
| `AGENT_BOOST_STATE_DIR` | `~/.local/share/agent-boost` | Durable state root |
| `AGENT_BOOST_SHADE_TREE_ENABLED` | `true` | Enable optional explicit covered egress |
| `AGENT_BOOST_SHADE_TREE_PROXY_PORT` | `9186` | Authenticated loopback Shade Tree Proxy |
| `AGENT_BOOST_SHADE_TREE_PROFILE_DIR` | `$AGENT_BOOST_STATE_DIR/shade-tree/profile` | Operator-provisioned owner-only profile |
| `AGENT_BOOST_SHADE_TREE_REQUEST_TIMEOUT_MS` | `30000` | Covered request deadline |
| `AGENT_BOOST_SHADE_TREE_MAX_RESPONSE_BYTES` | `1048576` | Covered response body cap |
| `AGENT_BOOST_PRIVATE_INFERENCE_ENABLED` | `false` | Enable explicit ACI-backed private inference |
| `AGENT_BOOST_PRIVATE_INFERENCE_BASE_URL` | `https://tee.redpill.ai/v1` | Hosted or self-hosted HTTPS ACI endpoint |
| `AGENT_BOOST_PRIVATE_INFERENCE_API_KEY` | none | Downstream gateway credential; keep outside chat and source control |
| `AGENT_BOOST_PRIVATE_INFERENCE_MODEL` | none | Default confidential model identifier |
| `AGENT_BOOST_PRIVATE_INFERENCE_MODEL_ALLOWLIST` | none | Comma-separated eligible models; must include the default |
| `AGENT_BOOST_PRIVATE_INFERENCE_TRUST_MODE` | `reviewed_release` | `reviewed_release` or evaluation-only `hardware` |
| `AGENT_BOOST_PRIVATE_INFERENCE_ACCEPTED_COMPOSE_HASHES` | none | Required reviewed release pins in `reviewed_release` mode |

The upstream RPC URL is never returned through MCP or given to Kohaku. Do not put credentialed
URLs in the repository or paste them into a model conversation.

The default is the public Sepolia endpoint
`https://ethereum-sepolia-rpc.publicnode.com`, routed through Tor with no direct
fallback. Kohaku's account-abstraction relay also uses its own Tor-backed
Pimlico path; neither path makes Hermes or general agent traffic private.

## Development

```console
npm ci
npm run check
npm test
npm run build
npm run release:smoke
node dist/cli.js doctor
```

Focused dependency repair:

```console
make install-kohaku
```

`npm test` covers policy and idempotency, state permissions, command injection
resistance, exact Kohaku argv, Sepolia-only RPC, MCP schemas, Hermes config
drift, QR contents, loopback request filtering, UI state honesty, responsive
layout contracts, and recipient-delivery confirmation.

An active Hermes gateway keeps one Agent Boost MCP child open and owns the
runtime lock. In that state, `agent-boost status` remains available because it
is read-only, while a second `hermes mcp test agent-boost` intentionally fails
closed. Stop or restart the gateway only when an operator specifically needs a
standalone MCP connectivity test.

## License

No license has been granted yet. Treat this repository as all rights reserved
until a license file is added.
