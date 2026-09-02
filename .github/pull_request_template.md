## Summary

Describe what changed and why. Link the issue or design discussion when one exists.

## Verification

List the commands you ran and their results. Include focused tests for the behavior
you changed.

```text
npm run check
npm test
npm run build
# npm run release:smoke, when install or packaging changes
# npm run eval, when Hermes skills or conversation flows change
```

## Security and trust model

- [ ] I considered untrusted input, secret handling, fail-closed behavior, and the
      boundaries in `docs/THREAT-MODEL.md` and `docs/CAPABILITY-CONTRACT.md`.
- [ ] No MCP result, log line, prompt, or command argument added here can carry a
      seed, private key, wallet password, raw note or proof, raw signed
      transaction, route credential, or provider API key.
- [ ] Anything that widens what the agent may do (a new tool, a wider allowlist, a
      new network route, a changed delegation limit) is called out explicitly below.
- [ ] This change does not commit credentials, wallet material, or private
      infrastructure details.

Security notes, or `Not applicable`:

## Documentation and release impact

- [ ] User-facing commands, configuration, MCP tool schemas, and operational
      behavior are documented in this change.
- [ ] Backward-compatibility and rollout implications are described below, or are
      not applicable.
- [ ] The change is narrowly scoped and any remaining work is stated honestly.

Release or migration notes, or `Not applicable`:
