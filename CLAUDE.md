# FrontLane Agent Platform

> **🧭 Onboarding banner for coding agents**
>
> This repo is mid-migration from V1 (sibling repo `../openclaw/`, codename "小环") to MUAP. The migration constitution **v1.2** is final; Phase 0a + Phase 0b are pending kickoff.
>
> **First-touch reading order** (do NOT skip):
> 1. [`docs/migration-from-v1.md`](docs/migration-from-v1.md) — cross-repo pointer
> 2. `../openclaw/CLOSEOUT/migration-to-muap.md` v1.2 — Q1-Q7 final rulings, scope, timeline
> 3. [`docs/decisions/README.md`](docs/decisions/README.md) — ADR index, the "why" archive
> 4. This file (`CLAUDE.md`) §"Session Continuation Guide" — how to resume work across sessions
>
> If you cannot reach `../openclaw/CLOSEOUT/` (out of scope / not cloned), STOP and ask the user before making architecture-relevant changes.

This repo is the enterprise baseline for a multi-user agent platform.

## Scope

Keep the project focused on these concerns:

- Feishu and CLI as ingress channels
- frontdesk -> worker delegation
- per-user or per-thread session isolation
- ERP Gateway integration for auth, execute, and long-term memory
- containerized agent execution

Do not reintroduce old personal-assistant, migration, marketplace, or multi-channel fork infrastructure unless explicitly requested.

## Core Shape

- Host: `src/index.ts`, `src/router.ts`, `src/delivery.ts`, `src/host-sweep.ts`
- DB: `src/db/`
- Channels: `src/channels/` with `cli` and `feishu`
- Enterprise bootstrap: `scripts/init-enterprise-topology.ts`, `scripts/configure-enterprise-gateway.ts`
- Container runner: `container/agent-runner/src/`
- Container prompt base: `container/CLAUDE.md`

## Runtime Model

- The host is a single Node process.
- Each active session maps to a containerized agent runner.
- Host and runner communicate through per-session SQLite files.
- Long-term business memory should live behind the ERP gateway, not in ad-hoc local files.

## Working Rules

- Prefer keeping enterprise behavior in the gateway contract, not hardcoding ERP-specific logic into the platform core.
- Preserve user/session isolation semantics when changing routing logic.
- Keep Feishu group-chat behavior conservative; do not widen write permissions based only on group context.
- When cleaning or extending the repo, prefer deleting unused legacy surface over keeping compatibility shims for old product directions.

## Useful Docs

- `README.md`
- `docs/migration-from-v1.md` — cross-repo pointer to V1 closeout (must-read for new agents)
- `docs/decisions/README.md` — ADR index (architectural "why" archive)
- `docs/enterprise-multi-user.md`
- `docs/enterprise-erp-gateway.md`
- `docs/feishu-channel.md`
- `docs/architecture.md`
- `docs/isolation-model.md`

## Session Continuation Guide

This project is intended to support **multi-session, multi-agent collaborative development**. A new coding agent picking up this repo should be able to reconstruct prior context in **≤3 hops**.

### When you (a coding agent) enter this repo, do this in order:

1. **Read this file (CLAUDE.md) and the README.md banner.** Understand scope + cross-repo migration status.
2. **Open `docs/migration-from-v1.md`** to confirm whether V1 closeout context (`../openclaw/CLOSEOUT/`) is reachable.
3. **Skim `docs/decisions/README.md`** — every ADR is an architectural commitment. If the user's request contradicts an ADR, raise it before implementing.
4. **Check `.sisyphus/`** if present — it contains prior agent's working state (plans, todos, evidence). Format may be tool-specific; treat as advisory, not authoritative.
5. **Run `pnpm typecheck && pnpm test`** to confirm the baseline is green before making changes.

### When you finish a non-trivial work session, do this:

1. **If you made an architecturally significant decision** (changed a public contract, picked between two viable approaches, introduced a new dependency category, or invalidated a prior ADR):
   - Add a new ADR under `docs/decisions/ADR-NNNN-short-title.md` using the template at `docs/decisions/_template.md`
   - Update `docs/decisions/README.md` index
2. **If you changed a runtime contract** (DB schema, ERP gateway interface, channel adapter shape, container ↔ host protocol):
   - Update the relevant `docs/*.md` doc in the same commit
3. **If your work is incomplete and you expect another session to continue**:
   - Leave a clear handoff note. Either via `.sisyphus/notepads/` (if you use Sisyphus), or as a `TODO:` comment near the relevant code, or as an `## Open Questions` section in the most relevant doc
4. **Never delete the "why"**. If you remove code, leave a one-line note about why in the commit message. If the rationale is non-trivial, write an ADR for the removal.

### Constitution-level rules (cannot be changed without user approval)

- The migration constitution `../openclaw/CLOSEOUT/migration-to-muap.md` v1.2 is **binding**. Phase ordering, scope, and timeline are not subject to local agent-level revision.
- Phase 0b observability stack is **Arize Phoenix (OSS) + Grafana**. No Logfire / OpenTelemetry-only / DIY-logging proposals without explicit user approval.
- Identity trust chain (batch-level `RequestIdentity`, `origin_user_id` propagation, HMAC signing, `erp_audit`) is **complete and load-bearing**. Do not weaken any of these layers.
- ERP Gateway contract is the **only** path for business memory and authorization. Do not introduce parallel paths.

### Decision logging is non-optional

If you find yourself thinking *"this is just a small architectural choice, no one needs to know"* — that is exactly the moment to write an ADR. The cost of an ADR is 5 minutes; the cost of the next agent reverse-engineering your reasoning from code is hours.


