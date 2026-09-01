---
name: agent-boost-setup
description: Guide local Sepolia wallet setup and funding.
version: 0.1.0
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
4. When funding remains, immediately present the QR image returned by the tool
   in the current reply, regardless of `ui_opened`; do not ask whether the
   participant wants it. When the tool result contains a `MEDIA:` tag, copy that
   exact tag onto a standalone line so the messaging gateway attaches the image.
   Never mention or offer a loopback URL, `localhost`, or `127.0.0.1` over
   Matrix or from a headless/remote host. In the same reply, always show the
   server-provided `data.funding.network`, `remaining_amount_eth`,
   `remaining_amount_wei`, `address`, and `funding_uri` as a copyable fallback.
   If the image is absent or upload fails, say the QR attachment was unavailable
   and still send that complete text fallback.
5. Ask the event operator to send only the exact remaining Sepolia ETH returned
   in `data.funding`. State plainly that Sepolia ETH has no real or redeemable
   value. Do not ask for a seed, key, password, or wallet approval.
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
