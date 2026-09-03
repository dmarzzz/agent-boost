# Product philosophy

## The model is not the integrity boundary

Agent Boost must remain correct when the agent model is distracted, confused,
bad at arithmetic, carrying stale context, or simply not very capable. A better
model should make the experience more fluent and delightful. It must not be the
thing that makes balances, permissions, privacy, or payments correct.

That is our central engineering rule:

> Build the rails for the weakest supported model. Let stronger models improve
> the ride, not determine whether it stays on the track.

The agent is a probabilistic planner and conversational interface. Deterministic
software owns facts, calculations, validation, policy, secrets, and side effects.

## What this means in practice

### Live facts come from live tools

A balance, readiness state, allowance, price, or transaction status is never
answered from chat history, model memory, onboarding copy, or a previous tool
result. The agent reads it again in the same turn.

Tools return the exact human-readable value the agent should present. The model
does not convert wei, combine balances, infer readiness, or reconstruct a fact
from raw fields. There is one canonical answer for each ordinary question.

The balance incident that shaped this rule was simple: the chain value was
correct, but an agent reused old context and rendered roughly `68.899 ETH` as
`0.068 ETH`. The RPC had not failed. The product had asked a language model to
do work deterministic software should have completed.

### Prompts guide behavior; code enforces truth

System prompts, skills, and tool descriptions make the intended path obvious.
They are useful UX, not a security boundary. Anything important is also
enforced at the tool or service layer:

- chain and asset restrictions;
- balance ownership and account semantics;
- approval requirements and spending limits;
- idempotency and replay protection;
- secret redaction and public-data allowlists;
- fail-closed routing and explicit degraded states.

If a model ignores an instruction, the safe result is a refusal or a clearly
unavailable action—not a plausible but incorrect answer.

### The user speaks like a person

Users should never need to know tool names, decision IDs, request IDs, wei,
configuration syntax, or process topology. They ask a natural question, approve
an exact human-readable action when needed, and receive a concise answer.

Advanced controls can exist, but they must not leak into the sane default. The
default experience should feel obvious: one clear next step, no ceremony, and
no requirement to understand the machinery underneath it.

### Privacy is the default presentation

Public-on-chain does not mean "display everywhere." A wallet address may be
necessary inside the trusted tool boundary while still being unnecessary in a
chat response, screenshot, analytics event, or onboarding URL.

Every surface gets the minimum data it needs. Public loadout pages receive only
allowlisted feature flags. Normal balance replies contain the balance, not the
address. Secrets and signing material never enter the model conversation.

### Delight sits on top of clarity

Personality, playful framing, ASCII art, memes, and emojis can make security
concepts memorable. They should reduce anxiety and explain the product—not hide
risk or compete with the next action.

Be fun about activation. Be exact about money. Be unmistakable about failure.

### Sessions are versioned product state

Long conversations accumulate old facts and old assumptions. Deploying new code
does not magically remove them. Changes to tool contracts, safety behavior, or
onboarding semantics must include an explicit session strategy: reload the
capabilities, rotate stale sessions while preserving history, or prove that the
existing session receives the new contract.

"Restarted" is not the same as "upgraded," and "upgraded" is not the same as
"the active conversation is using it."

### Done means proven in the real path

A change is shipped only when all of these are true:

1. The code and behavioral contract are committed and pushed.
2. Automated checks pass.
3. The exact artifact is installed in the target environment.
4. The owning service is restarted or reloaded.
5. The real model, real tool registry, and real runtime complete the user flow.
6. Logs confirm the required tool call and the final user-visible result.

A unit test can prove formatting. An MCP probe can prove connectivity. Only an
end-to-end agent turn proves the product experience.

## Review questions

Before merging a user-facing capability, ask:

- What happens if the model thinks it knows the answer and skips the tool?
- What happens if it performs the arithmetic incorrectly?
- What stale information can survive in an existing session?
- What is the smallest result the model needs to see?
- Can a private identifier be omitted from the default UI and reply?
- Is an uncertain side effect represented as uncertain?
- Does a retry remain safe?
- Has this been exercised with the weakest supported model and the full tool
  catalog?
- Was the exact deployed runtime tested, rather than a nearby local build?

If correctness depends on answering any of these with "the model should know,"
the feature is not finished.
