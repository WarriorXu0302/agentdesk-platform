# AgentDesk Architecture (Draft)

## Core Idea

Each agent session has a **pair** of mounted SQLite files. Together they are
the sole IO channel between host and container. No IPC files, no stdin
piping. Everything is a message.

- `inbound.db` — host writes, container reads. Holds `messages_in`,
  routing metadata, destinations, pending questions, processing_ack.
- `outbound.db` — container writes, host reads. Holds `messages_out`,
  session_state, container_state.

Splitting the writers this way eliminates cross-mount lock contention:
each file has exactly one writer. See `src/session-manager.ts` for the
cross-mount invariants (DELETE journal, open-write-close, etc.) that make
this work on virtiofs / Apple Container filesystems.

Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB update, so
the host can detect "alive but silent" containers without either side
writing to the other side's DB.

## Two-Level DB

**Central DB (host process, `data/v2.db`):**
- Agent groups, messaging groups, wirings, sessions
- Users, user_roles, agent_group_members
- Enterprise audit trail (`gateway_audit`, `enterprise_audit`)
- Inbound message dedup, progress reactions, schema_version
- Channel adapters don't touch this directly — the host does the lookup

**Per-session DBs (mounted into container at `/workspace/inbound.db` +
`/workspace/outbound.db`):**
- messages_in / messages_out — chat, tasks, webhooks, system actions,
  agent-to-agent traffic, everything
- No cross-file writes: host only writes inbound.db, container only
  writes outbound.db

## Agent Groups vs Sessions

An agent group has its own filesystem — folder, CLAUDE.md, skills, container
config. Multiple sessions can share the same agent group (same filesystem,
same skills) but each session gets its own inbound.db + outbound.db
mounted at known paths. Each session = a separate container with the same
agent group's filesystem but different session DBs.

## Message Flow

```
Platform event
  → Channel adapter (trigger check, ID extraction)
  → Returns: InboundEvent { channelType, platformId, threadId, message }
  → Router maps channelType + platformId → messaging group → agent groups
  → For each engaged agent: host resolves session, writes to inbound.db,
    calls wakeContainer(session)
  → Container spins up (or is already running)
  → Agent-runner polls inbound.db, finds new messages, publishes a
    batch RequestIdentity for trust-sensitive tools (see below)
  → Agent-runner processes with the configured provider
  → Agent-runner writes response to outbound.db
  → Host delivery loop polls outbound.db for undelivered rows
  → Host reads the response, delivers through the originating channel
    adapter (or agent-to-agent, or system action handler)
```

## Identity Model (RequestIdentity + origin_user_id)

Trust-sensitive tool handlers — the backend gateway MCP tools are the current
headline — must not take the requester identity from the agent's own tool
arguments. An agent that's been prompt-injected can otherwise call
`gateway_execute` as any user it names.

Two concrete mechanisms enforce this:

1. **Batch-pinned RequestIdentity (container side).** At the start of each
   poll batch, `container/agent-runner/src/request-identity.ts` derives
   a `RequestIdentity` from the first `trigger=1` chat row in the batch:
   - Prefer `origin_user_id` on the row (host-written, container cannot
     forge it).
   - Else parse `senderId` out of the message content and namespace it
     with the row's `channel_type`.
   - If neither is available (scheduled task, a2a hop with no attribution
     source), `source='agent-asserted'` — flag for the backend.

   The identity is published via `request-context.ts` and cleared at
   batch end. Tool handlers read it instead of querying the DB at call
   time — that eliminates the race where a mid-turn inbound would flip
   "most recent message" under the tool call.

2. **origin_user_id traversal (host side).** `messages_in` has an
   `origin_user_id` column. Channel-side inbound leaves it NULL (senderId
   in the content payload is authoritative). The agent-to-agent module
   (`src/modules/agent-to-agent/agent-route.ts`) copies it from the source
   session when writing the target row, so worker sessions see the real
   employee id even N hops down the delegation chain.

Gateway requests carry both the resolved `requester` block and an explicit
`requesterSource: 'session' | 'agent-asserted'` field so the backend can
apply a stricter policy to unauthenticated requests (typically: reject
writes when the source is agent-asserted).

## Channel Adapters

Channel adapters are responsible for:
1. Receiving platform events (webhooks, polling, websockets — platform-specific)
2. **Filtering**: deciding which messages to forward to the host for processing. This can be stateless (regex trigger match) or stateful (e.g., "was the bot mentioned in this thread at some point? If so, forward all subsequent messages"). The adapter receives a stream of unfiltered platform messages and decides which ones to pass on. How it decides is an implementation detail — AgentDesk doesn't know or care.
3. Extracting and standardizing two IDs:
   - **Platform channel ID** — identifies the conversation (WhatsApp group, Slack channel, email thread)
   - **Platform thread ID** — optional sub-context (Slack thread, GitHub PR comment thread)
4. Outbound delivery — sending responses back to the platform

The channel adapter does NOT know about agent group IDs or session IDs. It returns platform-level identifiers. The host maps those to the entity model.

The two-level ID scheme (channel ID + thread ID) gives flexibility:
- Want every Slack thread to be a separate session? Return unique thread IDs.
- Want all messages in a Slack channel to share a session? Return the same thread ID (or null).
- This is configured per-channel, not globally.

### Channel Adapter Configuration

Adapters are stateless — they receive config from the host at setup time, not from the DB directly.

**What lives in code (per channel type, doesn't change at runtime):**
- Auto-registration behavior (enabled/disabled, how it works)
- Sender allowlist rules
- Whether allowlisted senders can auto-register groups
- Platform-specific connection and message handling

These are decisions made when setting up the channel adapter. Change them = change the code.

**What lives in the DB (per group, varies group to group):**
- Which agent group handles it
- Trigger / filter rules (regex, @mention-only, exclude certain senders, etc.)
- Response scope (respond to all messages vs only triggered/allowlisted)
- Session mode (`shared`, `per-thread`, `agent-shared`, `per-user`, `per-user-per-thread`)

The host reads per-group config from the DB and passes it to the adapter at setup. If config changes at runtime (admin agent registers a new group, changes a trigger), the host calls the adapter's update method.

### Auto-Registration

When the adapter forwards a message from an unknown group, the host needs to decide whether to create the group and a session for it.

**The adapter controls whether to forward unknown messages** — based on its code-level auto-registration rules (sender allowlist, group-add detection, etc.). If the adapter forwards it, the host creates the group + session.

**Session creation for known groups:**
- Shared session mode: host finds the existing session or creates one if it's the first message
- Per-thread session mode: host looks up by threadId. If no session exists for this thread, auto-creates one with the same agent group
- Per-user session mode: host looks up by sender identity. If no session exists for this sender, auto-creates one with the same agent group
- Per-user-per-thread mode: host looks up by sender identity + thread

**The code-level rules are channel-specific:**
- WhatsApp: if an allowlisted number adds the bot to a group → auto-register. If an unknown number DMs → depends on the adapter's configuration.
- Email: if the sender is known → auto-register the thread. If unknown → drop.
- Slack: if someone @mentions the bot in a new channel → adapter decides whether to forward based on its rules.

No `channel_configs` table — channel-type-level behavior is baked into the adapter code.

### Chat SDK Integration

Chat SDK adapters are wrapped per-channel:
- Each Chat SDK adapter gets its own Chat instance
- Concurrency mode is configured per-channel (concurrent for chat, queue for tasks, debounce for webhooks)
- A bridge wraps the Chat instance + adapter to conform to AgentDesk's standard channel interface
- Chat SDK handles: webhook parsing, dedup, message history, platform API calls, rich content delivery
- AgentDesk handles: routing, agent lifecycle, session management

**Chat SDK's subscription model:**

Chat SDK has its own thread-level subscription concept (distinct from AgentDesk's channel-level registration):
- `onNewMention` / `onNewMessage(regex)` — fires on first contact (e.g., @mention in a Slack thread)
- `thread.subscribe()` — opts into all future messages in that thread
- `onSubscribedMessage` — fires for all messages in subscribed threads

This is sub-channel granularity. AgentDesk registers at the channel level ("listen to this Discord channel"). Chat SDK subscribes at the thread level ("track this specific Slack thread"). The bridge lets Chat SDK manage its own subscriptions internally — AgentDesk doesn't interfere with or replicate this.

**Platform capability differences:**

Capabilities vary significantly across adapters (see [Chat SDK adapter docs](https://chat-sdk.dev/docs/adapters)):
- **Slack**: Full rich content (Block Kit cards, modals, streaming, reactions, ephemeral messages)
- **Discord**: Embeds, buttons, streaming via post+edit
- **WhatsApp (Cloud API)**: DMs only, interactive reply buttons, no streaming, no reactions
- **GitHub/Linear**: Markdown comments, no interactive elements
- **Telegram**: Inline keyboard buttons, streaming via post+edit

The host/bridge handles graceful degradation — if an agent posts a card on a platform that doesn't support cards, it falls back to text.

Non-Chat-SDK channels (WhatsApp via Baileys, Gmail, custom integrations) implement the AgentDesk channel interface directly — no bridge, no Chat SDK types.

## Container Lifecycle

The host is an orchestrator:
1. **Spawn** — when wakeUpAgent is called and no container exists for the session
2. **Idle kill** — when a container has no unprocessed messages for some timeout period
3. **Limits** — MAX_CONCURRENT_CONTAINERS caps active containers

When a container spins up, the agent-runner immediately starts polling its session DB. Messages are already there waiting.

## Media Handling

### Inbound

Media is not downloaded by the host. Instead:
- Messages include download URLs (signed URLs where possible)
- Agent-runner downloads and processes media inside the container
- For channels where signed URLs don't work (e.g., WhatsApp with buffered streams), the channel adapter downloads the media and serves it via a local URL/server that the container can access

**Native content blocks (provider-dependent):**

The agent-runner detects file types and passes supported types as native content blocks where the provider supports it:

| Type | Claude | Codex | OpenCode |
|------|--------|-------|----------|
| Images (JPEG, PNG, GIF, WebP) | Native image content block | Save to disk, reference in prompt | Save to disk, reference in prompt |
| PDFs | Native document content block | Save to disk | Save to disk |
| Audio | Native audio content block | Save to disk | Save to disk |
| Other files (code, data, video, archives) | Save to disk | Save to disk | Save to disk |

"Save to disk" means downloaded to `/workspace/downloads/{messageId}/` and referenced in the prompt text as an available file path. The agent can use tools (Read, Bash) to access it.

The agent-runner builds the prompt differently per provider. For Claude, it constructs multi-part `MessageParam` content with image/document blocks. For Codex/OpenCode, everything is text with file path references.

### Outbound

Outbound file delivery is tool-based. The agent calls a tool (e.g., `send_file`) with a file path. The agent-runner moves the file to the outbox and writes the messages_out row.

```
/workspace/
  outbox/
    {message_id}/        ← one dir per messages_out row
      chart.png
      report.pdf
```

messages_out content references filenames only:

```json
{ "text": "Here's the chart", "files": ["chart.png", "report.pdf"] }
```

No paths in the DB — the convention is the contract. The host reads files from `outbox/{message_id}/` in the mounted session folder and delivers them via the adapter (Chat SDK `FileUpload` with buffer data, or platform-specific upload for native channels). Host cleans up the outbox directory after successful delivery.

Outbound files use a dedicated `send_file` MCP tool (separate from `send_message`). See [agent-runner-details.md](agent-runner-details.md) for the tool interface.

### Message Deduplication

Dedup is the channel adapter's responsibility. Chat SDK handles this internally. Native adapters track platform message IDs as needed. The host does not deduplicate — if the adapter forwards it, the host writes it.

## Session DB Schema

Two tables. JSON blobs for content — schema-free, format varies by `kind`.

```sql
-- Host writes, agent-runner reads
CREATE TABLE messages_in (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,      -- 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system'
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',  -- 'pending' | 'processing' | 'completed' | 'failed'
  status_changed TEXT,               -- ISO timestamp of last status change
  process_after  TEXT,               -- ISO timestamp. NULL = process immediately.
  recurrence     TEXT,               -- cron expression. NULL = one-shot.
  tries          INTEGER DEFAULT 0,  -- number of processing attempts

  -- routing (agent-runner copies to messages_out; agent never sees these)
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,

  -- payload (structure depends on kind)
  content        TEXT NOT NULL        -- JSON blob
);

-- Agent-runner writes, host reads
CREATE TABLE messages_out (
  id             TEXT PRIMARY KEY,
  in_reply_to    TEXT,               -- references messages_in.id (optional)
  timestamp      TEXT NOT NULL,
  delivered      INTEGER DEFAULT 0,
  deliver_after  TEXT,               -- ISO timestamp. NULL = deliver immediately.
  recurrence     TEXT,               -- cron expression. NULL = one-shot.

  -- routing (default: copied from messages_in by agent-runner)
  kind           TEXT NOT NULL,      -- 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system'
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,

  -- payload (format matches kind)
  content        TEXT NOT NULL        -- JSON blob
);

```

### Scheduling

One-shot and recurring tasks use the same tables — no separate scheduler.

**One-shot:** `process_after` (inbound) or `deliver_after` (outbound) with `recurrence = NULL`.

**Recurring:** Same, plus a `recurrence` cron expression. After the host marks a row as handled/delivered, if `recurrence` is set, it inserts a new row with `process_after`/`deliver_after` advanced to the next cron occurrence. Next time is computed from the scheduled time (not wall clock) to prevent drift.

**Host sweep** (every ~60s across all session DBs):
- `messages_in WHERE status = 'pending' AND (process_after IS NULL OR process_after <= now())` → wake agent
- `messages_in WHERE status = 'processing' AND status_changed < (now - stale_threshold)` → stale detection, increment tries, reset to pending with backoff
- `messages_out WHERE delivered = 0 AND (deliver_after IS NULL OR deliver_after <= now())` → deliver
- After completing/delivering a row with `recurrence`, insert next occurrence

**Active container poll** (~1s) checks the same conditions but only for sessions with running containers.

**Agent-runner creates schedules** by writing messages_in (to itself) or messages_out (reminders/notifications) with `process_after` and optionally `recurrence`.

### messages_in content by kind

**`chat`** — simple AgentDesk format. Any channel can produce this.
```json
{
  "sender": "John",
  "senderId": "user123",
  "text": "Check this PR",
  "attachments": [{ "type": "image", "url": "https://signed-url..." }],
  "isFromMe": false
}
```

**`chat-sdk`** — full Chat SDK `SerializedMessage`, passed through from bridge adapter. Includes `author`, `text`, `formatted` (mdast AST), `attachments`, `isMention`, `links`, `metadata`.

**`task`** — scheduled task firing.
```json
{ "prompt": "Review open PRs", "script": "scripts/review.sh" }
```

**`webhook`** — raw webhook payload.
```json
{ "source": "github", "event": "pull_request", "payload": { ... } }
```

**`system`** — host action result (response to a system action the agent requested).
```json
{ "action": "register_group", "status": "success", "result": { "agent_group_id": "ag-456" } }
```

### messages_out content by kind

Output `kind` determines the format and delivery adapter. Default: agent-runner copies `kind` and routing fields from the messages_in row it's responding to.

**`chat`** — simple AgentDesk format. AgentDesk channel delivers via `sendMessage(text)`.
```json
{ "text": "LGTM, merging now" }
```

**`chat-sdk`** — Chat SDK `AdapterPostableMessage`. Bridge adapter delivers via `thread.post()`. Can be markdown, card, or raw — adapter handles platform conversion.
```json
{ "markdown": "## Review\n**LGTM**", "attachments": [...] }
```
```json
{ "card": { "type": "card", "title": "Review", "children": [...] }, "fallbackText": "..." }
```

**`task`** — task result. Host logs and optionally notifies.
```json
{ "result": "3 PRs reviewed", "status": "success" }
```

**`webhook`** — webhook response. Host sends HTTP response or notifies.
```json
{ "response": { "status": 200, "body": { ... } } }
```

**`system`** — host action request (register group, reset session, etc.). Host reads, validates permissions, executes, writes result back as a `system` messages_in row.
```json
{ "action": "reset_session", "payload": { "session_id": "sess-123" } }
```

### Interactive Operations (Cards, Reactions, Edits)

All interactive operations flow through messages_in/out — the DB is the only IO boundary for the container. The agent uses MCP tools; the agent-runner translates tool calls into structured messages_out rows; the host delivers through the appropriate adapter method.

**Cards with user interaction (e.g., "Ask User Question"):**

1. Agent calls `ask_user_question` tool with question + options
2. Agent-runner writes messages_out with the question card
3. Host delivers as interactive card through adapter (e.g., Slack Block Kit buttons)
4. User clicks an option
5. Platform sends event back to adapter → host writes messages_in with the response
6. Agent-runner reads messages_in, matches to pending tool call, returns selection to agent as tool result

The agent-runner holds the tool call open while waiting for the user's response in messages_in. The round-trip goes: agent → messages_out → host → platform → user clicks → platform → host → messages_in → agent-runner → agent.

**Approvals:**

Two patterns, both handled at the host level:
- **Implicit**: Agent calls a tool that requires approval. Host intercepts, sends approval card to admin, waits for response, then executes or rejects. The agent doesn't know about the approval step.
- **Explicit**: Agent explicitly requests approval via a tool. Agent-runner writes the approval request to messages_out. Same flow as "ask user question" — response comes back through messages_in.

In both cases, the approval and action execution happen on the host side, not the agent side.

**Approval routing:** Privilege is a user-level concept. `user_roles` records `owner` (global only — first user to pair becomes owner) and `admin` (global or scoped to a specific `agent_group_id`). When an action requires approval, `pickApprover(agentGroupId)` returns candidates in order: scoped admins for that agent group → global admins → owners (deduplicated). `pickApprovalDelivery` then takes the first candidate reachable via `ensureUserDm` (with a same-channel-kind tie-break so a Discord approval request prefers a Discord-using approver). The approval card lands in the approver's DM messaging group, not the origin chat. Delivery is resolved through the Chat SDK's `openDM` for resolution-required channels (Discord/Slack/…) or the user's handle directly for direct-addressable channels (Telegram/WhatsApp/…), and the mapping is cached in `user_dms` for subsequent requests. See `src/access.ts`, `src/user-dm.ts`.

**Editing a sent message:**

Agent calls an `edit_message` tool with the message ID and new content. Agent-runner writes messages_out with an edit operation. Host calls `adapter.editMessage()`. Messages in the agent's context include integer IDs so the agent can reference them.

**Reactions:**

Agent calls `add_reaction` tool with message ID and emoji. Agent-runner writes messages_out with a reaction operation. Host calls `adapter.addReaction()`.

**Operations in messages_out content:**

```json
// Normal message (default)
{ "text": "LGTM" }

// Interactive card
{ "operation": "ask_question", "title": "Deploy", "question": "Approve deployment?", "options": ["Yes", "No", "Defer"] }

// Edit existing message
{ "operation": "edit", "messageId": "3", "text": "Updated: LGTM with minor comments" }

// Reaction
{ "operation": "reaction", "messageId": "5", "emoji": "thumbs_up" }
```

The host reads the `operation` field (if present) and calls the right adapter method. No operation field = normal message delivery. Platform capabilities vary — the host/bridge handles graceful degradation (e.g., reaction on a platform that doesn't support it → skip or send as text).

### Agent-to-Agent Communication

Sending a message to another agent uses the same routing fields as channel delivery. The agent-runner sets `channel_type: 'agent'` and `platform_id` to the target agent group ID. Optionally, `thread_id` can target a specific session (null = find or create the default session).

From the sending agent's perspective, it's the same mechanism as sending to Slack or WhatsApp — just a messages_out row with different routing. The host reads it, checks that this agent group has permission to message the target, resolves the target session, and writes a messages_in row to that session's DB.

```json
// messages_out routing fields
{ "kind": "chat", "channel_type": "agent", "platform_id": "pr-worker", "thread_id": null }
// messages_out content
{ "text": "Reset your session and re-review", "sender": "Supervisor", "senderId": "agent:pr-admin" }
```

The receiving agent gets a normal chat message. It doesn't need to know the source is another agent unless that's relevant context.

### Routing

**Default behavior:** Agent-runner copies routing fields (`kind`, `platform_id`, `channel_type`, `thread_id`) from the messages_in row to messages_out. Response goes back where it came from.

**Host validation:** Before delivering, the host checks that this agent group is permitted to send to the destination. The agent-runner copies routing; the host validates.

**Multi-destination pattern:** An agent may need to send to a different
channel than the origin (e.g., a webhook triggers a Slack notification).
The agent-to-agent module ships this out of the box:

1. `destinations` table lives in each session's `inbound.db`
2. `src/modules/agent-to-agent/write-destinations.ts` populates it on every
   container wake from the central-DB `agent_destinations` table
3. Agents pick a destination by logical name; agent-runner resolves to
   routing fields on the outbound message
4. Host validates against `agent_destinations` before delivery
   (`src/delivery.ts`)

## Core Properties
- Container isolation via filesystem mounts
- Credential proxy (OneCLI)
- Per-agent-group workspace (folder, CLAUDE.md, skills)
- Polling-based (not event-driven)
- Per-agent-group agent-runner recompilation on container startup (agent can modify its own source, request rebuild/restart, changes persist across teardowns)
- Host ↔ container IO through the per-session DB pair (`inbound.db` +
  `outbound.db`) — single writer per file, no stdin piping, no IPC files
- Agent commands are `messages_out` rows with `kind: 'system'`
- Agent-to-agent supported via target-agent routing on `messages_out`
- Scheduling uses `process_after` / `deliver_after` + `recurrence` on the same message tables
- Media via signed URLs, downloaded in the container
- Channel adapters use the Chat SDK bridge + a standard interface (trunk ships only the bridge/registry; platform adapters install via `/add-<channel>` skills)
- Routing: channel adapter extracts IDs, host maps to entities
- Concurrency: Chat SDK per-channel + container limits
- Session scoping: per-session DB, multiple sessions per agent group

## Design Decisions

**Session DB location:** Not in the agent group folder. Separate directory
under `data/v2-sessions/{agent_group_id}/{session_id}/`. Each session
folder contains two SQLite files — `inbound.db` (host-writable) and
`outbound.db` (container-writable) — plus the Claude SDK's `.claude/`
directory. The session identity IS the folder — no need to track
provider-specific session IDs.

**Container mount structure:**

```
/workspace/                 ← mount: session folder (read-write)
  .claude/                  ← Claude SDK session data (auto-created)
  inbound.db                ← host writes, container reads
  outbound.db               ← container writes, host reads
  .heartbeat                ← file touched by container-runner each poll
  outbox/                   ← agent-runner writes outbound files here
  agent/                    ← mount: agent group folder (nested, read-write)
    CLAUDE.md               ← agent instructions
    skills/                 ← agent skills
    ... working files
```

Two directory mounts: session folder at `/workspace`, agent group folder
at `/workspace/agent/`. The agent-runner CDs into `/workspace/agent/` to
run the agent. Claude SDK writes `.claude/` at `/workspace/.claude/` (root
of the workspace). The session DBs are at `/workspace/inbound.db` and
`/workspace/outbound.db`.

This works on both Docker (nested bind mounts) and Apple Container
(directory mounts only — no file-level mounts, but nested directory
mounts are supported).

**Session DB concurrent access:** The two files have exactly one writer
each — inbound.db writer is the host, outbound.db writer is the container.
This replaces the older "both sides write one file with WAL" design,
which didn't survive virtiofs / Apple Container mounts reliably. Both DBs
run in DELETE journal mode because cross-mount WAL coherency isn't
guaranteed (the `-shm` mapping doesn't propagate). See
`src/session-manager.ts` for the full set of cross-mount invariants and
`scripts/sanity-live-poll.ts` for empirical validation of what works on
which runtime.

**Session management:** Host-managed. The host creates session folders and mounts them. The container only sees its own session folder.

**Session creation (no race condition):**

1. Message arrives, host checks central DB for a session matching this
   group + messaging group + (owner, thread) scope
2. No session exists → host atomically creates session row in central DB,
   creates the session folder, initializes inbound.db + outbound.db,
   writes the message
3. More messages arrive before container starts → host finds the existing
   session, writes to the same inbound.db
4. Container starts, mounts the folder, agent-runner finds messages waiting

The central DB session row creation is the serialization point. No Claude SDK session ID to coordinate — the SDK discovers its own session data in `.claude/` when the agent runs.

**System actions:** The agent uses MCP tools (register group, reset session, schedule task, etc.). The agent-runner handles these tool calls and writes a structured, deterministic messages_out row with `kind: 'system'`. This is not natural language — it's a programmatic, structured payload that the host processes deterministically. Host validates permissions, executes, and writes the result back as a `system` messages_in row.

**Container lifecycle:** No warm pool. Containers are spawned on demand (wakeUpAgent) and torn down from the outside by the host when idle. Existing idle detection + teardown mechanism carries over.

## Operational Behavior

### Output Delivery

AgentDesk does not stream tokens to users. The Claude Agent SDK's `query()` yields complete results. The agent-runner writes one complete message to messages_out per result. The host delivers complete messages to channels.

Message editing is supported as an explicit operation (agent calls an `edit_message` tool), not as a streaming mechanism.

Typing indicators: host sets typing when a container is active for a session, clears when the container exits or a response appears in messages_out.

### Message Batching

When multiple messages arrive while the container is down, they accumulate as `handled = 0` rows in messages_in. When the container wakes up, the agent-runner queries all unhandled messages and processes them as a batch — multiple messages are formatted into a single `<messages>` XML block.

### Message Lifecycle

```
pending → processing → completed
                    → failed (after max retries)
```

- **pending**: Written by host. Ready to be picked up (if `process_after` is null or past).
- **processing**: Agent-runner sets this when it picks up the message. `status_changed` is set to now. Prevents other polls from re-picking the same message.
- **completed**: Agent-runner sets this after successful processing.
- **failed**: Set after max retries exhausted.

**Stale detection**: If a message is `processing` but `status_changed` is too old (e.g., >10 minutes), the host assumes the container crashed. It resets the message to `pending`, increments `tries`, and sets `process_after` with exponential backoff.

### Error Handling and Retries

Retries use `process_after` with exponential backoff. Each retry increments `tries` and pushes `process_after` further out:

- Try 1: immediate
- Try 2: +5s
- Try 3: +10s
- Try 4: +20s
- Try 5: +40s
- After max retries: status set to `failed`

The host computes this — not the agent-runner. When the host detects a stale `processing` message or the container exits with an error, it increments `tries`, computes the next `process_after`, and resets status to `pending`.

**Output-sent protection**: If messages_out already has delivered rows for a batch, don't retry (prevents duplicate messages to user).

### Host Polling

Two tiers:
- **Active containers (~1s)**: Poll session DBs for new messages_out rows to deliver
- **All sessions (~60s)**: Sweep all session DBs for due `process_after` / `deliver_after` timestamps, handle recurrence

## Flexibility Model

The architecture is **flexible for code changes, not configurable for everything**. Advanced setups (like the PR Factory below) use custom routing logic and host-side hooks — not database config columns.

### Code Structure for Skill Customization

AgentDesk is customized via skills — branches that get merged into the user's installation. Different skills add different capabilities (channels, integrations, behaviors). The code must be structured so that:

1. **Different customizations don't conflict.** Adding Slack and adding Telegram should not produce merge conflicts. Adding a new MCP tool should not conflict with adding a channel. Each type of customization should touch its own file(s).

2. **Core blocks of functionality are in separate files.** Channel registration, message formatting, MCP tools, routing logic, container management — each in its own file. A skill that changes how messages are formatted doesn't touch the file that handles container spawning.

3. **The index file is thin.** It wires things together (init DB, start adapters, start poll loops) but contains no business logic. All logic lives in purpose-specific modules that skills can modify independently.

4. **Don't over-split.** A simple change (e.g., adding a new message kind) shouldn't require edits across 5 files. Group related logic together. The goal is that each skill touches 1-2 files for its core change.

5. **Registration patterns over switch statements.** Channels, MCP tools, and providers should use registration/plugin patterns. A skill adds a channel by adding a file and a registration call — not by editing a central switch statement alongside every other channel.

**Practical example:** Adding a new channel via skill should require:
- One new file (the channel adapter or Chat SDK config)
- One line in the barrel file (`channels/index.ts`) to import the self-registering module
- Zero changes to routing, formatting, delivery, or container code

### Conflict Hotspots and Solutions

Analysis of 33 skill branches shows these files cause the most merge conflicts:

| Hotspot | Why it conflicts | Solution |
|-----------|-----------------|-------------|
| `src/index.ts` (2000 LOC) | Every skill patches the main loop, imports, init logic | Thin index that wires modules. Logic lives in purpose-specific files (router, delivery, session-manager, host-sweep). |
| `src/config.ts` | Every skill adds env vars to a central file | Config declared where it's used. Each module reads its own env vars. No central config registry that every skill edits. |
| `src/container-runner.ts` | Channel skills add mounts, env vars, credential setup | Declarative mount registration. Channels declare their mounts in their own file. Container runner reads from a registry, not a hardcoded list. |
| `src/db.ts` (750 LOC) | Schema, migrations, and all CRUD in one file | Split by entity. Numbered migrations. Skills add a migration file + edit one entity file. |
| `container/agent-runner/src/index.ts` | Agent protocol, IPC handling, formatting all in one file | Split into poll-loop, formatter, providers/, mcp-tools/. Session DB replaces IPC. |
| `src/ipc.ts` | Every MCP tool addition patches one file | `mcp-tools/` directory with barrel. Skills add a tool file + barrel line. |
| `src/channels/index.ts` | Every channel adds an import line at the same location | Barrel file with comment slots per channel (current pattern works, keep it). |

**Mount registration pattern:** Instead of every channel skill editing `buildVolumeMounts()`, channels declare mounts that the container runner collects:

```typescript
// channels/gmail.ts
registerChannel('gmail', {
  factory: createGmailAdapter,
  mounts: [
    { hostPath: '~/.gmail-mcp', containerPath: '/home/node/.gmail-mcp', readonly: false }
  ],
  env: ['GMAIL_OAUTH_TOKEN'],
});
```

The container runner reads registered mounts from the channel registry — no need to edit `container-runner.ts`.

**Config pattern:** Skills don't patch `config.ts` or `.env.example`. Skill-specific env vars are documented in the skill's SKILL.md — the setup process reads those instructions. Each module reads its own env vars directly:

```typescript
// channels/discord.ts
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;

// channels/gmail.ts  
const GMAIL_CREDS = process.env.GMAIL_CREDENTIALS_PATH;
```

Shared config (DATA_DIR, TIMEZONE, MAX_CONCURRENT_CONTAINERS) stays in `config.ts`. Channel/skill-specific config stays in the module that uses it.

### Code Style

**Line width: 120 characters.** Most statements fit on one line without sacrificing readability.

**Concise logging.** A thin wrapper keeps every log call on one line:

```typescript
log.info('IPC message sent', { chatJid, sourceGroup });
log.warn('Unauthorized IPC attempt', { chatJid });
log.error('Error processing', { file, err });
```

### DB File Structure

The DB layer is split by entity rather than kept in one monolithic file:

```
src/db/
  connection.ts              ← singleton, init, WAL mode
  schema.ts                  ← CREATE TABLE statements (current state, for reference)
  migrations/
    index.ts                 ← runner: checks version, applies pending
    001-initial.ts           ← initial schema
    002-pending-questions.ts ← example: adds pending_questions table
    ...                      ← skills append new numbered files
  agent-groups.ts            ← CRUD for agent_groups
  messaging-groups.ts        ← CRUD for messaging_groups + messaging_group_agents
  sessions.ts                ← CRUD for sessions + pending_questions
  index.ts                   ← barrel: re-exports everything
```

**Principles:**
- **Split by entity, not by layer.** Each entity file has its own CRUD functions (~50-100 lines). A skill that adds a column to messaging_groups edits `messaging-groups.ts` — doesn't touch sessions or agent groups.
- **Schema as current state + migrations as history.** `schema.ts` documents what the DB looks like now (read this to understand the schema). Migrations are append-only numbered files that describe how we got here.
- **No inline ALTER TABLE.** A migration runner with a `schema_version` table replaces `try { ALTER TABLE } catch { /* exists */ }` blocks. On startup, it checks the current version and applies pending migrations in order. Each migration is a function: `(db: Database) => void`.
- **Skills add migrations.** A skill that needs a new column adds a new numbered migration file. No conflicts with other skills' migrations as long as numbers don't collide (use timestamps or high-enough numbers for skill branches).

**Agent-runner session DB** uses the same pattern but lighter — no migrations needed since session DBs are created fresh by the host:

```
container/agent-runner/src/db/
  connection.ts          ← open session.db at fixed path, WAL mode
  messages-in.ts         ← read pending, update status
  messages-out.ts        ← write results, outbox queries
  index.ts               ← barrel
```

### What the base architecture must support primitively

These are the building blocks. None require special abstractions — they fall out of per-session DBs, host-managed routing, and messages_out with `kind: 'system'`:

1. **Multiple agent groups on the same channel with content-based routing.** Different messages in the same thread can route to different agent groups based on content (e.g., @mention routes to supervisor, normal messages route to worker). The channel adapter's routing logic — custom code — decides.

2. **Per-thread sessions from a shared agent group.** Multiple sessions share the same agent group (filesystem, skills, CLAUDE.md) but each gets its own session DB. Standard for worker pools.

3. **Session reset and replay.** Create a new session for the same thread. Mark old messages as unhandled so the poll picks them up again. Old output stays visible in the platform (e.g., Discord thread) for comparison. This is an action an agent can request — not automatic.

4. **Cross-session read access.** Some agents can query other sessions' data. Different access levels: manager sees messages_in/messages_out (review content). Supervisor sees full internals (agent logs, tool calls, debug traces). This is just filesystem/DB access — mount or query the right paths.

5. **Context duplication into new sessions.** When a supervisor is invoked in a worker's thread, a new session is created with relevant messages copied in. Custom host-side code handles this.

6. **Agent-initiated host actions.** The agent uses MCP tools (reset session, update skills, etc.). The agent-runner handles the tool call and writes a structured `system` messages_out row. The host reads and executes with permission checks. The agent can request, but the host decides.

### Example: PR Factory

Three agent groups, one Discord channel (PR Factory), plus an admin channel:

| Role | Agent Group | Where | Session model |
|------|-------------|-------|---------------|
| **Worker** | pr-worker | PR Factory threads | One session per thread (per PR) |
| **Manager** | pr-manager | PR Factory channel | Single session, queries across worker sessions |
| **Supervisor** | pr-admin | Admin channel + PR Factory (when @tagged) | Main session in admin channel; per-thread session when invoked in worker threads |

**Worker flow:** GitHub PR → Discord thread → worker agent reviews (triage, review, test plan). Each thread gets a session from the shared pr-worker group.

**Feedback flow:** User @tags supervisor in worker threads → custom routing sends to supervisor with a new session containing the thread's messages (duplicated). Supervisor collects feedback to filesystem. Worker doesn't see supervisor messages.

**Iteration flow:** User discusses feedback with supervisor in admin channel → supervisor suggests skill changes (shown as rich card with diff) → user approves → supervisor applies changes via host action → supervisor requests session reset + replay → workers re-review same PRs with updated skills in same threads but fresh sessions → user compares reviews side by side.

**Manager flow:** User talks to manager in PR Factory main channel (not in threads). Manager can search across all worker session DBs (messages_in/messages_out) to answer questions like "how many PRs today?" or "what topics are trending?" Can request actions (close PR, re-open).

**What's custom code vs. base architecture:**

| Capability | Base architecture | Custom code (PR Factory) |
|-----------|-------------------|-------------------------|
| Per-thread sessions | ✓ platformThreadId → session | |
| Shared agent group across sessions | ✓ Multiple sessions, one group | |
| Writing messages to session DB | ✓ Standard flow | |
| @mention routing to different agent | | ✓ Channel adapter routing logic |
| Context duplication into supervisor session | | ✓ Host-side hook on supervisor invocation |
| Session reset + replay | ✓ Primitives (new session, mark unhandled) | ✓ Supervisor action triggers it |
| Skill updates | ✓ Filesystem writes | ✓ Supervisor action applies changes |
| Cross-session queries | ✓ DB/filesystem access | ✓ Manager's tools know where to look |
| Rich card output | ✓ Structured output in messages_out | |

## Central DB Schema

The central DB handles routing and entity management. All content and execution state lives in per-session DBs.

```sql
-- Agent workspaces: folder, skills, CLAUDE.md, container config
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,              -- default for sessions (null = system default)
  container_config TEXT,              -- JSON: { additionalMounts, timeout }
  created_at       TEXT NOT NULL
);

-- Platform groups/channels (WhatsApp group, Slack channel, Discord channel, email thread, etc.)
CREATE TABLE messaging_groups (
  id                     TEXT PRIMARY KEY,
  channel_type           TEXT NOT NULL,     -- 'whatsapp', 'slack', 'discord', 'telegram', 'email'
  platform_id            TEXT NOT NULL,     -- platform-specific ID (JID, channel ID, etc.)
  name                   TEXT,
  is_group               INTEGER DEFAULT 0,
  unknown_sender_policy  TEXT NOT NULL DEFAULT 'strict',  -- 'strict' | 'request_approval' | 'public'
  created_at             TEXT NOT NULL,
  UNIQUE(channel_type, platform_id)
);

-- Users (messaging platform identities, namespaced "<channel_type>:<handle>")
CREATE TABLE users (
  id           TEXT PRIMARY KEY,   -- e.g. 'telegram:123456', 'discord:1470...'
  kind         TEXT NOT NULL,      -- mirrors the channel_type prefix
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- Roles (owner is global only; admin can be global or scoped to an agent_group)
CREATE TABLE user_roles (
  user_id         TEXT NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL,   -- 'owner' | 'admin'
  agent_group_id  TEXT REFERENCES agent_groups(id),  -- NULL for global
  granted_by      TEXT,
  granted_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
-- owner rows must have agent_group_id = NULL (enforced in db/user-roles.ts)

-- Membership (explicit non-privileged access; admin/owner imply membership)
CREATE TABLE agent_group_members (
  user_id         TEXT NOT NULL REFERENCES users(id),
  agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id),
  added_by        TEXT,
  added_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

-- DM resolution cache (so cold DMs aren't re-resolved every time)
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);

-- Which agent groups handle which messaging groups, with what rules
CREATE TABLE messaging_group_agents (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  trigger_rules      TEXT,              -- JSON: { pattern, mentionOnly, excludeSenders, includeSenders }
  response_scope     TEXT DEFAULT 'all',    -- 'all' | 'triggered' | 'allowlisted'
  session_mode       TEXT DEFAULT 'shared', -- 'shared' | 'per-thread' | 'agent-shared' | 'per-user' | 'per-user-per-thread'
  priority           INTEGER DEFAULT 0,     -- higher = checked first when multiple agents match
  created_at         TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);

-- Sessions: one folder = one session = one container when running
-- Folder path is derived: sessions/{agent_group_id}/{session_id}/
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),  -- null for internal/spawned sessions
  thread_id          TEXT,              -- platform thread ID (null for shared session mode)
  agent_provider     TEXT,              -- override per session (null = inherit from agent_group)
  status             TEXT DEFAULT 'active',    -- 'active' | 'closed'
  container_status   TEXT DEFAULT 'stopped',   -- 'running' | 'idle' | 'stopped'
  last_active        TEXT,              -- last message activity timestamp
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);

-- Pending interactive questions (cards waiting for user response)
-- Host writes when delivering a question card, deletes when response received
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,     -- the messages_out row that sent the card
  platform_id    TEXT,              -- where the card was delivered
  channel_type   TEXT,
  thread_id      TEXT,
  created_at     TEXT NOT NULL
);
```

### Pending Question Flow

When the host delivers a messages_out row with `operation: 'ask_question'`:
1. Host delivers the card via the channel adapter
2. Host writes a `pending_questions` row mapping `question_id` → `session_id`

When a Chat SDK `ActionEvent` (button click) arrives:
1. Bridge extracts `actionId` from the event
2. Host looks up `pending_questions` by `question_id` (derived from actionId — the bridge maintains the mapping)
3. Host finds the target session, writes a messages_in row with `questionId` + `selectedOption`
4. Host deletes the `pending_questions` row
5. Agent-runner picks up the messages_in row, matches to the pending tool call, returns the selection

This avoids scanning session DBs. The central DB is the routing lookup — same pattern as message routing.

Also used for host-generated approval cards: when the host sends an approval request to the admin's DM, it writes a `pending_questions` row. The admin's response is routed back to the originating session.

### Container lifecycle states

```
stopped → running → idle → stopped
                  ↗
            idle → running (new message while warm)
```

- **stopped**: No container. Swept at 60s for due scheduled messages.
- **running**: Actively processing. Polled at 1s for messages_out.
- **idle**: Done processing, container still warm (up to 30 min timeout). Polled at 1s so new messages are picked up quickly.
- After idle timeout → host kills container → stopped.

## Agent-Runner Architecture

The agent-runner is the process inside the container. It mediates between the session DB and the Claude SDK — polling for work, formatting messages for the agent, translating tool calls into DB rows, and managing the agent lifecycle.

### IO Model

All IO goes through the session DB. No stdin, no stdout markers, no IPC files.

- Initial input and follow-ups: poll `messages_in`
- Output: write `messages_out` rows
- MCP tools: write DB rows (no IPC files)
- Shutdown: host kills the container on idle timeout, or the agent-runner exits when there's no pending work

### Poll Loop

1. Query `messages_in WHERE status = 'pending' AND (process_after IS NULL OR process_after <= now())`
2. If rows found: set `status = 'processing'`, `status_changed = now()` on each
3. Batch messages into a single prompt (strip routing fields, format by kind)
4. Push into Claude SDK's MessageStream
5. Process agent output → write `messages_out` rows
6. Set processed messages to `status = 'completed'`
7. Back to step 1. If no messages found, sleep briefly and re-poll (container stays warm for idle timeout)

### Message Formatting by Kind

Agent-runner strips routing fields (`platform_id`, `channel_type`, `thread_id`) before formatting. The agent never sees routing info — it only sees content.

- **`chat`** — format into `<messages>` XML block
- **`chat-sdk`** — extract text, author, attachments from serialized message; format into `<messages>` XML
- **`task`** — format as `[SCHEDULED TASK]` prefix + prompt. Run pre-script if present.
- **`webhook`** — format as `[WEBHOOK: source/event]` + JSON payload
- **`system`** — host action results (e.g., "register_group succeeded"). Format as system context, not chat.

Mixed batches (e.g., a chat message + a system result both pending) are combined into one prompt with clear delimiters.

### MCP Tools

MCP tools write directly to the session DB.

**Core tools:**

| Tool | What it does |
|------|-------------|
| `send_message` | Write `messages_out` row, `kind: 'chat'` |
| `send_file` | Move file to `outbox/{msg_id}/`, write `messages_out` with filenames |
| `schedule_task` | Write `messages_in` row (to self) with `process_after` + `recurrence`. Or `messages_out` with `deliver_after` for outbound reminders. |
| `list_tasks` | Query `messages_in WHERE recurrence IS NOT NULL` |
| `pause_task` / `resume_task` / `cancel_task` | Modify `messages_in` rows (update status, clear/set recurrence) |
| `register_agent_group` | Write `messages_out`, `kind: 'system'`, `action: 'register_agent_group'` |

**New tools:**

| Tool | What it does |
|------|-------------|
| `ask_user_question` | Write `messages_out` with question card. Hold tool call open, poll `messages_in` for response matching `questionId`. Return selection as tool result. |
| `edit_message` | Write `messages_out` with `operation: 'edit'` |
| `add_reaction` | Write `messages_out` with `operation: 'reaction'` |
| `send_to_agent` | Write `messages_out` with `channel_type: 'agent'`, `platform_id: '{target}'` |
| `send_card` | Write `messages_out` with card structure |

See [agent-runner-details.md](agent-runner-details.md) for full MCP tool parameter definitions.

### Cards

**Agent-initiated (outbound):** Tool-based. Agent calls `ask_user_question` (interactive card with options) or `send_card` (structured card). Agent-runner writes the card structure to messages_out. Host/adapter handles platform-specific rendering (Slack Block Kit, Discord embeds, Telegram inline keyboard, text fallback).

**Host-initiated (approval cards):** When an action requires approval, the host generates a standardized approval card and sends it to the admin's DM. These are not agent-initiated — the agent doesn't know about the approval step. The card format is fixed (action description + approve/deny buttons).

**Inbound (card responses):** Not a card — it's a messages_in row with `questionId` + `selectedOption` in the content. Agent-runner matches to the pending `ask_user_question` tool call and returns the selection as the tool result.

### Commands

Messages starting with `/` are checked against three lists:

**Whitelisted commands (pass-through to agent):**
- Standard slash commands that the agent provider handles natively (e.g., Claude's built-in commands)
- Passed raw, no `<messages>` XML wrapping

**Admin-only commands (require admin sender):**
- `/remote-control` — remote control session
- `/clear` — clear session context
- `/compact` — force context compaction
- If sent by a non-admin user, the command is rejected with an error message. Not forwarded to the agent.

**Filtered commands (dropped entirely):**
- Commands that don't make sense in the AgentDesk context or could cause issues
- Silently dropped — no error, no forwarding

The command lists are hardcoded in the agent-runner. Admin verification happens host-side before the message ever reaches the container: `src/command-gate.ts` queries `user_roles` (owner / global admin / scoped-admin-of-this-agent-group) and either passes the message through, drops it, or routes it elsewhere. The container has no notion of admin identity — no env var, no DB query, no per-message check.

### Recurring Tasks

The agent-runner processes recurring task messages like any other messages_in row. After the agent-runner marks a recurring message as `completed`, the **host** handles inserting the next occurrence (new messages_in row with `process_after` advanced to next cron time). The agent-runner doesn't manage recurrence — it just processes what it finds.

Pre-scripts: if a task message has a `script` field, run it first. If `wakeAgent = false`, mark completed without invoking Claude.

### Agent-to-Agent Messaging

**Outbound:** Agent calls `send_to_agent` tool → agent-runner writes messages_out with `channel_type: 'agent'`, `platform_id` = target agent group ID. Host validates permissions and writes to target session's messages_in.

**Inbound:** Messages from other agents arrive as normal `chat` messages_in rows. The content includes `sender` and `senderId` (e.g., `"senderId": "agent:pr-admin"`). No special formatting — the agent sees it as a chat message.

### Agent-Runner Properties

- AgentProvider interface wraps SDK-specific query logic (trunk ships the `claude` provider; additional providers like OpenCode install via `/add-<provider>` skills)
- Session resume via provider-specific mechanisms
- System prompt loading from CLAUDE.md files
- PreCompact hook for transcript archiving (Claude provider)
- Script execution for task-kind messages

## Open Questions

- **Approval routing** — how does the host find the admin's DM conversation? What if no DM channel exists? Is the approval list configurable per agent group or global?
- **MCP server lifecycle** — does the MCP server process persist across multiple queries in the same container, or restart each time?
- **Container startup config** — what config (if any) is passed to the container at launch beyond env vars? The session DB is at a fixed mount path. System prompt comes from CLAUDE.md. Provider name comes from env. What else?
- **Idle detection with pending questions** — when `ask_user_question` is waiting for a response, the container should not be considered idle. Also need to detect when the agent is still working (active tool calls, subagents) and avoid killing the container even if no messages_out have been written recently.

## Related Documents

- **[api-details.md](api-details.md)** — Channel adapter interface (AgentDesk + Chat SDK bridge), message content examples, host delivery logic
- **[agent-runner-details.md](agent-runner-details.md)** — AgentProvider interface, MCP tools, message formatting, media handling, provider implementations
