# Conversation evals

`ideal-flows.json` is the reviewable UX contract for Hermes. Each flow records:

- the participant's natural-language request;
- the exact MCP calls Hermes should own;
- the expected structured result and compact MCP presentation hint;
- the ideal participant-facing response;
- the maximum number of visible lines.

Run the deterministic suite with:

```sh
npm run eval
```

The runner connects an MCP client to the real Agent Boost MCP server over an
in-memory transport and replays every tool step against a fake wallet runtime.
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
`--model` to pin inference, and `--report` to write a private-permission JSON report. The runner
creates a disposable `HERMES_HOME`, exposes only the fake Agent Boost MCP
toolset, preloads the checked-in skills, grades participant-visible responses
and the exact tool trace, and removes the profile afterward. It inherits the
operator's normal inference-provider environment but never copies their
sessions, memory, rules, or MCP configuration. Keep live-wallet smoke tests
separate and never use them for an `indeterminate` request.
