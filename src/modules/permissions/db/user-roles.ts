import type { UserRole, UserRoleKind } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { recordEnterpriseAudit } from '../../../db/enterprise-audit.js';

/**
 * Grant a role. Owner rows must have agent_group_id = null (enforced here,
 * not by schema, so callers get a clean error path).
 *
 * Privilege grants are recorded to `enterprise_audit` (roadmap 5.1): a missing
 * audit row for a role change is a compliance gap — reviewers must be able to
 * reconstruct "who granted whom what, and when".
 */
export function grantRole(row: UserRole): void {
  if (row.role === 'owner' && row.agent_group_id !== null) {
    throw new Error('owner role must be global (agent_group_id = null)');
  }
  getDb()
    .prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (@user_id, @role, @agent_group_id, @granted_by, @granted_at)`,
    )
    .run(row);
  recordEnterpriseAudit({
    eventType: 'user_role_granted',
    agentGroupId: row.agent_group_id,
    actor: row.granted_by,
    details: { userId: row.user_id, role: row.role, agentGroupId: row.agent_group_id },
  });
}

/**
 * Revoke a role. `revokedBy` is the actor performing the revoke (optional for
 * backward compatibility; callers should pass it). Only emits an audit row when
 * a role was actually removed, so no-op revokes don't create misleading trails.
 */
export function revokeRole(
  userId: string,
  role: UserRoleKind,
  agentGroupId: string | null,
  revokedBy: string | null = null,
): void {
  const result =
    agentGroupId === null
      ? getDb()
          .prepare('DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL')
          .run(userId, role)
      : getDb()
          .prepare('DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ?')
          .run(userId, role, agentGroupId);
  if (result.changes > 0) {
    recordEnterpriseAudit({
      eventType: 'user_role_revoked',
      agentGroupId,
      actor: revokedBy,
      details: { userId, role, agentGroupId, removed: result.changes },
    });
  }
}

export function getUserRoles(userId: string): UserRole[] {
  return getDb().prepare('SELECT * FROM user_roles WHERE user_id = ?').all(userId) as UserRole[];
}

export function isOwner(userId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL LIMIT 1')
    .get(userId, 'owner');
  return !!row;
}

export function isGlobalAdmin(userId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL LIMIT 1')
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
    .prepare('SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL ORDER BY granted_at')
    .all('owner') as UserRole[];
}

export function hasAnyOwner(): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM user_roles WHERE role = ? AND agent_group_id IS NULL LIMIT 1')
    .get('owner');
  return !!row;
}

export function getGlobalAdmins(): UserRole[] {
  return getDb()
    .prepare('SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL ORDER BY granted_at')
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
      "SELECT 1 FROM user_roles WHERE user_id = ? AND role IN ('operator', 'viewer') AND agent_group_id IS NULL LIMIT 1",
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
    .prepare('SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL ORDER BY granted_at')
    .all('operator') as UserRole[];
}

export function getViewers(): UserRole[] {
  return getDb()
    .prepare('SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL ORDER BY granted_at')
    .all('viewer') as UserRole[];
}
