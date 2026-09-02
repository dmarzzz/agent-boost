![Agent Boost banner: two agents, one switch, four private lanes](assets/agent-boost-readme-banner.webp)

# Agent Boost

**Dark mode for your agent.**

[![ci][ci-badge]][ci-url]
[![clean install][install-badge]][install-url]
[![Node.js 22+][node-badge]][node-url]
[![Hermes 0.16+][hermes-badge]][hermes-url]
![research preview][preview-badge]
[![license][license-badge]][license-url]

**[Install](#install)** · [Demo](docs/DEMO.md) · [Tools](docs/TOOLS.md) ·
[Docs](docs/README.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

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

> Send 0.02 Sepolia ETH privately to 0x2222…2222.

Hermes reads the live balance, reads the exact plan back, waits for your yes,
then signs and submits within a one-payment, seven-day delegation.

> Fetch https://example.com/data.json through covered egress.

After a Grove operator enrolls the install, Hermes fetches one public HTTPS
resource through Shade Tree over Tor, never a direct connection.

The full walkthrough, including the security policy and evals, is in
[docs/DEMO.md](docs/DEMO.md). The eleven MCP tools behind these conversations
are in [docs/TOOLS.md](docs/TOOLS.md).

## Docs

| Doc | What it covers |
| --- | --- |
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
[hermes-badge]: https://img.shields.io/badge/hermes-0.16%2B-3f8f14.svg
[hermes-url]: integrations/hermes/agent-boost/SKILL.md
[preview-badge]: https://img.shields.io/badge/status-research%20preview-9ee01e.svg
[license-badge]: https://img.shields.io/badge/license-all%20rights%20reserved-lightgrey.svg
[license-url]: #license
