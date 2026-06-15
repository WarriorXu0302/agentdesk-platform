/**
 * Operability roles (ADR-0051): operator/viewer + canOperate.
 *
 * These tests pin the three load-bearing boundaries of the design:
 *   1. operator/viewer are NOT routing grants (canAccessAgentGroup denies them
 *      with the explicit `operability_only` reason, NOT `member`).
 *   2. operator/viewer do NOT confer admin power (hasAdminPrivilege stays false)
 *      — preserves the ADR-0045 approval-card anti-forgery surface.
 *   3. revoking 'admin' must NOT collaterally remove operator/viewer grants.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { canAccessAgentGroup } from './access.js';
import { addMember } from './db/agent-group-members.js';
import { createUser } from './db/users.js';
import { getOperators, getViewers, hasAdminPrivilege, grantRole, revokeRole } from './db/user-roles.js';
import { canOperate } from './operability.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: now() });
}

function seedUser(id: string): void {
  createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

beforeEach(() => {
  runMigrations(initTestDb());
  seedAgentGroup('ag-1');
  seedAgentGroup('ag-2');
});

afterEach(() => {
  closeDb();
});

describe('operability roles are NOT routing grants (ADR-0051)', () => {
  it('a user holding only global operator/viewer is denied routing with operability_only', () => {
    seedUser('u-op');
    grantRole({ userId: 'u-op', role: 'operator', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    const d = canAccessAgentGroup('u-op', 'ag-1');
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('operability_only');

    seedUser('u-vw');
    grantRole({
      userId: 'u-vw',
      role: 'viewer',
      scope: { kind: 'group', agentGroupId: 'ag-1' },
      grantedBy: null,
      grantedAt: now(),
    });
    expect(canAccessAgentGroup('u-vw', 'ag-1').allowed).toBe(false);
    expect((canAccessAgentGroup('u-vw', 'ag-1') as { reason: string }).reason).toBe('operability_only');
    // scoped to ag-1 only → ag-2 falls through to the plain not_member denial
    expect((canAccessAgentGroup('u-vw', 'ag-2') as { reason: string }).reason).toBe('not_member');
  });

  it('an operator who is ALSO a member still routes via the member tier (orthogonality)', () => {
    seedUser('u-both');
    grantRole({ userId: 'u-both', role: 'operator', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    addMember({ user_id: 'u-both', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    const d = canAccessAgentGroup('u-both', 'ag-1');
    expect(d.allowed).toBe(true);
    expect(d.allowed === true && d.reason).toBe('member');
  });
});

describe('operability roles do NOT confer admin power (ADR-0045 guard)', () => {
  it('operator/viewer never satisfy hasAdminPrivilege', () => {
    seedUser('u-op');
    grantRole({
      userId: 'u-op',
      role: 'operator',
      scope: { kind: 'group', agentGroupId: 'ag-1' },
      grantedBy: null,
      grantedAt: now(),
    });
    seedUser('u-vw');
    grantRole({ userId: 'u-vw', role: 'viewer', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    expect(hasAdminPrivilege('u-op', 'ag-1')).toBe(false);
    expect(hasAdminPrivilege('u-vw', 'ag-1')).toBe(false);
  });
});

describe('canOperate (ADR-0051 in-band operator-surface gate)', () => {
  it('unknown user cannot operate', () => {
    expect(canOperate('ghost')).toBe(false);
  });

  it('owner / global-admin operate fleet-wide', () => {
    seedUser('u-owner');
    grantRole({ userId: 'u-owner', role: 'owner', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    seedUser('u-ga');
    grantRole({ userId: 'u-ga', role: 'admin', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    expect(canOperate('u-owner')).toBe(true);
    expect(canOperate('u-ga', 'ag-1')).toBe(true);
  });

  it('global operator/viewer operate fleet-wide', () => {
    seedUser('u-op');
    grantRole({ userId: 'u-op', role: 'operator', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    seedUser('u-vw');
    grantRole({ userId: 'u-vw', role: 'viewer', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    expect(canOperate('u-op')).toBe(true);
    expect(canOperate('u-vw')).toBe(true);
  });

  it('scoped operator/viewer/admin operate only their group, not fleet-wide', () => {
    seedUser('u-sop');
    grantRole({
      userId: 'u-sop',
      role: 'operator',
      scope: { kind: 'group', agentGroupId: 'ag-1' },
      grantedBy: null,
      grantedAt: now(),
    });
    expect(canOperate('u-sop', 'ag-1')).toBe(true);
    expect(canOperate('u-sop', 'ag-2')).toBe(false);
    expect(canOperate('u-sop')).toBe(false); // fleet-wide query → denied

    seedUser('u-sa');
    grantRole({
      userId: 'u-sa',
      role: 'admin',
      scope: { kind: 'group', agentGroupId: 'ag-2' },
      grantedBy: null,
      grantedAt: now(),
    });
    expect(canOperate('u-sa', 'ag-2')).toBe(true);
    expect(canOperate('u-sa', 'ag-1')).toBe(false);
  });

  it('a known user with no role cannot operate', () => {
    seedUser('u-plain');
    addMember({ user_id: 'u-plain', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    expect(canOperate('u-plain', 'ag-1')).toBe(false);
  });
});

describe('role getters + revoke isolation', () => {
  it('getOperators/getViewers list only global grants of that kind', () => {
    seedUser('u-op');
    grantRole({ userId: 'u-op', role: 'operator', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    seedUser('u-vw');
    grantRole({ userId: 'u-vw', role: 'viewer', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    // a scoped operator must NOT appear in the global list
    seedUser('u-sop');
    grantRole({
      userId: 'u-sop',
      role: 'operator',
      scope: { kind: 'group', agentGroupId: 'ag-1' },
      grantedBy: null,
      grantedAt: now(),
    });
    expect(getOperators().map((r) => r.user_id)).toEqual(['u-op']);
    expect(getViewers().map((r) => r.user_id)).toEqual(['u-vw']);
  });

  it('revoking admin does NOT remove an operator/viewer grant for the same user', () => {
    seedUser('u-multi');
    grantRole({ userId: 'u-multi', role: 'admin', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    grantRole({ userId: 'u-multi', role: 'operator', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    revokeRole({ userId: 'u-multi', role: 'admin', scope: { kind: 'global' } });
    // operator survives → can still operate fleet-wide
    expect(canOperate('u-multi')).toBe(true);
    expect(getOperators().map((r) => r.user_id)).toEqual(['u-multi']);
  });
});
