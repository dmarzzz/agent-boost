---
name: agent-boost-setup
description: Guide local Sepolia wallet setup and funding.
version: 0.1.1
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

## Procedure

1. Call `capabilities` with no arguments. If it is unavailable, explain that
   the files are installed but this Hermes session has not loaded them. Ask the
   user to enter `/reload-skills` and then `/reload-mcp` in the local CLI, or
   `!reload-skills` and then `!reload-mcp` over Matrix, or restart Hermes once.
   Do not edit config, invoke a shell, or ask the user to open a terminal.
2. Confirm that the capability reports Sepolia (`eip155:11155111`),
   `testnet_delegated` authority, `mainnet_available: false`, and a ready Tor
   RPC route with `direct_fallback: false`. Then call
   `onboarding_start` with no arguments. Repeated calls resume the same durable
   setup; they never create or replace another wallet.
3. Read `data.setup` and `data.funding` from the structured result. Preserve
   `setupId` and `revision` exactly. Treat `data.ui_opened` only as a fact about
   a browser on the Agent Boost host, never as evidence the participant can see
   a page.
4. When funding remains, immediately present the QR image returned by the tool,
   regardless of `ui_opened`; do not ask whether the participant wants it.
   Never mention or offer a loopback URL, `localhost`, or `127.0.0.1` over
   Matrix or from a headless/remote host.

   On the reference Matrix flow, produce three separate events in this order:

   1. Use `send_message` with `action: send` and `target: matrix` to send a
      concise funding instruction containing only the server-provided
      `data.funding.network`, `remaining_amount_eth`, and
      `remaining_amount_wei`, plus the valueless-testnet warning. The Matrix
      home channel is the participant conversation for this flow. Do not put
      the address or funding URI in this instruction.
   2. Use `send_message` again with `action: send`, `target: matrix`, and the
      exact server-provided `data.funding.address` as the entire `message`.
      No label, prefix, suffix, punctuation, Markdown, backticks, or code fence.
      An address must always be a message of its own so a mobile user can copy
      the whole bubble.
   3. When the tool result contains a `MEDIA:` tag, use `send_message` a third
      time with `action: send`, `target: matrix`, and that exact tag as the
      entire `message`. The gateway sends the QR as its own image event.

   After successful sends, do not emit a redundant final prose message; proceed
   directly to status monitoring. Never repeat the address in the instruction,
   phase updates, or another prose message. When the image is absent or its
   upload fails, use `send_message` to send the exact server-provided
   `funding_uri` as another standalone message. If `send_message` itself is
   unavailable, preserve the priority of an address-only visible response and
   put the exact `MEDIA:` tag on a new line; do not fold the instruction,
   address, and URI back into one message.
5. The instruction event in step 4 must ask the event operator to send only the
   exact remaining Sepolia ETH returned in `data.funding` and state plainly
   that Sepolia ETH has no real or redeemable value. Do not append this prose
   to the address-only response. Do not ask for a seed, key, password, or
   wallet approval.
6. Long-poll `onboarding_status` with the exact `setup_id`, the latest
   `since_revision`, and `wait_ms: 90000`. After every response, retain the
   newest revision for the next call. Continue through funding and automatic
   shielding, but narrate only meaningful phase changes.
7. Setup is complete only when the phase is `private_ready` and
   `privateBalanceWei` is at least `shieldAmountWei`, with the Tor RPC route
   still ready in a fresh `capabilities` result. `funding_pending`,
   `funded_public`, and `shielding` are intermediate states.

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
