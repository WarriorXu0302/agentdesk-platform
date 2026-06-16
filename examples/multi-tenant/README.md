# Multi-tenant org isolation (ADR-0052)

A worked walkthrough of running **isolated tenants** on one deployment: a user in
org A cannot reach org B's agent groups, sessions, or triage data. Enforcement is
entirely host-side at the access gate; the backend gateway stays the only path for
business authorization (org never enters it).

## The model

- An **organization** is the tenant boundary. An `agent_group` belongs to at most
  one org (`agent_groups.organization_id`, nullable — `NULL` = legacy / un-orged,
  no tenancy). `organization_members` is *reachability*, never privilege.
- **Roles** (`user_roles`): `owner` / `admin` are platform-global (above tenants);
  `org-admin` administers one org; `operator` / `viewer` are read-only operability
  (the ADR-0049 triage surface), each grantable global / per-group / per-org.
- The gate `canAccessAgentGroup`: `owner` / `global_admin` bypass → **org-membership
  prerequisite** (non-member ⇒ `cross_org_denied`) → `org_admin` / group-admin /
  member. a2a delegation and channel wiring stay within one org; the triage surface
  (`scripts/trace.ts --as`) is org-scoped for a non-global actor.

## Run the demo

```bash
pnpm exec tsx examples/multi-tenant/demo.ts
```

It builds a two-tenant topology **in an in-memory DB** (touches nothing on disk),
then prints — and asserts — the access outcomes (a member reaches only their org,
an org-admin only their org, the platform owner everywhere, a legacy un-orged group
under plain RBAC). Green exit = isolation holds against the real merged code.

## Set it up on a real deployment

Use the operator CLI `scripts/org.ts` against the live central DB:

```bash
pnpm exec tsx scripts/org.ts create acme "Acme Inc"           # → org id 'org-acme'
pnpm exec tsx scripts/org.ts assign <agentGroupId> acme        # tag a group into the org
#   ^ auto-enrolls the group's current members + admins so nobody is locked out
pnpm exec tsx scripts/org.ts grant-admin feishu:ou_alice acme  # delegate org-admin (also enrolls as member)
pnpm exec tsx scripts/org.ts add-member feishu:ou_bob acme     # plain reachability
pnpm exec tsx scripts/org.ts list
```

Triage one org's fleet (org-scoped for a non-global actor):

```bash
pnpm exec tsx scripts/trace.ts --as feishu:ou_alice --status active
```

## Backward compatibility

A deployment that creates **no** organizations behaves exactly as before: every
`agent_group` stays `NULL`-org, the gate applies no org prerequisite, and access is
the original owner / admin / member RBAC. Migration 035 only materializes an
`org-default` (and enrolls every reachable user into it) if the deployment already
has workload — so an upgrade locks nobody out.

See [docs/isolation-model.md](../../docs/isolation-model.md#organization-tenancy-adr-0052)
and [docs/enterprise-multi-user.md](../../docs/enterprise-multi-user.md) for the
full model + the access-evaluation / revocation-timing semantics.
