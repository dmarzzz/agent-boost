# Security policy

## Status

Agent Boost is an unaudited research preview. It reduces what an agent can see
and do, but it is not a custody boundary and it is not an anonymity guarantee.
The wallet stack is Sepolia-only by configuration, funds are disposable test
ETH, and mainnet is rejected. Kohaku, the Zallet integration, Shade Tree, the
ACI verifier, and the embedded `tor-js` client are all unaudited. Do not put
real value, a wallet you care about, or sensitive traffic behind this build.

The full threat model, protected data, security goals, and non-goals are in
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md). The exact tool surface the agent
is allowed to see is in [`docs/CAPABILITY-CONTRACT.md`](docs/CAPABILITY-CONTRACT.md).
Read both before reporting: several sharp edges are already known and
documented, and a report against one of those is a duplicate, not a finding.

## In scope

Reports that show a real defect in the shipped code, for example:

- Any MCP result, log line, prompt, command argument, or UI response that
  carries a seed phrase, private key, wallet password, raw privacy note or
  proof, raw PCZT or signed transaction, route credential, or provider API key.
- A way to run a wallet command outside the fixed allowlist, or to reach a
  shell through one.
- A mainnet or non-Sepolia RPC endpoint being accepted, or Ethereum JSON-RPC
  leaving the fixed Tor route with a direct fallback.
- Payment terms changing between the plan the user confirmed and the
  transaction that is signed, or a payment escaping its one-use, expiring
  delegation limit.
- A retry or restart that double-executes a payment, or a reconciliation path
  that rebroadcasts an unresolved request.
- The onboarding UI exposing more than the public funding projection, or
  accepting non-loopback requests.
- Covered egress falling back to a direct connection, or routing traffic it was
  not explicitly asked to route.
- Private inference returning an unverified response as verified, or sending a
  query to a model outside the allowlist.
- State files or directories created without private local permissions.

## Known and out of scope

These are documented limitations, not vulnerabilities. Please do not file them
as new reports; concrete improvements are welcome as pull requests.

- **Same-user isolation.** Hermes and Agent Boost run under the same OS
  account. A locally privileged agent with shell and filesystem access can read
  the encrypted wallet and its password file. Skill instructions are not
  enforcement. (`docs/THREAT-MODEL.md`, "Same-user isolation".)
- **Anonymity is not guaranteed.** Funding is public, the testnet anonymity set
  is small, the RPC provider still sees methods, addresses, and timing, and only
  explicitly covered requests go through Shade Tree. (`docs/THREAT-MODEL.md`,
  "Guaranteed anonymity"; README "Privacy claims and limits".)
- **The confirmation boolean comes from Hermes.** A compromised Hermes has the
  same authority as a falsely confirmed conversation, within the delegation
  limits. (README "Local security boundary".)
- **No real-value safety.** No seed export, hardware signer, multi-party
  approval, fee policy, or reorg handling. (`docs/THREAT-MODEL.md`, "Real-value
  safety".)
- **Known dependency advisories** called out in the README warning are tracked
  there, not here.

## Reporting

Report privately. Do not open a public issue for a suspected vulnerability.

- Open a private security advisory on GitHub for `dmarzzz/agent-boost`
  (repository → Security → Advisories → "Report a vulnerability").

That is the intended private channel. There is no dedicated security email.

Please include: the affected file and symbol, the boundary crossed (which
secret reached which surface, or which limit was escaped), a reproduction (a
failing test under `test/` is ideal, since the whole repo is tested that way),
and the impact.

## Disclosure

This is a small research project, so treat these as expectations, not a
contract. We aim to acknowledge a report within a few days and to work toward a
fix on a reasonable, coordinated timeline before public disclosure. If a report
matches an already-documented limitation above, we will say so and point at the
tracking issue rather than treat it as a new finding.
