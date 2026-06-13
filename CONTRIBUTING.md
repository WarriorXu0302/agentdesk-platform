# Contributing to AgentDesk

AgentDesk is an open, business-agnostic baseline for a multi-user enterprise
agent platform. The core is deliberately generic — business-specific topologies,
prompts, and backend operations live in `examples/` or in an operator's own
deployment, never hardcoded into the platform. Please keep contributions aligned
with that scope (see `CLAUDE.md` → "Scope").

## Development setup

```bash
pnpm install                                       # host deps (Node ≥ 20, pnpm)
(cd container/agent-runner && bun install)         # container runner deps (Bun)
pnpm container:build                               # build the agent image (needs Docker)
```

The host is a single Node process; each active session maps to a containerized
agent runner; host and runner communicate through per-session SQLite files. See
`docs/architecture.md` and `docs/build-and-runtime.md`.

## The verification gate

Before opening a PR, run the same checks CI runs (`.github/workflows/ci.yml`).
**All must pass.**

```bash
pnpm run audit            # supply-chain: no new high+ advisories in prod deps
pnpm run format:check     # prettier
pnpm exec tsc --noEmit    # host typecheck
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit   # container typecheck
pnpm exec vitest run      # host tests
pnpm lint                 # eslint (0 errors; warnings are tolerated)
cd container/agent-runner && bun test   # container tests (bun:test, not vitest)
```

A real-container round trip (`pnpm e2e:container`, needs Docker + a built image)
and the Prometheus rule check (`pnpm obs:rules:check`) also run in CI's
`image-smoke` job.

## Load-bearing invariants — do not weaken without an ADR

These are the platform's reason for existing. If your change touches any of them,
it needs an ADR (see below), and likely a maintainer discussion first:

- **Identity trust chain** — batch-level `RequestIdentity`, `origin_user_id`
  propagation across a2a hops, HMAC signing, and the central `gateway_audit`
  table are complete and load-bearing. Agent rows trust only the
  `origin_user_id` column, never `content.senderId`.
- **Backend gateway is the only path** for business memory and authorization.
  Do not introduce parallel paths.
- **Three-DB single-writer invariant** — the central DB and each session's
  `inbound.db` are host-written; `outbound.db` is container-written. The
  open-write-close pattern is required for cross-mount reliability.
- **Observability is read-only** — the Phoenix/Grafana + OpenTelemetry stack must
  never mutate the identity trust chain or message flow.
- **Session DBs use `journal_mode=DELETE`, not WAL** (WAL's `-shm` map doesn't
  cross the host↔guest mount). The central DB uses WAL.
- **Don't hardcode the brand name.** Derive display strings from `PLATFORM_BRAND`
  and machine identifiers from `PLATFORM_PROTOCOL_NAMESPACE` (`src/branding.ts`).

See `CLAUDE.md` → "Load-bearing invariants" for the authoritative list.

## Architecture Decision Records (ADRs)

Decision logging is **not optional**. If you make an architecturally significant
decision — changed a public contract, picked between two viable approaches,
introduced a new dependency category, or invalidated a prior ADR — add one:

1. Copy `docs/decisions/_template.md` to
   `docs/decisions/ADR-NNNN-short-title.md`.
2. Update the index in `docs/decisions/README.md`.
3. Reference the ADR number in your commit message (`refs ADR-NNNN`).

If you remove code, leave a one-line note in the commit about *why*. Never delete
the "why."

## Keep runtime contracts and docs in sync

If you change a runtime contract, update its doc **in the same PR**:

- DB schema → `docs/db-*.md`
- Backend gateway interface → `docs/enterprise-erp-gateway.md`
- Channel adapter shape → `docs/feishu-channel.md`
- Container ↔ host protocol / build → `docs/build-and-runtime.md`
- CI step order → `docs/build-and-runtime.md` "CI shape" (the `ci.yml` header
  enforces this)
- New/changed metric or alert → `infra/observability/prometheus/alerts.yml` +
  `docs/RUNBOOK.md` (the `metrics-alerts-consistency` / `runbook-consistency`
  drift-guard tests enforce this)

## Commits & PRs

- Branch off `main`; keep PRs focused on one concern.
- Write clear commit messages explaining the *why*, not just the *what*.
- Fill in the PR template checklist.
- Prefer deleting unused legacy surface over keeping compatibility shims for old
  product directions.

## Reporting security issues

Do **not** open a public issue for a vulnerability. Follow `SECURITY.md`.
