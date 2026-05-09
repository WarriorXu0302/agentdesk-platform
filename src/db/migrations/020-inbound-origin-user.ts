import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Session DB schema coordination marker: per-session inbound.db files also
 * need an `origin_user_id` column. Session DBs are opened lazily and
 * migrated through `migrateMessagesInTable` in `src/db/session-db.ts`
 * (see the ALTER path there); this central-DB migration is just a marker so
 * the `schema_version` table records that the feature is active for new
 * installs to rely on it.
 *
 * No central-DB schema change is required — the column lives in per-session
 * inbound.db. We still record the migration so `/debug` / installers can
 * check "was this feature applied?" in a single place.
 */
export const migration020: Migration = {
  version: 20,
  name: 'inbound-origin-user',
  up: (_db: Database.Database) => {
    // intentionally empty — session-db migrateMessagesInTable handles the
    // per-session ALTER when each inbound.db is opened.
  },
};
