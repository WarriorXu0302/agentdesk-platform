import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Track per-session a2a-spawn depth so the host can cap dispatch chain length.
 *
 * Depth 0 = channel-entry sessions (frontdesk, anything wired directly to a
 * messaging group). Each subsequent a2a hop bumps the target's depth by one.
 * Combined with AGENTDESK_MAX_SPAWN_DEPTH (default 2) in agent-route.ts this
 * applies a default spawn-depth cap of 2 as a runtime
 * defense-in-depth on top of the existing `agent_destinations` ACL.
 *
 * Backfill heuristic: existing rows with a `messaging_group_id` are
 * channel-entry sessions (frontdesk-style) and stay at 0. The rest were
 * created via a2a routing into an agent-shared / root-session lane and are
 * pinned to 1 — the only depth they could have under the current "only
 * frontdesk talks to channels" topology. Pre-migration installs that wired
 * workers to channels directly should re-pin depth via SQL after running this.
 *
 * If a deeper-than-1 a2a chain existed before the cap (unlikely — pre-cap
 * topology was strictly star), the backfill underestimates; operators should
 * either accept the relaxed cap on those stale sessions or `DELETE` them so
 * fresh ones are created with the correct depth.
 */
export const migration025: Migration = {
  version: 25,
  name: 'session-spawn-depth',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0;
      UPDATE sessions
        SET spawn_depth = 1
        WHERE messaging_group_id IS NULL;
    `);
  },
};
