![An open technical field guide showing the modular Agent Boost system](../assets/docs-field-guide.webp)

# Agent Boost docs

Agent Boost is a local privacy sidecar for Hermes. These docs cover the
participant experience, the deterministic contracts underneath it, and the
limits that keep a Sepolia research preview from being mistaken for production
custody or whole-agent anonymity.

[Back to the project README](../README.md) · [Run the demo](DEMO.md) ·
[Review the privacy boundary](PRIVACY.md)

> [!IMPORTANT]
> Start with [Install](INSTALL.md) and [Run the demo](DEMO.md) if you want to use
> Agent Boost. Start with [Architecture](ARCHITECTURE.md) and the
> [Threat model](THREAT-MODEL.md) if you are evaluating the design.

## Choose a path

| Goal | Read in this order | What you will learn |
| --- | --- | --- |
| **Try the research preview** | [Install](INSTALL.md) → [Run the demo](DEMO.md) → [Privacy](PRIVACY.md) | Supported hosts, funding flow, private test payments, covered fetches, and the claims you can safely make |
| **Integrate Hermes** | [Integration](INTEGRATION.md) → [Tools](TOOLS.md) → [Capability contract](CAPABILITY-CONTRACT.md) | MCP wiring, skill behavior, tool order, structured results, and authority boundaries |
| **Review security** | [Architecture](ARCHITECTURE.md) → [Threat model](THREAT-MODEL.md) → [Product philosophy](PRODUCT-PHILOSOPHY.md) | Process boundaries, failure behavior, residual risk, and why deterministic code—not the model—owns correctness |
| **Operate covered egress** | [Covered egress](COVERED-EGRESS.md) → [Configuration](CONFIGURATION.md) → [Privacy](PRIVACY.md) | Enrollment, request policy, local state, platform support, and what Shade Tree does not hide |

## The four ideas to keep straight

1. **The model is not the integrity boundary.** Hermes handles language and
   intent; Agent Boost re-reads facts and enforces policy, approval, redaction,
   and side effects in deterministic code.
2. **Permission is not liquidity.** A spending limit, an account balance, and a
   supported transfer route are separate facts.
3. **Each privacy lane is scoped.** Wallet RPC over Tor, covered HTTPS egress,
   and the model/tool boundary protect different information. None privatizes
   Hermes as a whole.
4. **Uncertainty stays uncertain.** An unresolved payment is reconciled by
   observation and is never replaced with an automatic rebroadcast.

## Reference

| Document | Use it when you need… |
| --- | --- |
| [Install](INSTALL.md) | Host support, prerequisites, installed paths, dependency pins, or reload commands |
| [Run the demo](DEMO.md) | The complete wallet, policy, payment, reset, covered-fetch, and eval flow |
| [Tools](TOOLS.md) | The fourteen MCP tools in call order, with inputs and returns |
| [Configuration](CONFIGURATION.md) | Environment variables, defaults, and adjustable testnet bounds |
| [Architecture](ARCHITECTURE.md) | Components, loopback surfaces, state machines, subprocess behavior, and failure handling |
| [Capability contract](CAPABILITY-CONTRACT.md) | Machine-readable wallet and egress guarantees, identifiers, envelopes, and authority |
| [Covered egress](COVERED-EGRESS.md) | The Shade Tree request policy, enrollment material, slot lifecycle, and platform limits |
| [Privacy claims and limits](PRIVACY.md) | What each route protects, what remains visible, and the same-user boundary |
| [Threat model](THREAT-MODEL.md) | Protected data, non-goals, attacks, mitigations, residual risk, and the release boundary |
| [Hermes integration](INTEGRATION.md) | MCP configuration, skill split, conversation behavior, session lifetime, and troubleshooting |
| [Product philosophy](PRODUCT-PHILOSOPHY.md) | Weak-model-safe engineering rules and the project definition of “shipped” |

## Sources of truth

The prose explains the product, but it does not grant authority. The checked-in
schemas under [`spec/`](../spec/), structured MCP results, durable local state,
and runtime checks are authoritative for what Agent Boost can do. When a claim
and the running capability document disagree, treat the runtime as unavailable
or degraded and investigate—do not widen the claim.
