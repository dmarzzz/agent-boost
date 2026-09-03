# Changelog

## Unreleased

- Added a deterministic, privacy-safe wallet tree for Hermes: friendly profile
  names with sibling main/private balances, explicit live/last-known freshness,
  and no addresses, wallet IDs, raw atomic values, or aggregate total.
- README cut to the essentials; the install details, demo walkthrough, tools,
  configuration, privacy claims, and runtime hardening notes moved to `docs/`
  with an index at `docs/README.md`.
- README banner replaced with the phosphor Toggle Circuit board as a 1731 px
  WebP (about 100 KB, down from a 2.5 MB PNG).
- Repository hygiene: CI workflow behind the README badge, badge and link rows,
  `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, this changelog,
  CODEOWNERS, Dependabot, and issue and pull request templates.

## 0.1.0 (2026-09-01)

**Research preview.** Sepolia-only, disposable test funds, unaudited.

- Wallet-first proof of concept: Hermes creates a disposable Sepolia wallet
  through Agent Boost, the funding page shows an exact QR and address, and
  `0.1` test ETH is shielded through Kohaku automatically.
- One bounded shielded payment per delegation: planned from the live balance,
  read back, verbally confirmed, then signed and submitted within a one-use,
  expiring limit. Stable client IDs make retries idempotent.
- Sepolia JSON-RPC for both Agent Boost and Kohaku routed through embedded Tor
  with remote hostname resolution and no direct fallback; Tor deadlines kept
  live on Linux; first-run Tor reads recovered.
- First-install funding flow gated, remote funding recovery made reliable, and
  status kept available while a Hermes gateway owns the runtime lock.
- Conversational setup and payments for Hermes, with golden conversation evals.
- Resilient demo lifecycle: reset archives prior state instead of deleting it.
- Fail-closed covered egress: an explicit `egress_fetch` for one public HTTPS
  read through Shade Tree after operator enrollment, never a direct fallback.
