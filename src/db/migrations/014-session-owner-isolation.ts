import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Add sender-scoped session support for enterprise-style shared entry agents.
 *
 * `owner_user_id` lets one messaging group host multiple isolated sessions,
 * one per user (optionally per thread as well). Existing sessions remain
 * shared because the new column is nullable and historical rows backfill to
 * NULL.
 */
export const migration014: Migration = {
  version: 14,
  name: 'session-owner-isolation',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN owner_user_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_sessions_lookup_owner
        ON sessions(agent_group_id, messaging_group_id, owner_user_id, thread_id);
    `);
  },
};
