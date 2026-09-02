# Private inference provider roadmap

Reviewed September 2, 2026. This document separates privacy properties that
are easy to blur together. “Private inference” is not one interchangeable
claim.

## Deployment choices for the ACI release

Agent Boost is the relying-party client. It needs an ACI-compatible HTTPS
endpoint, a model identifier, a local model allowlist, a credential for that
endpoint, and a trust policy.

| Deployment | What the Agent Boost operator supplies | Who runs the gateway |
| --- | --- | --- |
| Hosted ACI service | Hosted endpoint API key, model, allowlist, and reviewed compose/session pins | The hosted service, such as an ACI-compatible RedPill or Phala deployment |
| Own ACI gateway | Downstream Agent Boost credential, gateway URL, model, and pins; provider-side deployment also needs dstack secrets and confidential-upstream credentials | The Agent Boost product/operator team in a dstack TEE |
| Customer-owned ACI gateway | Customer gateway URL, customer-issued credential, model, and customer-approved pins | The customer in its own dstack environment |

Using a hosted ACI service does **not** require the Agent Boost user to deploy
`private-ai-gateway`. The configured endpoint already performs that role.

Operating a gateway does require deploying the Rust gateway workload under
dstack/TDX (or an ACI-compatible implementation with equivalent evidence),
provisioning its keys through dstack KMS, publishing TLS bound to the attested
keyset, and configuring at least one supported confidential upstream. An
identity-only gateway has no inference route. A generic unverified OpenAI
upstream does not become confidential merely because the gateway is in a TEE;
the upstream adapter must verify and enforce the provider-side channel too.

The downstream key Agent Boost sends and the upstream provider key stored by a
self-hosted gateway are different credentials:

```text
Agent Boost -- downstream key --> attested ACI gateway
            <-- receipt --------

attested ACI gateway -- upstream provider key --> verified confidential model
```

For a hosted service, the user usually manages only the first key. For a
self-hosted service, the gateway operator manages both sides. Future device
authorization can replace manual downstream key entry where the service
supports it.

## Privacy property matrix

| Route | Prompt hidden from intermediary/operator | Prompt hidden from model provider outside protected compute | Requests unlinkable to user/session | Payment/authorization privacy | Current integration cost |
| --- | --- | --- | --- | --- | --- |
| **ACI** | Yes, from the gateway host after attestation; measured middleware is inside the trusted workload | Yes only for a verified confidential upstream | No inherent unlinkability | Conventional API credential | Low; Node/Bun SDK is imported in-process |
| **OpenAnonymity / oa-chat protocol** | OA org, station, and verifier are outside the inference data path | No; the inference provider receives plaintext prompts | Core goal: blind-signed ticket redemption and fresh ephemeral keys provide identity and cross-session unlinkability | Blind-signed tickets issue anonymous ephemeral keys | Medium/high; browser reference code must become a headless Agent Boost adapter |
| **zkAPI** | In direct-OpenRouter mode the zkAPI server does not receive prompts or responses | No; OpenRouter receives the LLM traffic unless paired with a confidential provider | Private notes, local Groth16 proofs, and short-lived keys reduce linkage; reuse settings trade proof cost for linkability | Private prepaid credits and ZK authorization | High; current client is a Rust local daemon with chain/proving state |

These systems are complementary. A future composition could use unlinkable or
ZK-funded authorization to obtain an ephemeral credential for an ACI-backed
confidential endpoint. That could provide both content confidentiality and
identity unlinkability, but the composition must be evaluated end-to-end:
stable IP addresses, model choices, timing, ticket batch size, key reuse,
receipts, and Agent Boost's own state can reintroduce linkability.

## Adapter architecture

The public Agent Boost tool should remain stable while providers vary behind
`PrivateInferencePort`. Every adapter must publish machine-readable properties
rather than inherit the generic label “private”:

- `content_confidentiality`: who can see prompt/response plaintext;
- `identity_unlinkability` and `cross_session_unlinkability`;
- `authorization_privacy` and key lifetime;
- `origin_ip_hidden`, `timing_hidden`, and `traffic_shape_hidden`;
- verifier type, trust roots, release pins, and receipt/evidence type;
- provider/model allowlists, direct fallback, limits, and retention;
- whether the calling Hermes model saw input and output.

Dynamic policy selects a route by required assurance, not provider brand. A
policy check containing confidential facts requires verified content
confidentiality; OA or zkAPI unlinkability alone is insufficient because the
model provider still sees the facts. If a policy only needs unlinkable access,
an ephemeral-key route may be sufficient. Missing assurance fails closed.

## OpenAnonymity adapter requirements

`oa-chat` is a browser chat application and reference client, not a drop-in
Node inference SDK. The reusable protocol pieces are Privacy Pass ticket
blinding/unblinding, ticket issuance and redemption, ephemeral provider keys,
station/org signatures, and verifier checks.

A headless Agent Boost adapter will need to:

1. provide an explicit invitation/ticket onboarding flow without putting
   credentials or raw tickets in Hermes chat;
2. port or package the pure-JavaScript blind-signature client for Node/Bun;
3. store tickets with owner-only local permissions and keep ephemeral API keys
   in memory;
4. verify station/account privacy settings before inference;
5. decide whether to reproduce OA's encrypted network relay or require a
   separate covered route, and never silently fall back directly;
6. rotate keys per private session and report the chosen reuse/linkability
   tradeoff;
7. preserve OA's exact claim: unlinkability, not prompt secrecy from the model
   provider.

## zkAPI adapter requirements

The fastest prototype is a loopback adapter to `zkapi client`, whose daemon
already exposes OpenAI Chat Completions and Responses on `127.0.0.1:11434`.
That would be two running binaries and therefore does not satisfy the final
packaging goal.

A production integration must choose one of three paths:

- keep the Rust daemon as an explicitly managed optional dependency;
- embed its checked Rust executable as a signed platform asset in one
  distributable and supervise it as a child process;
- move Agent Boost's shipping runtime to Rust or expose stable Rust library/FFI
  boundaries rather than reimplement proof and wallet logic.

The adapter also needs a separate onboarding and risk review because zkAPI may
fund real on-chain credit vaults, creates local proof/nullifier state, has
recovery and double-spend semantics, and can use real USDC plus gas. It must
default to a disposable/test deployment until the custody and value boundary
is deliberately expanded. Direct-OpenRouter mode should require the advertised
capability and reject downgrade to legacy proxy mode when prompt exclusion is
part of the requested policy.

## Recommended sequence

1. Ship ACI as the only enabled adapter and keep the provider name explicit in
   capability output.
2. Add a provider-neutral capability schema and assurance selector before a
   second adapter ships.
3. Build OpenAnonymity ticket issuance/redemption as a credential module, then
   pair it with an inference transport.
4. Prototype zkAPI over loopback, measure proof latency and state/recovery
   burden, and decide the one-artifact packaging strategy before promising it.
5. Test composed routes adversarially; do not infer combined privacy from the
   sum of two component marketing claims.

Primary references:

- [ACI private-ai-gateway](https://github.com/Dstack-TEE/private-ai-gateway)
- [OpenAnonymity oa-chat](https://github.com/OpenAnonymity/oa-chat)
- [OpenAnonymity privacy model](https://github.com/OpenAnonymity/oa-chat/blob/main/docs/PRIVACY_MODEL.md)
- [zkAPI Ethereum Foundation collaboration](https://github.com/OpenAnonymity/zkapi-EF-collab)
