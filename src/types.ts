// ── Central DB entities ──

export interface AgentGroup {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  created_at: string;
}

export type UnknownSenderPolicy = 'strict' | 'request_approval' | 'public';

export interface MessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
  name: string | null;
  is_group: number; // 0 | 1
  unknown_sender_policy: UnknownSenderPolicy;
  /**
   * When set, the owner explicitly denied registering this channel — the
   * router drops silently and does not re-escalate. Cleared by any explicit
   * wiring mutation (admin command). See migration 012.
   *
   * Optional on the TS type so pre-migration-012 callers that build
   * MessagingGroup objects in code (fixtures, etc.) don't need to update;
   * the column itself defaults to NULL in SQLite.
   */
  denied_at?: string | null;
  created_at: string;
}

// ── Identity & privilege ──

/**
 * User = a messaging-platform identifier. Namespaced so distinct channels
 * with numeric IDs don't collide: "phone:+1555...", "tg:123", "discord:456",
 * "email:a@x.com". A single human with a phone AND a telegram handle has
 * two separate users — no cross-channel linking (yet).
 */
export interface User {
  id: string;
  kind: string; // 'phone' | 'email' | 'discord' | 'telegram' | 'matrix' | ...
  display_name: string | null;
  created_at: string;
}

export type UserRoleKind = 'owner' | 'admin';

/**
 * Role grant. Owner is always global. Admin is either global
 * (agent_group_id = null) or scoped to a specific agent group.
 * Admin @ A implicitly makes the user a member of A — we do not require
 * a separate agent_group_members row for admins.
 */
export interface UserRole {
  user_id: string;
  role: UserRoleKind;
  agent_group_id: string | null;
  granted_by: string | null;
  granted_at: string;
}

/** "Known" membership in an agent group — required for unprivileged users. */
export interface AgentGroupMember {
  user_id: string;
  agent_group_id: string;
  added_by: string | null;
  added_at: string;
}

/** Cached DM channel for a user on a specific channel_type. */
export interface UserDm {
  user_id: string;
  channel_type: string;
  messaging_group_id: string;
  resolved_at: string;
}

export type EngageMode = 'pattern' | 'mention' | 'mention-sticky';
export type SenderScope = 'all' | 'known';
export type IgnoredMessagePolicy = 'drop' | 'accumulate';

export interface MessagingGroupAgent {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: EngageMode;
  /**
   * Regex source string used when engage_mode='pattern'. `'.'` is the sentinel
   * for "match every message" (the "always" flavor). Ignored for 'mention' /
   * 'mention-sticky' modes.
   */
  engage_pattern: string | null;
  sender_scope: SenderScope;
  ignored_message_policy: IgnoredMessagePolicy;
  session_mode: 'shared' | 'per-thread' | 'agent-shared' | 'per-user' | 'per-user-per-thread';
  priority: number;
  created_at: string;
}

export type A2aSessionMode = 'agent-shared' | 'root-session';

export interface Session {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  /**
   * When set, this session is scoped to a single sender identity inside the
   * messaging group. Used by enterprise-style shared entry agents where one
   * chat surface serves many users but each user must keep an isolated
   * execution context.
   */
  owner_user_id: string | null;
  /**
   * Stable root conversation lane for this session.
   *
   * Root/frontdesk sessions point to themselves. Worker sessions spawned off
   * the same user/business conversation point back to that root session id so
   * agent-to-agent routing can keep per-worker context isolated without
   * creating a brand-new worker session for every message hop.
   */
  root_session_id?: string | null;
  /**
   * Top-level conversation correlation id (ADR-0039). Minted on a root session
   * at channel ingress and propagated to a2a worker sessions, so a multi-hop
   * request can be traced end-to-end. Pure correlation — never an authz/routing
   * input. NULL on pre-migration sessions and before a thread is minted.
   */
  conversation_thread_id?: string | null;
  agent_provider: string | null;
  /**
   * Lifecycle state for the session:
   *   - `active`    — normal in-use session (default on create).
   *   - `closed`    — explicitly closed by admin / user command. No new
   *                   inbound is routed in; retained for scroll-back.
   *   - `archived`  — idled out past AGENTDESK_SESSION_TTL_DAYS and moved
   *                   to on-disk archive. Filesystem under
   *                   data/v2-sessions-archive/. DB row kept so audit
   *                   queries still resolve the session id.
   */
  status: 'active' | 'closed' | 'archived';
  container_status: 'running' | 'idle' | 'stopped';
  last_active: string | null;
  /**
   * When this session was archived. NULL for active / closed rows.
   * Hard-delete gating reads this — NOT last_active — so the retention
   * window starts at archive time, not at last user activity.
   */
  archived_at?: string | null;
  /**
   * a2a spawn-chain depth. 0 for channel-entry sessions (frontdesk and
   * anything wired directly to a messaging group); each agent-to-agent hop
   * bumps the target by one when the session is first created. agent-route.ts
   * rejects new edges where `source.spawn_depth >= AGENTDESK_MAX_SPAWN_DEPTH`
   * (default 2) so a labops→feishu-base→…→X chain can't run away.
   *
   * Note: a session's stored depth is its **creation** depth. With root-session
   * mode the same target session can be reused via a deeper path, so the
   * `agent_destinations` ACL is still the primary protection — this is a
   * runtime defense-in-depth that catches misconfigured destinations.
   */
  spawn_depth?: number;
  created_at: string;
}

// ── Session DB entities ──

export type MessageInKind = 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system';
export type MessageInStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface MessageIn {
  id: string;
  kind: MessageInKind;
  timestamp: string;
  status: MessageInStatus;
  status_changed: string | null;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

export interface MessageOut {
  id: string;
  in_reply_to: string | null;
  timestamp: string;
  delivered: number; // 0 | 1
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

// ── Pending questions (central DB) ──

export interface PendingQuestion {
  question_id: string;
  session_id: string;
  message_out_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  title: string;
  options: import('./channels/ask-question.js').NormalizedOption[];
  created_at: string;
}

// ── Pending approvals (central DB) ──

export interface PendingApproval {
  approval_id: string;
  session_id: string | null;
  request_id: string;
  action: string;
  payload: string; // JSON
  created_at: string;
  agent_group_id: string | null;
  channel_type: string | null;
  platform_id: string | null;
  platform_message_id: string | null;
  expires_at: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  title: string;
  options_json: string;
}

// ── Agent destinations (central DB) ──

export interface AgentDestination {
  agent_group_id: string;
  local_name: string;
  target_type: 'channel' | 'agent';
  target_id: string;
  created_at: string;
}
