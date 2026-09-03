# Trading plan

Agent Boost reserves a venue-neutral trade contract for regular and private
token swaps. The initial scope is Sepolia only. No venue, quote adapter, token
approval path, signer, or transaction submission path is configured yet.

The current release is deliberately inert:

- regular trading reports `SEPOLIA_SWAP_VENUE_NOT_CONFIGURED`;
- private trading reports `PRIVATE_SWAP_DESIGN_NOT_SELECTED`;
- both return `TRADE_NOT_CONFIGURED` from plan, execute, and status attempts;
- no attempt performs a network request, requests a quote or approval, changes
  durable state, accesses signing material, or submits a transaction;
- a private request never falls back to a regular/public swap;
- mainnet and cross-chain trading are unavailable.

## Product model

Regular and private trades share one exact-input swap intent, but they are
separate execution modes with separate readiness. `private` is an authority and
privacy requirement, not a routing preference. A private trade must stop if its
entire private path is unavailable.

The common intent binds:

- operation: `swap_exact_in`;
- execution mode: `regular` or `private`;
- CAIP-2 chain ID;
- CAIP-19 sell and buy asset IDs;
- exact atomic sell amount;
- maximum slippage in basis points;
- exact output recipient.

The first implementation should remain exact-input only. Limit orders, TWAP,
cross-chain swaps, arbitrary calldata, and a generic signing interface are
outside this contract and require separate designs.

## Agent-facing contract

`org.agentboost.trade/0.1` is separate from the existing wallet and payment
contract. It is available as a read-only MCP resource at:

```text
agent-boost://capabilities/trade/v1
```

Reserved tools:

| Tool | Current behavior | Future responsibility |
| --- | --- | --- |
| `trade_capabilities` | Reports both modes as `not_configured` | Advertise venues, policy, limits, and live readiness |
| `trade_plan` | Returns `TRADE_NOT_CONFIGURED` | Fetch and validate a quote, then persist an immutable decision |
| `trade_execute` | Returns `TRADE_NOT_CONFIGURED` | Confirm, consume authority, prepare, sign, and submit one decision |
| `trade_get_request` | Returns `TRADE_NOT_CONFIGURED` | Reconcile one durable request without rebroadcasting |

No unavailable call creates a decision ID or request ID. Execute and status
inputs exist to reserve the lifecycle shape, but fabricated IDs cannot cause a
side effect.

## Future regular Sepolia flow

```text
trade_capabilities
  -> trade_plan(exact intent)
  -> venue quote
  -> Boost validates tokens, amount, recipient, slippage, fees, spender,
     approvals, calldata, deadline, and chain
  -> immutable decision + digest
  -> native user confirmation
  -> trade_execute(decision ID)
  -> persist request and consume authority before signing
  -> bounded token approval/wrap action when required
  -> sign and submit
  -> trade_get_request(request ID) until terminal
```

The venue adapter must return normalized data rather than opaque executable
calldata alone. Agent Boost must independently check the quote against the
intent and an allowlist of token, router, spender, and function semantics.
ERC-20 approval or Permit2 authorization is a separate authority-bearing
action and must be bounded to an exact token, spender, amount, and lifetime.

A Sepolia venue should be selected only after checking:

- actual Sepolia deployment and test-token liquidity;
- stable quote and status APIs or contracts;
- reproducible recipient, minimum-output, fee, and deadline semantics;
- approval scope and revocation behavior;
- simulation support and failure observability;
- idempotency and ambiguous-submission reconciliation;
- dependency and contract auditability.

## Future private Sepolia flow

Private trading stays unimplemented until “private” has an explicit threat
model. Venue privacy, RPC privacy, mempool privacy, wallet unlinkability, token
approval visibility, settlement visibility, and output-recipient privacy are
different properties. The product must say which are provided and which are
not before making any privacy claim.

The design must also answer:

- whether funds enter from the current Kohaku private balance or another
  shielded asset system;
- where token conversion occurs and what becomes public on-chain;
- how gas and fees are funded without relinking identities;
- whether approvals, intents, and settlement use a relayer or private order
  flow;
- how change and output accounts are derived;
- what the venue, RPC provider, relayer, and global observer can correlate;
- how an unavailable private route fails without a regular fallback.

## Mainnet gate

Mainnet is a later contract version, not a configuration toggle. It requires a
production custody boundary unavailable to the agent process, audited venue and
contract allowlists, token-risk policy, simulation, bounded approvals, fee and
slippage ceilings, durable nonce/idempotency handling, reorganization-aware
reconciliation, emergency disable/revocation, and explicit operator rollout.

The Sepolia placeholder must not contain dormant mainnet endpoints, chain
switches, or a generic signer that could be enabled accidentally.
