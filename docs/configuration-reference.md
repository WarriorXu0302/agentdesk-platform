# Configuration Reference

Two configuration surfaces in AgentDesk:

1. **Host environment** — process-wide settings (channel credentials, provider
   keys, gateway URL, feature flags, sweeps). The authoritative, fully-commented
   list is [`.env.example`](../.env.example) — copy it to `.env`. This doc does
   **not** duplicate it; see there for every env var.
2. **Per-group `container.json`** — one file per agent group, at
   `groups/<folder>/agent/container.json` (mounted read-only into that group's
   container). This is where you tune a _single_ group's behavior. The fields are
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

| Field           | Type   | Default  | Read by | What it does                                                                                                                                                                        |
| --------------- | ------ | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`      | string | `claude` | both    | Legacy/single-role LLM provider: `claude`, `openai`, `codex`, `opencode-go`, or `mock`. Execution resolution is session → group → `llm.execution.provider` → this field → `claude`. |
| `assistantName` | string | `''`     | both    | Display name the agent uses for itself.                                                                                                                                             |
| `groupName`     | string | `''`     | both    | Human label for the group (logs, cards).                                                                                                                                            |
| `agentGroupId`  | string | `''`     | both    | Stable id; normally set by the bootstrap script, not by hand.                                                                                                                       |

### Routing & conversation

| Field                  | Type            | Default | Read by   | What it does                                                                                                                                                                                                                                        |
| ---------------------- | --------------- | ------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxMessagesPerPrompt` | number          | `10`    | container | Max pending messages folded into one prompt turn.                                                                                                                                                                                                   |
| `confidenceThreshold`  | number in (0,1) | `0.70`  | container | classify_intent clarify cutoff: below this, the advisory tells the frontdesk to `ask_user_question` before delegating. Raise for a stricter group (finance), lower for a looser one (support). Out-of-range values fall back to 0.70. (roadmap 2.4) |

#### Enforced frontdesk dual-LLM routing (`llm`)

`llm.routing` is default-off. When enabled on a frontdesk, the runner performs a stateless, tool-free Routing call before frontdesk Execution. Worker A2A turns bypass Routing. `llm.execution` may also be used by itself to select a provider/model while keeping the legacy single-phase flow. Routing and Execution may independently use `claude`, `openai`, `codex`, or `opencode-go`.

Omitted policy fields take the documented defaults. Explicit invalid provider requirements, transport values, paths, integer ranges, confidence values, or fallback actions fail container startup; they are not silently coerced into a legacy or permissive route.

| Sub-field                                     | Type                              | Default / rule        | What it does                                                                                                                        |
| --------------------------------------------- | --------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `llm.routing.enabled`                         | boolean                           | `false`               | Enables enforced Routing for channel-entry chat turns in this group.                                                                |
| `llm.routing.provider`                        | string                            | required when enabled | Provider for Routing, independent of Execution.                                                                                     |
| `llm.routing.model`                           | string                            | required when enabled | Lightweight Routing model.                                                                                                          |
| `llm.routing.transport`                       | `responses` \| `chat-completions` | `chat-completions`    | Provider transport. OpenCode Go uses `chat-completions`.                                                                            |
| `llm.routing.promptFile`                      | relative string under `prompts/`  | required              | Request-time Routing policy file, nested-mounted read-only and SHA-256 correlated. Absolute/traversal/symlink escapes are rejected. |
| `llm.routing.timeoutMs`                       | integer 1000..120000              | `10000`               | Per Routing attempt timeout.                                                                                                        |
| `llm.routing.retryTimes`                      | integer 0..3                      | `1`                   | Additional complete Routing attempts; maximum calls are `1 + retryTimes`.                                                           |
| `llm.routing.context.maxMessages`             | integer 1..10                     | `4`                   | Maximum current-turn chat rows in the bounded Routing view.                                                                         |
| `llm.routing.context.maxChars`                | integer 1000..50000               | `12000`               | Character ceiling for the rendered Routing request.                                                                                 |
| `llm.routing.confidence.threshold`            | number 0..1                       | `0.70`                | A `delegate` below this confidence is replaced by `belowThresholdAction`.                                                           |
| `llm.routing.confidence.belowThresholdAction` | `clarify` \| `reject`             | `clarify`             | Non-delegating action enforced for low-confidence delegation.                                                                       |
| `llm.routing.fallback.action`                 | `clarify` \| `reject`             | `clarify`             | Fail-closed action after prompt/transport/output validation failures.                                                               |
| `llm.execution.provider`                      | string                            | legacy `provider`     | Provider for frontdesk Execution. Session/group overrides remain higher precedence.                                                 |
| `llm.execution.model`                         | string                            | provider default      | Model for this Execution role. Ignored when a session/group provider override selects another provider.                             |
| `llm.execution.transport`                     | `responses` \| `chat-completions` | provider default      | Transport for this Execution role.                                                                                                  |

Routing outputs only `delegate`, `answer_self`, `clarify`, or `reject`. `delegate` is validated against the current live agent destinations and bypasses frontdesk Execution; the other actions call frontdesk Execution and forbid agent-destination sends for that turn. See [ADR-0054](decisions/ADR-0054-frontdesk-enforced-dual-llm-routing.md) and the [approved Spec](specs/frontdesk-dual-llm-routing.md).

### Memory & a2a

| Field            | Type                             | Default        | Read by | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | -------------------------------- | -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memoryMode`     | `workspace` \| `gateway`         | `workspace`    | both    | `gateway` = durable business/user memory (incl. `persona`, ADR-0057) goes through the backend gateway; the agent is instructed not to use workspace files as a source of truth, and Claude auto-memory is disabled. Honest scope: this is a PROMPT/config contract, not a filesystem lockout — the scope workspace stays writable for working notes, and the platform still archives compaction transcripts there (per-user scoped since ADR-0055). |
| `a2aSessionMode` | `agent-shared` \| `root-session` | `agent-shared` | both    | `root-session` = each (root session, target) gets its own worker session; **forced** when roster-DM is enabled.                                                                                                                                                                                                                                                                                                                                     |

### Backend gateway (the only path for business memory + authorization)

`backendGateway` is an object:

| Sub-field        | Type                             | Default          | What it does                                                                                                    |
| ---------------- | -------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `baseUrl`        | string                           | —                | Your gateway HTTP base. Required to enable the gateway tools for this group.                                    |
| `timeoutMs`      | number                           | 15000            | Per-request timeout.                                                                                            |
| `defaultHeaders` | object                           | —                | Static headers sent on every gateway call.                                                                      |
| `signingKey`     | string                           | —                | HMAC-SHA256 signing key (ADR-0018). Prefer the host signing proxy (ADR-0034) to keep this out of the container. |
| `signingHeaders` | `{timestamp?,nonce?,signature?}` | brand-namespaced | Override the signing header names.                                                                              |

### Multi-tenant resource limits (cgroup)

`resources` is an object (strongly recommended for shared deployments):

| Sub-field   | Type                   | Maps to                    |
| ----------- | ---------------------- | -------------------------- |
| `memoryMb`  | number                 | `docker run --memory <N>m` |
| `cpus`      | number (fractional ok) | `--cpus <N>`               |
| `pidsLimit` | number                 | `--pids-limit <N>`         |

### Network / egress (ADR-0032)

| Field     | Type   | Default          | What it does                                                                                                                                                                                                                                                                                                                      |
| --------- | ------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network` | string | unset → `bridge` | `docker run --network <value>`. Use an operator-managed egress-proxy network to lock down egress, or a built-in mode: `none` (no network — pure-DB workers), `host` (share host netns, rarely advisable), `bridge` (explicit default). Validated against an allowlist; an unsafe value is rejected and falls back to the default. |
| `env`     | object | —                | Extra `KEY=VALUE` env forwarded into the container (e.g. point a skill at a backend URL) without rebuilding the image. Provider/system env (TZ, OneCLI proxy, …) is layered separately and not overridable here.                                                                                                                  |

### Image, packages, mounts, skills, MCP

| Field              | Type                                   | Default | What it does                                                      |
| ------------------ | -------------------------------------- | ------- | ----------------------------------------------------------------- |
| `imageTag`         | string                                 | derived | Override the agent image tag for this group.                      |
| `packages`         | `{apt:[],npm:[]}`                      | empty   | Extra apt/npm packages baked at build.                            |
| `additionalMounts` | `[{hostPath,containerPath,readonly?}]` | empty   | Extra bind mounts (validated against an install-level allowlist). |
| `skills`           | `string[]` \| `'all'`                  | `'all'` | Which skills to enable for this group.                            |
| `mcpServers`       | record                                 | empty   | Extra MCP servers `{command,args,env}` available to the agent.    |

### Lifecycle

| Field        | Type   | Default | Read by   | What it does                                                                                                                                                                                                                             |
| ------------ | ------ | ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idleExitMs` | number | `0`     | container | Idle-exit window: after this many ms with no trigger-eligible pending message the container exits cleanly (frees memory). `0` = stay alive until the host-sweep 30-min ceiling. Env `AGENTDESK_IDLE_EXIT_MS` overrides this per process. |

## See also

- [`.env.example`](../.env.example) — host environment variables (authoritative).
- [`docs/enterprise-erp-gateway.md`](enterprise-erp-gateway.md) — the gateway contract.
- [`docs/isolation-model.md`](isolation-model.md) — session modes.
- [`docs/architecture.md`](architecture.md) — how the host + container read this file.
