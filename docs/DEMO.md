# Run the demo

The full walkthrough of the three conversations the README shows, plus the security policy and the conversation evals.

## 1. Set up the wallet

Tell Hermes:

> Set up Agent Boost for me.

Hermes calls `onboarding_start`. Agent Boost creates or resumes one durable
Sepolia setup and opens the funding page. The page shows an EIP-681 QR code for
the exact remaining amount, the full address, public funding progress, and
private-balance progress. When Hermes needs to carry the QR into the
conversation, Agent Boost returns it in a branded dark-sidecar card while
preserving a conventional high-contrast scan field.

Scan the QR and send the amount shown—normally `0.2` Sepolia ETH. Then reply
with ✅ or tell Hermes you sent it. Partial funding is supported: the funding
page and a resumed QR automatically use the remaining amount. Do not send ETH
on mainnet or another network.

After your acknowledgement, Hermes uses bounded status checks without flooding
or holding the conversation in an open-ended loop:

```text
creating_wallet
  → preparing_privacy
  → awaiting_funding
  → funding_pending
  → funded_public
  → shielding
  → private_ready
```

When `private_ready` appears, at least `0.1` Sepolia ETH is spendable through
the configured private-payment path. Hermes also rechecks that
`readiness.rpc_egress` is `ready` before declaring setup complete.

## 2. Inspect or change the wallet permission

New wallets start with a sane default: up to 10 sends shared by regular and private transfers, 1 Sepolia ETH
per send, 10 Sepolia ETH total, and seven days. Ask Hermes naturally:

> What are my wallet limits?

Or change any part:

> Let Hermes make 20 private sends of up to 2 Sepolia ETH each for the next 14
> days.

Hermes shows one compact permission card. Reply ✅ or say yes to apply it. This
confirmation is separate from confirming a payment. The update changes local
delegated authority only: it does not send or shield ETH, move the main balance
into the private payment pocket, add a public-main-account send route, enable
mainnet, or expose signing material.

Advanced testnet policies remain bounded at 100 sends, 100 native test tokens
per send, 10,000 total, and 30 days. Already-used sends and spent allowance
cannot be erased by lowering and re-raising a policy. Existing wallets from the
older one-send release remain one-send after upgrade until the user explicitly
previews and confirms new limits.

## 3. Send a test payment

Tell Hermes, for example:

> Send 0.02 Sepolia ETH privately to
> 0x2222222222222222222222222222222222222222.

Hermes reads current wallet context and creates a short-lived plan itself. Under
the default security policy, the client shows a native receipt with the exact
Sepolia ETH amount, full recipient address, testnet privacy warning, and
**Approve** / **Cancel** controls. Hermes owns the MCP calls, decision IDs,
atomic units, and idempotency key; the user never types them.

If the client cannot render MCP elicitation, Agent Boost returns the same
structured receipt for Hermes to read back. In that fallback only, reply ✅,
`yes`, or `send it`, and Hermes retries the unchanged decision with
`user_confirmed: true`. This remains a conversational demo control, not
independent authentication or an out-of-band approval channel.

After confirmation, Hermes executes the immutable plan with a stable request
ID. The default wallet policy permits:

- Sepolia only (`eip155:11155111`);
- native test ETH only;
- at most `1` ETH per send;
- up to 10 sends and `10` ETH total;
- execution within seven days of setup;
- no mainnet path.

Agent Boost asks Kohaku to unshield the `0.1` ETH note to a fresh payment
subaccount and append the exact recipient transfer as a tail call. The main
account is a funding source only and has no control or recovery authority over
subaccounts. Kohaku waits for UserOperation inclusion. Agent Boost stores a recipient
balance checkpoint before handing execution authority to Kohaku and keeps a
UserOperation hash distinct from an Ethereum transaction hash. It reports
`confirmed` only from Kohaku's explicit confirmation, a successful transaction
receipt, or a sufficient recipient-balance delta. Submitted and interrupted
requests are reconciled on restart and status reads without broadcasting again.
If concrete evidence is unavailable, the durable result remains `submitted` or
`indeterminate` rather than guessing.

Each attempted execution consumes one send count before Kohaku is called so an
uncertain side effect cannot be retried as if nothing happened. The seven-day
deadline applies to delegated Agent Boost execution, not to the
wallet, address, or funds. Address and balance reads remain available after it
expires. This POC currently blocks new Agent Boost transfers under an expired
delegation; the user can now preview and confirm a renewal conversationally.
The current release still requires a separately designed and confirmed recovery
transfer path before it can move those funds. Never
interpret expiry as deletion or loss of access to the encrypted wallet.

## Start a fresh demo

Tell Hermes that you want to start a new demo wallet. Hermes summarizes that
the current demo will be archived and asks for ordinary confirmation. After you
approve, `wallet_start_new_demo` drains in-flight work, archives the complete
state under the private local state directory, retains the previous Kohaku
wallet, creates a new wallet profile, and presents a fresh funding QR. An
unresolved prior payment is archived exactly as observed and is never retried.

## Fetch public data through covered egress

After the installation has been admitted to a Shade Tree Grove, tell Hermes,
for example:

> Fetch https://example.com/data.json through covered egress.

Hermes checks `egress_status`, then calls `egress_fetch` itself. Users never
handle a Proxy URL, auth token, identity secret, member set, or terminal
command. The first release permits public DNS names over HTTPS port 443, GET or
HEAD, at most three redirects, UTF-8 text/JSON responses up to 1 MiB, and a
30-second request deadline. It sends no credentials, cookies, request body, or
custom headers. Every redirect is revalidated and every returned body is
marked `untrusted_external` so content cannot become agent instructions.

This is accurately described as privacy-improving covered HTTPS egress, not an
anonymity guarantee. The destination sees a Shade Tree node address. The node
sees the destination hostname, port, timing, lifetime, and traffic volume;
end-to-end TLS hides the path, query, and body from the node. A global observer
may still correlate timing. See [Covered egress](COVERED-EGRESS.md).

## Layered security policy

Agent Boost ships with built-in defaults and merges explicit local overrides
on top:

```text
default:  wallet.read=allow, payment.plan=allow, payment.execute=confirm
override: AGENT_BOOST_PAYMENT_APPROVAL=allow|confirm|deny
effective: reported by the capabilities and payment-plan tools
```

`confirm` is the default. `allow` permits automatic execution only inside the
active Sepolia delegation; `deny` locks payment execution. Users may separately
preview and confirm count, amount, expiry, or enabled-state changes inside the
reported hard testnet bounds. No override or policy update can enable mainnet,
direct RPC fallback, arbitrary signing, or bypass adapter readiness.

## Conversation evals

The reviewable golden flows in [`evals/ideal-flows.json`](../evals/ideal-flows.json)
cover setup and QR funding, ambiguous-amount clarification, natural approval,
confirmed and indeterminate outcomes, and the local `allow`/`deny` overrides.
Run them without a wallet, network call, or model invocation:

```sh
npm run eval
```

The eval runner replays each ideal tool trace through the real MCP server using
an in-memory fake wallet. It checks structured outcomes, compact MCP hints,
maximum visible response length, QR presence, and forbidden leakage such as
tool names, internal IDs, booleans, wei, or signing material. See
[`evals/README.md`](../evals/README.md) for the boundary between this deterministic
contract eval and a live Hermes model eval.

Run the same conversations through a real Hermes model and the fake MCP runtime
in a disposable profile:

```sh
npm run eval:live -- --hermes "$(command -v hermes)" --provider <provider> --model <model>
```

This opt-in eval grades visible response length/content and the exact tool trace.
It cannot touch a wallet, Tor, Sepolia, or the user's normal Hermes sessions,
memory, rules, or MCP configuration.
