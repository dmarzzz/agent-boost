# Conversation evals

`ideal-flows.json` is the reviewable UX contract for Hermes. Each flow records:

- the participant's natural-language request;
- the exact MCP calls Hermes should own;
- the expected structured result and compact MCP presentation hint;
- each separate chat preview, approval, and cancellation turn;
- the ideal participant-facing response;
- the maximum number of visible lines.

Run the deterministic suite with:

```sh
npm run eval
```

The runner connects an MCP client to the real Agent Boost MCP server over an
in-memory transport and replays every tool step against a fake wallet runtime.
Every flow advertises MCP form elicitation as an adversarial client capability;
the suite fails if Agent Boost invokes it. Confirmation must remain in chat and
reach the matching tool as `user_confirmed: true`; explicit cancellation is
also verified without any side effect.
It never starts Tor, creates a key, contacts Sepolia, or signs a payment. It
also rejects golden responses that expose tool names, IDs, booleans, wei, MCP
syntax, or signing material.

This is a contract-level end-to-end eval, not a claim that a nondeterministic
model will always produce the golden prose. To evaluate a Hermes model or
prompt revision with a real Hermes model and the fake MCP runtime, run:

```sh
npm run eval:live -- --hermes "$(command -v hermes)"
```

Use `--case confirmed-payment-with-emoji` to run one case, `--provider` and
`--model` to pin inference, and `--report` to write a private-permission JSON report. Live cases
include saved-wallet discovery, ambiguous and already-active loads, the
load/switch/reauthorize sequence, regular-transfer confirmation and status,
and explicit cancellation. The runner
creates a disposable `HERMES_HOME`, exposes only the fake Agent Boost MCP
toolset, preloads the checked-in skills, grades participant-visible responses
and the exact tool trace, and removes the profile afterward. It inherits the
operator's normal inference-provider environment but never copies provider
credentials, sessions, memory, rules, or MCP configuration. If that
environment has no auto-selectable provider, pass both `--provider` and
`--model` explicitly. Keep live-wallet smoke tests
separate and never use them for an `indeterminate` request.
