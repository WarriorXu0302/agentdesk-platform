/**
 * Organization (tenant) admin CLI (ADR-0052 Stage C) — set up and manage the
 * multi-tenant org boundary on a single-machine deployment.
 *
 *   pnpm exec tsx scripts/org.ts list
 *   pnpm exec tsx scripts/org.ts create acme "Acme Inc"          # → org id 'org-acme'
 *   pnpm exec tsx scripts/org.ts assign <agentGroupId> acme       # tag a group into the org (auto-enrolls its members)
 *   pnpm exec tsx scripts/org.ts add-member feishu:ou_x acme      # reachability (not privilege)
 *   pnpm exec tsx scripts/org.ts remove-member feishu:ou_x acme
 *   pnpm exec tsx scripts/org.ts grant-admin feishu:ou_x acme     # org-admin (also enrolls as member)
 *   pnpm exec tsx scripts/org.ts revoke-admin feishu:ou_x acme
 *
 * A deliberately FOCUSED tool (cf. scripts/trace.ts) rather than threading org
 * flags through the 753-line init-enterprise-topology.ts. Read-modify on the
 * operator-owned central DB; access is gated by who can run it. The underlying
 * db functions are the audited source of truth (enterprise_audit).
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { getAllAgentGroups, getAgentGroup } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import {
  addOrgMember,
  assignAgentGroupToOrg,
  createOrganization,
  getAllOrganizations,
  getOrganizationBySlug,
  orgsForUser,
  removeOrgMember,
} from '../src/modules/permissions/db/organizations.js';
import { grantRole, revokeRole } from '../src/modules/permissions/db/user-roles.js';

function now(): string {
  return new Date().toISOString();
}

function usage(): never {
  console.error(
    [
      'Usage:',
      '  org.ts list',
      '  org.ts create <slug> <name>',
      '  org.ts assign <agentGroupId> <slug>',
      '  org.ts add-member <userId> <slug>',
      '  org.ts remove-member <userId> <slug>',
      '  org.ts grant-admin <userId> <slug>',
      '  org.ts revoke-admin <userId> <slug>',
    ].join('\n'),
  );
  process.exit(1);
}

/** Resolve a slug to an org id, or exit with a clear error. */
function orgIdOrExit(slug: string): string {
  const org = getOrganizationBySlug(slug);
  if (!org) {
    console.error(`no organization with slug '${slug}' (create it: org.ts create ${slug} "<name>")`);
    process.exit(1);
  }
  return org.id;
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  switch (cmd) {
    case 'list': {
      const groups = getAllAgentGroups();
      for (const org of getAllOrganizations()) {
        const inOrg = groups.filter((g) => g.organization_id === org.id).map((g) => g.id);
        console.log(`${org.slug}  (${org.id})  "${org.name}"  groups=${inOrg.length}`);
        for (const g of inOrg) console.log(`    - ${g}`);
      }
      const ungrouped = groups.filter((g) => !g.organization_id).map((g) => g.id);
      if (ungrouped.length) console.log(`(no org / legacy)  groups=${ungrouped.length}: ${ungrouped.join(', ')}`);
      return;
    }
    case 'create': {
      const [slug, name] = rest;
      if (!slug || !name) usage();
      if (getOrganizationBySlug(slug)) {
        console.error(`organization '${slug}' already exists`);
        process.exit(1);
      }
      const id = `org-${slug}`;
      createOrganization({ id, name, slug, created_at: now() });
      console.log(`created ${slug} (${id})`);
      return;
    }
    case 'assign': {
      const [agentGroupId, slug] = rest;
      if (!agentGroupId || !slug) usage();
      if (!getAgentGroup(agentGroupId)) {
        console.error(`no agent group '${agentGroupId}'`);
        process.exit(1);
      }
      const orgId = orgIdOrExit(slug);
      const enrolled = assignAgentGroupToOrg(agentGroupId, orgId, null);
      console.log(`assigned ${agentGroupId} → ${slug}; auto-enrolled ${enrolled} existing principal(s)`);
      return;
    }
    case 'add-member': {
      const [userId, slug] = rest;
      if (!userId || !slug) usage();
      addOrgMember(orgIdOrExit(slug), userId, null);
      console.log(`added ${userId} to ${slug}`);
      return;
    }
    case 'remove-member': {
      const [userId, slug] = rest;
      if (!userId || !slug) usage();
      removeOrgMember(orgIdOrExit(slug), userId, null);
      console.log(`removed ${userId} from ${slug}`);
      return;
    }
    case 'grant-admin': {
      const [userId, slug] = rest;
      if (!userId || !slug) usage();
      const orgId = orgIdOrExit(slug);
      // org-admin must also be a member, else the org prerequisite denies them.
      addOrgMember(orgId, userId, null);
      grantRole({ userId, role: 'org-admin', scope: { kind: 'org', organizationId: orgId }, grantedBy: null });
      console.log(`granted org-admin on ${slug} to ${userId} (and enrolled as member)`);
      return;
    }
    case 'revoke-admin': {
      const [userId, slug] = rest;
      if (!userId || !slug) usage();
      const orgId = orgIdOrExit(slug);
      revokeRole({ userId, role: 'org-admin', scope: { kind: 'org', organizationId: orgId } });
      console.log(
        `revoked org-admin on ${slug} from ${userId} (membership left intact — remove-member to fully detach)`,
      );
      // Surface remaining org context for the operator.
      console.log(`  ${userId} now in orgs: ${orgsForUser(userId).join(', ') || '(none)'}`);
      return;
    }
    default:
      usage();
  }
}

main();
