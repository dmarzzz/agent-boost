# Configuration

The POC is deliberately small and uses environment variables rather than a
secret-bearing repository config.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_BOOST_RPC_URL` | Public HTTPS Sepolia RPC | Fixed Tor-routed endpoint; hostname and HTTPS required |
| `AGENT_BOOST_UI_PORT` | `9183` | Loopback funding page port; `9180`, `9184`, and `9185` forbidden |
| `AGENT_BOOST_TOR_RPC_PORT` | `9185` | Authenticated fixed-origin loopback relay for Kohaku |
| `AGENT_BOOST_TOR_DATA_DIR` | `$AGENT_BOOST_STATE_DIR/tor` | Private embedded-Tor cache namespace |
| `AGENT_BOOST_TOR_BOOTSTRAP_TIMEOUT_MS` | `120000` | Fail-closed Tor startup deadline |
| `AGENT_BOOST_FUNDING_WEI` | `200000000000000000` | Requested initial funding |
| `AGENT_BOOST_SHIELD_WEI` | `100000000000000000` | Tornado shield/note amount |
| `AGENT_BOOST_PAYMENT_LIMIT_WEI` | `1000000000000000000` | Default per-send limit (1 Sepolia ETH) |
| `AGENT_BOOST_MAX_PAYMENTS` | `10` | Default number of private sends |
| `AGENT_BOOST_LIFETIME_LIMIT_WEI` | `10000000000000000000` | Default total send allowance (10 Sepolia ETH) |
| `AGENT_BOOST_DELEGATION_TTL_MS` | `604800000` | Delegated execution lifetime (seven days) |
| `AGENT_BOOST_OPEN_UI` | `false` | Optionally open the same-device fallback UI |
| `AGENT_BOOST_EXECUTE` | `true` | Enable bounded testnet execution |
| `AGENT_BOOST_STATE_DIR` | `~/.local/share/agent-boost` | Durable state root |
| `AGENT_BOOST_SHADE_TREE_ENABLED` | `true` | Enable optional explicit covered egress |
| `AGENT_BOOST_SHADE_TREE_PROXY_PORT` | `9186` | Authenticated loopback Shade Tree Proxy |
| `AGENT_BOOST_SHADE_TREE_PROFILE_DIR` | `$AGENT_BOOST_STATE_DIR/shade-tree/profile` | Operator-provisioned owner-only profile |
| `AGENT_BOOST_SHADE_TREE_REQUEST_TIMEOUT_MS` | `30000` | Covered request deadline |
| `AGENT_BOOST_SHADE_TREE_MAX_RESPONSE_BYTES` | `1048576` | Covered response body cap |

The upstream RPC URL is never returned through MCP or given to Kohaku. Do not put credentialed
URLs in the repository or paste them into a model conversation.

The default is the public Sepolia endpoint
`https://ethereum-sepolia-rpc.publicnode.com`, routed through Tor with no direct
fallback. Kohaku's account-abstraction relay also uses its own Tor-backed
Pimlico path; neither path makes Hermes or general agent traffic private.

These variables set the sane policy for newly created wallets. Existing wallet
authority is durable and is never silently widened during an upgrade. Users can
say “change my wallet limits” in Hermes to preview and confirm a policy update
without editing environment variables. The current Sepolia-only editor is hard
bounded to 100 sends, 100 native test tokens per send, 10,000 total, and 30 days.
Changing policy does not move funds between the main account and private pocket.
