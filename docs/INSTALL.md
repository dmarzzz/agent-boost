# Install

Everything the installer does, what it pins, and where state lives. The short version is in the [README](../README.md#install).

Supported hosts:

- macOS on Apple silicon;
- macOS on Intel;
- Ubuntu 24.04 on ARM64.

Every change runs the same clean-tarball install smoke on native GitHub runners
for Ubuntu 24.04 ARM64, macOS ARM64, and macOS Intel. The smoke installs into an
empty prefix, starts the packaged executable, loads runtime configuration,
checks the complete modular Hermes skill bundle, and rejects private planning
material in the package.

Prerequisites are Git, Node.js 22 or newer, npm, and Hermes 0.21 or newer.
No system Tor installation is required; the POC embeds Arti through `tor-js`.
The installer builds the repository, installs Agent Boost under `~/.local`,
fetches and verifies the pinned Kohaku commit, installs the checksummed Shade
Tree v0.4.0 live client where upstream publishes one, and configures the active
Hermes profile without replacing a conflicting MCP entry. It validates every
file in the modular skill bundle before installing any of them, writes each
replacement atomically with a backup, and exposes the MCP entry only after the
complete bundle is present. Covered egress is
currently supported on Ubuntu ARM64 and macOS Apple silicon. The wallet remains
supported on macOS Intel, but Shade Tree v0.4.0 has no Intel live binary; the
installer reports that limitation instead of substituting an unproved route.

Hermes integration updates are serialized by a profile-local
`.agent-boost-install.lock`. The installer snapshots the config and every Agent
Boost skill and hook-approval target, refuses linked or concurrently changed
targets, validates the pre/post turn gate, native plugin, and new MCP server,
and rolls back only files whose bytes still match this install if validation
fails. Its JSON
output reports backup paths and any incomplete hash-guarded rollback. It never
includes the durable Agent Boost wallet state in that transaction. If a killed
installer leaves the lock behind, the error reports its path and owner PID;
verify that PID is no longer running an Agent Boost install before removing
only the reported lock file.

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

The restart is required when the native pre-LLM bridge or turn-gate hooks are
first installed or changed; skill and MCP reload commands do not register
plugins or hooks. After restarting, use
`/new` locally or `!new` over Matrix so the upgraded tool contract starts in a
fresh conversation.

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
