<!--
Thanks for contributing to AgentDesk! Please read CONTRIBUTING.md first.
Keep the PR focused on one concern and explain the *why*, not just the *what*.
-->

## What & why

<!-- What does this change and why? Link any issue. -->

## Verification gate (all must pass — see CONTRIBUTING.md)

- [ ] `pnpm run audit` — no new high+ advisories in prod deps
- [ ] `pnpm run format:check`
- [ ] `pnpm exec tsc --noEmit` (host) and container typecheck
- [ ] `pnpm exec vitest run` (host) and `bun test` (container)
- [ ] `pnpm lint` — 0 errors

## Architectural hygiene

- [ ] If this is an architecturally significant decision, I added an ADR under
      `docs/decisions/` and updated the index (and referenced it in the commit).
- [ ] If I changed a runtime contract (DB schema, gateway interface, channel
      shape, container↔host protocol, CI step order, a metric/alert), I updated
      the matching doc **in this PR**.
- [ ] I did **not** weaken any load-bearing invariant (identity trust chain,
      gateway-only path, three-DB single-writer, observability read-only) without
      an ADR documenting the trade-off.
- [ ] No brand name hardcoded (`PLATFORM_BRAND` / `PLATFORM_PROTOCOL_NAMESPACE`).
- [ ] If I removed code, the commit message says *why*.

## Notes for reviewers

<!-- Anything reviewers should focus on, risks, follow-ups. -->
