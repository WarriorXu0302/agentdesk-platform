import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Roster directed-message grants (ADR-0023).
 *
 * Two host-single-writer tables in the central v2.db. v2.db is NEVER mounted
 * into a container, so the agent has no write handle to either table — this is
 * what keeps the consent + rate-limit ledger out of reach of a prompt-injected
 * runner (three-DB single-writer invariant).
 *
 * `dm_grants` — one row per (scope, slot) the owner explicitly consented to.
 *   The consent must originate from a channel-ingress action by the participant
 *   themselves (p2p inbound) or a fail-closed directed card; it is NEVER
 *   derived from an a2a origin or accumulated cross-session identity (R1).
 *   The delivery gate reverse-looks-up by (scope_id, slot_label) and OVERWRITES
 *   whatever channel_type/platform_id the container wrote, so the container
 *   cannot redirect a roster DM to an arbitrary target (R3).
 *
 *     consent_source: 'p2p-ingress' (participant DM'd the bot) |
 *                     'directed-card' (participant clicked a card scoped to
 *                      their own open_id, validated fail-closed)
 *     dm_platform_id: the authoritative `feishu:p2p:ou_*` destination. The
 *                     participant_open_id and dm_platform_id are derived
 *                     atomically from the SAME inbound event and asserted to
 *                     resolve back to the same open_id (R2).
 *     max_sends / sends_used: per-grant total-volume cap (R5). When sends_used
 *                     reaches max_sends the grant auto-revokes.
 *     revoked_at / expires_at: every deliver (incl. each retry) re-checks these
 *                     live, inside the same critical section (R5).
 *
 *   UNIQUE(scope_id, slot_label)        — one participant per slot per scope (R4)
 *   UNIQUE(scope_id, participant_open_id) — a participant occupies at most one slot
 *
 * `dm_rate_ledger` — persisted multi-key sliding-window counters (R5). Keyed
 *   rows (grant / scope / participant / deploy) survive host restarts so the
 *   rate limit can't be reset by bouncing the process. Host single-writer.
 *
 * `dm_audit` — one row per roster DM delivery decision (delivered AND rejected),
 *   mirroring gateway_audit's compliance-paper-trail role for this surface.
 *   Records who, which slot/scope, the resolved target, and the deny reason.
 *   Host single-writer.
 */
export const migration027: Migration = {
  version: 27,
  name: 'dm-grants',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dm_grants (
        id                    TEXT PRIMARY KEY,
        scope_id              TEXT NOT NULL,
        agent_group_id        TEXT NOT NULL,
        slot_label            TEXT NOT NULL,
        participant_open_id   TEXT NOT NULL,
        dm_platform_id        TEXT NOT NULL,
        channel_type          TEXT NOT NULL DEFAULT 'feishu',
        consent_source        TEXT NOT NULL,
                              -- 'p2p-ingress' | 'directed-card'
        consent_inbound_msg_id TEXT NOT NULL,
        consent_origin_user_id TEXT,
        created_at            TEXT NOT NULL,
        expires_at            TEXT,
        revoked_at            TEXT,
        max_sends             INTEGER NOT NULL DEFAULT 0,
        sends_used            INTEGER NOT NULL DEFAULT 0,
        UNIQUE(scope_id, slot_label),
        UNIQUE(scope_id, participant_open_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dm_grants_scope ON dm_grants(scope_id);
      CREATE INDEX IF NOT EXISTS idx_dm_grants_live ON dm_grants(scope_id, revoked_at, expires_at);

      CREATE TABLE IF NOT EXISTS dm_rate_ledger (
        key           TEXT NOT NULL,
        window_start  TEXT NOT NULL,
        count         INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key, window_start)
      );
      CREATE INDEX IF NOT EXISTS idx_dm_rate_ledger_key ON dm_rate_ledger(key, window_start);

      CREATE TABLE IF NOT EXISTS dm_audit (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at     TEXT NOT NULL,
        scope_id        TEXT NOT NULL,
        agent_group_id  TEXT,
        session_id      TEXT,
        slot_label      TEXT,
        grant_id        TEXT,
        participant_open_id TEXT,
        dm_platform_id  TEXT,
        message_out_id  TEXT,
        decision        TEXT NOT NULL,
                        -- 'delivered' | 'rejected'
        reason          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dm_audit_at ON dm_audit(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_dm_audit_scope ON dm_audit(scope_id, occurred_at);
    `);
  },
};
