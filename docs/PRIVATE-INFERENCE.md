# Private inference product requirements

Status: first module implementation; opt-in and fail-closed. The ACI gateway is
developer-preview infrastructure, so this is not yet a production privacy
guarantee.

## Product definition

Agent Boost gives a user or agent an explicit way to run a second inference in
an attested confidential-computing environment. Hermes itself does not need to
run privately. Agent Boost verifies the remote workload before releasing the
inference credential, restricts requests to an operator allowlist of TEE
models, binds traffic to the attested TLS key, and verifies a signed receipt
before returning an answer.

Agent Boost imports the TypeScript ACI client and verifier. It does not embed or
launch the Rust `private-ai-gateway`: the gateway, broker, and inference runtime
belong inside the provider's dstack deployment. This keeps the local module
in-process and compatible with a future single executable.

The product has two consumers:

- A person can ask the agent to use private inference for a discrete question.
- An agent can choose the tool for a sensitive subproblem or Agent Boost can
  invoke the same module internally as a dynamic policy evaluator.

## Privacy contract

The first release protects the explicit second inference from the gateway host
and the model provider outside the verified TEE. It verifies workload identity,
the serving path, exact request and response body receipts, and—when configured—
a reviewed release hash or serving session.

It does **not** make Hermes or the current conversation private. In a normal MCP
tool call, Hermes' primary model sees the tool name and arguments before Agent
Boost receives them, and it sees the returned answer. The module also does not
hide the user's IP address, request timing, traffic shape, local logs, screen,
keyboard, malware, or compromise inside the measured workload. It never routes
inference through Shade Tree because covered egress currently permits only
uncredentialed GET/HEAD requests, not model POST bodies.

The UI, capability manifest, and tool result MUST preserve this distinction:

- `confidential from infrastructure outside the TEE`: yes, after verification;
- `confidential from the calling Hermes model`: no;
- `anonymous network access`: no;
- `direct non-TEE fallback`: never.

## User and agent flows

### Explicit private query

1. The user or agent chooses `private_inference_query` for one subproblem.
2. Agent Boost validates the local model allowlist and input bounds.
3. The ACI client verifies attestation, the measured workload, and TLS binding
   before Agent Boost sends the API key or prompt.
4. Agent Boost discovers the live TEE-only model catalog over the verified
   channel and rejects absent or incompatible models.
5. The request is sent through the pinned channel with no direct fallback.
6. Agent Boost consumes the bounded response and returns it only after the
   signed receipt and any cited serving session verify.

### Dynamic policy evaluation

1. A local operation computes its ordinary static decision: `allow`, `confirm`,
   or `deny`.
2. Agent Boost gives the confidential evaluator an operator-owned policy,
   action name, and bounded JSON facts. Facts are untrusted data, not
   instructions.
3. The evaluator returns a strict JSON decision and short reason.
4. Agent Boost selects the more restrictive of the static and model decisions.
5. Any timeout, verifier failure, malformed answer, unavailable model, or other
   error becomes `deny`.

Dynamic policy is deliberately **restrict-only**. It cannot turn `deny` into
`confirm` or `allow`, cannot raise a spending limit, cannot bypass user
confirmation, and cannot create signing authority. Local hard limits and
static policy remain authoritative. The internal evaluator ships with this
module; wiring it into payment execution is a separate release gate and is
reported as `wallet_enforcement_wired: false` until that work is complete.

## Functional requirements

- **PI-001 — Discoverability:** MCP always exposes capability and status tools,
  including when the feature is disabled.
- **PI-002 — Explicit invocation:** inference runs only from an explicit tool or
  an internal policy call; it is not a blanket proxy for Hermes traffic.
- **PI-003 — In-process integration:** the local product imports the ACI client
  libraries and starts no private-inference sidecar.
- **PI-004 — Verify before secrets:** no API key or prompt may leave Agent Boost
  before attestation and channel binding succeed.
- **PI-005 — TEE-only models:** model discovery must set `isTeeOnly`, apply a
  local allowlist, and reject a model missing from the verified catalog.
- **PI-006 — Release policy:** production configuration must pin reviewed
  compose hashes. Hardware-only mode is explicit and accurately reported as
  not release-pinned.
- **PI-007 — Serving policy:** optional accepted session IDs constrain brokered
  serving. Receipt verification must validate any cited session.
- **PI-008 — Receipt gate:** response-completion verification is mandatory; an
  answer is not returned before its receipt verifies.
- **PI-009 — No fallback:** verifier or provider failure blocks the call. Agent
  Boost never retries against an ordinary provider.
- **PI-010 — Local bounds:** request characters, output tokens, response bytes,
  time, model IDs, and receipt history are bounded.
- **PI-011 — Secret handling:** the API key is accepted only from process
  configuration, attached only to inference POSTs, never returned through MCP,
  and never included in public errors or status.
- **PI-012 — Redacted failures:** public errors reveal stable local codes and at
  most an HTTP status; they do not return upstream bodies, URLs, verifier
  internals, paths, credentials, prompts, or responses.
- **PI-013 — Lifecycle:** connections are lazy, process-scoped, reused while
  valid, and closed during runtime shutdown.
- **PI-014 — Auditable results:** a successful query reports the model, receipt
  ID, attestation/receipt state, release-pinning state, and privacy exclusions.
- **PI-015 — Agent-safe descriptions:** tool metadata states that the primary
  model sees arguments and results and that prior conversation content is not
  retroactively protected.

## Dynamic policy requirements

- **DP-001 — Trusted policy source:** policy text comes from operator-controlled
  configuration, not from model output or external content.
- **DP-002 — Untrusted facts:** web pages, tool output, transaction metadata, and
  other facts are serialized as data and cannot change the policy contract.
- **DP-003 — Closed decision set:** the only accepted decisions are `allow`,
  `confirm`, and `deny`, in exact JSON with a bounded reason.
- **DP-004 — Monotonic restriction:** `effective = max(static, dynamic)` under
  `allow < confirm < deny`.
- **DP-005 — Fail closed:** unavailable or invalid evaluation produces `deny`.
- **DP-006 — No authority transfer:** dynamic inference receives no key material
  and cannot sign, broadcast, execute, mutate limits, or mark user confirmation.
- **DP-007 — Automatic enforcement:** when enabled for an operation in a future
  release, Agent Boost invokes it inside the plan/execute boundary. The agent
  cannot opt out by omitting a tool call.
- **DP-008 — Explainability:** durable audit state records the static decision,
  dynamic decision, effective decision, policy version, receipt ID, and a
  redacted reason; it does not persist secret facts by default.
- **DP-009 — Rollout:** start in shadow mode, compare decisions, test adversarial
  facts, then enable restrict-only enforcement per operation.

## Configuration

Private inference is disabled by default. Enabling it requires an API key, a
default model, and an allowlist containing that model. The safer
`reviewed_release` trust mode also requires at least one independently reviewed
64-character compose hash.

```sh
export AGENT_BOOST_PRIVATE_INFERENCE_ENABLED=true
export AGENT_BOOST_PRIVATE_INFERENCE_BASE_URL=https://tee.redpill.ai/v1
export AGENT_BOOST_PRIVATE_INFERENCE_API_KEY=replace-me
export AGENT_BOOST_PRIVATE_INFERENCE_MODEL=provider/model-id
export AGENT_BOOST_PRIVATE_INFERENCE_MODEL_ALLOWLIST=provider/model-id
export AGENT_BOOST_PRIVATE_INFERENCE_TRUST_MODE=reviewed_release
export AGENT_BOOST_PRIVATE_INFERENCE_ACCEPTED_COMPOSE_HASHES=<reviewed-64-hex-hash>
```

Compose hashes must come from authenticated release metadata reviewed by the
operator. Copying the current hash from the endpoint and trusting it on first
use defeats release pinning. `hardware` mode exists for evaluation and verifies
the TEE and measured compose but accepts any measured release.

Optional limits:

- `AGENT_BOOST_PRIVATE_INFERENCE_ACCEPTED_SESSION_IDS`
- `AGENT_BOOST_PRIVATE_INFERENCE_REQUEST_TIMEOUT_MS` (default `120000`)
- `AGENT_BOOST_PRIVATE_INFERENCE_MAX_INPUT_CHARS` (default `32768`)
- `AGENT_BOOST_PRIVATE_INFERENCE_MAX_OUTPUT_TOKENS` (default `2048`)
- `AGENT_BOOST_PRIVATE_INFERENCE_MAX_RESPONSE_BYTES` (default `1048576`)

## Single-executable path

The selected ACI packages are ESM TypeScript/JavaScript and have no private
gateway process to supervise. The current Agent Boost distribution remains an
npm-installed Node application and separately installs wallet/egress helpers,
so it is one command but not yet one physical binary. The packaging sequence is:

1. keep private inference in-process and isolate it behind `PrivateInferencePort`;
2. add a Bun compiled-executable or Node SEA build for Agent Boost;
3. embed or securely unpack required wallet/egress assets for each supported
   platform;
4. run clean-machine signature, update, rollback, and reproducibility tests;
5. call it “one binary” only when no runtime npm install or adjacent executable
   is required.

## Release gates and roadmap

The first release is complete when offline contract tests, injected-provider
tests, TypeScript checks, the full Agent Boost suite, and a clean package build
pass. A live gateway smoke test additionally requires operator-provided
credentials and reviewed release pins; it must never silently switch to
hardware-only trust.

The September 2, 2026 production-dependency audit reports four low-severity
entries rooted in `elliptic` advisory GHSA-848j-6mx2-7j84 through
`@phala/dcap-qvl`, with no automatic fix available. This does not fail the
research-preview gate, but production assurance requires upstream remediation
or an independently reviewed verifier substitution.

Two later features close the primary-agent visibility gap:

- **Opaque artifact inference:** Agent Boost reads a locally protected artifact
  by handle and sends its contents directly to the TEE; Hermes sees the handle,
  instruction, and returned answer, but not the artifact body.
- **Pre-model private route:** a local `/private` input path is intercepted before
  Hermes' primary remote model receives the text. Agent Boost sends it directly
  to the confidential model and renders the answer locally.

Those modes need separate UX, access control, retention, injection defenses,
and audit requirements. They must not be implied by the explicit MCP query
shipped here.

Future OpenAnonymity and zkAPI routes are intentionally separate adapters with
different assurance claims. See
[PRIVATE-INFERENCE-PROVIDERS.md](PRIVATE-INFERENCE-PROVIDERS.md) for the
hosted/self-hosted ACI deployment split, privacy-property matrix, and adapter
requirements.
