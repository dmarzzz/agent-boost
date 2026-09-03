# Hermes integration

Agent Boost is a stdio MCP server plus two Hermes skills. The one-time installer
places the executable and pinned Kohaku dependency locally, copies the skills
into the active Hermes profile, adds one conflict-safe MCP entry, enables
Hermes tool-use enforcement when the operator has not already chosen a value,
and runs `hermes mcp test agent-boost`.

## Supported hosts

- macOS arm64;
- macOS x86_64;
- Ubuntu 24.04 arm64;
- Node.js 22 or newer;
- Hermes 0.16.0 or a compatible later release.

```console
make install
agent-boost doctor
```

The installer never replaces an existing, different `agent-boost` MCP entry.
It creates timestamped backups before changing existing Hermes config or skill
files. Repeat installation with the same content is idempotent.

Restart Hermes once and begin a fresh conversation. The no-restart path is
`/reload-skills`, `/reload-mcp`, then `/new` locally. Over Matrix, use
`!reload-skills`, `!reload-mcp`, then `!new`. The fresh session prevents facts
and behavioral assumptions from the prior contract surviving an upgrade; the
old transcript remains in Hermes history.

## Generated MCP configuration

```yaml
agent:
  tool_use_enforcement: true

mcp_servers:
  agent-boost:
    command: /absolute/path/to/agent-boost
    args: [mcp, --mode, dark, --contract-major, "1"]
    enabled: true
    timeout: 180
    supports_parallel_tool_calls: false
    tools:
      include:
        - capabilities
        - onboarding_start
        - onboarding_status
        - wallet_get_context
        - wallet_get_policy
        - wallet_plan_policy_update
        - wallet_apply_policy_update
        - wallet_start_new_demo
        - wallet_plan_private_payment
        - wallet_execute_private_payment
        - wallet_get_request
      resources: false
      prompts: false
```

`agent.tool_use_enforcement: true` is the safe default only when the setting is
absent. The installer preserves an explicit operator value, including `false`,
so an advanced user remains in control of the wider Hermes behavior.

The native names above are the stable contract. Any prefix Hermes adds to a
model-visible tool name is a host implementation detail.

## Skill split

`agent-boost-setup` is discoverable even before the MCP toolset has loaded. It
gives reload guidance, starts onboarding with no arguments, preserves the setup
ID and revision, presents the browser/QR/address fallback honestly, and
long-polls with `wait_ms: 90000`.

`agent-boost` requires the Agent Boost MCP toolset. It teaches the policy and
payment sequences:

1. read capabilities and live wallet context;
2. inspect or preview wallet-policy changes in ordinary native-token units;
3. confirm and apply policy changes separately from payments;
4. plan an exact recipient and wei amount;
5. immediately execute the immutable plan with
   `client_request_id: hermes:<decision_id>` and omit `user_confirmed`, allowing
   the MCP client to render the exact one-shot **Approve** / **Cancel** receipt;
6. only when native elicitation is unavailable, read back the returned receipt,
   obtain unambiguous verbal confirmation, and retry that same decision with
   `user_confirmed: true`;
7. preserve the returned request ID until terminal.

The skills are choreography. Sepolia enforcement, adjustable hard ceilings,
expiry, payment-count use, balance checks, policy-plan binding, and idempotency
are enforced in Agent Boost.

Policy editing uses `wallet_get_policy`, `wallet_plan_policy_update`, and
`wallet_apply_policy_update`. The user speaks in native-token decimals; the MCP
boundary converts them exactly. The preview says explicitly that authority is
not liquidity: applying it does not move the main balance into the private
payment pocket or approve a payment.

## Onboarding

`onboarding_start` creates or resumes a durable setup. It returns:

- `data.setup`: the full public setup record;
- `data.public`: the public UI-safe projection;
- `data.ui_opened`: whether a graphical browser was opened;
- a branded dark-mode MCP PNG card when an address is ready and a headless
  fallback is needed. Its QR scan field remains muted, high-contrast, and
  uninterrupted with conventional dark-on-light polarity.

On graphical macOS or Linux, the page opens at a loopback URL. On headless
Linux, Hermes should display the returned image. The page is read-only; the only
human action is sending Sepolia ETH from a separate wallet.

In the reference Matrix conversation, Hermes sends the funding instruction,
bare address, and QR as separate events. The address event contains no label or
formatting so a mobile user can copy the complete message directly.

`onboarding_status` accepts the exact `setup_id`, optional
`since_revision`, and optional `wait_ms` up to 90 seconds. Revisions advance
only for meaningful state changes, so a long-poll does not consume Hermes tool
turns while funding is unchanged.

## Payment execution

`wallet_plan_private_payment` accepts:

```json
{
  "recipient": "0x2222222222222222222222222222222222222222",
  "amount_atomic": "20000000000000000"
}
```

Planning refreshes Kohaku's private balance, reads the durable delegation, and
returns `allow` or `deny` with explicit blockers. It creates no transaction.

`wallet_execute_private_payment` accepts only the returned decision ID, a
stable client request ID, and an optional fallback confirmation boolean. It
never accepts a second copy of the recipient or amount. Under the default
policy, Agent Boost requests native form elicitation from the MCP client; a
decline or cancellation never executes. A client without elicitation receives a
structured receipt and may retry the same plan after verbal approval with
`user_confirmed: true`. That boolean is Hermes's attestation, not independent
speaker authentication. A repeat with the same client ID and decision returns
the original request; a conflicting repeat is rejected.

The execution tool can cause signing and broadcast. The authority is constrained
to the active count, per-send, total, and expiry policy, with non-adjustable
Sepolia and testnet ceilings. A submitted result is not confirmed. Agent Boost distinguishes a
Kohaku UserOperation hash from a transaction hash. It reports confirmed only
from explicit adapter confirmation, a successful transaction receipt, or the
recipient balance increasing by the requested amount from the pre-execution
checkpoint. Otherwise it preserves submitted or indeterminate state and
reconciles on restart/status reads without rebroadcast.

`wallet_start_new_demo` is the explicit reset path. After ordinary user
confirmation it archives current state, keeps the prior Kohaku wallet, creates
a new wallet profile, and returns a fresh funding QR. `onboarding_start` alone
always resumes the current wallet.

## Process and state lifetime

Hermes launches Agent Boost as an MCP child. Each launch:

- opens the durable state with private permissions;
- acquires the exclusive loopback runtime-ownership lock;
- bootstraps embedded Tor and verifies the Sepolia chain through it;
- starts the authenticated fixed-origin loopback RPC relay for Kohaku;
- starts the authenticated Shade Tree loopback Proxy only when a complete,
  owner-only Grove enrollment profile is present;
- restores the persisted active wallet profile before resuming work;
- resumes an unfinished funding or shield workflow;
- starts the loopback UI only when onboarding requests it;
- serializes Kohaku calls for the wallet;
- shuts down the watcher and UI when MCP closes.

There is no background daemon or administrative TCP API. The fixed-origin
loopback JSON-RPC relay has a random path, accepts POST only, and can reach only
the configured HTTPS Sepolia RPC through Tor. The separate optional Shade Tree
Proxy accepts authenticated CONNECT and is reachable through the bounded
`egress_fetch` tool only; it is not injected into Hermes process-wide proxy
settings. See [Covered egress](COVERED-EGRESS.md).

## Troubleshooting

```console
agent-boost doctor
agent-boost status
agent-boost install-hermes
make install-kohaku
```

`doctor` verifies Node, pinned Kohaku provenance and executable, a Tor-observed
exit, the Sepolia chain ID through that Tor path, Hermes availability, and the
redacted covered-egress lifecycle. It warns when Shade Tree is unsupported or
needs operator enrollment and never implies that general Hermes traffic is
covered.
