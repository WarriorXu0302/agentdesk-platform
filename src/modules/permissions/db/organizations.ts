/**
 * Organization tenancy (ADR-0052) — the org table, its membership roster, and
 * the org-scoped reads the access gate / operability gate consult in Stage B.
 *
 * Membership is REACHABILITY, not privilege: an `organization_members` row says
 * "this user is reachable inside org O", nothing more. Privilege is in
 * `user_roles` with `organization_id` set (org-admin / org-scoped operator|viewer).
 *
 * Everything here reads/writes only HOST central-DB tables — never the gateway
 * (invariant 2; enforced by operability-gateway-isolation.test.ts).
 */
import type { Organization } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { recordEnterpriseAudit } from '../../../db/enterprise-audit.js';

export function createOrganization(org: Organization): void {
  getDb()
    .prepare('INSERT INTO organizations (id, name, slug, created_at) VALUES (@id, @name, @slug, @created_at)')
    .run(org);
  recordEnterpriseAudit({
    eventType: 'organization_created',
    actor: null,
    details: { id: org.id, slug: org.slug, name: org.name },
  });
}

export function getOrganization(id: string): Organization | undefined {
  return getDb().prepare('SELECT * FROM organizations WHERE id = ?').get(id) as Organization | undefined;
}

export function getOrganizationBySlug(slug: string): Organization | undefined {
  return getDb().prepare('SELECT * FROM organizations WHERE slug = ?').get(slug) as Organization | undefined;
}

export function getAllOrganizations(): Organization[] {
  return getDb().prepare('SELECT * FROM organizations ORDER BY created_at').all() as Organization[];
}

/** Enroll a user into an org (reachability, not privilege). Idempotent + audited on change. */
export function addOrgMember(organizationId: string, userId: string, addedBy: string | null = null): void {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO organization_members (organization_id, user_id, added_by, added_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(organizationId, userId, addedBy, new Date().toISOString());
  if (result.changes > 0) {
    recordEnterpriseAudit({
      eventType: 'org_member_added',
      actor: addedBy,
      details: { organizationId, userId },
    });
  }
}

export function removeOrgMember(organizationId: string, userId: string, removedBy: string | null = null): void {
  const result = getDb()
    .prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
    .run(organizationId, userId);
  if (result.changes > 0) {
    recordEnterpriseAudit({
      eventType: 'org_member_removed',
      actor: removedBy,
      details: { organizationId, userId },
    });
  }
}

/**
 * Assign an EXISTING agent group to an organization (ADR-0052 Stage C). To avoid
 * locking out the group's current principals once the org prerequisite is live,
 * this also enrolls every current group member + group-scoped admin into the org
 * (mirrors the migration-035 backfill). Idempotent + audited. Returns the number
 * of principals freshly enrolled.
 */
export function assignAgentGroupToOrg(
  agentGroupId: string,
  organizationId: string,
  actor: string | null = null,
): number {
  const db = getDb();
  db.prepare('UPDATE agent_groups SET organization_id = ? WHERE id = ?').run(organizationId, agentGroupId);
  const principals = new Set<string>();
  for (const r of db
    .prepare('SELECT user_id FROM agent_group_members WHERE agent_group_id = ?')
    .all(agentGroupId) as Array<{ user_id: string }>) {
    principals.add(r.user_id);
  }
  for (const r of db.prepare('SELECT user_id FROM user_roles WHERE agent_group_id = ?').all(agentGroupId) as Array<{
    user_id: string;
  }>) {
    principals.add(r.user_id);
  }
  let enrolled = 0;
  const before = db
    .prepare('SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?')
    .get(organizationId) as { n: number };
  for (const userId of principals) addOrgMember(organizationId, userId, actor);
  const after = db
    .prepare('SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?')
    .get(organizationId) as { n: number };
  enrolled = after.n - before.n;
  recordEnterpriseAudit({
    eventType: 'agent_group_org_assigned',
    agentGroupId,
    actor,
    details: { organizationId, enrolledMembers: enrolled },
  });
  return enrolled;
}

export function isMemberOfOrg(userId: string, organizationId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ? LIMIT 1')
    .get(organizationId, userId);
  return !!row;
}

/** Which orgs is this user a member of? (the hot prerequisite lookup) */
export function orgsForUser(userId: string): string[] {
  return (
    getDb().prepare('SELECT organization_id FROM organization_members WHERE user_id = ?').all(userId) as Array<{
      organization_id: string;
    }>
  ).map((r) => r.organization_id);
}

/** The org that owns an agent group, derived from the immutable agent_group_id FK. */
export function orgOfAgentGroup(agentGroupId: string): string | null {
  const row = getDb().prepare('SELECT organization_id FROM agent_groups WHERE id = ?').get(agentGroupId) as
    | { organization_id: string | null }
    | undefined;
  return row?.organization_id ?? null;
}

/** Org-scoped admin over org O (role 'org-admin', organization_id = O, no group scope). */
export function isOrgAdmin(userId: string, organizationId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ? AND role = 'org-admin' AND organization_id = ? AND agent_group_id IS NULL LIMIT 1`,
    )
    .get(userId, organizationId);
  return !!row;
}

/** Every org-admin of org O (for approver-picking, ADR-0052 FIX-4b). */
export function getOrgAdmins(organizationId: string): Array<{ user_id: string }> {
  return getDb()
    .prepare(
      `SELECT user_id FROM user_roles
       WHERE role = 'org-admin' AND organization_id = ? AND agent_group_id IS NULL ORDER BY granted_at`,
    )
    .all(organizationId) as Array<{ user_id: string }>;
}

/** Org-scoped operability (operator|viewer) over org O. */
export function hasOrgOperabilityRole(userId: string, organizationId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ? AND role IN ('operator', 'viewer') AND organization_id = ? AND agent_group_id IS NULL LIMIT 1`,
    )
    .get(userId, organizationId);
  return !!row;
}
