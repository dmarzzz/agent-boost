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
`--model` to pin inference, `--base-url` for a local OpenAI-compatible model,
and `--report` to write a private-permission JSON report. Live cases
include saved-wallet discovery, ambiguous loads with a bare friendly-name
follow-up, already-active loads, the
load/switch/reauthorize sequence, named-source switch/reauthorize/send intent
preservation, regular-transfer confirmation and status, and explicit
cancellation. The plain wallet-overview regression uses the exact
production wording and leaves the skill behind Hermes progressive discovery;
both direct tree cases require the complete response byte-for-byte. The other
cases explicitly preload only the checked-in intent specialist for that chat
turn: planning turns never receive apply/execute instructions, while a later
approval or rejection receives the matching confirmation specialist. The
runner creates a disposable `HERMES_HOME`, exposes only the fake Agent Boost MCP toolset, grades
participant-visible responses and the exact, chat-turn-tagged tool trace, and
removes the profile afterward. Policy confirmation and saved-wallet
reauthorization are graded per turn, so a correct aggregate call order cannot
hide a call made before its user confirmation. For a ready setup, the grader
accepts either a status read or an idempotent setup start from a blank profile;
covered-egress capabilities are optional, while the complete wallet tree block
must still match byte-for-byte. It inherits the operator's normal
inference-provider environment but never copies provider credentials, sessions,
memory, rules, or MCP configuration. If that environment has no auto-selectable
provider, pass both `--provider` and `--model` explicitly. Keep live-wallet
smoke tests separate and never use them for an `indeterminate` request.
