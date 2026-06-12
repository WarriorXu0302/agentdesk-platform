import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Roster DM harden-after (ADR-0023, item 11b): record the source group a grant
 * was consented in, so a platform leave/disband event can revoke exactly the
 * grants that belong to the chat the participant left.
 *
 * `origin_platform_id` is the `feishu:<chat_id>` of the group the participant
 * was acting in when they consented (NULL for a pure p2p opt-in with no group
 * context — those are revoked only by explicit opt-out / scope teardown, since
 * leaving a p2p "chat" with the bot has no platform leave event). It is
 * host-derived from the inbound event at consent time and is NEVER used as a
 * routing field — routing authority stays with dm_platform_id.
 *
 * Additive, idempotent: a plain nullable column with a covering index for the
 * leave-revoke lookup. No backfill — pre-existing grants keep NULL and are
 * unaffected by leave events (their teardown path is explicit opt-out / scope
 * finish, which is unchanged).
 */
export const migration028: Migration = {
  version: 28,
  name: 'dm-grant-origin',
  up: (db: Database.Database) => {
    const cols = db.prepare(`PRAGMA table_info(dm_grants)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'origin_platform_id')) {
      db.exec(`ALTER TABLE dm_grants ADD COLUMN origin_platform_id TEXT;`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_dm_grants_origin
         ON dm_grants(origin_platform_id, participant_open_id);`,
    );
  },
};
