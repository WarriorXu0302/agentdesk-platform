# AgentDesk Agent Platform

This repo is an open, business-agnostic baseline for a multi-user enterprise agent platform.

## Scope

Keep the project focused on these concerns:

- Channel ingress (Feishu and CLI ship in-tree; others install as adapters)
- frontdesk -> worker delegation
- per-user or per-thread session isolation
- a pluggable backend gateway for auth, execute, and long-term memory
- containerized agent execution

The platform core is generic. Business-specific topologies, prompts, and
backend operations live in `examples/` or in an operator's own deployment —
not hardcoded into the core. Do not bake a particular company's ERP/CRM/lab
logic into the platform.

## Core Shape

- Host: `src/index.ts`, `src/router.ts`, `src/delivery.ts`, `src/host-sweep.ts`
- DB: `src/db/`
- Channels: `src/channels/` with `cli` and `feishu`
- Bootstrap: `scripts/init-enterprise-topology.ts`, `scripts/configure-enterprise-gateway.ts`
- Container runner: `container/agent-runner/src/`
- Container prompt base: `container/CLAUDE.md`
- Branding/namespace single source of truth: `src/branding.ts` (override with
  `BRAND_NAME` / `BRAND_NAMESPACE` env vars)

## Runtime Model

- The host is a single Node process.
- Each active session maps to a containerized agent runner.
- Host and runner communicate through per-session SQLite files.
- Long-term business memory should live behind the backend gateway, not in
  ad-hoc local files.

## Working Rules

- Keep backend-specific behavior in the gateway contract, not hardcoded into
  the platform core. The gateway can front any backend (ERP, CRM, internal
  API, ticketing) — the platform must not assume which.
- Preserve user/session isolation semantics when changing routing logic.
- Keep Feishu group-chat behavior conservative; do not widen write permissions
  based only on group context.
- When cleaning or extending the repo, prefer deleting unused legacy surface
  over keeping compatibility shims for old product directions.
- Don't hardcode the brand name. Derive display strings from `PLATFORM_BRAND`
  and machine identifiers from `PLATFORM_PROTOCOL_NAMESPACE` (`src/branding.ts`).

## Useful Docs

- `README.md`
- `docs/decisions/README.md` — ADR index (architectural "why" archive)
- `docs/enterprise-multi-user.md`
- `docs/enterprise-erp-gateway.md` — backend gateway contract
- `docs/feishu-channel.md`
- `docs/architecture.md`
- `docs/configuration-reference.md` — authoritative per-group `container.json` fields
- `docs/isolation-model.md`
- `docs/capacity.md` — 一台宿主承载多少人:实测的宿主开销、吞吐公式、
  该看哪些指标、扩容顺序,以及明确的未做项

## Session Continuation Guide

This project supports **multi-session, multi-agent collaborative development**.
A new coding agent picking up this repo should be able to reconstruct prior
context in **≤3 hops**.

### When you (a coding agent) enter this repo, do this in order:

1. **Read this file (CLAUDE.md) and the README.md.** Understand scope.
2. **Skim `docs/decisions/README.md`** — every ADR is an architectural
   commitment. If the user's request contradicts an ADR, raise it before
   implementing.
3. **Run `pnpm typecheck && pnpm test`** to confirm the baseline is green
   before making changes.

### When you finish a non-trivial work session, do this:

1. **If you made an architecturally significant decision** (changed a public
   contract, picked between two viable approaches, introduced a new dependency
   category, or invalidated a prior ADR):
   - Add a new ADR under `docs/decisions/ADR-NNNN-short-title.md` using the
     template at `docs/decisions/_template.md`
   - Update `docs/decisions/README.md` index
2. **If you changed a runtime contract** (DB schema, backend gateway interface,
   channel adapter shape, container ↔ host protocol):
   - Update the relevant `docs/*.md` doc in the same commit
3. **If your work is incomplete and you expect another session to continue**:
   - Leave a clear handoff note (a `TODO:` comment near the relevant code, or
     an `## Open Questions` section in the most relevant doc)
4. **Never delete the "why"**. If you remove code, leave a one-line note about
   why in the commit message. If the rationale is non-trivial, write an ADR.

### Load-bearing invariants (do not weaken without user approval)

- **Identity trust chain** — batch-level `RequestIdentity`, `origin_user_id`
  propagation across a2a hops, HMAC signing, and the `gateway_audit` table are
  complete and load-bearing. Do not weaken any of these layers.
- **Backend gateway is the only path** for business memory and authorization.
  Do not introduce parallel paths.
- **Multi-tenant org isolation** (ADR-0052) — when an `agent_group` belongs to an
  organization, cross-org access is denied at the HOST access gate
  (`canAccessAgentGroup` + its `hasAdminPrivilege` / `canOperate` / operator-query
  cousins). org must NEVER become a backend-gateway business-authz input — it stays
  host-side (enforced by `operability-gateway-isolation.test.ts`). Each `user_roles`
  row carries exactly one scope axis (global / group / org); a `global` revoke must
  keep `… AND organization_id IS NULL`. NULL-org = legacy (no prerequisite). Do not
  weaken cross-org denial or fold org into the gateway path.
- **Three-DB single-writer invariant** — central DB and each session's
  inbound.db are host-written; outbound.db is container-written. The
  "open-write-close" pattern is required for cross-mount reliability, not an
  optimization.
- **Observability is read-only** — the Phoenix/Grafana + OpenTelemetry stack
  must never mutate the identity trust chain or message flow.
- **Enforced frontdesk Routing is controller-owned** (ADR-0054) — when
  `llm.routing.enabled` is on, the tool-free/stateless Routing provider may
  only propose a closed action. The runner validates and enforces it through
  the shared outbound DB gate; non-delegating Execution can send only to the
  exact origin channel/platform/thread, cannot reclassify, and cannot change
  the selected agent destination. Clear any persisted gate before a new turn
  so crash residue cannot constrain a replay. Worker A2A turns do not reroute.
- **The outbound contract is the one decode point on the delivery path**
  (ADR-0063) — `messages_out.content` is agent-authored bytes from the
  untrusted side. `parseOutboundContent` (`src/outbound-contract.ts`) runs once
  in `deliverMessage`; everything downstream may assume a plain object with no
  prototype-mutating keys, inside the size and depth bounds. Read fields with
  the strict readers, never `content.x as T` — a cast is not a check, and
  `RegExp.test` stringifies, so a pattern check placed before a type check
  waves numbers through. A contract violation is PERMANENT: dead-letter on the
  first attempt, never retry. (`llm-usage` rows short-circuit before this point
  and `host-sweep` parses them separately, narrowly typed — that is the one
  documented exception.)
- **An approval card must show everything that will be applied** (ADR-0063) —
  the card is the only gate in front of group-level `container.json` writes, so
  it renders the exact object `apply.ts` will write, agent text is fenced, and
  characters that could escape the fence or make the display differ from the
  stored value (backtick, backslash, `\p{Cc}`, `\p{Cf}` bidi) are rejected
  rather than escaped. Anything agent-derived that reaches the card counts —
  including the agent group NAME, which `create_agent` persists verbatim.
- **Per-session fan-out must isolate per-session failure** — both the delivery
  drain and the host sweep iterate every session, and one session's throw must
  never end the pass. `getActiveSessions()` has no ORDER BY, so SQLite serves
  the same order every tick: an unisolated failure starves the same sessions
  behind it forever, not occasionally.

### An ADR's index row is part of the ADR

`docs/decisions/README.md` is what a new agent skims first, so a stale row
teaches the wrong thing to exactly the reader who has no way to know better.
**When you correct an ADR body, correct its row in the same edit.** This has
been violated three times in a single day — the ADR was fixed, the row kept
teaching the retracted version. If the correction is too long for a row, say
"superseded by the ADR's own correction section" and link it.

### Decision logging is non-optional

If you find yourself thinking *"this is just a small architectural choice, no
one needs to know"* — that is exactly the moment to write an ADR. The cost of
an ADR is 5 minutes; the cost of the next agent reverse-engineering your
reasoning from code is hours.
