# Privacy claims and limits

The accurate claim for this POC is:

> A privacy-improving, shielded Sepolia test payment.

It is not a guarantee of anonymity.

- Initial funding is public. The funder, destination, amount, and timing are
  visible on Sepolia.
- Shielding and later unshielding break the direct deposit/withdrawal link, but
  timing, amounts, a small testnet anonymity set, and protocol activity may
  still correlate them.
- Agent Boost and Kohaku route Ethereum JSON-RPC over Tor with remote hostname
  resolution and no direct fallback. This hides the machine's origin IP from
  the RPC provider, but the provider still sees RPC methods, wallet addresses,
  payloads, and timing.
- Kohaku separately uses Tor for supported privacy-protocol HTTP traffic.
  Explicit `egress_fetch` calls can use Shade Tree after enrollment. Hermes,
  model-provider, Matrix, browser, and all other process traffic remain outside
  that covered request.
- A fresh or stealth address alone does not hide its funding transaction.
- Demo reset archives prior state and retains old Kohaku wallet data locally.
  Saved profiles can be selected again and exact private amounts can be
  recovered after separate confirmation, but Agent Boost never exports a seed.
- Recipient-balance-delta confirmation proves delivery of at least the amount;
  it is not cryptographic attribution when unrelated concurrent transfers are
  possible.

Shade Tree cover is a research-preview, explicitly invoked module. It does not
change the wallet RPC route and it is never presented as whole-agent privacy.


## Local security boundary

Agent Boost keeps secrets out of tool results, prompts, command arguments, and
normal logs. That is useful, but it is not an operating-system custody boundary
when Hermes and Agent Boost run as the same user. A locally privileged agent
with unrestricted shell and filesystem access could read both the encrypted
Kohaku wallet and its local password file. The Hermes skills tell the agent not
to do this; instructions are not enforcement.

For this POC, the practical safety boundary is disposable Sepolia-only funds,
a maximum one-time payment, no mainnet configuration, and explicit verbal
confirmation. A future real-value release would require a separate service
identity or hardware/cryptographic signer that the agent process cannot access.
The confirmation boolean is supplied by Hermes, so a compromised Hermes has
the same authority as a falsely confirmed conversation within these limits.
