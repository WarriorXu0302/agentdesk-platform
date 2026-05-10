import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Add `archived_at` to `sessions` so hard-delete can be gated on "time
 * since archive", not on the overloaded `last_active` column. Before this
 * migration, FRONTLANE_ARCHIVE_HARD_DELETE_DAYS was effectively
 * "max(ttl, hardDelete) days since last active" — which meant a very old
 * session would get archived AND hard-deleted in the same sweep tick,
 * giving the operator zero tarball retention.
 *
 * Backfill: existing archived rows get archived_at = last_active so they
 * immediately become hard-delete candidates after hardDeleteDays from
 * their idle point (matching the old behavior). Non-archived rows stay
 * NULL.
 */
export const migration022: Migration = {
  version: 22,
  name: 'session-archived-at',
  up: (db: Database.Database) => {
    const cols = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'archived_at')) {
      db.exec('ALTER TABLE sessions ADD COLUMN archived_at TEXT');
      db.exec(`UPDATE sessions SET archived_at = last_active WHERE status = 'archived' AND archived_at IS NULL`);
    }
  },
};
