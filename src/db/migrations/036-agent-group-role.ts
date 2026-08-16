import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * agent_groups.role — model "frontdesk vs worker" as data (ADR-0056).
 *
 * "Is this group a frontdesk?" used to be answered by four independent,
 * uncorrelated conventions: the folder name (autowire), `llm.routing.enabled`
 * in container.json (the ADR-0054 enforcement machine), rows in
 * `agent_destinations` (delegability), and a script-local `AgentRole` type in
 * init-enterprise-topology (resource caps). Nothing correlated them, so no
 * validation could exist — a worker with a routing config, or a "frontdesk"
 * with no workers, was undetectable.
 *
 * Values: 'frontdesk' | 'worker' | NULL. NULL = unclassified — every
 * pre-migration row, and standalone/CLI agents that are neither. All
 * enforcement treats NULL as legacy-permitted; only an explicit
 * role='worker' contradiction refuses.
 *
 * BEHAVIOR-PRESERVING: metadata-only ALTER (nullable, no rebuild), nothing
 * reads the column until the same release's write/enforce sites. Existing
 * deployments stamp roles by re-running init-enterprise-topology (idempotent).
 */
export const migration036: Migration = {
  version: 36,
  name: 'agent-group-role',
  up: (db: Database.Database) => {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN role TEXT`);
  },
};
