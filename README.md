![Agent Boost: private payment and identity marked on; private inference and private search marked coming soon](assets/agent-boost-readme-banner.webp)

# Agent Boost

**Dark mode for your agent.**

[![ci][ci-badge]][ci-url]
[![clean install][install-badge]][install-url]
[![Node.js 22+][node-badge]][node-url]
[![Hermes 0.16+][hermes-badge]][hermes-url]
![research preview][preview-badge]
[![license][license-badge]][license-url]

**[Install](#install)** · [Demo](docs/DEMO.md) · [Tools](docs/TOOLS.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Privacy](docs/PRIVACY.md) ·
[Security](SECURITY.md) · [Docs](docs/README.md)

Agent Boost is a local privacy sidecar for Hermes. It gives an agent tightly
scoped private capabilities while deterministic software—not the model—owns
live facts, policy, approval, secrets, and side effects.

The research preview centers on a shielded Sepolia wallet and explicitly scoped
Shade Tree egress. **Private search and private inference are coming soon.**
Covered HTTPS egress is a separate, explicitly invoked capability; it does not
provide a private search product or a blanket-private Hermes session.

> [!CAUTION]
> Unaudited research software. The wallet is Sepolia-only and intended for
> disposable test funds. Never send mainnet assets, real value, or a wallet you
> care about.

## What it adds

| Capability | Status | What it covers |
| --- | --- | --- |
| Private payment and identity | Research preview | Fresh Ethereum accounts and shielded Sepolia test payments through Kohaku. Wallet tool results expose addresses, balances, and status, while keeping signing material out of the model conversation. |
| Covered egress | Research preview; Grove enrollment required | Explicit public HTTPS reads through a Shade Tree over Tor. The route is bounded and has no direct fallback. |
| Private search | Coming soon | A future search capability; distinct from the covered HTTPS reads available in the preview. |
| Private inference | Coming soon | A planned opt-in path for discrete subproblems sent to attested confidential compute, with a verified response receipt. |

These are independent lanes. Enabling one does not silently reroute the others.

## Install

Supported on macOS (Apple silicon or Intel) and Ubuntu 24.04 ARM64. You need
Git, Node.js 22+, npm, and a working Hermes install. You do **not** need a
system Tor installation.

```console
git clone https://github.com/dmarzzz/agent-boost.git
cd agent-boost
make install
```

Restart Hermes once, then tell it:

> Set up Agent Boost for me.

The installer pins and verifies Kohaku and the Shade Tree client, installs
under `~/.local`, and wires the active Hermes profile. After that, ordinary use
happens in conversation—no tool names, IDs, atomic units, or terminal commands
required. See [the installation guide](docs/INSTALL.md) for platforms, paths,
and dependency pins.

## Talk to it

| Say this to Hermes | What Agent Boost does |
| --- | --- |
| **“Set up Agent Boost for me.”** | Creates a disposable wallet, shows a funding QR for the exact remaining amount, and shields `0.1` Sepolia ETH once funded. |
| **“Send 0.02 Sepolia ETH privately to `0x2222…2222`.”** | Refreshes live state, checks funds and policy, shows the exact plan, waits for approval, then submits once. |
| **“Fetch `https://example.com/data.json` through covered egress.”** | After Grove enrollment, reads one public HTTPS resource through Shade Tree over Tor—never by a direct fallback. |

Plans do not sign or submit. Execution rechecks the live balance and policy,
and an uncertain result stays uncertain rather than becoming an unsafe retry.
The [full demo](docs/DEMO.md) walks through setup, permissions, payment, egress,
and the conversation evals.

## The model is not the security boundary

<p align="center">
  <img src="assets/agent-boost-boundary.svg" width="100%" alt="Hermes sends intent to the local Agent Boost sidecar, where code enforces live facts, policy, approval, and redaction before using one of three scoped privacy paths">
</p>

Hermes handles language and intent. Agent Boost handles the parts that must be
deterministic:

- live balance and readiness reads instead of remembered chat context;
- immutable plans, bounded permissions, explicit approval, and idempotency;
- redacted tool results that exclude keys, passwords, notes, proofs, and raw
  signed transactions;
- fail-closed Tor and Shade Tree routes, with no quiet direct-network retry.

That split is the core product rule: stronger models can make the experience
better, but they do not make balances, permissions, privacy, or payments
correct. Read the [product philosophy](docs/PRODUCT-PHILOSOPHY.md) and
[architecture](docs/ARCHITECTURE.md) for the detailed contract.

## Privacy, precisely

Agent Boost improves privacy; it does not promise anonymity.

- Initial funding and later testnet activity remain public on Sepolia. Shielding
  reduces direct linkability, but timing, amounts, and a small anonymity set can
  still correlate activity.
- Wallet JSON-RPC uses Tor with remote DNS and no direct fallback. The RPC
  provider still sees methods, addresses, payloads, and timing.
- Covered egress applies only to the explicit HTTPS request. It does not
  blanket-route Hermes, its model provider, Matrix, or the browser.
- Hermes and Agent Boost currently run as the same OS user. Keeping secrets out
  of the model conversation is useful, but it is not a hardware custody
  boundary against a locally privileged process.

The exact claims and non-claims live in [Privacy](docs/PRIVACY.md) and the
[threat model](docs/THREAT-MODEL.md).

## Docs

| Read | For |
| --- | --- |
| [Install](docs/INSTALL.md) | Supported hosts, installed paths, pins, and enrollment |
| [Demo](docs/DEMO.md) | The complete participant flow and conversation evals |
| [Tools](docs/TOOLS.md) | MCP tools in call order, with inputs and returns |
| [Architecture](docs/ARCHITECTURE.md) | Components, state machines, and hardening |
| [Capability contract](docs/CAPABILITY-CONTRACT.md) | Machine-readable guarantees and result envelopes |
| [Covered egress](docs/COVERED-EGRESS.md) | Shade Tree scope, limits, and privacy boundary |
| [Configuration](docs/CONFIGURATION.md) | Environment variables and defaults |
| [All docs](docs/README.md) | Documentation index |

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
