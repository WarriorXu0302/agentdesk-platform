# Configuration Reference

Two configuration surfaces in AgentDesk:

1. **Host environment** — process-wide settings (channel credentials, provider
   keys, gateway URL, feature flags, sweeps). The authoritative, fully-commented
   list is [`.env.example`](../.env.example) — copy it to `.env`. This doc does
   **not** duplicate it; see there for every env var.
2. **Per-group `container.json`** — one file per agent group, at
   `groups/<folder>/agent/container.json` (mounted read-only into that group's
   container). This is where you tune a *single* group's behavior. The fields are
   read on two sides — the **host** (`src/container-config.ts`, spawn/mounts) and
   the **container runner** (`container/agent-runner/src/config.ts`, runtime) —
   so they were scattered. This doc consolidates them.

> Roadmap note: this reference was the "operators can't discover per-group
> fields without reverse-engineering source" gap (`docs/business-optimization-roadmap.md` 1.6).
> When you add or rename a `container.json` field, update this table in the same PR.

## `container.json` fields (per agent group)

All fields are optional unless noted; omit a field to take its default. Unknown
fields are ignored. Most are set for you by
`scripts/init-enterprise-topology.ts` / `scripts/configure-enterprise-gateway.ts`
— edit by hand only when tuning.

### Identity

| Field | Type | Default | Read by | What it does |
|---|---|---|---|---|
| `provider` | string | `claude` | both | LLM provider: `claude`, `openai`, `codex`, or `mock`. Resolution order is session → group → this field → `claude`. |
| `assistantName` | string | `''` | both | Display name the agent uses for itself. |
| `groupName` | string | `''` | both | Human label for the group (logs, cards). |
| `agentGroupId` | string | `''` | both | Stable id; normally set by the bootstrap script, not by hand. |

### Routing & conversation

| Field | Type | Default | Read by | What it does |
|---|---|---|---|---|
| `maxMessagesPerPrompt` | number | `10` | container | Max pending messages folded into one prompt turn. |
| `confidenceThreshold` | number in (0,1) | `0.70` | container | classify_intent clarify cutoff: below this, the advisory tells the frontdesk to `ask_user_question` before delegating. Raise for a stricter group (finance), lower for a looser one (support). Out-of-range values fall back to 0.70. (roadmap 2.4) |

### Memory & a2a

| Field | Type | Default | Read by | What it does |
|---|---|---|---|---|
| `memoryMode` | `workspace` \| `gateway` | `workspace` | both | `gateway` = durable business memory MUST go through the backend gateway (local workspace fallback disabled). |
| `a2aSessionMode` | `agent-shared` \| `root-session` | `agent-shared` | both | `root-session` = each (root session, target) gets its own worker session; **forced** when roster-DM is enabled. |

### Backend gateway (the only path for business memory + authorization)

`backendGateway` is an object:

| Sub-field | Type | Default | What it does |
|---|---|---|---|
| `baseUrl` | string | — | Your gateway HTTP base. Required to enable the gateway tools for this group. |
| `timeoutMs` | number | 15000 | Per-request timeout. |
| `defaultHeaders` | object | — | Static headers sent on every gateway call. |
| `signingKey` | string | — | HMAC-SHA256 signing key (ADR-0018). Prefer the host signing proxy (ADR-0034) to keep this out of the container. |
| `signingHeaders` | `{timestamp?,nonce?,signature?}` | brand-namespaced | Override the signing header names. |

### Multi-tenant resource limits (cgroup)

`resources` is an object (strongly recommended for shared deployments):

| Sub-field | Type | Maps to |
|---|---|---|
| `memoryMb` | number | `docker run --memory <N>m` |
| `cpus` | number (fractional ok) | `--cpus <N>` |
| `pidsLimit` | number | `--pids-limit <N>` |

### Network / egress (ADR-0032)

| Field | Type | Default | What it does |
|---|---|---|---|
| `network` | string | unset → `bridge` | `docker run --network <value>`. Use an operator-managed egress-proxy network to lock down egress, or a built-in mode: `none` (no network — pure-DB workers), `host` (share host netns, rarely advisable), `bridge` (explicit default). Validated against an allowlist; an unsafe value is rejected and falls back to the default. |
| `env` | object | — | Extra `KEY=VALUE` env forwarded into the container (e.g. point a skill at a backend URL) without rebuilding the image. Provider/system env (TZ, OneCLI proxy, …) is layered separately and not overridable here. |

### Image, packages, mounts, skills, MCP

| Field | Type | Default | What it does |
|---|---|---|---|
| `imageTag` | string | derived | Override the agent image tag for this group. |
| `packages` | `{apt:[],npm:[]}` | empty | Extra apt/npm packages baked at build. |
| `additionalMounts` | `[{hostPath,containerPath,readonly?}]` | empty | Extra bind mounts (validated against an install-level allowlist). |
| `skills` | `string[]` \| `'all'` | `'all'` | Which skills to enable for this group. |
| `mcpServers` | record | empty | Extra MCP servers `{command,args,env}` available to the agent. |

### Lifecycle

| Field | Type | Default | Read by | What it does |
|---|---|---|---|---|
| `idleExitMs` | number | `0` | container | Idle-exit window: after this many ms with no trigger-eligible pending message the container exits cleanly (frees memory). `0` = stay alive until the host-sweep 30-min ceiling. Env `AGENTDESK_IDLE_EXIT_MS` overrides this per process. |

## See also

- [`.env.example`](../.env.example) — host environment variables (authoritative).
- [`docs/enterprise-erp-gateway.md`](enterprise-erp-gateway.md) — the gateway contract.
- [`docs/isolation-model.md`](isolation-model.md) — session modes.
- [`docs/architecture.md`](architecture.md) — how the host + container read this file.
