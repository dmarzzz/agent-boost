# Threat model

Agent Boost is a research POC for reducing common privacy and custody failures
at the boundary between a local agent and external systems. It is not an
anonymity guarantee or a production wallet.

## Assets

- wallet seed, private keys, and unlock material;
- the operator's host IP and direct network location;
- the link between agent activity and external destinations;
- payment intent before operator approval;
- adapter credentials and local policy;
- request history and receipts.

## Trust assumptions

The POC trusts:

- the host kernel and operator identity;
- the Agent Boost process and its local state permissions;
- the Kohaku and Shade Tree versions selected by the operator;
- the operator to inspect approvals and protect unlock material.

The agent runtime, model output, fetched content, destinations, RPC provider,
egress relays, and public blockchain are not trusted with wallet secrets.

Public wallet addresses, balances, pending status, fee estimates, and policy
allowances are intentionally returned to the agent so it can make decisions.
They are not treated as custody secrets. If the agent uses remote inference,
that model provider may observe whatever wallet context is placed in the model
request; preventing that disclosure requires local inference or a separate
context-redaction policy.

## Security goals

1. The agent cannot read wallet seed or private key through the Agent Boost
   interface.
2. A payment cannot be signed before approval of its exact immutable details.
3. Dark HTTP and wallet RPC do not silently fall back to direct clearnet.
4. Strict mode denies the agent an ambient network path around Agent Boost.
5. Administrative control is unavailable to the agent OS identity, sandbox,
   MCP child, and model-generated code.
6. Receipts are useful for diagnosis without storing prompts, payloads, auth
   headers, or secrets by default.
7. Restart and retry do not accidentally double-broadcast a payment.

## In scope

### Prompt injection or malicious model output

The agent may request an unexpected destination or payment. Agent Boost applies
schema limits, destination policy, fee bounds, and approval independently of
the model. Tool results are bounded before returning to the agent.

### Secret exfiltration through the agent interface

The interface has no export-seed, export-key, raw-sign, arbitrary-wallet-shell,
or arbitrary-adapter-shell capability. Error messages and receipts are scrubbed
before crossing the boundary.

### Direct network bypass

Strict mode assumes the agent runs in an operating-system sandbox that denies
direct sockets. The compatibility wrapper alone is not a bypass defense.

### Silent route downgrade

Private-route loss returns an error. Agent Boost does not retry the request
through a direct connector, alternate RPC URL, or host default route.

### Unapproved signing

Payment planning, preparation, and signing are separate states. A plan is
read-only. Preparation revalidates and reserves, but cannot sign. Approval is
bound to a digest of network, source account, destination, asset, amount,
calldata summary, nonce policy, and fee ceiling.

### Duplicate execution

Side-effecting requests have stable IDs and persistent states. After an
ambiguous broadcast result, Agent Boost reconciles chain state before retry.

### Same-UID control-plane bypass

Filesystem mode bits do not isolate processes that share the operator UID. The
strict deployment therefore separates the Agent Boost operator service from the
agent identity and denies the agent access to the admin socket and wallet-state
paths. Cryptographic operator authentication is an acceptable alternative only
when its credential is never available to the agent process.

## Out of scope

The POC does not protect against:

- a compromised kernel, root user, debugger, or process with access to the
  operator identity or authenticated control plane;
- a global passive adversary or traffic-analysis attack across the anonymity
  network;
- malicious Tor exits, Grove nodes, destinations, or RPC providers observing
  the traffic they legitimately terminate;
- cookies, logins, API keys, browser fingerprints, prompt contents, or other
  application-layer identifiers sent by the agent;
- disclosure of agent-visible public wallet state to a remote model provider;
- public-chain analysis of amounts, timing, counterparties, contract calls, or
  the source of first funding;
- an operator approving a malicious or misleading request;
- denial of service, unavailable relays, unavailable RPC, or fee volatility;
- vulnerabilities in Agent Boost, Kohaku, Shade Tree, Tor, dependencies, or
  host cryptography;
- post-quantum security, private inference, or confidential model execution.

## Funding caveat

A stealth address changes how a recipient is discovered; it does not make the
funding transaction invisible. The POC test sponsor can observe the requested
destination and timing, and a chain observer can see the transfer. The
`bootstrap --testnet` command exists for usability testing only.

## Logging policy

By default, receipts may store:

- request ID and timestamps;
- mode, capability, adapter, and coarse destination origin;
- approval state and terminal result;
- public transaction hash after broadcast.

They do not store:

- model prompts or chain-of-thought;
- HTTP request or response bodies;
- authorization, cookie, or proxy-credential headers;
- wallet seed, private keys, unlock values, or encrypted wallet blobs;
- full URL paths or query strings.

Operators can disable destination logging entirely. Debug logging must be an
explicit, time-bounded operator action and must never enable secret logging.

## POC security gates

Before a downloadable release, tests must demonstrate:

- loopback-only listeners and operator-only control-socket permissions;
- distinct agent/operator authority or cryptographic operator authentication,
  with an agent-sandbox canary proving the admin socket and state paths are
  unreachable;
- process environment and command-line secret scans;
- direct-connect failure from the strict agent sandbox;
- clearnet canaries for both HTTP and Ethereum RPC;
- proxy-loss failure without fallback;
- approval digest mutation rejection;
- log and receipt redaction fixtures;
- crash recovery without double-broadcast;
- dependency version pinning and artifact checksums.

Any failed gate keeps the affected capability disabled or the release labeled
as a non-private engineering preview.
