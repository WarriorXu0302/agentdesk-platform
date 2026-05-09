import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * ERP gateway audit log. Every call that leaves a container toward the
 * configured ERP gateway writes one row here — win or lose. This is the
 * paper trail for enterprise compliance reviews and the only surface that
 * records WHAT each agent tried to do, independent of whatever the gateway
 * itself persists.
 */
export const migration019: Migration = {
  version: 19,
  name: 'erp-audit',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS erp_audit (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at        TEXT NOT NULL,
        session_id         TEXT,
        agent_group_id     TEXT,
        user_id            TEXT,
        path               TEXT NOT NULL,
        operation          TEXT,
        requester_source   TEXT NOT NULL,
        status             TEXT NOT NULL,
        http_status        INTEGER,
        duration_ms        INTEGER,
        idempotency_key    TEXT,
        input_hash         TEXT,
        error_msg          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_erp_audit_at ON erp_audit(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_erp_audit_user ON erp_audit(user_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_erp_audit_operation ON erp_audit(operation, occurred_at);
    `);
  },
};
