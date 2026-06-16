/**
 * Multi-tenant org isolation — runnable demo + integration smoke (ADR-0052).
 *
 *   pnpm exec tsx examples/multi-tenant/demo.ts
 *
 * Sets up a two-tenant topology IN AN IN-MEMORY DB (touches nothing on disk) and
 * prints — and ASSERTS — the host access-gate outcomes, so running it green is a
 * live end-to-end check that org isolation holds. It exercises the real merged
 * code paths (canAccessAgentGroup / canOperate / the org tables), not a mock.
 *
 * The equivalent against a real deployment is the `scripts/org.ts` CLI (see the
 * README in this folder) — this file is the readable, self-checking walkthrough.
 */
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../src/db/index.js';
import { canAccessAgentGroup } from '../../src/modules/permissions/access.js';
import { addMember } from '../../src/modules/permissions/db/agent-group-members.js';
import { addOrgMember, createOrganization } from '../../src/modules/permissions/db/organizations.js';
import { createUser } from '../../src/modules/permissions/db/users.js';
import { grantRole } from '../../src/modules/permissions/db/user-roles.js';
import { canOperate } from '../../src/modules/permissions/operability.js';

function now(): string {
  return new Date().toISOString();
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? '✓' : '✗ FAIL'}  ${label}  → ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`,
  );
}

function reason(d: ReturnType<typeof canAccessAgentGroup>): string {
  return d.allowed ? `allowed:${d.reason}` : `denied:${d.reason}`;
}

function main(): void {
  runMigrations(initTestDb());

  console.log('\nSetting up two tenants (Acme, Globex) + a legacy un-orged group…\n');

  // Tenants
  createOrganization({ id: 'org-acme', name: 'Acme', slug: 'acme', created_at: now() });
  createOrganization({ id: 'org-globex', name: 'Globex', slug: 'globex', created_at: now() });

  // One agent group per tenant + a legacy (no-org) group to show backward-compat.
  createAgentGroup({
    id: 'acme-fd',
    name: 'Acme FD',
    folder: 'acme-fd',
    agent_provider: null,
    created_at: now(),
    organization_id: 'org-acme',
  });
  createAgentGroup({
    id: 'globex-fd',
    name: 'Globex FD',
    folder: 'globex-fd',
    agent_provider: null,
    created_at: now(),
    organization_id: 'org-globex',
  });
  createAgentGroup({
    id: 'legacy-fd',
    name: 'Legacy FD',
    folder: 'legacy-fd',
    agent_provider: null,
    created_at: now(),
  });

  // People
  for (const id of ['alice', 'bob', 'pat', 'opal', 'root']) {
    createUser({ id, kind: 'demo', display_name: id, created_at: now() });
  }
  // alice: a plain member of Acme. bob: a plain member of Globex.
  addOrgMember('org-acme', 'alice');
  addMember({ user_id: 'alice', agent_group_id: 'acme-fd', added_by: null, added_at: now() });
  addOrgMember('org-globex', 'bob');
  addMember({ user_id: 'bob', agent_group_id: 'globex-fd', added_by: null, added_at: now() });
  // pat: org-admin of Acme (must also be an org member). opal: org-scoped operator of Acme.
  addOrgMember('org-acme', 'pat');
  grantRole({
    userId: 'pat',
    role: 'org-admin',
    scope: { kind: 'org', organizationId: 'org-acme' },
    grantedBy: 'root',
  });
  addOrgMember('org-acme', 'opal');
  grantRole({
    userId: 'opal',
    role: 'operator',
    scope: { kind: 'org', organizationId: 'org-acme' },
    grantedBy: 'root',
  });
  // root: the platform owner — above the tenant boundary.
  grantRole({ userId: 'root', role: 'owner', scope: { kind: 'global' }, grantedBy: null });

  console.log('Routing access (canAccessAgentGroup) — the host gate:\n');
  // A tenant member reaches their tenant, never another.
  check('alice → acme-fd  (own tenant)', reason(canAccessAgentGroup('alice', 'acme-fd')), 'allowed:member');
  check(
    'alice → globex-fd (other tenant)',
    reason(canAccessAgentGroup('alice', 'globex-fd')),
    'denied:cross_org_denied',
  );
  check('bob   → globex-fd (own tenant)', reason(canAccessAgentGroup('bob', 'globex-fd')), 'allowed:member');
  check('bob   → acme-fd   (other tenant)', reason(canAccessAgentGroup('bob', 'acme-fd')), 'denied:cross_org_denied');
  // An org-admin administers their org, not another.
  check('pat   → acme-fd   (org-admin)', reason(canAccessAgentGroup('pat', 'acme-fd')), 'allowed:org_admin');
  check('pat   → globex-fd (other tenant)', reason(canAccessAgentGroup('pat', 'globex-fd')), 'denied:cross_org_denied');
  // The platform owner bypasses the tenant boundary by design.
  check('root  → acme-fd   (platform owner)', reason(canAccessAgentGroup('root', 'acme-fd')), 'allowed:owner');
  check('root  → globex-fd (platform owner)', reason(canAccessAgentGroup('root', 'globex-fd')), 'allowed:owner');
  // A legacy un-orged group has no prerequisite — only normal RBAC (here: nobody is a member).
  check(
    'alice → legacy-fd (un-orged, not a member)',
    reason(canAccessAgentGroup('alice', 'legacy-fd')),
    'denied:not_member',
  );

  console.log('\nFleet operability (canOperate) — the read-only triage gate (ADR-0049/0051):\n');
  // An org operator can operate their org's groups only — never another org, never fleet-wide.
  check('opal can operate acme-fd', canOperate('opal', 'acme-fd'), true);
  check('opal can operate globex-fd', canOperate('opal', 'globex-fd'), false);
  check('opal can operate fleet-wide', canOperate('opal'), false);
  check('root can operate fleet-wide', canOperate('root'), true);

  closeDb();
  console.log(
    `\n${failures === 0 ? '✓ All isolation invariants held.' : `✗ ${failures} check(s) FAILED — isolation regressed!`}\n`,
  );
  if (failures > 0) process.exit(1);
}

main();
