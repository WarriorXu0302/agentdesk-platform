import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Worker routing feedback (ADR-0040, roadmap 2.1 misroute + 2.5 nack): record a
 * worker's "this should have gone elsewhere" / "I'm rejecting this" signal as a
 * frontdesk-decision-log row, distinct from a delegation or an escalation.
 *
 * One additive nullable column on the append-only classification_log:
 *   - `feedback_kind` — coerced to a closed enum (misroute|nack|unknown) at the
 *     host boundary before it lands here. NULL for every non-feedback row.
 *
 * Additive + idempotent: `action` is TEXT NOT NULL with no CHECK constraint, so
 * the new `action='routing_feedback'` value needs no schema change (same path
 * migration030 used for 'escalate'); only this one nullable column. No backfill —
 * pre-existing rows keep NULL. No new table: feedback reuses classification_log
 * (host-single-writer) + enterprise_audit (`agent_routing_feedback`), per ADR-0040
 * (rejected a dedicated routing_feedback/nack table). The worker's free-text reason
 * reuses the existing `reasoning` column and its suggested-target hint reuses
 * `recommended_worker` (recorded-only, NEVER ACL-validated — see ADR-0040), so no
 * column is added for those. Active reroute is REJECTED in ADR-0040, so no
 * routing/priority column is added here.
 */
export const migration033: Migration = {
  version: 33,
  name: 'routing-feedback-fields',
  up: (db: Database.Database) => {
    const cols = db.prepare(`PRAGMA table_info(classification_log)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'feedback_kind')) {
      db.exec(`ALTER TABLE classification_log ADD COLUMN feedback_kind TEXT;`);
    }
  },
};
