# Hermes integration

Agent Boost is a stdio MCP server plus two Hermes skills. The one-time installer
places the executable and pinned Kohaku dependency locally, copies the skills
into the active Hermes profile, adds one conflict-safe MCP entry, and runs
`hermes mcp test agent-boost`.

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

Restart Hermes once, or enter `/reload-skills` followed by `/reload-mcp` in a
local conversation. Over Matrix, use `!reload-skills` followed by
`!reload-mcp`.

## Generated MCP configuration

```yaml
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
        - wallet_plan_private_payment
        - wallet_execute_private_payment
        - wallet_get_request
      resources: false
      prompts: false
```

The native names above are the stable contract. Any prefix Hermes adds to a
model-visible tool name is a host implementation detail.

## Skill split

`agent-boost-setup` is discoverable even before the MCP toolset has loaded. It
gives reload guidance, starts onboarding with no arguments, preserves the setup
ID and revision, presents the browser/QR/address fallback honestly, and
long-polls with `wait_ms: 90000`.

`agent-boost` requires the Agent Boost MCP toolset. It teaches the payment
sequence:

1. read capabilities and live wallet context;
2. plan an exact recipient and wei amount;
3. read back the exact terms and privacy limitations, including the scoped Tor
   RPC route and uncovered general traffic;
4. obtain an unambiguous verbal confirmation;
5. execute with `user_confirmed: true` and
   `client_request_id: hermes:<decision_id>`;
6. preserve the returned request ID until terminal.

The skills are choreography. Sepolia enforcement, limits, expiry, one-payment
use, balance checks, and idempotency are enforced in Agent Boost.

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
stable client request ID, and the user's confirmation boolean. It never accepts
a second copy of the recipient or amount. A repeat with the same client ID and
decision returns the original request; a conflicting repeat is rejected.

The boolean is Hermes's attestation that the exact readback was confirmed.
Agent Boost does not receive audio or independently authenticate the speaker.

The execution tool can cause signing and broadcast. The authority is constrained
to one native-ETH Sepolia payment under the configured amount and lifetime
limits. A submitted result is not confirmed. Agent Boost reports confirmed only
after Kohaku returns from inclusion and the recipient balance delta covers the
requested amount.

## Process and state lifetime

Hermes launches Agent Boost as an MCP child. Each launch:

- opens the durable state with private permissions;
- acquires the exclusive loopback runtime-ownership lock;
- bootstraps embedded Tor and verifies the Sepolia chain through it;
- starts the authenticated fixed-origin loopback RPC relay for Kohaku;
- resumes an unfinished funding or shield workflow;
- starts the loopback UI only when onboarding requests it;
- serializes Kohaku calls for the wallet;
- shuts down the watcher and UI when MCP closes.

There is no background daemon, administrative TCP API, or general egress
module. The only proxy is the loopback JSON-RPC relay: it has a random path,
accepts POST only, and can reach only the configured HTTPS Sepolia RPC through
Tor.

## Troubleshooting

```console
agent-boost doctor
agent-boost status
agent-boost install-hermes
make install-kohaku
```

`doctor` verifies Node, pinned Kohaku provenance and executable, a Tor-observed
exit, the Sepolia chain ID through that Tor path, and Hermes availability. It
warns that general Hermes and agent traffic is not covered.
