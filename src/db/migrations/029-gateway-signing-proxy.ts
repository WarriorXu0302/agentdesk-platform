import type Database from 'better-sqlite3';
import { hasTable } from '../connection.js';
import type { Migration } from './index.js';

/**
 * Host-side gateway signing credential proxy (ADR-0034).
 *
 * Two additive changes, both safe on an existing DB:
 *
 * 1. `gateway_proxy_token` — per-session signing tokens minted by the host at
 *    container spawn. The container holds only the opaque token (in env); the
 *    backend signing key never enters the container. The proxy looks a token up
 *    by its sha256 (the raw token is never stored), checks expiry / revocation /
 *    source-IP pin, then signs+forwards on behalf of the token's authoritative
 *    agent group. `source_ip` is filled trust-on-first-use and pinned after.
 *
 * 2. `gateway_audit` proxy columns — the proxy writes its own authoritative,
 *    two-phase audit rows (intent → final) carrying facts only the host knows
 *    (which group it signed as, the token jti, whether the container's claimed
 *    group mismatched). All nullable + additive so the existing container-driven
 *    audit path (recordGatewayAudit) is untouched and leaves them NULL.
 */
export const migration029: Migration = {
  version: 29,
  name: 'gateway-signing-proxy',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_proxy_token (
        jti             TEXT PRIMARY KEY,
        token_sha256    TEXT NOT NULL UNIQUE,
        session_id      TEXT NOT NULL,
        agent_group_id  TEXT NOT NULL,
        allowed_paths   TEXT NOT NULL,
        source_ip       TEXT,
        created_at      TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        revoked_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_proxy_token_session ON gateway_proxy_token(session_id);
      CREATE INDEX IF NOT EXISTS idx_gateway_proxy_token_expires ON gateway_proxy_token(expires_at);
    `);

    // gateway_audit additive columns. This migration hard-depends on migration
    // 019 having created gateway_audit (it precedes us in the array). Guard on
    // table presence anyway so a future array reorder fails safe (skip) rather
    // than throwing 'no such table' mid-transaction. ADD COLUMN is not
    // idempotent in SQLite, so also guard each column against the live set.
    if (hasTable(db, 'gateway_audit')) {
      const existing = new Set(
        (db.prepare(`PRAGMA table_info(gateway_audit)`).all() as Array<{ name: string }>).map((c) => c.name),
      );
      const addColumn = (name: string, decl: string): void => {
        if (!existing.has(name)) db.exec(`ALTER TABLE gateway_audit ADD COLUMN ${name} ${decl}`);
      };
      addColumn('signed_as_group', 'TEXT');
      addColumn('token_jti', 'TEXT');
      addColumn('proxy_request_id', 'TEXT');
      addColumn('identity_mismatch', 'INTEGER');
      addColumn('requester_source_coerced', 'INTEGER');
      addColumn('audit_phase', 'TEXT');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_gateway_audit_proxy_req ON gateway_audit(proxy_request_id);`);
    }
  },
};
