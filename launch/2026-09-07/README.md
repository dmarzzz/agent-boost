# Agent Boost posting kit

## Post this

1. Copy **post.txt**.
2. Attach **agent-boost-social.png** — the square version made for the feed.
3. Use **alt-text.txt** as the image description.
4. Add **reply-how-it-works.txt** if you want to show the flow in a first reply.

The post asks what people would have Hermes pay for. That gives agent builders
one concrete thing to respond to.

## Other surfaces

- **agent-boost-banner.png**: the wide version for the README or repository
  social preview. Use **banner-alt-text.txt** for its description.
- **reusable-copy.md**: tagline, plain-language descriptor, short introduction,
  technical introduction, and prepared GitHub description.
- **reply-privacy.txt**: a concise answer when someone asks about privacy scope.
- **reply-repo-once-public.txt**: the repository link reply, for a public release.

## The message

**Agent Boost. Dark mode for your agent.**

Explain it immediately: **give ur agent a private crypto address and tool use**

The supporting memory cue: **Give your agent a wallet. Keep the keys out of its
context.**

The graphic carries one visual idea: the green dark-mode switch. Wallet
addresses and test payments are the preview. Private search and private
inference each retain an explicit **Coming soon** label.

The launch names Hermes, the integration documented in this repository. The
new graphics focus on Agent Boost and omit integration-logo clutter. Technical
terms such as MCP, sidecar, and Kohaku appear after the plain-language pitch.

## Questions you may get

**What does private identity mean?**

Fresh wallet addresses in this preview. Initial funding is public, and timing
or amounts can still correlate activity. It isn't whole-agent anonymity.

**Are the keys inaccessible to the agent?**

They stay out of model prompts and wallet tool results. Hermes and Agent Boost
currently share an OS user, so this isn't a custody boundary against a
privileged local process.

**Can I use real funds?**

This is an unaudited Sepolia research preview. Use disposable test funds only.

**When do search and inference ship?**

They're coming soon; no release date is announced in this kit.

## Repository release

The repository was verified as **private** during this preparation. The main
post therefore works without a public link. Publish the link reply only after
the repository opens while signed out. The prepared README and banner changes
should land before sharing that link.

A GitHub description is prepared in **reusable-copy.md**. The repository has no
open-source license, so the copy does not describe it as open source.

These are local launch assets and documentation changes, not a published or
scheduled post, a visibility change, or a fresh wallet execution test.

## Asset provenance and review

The square and wide assets were created with the built-in image generation
tool from the existing Agent Boost brand graphic. Exact prompts are saved in
**image-social-prompt.txt**, **image-social-refinement-prompt.txt**, and
**image-banner-prompt.txt**. The refinement gives the small text a solid
background and larger, filled Coming soon badges.

The square was reviewed at 400 pixels wide. The README was rendered locally
at mobile and desktop widths; this approximates GitHub typography and does not
represent a deployed GitHub page. Review captures are in the checkout's
**review/** directory. No engagement or user-comprehension measurements are
claimed.
