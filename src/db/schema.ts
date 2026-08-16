/**
 * Reference copy of the current v2 schema.
 * Read this to understand the DB structure.
 * Actual creation is done by migrations — do not use this at runtime.
 */

export const SCHEMA = `
-- Organizations: the multi-tenant isolation boundary (ADR-0052). A user in
-- org X cannot reach org Y's agent groups / sessions / triage data (enforced at
-- the host access gate). owner / global_admin are platform superusers above the
-- boundary by design.
CREATE TABLE organizations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Org membership = REACHABILITY, never privilege (ADR-0052). Privilege lives in
-- user_roles (with organization_id set). Keeping the two separate is what avoids
-- a circular access gate.
CREATE TABLE organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  added_by        TEXT REFERENCES users(id),
  added_at        TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX idx_org_members_user ON organization_members(user_id);

-- Agent workspaces: folder, skills, CLAUDE.md.
-- Privilege lives on users, not groups. Workspaces are NO LONGER all equal
-- (ADR-0052 superseded the original "all workspaces are equal" model): a
-- workspace belongs to at most one organization (organization_id), the tenant
-- boundary. NULL organization_id = legacy / un-orged (no isolation prerequisite).
-- Container config (mcpServers, packages, imageTag, additionalMounts) lives
-- in groups/<folder>/container.json on disk, not in the DB.
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,
  created_at       TEXT NOT NULL,
  organization_id  TEXT REFERENCES organizations(id),
  role             TEXT
);
CREATE INDEX idx_agent_groups_org ON agent_groups(organization_id);

-- Platform groups/channels. unknown_sender_policy governs what happens
-- when a sender we've never seen before posts in this chat.
-- The column DEFAULT is "strict" (inherited from migration 001), but it
-- only matters if something inserts without specifying the field, which no
-- current callsite does. Router auto-create hardcodes "request_approval"
-- (see src/router.ts); bootstrap scripts choose explicitly per context.
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
                        -- 'strict' | 'request_approval' | 'public'
  created_at            TEXT NOT NULL,
  -- Set when an owner explicitly DENIED registering this channel. The router
  -- drops such channels silently, and autowire refuses to re-wire them.
  denied_at             TEXT,
  UNIQUE(channel_type, platform_id)
);

-- Which agent groups handle which messaging groups.
-- engage_mode / engage_pattern / sender_scope / ignored_message_policy are
-- the four orthogonal axes that together define how an agent engages,
-- accumulates, and isolates context within a messaging group.
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  -- NOTE: these three are NULLABLE with no column default in the real DB —
  -- migration 008 added them via ALTER TABLE ADD COLUMN and backfilled instead.
  -- Callers must not rely on a DB-level default; the router treats NULL as the
  -- documented fallback ('mention' / 'all' / 'drop').
  engage_mode            TEXT,   -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern         TEXT,   -- regex; required when engage_mode='pattern';
                                 -- '.' means "match every message" (the "always" flavor)
  sender_scope           TEXT,   -- 'all' | 'known'
  ignored_message_policy TEXT,   -- 'drop' | 'accumulate'
  session_mode           TEXT DEFAULT 'shared',
                         -- 'shared' | 'per-thread' | 'agent-shared' |
                         -- 'per-user' | 'per-user-per-thread'
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);

-- Users are messaging-platform identifiers, namespaced: "phone:+1555...",
-- "tg:123", "discord:456", "email:a@x.com". A single human can own multiple
-- user rows if they have identifiers on unrelated channels (no linking yet).
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- Role grants on users. Privilege is user-level, not group-level.
--   role ∈ {owner, admin}
--   owner: always global (agent_group_id IS NULL)
--   admin: agent_group_id NULL = global, else scoped to that agent group
-- Invariant: admin @ A implies membership in A (no row needed).
-- Role grant. At most ONE scope axis is set per row (enforced in code):
--   global → (agent_group_id NULL, organization_id NULL)
--   group  → (agent_group_id set,  organization_id NULL)
--   org    → (agent_group_id NULL, organization_id set)   [ADR-0052]
CREATE TABLE user_roles (
  user_id         TEXT NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL,
  agent_group_id  TEXT REFERENCES agent_groups(id),
  organization_id TEXT REFERENCES organizations(id),
  granted_by      TEXT REFERENCES users(id),
  granted_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);
-- Global-scope lookups filter on role alone (command-gate + operability queries).
CREATE INDEX idx_user_roles_role ON user_roles(role);
CREATE INDEX idx_user_roles_org ON user_roles(organization_id);
-- One org-scoped grant of a role per (user, org); disjoint from group rows.
CREATE UNIQUE INDEX idx_user_roles_org_grant
  ON user_roles(user_id, role, organization_id)
  WHERE agent_group_id IS NULL AND organization_id IS NOT NULL;

-- "Known" membership in an agent group. Required for an unprivileged user
-- to interact with a workspace. Admin @ A is implicitly a member of A.
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

-- Cached mapping from (user, channel) to the DM messaging group. Lets the
-- host initiate cold DMs (pairing, approvals) without reprobing the
-- platform API on every send. Populated lazily by ensureUserDm().
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);

-- Sessions: one folder = one session = one container when running
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  owner_user_id      TEXT,
  root_session_id    TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  -- Independent of last_active. Only set when status flips to 'archived'
  -- by the session lifecycle sweep. Hard-delete gates on this, so an
  -- already-idle-for-a-year session still gets its configured
  -- archive retention window before the tarball is wiped.
  archived_at        TEXT,
  created_at         TEXT NOT NULL,
  -- a2a spawn-chain depth, capped by AGENTDESK_MAX_SPAWN_DEPTH (loop guard).
  spawn_depth        INTEGER NOT NULL DEFAULT 0,
  -- Provider-side conversation id. CORRELATION ONLY — never an authz input.
  conversation_thread_id TEXT
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);
CREATE INDEX idx_sessions_lookup_owner ON sessions(agent_group_id, messaging_group_id, owner_user_id, thread_id);
CREATE INDEX idx_sessions_agent_root ON sessions(agent_group_id, root_session_id);

-- Pending interactive questions
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Pending approvals for unknown senders (unknown_sender_policy='request_approval').
-- In-flight dedup via UNIQUE(messaging_group_id, sender_identity): a second
-- message from the same unknown sender while a card is pending is silently
-- dropped instead of spamming the admin.
CREATE TABLE pending_sender_approvals (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity    TEXT NOT NULL,    -- namespaced user id (channel_type:handle)
  sender_name        TEXT,
  original_message   TEXT NOT NULL,    -- JSON of the original InboundEvent
  approver_user_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  -- Card render metadata (migration 011), so the host can rebuild the exact card
  -- it sent and validate the clicked option against it.
  title              TEXT NOT NULL DEFAULT '',
  options_json       TEXT NOT NULL DEFAULT '[]',
  UNIQUE(messaging_group_id, sender_identity)
);
CREATE INDEX idx_pending_sender_approvals_mg ON pending_sender_approvals(messaging_group_id);


-- ==========================================================================
-- Tables added by later migrations. Kept in sync with the migration chain by
-- src/db/schema-drift.test.ts — that test fails if this reference and
-- runMigrations() ever disagree on tables, columns or indexes.
-- ==========================================================================

-- a2a permission table: the source agent group must have a row for the target
-- before it may address it. The ONLY grant surface for agent-to-agent sends.
CREATE TABLE agent_destinations (
  agent_group_id  TEXT NOT NULL,
  local_name      TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, local_name)
);

CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);

-- Chat SDK state backing store (kv / lists / locks / subscriptions). Written by
-- SqliteStateAdapter on behalf of chat-sdk adapters (Discord, Slack, Telegram …).
CREATE TABLE chat_sdk_kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  INTEGER
);

CREATE TABLE chat_sdk_lists (
  key         TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  value       TEXT NOT NULL,
  expires_at  INTEGER,
  PRIMARY KEY (key, idx)
);

CREATE TABLE chat_sdk_locks (
  thread_id   TEXT PRIMARY KEY,
  token       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE chat_sdk_subscriptions (
  thread_id      TEXT PRIMARY KEY,
  subscribed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Frontdesk intent-classification decisions plus the closing-the-loop outcome.
-- Read-only analytics; never an authorization input.
CREATE TABLE classification_log (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at             TEXT NOT NULL,
  session_id              TEXT,
  agent_group_id          TEXT,
  user_id                 TEXT,
  user_message            TEXT,
  recommended_worker      TEXT,
  confidence              REAL,
  candidates              TEXT,
  reasoning               TEXT,
  action                  TEXT NOT NULL,
  outcome_ref             TEXT,
  classification_id       TEXT,
  channel_type            TEXT,
  platform_id             TEXT,
  thread_id               TEXT,
  escalation_reason       TEXT,
  urgency_level           TEXT,
  conversation_thread_id  TEXT,
  feedback_kind           TEXT
);

CREATE INDEX idx_classification_log_at ON classification_log(occurred_at);

CREATE INDEX idx_classification_log_user ON classification_log(user_id, occurred_at);

CREATE INDEX idx_classification_log_worker ON classification_log(recommended_worker, occurred_at);

CREATE UNIQUE INDEX idx_classification_log_cls_id ON classification_log(classification_id);

CREATE INDEX idx_classification_log_conversation ON classification_log(conversation_thread_id);

-- Append-only audit of every roster-DM delivery decision (delivered/rejected +
-- reason).
CREATE TABLE dm_audit (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at          TEXT NOT NULL,
  scope_id             TEXT NOT NULL,
  agent_group_id       TEXT,
  session_id           TEXT,
  slot_label           TEXT,
  grant_id             TEXT,
  participant_open_id  TEXT,
  dm_platform_id       TEXT,
  message_out_id       TEXT,
  decision             TEXT NOT NULL,
  reason               TEXT
);

CREATE INDEX idx_dm_audit_at ON dm_audit(occurred_at);

CREATE INDEX idx_dm_audit_scope ON dm_audit(scope_id, occurred_at);

-- Roster-DM consent grants (ADR-0023). One row per (scope, participant); the
-- agent only ever sees the opaque slot_label, never the identity columns.
CREATE TABLE dm_grants (
  id                      TEXT PRIMARY KEY,
  scope_id                TEXT NOT NULL,
  agent_group_id          TEXT NOT NULL,
  slot_label              TEXT NOT NULL,
  participant_open_id     TEXT NOT NULL,
  dm_platform_id          TEXT NOT NULL,
  channel_type            TEXT NOT NULL DEFAULT 'feishu',
  consent_source          TEXT NOT NULL,
  consent_inbound_msg_id  TEXT NOT NULL,
  consent_origin_user_id  TEXT,
  created_at              TEXT NOT NULL,
  expires_at              TEXT,
  revoked_at              TEXT,
  max_sends               INTEGER NOT NULL DEFAULT 0,
  sends_used              INTEGER NOT NULL DEFAULT 0,
  origin_platform_id      TEXT
);

CREATE INDEX idx_dm_grants_scope ON dm_grants(scope_id);

CREATE INDEX idx_dm_grants_live ON dm_grants(scope_id, revoked_at, expires_at);

CREATE INDEX idx_dm_grants_origin ON dm_grants(origin_platform_id, participant_open_id);

-- Tumbling-window counters backing the roster-DM rate limits and the 24h
-- deploy-wide blast-radius cap, plus the per-message reservation marker.
CREATE TABLE dm_rate_ledger (
  key           TEXT NOT NULL,
  window_start  TEXT NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX idx_dm_rate_ledger_key ON dm_rate_ledger(key, window_start);

-- Append-only governance audit: role grants/revokes, command-gate denials, a2a
-- delegations, approval decisions/expiries, roster-grant lifecycle, autowire.
CREATE TABLE enterprise_audit (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at         TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  messaging_group_id  TEXT,
  agent_group_id      TEXT,
  actor               TEXT,
  details             TEXT
);

CREATE INDEX idx_enterprise_audit_at ON enterprise_audit(occurred_at);

CREATE INDEX idx_enterprise_audit_type ON enterprise_audit(event_type);

-- Append-only audit: one row per backend-gateway call. The pre-forward intent
-- write is FAIL-CLOSED — no signed call exists without a row here.
CREATE TABLE gateway_audit (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at               TEXT NOT NULL,
  session_id                TEXT,
  agent_group_id            TEXT,
  user_id                   TEXT,
  path                      TEXT NOT NULL,
  operation                 TEXT,
  requester_source          TEXT NOT NULL,
  status                    TEXT NOT NULL,
  http_status               INTEGER,
  duration_ms               INTEGER,
  idempotency_key           TEXT,
  input_hash                TEXT,
  error_msg                 TEXT,
  signed_as_group           TEXT,
  token_jti                 TEXT,
  proxy_request_id          TEXT,
  identity_mismatch         INTEGER,
  requester_source_coerced  INTEGER,
  audit_phase               TEXT
);

CREATE INDEX idx_gateway_audit_at ON gateway_audit(occurred_at);

CREATE INDEX idx_gateway_audit_user ON gateway_audit(user_id, occurred_at);

CREATE INDEX idx_gateway_audit_operation ON gateway_audit(operation, occurred_at);

CREATE INDEX idx_gateway_audit_proxy_req ON gateway_audit(proxy_request_id);

-- Per-session unforgeable tokens for the host-side gateway signing proxy
-- (ADR-0034), so "signingKey" never enters the container. Purged on a TTL.
CREATE TABLE gateway_proxy_token (
  jti             TEXT PRIMARY KEY,
  token_sha256    TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  agent_group_id  TEXT NOT NULL,
  allowed_paths   TEXT NOT NULL,
  source_ip       TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT
);

CREATE INDEX idx_gateway_proxy_token_session ON gateway_proxy_token(session_id);

CREATE INDEX idx_gateway_proxy_token_expires ON gateway_proxy_token(expires_at);

-- Platform-message-id dedup for at-least-once channel delivery. Pruned by the
-- host sweep on a TTL.
CREATE TABLE inbound_dedup (
  channel   TEXT NOT NULL,
  event_id  TEXT NOT NULL,
  seen_at   TEXT NOT NULL,
  PRIMARY KEY (channel, event_id)
);

CREATE INDEX idx_inbound_dedup_seen_at ON inbound_dedup(seen_at);

-- Persist-before-route (ADR-0022): the raw envelope lands here BEFORE routing,
-- so a routing failure is retained and operator-replayable, never dropped.
CREATE TABLE inbound_ingress (
  id            TEXT PRIMARY KEY,
  channel_type  TEXT NOT NULL,
  platform_id   TEXT NOT NULL,
  thread_id     TEXT,
  message_json  TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'received',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);

CREATE INDEX idx_inbound_ingress_status ON inbound_ingress(status, received_at);

-- Agent-initiated privileged actions awaiting an admin click (install_packages,
-- add_mcp_server, onecli_credential …). "status" is flipped to 'expired' by the
-- host sweep; the response handler refuses any non-'pending' row.
CREATE TABLE pending_approvals (
  approval_id          TEXT PRIMARY KEY,
  session_id           TEXT,
  request_id           TEXT NOT NULL,
  action               TEXT NOT NULL,
  payload              TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  agent_group_id       TEXT,
  channel_type         TEXT,
  platform_id          TEXT,
  platform_message_id  TEXT,
  expires_at           TEXT,
  status               TEXT NOT NULL DEFAULT 'pending',
  title                TEXT NOT NULL DEFAULT '',
  options_json         TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_pending_approvals_action_status ON pending_approvals(action, status);

-- One in-flight channel-registration card per messaging group (the PK IS the
-- dedup key). A transient delivery failure clears the row so the next mention
-- can re-escalate.
CREATE TABLE pending_channel_approvals (
  messaging_group_id  TEXT PRIMARY KEY,
  agent_group_id      TEXT NOT NULL,
  original_message    TEXT NOT NULL,
  approver_user_id    TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  title               TEXT NOT NULL DEFAULT '',
  options_json        TEXT NOT NULL DEFAULT '[]'
);

-- The ambient "working" reaction placed on a user's message, so it can be
-- cleared when the turn finishes.
CREATE TABLE progress_reactions (
  session_id         TEXT PRIMARY KEY,
  channel_type       TEXT NOT NULL,
  platform_id        TEXT NOT NULL,
  thread_id          TEXT,
  source_message_id  TEXT NOT NULL,
  reaction_id        TEXT NOT NULL,
  emoji              TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

-- Applied-migration ledger. runMigrations() is the ONLY builder of this DB;
-- everything below documents the shape that chain produces.
CREATE TABLE schema_version (
  version  INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  applied  TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_schema_version_name ON schema_version(name);

-- Senders seen in a channel the platform has not registered yet. Observability
-- for the channel-registration flow, never an authorization input.
CREATE TABLE unregistered_senders (
  channel_type        TEXT NOT NULL,
  platform_id         TEXT NOT NULL,
  user_id             TEXT,
  sender_name         TEXT,
  reason              TEXT NOT NULL,
  messaging_group_id  TEXT,
  agent_group_id      TEXT,
  message_count       INTEGER NOT NULL DEFAULT 1,
  first_seen          TEXT NOT NULL,
  last_seen           TEXT NOT NULL,
  PRIMARY KEY (channel_type, platform_id)
);

CREATE INDEX idx_unregistered_senders_last_seen ON unregistered_senders(last_seen);
`;

/**
 * Session DB schemas — split into two files so each has exactly one writer.
 * This eliminates SQLite write contention across the host-container mount boundary.
 *
 *   inbound.db  — host writes, container reads (read-only mount or open read-only)
 *   outbound.db — container writes, host reads (read-only open)
 */

/** Host-owned: inbound messages + delivery tracking + destination map. */
export const INBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',
  process_after  TEXT,
  recurrence     TEXT,
  series_id      TEXT,
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1,
                 -- 0 = accumulated context (don't wake), 1 = wake agent
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,
  -- For agent-to-agent inbound rows: the source session that emitted the
  -- triggering outbound. Used as a return path when the target replies —
  -- the reply routes back to this exact session, not to the source agent
  -- group's "newest" session. NULL on channel-side inbound and on a2a rows
  -- written before this column existed.
  source_session_id TEXT,
  -- For agent-to-agent inbound rows: the namespaced user id of the human
  -- employee who ultimately triggered the delegation chain. Enables worker
  -- sessions to attribute downstream ERP calls to the real employee rather
  -- than falling back to agent-asserted identity. NULL on channel-side
  -- inbound (senderId embedded in content is authoritative) and on
  -- pre-migration rows.
  origin_user_id TEXT,
  -- Top-level conversation correlation id (ADR-0039, roadmap 2.2). Stable for
  -- the whole multi-hop request (frontdesk → worker A → worker B), so operators
  -- can trace a request end-to-end and measure multi-hop latency. HOST-owned and
  -- PURE CORRELATION: never an input to any authz/routing/priority decision.
  -- NULL on channel-side inbound before a thread is minted and on pre-migration
  -- rows. The container never supplies this (unlike origin_user_id) — the host
  -- stamps it from the source session, so there is no forgeable emit path.
  conversation_thread_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);
CREATE INDEX IF NOT EXISTS idx_messages_in_conversation ON messages_in(conversation_thread_id);

-- Host tracks delivery outcomes for messages_out IDs.
-- Avoids writing to outbound.db (container-owned).
CREATE TABLE IF NOT EXISTS delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);

-- Destination map for this session's agent.
-- Host overwrites on every container wake AND on demand (rewires, new child
-- agents, etc.). Container queries this live on every lookup, so changes
-- take effect mid-session without requiring a container restart.
CREATE TABLE IF NOT EXISTS destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,   -- 'channel' | 'agent'
  channel_type    TEXT,            -- for type='channel'
  platform_id     TEXT,            -- for type='channel'
  agent_group_id  TEXT             -- for type='agent'
);

-- Default reply routing for this session. Single-row table (id=1).
-- Host overwrites on every container wake from the session's messaging_group
-- and thread_id. Container reads it in send_message / ask_user_question to
-- default the channel/thread of outbound messages when the agent doesn't
-- specify an explicit destination.
CREATE TABLE IF NOT EXISTS session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);

-- Agent-facing roster-DM slot discovery projection (ADR-0044 Stage 1).
-- Host DELETE+INSERTs this on every container wake (ONLY when ALLOW_ROSTER_DM
-- is on for the group) from the scope's LIVE grants, so the agent can learn
-- WHICH slots it may DM via send_roster_dm. Deliberately projects ZERO identity
-- fields — no participant_open_id, no dm_platform_id — so the agent only ever
-- sees a slot LABEL, never the consented person's id (R3 slot indirection). The
-- scope_id is never written here either; it stays on the trusted host side.
-- May be stale within a container lifetime (a grant revoked mid-turn); the
-- send-time checkGrantLive re-check (ADR-0023 R5) is the authoritative gate.
CREATE TABLE IF NOT EXISTS roster_slots (
  slot_label      TEXT PRIMARY KEY,
  -- Remaining sends before max_sends auto-revokes the grant; NULL = uncapped.
  sends_remaining INTEGER,
  -- Absolute grant expiry (ISO-8601 UTC) or NULL when the grant never expires.
  expires_at      TEXT
);
`;

/** Container-owned: outbound messages + processing acknowledgments. */
export const OUTBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  in_reply_to    TEXT,
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,
  recurrence     TEXT,
  kind           TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL
);

-- Container tracks processing status here instead of updating messages_in.
-- Host reads this to know which messages have been processed.
-- On container startup, stale 'processing' entries are cleared (crash recovery).
CREATE TABLE IF NOT EXISTS processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  status_changed TEXT NOT NULL
);

-- Persistent key/value state owned by the container. Used (among other things)
-- to store the SDK session ID so the agent's conversation resumes across
-- container restarts. Cleared by /clear.
CREATE TABLE IF NOT EXISTS session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Current tool-in-flight state. Single-row table (id=1). Container writes on
-- PreToolUse and clears on PostToolUse / PostToolUseFailure. Host reads in the
-- sweep to extend the stuck-tolerance window when Bash is running with a
-- declared timeout > 60s (long-running scripts shouldn't be flagged as stuck).
CREATE TABLE IF NOT EXISTS container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,
  tool_started_at          TEXT,
  updated_at               TEXT NOT NULL
);
`;
