# Environment Quick Start

[`.env.example`](../.env.example) is the **authoritative, fully-commented** list
of every environment variable — but it's 355 lines, and that's a lot to face on
day one. This page is a navigation layer: it groups the variables by *what you're
trying to do* and tells you which are actually required. It does not duplicate
the per-variable annotations — once you know which block you need, read that
block in `.env.example`.

> **"Required" means required only when its feature is enabled.** The host runs
> conservative fail-fast checks (`src/config-validate.ts`, ADR-0025): it demands
> a variable only when the feature that needs it is turned on. A minimal CLI
> deployment needs almost nothing. So don't fill in all 355 lines — fill in the
> block for the scenario you're running.

> **Replace every placeholder secret.** Sentinels like `replace-me-…` / `your-…`
> are baked into `src/security/known-weak-secrets.ts`; booting with one in a
> security-critical slot is a **hard startup error**, not a warning. Generate
> real values with `openssl rand -hex 32`.

---

## Scenario A — Minimal local (CLI channel, just kick the tires)

The smallest thing that runs an agent locally. No chat platform, no backend.
Pick a provider; everything else takes its default.

| Variable | Required? | Why / how to get |
|---|---|---|
| `OPENAI_BASE_URL` + `OPENAI_API_KEY` | yes, **if** you use the OpenAI-compatible provider | Your LLM gateway URL + key. The host fails fast if any `OPENAI_*` is set but the key is missing. |
| `ANTHROPIC_BASE_URL` | no | Only for a custom Anthropic-compatible endpoint. Leave unset for the default Claude path (token rewriting handled by OneCLI, never enters the container). |
| `BRAND_NAME` / `BRAND_NAMESPACE` | no | Rename the platform. Defaults: `AgentDesk` / `agentdesk`. |

The default provider is **Claude** — with no provider vars at all, you're on the
standard Claude path. Set the `OPENAI_*` pair only if a group selects the
`openai`/`codex` provider. That's it for local: run `pnpm dev` and talk to it
over the CLI channel.

> Don't forget `pnpm container:build` before the first message — the host boots
> without the image but every agent wake fails until it's built.

---

## Scenario B — Production (Feishu + backend gateway)

The real deployment: a chat channel in, your backend behind the gateway, capacity
limits, and locked-down `/metrics`.

### B1. Feishu channel (`src/channels/feishu.ts`)

| Variable | Required? | Why / how to get |
|---|---|---|
| `FEISHU_APP_ID` + `FEISHU_APP_SECRET` | **yes** (both — half a pair fails fast) | Feishu/Lark app credentials (developer console → your app → Credentials). The secret authenticates your bot; leaking it = impersonation. |
| `FEISHU_EVENT_MODE` | no (default `long-connection`) | `webhook` \| `long-connection` \| `hybrid`. |
| `FEISHU_ENCRYPT_KEY` + `FEISHU_VERIFICATION_TOKEN` | **yes, in `webhook`/`hybrid` mode** | Payload decryption + callback verification (app console → Event Subscriptions). Without them every inbound event is rejected. |
| `FEISHU_BOT_OPEN_ID` | no | Mention / self-message detection. |
| `WEBHOOK_PORT` | **yes, in webhook mode** (default `3000`) | Shared port serving the webhook **and** `/metrics` `/healthz` `/readyz`. |

### B2. Provider

Same as Scenario A — Claude by default, or the `OPENAI_*` pair for an
OpenAI-compatible provider. For key-out-of-container hardening see
`AGENTDESK_OPENAI_VIA_ONECLI` (ADR-0035) and the OneCLI block (`ONECLI_URL` /
`ONECLI_API_KEY`).

### B3. Backend gateway (the only path to business memory + authorization)

| Variable | Required? | Why / how to get |
|---|---|---|
| `GATEWAY_BASE_URL` | recommended | Default base URL `scripts/configure-enterprise-gateway.ts` writes into groups. Your gateway: see [`gateway-kickstart.md`](gateway-kickstart.md). |
| `GATEWAY_SIGNING_KEY` | **strongly recommended in production** | HMAC key (ADR-0018). Without it, anything that can reach your backend can forge requests — unsigned groups raise the `AgentDeskUnsignedGateways` alert. `openssl rand -hex 32`. |
| `AGENTDESK_GATEWAY_SIGNING_PROXY*` | no | Host-side signing proxy (ADR-0034) so the key never enters the container. Prefer this over per-container `signingKey`. |

### B4. Capacity & lifecycle (strongly recommended for shared hosts)

| Variable | Default | Why set it |
|---|---|---|
| `MAX_CONCURRENT_CONTAINERS` | `10` (on by default) | Global cap on simultaneous agent containers — prevents fork-bombing under an inbound burst. Tune to host capacity. |
| `AGENTDESK_IDLE_EXIT_MS` | `0` (off) | Idle-exit window so idle containers free memory. Production: set it (e.g. `120000`). |
| `AGENTDESK_SESSION_TTL_DAYS` | `0` (off) | Session TTL + archival. |
| `AGENTDESK_SESSION_TOKEN_BUDGET_PER_MIN` | `0` (off) | Per-session token/cost ceiling — a runaway session is killed and counted (roadmap 7.1). |
| `AGENTDESK_AUDIT_RETAIN_DAYS` | — | Audit retention window (compliance). |

### B5. Lock down observability

| Variable | Required? | Why |
|---|---|---|
| `METRICS_AUTH_TOKEN` | **yes in production** | Without it `/metrics` is open. When set, `/metrics` requires `Authorization: Bearer <token>`. |

### B6. Autowire (optional convenience)

`ENTERPRISE_FRONTDESK_FOLDER`, `ENTERPRISE_AUTO_WIRE_CHANNELS`,
`ENTERPRISE_AUTO_WIRE_P2P`, … let the host wire a channel → frontdesk topology at
boot instead of running the bootstrap script by hand. All optional; see the
"Enterprise autowire" block in `.env.example`.

---

## Scenario C — Add tracing (optional, on top of A or B)

Observability is **read-only** — it never mutates the identity trust chain or
message flow. Layer it on when you want traces in Phoenix/Grafana.

| Variable | Required? | Why / how to get |
|---|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | no | OTLP collector endpoint (e.g. Phoenix). Unset = no trace export. |
| `OTEL_SERVICE_NAME` | no | Service name in traces. |
| `OTEL_SDK_DISABLED` | no | Hard kill-switch for all OTEL. |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error`. |

See [`docs/architecture.md`](architecture.md) and the observability stack under
`infra/observability/`.

---

## Other blocks (read in `.env.example` when relevant)

- **Roster DM** (`ALLOW_ROSTER_DM`, `ROSTER_*`) — host-mediated, consent-gated
  directed messaging (ADR-0023). Off by default.
- **Security switches** (`ALLOW_ADMIN_WITHOUT_ROLES`) — fail-closed escape
  hatches (ADR-0019). Leave at the secure default unless you know why.
- **Delivery** (`DELIVERY_TIMEOUT_MS`, `DELIVERY_CONCURRENCY`,
  `INGRESS_DURABILITY`) — outbound resilience tuning (ADR-0016).
- **Misc** (`NODE_ENV`, `TZ`, `SHUTDOWN_DEADLINE_MS`) — runtime knobs.

## See also

- [`.env.example`](../.env.example) — the authoritative, per-variable reference.
- [`docs/configuration-reference.md`](configuration-reference.md) — per-group `container.json` fields (the *other* config surface).
- [`docs/gateway-kickstart.md`](gateway-kickstart.md) — standing up the backend gateway `GATEWAY_BASE_URL` points at.
