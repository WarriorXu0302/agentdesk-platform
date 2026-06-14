import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Conversation thread id — sessions column (ADR-0039 commit 2/4, roadmap 2.2).
 *
 * The mint point: a root (frontdesk) session gets a `conversation_thread_id`
 * when it is created at channel ingress; it is stored here so a LATER,
 * separate delivery-action handler (handleClassifyIntent) and the a2a
 * propagation read it back from the host-trusted sessions row. Worker (a2a
 * child) sessions are NOT minted here — the id is propagated to them
 * (commit 3/4). NULL on pre-migration sessions and on channel sessions created
 * before a thread is minted.
 *
 * Additive + idempotent + nullable (mirrors how spawn_depth was added). Pure
 * correlation — never an authz/routing input (ADR-0039).
 */
export const migration032: Migration = {
  version: 32,
  name: 'session-conversation-thread',
  up: (db: Database.Database) => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('conversation_thread_id')) {
      db.exec('ALTER TABLE sessions ADD COLUMN conversation_thread_id TEXT');
    }
  },
};
