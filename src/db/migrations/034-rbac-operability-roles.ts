import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Operability roles (ADR-0051): add `operator` / `viewer` as user-level role
 * kinds for read-only fleet triage / governance on the HOST plane (the ADR-0049
 * operator surface) — never routing, never per-request business authz.
 *
 * Like 'escalate' (migration030) and 'routing_feedback' (migration033), the new
 * role kinds need NO DDL on `user_roles`: `role` is plain TEXT with no CHECK
 * constraint, so 'operator'/'viewer' are insertable today, and they reuse the
 * existing nullable `agent_group_id` scoping (global or per-group, exactly like
 * 'admin'). A CHECK constraint is deliberately NOT added — it would force a
 * full table rebuild AND freeze the role vocabulary, against the project's
 * "enforce in code, not schema" convention (the owner-must-be-global rule is
 * enforced in grantRole, not the schema).
 *
 * The only DDL here is a metadata-only index to keep the new global
 * role-listing getters (getOperators/getViewers) cheap. Idempotent + no
 * rewrite + safe on a populated table. Central v2.db only (host-single-writer);
 * no session-DB / three-DB concern.
 */
export const migration034: Migration = {
  version: 34,
  name: 'rbac-operability-roles',
  up: (db: Database.Database) => {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);`);
  },
};
