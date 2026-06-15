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
import {
  hasGlobalOperabilityRole,
  hasScopedOperabilityRole,
  isAdminOfAgentGroup,
  isGlobalAdmin,
  isOwner,
} from './db/user-roles.js';
import { getUser } from './db/users.js';

export type AccessDecision =
  | { allowed: true; reason: 'owner' | 'global_admin' | 'admin_of_group' | 'member' }
  | { allowed: false; reason: 'unknown_user' | 'not_member' | 'operability_only' };

/**
 * Can this user ROUTE to / interact with this agent group?
 *
 * This is the HOST routing gate. Operability roles (operator/viewer, ADR-0051)
 * are NOT routing grants: a user holding only operator/viewer is denied here
 * with the explicit `operability_only` reason (clearer than the misleading
 * `not_member`), so logs/dropped_messages show "has fleet-triage access, but
 * not chat access". Operability access is gated separately by `canOperate`
 * (operability.ts) — never here.
 */
export function canAccessAgentGroup(userId: string, agentGroupId: string): AccessDecision {
  if (!getUser(userId)) return { allowed: false, reason: 'unknown_user' };
  if (isOwner(userId)) return { allowed: true, reason: 'owner' };
  if (isGlobalAdmin(userId)) return { allowed: true, reason: 'global_admin' };
  if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'admin_of_group' };
  if (isMember(userId, agentGroupId)) return { allowed: true, reason: 'member' };
  if (hasGlobalOperabilityRole(userId) || hasScopedOperabilityRole(userId, agentGroupId)) {
    return { allowed: false, reason: 'operability_only' };
  }
  return { allowed: false, reason: 'not_member' };
}
