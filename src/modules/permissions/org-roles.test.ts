/**
 * Multi-tenant org roles + contract rework (ADR-0052 Stage A).
 *
 * The headline test is the REVOKE-CONTRACT REGRESSION: it pins the fix for the
 * fatal flaw where a global revoke (predicated only on `agent_group_id IS NULL`)
 * would collaterally strip every org-scoped grant. Also covers grant/scope
 * validation, the single audited grant path, fix-1 (org rows must not leak as
 * global), and the organizations.ts reads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import {
  addOrgMember,
  createOrganization,
  getOrganizationBySlug,
  hasOrgOperabilityRole,
  isMemberOfOrg,
  isOrgAdmin,
  orgOfAgentGroup,
  orgsForUser,
} from './db/organizations.js';
import { createUser } from './db/users.js';
import {
  getGlobalAdmins,
  getUserRoles,
  grantRole,
  hasGlobalOperabilityRole,
  isGlobalAdmin,
  revokeRole,
} from './db/user-roles.js';

function now(): string {
  return new Date().toISOString();
}

function seedOrg(id: string, slug: string): void {
  createOrganization({ id, name: id, slug, created_at: now() });
}

function seedUser(id: string): void {
  createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

beforeEach(() => {
  runMigrations(initTestDb());
  seedOrg('org-x', 'x');
  seedOrg('org-y', 'y');
  seedUser('u');
});

afterEach(() => {
  closeDb();
});

describe('revoke-contract regression (ADR-0052 — the fatal-flaw fix)', () => {
  it('a global revoke removes ONLY the global grant, never org-scoped grants', () => {
    grantRole({ userId: 'u', role: 'admin', scope: { kind: 'global' }, grantedBy: null });
    grantRole({ userId: 'u', role: 'org-admin', scope: { kind: 'org', organizationId: 'org-x' }, grantedBy: null });
    grantRole({ userId: 'u', role: 'operator', scope: { kind: 'org', organizationId: 'org-y' }, grantedBy: null });
    expect(getUserRoles('u')).toHaveLength(3);

    revokeRole({ userId: 'u', role: 'admin', scope: { kind: 'global' } });

    // global admin gone; the two org-scoped grants SURVIVE (the historical bug
    // would have wiped them because they also have agent_group_id IS NULL).
    expect(isGlobalAdmin('u')).toBe(false);
    expect(isOrgAdmin('u', 'org-x')).toBe(true);
    expect(hasOrgOperabilityRole('u', 'org-y')).toBe(true);
  });

  it('an org revoke removes exactly one org tier and leaves the others intact', () => {
    grantRole({ userId: 'u', role: 'org-admin', scope: { kind: 'org', organizationId: 'org-x' }, grantedBy: null });
    grantRole({ userId: 'u', role: 'org-admin', scope: { kind: 'org', organizationId: 'org-y' }, grantedBy: null });

    revokeRole({ userId: 'u', role: 'org-admin', scope: { kind: 'org', organizationId: 'org-x' } });

    expect(isOrgAdmin('u', 'org-x')).toBe(false);
    expect(isOrgAdmin('u', 'org-y')).toBe(true);
  });

  it('a group revoke matches on group alone and leaves a same-role global grant intact', () => {
    createAgentGroup({ id: 'ag-1', name: 'A1', folder: 'a1', agent_provider: null, created_at: now() });
    grantRole({ userId: 'u', role: 'admin', scope: { kind: 'global' }, grantedBy: null });
    grantRole({ userId: 'u', role: 'admin', scope: { kind: 'group', agentGroupId: 'ag-1' }, grantedBy: null });

    revokeRole({ userId: 'u', role: 'admin', scope: { kind: 'group', agentGroupId: 'ag-1' } });

    expect(isGlobalAdmin('u')).toBe(true); // global survives
    expect(getUserRoles('u')).toHaveLength(1);
  });
});

describe('grant/scope validation + single audited path', () => {
  it('rejects mismatched role/scope pairings', () => {
    expect(() =>
      grantRole({ userId: 'u', role: 'owner', scope: { kind: 'group', agentGroupId: 'ag-1' }, grantedBy: null }),
    ).toThrow();
    expect(() => grantRole({ userId: 'u', role: 'org-admin', scope: { kind: 'global' }, grantedBy: null })).toThrow();
    expect(() =>
      grantRole({ userId: 'u', role: 'admin', scope: { kind: 'org', organizationId: 'org-x' }, grantedBy: null }),
    ).toThrow();
  });

  it('an org-scoped grant rides the SAME audited insert (organizationId in the audit row)', () => {
    seedUser('u-boss');
    grantRole({ userId: 'u', role: 'org-admin', scope: { kind: 'org', organizationId: 'org-x' }, grantedBy: 'u-boss' });
    const row = getDb().prepare("SELECT details FROM enterprise_audit WHERE event_type='user_role_granted'").get() as {
      details: string;
    };
    const details = JSON.parse(row.details);
    expect(details.organizationId).toBe('org-x');
    expect(details.role).toBe('org-admin');
  });
});

describe('fix-1: org-scoped rows must not leak as global', () => {
  it('an org-scoped operator is NOT a global operability holder', () => {
    grantRole({ userId: 'u', role: 'operator', scope: { kind: 'org', organizationId: 'org-x' }, grantedBy: null });
    expect(hasGlobalOperabilityRole('u')).toBe(false);
  });

  it('an org-admin row does not appear in the global-admin list', () => {
    grantRole({ userId: 'u', role: 'org-admin', scope: { kind: 'org', organizationId: 'org-x' }, grantedBy: null });
    expect(isGlobalAdmin('u')).toBe(false);
    expect(getGlobalAdmins()).toHaveLength(0);
  });
});

describe('organizations.ts reads/writes', () => {
  it('createOrganization + slug lookup', () => {
    expect(getOrganizationBySlug('x')?.id).toBe('org-x');
  });

  it('addOrgMember is idempotent; isMemberOfOrg + orgsForUser reflect it', () => {
    addOrgMember('org-x', 'u');
    addOrgMember('org-x', 'u'); // idempotent
    expect(isMemberOfOrg('u', 'org-x')).toBe(true);
    expect(isMemberOfOrg('u', 'org-y')).toBe(false);
    expect(orgsForUser('u')).toEqual(['org-x']);
  });

  it('orgOfAgentGroup derives org from the agent group', () => {
    createAgentGroup({
      id: 'ag-x',
      name: 'AX',
      folder: 'ax',
      agent_provider: null,
      created_at: now(),
      organization_id: 'org-x',
    });
    createAgentGroup({ id: 'ag-legacy', name: 'AL', folder: 'al', agent_provider: null, created_at: now() });
    expect(orgOfAgentGroup('ag-x')).toBe('org-x');
    expect(orgOfAgentGroup('ag-legacy')).toBe(null);
    expect(orgOfAgentGroup('nope')).toBe(null);
  });
});
