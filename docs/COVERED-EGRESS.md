# Covered egress

Agent Boost exposes an optional `org.agentboost.egress/0.1` module for explicit
public HTTPS reads through Shade Tree v4. It is separate from the fixed Tor
route used by Sepolia JSON-RPC and Kohaku. The first release deliberately does
not wrap the Hermes process: model-provider, Matrix, plugin, update, browser,
and other traffic retain their existing routes.

## User flow

After one operator enrollment, a user asks Hermes to fetch a public HTTPS URL.
Hermes calls `egress_status`, then `egress_fetch`; the user never sees or types
Proxy credentials or terminal commands. If the module is not ready, it fails
closed. Hermes may offer a non-network alternative but must not make the same
request with another network tool.

## Request policy

- public DNS hostname and HTTPS port 443 only;
- GET or HEAD only;
- no request body, URL credentials, cookies, Authorization, arbitrary headers,
  client certificate, forwarded-IP headers, or credential-like query keys;
- no IP literal, single-label, localhost, `.local`, `.internal`, `.home`,
  `.lan`, or `.onion` destination;
- no local DNS preflight, which would leak the target; Shade Tree nodes validate
  every resolved answer against private, loopback, link-local, metadata, and
  reserved ranges;
- at most three redirects, with every destination revalidated;
- 30-second request deadline and 1 MiB body cap by default;
- UTF-8 `text/*`, `application/json`, or `application/*+json` only;
- normal destination certificate verification is mandatory;
- no clearnet, raw-Tor, or alternate-provider fallback.

Fetched content is marked `untrusted_external`. It is data to summarize, never
instructions for the agent.

## Local lifecycle

The installer pins Shade Tree release v0.4.0 and its platform SHA-256. Agent
Boost verifies the binary again before execution. A fresh, random 256-bit
Proxy token exists only in the Agent Boost process environment and is never
returned through MCP. The Proxy listens on loopback port 9186 and accepts
authenticated HTTP CONNECT only.

The owner-only profile directory is:

```text
~/.local/share/agent-boost/shade-tree/profile/
  identity.json
  members.json
  access.json
```

`identity.json` is generated locally by the pinned client and never leaves the
host. The operator receives only its public enrollment leaf, admits that exact
leaf at the agreed limit, and supplies the matching `members.json`. Agent Boost
does not attempt remote enrollment. The Proxy pins `--leaf-source invited` and
`--max-anon`, so a directory without an explicitly invited-only gateway fails
closed instead of selecting a staked or paid admission route.

`access.json` has this exact owner-only shape:

```json
{
  "version": 1,
  "protocol": 4,
  "bootnodeOnion": "<56-character-v3-onion>.onion",
  "directorySigner": "<64-lowercase-hex-ed25519-key>"
}
```

The onion and signer are one trust-pinned pair and must come from the same
operator. Agent Boost intentionally does not publish live Grove access values
in this repository.

RLN slot allocation is crash-safe and forward-only under
`shade-tree/slots/`. A slot is durably burned before proving. Never edit,
delete, restore, or rewind the cursor to reclaim capacity during an epoch; a
corrupt, unavailable, locked, rolled-back, or exhausted cursor fails closed.

## Support and limitations

The pinned live binary is available for Ubuntu ARM64 GNU and macOS Apple
silicon. The v0.4.0 release has no macOS Intel live asset. Its macOS binary is
not Developer ID signed/notarized; Agent Boost never removes quarantine or
bypasses Gatekeeper. The wallet POC remains available when covered egress is
unsupported or unenrolled.

The accurate claim is “privacy-improving covered HTTPS egress,” not anonymous
egress. The destination sees a Shade Tree node address. The node sees target
hostname/port, timing, lifetime, and traffic volume. End-to-end TLS hides the
path, query, and body from the node, assuming certificate validation holds.
Tor does not stop correlation by a sufficiently capable observer, and one RLN
proof admits one CONNECT tunnel rather than every HTTP request within it.
