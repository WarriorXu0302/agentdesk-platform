/**
 * Access control.
 *
 * Privilege is user-level, not group-level. A user holds zero or more roles
 * (owner | admin) via `user_roles`, and is optionally "known" in specific
 * agent groups via `agent_group_members`. Admins are implicitly members of
 * the groups they administer.
 *
 * Approver-picking (`pickApprover`, `pickApprovalDelivery`) lives in the
 * approvals module — see `src/modules/approvals/primitive.ts`.
 */
import { isMember } from './db/agent-group-members.js';
import { hasOrgOperabilityRole, isMemberOfOrg, isOrgAdmin, orgOfAgentGroup } from './db/organizations.js';
import {
  hasGlobalOperabilityRole,
  hasScopedOperabilityRole,
  isAdminOfAgentGroup,
  isGlobalAdmin,
  isOwner,
} from './db/user-roles.js';
import { getUser } from './db/users.js';

export type AccessDecision =
  | { allowed: true; reason: 'owner' | 'global_admin' | 'org_admin' | 'admin_of_group' | 'member' }
  | { allowed: false; reason: 'unknown_user' | 'not_member' | 'operability_only' | 'cross_org_denied' };

/**
 * Can this user ROUTE to / interact with this agent group?
 *
 * This is the HOST routing gate. Order (ADR-0052):
 *  1. owner / global_admin — platform superusers, ABOVE the tenant boundary
 *     (they bypass the org prerequisite by design; sub-decision #2).
 *  2. ORG PREREQUISITE — if the group belongs to an organization, the user must
 *     be a member of that org, else `cross_org_denied`. A NULL-org (legacy /
 *     un-orged) group has no prerequisite, so an un-orged deployment behaves
 *     exactly as before (full backward-compat).
 *  3. org-admin / group-admin / member.
 *
 * Operability roles (operator/viewer, ADR-0051) are NOT routing grants: a user
 * holding only operator/viewer is denied with the explicit `operability_only`
 * reason. Operability access is gated separately by `canOperate` — never here.
 */
export function canAccessAgentGroup(userId: string, agentGroupId: string): AccessDecision {
  if (!getUser(userId)) return { allowed: false, reason: 'unknown_user' };
  if (isOwner(userId)) return { allowed: true, reason: 'owner' };
  if (isGlobalAdmin(userId)) return { allowed: true, reason: 'global_admin' };

  const org = orgOfAgentGroup(agentGroupId);
  if (org !== null && !isMemberOfOrg(userId, org)) {
    return { allowed: false, reason: 'cross_org_denied' };
  }

  if (org !== null && isOrgAdmin(userId, org)) return { allowed: true, reason: 'org_admin' };
  if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'admin_of_group' };
  if (isMember(userId, agentGroupId)) return { allowed: true, reason: 'member' };
  if (
    hasGlobalOperabilityRole(userId) ||
    hasScopedOperabilityRole(userId, agentGroupId) ||
    (org !== null && hasOrgOperabilityRole(userId, org))
  ) {
    return { allowed: false, reason: 'operability_only' };
  }
  return { allowed: false, reason: 'not_member' };
}
