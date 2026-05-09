import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Cross-process inbound dedup for channels whose webhooks are at-least-once
 * (Feishu in particular). Keyed on (channel, event_id); TTL-pruned by
 * host-sweep so the table stays small.
 */
export const migration016: Migration = {
  version: 16,
  name: 'inbound-dedup',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_dedup (
        channel  TEXT NOT NULL,
        event_id TEXT NOT NULL,
        seen_at  TEXT NOT NULL,
        PRIMARY KEY (channel, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_dedup_seen_at ON inbound_dedup(seen_at);
    `);
  },
};
