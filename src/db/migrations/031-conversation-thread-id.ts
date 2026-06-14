import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Conversation thread id (ADR-0039, roadmap 2.2) — a host-owned, pure-correlation
 * id that spans a multi-hop request (frontdesk → worker A → worker B) so
 * operators can trace it end-to-end and measure hop latency.
 *
 * Two surfaces, both host-written:
 *   - central v2.db `classification_log` — real ALTER here (idempotent), mirroring
 *     migration024's column adds, so a multi-hop classification chain shares one id.
 *   - per-session inbound.db `messages_in` — NOT here. Session DBs are opened
 *     lazily and migrated by `migrateMessagesInTable` (src/db/session-db.ts),
 *     which adds the column + index on next open. This migration is a MARKER for
 *     that part (same split as migration020-inbound-origin-user), so installers /
 *     /debug can confirm the feature is active.
 *
 * Deliberately NOT touched: container-written `messages_out`. The host owns the
 * id end-to-end (stamps it from the source session), so the container never
 * supplies it — no forgeable emit path, no trace-poisoning surface (ADR-0039).
 *
 * Additive + idempotent + nullable: pre-migration / channel-only rows stay NULL;
 * the column is never load-bearing for message flow (best-effort writer).
 */
export const migration031: Migration = {
  version: 31,
  name: 'conversation-thread-id',
  up: (db: Database.Database) => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('classification_log')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('conversation_thread_id')) {
      db.exec('ALTER TABLE classification_log ADD COLUMN conversation_thread_id TEXT');
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_classification_log_conversation ON classification_log(conversation_thread_id)',
    );
    // The per-session messages_in column is handled by migrateMessagesInTable on
    // each inbound.db open — this central migration is just the marker.
  },
};
