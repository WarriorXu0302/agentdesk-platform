import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Inbound ingress recovery ledger (ADR-0022).
 *
 * This is the durable landing zone for raw inbound envelopes that the router
 * persists BEFORE it does any session-DB / attachment / wake work. If anything
 * downstream of the persist throws (session inbound.db SQLITE_BUSY across the
 * mount boundary, attachment IO failure, a transient central-DB error, or a
 * host crash mid-route), the row survives so an operator can inspect or replay
 * it. The happy path deletes the row, so in steady state this table holds only
 * in-flight + failed rows and never grows unbounded.
 *
 * Crucially this is NOT a dedup key. Adapter-layer dedup (inbound_dedup, keyed
 * on the channel event_id) runs BEFORE routeInbound and stays the source of
 * truth for "have we seen this event". This ledger is keyed on a synthetic uuid
 * so it never collides with — or is mistaken for — the dedup table. Replay is
 * an explicit operator action precisely because re-running routeInbound would
 * bypass that adapter-layer dedup.
 *
 *   status:   'received' (in-flight or crash-orphaned) | 'failed' (route threw)
 *   attempts: incremented on each failed route / replay attempt
 */
export const migration026: Migration = {
  version: 26,
  name: 'inbound-ingress',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_ingress (
        id            TEXT PRIMARY KEY,
        channel_type  TEXT NOT NULL,
        platform_id   TEXT NOT NULL,
        thread_id     TEXT,
        message_json  TEXT NOT NULL,
        received_at   TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'received',
                      -- 'received' | 'failed'
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_ingress_status ON inbound_ingress(status, received_at);
    `);
  },
};
