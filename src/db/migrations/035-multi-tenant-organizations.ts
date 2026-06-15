import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Multi-tenant organization isolation (ADR-0052, Stage A — schema + backfill).
 *
 * Adds the organization tenant and its membership roster, plus an
 * `organization_id` on the two tables that actually carry tenancy on the
 * workload side:
 *   - agent_groups.organization_id — the ONLY workload anchor; sessions /
 *     messaging_groups / audit derive org by JOIN through their (immutable)
 *     agent_group_id, so there is no second copy of org to drift or forge.
 *   - user_roles.organization_id — lets a role grant itself be org-scoped
 *     ('org-admin' / org-scoped operator|viewer).
 *
 * `organization_members` is REACHABILITY, not privilege (privilege stays in
 * user_roles). This split is what avoids a circular access gate.
 *
 * STAGE A IS BEHAVIOR-PRESERVING: nothing reads these columns until Stage B
 * wires the access gate. All DDL is metadata-only on central v2.db (CREATE
 * TABLE / ALTER ADD COLUMN nullable / CREATE INDEX) — no PK touch, no rebuild,
 * no session-DB / three-DB concern.
 *
 * Backfill (sub-decision #3, recommended default): if the deployment already
 * has workload, materialize a single 'org-default' and enroll EVERY currently
 * reachable user into it, so an upgrade locks nobody out. A single-org
 * deployment then behaves byte-for-byte as before once Stage B lands. Global
 * roles (owner / global-admin / global-operability) deliberately STAY org-NULL;
 * only group-scoped role rows inherit their group's org.
 */
export const migration035: Migration = {
  version: 35,
  name: 'multi-tenant-organizations',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        slug       TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS organization_members (
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        user_id         TEXT NOT NULL REFERENCES users(id),
        added_by        TEXT REFERENCES users(id),
        added_at        TEXT NOT NULL,
        PRIMARY KEY (organization_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
    `);

    const agCols = db.prepare(`PRAGMA table_info(agent_groups)`).all() as Array<{ name: string }>;
    if (!agCols.some((c) => c.name === 'organization_id')) {
      db.exec(`ALTER TABLE agent_groups ADD COLUMN organization_id TEXT REFERENCES organizations(id);`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_groups_org ON agent_groups(organization_id);`);

    const urCols = db.prepare(`PRAGMA table_info(user_roles)`).all() as Array<{ name: string }>;
    if (!urCols.some((c) => c.name === 'organization_id')) {
      db.exec(`ALTER TABLE user_roles ADD COLUMN organization_id TEXT REFERENCES organizations(id);`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_roles_org ON user_roles(organization_id);
      -- One org-scoped grant of a role per (user, org). agent_group_id IS NULL guard
      -- keeps this disjoint from group-scoped rows (whose org is always NULL).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_org_grant
        ON user_roles(user_id, role, organization_id)
        WHERE agent_group_id IS NULL AND organization_id IS NOT NULL;
    `);

    // ── Backfill (idempotent; only materializes a default org if there is workload) ──
    const iso = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO organizations (id, name, slug, created_at)
         SELECT 'org-default', 'Default', 'default', ?
         WHERE EXISTS (SELECT 1 FROM agent_groups) OR EXISTS (SELECT 1 FROM user_roles)`,
    ).run(iso);

    db.exec(`UPDATE agent_groups SET organization_id = 'org-default' WHERE organization_id IS NULL;`);

    // Enroll everyone reachable today (member OR role-holder) so nobody is locked out.
    db.prepare(
      `INSERT OR IGNORE INTO organization_members (organization_id, user_id, added_by, added_at)
         SELECT 'org-default', user_id, NULL, ? FROM agent_group_members
         UNION SELECT 'org-default', user_id, NULL, ? FROM user_roles`,
    ).run(iso, iso);

    // Group-scoped role rows inherit their group's org; GLOBAL rows stay org NULL.
    db.exec(`
      UPDATE user_roles
         SET organization_id = (SELECT ag.organization_id FROM agent_groups ag WHERE ag.id = user_roles.agent_group_id)
       WHERE agent_group_id IS NOT NULL AND organization_id IS NULL;
    `);
  },
};
