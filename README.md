![Agent Boost banner: two agents, one switch, four private lanes](assets/agent-boost-readme-banner.webp)

# Agent Boost

**Dark mode for your agent.**

[![ci][ci-badge]][ci-url]
[![clean install][install-badge]][install-url]
[![Node.js 22+][node-badge]][node-url]
[![Hermes 0.21+][hermes-badge]][hermes-url]
![research preview][preview-badge]
[![license][license-badge]][license-url]

**[Install](#install)** · [Demo](docs/DEMO.md) · [Tools](docs/TOOLS.md) ·
[Philosophy](docs/PRODUCT-PHILOSOPHY.md) · [Docs](docs/README.md) ·
[Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

Agent Boost is a local sidecar that gives a Hermes agent private money, a
private identity, and anonymous egress without ever handing it a key.

- **Private payment and identity**: stealth Ethereum addresses and balances
  through Kohaku, and shielded Zcash through Zallet; the agent sees addresses
  and balances, never keys.
- **Anonymous egress**: public HTTPS reads through a Shade Tree, or a grove of
  them, over Tor with no direct fallback.
- **Private inference**: sensitive subproblems sent to an attested confidential
  model, with a receipt the sidecar verifies.

> [!WARNING]
> Unaudited research software. Sepolia-only, disposable test funds. Never send
> mainnet assets, real value, or a wallet you care about.

## Install

macOS (Apple silicon or Intel) or Ubuntu 24.04 ARM64, with Node.js 22+ and a
working Hermes. No system Tor needed.

```console
git clone https://github.com/dmarzzz/agent-boost.git
cd agent-boost
make install
```

Restart Hermes once, then tell it:

> Set up Agent Boost for me.

The installer pins and verifies Kohaku and the Shade Tree client, installs
under `~/.local`, and wires the Hermes profile. Details, paths, and pins are in
[docs/INSTALL.md](docs/INSTALL.md).

## Use it

Everything happens in conversation. No terminal after install.

> Set up Agent Boost for me.

Hermes creates a disposable Sepolia wallet, shows a QR for `0.2` test ETH, and
shields `0.1` of it through Kohaku once funded.

> Show me my wallets as a tree.

Hermes prints one live, address-free map using friendly wallet names. Public
balances, every named private balance, and any wallet-controlled public change
left by a private operation stay nested beneath their saved parent wallet.
Active balances are refreshed; inactive balances are clearly marked last known.

> Create a private balance called savings under agent-boost, then fund it with 0.1 Sepolia ETH from main.

Private balances are durable named pockets, not chat-only labels. You can add
more than one beneath a wallet, fund one from its parent main account, or move a
whole supported private denomination from one sibling pocket into another.
Creation and funding each get their own chat preview and approval; a later
clause never runs silently across a confirmation boundary.
Creating a second wallet gives it its own independent set of pockets and
policies, all restored when that wallet is loaded again.

> Load my old wallet.

One task-level call resolves the wording against saved profiles. If exactly one
inactive profile fits, Hermes shows its switch preview; if several fit, it asks
which friendly name to load. Replying with just that name opens its switch
preview. After approval, the same flow restores that
wallet's durable setup and returns the fresh bounded-authority preview.
Granting authority still requires its own later chat confirmation. You can
create, adopt, archive, and switch among local Sepolia wallets without entering
a seed, password, key, path, or internal wallet ID.

> Send 0.02 Sepolia ETH privately to 0x2222…2222.

Hermes reads the live balance, reads the exact plan back, waits for your yes,
then signs and submits within a user-visible, seven-day delegation. New wallets
start with 10 sends of up to 1 Sepolia ETH each; say “change my wallet limits”
to preview and approve different testnet guardrails.

> Send a regular public transfer of 0.02 Sepolia ETH to 0x2222…2222.

Hermes uses the selected main account by default. If you explicitly say “from
the savings public change,” it instead uses spendable public value nested under
that private balance. It reserves gas, shows the exact public-transfer source,
executes and verifies it in one task-level call, and never substitutes the
private route. Regular and private
sends share the same testnet delegation envelope. Your next chat reply—“yes,”
“send it,” or ✅—confirms the shown plan; there is no separate interface or
plan ID for you to operate.

> Fetch https://example.com/data.json through covered egress.

After a Grove operator enrolls the install, Hermes fetches one public HTTPS
resource through Shade Tree over Tor, never a direct connection.

The full walkthrough, including the security policy and evals, is in
[docs/DEMO.md](docs/DEMO.md). The MCP tools behind these conversations are
documented in [docs/TOOLS.md](docs/TOOLS.md).

## Docs

| Doc | What it covers |
| --- | --- |
| [Product philosophy](docs/PRODUCT-PHILOSOPHY.md) | Weak-model-safe correctness and the definition of shipped |
| [Tools](docs/TOOLS.md) | The MCP tools in call order, with inputs and returns |
| [Architecture](docs/ARCHITECTURE.md) | Components, loopback surfaces, hardening |
| [Threat model](docs/THREAT-MODEL.md) | Protected data, goals, non-goals, attacks |
| [Privacy claims and limits](docs/PRIVACY.md) | What is and is not private |
| [Capability contract](docs/CAPABILITY-CONTRACT.md) | The wallet and egress contracts |
| [Configuration](docs/CONFIGURATION.md) | Environment variables and defaults |
| [All docs](docs/README.md) | Index |

## Development

```console
npm ci
npm run check
npm test
npm run build
```

House rules and the test layout are in [CONTRIBUTING.md](CONTRIBUTING.md).
Report security issues privately through [SECURITY.md](SECURITY.md).

## License

No license has been granted yet. Treat this repository as all rights reserved
until a license file is added.

[ci-badge]: https://github.com/dmarzzz/agent-boost/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/dmarzzz/agent-boost/actions/workflows/ci.yml
[install-badge]: https://github.com/dmarzzz/agent-boost/actions/workflows/release-matrix.yml/badge.svg
[install-url]: https://github.com/dmarzzz/agent-boost/actions/workflows/release-matrix.yml
[node-badge]: https://img.shields.io/badge/node-%3E%3D22-3f8f14.svg
[node-url]: https://nodejs.org/en/download
[hermes-badge]: https://img.shields.io/badge/hermes-0.21%2B-3f8f14.svg
[hermes-url]: integrations/hermes/agent-boost/SKILL.md
[preview-badge]: https://img.shields.io/badge/status-research%20preview-9ee01e.svg
[license-badge]: https://img.shields.io/badge/license-all%20rights%20reserved-lightgrey.svg
[license-url]: #license
