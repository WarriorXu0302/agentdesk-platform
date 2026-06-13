# Image-generation prompt — `architecture.png`

Source prompt for the canonical architecture diagram. Feed this to an image
model (or adapt it for a vector tool), then save the result as
`architecture.png` in this folder. Keep it in sync with the code: if a
load-bearing structure changes, update this prompt and regenerate.

---

## "AgentDesk: An Open Multi-User Enterprise Agent Platform"

### 1. Overall Style & Aesthetic
Generate a scientific system-architecture diagram with a **clean, modern, flat design** suitable for a top-tier systems/AI conference. Use a **soft pastel palette** (muted blues, soft greens, light oranges/salmon, gentle grays) on **clean white rounded-corner containers** with subtle drop shadows. Connectors are **thick, clean lines**: **solid** for the primary request→reply flow, **dashed** for feedback/secondary/control flows, and a **distinct gold/amber line** reserved exclusively for the identity-trust-chain thread. Use **stylized flat icons** — cute robot heads for agents, folded-corner document icons for data/DB files, gear icons for host processing, code-bracket `{}` icons for scripts, shield/lock icons for security & identity, a magnifying glass for observability, a funnel for routing. Clean **sans-serif** font; short legible labels with light-gray sub-annotations. Layout flows **left → right** through three labeled vertical stages, with **two horizontal cross-cutting bands** underneath all stages. Add small **status pills** on components: filled green `DEFAULT` (on by default) vs hollow orange `OPTIONAL` (flag/config-gated).

### 2. Overall Layout Structure
Three main vertical panels with pastel headers, plus two full-width horizontal bands at the bottom:
- **Left — Stage 1: Multi-Channel Ingress & Identity Capture**
- **Middle — Stage 2: Host Orchestration & Isolated Sessions** *(the single-process "brain")*
- **Right — Stage 3: Containerized Execution & Backend Gateway**
- **Cross-cutting Band A** (thin, gold, threading through all three stages): **"Identity Trust Chain — Unforgeable, End-to-End"**
- **Cross-cutting Band B** (wide, bottom, gray): **"Observability (Read-Only) · Reliability & Durability · Security / Supply-Chain Hardening"**
- A dashed return arrow curving along the top from Stage 3 back to Stage 1, labeled **"Reply Delivery (retry · backoff · DLQ · in-order)"**.

### 3. Detailed Component Description by Stage

**Stage 1 — Multi-Channel Ingress & Identity Capture (Left)**
- Top-left: chat-platform icons (Feishu/Lark, CLI/terminal, faded Discord/Slack/Telegram) feeding **"Chat Users & Group Chats"** (*one entry point serves the whole company*).
- Channel Adapters row: **"Feishu Adapter"** (*webhook / long-conn / hybrid; signature-verified + AES-decrypted*), **"CLI Adapter"** (*local Unix socket*), and a dashed **"Fork-Free Extensions"** box with `OPTIONAL` pill (*manifest + contract gate; fail-open; Discord/Slack/Telegram via Chat-SDK bridge*).
- **Shared Webhook Server** gear box (*body-size cap · timeouts · always exposes `/healthz` `/readyz` `/metrics`*).
- Thick arrow into **"Router · `routeInbound`"** funnel, fed by small boxes: **"Inbound Dedup"**, **"Access Gate / Sender Scope"**, **"Engage Mode (always / mention / mention-sticky)"**.
- **"`inbound_ingress` (raw envelope)"** document/DB icon (*persisted before routing → at-least-once, no silent loss; operator-replayable*).
- Gold shield callout **"Capture `RequestIdentity` / `origin_user_id`"** (*identity bound from the trusted inbound row, not from agent input*) — origin of Band A.

**Stage 2 — Host Orchestration & Isolated Sessions (Middle)**
Wrap the panel in a labeled frame **"Single Node Host Process"** (emphasize: one process).
- **Frontdesk Agent** robot head **"Frontdesk — `classify_intent`"** (*≥0.85 dispatch · 0.70–0.85 suggest · <0.70 clarify*), with a **`classification_log`** doc (*decision audited & reconciled with outcome*).
- Arrows fan out to 2–3 **"Worker Agent"** robot heads, labeled **"agent→agent routing (ACL-enforced)"**, with a **"`spawn_depth` ≤ N"** badge (*prevents runaway delegation chains*). The gold thread runs along these arrows: **"`origin_user_id` propagated + host cross-validated"** (*rejects prompt-injected impersonation*).
- **"Per-User / Per-Thread Session Isolation"** (*shared · per-thread · per-user · per-user-per-thread*) with several isolated session capsules.
- **Three-DB Single-Writer Model** (prominent): three color-distinct DB cylinders — **Central `v2.db`** (blue, *host-written: identity, wiring, audit; WAL*), **`inbound.db`** (green, *host-writes → container reads*), **`outbound.db`** (orange, *container-writes → host reads*). Boxed note: **"Single-writer invariant · `journal_mode=DELETE` for cross-mount visibility · even/odd `seq` parity."**
- **Host-Sweep (60s)** gear (*idle-exit · crash-row reset w/ backoff · archive · retention · SLA*).

**Stage 3 — Containerized Execution & Backend Gateway (Right)**
- **"Per-Session Agent Container"** (shield-bordered box) with hardening badges: **non-root**, **no-new-privileges**, **cgroup limits**, **digest-pinned base**, **global concurrency cap**, and a dashed `OPTIONAL` **egress lock**.
- Inside: **"Agent Runner · poll-loop"** robot reading `inbound.db` / writing `outbound.db` (thin cross-mount arrows to Stage-2 DBs), a **"Providers: Claude · OpenAI · (mock)"** chip, a **"Skills + composed `CLAUDE.md`"** `{}` icon.
- **MCP Tool Belt**: **classify_intent · ask_user_question · approvals · gateway tools**.
- **Backend Gateway ($\mathcal{G}$) — "The Only Authorized Backend Path"** (bold gold-shield panel) with six tool chips: **`describe` · `authorize` · `execute` (idempotent, dryRun) · `memory_get` · `memory_upsert` · `memory_search`**. Annotations: **"HMAC-SHA256 signed (timestamp · nonce · signature)"** on the outgoing arrow; **"`gateway_audit`"** doc (*two-phase intent→final; one row per backend call: who / what / when / outcome*); `OPTIONAL` **"Host Signing Proxy"** (*signing key never enters the container; per-session token; fail-closed*); lock on the memory return arrow **"nonce-fenced `UNTRUSTED_MEMORY` (prompt-injection isolation)"**.
- Arrow out to a faded **"Operator's Backend (ERP / CRM / API / ticketing)"** (*platform is business-agnostic — backend is pluggable, not hardcoded*).
- Reply path: `outbound.db` → **"Delivery"** (retry/backoff/DLQ/in-order) → top dashed return arrow to Stage 1.

**Band A — Identity Trust Chain** (gold ribbon, four nodes left→right): **"`RequestIdentity` (ingress)"** → **"`origin_user_id` across a2a hops"** → **"host cross-validation (anti-impersonation)"** → **"HMAC signing + `gateway_audit`"**. Caption: **"Every backend call attributable to the real end user; a prompt-injected agent cannot forge identity."**

**Band B — bottom gray band, three segments:**
- **Observability (Read-Only):** chips **"`/metrics` (25+ signals)"**, **"OTel traces → Phoenix (`agent.turn` / `provider.request` / `mcp.*`)"**, **"Grafana + 18 alert rules"**, **"RUNBOOK + drift-guard tests"**. Note: **"never mutates the identity chain or message flow."**
- **Reliability & Durability:** **"persist-before-route"**, **"DLQ + operator replay"**, **"graceful shutdown drain"**, **"crash-safe recovery"**, **"online SQLite backup"**.
- **Security / Supply-Chain Hardening:** **"fail-closed defaults"**, **"config validation (reject placeholder secrets)"**, **"`pnpm audit` CI gate + Dependabot"**, **"secret-scan pre-commit"**.

### 4. Legend (bottom-right)
- **Solid** = primary request→reply · **Dashed** = feedback/control/optional · **Gold** = identity trust chain.
- **Status pills:** green `DEFAULT` = on out-of-the-box · orange `OPTIONAL` = flag/config-gated (default off; e.g. Roster-DM, signing proxy, egress lock, OpenAI-via-vault, plaintext trace capture).
- **DB colors:** blue = central (host) · green = inbound (host→container) · orange = outbound (container→host).
- **Shield/lock** = security/identity boundary · **Robot head** = LLM agent.
- Tagline at the very bottom: **"Channel ingress → frontdesk dispatch → isolated per-user sessions → sandboxed execution → one audited, identity-bound backend gateway."**
