import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Audit log for enterprise-specific state changes that happen automatically
 * (policy downgrades during autowire, bulk topology changes, etc.). Kept
 * narrowly-scoped to enterprise flows so general product code isn't forced
 * to write through this table.
 */
export const migration018: Migration = {
  version: 18,
  name: 'enterprise-audit',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS enterprise_audit (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at         TEXT NOT NULL,
        event_type          TEXT NOT NULL,
        messaging_group_id  TEXT,
        agent_group_id      TEXT,
        actor               TEXT,
        details             TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_enterprise_audit_at ON enterprise_audit(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_enterprise_audit_type ON enterprise_audit(event_type);
    `);
  },
};
