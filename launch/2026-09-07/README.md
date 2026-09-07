# Agent Boost — Twitter post kit

Prepared for September 7, 2026, America/New_York.

## Ready to post

1. Copy `post.txt` into Twitter/X.
2. Attach `agent-boost-coming-soon.png`.
3. Paste `alt-text.txt` into the image description.
4. Optionally add `reply-how-it-works.txt` as a reply.

The main post stands on its own and does not require a public repository link.

## Repository link

`dmarzzz/agent-boost` was verified as **private** during preparation. Use
`reply-repo-once-public.txt` only after the repository is public and its link
opens while signed out. Making the repository public is a separate publishing
decision; no visibility change is included in this preparation.

The repository currently has no open-source license. The copy therefore does
not call the project open source.

## Feature wording

- Private payment and identity: the current research preview, using fresh
  Ethereum accounts and shielded Sepolia test payments through Kohaku.
- Private search: **coming soon**.
- Private inference: **coming soon**.
- Covered HTTPS egress: a separate research-preview capability that requires
  Grove enrollment. It is not the upcoming private search product.
- The copy names Hermes, the integration documented in the current repository.
  The existing graphic retains its Hermes and OpenClaw branding; this kit does
  not claim a verified OpenClaw installation flow.

## Prepared replies to likely questions

**What does private identity mean here?**

Fresh wallet accounts/addresses for the agent. It isn't a claim that the whole
agent session is anonymous; funding, timing, and other activity can still be
correlated.

**Does it make all of Hermes private?**

No. These are scoped capabilities. Covered HTTPS fetches are explicit, and the
model provider, browser, and other process traffic aren't automatically routed
through them.

**Can I use real funds?**

This preview is Sepolia-only, unaudited research software. Use disposable test
funds.

**When do search and inference arrive?**

They're coming soon. I don't have a release date to share yet.

## Local repo preparation

The matching README status changes and corrected banner are prepared in this
checkout on `codex/agent-boost-launch-prep`, based on `origin/main` at `6ec26fe`.
The README distinguishes the upcoming features from the existing wallet and
covered-egress preview. This kit does not publish a post, schedule a post,
change repository visibility, or claim a fresh end-to-end wallet test.

For a public repository launch, land the prepared README/banner changes before
posting its link. The upstream main checks were green when inspected (Node 22
and 24; clean installs on macOS ARM64, macOS Intel, and Ubuntu 24.04 ARM64).

## Asset provenance

The graphic uses the original high-resolution phosphor banner from
`/Users/halcyon/agent-boost-branding/agent-boost-hero-phosphor-short@2x.png`.
The edit is made with the built-in image generation tool. Its exact prompt is
saved in `image-edit-prompt.txt`.
