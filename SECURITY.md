# Security Policy

AgentDesk is an open, business-agnostic baseline for a multi-user enterprise
agent platform. Its headline property is an **unforgeable identity trust chain**:
every backend call is attributable to the real end user, and a prompt-injected
agent cannot forge that identity. Security reports against that property — or any
other trust boundary below — are taken seriously.

## Reporting a Vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on
<https://github.com/WarriorXu0302/agentdesk-platform/security/advisories/new>.

Please include:

- the affected component (host, container runner, a channel adapter, the gateway
  contract, the observability stack, …) and version / commit,
- a description of the trust boundary you believe is crossed,
- a minimal reproduction or proof-of-concept if you have one,
- the impact you can demonstrate (identity forgery, audit bypass, cross-session
  leakage, RCE, credential disclosure, …).

This is a community-maintained baseline, not a vendored product with an SLA — we
acknowledge reports on a best-effort basis and will coordinate a fix and
disclosure timeline with you. If you operate your own deployment, also notify
your own security team: much of production hardening is operator responsibility
(see "Operator hardening" below).

## Supported Versions

Security fixes land on `main` (and the current `2.x` line). There is no
long-term-support branch — this is a baseline you fork and deploy, so track
`main` and apply the operator hardening checklist for your deployment.

## Security Model & Trust Boundaries

The load-bearing security invariants (do not weaken without an ADR documenting
the trade-off — see `CLAUDE.md` and `docs/decisions/`):

| Boundary | Mechanism | Reference |
|---|---|---|
| **Identity trust chain** | Batch-level `RequestIdentity`; `origin_user_id` propagated across a2a hops; host cross-validates the container's self-reported identity against the trusted `inbound.db` set (agent rows trust only the `origin_user_id` column, never `content.senderId`) | ADR-0017 |
| **Gateway authentication** | HMAC request signing; unsigned groups are observable + alertable (`gateway_unsigned_groups`) | ADR-0018 |
| **Credential isolation** | Host-side signing-credential proxy keeps `signingKey` out of the container (per-session unforgeable token, redacted `container.json`, structural fail-closed, default OFF); OpenAI key routed via OneCLI vault so it never enters the container | ADR-0034, ADR-0035 |
| **Audit** | Central append-only `gateway_audit` table — one row per backend call (who / what / when / outcome); the pre-forward intent write is fail-closed (no signed call without an audit row) | ADR-0034 |
| **Fail-closed defaults** | Missing admin table → deny; uncompilable engage regex → drop, never hijack; approval card without an actor → deny; config validation rejects placeholder secrets at startup | ADR-0019, ADR-0025 |
| **Ingress durability** | Persist-before-route: the raw envelope is persisted before routing; failures are retained + operator-replayable, not silently dropped | ADR-0022 |
| **Session isolation** | Per-user / per-thread session isolation; each session maps to its own container with per-group cgroup limits | `docs/isolation-model.md` |
| **Memory / prompt-injection** | Long-term business memory lives only behind the backend gateway; retrieved memory is fenced with a nonce-delimited injection boundary | ADR-0033 |
| **Observability is read-only** | The Phoenix/Grafana + OpenTelemetry stack must never mutate the identity trust chain or message flow; trace content capture is opt-in and off by default | ADR-0007, ADR-0027 |

### Out of scope

- The **operator's own backend gateway, ERP/CRM, and business prompts** — the
  platform fronts these but does not define their security; a vulnerable backend
  behind the gateway is the operator's responsibility.
- **Third-party channel adapters** installed out-of-tree.
- Misconfiguration that the shipped fail-fast / hardening checklist warns against
  (e.g. disabling signing, opening container egress, running with placeholder
  secrets). These are documented operator decisions, not platform vulnerabilities.

## Supply-chain / Dependency Posture

- CI runs `pnpm run audit` (`pnpm audit --prod --audit-level high`) on every PR
  and fails on any high/critical advisory in the **shipped** dependency tree.
- Dependabot (`.github/dependabot.yml`) opens weekly update PRs for the host npm
  tree, the container base image, and GitHub Actions.
- The container agent-runner uses a `bun.lock` lockfile, which Dependabot does not
  understand; its dependencies are tracked manually against upstream advisories.

### Suppressed advisories

A small number of advisories are suppressed in
`package.json` → `pnpm.auditConfig.ignoreGhsas` because the vulnerable code path
is provably unreachable in this platform. Each is justified here and re-evaluated
when the dependency tree changes:

| GHSA | Package | Why not applicable |
|---|---|---|
| `GHSA-q7rr-3cgh-j5r3` | `@opentelemetry/exporter-prometheus` (transitive, via `auto-instrumentations-node` / `sdk-node`) | "Prometheus exporter process crash via malformed HTTP request." The OTEL Prometheus exporter is **never instantiated** — `/metrics` is served by `prom-client` (`src/metrics.ts`), and host OTEL starts only `NodeSDK` + `OTLPTraceExporter` (`src/observability/init.ts`). Fixing requires a ~162-minor OTEL jump (0.55 → 0.217) that risks the ADR-0026 trace pipeline; tracked as a separate upgrade. |
| `GHSA-w5hq-g745-h8pq` | `uuid@9` (transitive, via `gaxios` ← OTEL GCP resource detector) | "Missing buffer bounds check in v3/v5/v6 when a buffer is supplied." Only `uuid.v4()` (no buffer argument) is reached on this path, so the vulnerable functions are never invoked. The fix is a major bump (uuid 9 → 11) under `gaxios`, in a GCP-detector path this platform (bare Node / Docker, not GCP) does not exercise. |

Reachable advisories are remediated via `pnpm.overrides` (currently
`axios`, `ws`, `qs`, `protobufjs` pinned to patched in-major versions).

## Operator Hardening

Production safety is a shared responsibility. Before deploying, follow the
checklist in `deploy/README.md` and `docs/build-and-runtime.md`: enable HMAC
signing, lock container egress, run under a process supervisor with backups and
alerting wired, and keep `a2aSessionMode=root-session`. The shipped Alertmanager
config routes to a no-op receiver by design (dev runs credential-free) — run
`pnpm obs:alertmanager:check` in your deploy pipeline so a placeholder routing
never reaches production silently.
