import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Add stable root-session lanes so worker agent sessions can be isolated per
 * user/business conversation instead of falling back to a single shared
 * agent-shared session.
 *
 * Existing sessions backfill to themselves, preserving current behavior while
 * giving new code a deterministic root id to route against.
 */
export const migration015: Migration = {
  version: 15,
  name: 'root-session-lane',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN root_session_id TEXT;
      UPDATE sessions SET root_session_id = id WHERE root_session_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_sessions_agent_root
        ON sessions(agent_group_id, root_session_id);
    `);
  },
};
