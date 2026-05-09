import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Persist progress-reaction state so it survives host restarts and is visible
 * to future multi-process deployments. Replaces the in-memory Map in
 * src/modules/progress-status/index.ts.
 */
export const migration017: Migration = {
  version: 17,
  name: 'progress-reactions',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS progress_reactions (
        session_id        TEXT PRIMARY KEY,
        channel_type      TEXT NOT NULL,
        platform_id       TEXT NOT NULL,
        thread_id         TEXT,
        source_message_id TEXT NOT NULL,
        reaction_id       TEXT NOT NULL,
        emoji             TEXT NOT NULL,
        created_at        TEXT NOT NULL
      );
    `);
  },
};
