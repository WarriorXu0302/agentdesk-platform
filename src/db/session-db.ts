/**
 * SQL operations on per-session inbound/outbound DBs.
 *
 * These are NOT the central app DB — they're the cross-mount SQLite files
 * shared between host and container. Callers own the connection lifecycle
 * (open-write-close per op). See session-manager.ts header for invariants.
 */
import Database from 'better-sqlite3';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';

/** Apply the inbound or outbound schema to a DB file. Idempotent. */
export function ensureSchema(dbPath: string, schema: 'inbound' | 'outbound'): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.exec(schema === 'inbound' ? INBOUND_SCHEMA : OUTBOUND_SCHEMA);
  db.close();
}

/** Open the inbound DB for a session (host reads/writes). */
export function openInboundDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Open the outbound DB for a session with write access. Only safe to call when no container is running. */
export function openOutboundDbRw(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Open outbound.db for a brief, racy write (host short-circuit, admin
 * deny-command response). The container holds it open as the sole writer
 * via `getOutboundDb()` (`busy_timeout=5000`, `journal_mode=DELETE`); we
 * connect briefly with a SHORT busy_timeout so a stuck container can't
 * block the routing thread.
 *
 * Caller MUST be prepared for SQLITE_BUSY (returned via thrown Error with
 * message `"database is locked"`) and treat it as a soft failure — fall
 * back to the regular LLM path. WAL mode is intentionally NOT enabled
 * because Docker bind-mount visibility for `-shm`/`-wal` files is
 * unreliable across the host/container boundary (see connection.ts in
 * container — inbound.db MUST be DELETE for the same reason).
 */
export function openOutboundDbForRacyWrite(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  // Short timeout so a stuck container doesn't freeze the host's routing
  // thread. 500ms gives SQLite a few retry chances at typical contention.
  db.pragma('busy_timeout = 500');
  return db;
}

export function upsertSessionRouting(
  db: Database.Database,
  routing: { channel_type: string | null; platform_id: string | null; thread_id: string | null },
): void {
  db.prepare(
    `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
     VALUES (1, @channel_type, @platform_id, @thread_id)
     ON CONFLICT(id) DO UPDATE SET
       channel_type = excluded.channel_type,
       platform_id  = excluded.platform_id,
       thread_id    = excluded.thread_id`,
  ).run(routing);
}

export interface DestinationRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

export function replaceDestinations(db: Database.Database, entries: DestinationRow[]): void {
  const tx = db.transaction((rows: DestinationRow[]) => {
    db.prepare('DELETE FROM destinations').run();
    const stmt = db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (@name, @display_name, @type, @channel_type, @platform_id, @agent_group_id)`,
    );
    for (const row of rows) stmt.run(row);
  });
  tx(entries);
}

// ---------------------------------------------------------------------------
// messages_in
// ---------------------------------------------------------------------------

/**
 * Next even seq number for host-owned inbound.db.
 *
 * Exported so the scheduling module's task helpers can maintain the
 * host-writes-even-seq invariant without duplicating the logic. Not part of
 * the general public API — imported by `src/modules/scheduling/db.ts` only.
 */
export function nextEvenSeq(db: Database.Database): number {
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  return maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);
}

export function insertMessage(
  db: Database.Database,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
    processAfter: string | null;
    recurrence: string | null;
    /**
     * 1 = wake the agent (default); 0 = accumulate as context only.
     * Host countDueMessages gates on this; container reads everything.
     */
    trigger?: 0 | 1;
    /**
     * For agent-to-agent inbound: the source session id that emitted the
     * outbound message which became this inbound row. Used as the return
     * path for the target's reply. NULL on channel-side inbound.
     */
    sourceSessionId?: string | null;
    /**
     * Namespaced user id of the human ultimately responsible for this
     * message. Populated for a2a inbound (copied from source session) and
     * left NULL for channel-side inbound (the user id is already in the
     * content payload's senderId).
     */
    originUserId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence, series_id, trigger, source_session_id, origin_user_id)
     VALUES (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content, @processAfter, @recurrence, @id, @trigger, @sourceSessionId, @originUserId)`,
  ).run({
    ...message,
    trigger: message.trigger ?? 1,
    sourceSessionId: message.sourceSessionId ?? null,
    originUserId: message.originUserId ?? null,
    seq: nextEvenSeq(db),
  });
}

export function countDueMessages(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM messages_in
       WHERE status = 'pending'
         AND trigger = 1
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
      )
      .get() as { count: number }
  ).count;
}

export function markMessageFailed(db: Database.Database, messageId: string): void {
  db.prepare("UPDATE messages_in SET status = 'failed' WHERE id = ?").run(messageId);
}

export interface FailedInboundRow {
  id: string;
  kind: string;
  tries: number;
  timestamp: string;
  origin_user_id: string | null;
}

/** Inbound messages dead-lettered by host-sweep retry exhaustion (status='failed'). */
export function listFailedInbound(db: Database.Database): FailedInboundRow[] {
  return db
    .prepare(
      "SELECT id, kind, tries, timestamp, origin_user_id FROM messages_in WHERE status = 'failed' ORDER BY timestamp",
    )
    .all() as FailedInboundRow[];
}

/**
 * Requeue a dead-lettered inbound message: reset it to pending so the next
 * wake/sweep re-delivers it to the container. Clears tries + process_after so
 * it isn't immediately re-killed by the same backoff. Returns true if a failed
 * row was actually reset. Mirrors requeueFailedDelivery for the outbound DLQ.
 */
export function requeueFailedInbound(db: Database.Database, messageId: string): boolean {
  const res = db
    .prepare(
      "UPDATE messages_in SET status = 'pending', tries = 0, process_after = NULL WHERE id = ? AND status = 'failed'",
    )
    .run(messageId);
  return res.changes > 0;
}

export function retryWithBackoff(db: Database.Database, messageId: string, backoffSec: number): void {
  db.prepare(
    `UPDATE messages_in SET tries = tries + 1, process_after = datetime('now', '+${backoffSec} seconds') WHERE id = ?`,
  ).run(messageId);
}

export function getMessageForRetry(
  db: Database.Database,
  messageId: string,
  status: string,
): { id: string; tries: number; processAfter: string | null } | undefined {
  return db
    .prepare('SELECT id, tries, process_after as processAfter FROM messages_in WHERE id = ? AND status = ?')
    .get(messageId, status) as { id: string; tries: number; processAfter: string | null } | undefined;
}

export function syncProcessingAcks(inDb: Database.Database, outDb: Database.Database): void {
  const completed = outDb
    .prepare("SELECT message_id FROM processing_ack WHERE status IN ('completed', 'failed')")
    .all() as Array<{ message_id: string }>;

  if (completed.length === 0) return;

  const updateStmt = inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ? AND status != 'completed'");
  inDb.transaction(() => {
    for (const { message_id } of completed) {
      updateStmt.run(message_id);
    }
  })();
}

export function getStuckProcessingIds(outDb: Database.Database): string[] {
  return (
    outDb.prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'").all() as Array<{
      message_id: string;
    }>
  ).map((r) => r.message_id);
}

export interface ProcessingClaim {
  message_id: string;
  status_changed: string;
}

/** Return processing_ack rows still in 'processing' with their claim timestamps. */
export function getProcessingClaims(outDb: Database.Database): ProcessingClaim[] {
  return outDb
    .prepare("SELECT message_id, status_changed FROM processing_ack WHERE status = 'processing'")
    .all() as ProcessingClaim[];
}

/**
 * Delete orphan 'processing' rows. Called by the host after killing a
 * container so the leftover claim doesn't trip claim-stuck on the next sweep
 * tick (which would kill the freshly respawned container before its
 * agent-runner can run its own startup cleanup).
 *
 * Safe because the host only writes to outbound.db when no container is
 * running (we just killed it). Returns the number of rows deleted.
 */
export function deleteOrphanProcessingClaims(outDb: Database.Database): number {
  return outDb.prepare("DELETE FROM processing_ack WHERE status = 'processing'").run().changes;
}

export interface ContainerState {
  current_tool: string | null;
  tool_declared_timeout_ms: number | null;
  tool_started_at: string | null;
}

/**
 * Read the container's current tool-in-flight state, if any. Returns null
 * when either the table doesn't exist yet (older session DB) or no tool is
 * active. Host sweep reads this to widen stuck-detection tolerance while
 * Bash is running with a long declared timeout.
 */
export function getContainerState(outDb: Database.Database): ContainerState | null {
  try {
    const row = outDb
      .prepare(
        `SELECT current_tool, tool_declared_timeout_ms, tool_started_at
           FROM container_state WHERE id = 1`,
      )
      .get() as ContainerState | undefined;
    return row ?? null;
  } catch {
    // Table not present on older session DBs — treat as "no tool in flight".
    return null;
  }
}

// ---------------------------------------------------------------------------
// messages_out (read-only from host)
// ---------------------------------------------------------------------------

export interface OutboundMessage {
  id: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  in_reply_to: string | null;
  /**
   * Scheduling fields (container-written). The host's roster-DM gate (ADR-0023)
   * rejects any kind='roster' row that carries either — a directed private
   * message must be sent now, not scheduled or made recurring (R6).
   */
  deliver_after?: string | null;
  recurrence?: string | null;
  /**
   * Set by the container on a2a outbound rows: the namespaced user id of
   * the human whose turn produced this delegation. Null on
   * channel-delivered rows (the user id is already on the source inbound
   * row) and on older containers that predate this column.
   */
  origin_user_id?: string | null;
}

export function getDueOutboundMessages(db: Database.Database): OutboundMessage[] {
  return db
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as OutboundMessage[];
}

// ---------------------------------------------------------------------------
// delivered
// ---------------------------------------------------------------------------

/**
 * Message-out ids that must NOT be (re)delivered right now (ADR-0016):
 *
 *   - status='delivered' rows — already on the user's screen.
 *   - status='failed' rows that are exhausted (attempts >= maxAttempts),
 *     have no scheduled retry (next_retry_at NULL — pre-migration rows and
 *     dlq-parked rows), or whose retry window hasn't opened yet.
 *
 * A failed row whose next_retry_at has passed is deliberately absent from
 * the set: the regular poll/sweep drain then re-attempts it exactly like an
 * undelivered row, which is what makes failed deliveries recoverable across
 * host restarts without a separate retry queue.
 *
 * Caller must run migrateDeliveredTable() first on DBs that may predate the
 * attempts / next_retry_at columns.
 */
export function getUndeliverableIds(db: Database.Database, maxAttempts: number): Set<string> {
  return new Set(
    (
      db
        .prepare(
          `SELECT message_out_id FROM delivered
            WHERE status = 'delivered'
               OR (status = 'failed' AND (
                     attempts >= ?
                     OR next_retry_at IS NULL
                     OR datetime(next_retry_at) > datetime('now')
                  ))`,
        )
        .all(maxAttempts) as Array<{ message_out_id: string }>
    ).map((r) => r.message_out_id),
  );
}

export function markDelivered(db: Database.Database, messageOutId: string, platformMessageId: string | null): void {
  // INSERT path: first-time success (the active/sweep poll race stays
  // idempotent — the second writer's conflict-update is gated on
  // status='failed', so it no-ops against an existing delivered row).
  // UPDATE path: a previously failed row finally delivered on retry —
  // flip it to delivered so it leaves the retry queue. attempts is kept
  // as a historical record of how many failures preceded success.
  db.prepare(
    `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
     VALUES (?, ?, 'delivered', datetime('now'))
     ON CONFLICT(message_out_id) DO UPDATE SET
       platform_message_id = excluded.platform_message_id,
       status              = 'delivered',
       delivered_at        = excluded.delivered_at
     WHERE delivered.status = 'failed'`,
  ).run(messageOutId, platformMessageId ?? null);
}

/** Persisted failed-attempt count for a message. 0 when never failed. */
export function getDeliveryAttempts(db: Database.Database, messageOutId: string): number {
  const row = db
    .prepare("SELECT attempts FROM delivered WHERE message_out_id = ? AND status = 'failed'")
    .get(messageOutId) as { attempts: number } | undefined;
  return row?.attempts ?? 0;
}

/**
 * Record a failed delivery attempt with a persisted attempt count and (when
 * backoffSec is non-null) a scheduled retry at now + backoffSec. backoffSec
 * null means automatic retries are exhausted: the row stays 'failed' for
 * audit / DLQ inspection and getUndeliverableIds excludes it permanently
 * until an operator requeues it via scripts/dlq.ts.
 *
 * The conflict-update is gated on status='failed' so a concurrent success
 * can never be downgraded back to failed.
 */
export function markDeliveryFailed(
  db: Database.Database,
  messageOutId: string,
  attempts: number,
  backoffSec: number | null,
): void {
  db.prepare(
    `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at, attempts, next_retry_at)
     VALUES (@id, NULL, 'failed', datetime('now'), @attempts,
             CASE WHEN @backoffSec IS NULL THEN NULL
                  ELSE datetime('now', '+' || @backoffSec || ' seconds') END)
     ON CONFLICT(message_out_id) DO UPDATE SET
       attempts      = excluded.attempts,
       delivered_at  = excluded.delivered_at,
       next_retry_at = excluded.next_retry_at
     WHERE delivered.status = 'failed'`,
  ).run({ id: messageOutId, attempts, backoffSec });
}

export interface FailedDeliveryRow {
  message_out_id: string;
  attempts: number;
  next_retry_at: string | null;
  delivered_at: string;
}

/** All failed delivery rows for a session, oldest first. Used by scripts/dlq.ts. */
export function listFailedDeliveries(db: Database.Database): FailedDeliveryRow[] {
  return db
    .prepare(
      `SELECT message_out_id, attempts, next_retry_at, delivered_at
         FROM delivered WHERE status = 'failed' ORDER BY delivered_at ASC`,
    )
    .all() as FailedDeliveryRow[];
}

/**
 * Reset a failed row so the next poll/sweep re-attempts it immediately:
 * attempts back to 0, next_retry_at to now. Returns true when a failed row
 * was actually reset. Used by scripts/dlq.ts — never by the host runtime.
 */
export function requeueFailedDelivery(db: Database.Database, messageOutId: string): boolean {
  return (
    db
      .prepare(
        "UPDATE delivered SET attempts = 0, next_retry_at = datetime('now') WHERE message_out_id = ? AND status = 'failed'",
      )
      .run(messageOutId).changes > 0
  );
}

/** Ensure the delivered table has columns added after initial schema. */
export function migrateDeliveredTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('delivered')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('platform_message_id')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN platform_message_id TEXT').run();
  }
  if (!cols.has('status')) {
    db.prepare("ALTER TABLE delivered ADD COLUMN status TEXT NOT NULL DEFAULT 'delivered'").run();
  }
  if (!cols.has('attempts')) {
    // Persistent retry state (ADR-0016). Pre-migration failed rows keep
    // attempts=0 / next_retry_at NULL, which getUndeliverableIds treats as
    // "no scheduled retry" — they stay parked until scripts/dlq.ts requeues
    // them, instead of resurrecting arbitrarily stale messages on upgrade.
    db.prepare('ALTER TABLE delivered ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!cols.has('next_retry_at')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN next_retry_at TEXT').run();
  }
}

// Adds columns added to messages_in after the initial v2 schema to
// pre-existing session DBs. No-op on fresh installs where the columns are
// in the baseline schema. Backfills existing rows so invariants hold.
export function migrateMessagesInTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('series_id')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN series_id TEXT').run();
    db.prepare('UPDATE messages_in SET series_id = id WHERE series_id IS NULL').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id)').run();
  }
  if (!cols.has('trigger')) {
    // All pre-existing rows got written with the old "every inbound wakes
    // the agent" semantics, so backfill 1 and default 1 for new inserts.
    db.prepare('ALTER TABLE messages_in ADD COLUMN trigger INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!cols.has('source_session_id')) {
    // For agent-to-agent return-path routing. NULL on existing rows is fine —
    // their replies fall back to the legacy "newest active session" lookup.
    db.prepare('ALTER TABLE messages_in ADD COLUMN source_session_id TEXT').run();
  }
  if (!cols.has('origin_user_id')) {
    // For agent-to-agent identity propagation. Carries the namespaced user
    // id of the human who originated the request, so worker sessions can
    // attribute ERP calls to the real employee rather than falling back to
    // agent-asserted identity. NULL on channel-side inbound (where the
    // user id is already in the content payload) and on pre-migration rows.
    db.prepare('ALTER TABLE messages_in ADD COLUMN origin_user_id TEXT').run();
  }
  if (!cols.has('conversation_thread_id')) {
    // Top-level conversation correlation id (ADR-0039). Host-owned, pure
    // correlation — minted once at conversation start and propagated across
    // a2a hops by the host. This ALTER-on-open covers in-flight inbound.db
    // files (the central migration 031 only records the marker). NULL on
    // pre-migration rows; never used for any authz/routing decision.
    db.prepare('ALTER TABLE messages_in ADD COLUMN conversation_thread_id TEXT').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_in_conversation ON messages_in(conversation_thread_id)').run();
  }
}

/**
 * Look up an inbound row's source_session_id by its message id. Returns null
 * if the row doesn't exist or the column is NULL (channel inbound or
 * pre-migration a2a inbound). Used by a2a routing to route replies back to
 * the originating session.
 */
export function getInboundSourceSessionId(db: Database.Database, messageId: string): string | null {
  const row = db.prepare('SELECT source_session_id FROM messages_in WHERE id = ?').get(messageId) as
    | { source_session_id: string | null }
    | undefined;
  return row?.source_session_id ?? null;
}

/**
 * Find the source_session_id of the most recent a2a inbound row from a
 * specific peer (by agent group id). Used as a peer-affinity fallback in
 * a2a routing when an outbound reply has no `in_reply_to` (e.g. the
 * container's send_message MCP tool path didn't thread the batch's
 * in_reply_to through).
 *
 * Heuristic: "the last time this peer talked to me, which session was it?"
 * Returns null when no prior a2a inbound from that peer carries a
 * non-null source_session_id (typical for pre-migration installs).
 */
export function getMostRecentPeerSourceSessionId(db: Database.Database, peerAgentGroupId: string): string | null {
  const row = db
    .prepare(
      `SELECT source_session_id FROM messages_in
        WHERE channel_type = 'agent'
          AND platform_id = ?
          AND source_session_id IS NOT NULL
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(peerAgentGroupId) as { source_session_id: string | null } | undefined;
  return row?.source_session_id ?? null;
}
