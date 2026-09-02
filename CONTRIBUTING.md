# Contributing

Agent Boost is a research-preview privacy sidecar for AI agents. The code is
unaudited (see [`SECURITY.md`](SECURITY.md)) and the wallet path is Sepolia-only
by design. Contributions are welcome; this page is how to run the tests and the
house rules a change must hold to.

## Run the tests

```console
npm ci
npm run check          # TypeScript, no emit
npm test               # the full suite under test/
npm run build          # dist/ plus copied assets
npm run release:smoke  # clean-install smoke, what CI runs per platform
npm run eval           # golden Hermes conversation evals
node dist/cli.js doctor
```

`npm test` runs every `test/**/*.test.ts` serially through the Node test runner.
Drop a new `*.test.ts` under `test/` and it is picked up; there is no manifest.
`npm run eval:live` needs a running Hermes and is not part of CI.

## Definitions of done

Every change is expected to meet these before it lands:

- **Every new behavior ships a test.** Policy, idempotency, permissions, argv
  shape, RPC allowlists, MCP schemas, and UI honesty are all tested today; keep
  that coverage moving with the code.
- **Every surface that reads untrusted input gets adversarial cases.** A parser,
  an allowlist, a state machine, or an RPC response handler needs negative tests
  that fail on a real defect: garbage in is rejected with a precise reason, a
  tampered field is refused, a flipped comparison would be caught.
- **No secret is ever returned, logged, or passed as an argument.** Not a seed,
  key, wallet password, raw note or proof, raw PCZT or signed transaction, route
  credential, or provider API key. The capability contract in
  [`docs/CAPABILITY-CONTRACT.md`](docs/CAPABILITY-CONTRACT.md) is the list of
  what the agent may see; extend it deliberately, in the same change, or not at
  all.
- **Docs are updated in the same change**, never deferred. If you touch a tool
  schema, update the capability contract; if you touch the threat surface,
  update `docs/THREAT-MODEL.md`; if you touch setup or a command, update the
  README.
- **No new dependency without a note on why.** Prefer the standard library and
  what is already in `package.json`.
- **Honest scope.** If a task is only partly done, split it and say what
  remains rather than implying it is complete.

## Trust-model invariants

These are load-bearing. A change must not break them; if a change appears to
need to, that is a design discussion, not a quiet edit. All are grounded in
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

- **The model gets the decision surface, not the signing surface.** Tools return
  addresses, balances, readiness, policy decisions, and durable outcomes. Signing
  happens behind the sidecar.
- **Fail closed.** A missing route, an unreachable RPC, a malformed field, an
  unresolved request: reject with a precise reason, never fall through to an
  open or trusting default. No direct fallback for Tor-routed RPC or covered
  egress.
- **Sepolia only.** Mainnet and non-Sepolia endpoints are rejected by
  configuration. Do not add a switch that relaxes this.
- **A payment is planned once, confirmed verbally, and executed within a
  one-use, expiring delegation.** Terms cannot change between plan and execute.
  Stable client IDs make retries idempotent.
- **Wallet commands are a fixed allowlist with validated fields and no shell.**
- **Covered egress and private inference are explicit and bounded.** They route
  the one request they were asked to route and nothing else, and they never
  present themselves as whole-agent privacy.
- **Same-user isolation is a known non-goal.** Do not describe skill
  instructions as enforcement.

## Code style

- **Match the surrounding code.** TypeScript ESM, the existing import and error
  conventions, the existing naming. Read the neighbours before adding a file.
- **Comment the why.** The existing code explains why a check exists and what it
  closes, not just what the line does. A security check with no rationale is
  hard to review and easy to delete.
- **No em dashes** in prose or comments. Use a comma, a colon, or a full stop.
- **No marketing.** Terse and accurate. Say what a thing does and what it does
  not.

## Never taken autonomously

Some actions must be flagged for a human rather than done by an agent or a
contributor on their own: enabling any non-Sepolia network, spending real
funds, widening a delegation limit or a tool allowlist, adding a direct network
fallback, changing what the agent can see, or merging to `main` without CI
green.
