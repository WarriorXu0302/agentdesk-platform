import type { RoleScope, UserRole, UserRoleKind } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { recordEnterpriseAudit } from '../../../db/enterprise-audit.js';

/**
 * Grant a role at an explicit scope (ADR-0052). Role/scope pairing is enforced
 * here (not by schema), so callers get a clean error path:
 *   owner           ⇒ global only
 *   org-admin       ⇒ org only
 *   admin           ⇒ global or group (NOT org — use 'org-admin' for an org admin)
 *   operator/viewer ⇒ any scope
 *
 * EXACTLY ONE of agent_group_id / organization_id is non-null, derived from the
 * scope — so there is no second copy of org to desync. This is the SINGLE audited
 * insert path: org-scoped grants ride the same statement + the same
 * `enterprise_audit` write (no parallel, un-audited path).
 */
export function grantRole(args: {
  userId: string;
  role: UserRoleKind;
  scope: RoleScope;
  grantedBy: string | null;
  grantedAt?: string;
}): void {
  const { userId, role, scope, grantedBy } = args;
  if (role === 'owner' && scope.kind !== 'global') {
    throw new Error('owner role must be global');
  }
  if (role === 'org-admin' && scope.kind !== 'org') {
    throw new Error("'org-admin' role must be org-scoped");
  }
  if (role === 'admin' && scope.kind === 'org') {
    throw new Error("admin role cannot be org-scoped — use the 'org-admin' role");
  }
  const agentGroupId = scope.kind === 'group' ? scope.agentGroupId : null;
  const organizationId = scope.kind === 'org' ? scope.organizationId : null;
  const row: UserRole = {
    user_id: userId,
    role,
    agent_group_id: agentGroupId,
    organization_id: organizationId,
    granted_by: grantedBy,
    granted_at: args.grantedAt ?? new Date().toISOString(),
  };
  getDb()
    .prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, organization_id, granted_by, granted_at)
       VALUES (@user_id, @role, @agent_group_id, @organization_id, @granted_by, @granted_at)`,
    )
    .run(row);
  recordEnterpriseAudit({
    eventType: 'user_role_granted',
    agentGroupId,
    actor: grantedBy,
    details: { userId, role, agentGroupId, organizationId },
  });
}

/**
 * Revoke a role at an explicit scope (ADR-0052). The scope goes into the DELETE
 * predicate so the three scope axes are DISJOINT: a 'global' revoke carries
 * `AND organization_id IS NULL` and therefore can NOT collaterally strip an
 * org-scoped grant (the historical fatal flaw), and a single org-scoped role is
 * now precisely revocable. Only emits an audit row when a role was actually
 * removed, so no-op revokes don't create misleading trails.
 */
export function revokeRole(args: {
  userId: string;
  role: UserRoleKind;
  scope: RoleScope;
  revokedBy?: string | null;
}): void {
  const { userId, role, scope, revokedBy = null } = args;
  let where: string;
  const params: unknown[] = [userId, role];
  switch (scope.kind) {
    case 'global':
      where = 'agent_group_id IS NULL AND organization_id IS NULL';
      break;
    case 'group':
      where = 'agent_group_id = ? AND organization_id IS NULL';
      params.push(scope.agentGroupId);
      break;
    case 'org':
      where = 'agent_group_id IS NULL AND organization_id = ?';
      params.push(scope.organizationId);
      break;
    default: {
      const _exhaustive: never = scope;
      throw new Error(`unknown role scope: ${JSON.stringify(_exhaustive)}`);
    }
  }
  const result = getDb()
    .prepare(`DELETE FROM user_roles WHERE user_id = ? AND role = ? AND ${where}`)
    .run(...params);
  if (result.changes > 0) {
    recordEnterpriseAudit({
      eventType: 'user_role_revoked',
      agentGroupId: scope.kind === 'group' ? scope.agentGroupId : null,
      actor: revokedBy,
      details: { userId, role, scope, removed: result.changes },
    });
  }
}

export function getUserRoles(userId: string): UserRole[] {
  return getDb().prepare('SELECT * FROM user_roles WHERE user_id = ?').all(userId) as UserRole[];
}

export function isOwner(userId: string): boolean {
  const row = getDb()
    .prepare(
      'SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL AND organization_id IS NULL LIMIT 1',
    )
    .get(userId, 'owner');
  return !!row;
}

export function isGlobalAdmin(userId: string): boolean {
  const row = getDb()
    .prepare(
      'SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL AND organization_id IS NULL LIMIT 1',
    )
    .get(userId, 'admin');
  return !!row;
}

export function isAdminOfAgentGroup(userId: string, agentGroupId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ? LIMIT 1')
    .get(userId, 'admin', agentGroupId);
  return !!row;
}

/** Any admin privilege over this agent group: global admin OR scoped admin. */
export function hasAdminPrivilege(userId: string, agentGroupId: string): boolean {
  return isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId);
}

export function getOwners(): UserRole[] {
  return getDb()
    .prepare(
      'SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL AND organization_id IS NULL ORDER BY granted_at',
    )
    .all('owner') as UserRole[];
}

export function hasAnyOwner(): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM user_roles WHERE role = ? AND agent_group_id IS NULL AND organization_id IS NULL LIMIT 1')
    .get('owner');
  return !!row;
}

export function getGlobalAdmins(): UserRole[] {
  return getDb()
    .prepare(
      'SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL AND organization_id IS NULL ORDER BY granted_at',
    )
    .all('admin') as UserRole[];
}

export function getAdminsOfAgentGroup(agentGroupId: string): UserRole[] {
  return getDb()
    .prepare('SELECT * FROM user_roles WHERE role = ? AND agent_group_id = ? ORDER BY granted_at')
    .all('admin', agentGroupId) as UserRole[];
}

/**
 * Operability roles (ADR-0051): `operator` / `viewer` gate read-only fleet
 * triage / governance on the HOST plane (the ADR-0049 operator surface). They
 * are DELIBERATELY absent from `hasAdminPrivilege` above — an operator/viewer
 * must NOT gain admin power (approval-card authority, member-add) and must NOT
 * become a routable member. The composed operability gate lives in
 * `operability.ts` (`canOperate`); these are the low-level reads.
 */
export function hasGlobalOperabilityRole(userId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 FROM user_roles WHERE user_id = ? AND role IN ('operator', 'viewer') AND agent_group_id IS NULL AND organization_id IS NULL LIMIT 1",
    )
    .get(userId);
  return !!row;
}

export function hasScopedOperabilityRole(userId: string, agentGroupId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 FROM user_roles WHERE user_id = ? AND role IN ('operator', 'viewer') AND agent_group_id = ? LIMIT 1",
    )
    .get(userId, agentGroupId);
  return !!row;
}

export function getOperators(): UserRole[] {
  return getDb()
    .prepare(
      'SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL AND organization_id IS NULL ORDER BY granted_at',
    )
    .all('operator') as UserRole[];
}

export function getViewers(): UserRole[] {
  return getDb()
    .prepare(
      'SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL AND organization_id IS NULL ORDER BY granted_at',
    )
    .all('viewer') as UserRole[];
}
