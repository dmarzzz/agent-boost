---
name: agent-boost-setup
description: Set up and fund a local Sepolia wallet conversationally.
version: 0.3.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [wallet, privacy, setup, mcp]
    category: tools
---

# Set up Agent Boost

Use this skill whenever the user asks Hermes to integrate, initialize, set up,
or fund Agent Boost. The one-time Agent Boost installation has already
configured Hermes. From this point onward, keep the participant in the Hermes
conversation and the local funding page; do not ask them to use a terminal.

This setup skill is intentionally unconditional. It remains discoverable when
the Agent Boost MCP toolset has not loaded, so it can give accurate reload
guidance instead of trying to bootstrap through an unavailable tool.

## Conversation contract

Use four participant-facing states and no implementation vocabulary:

1. **Fund your test wallet** — show the exact remaining amount, address, and QR.
2. **Funding found** — the full amount is visible on Sepolia.
3. **Preparing the private balance** — automatic privacy preparation is still
   running.
4. **Ready** — the private balance and Tor-routed Sepolia access both passed
   verification.

Never say MCP, toolset, process lock, loopback, shielding transaction, or
Tornado unless the user asks for technical detail. Never promise anonymity.

## Dark Mode opening

For a new setup only, wait until `capabilities` confirms the real starting
state, then open with this compact Matrix- and terminal-safe reveal. Never
replay it when resuming an existing setup.

```text
        \  |  /
      --  ☀  --
        /  |  \
           ↓
          ◐
           ↓
          ●

 D A R K  M O D E
   entering the chat…
```

Follow it with only the lines supported by the live capability result:

```text
The vault combination stays home. I’m printing Hermes a tiny permission slip instead. 🪪
💳 Spawning a disposable test wallet…
🕶️ Creating the private payment pocket…
🧅 Adding layers to the wallet route…
🌳 Leaving covered web asleep… shhh
🙋 Payments will knock first.
🔐 Default permission: 10 sends · up to 1 Sepolia ETH each.
Like turning knobs? Say advanced setup ⚙️
```

Do not report fake percentages or mark a capability ready before its check
passes. On resume, skip the theater and state only the current action.

## Public capability receipt

The shareable explainer is `https://agent-boost-phi.vercel.app/`. It is a static,
stateless receipt. Put only coarse feature state in its URL fragment; never put
an address, balance, amount, transaction, setup ID, timestamp, credential, or
other identifier in the URL. Use version `1` and only these keys:

- `eth`, `spend`, and `zec`: `ready`, `setup`, `off`, `attention`, or
  `unavailable`;
- `tor`: `wallet`, `setup`, `off`, `attention`, or `unavailable`;
- `shade` and `think`: `on`, `setup`, `off`, `attention`, or `unavailable`.

Example:

```text
https://agent-boost-phi.vercel.app/#v=1&eth=ready&spend=ready&zec=off&tor=wallet&shade=off&think=off
```

The receipt is explanatory, not authoritative. Construct its fragment only
from the latest tool results. Send it as **View your agent’s loadout 🎒** after
readiness, or when the user asks what is enabled. A remote Hermes cannot open a
browser on the participant’s device, so send a clickable link; do not claim it
opened. Keep the local funding page as an optional same-device fallback only.

## Start, resume, or resend

1. Call `capabilities` with no arguments. If it is unavailable, say that Hermes
   needs one refresh, then give only the commands appropriate to this channel:
   `/reload-skills` followed by `/reload-mcp` locally, or `!reload-skills`
   followed by `!reload-mcp` over Matrix. A single Hermes restart is the
   alternative. Do not edit config, invoke a shell, or ask the user to open a
   terminal.
2. Require Sepolia (`eip155:11155111`), `testnet_delegated` authority,
   `mainnet_available: false`, and a ready Tor RPC route with
   `direct_fallback: false`. Then call `onboarding_start` with no arguments.
   Repeated calls resume the same durable setup and address.
3. Preserve `data.setup.setupId` and `data.setup.revision` exactly. Treat
   `data.ui_opened` only as a fact about a browser on the Agent Boost host. If
   true, you may say that the local funding window opened. Never mention or
   offer `localhost`, `127.0.0.1`, a loopback URL, or a local filesystem path.
4. When `data.funding.remaining_amount_wei` is greater than zero, immediately
   present the tool-returned QR. The gateway owns MCP image delivery; never
   copy, repeat, transform, or manually send a `MEDIA:` tag.

   On Matrix, create this mobile-friendly sequence:

   1. Use `send_message` with `action: send` and `target: matrix` for one short
      instruction: send exactly the server-provided `remaining_amount_eth`
      Sepolia ETH, Sepolia ETH has no real or redeemable value, and reply with
      **✅** or say **sent** after submitting the transfer. Do not include the
      address or funding URI in this event.
   2. Make the final visible response exactly the server-provided funding
      address. No label, prefix, suffix, punctuation, Markdown, backticks, or
      code fence. The gateway will append the QR as its own image event.

   If `send_message` is unavailable, keep the final response compact: exact
   amount and warning, the address on a line by itself, then “Reply ✅ or say
   sent after you send it.” The QR still attaches automatically. The exact
   server-provided `funding_uri` is the fallback only when the image is absent
   or the user asks for a wallet link.
5. Do not begin a 90-second status loop while the participant still needs to
   fund. End the turn after presenting the funding details. Any clear indication
   that the transfer was sent—such as **sent**, **done**, **funded**, **✅**, or
   **👍**—is the conversational handoff back to Hermes. Never require a magic
   word or command syntax.
6. On a resumed setup, branch on the returned state before sending funding
   instructions: `private_ready` goes directly to completion verification;
   `funded_public` or `shielding` goes to the private-balance status flow; and
   `failed` reports its public remediation and stops. Never show a zero-amount
   funding request or an old QR.

## Start a new demo wallet

When the user clearly asks to start over, reset the demo, or create a fresh
wallet, do not call `onboarding_start`: it intentionally resumes the existing
wallet. Explain in one sentence that the current local demo and any unresolved
request will be archived, the old Kohaku wallet will be retained locally, and a
new wallet will need fresh Sepolia funding. Ask for ordinary confirmation.
After approval, call `wallet_start_new_demo` yourself with
`user_confirmed: true`. Present its returned funding QR and exact remaining
amount using the same funding interaction above. Never ask the user for tool
syntax or a boolean, never invoke the reset without confirmation, and never
describe it as deleting or retrying the prior payment.

## When the participant indicates they sent funds or asks for status

1. If the current conversation contains the latest `setupId` and `revision`,
   call `onboarding_status` with those exact values and `wait_ms: 30000`. If
   either value is unavailable, call `onboarding_start` once to resume and
   recover them.
2. If the phase remains `awaiting_funding` or `funding_pending`, report only the
   exact server-provided remaining Sepolia ETH and say that it is not fully
   visible yet. Ask the participant to wait briefly and reply **check again**.
   Do not resend the QR unless they ask to see it again.
3. When the phase becomes `funded_public` or `shielding`, say **Funding found.
   Preparing the private balance now.** Then make at most one
   `onboarding_status` call with the latest revision and `wait_ms: 90000` in
   this turn. If it is still running afterward, say so and ask the participant
   to reply **check again**; do not hold the conversation in an unbounded loop.
4. Setup is complete only when the phase is `private_ready`,
   `privateBalanceWei` is at least `shieldAmountWei`, and a fresh
   `capabilities` call reports `readiness.rpc_egress: ready`. Then say that
   Agent Boost is ready for Sepolia test payments. Do not put the balance or
   wallet address in the capability-receipt URL. `funding_pending`,
   `funded_public`, and `shielding` are never success. Use this completion,
   with the feature fragment derived from live state:

   ```text
   ╭────────────────────────╮
   │  🌑 DARK MODE: ONLINE  │
   ╰────────────────────────╯

   The vault combination stayed home. Hermes got the menu. 😎
   💳 Ethereum test wallet — ready
   🕶️ Private payment pocket — ready
   🧅 Wallet traffic — taking the onion route
   🌳 Covered web — napping for now

   [View your agent’s loadout 🎒](<capability-receipt URL>)

   Ready to take Dark Mode for a spin? 🚀
   You can say advanced setup anytime to change send limits or expiry.
   ```
5. Preserve the newest revision after every status result. Narrate only the four
   participant-facing states above; do not print raw phase names or wei unless
   the user asks.

## Safety

- Never ask for or expose a seed phrase, private key, keystore password, raw
  signed transaction, RPC credential, or wallet adapter credential.
- Never substitute mainnet or another chain. This POC is Sepolia-only.
- Never bypass the Agent Boost flow with a shell, browser wallet integration,
  or unrelated network tool. The local funding page is display-only.
- If status is failed or indeterminate, report the returned remediation and
  stop. Do not create a replacement wallet or repeat a shielding transaction.

## Verification

Before saying setup is ready, `onboarding_status` must report `private_ready`
with `privateBalanceWei >= shieldAmountWei`, and a fresh `capabilities` call
must report `readiness.rpc_egress: ready`. A visible public balance, a submitted
shield transaction, or an open funding page is not successful setup.
