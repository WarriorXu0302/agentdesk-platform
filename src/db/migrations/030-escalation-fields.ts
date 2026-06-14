import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Escalation hook (ADR-0038, roadmap 2.3): record an explicit AI→human
 * escalation as a frontdesk decision in classification_log, distinct from a
 * worker delegation.
 *
 * Two additive nullable columns on the append-only classification_log:
 *   - `escalation_reason` — free text the agent gave (untrusted; recorded for
 *     observability/audit only, NEVER an input to any authz/priority decision).
 *   - `urgency_level` — coerced to a closed enum (low|medium|high|critical|
 *     unknown) at the host boundary before it lands here.
 *
 * Additive + idempotent: `action` is TEXT NOT NULL with no CHECK constraint, so
 * the new `action='escalate'` value needs no schema change; only these two
 * nullable columns. No backfill — pre-existing rows keep NULL. No new table:
 * escalation reuses classification_log (frontdesk-decision log) + enterprise_audit
 * (`agent_escalation`), both host-single-writer, per ADR-0038 (rejected a
 * dedicated escalations table). Queue priority / routing-to-human stay with the
 * operator gateway, so no priority/routing column is added here.
 */
export const migration030: Migration = {
  version: 30,
  name: 'escalation-fields',
  up: (db: Database.Database) => {
    const cols = db.prepare(`PRAGMA table_info(classification_log)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'escalation_reason')) {
      db.exec(`ALTER TABLE classification_log ADD COLUMN escalation_reason TEXT;`);
    }
    if (!cols.some((c) => c.name === 'urgency_level')) {
      db.exec(`ALTER TABLE classification_log ADD COLUMN urgency_level TEXT;`);
    }
  },
};
