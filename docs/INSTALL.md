# Install

The one-time installer builds Agent Boost, pins its wallet and egress
dependencies, and wires the active Hermes profile. Ordinary use happens in
conversation after installation.

## Quick install

You need Git, Node.js 22 or newer, npm, and Hermes 0.21 or newer. No system
Tor installation is required; Agent Boost embeds Arti through `tor-js`.

```console
git clone https://github.com/dmarzzz/agent-boost.git
cd agent-boost
make install
```

Restart Hermes once, then tell it:

> Set up Agent Boost for me.

Hermes creates the wallet, presents the exact address and funding QR, and asks
you to reply with ✅ or say `sent` after sending the displayed Sepolia ETH. No
terminal or MCP command is needed after this handoff.

## Platform support

| Host | Wallet preview | Covered egress |
| --- | --- | --- |
| macOS, Apple silicon | Supported | Supported after Grove enrollment |
| macOS, Intel | Supported | Unavailable: Shade Tree v0.4.0 has no Intel live binary |
| Ubuntu 24.04, ARM64 | Supported | Supported after Grove enrollment |

Every change runs the same clean-tarball install smoke on native GitHub runners
for all three hosts. The smoke installs into an empty prefix, starts the
packaged executable, loads runtime configuration, checks the complete modular
Hermes skill bundle,
and rejects private planning material in the package.

## What the installer does

- builds and installs Agent Boost under `~/.local`;
- fetches the pinned Kohaku commit, installs its locked dependencies, records
  local SHA-256 provenance, and refuses to replace an unmanaged target;
- downloads the checksummed Shade Tree v0.4.0 client when the host has a live
  release asset;
- configures the active Hermes profile without replacing a conflicting MCP
  entry, validating every file in the modular skill bundle before installing
  any of them, writing each replacement atomically with a backup, and exposing
  the MCP entry only once the complete bundle is present;
- leaves covered egress in `needs_enrollment` until an operator admits the
  locally generated identity and supplies matching trust-pinned Grove values.

Wallet setup and payments remain available when covered egress is unsupported
or waiting for enrollment.

## Check or repair the integration

Run the optional host diagnostic before a demo:

```console
agent-boost doctor
```

If Hermes was unavailable during installation, configure it later:

```console
agent-boost install-hermes
```

For an already-running Hermes conversation, reload instead of restarting:

```text
local:   /reload-skills, then /reload-mcp
Matrix:  !reload-skills, then !reload-mcp
```

A full restart is still required when the native pre-LLM bridge or the
turn-gate hooks are first installed or changed: skill and MCP reload commands
do not register plugins or hooks. After restarting, use `/new` locally or
`!new` over Matrix so the upgraded tool contract starts in a fresh
conversation.

If the installer reports that `~/.local/bin` is not on `PATH`, add it before
running these commands.

## Installed paths

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

## Pins and provenance

Kohaku is pinned to commit
[`fcf9defa4d5ff7f63222f1b3bbe2d30e631ceffd`](https://github.com/kassandraoftroy/kohaku-cli/commit/fcf9defa4d5ff7f63222f1b3bbe2d30e631ceffd).
Agent Boost records SHA-256 provenance for its lockfile, launcher, and compiled
bundle. A managed installation is reused only when its pin and hashes still
match.

Shade Tree is pinned to release
[`v0.4.0`](https://github.com/dmarzzz/shade-tree-node/releases/tag/v0.4.0)
at commit
[`db074e4e75daf87b50fd52bda5378c9d04ce6c4d`](https://github.com/dmarzzz/shade-tree-node/commit/db074e4e75daf87b50fd52bda5378c9d04ce6c4d).
Agent Boost verifies the platform SHA-256 during installation and again before
launch. The binary alone grants no Grove access: the operator must admit the
exact public enrollment leaf and provision the matching member set and
trust-pinned discovery values.

## Current upstream risk

The Kohaku runtime is roughly 0.8 GiB after production pruning, before proving
artifacts. Its pinned production dependency tree also reports 44 known npm
advisories—38 moderate and 6 high—as of this release candidate. That unresolved
upstream risk is another reason this build is strictly disposable-testnet
software.

Continue with [Run the demo](DEMO.md), or read [Configuration](CONFIGURATION.md)
for paths, ports, limits, and local overrides.
