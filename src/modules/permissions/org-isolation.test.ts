/**
 * Cross-org isolation at the host access gate (ADR-0052 Stage B / B1).
 *
 * An attacker in org X must not reach org Y's agent group via routing, and the
 * org-membership PREREQUISITE must gate even a stale group-membership / a
 * cross-org admin grant. owner/global_admin sit above the boundary (sub-decision
 * #2). NULL-org (legacy) groups keep the pre-ADR-0052 behavior (backward-compat).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { canAccessAgentGroup } from './access.js';
import { addMember } from './db/agent-group-members.js';
import { addOrgMember, assignAgentGroupToOrg, createOrganization, isMemberOfOrg } from './db/organizations.js';
import { createUser } from './db/users.js';
import { grantRole, hasAdminPrivilege } from './db/user-roles.js';
import { canOperate } from './operability.js';
import { createDestination } from '../agent-to-agent/db/agent-destinations.js';

function now(): string {
  return new Date().toISOString();
}
function reason(d: ReturnType<typeof canAccessAgentGroup>): string {
  return d.reason;
}

beforeEach(() => {
  runMigrations(initTestDb());
  createOrganization({ id: 'org-x', name: 'X', slug: 'x', created_at: now() });
  createOrganization({ id: 'org-y', name: 'Y', slug: 'y', created_at: now() });
  // gX ∈ org-x, gY ∈ org-y, gLegacy ∈ no org
  createAgentGroup({
    id: 'gX',
    name: 'GX',
    folder: 'gx',
    agent_provider: null,
    created_at: now(),
    organization_id: 'org-x',
  });
  createAgentGroup({
    id: 'gY',
    name: 'GY',
    folder: 'gy',
    agent_provider: null,
    created_at: now(),
    organization_id: 'org-y',
  });
  createAgentGroup({ id: 'gLegacy', name: 'GL', folder: 'gl', agent_provider: null, created_at: now() });
});

afterEach(() => closeDb());

describe('canAccessAgentGroup cross-org denial', () => {
  it('an org-X member reaches org-X groups but is cross_org_denied on org-Y', () => {
    createUser({ id: 'u', kind: 'tg', display_name: null, created_at: now() });
    addOrgMember('org-x', 'u');
    addMember({ user_id: 'u', agent_group_id: 'gX', added_by: null, added_at: now() });

    expect(canAccessAgentGroup('u', 'gX').allowed).toBe(true);
    const dY = canAccessAgentGroup('u', 'gY');
    expect(dY.allowed).toBe(false);
    expect(reason(dY)).toBe('cross_org_denied');
  });

  it('the org prerequisite gates even a group member who is NOT an org member', () => {
    createUser({ id: 'u', kind: 'tg', display_name: null, created_at: now() });
    addMember({ user_id: 'u', agent_group_id: 'gX', added_by: null, added_at: now() }); // group member, NOT org member
    const d = canAccessAgentGroup('u', 'gX');
    expect(d.allowed).toBe(false);
    expect(reason(d)).toBe('cross_org_denied');
  });

  it('owner / global_admin bypass the org boundary (sub-decision #2)', () => {
    createUser({ id: 'owner', kind: 'tg', display_name: null, created_at: now() });
    createUser({ id: 'ga', kind: 'tg', display_name: null, created_at: now() });
    grantRole({ userId: 'owner', role: 'owner', scope: { kind: 'global' }, grantedBy: null });
    grantRole({ userId: 'ga', role: 'admin', scope: { kind: 'global' }, grantedBy: null });
    expect(canAccessAgentGroup('owner', 'gX').allowed).toBe(true);
    expect(canAccessAgentGroup('owner', 'gY').allowed).toBe(true);
    expect(canAccessAgentGroup('ga', 'gY').allowed).toBe(true);
  });

  it('an org-admin reaches their org, not another', () => {
    createUser({ id: 'oa', kind: 'tg', display_name: null, created_at: now() });
    addOrgMember('org-x', 'oa');
    grantRole({ userId: 'oa', role: 'org-admin', scope: { kind: 'org', organizationId: 'org-x' }, grantedBy: null });
    const dX = canAccessAgentGroup('oa', 'gX');
    expect(dX.allowed === true && dX.reason).toBe('org_admin');
    expect(reason(canAccessAgentGroup('oa', 'gY'))).toBe('cross_org_denied');
  });

  it('NULL-org (legacy) groups keep pre-ADR-0052 behavior: a group member needs no org membership', () => {
    createUser({ id: 'u', kind: 'tg', display_name: null, created_at: now() });
    addMember({ user_id: 'u', agent_group_id: 'gLegacy', added_by: null, added_at: now() });
    expect(canAccessAgentGroup('u', 'gLegacy').allowed).toBe(true);
  });
});

describe('canOperate is org-aware (symmetric with the gate)', () => {
  it('an org-X operator can operate org-X groups only, never another org and never fleet-wide', () => {
    createUser({ id: 'op', kind: 'tg', display_name: null, created_at: now() });
    addOrgMember('org-x', 'op');
    grantRole({ userId: 'op', role: 'operator', scope: { kind: 'org', organizationId: 'org-x' }, grantedBy: null });
    expect(canOperate('op', 'gX')).toBe(true);
    expect(canOperate('op', 'gY')).toBe(false);
    expect(canOperate('op')).toBe(false); // fleet-wide → platform tier only
  });

  it('an org operator who is not an org member is denied (prerequisite)', () => {
    createUser({ id: 'op', kind: 'tg', display_name: null, created_at: now() });
    grantRole({ userId: 'op', role: 'operator', scope: { kind: 'org', organizationId: 'org-x' }, grantedBy: null });
    // role granted but NOT enrolled as org member → prerequisite denies
    expect(canOperate('op', 'gX')).toBe(false);
  });
});

describe('hasAdminPrivilege is org-aware (approval-card authority)', () => {
  it('an org-admin has admin privilege in their org, not another', () => {
    createUser({ id: 'oa', kind: 'tg', display_name: null, created_at: now() });
    addOrgMember('org-x', 'oa');
    grantRole({ userId: 'oa', role: 'org-admin', scope: { kind: 'org', organizationId: 'org-x' }, grantedBy: null });
    expect(hasAdminPrivilege('oa', 'gX')).toBe(true);
    expect(hasAdminPrivilege('oa', 'gY')).toBe(false);
  });

  it('a cross-org group-admin grant is inert without org membership', () => {
    createUser({ id: 'a', kind: 'tg', display_name: null, created_at: now() });
    grantRole({ userId: 'a', role: 'admin', scope: { kind: 'group', agentGroupId: 'gX' }, grantedBy: null });
    // group-admin of gX but never enrolled in org-x → org prerequisite makes it inert
    expect(hasAdminPrivilege('a', 'gX')).toBe(false);
  });

  it('owner keeps admin privilege everywhere', () => {
    createUser({ id: 'owner', kind: 'tg', display_name: null, created_at: now() });
    grantRole({ userId: 'owner', role: 'owner', scope: { kind: 'global' }, grantedBy: null });
    expect(hasAdminPrivilege('owner', 'gX')).toBe(true);
    expect(hasAdminPrivilege('owner', 'gY')).toBe(true);
  });
});

describe('assignAgentGroupToOrg auto-enrolls existing principals (Stage C, no lockout)', () => {
  it('enrolls current members + scoped admins so they keep access after assignment', () => {
    createUser({ id: 'm', kind: 'tg', display_name: null, created_at: now() });
    createUser({ id: 'a', kind: 'tg', display_name: null, created_at: now() });
    addMember({ user_id: 'm', agent_group_id: 'gLegacy', added_by: null, added_at: now() });
    grantRole({ userId: 'a', role: 'admin', scope: { kind: 'group', agentGroupId: 'gLegacy' }, grantedBy: null });
    // Before assignment gLegacy is null-org → both already have access.
    expect(canAccessAgentGroup('m', 'gLegacy').allowed).toBe(true);

    const enrolled = assignAgentGroupToOrg('gLegacy', 'org-x', null);
    expect(enrolled).toBe(2); // m + a

    // Now org-scoped, but the auto-enroll keeps both reachable (no lockout).
    expect(isMemberOfOrg('m', 'org-x')).toBe(true);
    expect(isMemberOfOrg('a', 'org-x')).toBe(true);
    expect(canAccessAgentGroup('m', 'gLegacy').allowed).toBe(true);
    // An outsider is now cross_org_denied on the freshly-orged group.
    createUser({ id: 'outsider', kind: 'tg', display_name: null, created_at: now() });
    addMember({ user_id: 'outsider', agent_group_id: 'gLegacy', added_by: null, added_at: now() });
    expect((canAccessAgentGroup('outsider', 'gLegacy') as { reason: string }).reason).toBe('cross_org_denied');
  });
});

describe('createDestination cross-org refusal (FIX-3, a2a ACL writer)', () => {
  it('refuses an agent→agent destination across orgs', () => {
    expect(() =>
      createDestination({
        agent_group_id: 'gX',
        local_name: 'y',
        target_type: 'agent',
        target_id: 'gY',
        created_at: now(),
      }),
    ).toThrow(/cross-org/);
  });

  it('allows same-org and NULL-org agent destinations, and channel destinations', () => {
    createAgentGroup({
      id: 'gX2',
      name: 'GX2',
      folder: 'gx2',
      agent_provider: null,
      created_at: now(),
      organization_id: 'org-x',
    });
    // same org → ok
    expect(() =>
      createDestination({
        agent_group_id: 'gX',
        local_name: 'x2',
        target_type: 'agent',
        target_id: 'gX2',
        created_at: now(),
      }),
    ).not.toThrow();
    // legacy/null-org side → ok (no boundary)
    expect(() =>
      createDestination({
        agent_group_id: 'gX',
        local_name: 'leg',
        target_type: 'agent',
        target_id: 'gLegacy',
        created_at: now(),
      }),
    ).not.toThrow();
    // channels are not org-scoped → ok even from an org-scoped group
    expect(() =>
      createDestination({
        agent_group_id: 'gX',
        local_name: 'ch',
        target_type: 'channel',
        target_id: 'mg-1',
        created_at: now(),
      }),
    ).not.toThrow();
  });
});
