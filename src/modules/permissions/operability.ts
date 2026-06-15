/**
 * Operability gate (ADR-0051).
 *
 * `canOperate` is the in-band authorization for the READ-ONLY operator/triage
 * surface (ADR-0049: `src/db/operator-queries.ts`, `scripts/trace.ts`). Before
 * this, that surface was OS-gated only ("whoever can run the CLI / read v2.db");
 * `canOperate` lets a host or a future operator endpoint apply a real role check
 * so fleet triage can be delegated WITHOUT handing out a shell + raw DB access.
 *
 * Two hard boundaries:
 *  - This gates HOST OPERABILITY / GOVERNANCE reads only. It is NEVER a
 *    per-request business-authz input — business authorization stays at the
 *    backend gateway (the only authorization path). The gateway proxy must not
 *    import or consult this (enforced by operability-gateway-isolation.test.ts).
 *  - It confers no routing/write power. `canAccessAgentGroup` (the routing gate)
 *    and `hasAdminPrivilege` (approval-card authority) are unchanged; an
 *    operator/viewer cannot chat-route or approve.
 *
 * Scope semantics:
 *  - No `agentGroupId` → FLEET-WIDE operate: only owner / global-admin /
 *    global-operator / global-viewer.
 *  - With `agentGroupId` → that group: the above, OR a role scoped to the group
 *    (operator / viewer / admin @ group).
 */
import { hasOrgOperabilityRole, isMemberOfOrg, isOrgAdmin, orgOfAgentGroup } from './db/organizations.js';
import {
  hasGlobalOperabilityRole,
  hasScopedOperabilityRole,
  isAdminOfAgentGroup,
  isGlobalAdmin,
  isOwner,
} from './db/user-roles.js';
import { getUser } from './db/users.js';

export function canOperate(userId: string, agentGroupId?: string): boolean {
  if (!getUser(userId)) return false;
  // Platform tier — fleet-wide operate.
  if (isOwner(userId) || isGlobalAdmin(userId) || hasGlobalOperabilityRole(userId)) return true;
  if (agentGroupId) {
    // Org prerequisite, symmetric with canAccessAgentGroup (ADR-0052).
    const org = orgOfAgentGroup(agentGroupId);
    if (org !== null && !isMemberOfOrg(userId, org)) return false;
    if (isAdminOfAgentGroup(userId, agentGroupId) || hasScopedOperabilityRole(userId, agentGroupId)) return true;
    if (org !== null && (isOrgAdmin(userId, org) || hasOrgOperabilityRole(userId, org))) return true;
  }
  return false;
}
