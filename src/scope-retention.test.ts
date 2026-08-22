import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above imports — the factory must use a LITERAL path.
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-scope-retention/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-scope-retention/groups',
  };
});
const TEST_DIR = '/tmp/nanoclaw-test-scope-retention';
const SCOPES = `${TEST_DIR}/data/v2-scopes`;

const { sweepExpiredScopes, resetScopeRetentionPolicyLog } = await import('./scope-retention.js');
const { SCOPE_ACCESS_MARKER, userScopeKey, touchScopeAccess } = await import('./state-scope.js');
const { closeDb, initTestDb, runMigrations } = await import('./db/index.js');
const { createAgentGroup } = await import('./db/agent-groups.js');
const { createSession } = await import('./db/sessions.js');
import type { Session } from './types.js';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 7, 20);

function iso(agedDays = 0): string {
  return new Date(NOW - agedDays * DAY).toISOString();
}

/**
 * Materialize a scope with real content. NOTE: this deliberately does NOT
 * back-date the scope ROOT directory — the first cut of this feature read the
 * root's mtime as "last access", and a fixture that fakes that property is
 * exactly what let the bug ship. Age is expressed only through the marker
 * (the thing the code actually reads) or through session evidence.
 */
function seedScope(agentGroupId: string, userId: string, opts: { markerAgedDays?: number } = {}): string {
  const dir = path.join(SCOPES, agentGroupId, userScopeKey(userId));
  fs.mkdirSync(path.join(dir, 'workspace', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace', 'CLAUDE.local.md'), 'private memory');
  if (opts.markerAgedDays !== undefined) {
    touchScopeAccess(dir, NOW - opts.markerAgedDays * DAY);
  }
  return dir;
}

function seedSession(args: {
  id: string;
  agentGroupId: string;
  ownerUserId: string;
  status?: Session['status'];
  lastActiveAgedDays?: number;
}): void {
  createSession({
    id: args.id,
    agent_group_id: args.agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: args.ownerUserId,
    root_session_id: args.id,
    agent_provider: null,
    status: args.status ?? 'active',
    container_status: 'stopped',
    last_active: args.lastActiveAgedDays !== undefined ? iso(args.lastActiveAgedDays) : null,
    archived_at: null,
    created_at: iso(500),
  } as Session);
}

function hasMarker(dir: string): boolean {
  return fs.existsSync(path.join(dir, SCOPE_ACCESS_MARKER));
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(SCOPES, { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: iso(500) });
  resetScopeRetentionPolicyLog();
  delete process.env.AGENTDESK_SCOPE_TTL_DAYS;
  delete process.env.AGENTDESK_SCOPE_TTL_DRY_RUN;
});

afterEach(() => {
  closeDb();
  delete process.env.AGENTDESK_SCOPE_TTL_DAYS;
  delete process.env.AGENTDESK_SCOPE_TTL_DRY_RUN;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('scope retention (ADR-0061)', () => {
  it('is OFF by default — an ancient abandoned scope survives', () => {
    const dir = seedScope('ag-1', 'ou_ghost', { markerAgedDays: 400 });

    expect(sweepExpiredScopes(NOW).removed).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('expires a scope whose marker predates the window, keeps a fresh one', () => {
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '90';
    const stale = seedScope('ag-1', 'ou_ghost', { markerAgedDays: 120 });
    const fresh = seedScope('ag-1', 'ou_active', { markerAgedDays: 3 });

    const r = sweepExpiredScopes(NOW);

    expect(r.removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('ACCESS refreshes the clock — a long-lived scope used today is not expired', () => {
    // The trap: an absolute-age clock deletes exactly the memories still in
    // daily use, because those are the oldest ones.
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '90';
    const dir = seedScope('ag-1', 'ou_veteran', { markerAgedDays: 400 });
    touchScopeAccess(dir); // ...used just now

    expect(sweepExpiredScopes(NOW).removed).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  describe('adoption (blocker regression)', () => {
    it('NEVER deletes an unmarked scope on sight — it adopts it', () => {
      // Regression: the first cut fell back to the scope ROOT's mtime, which
      // on POSIX only tracks CREATION (later writes land deeper), so every
      // pre-feature scope read as maximally old and the longest-tenured users
      // were deleted first. Adoption removes the class outright.
      process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
      const dir = seedScope('ag-1', 'ou_legacy'); // no marker at all
      // Make the fixture hostile to the old implementation: the root dir is
      // genuinely old, and nothing has refreshed it.
      const old = new Date(NOW - 400 * DAY);
      fs.utimesSync(dir, old, old);

      const r = sweepExpiredScopes(NOW);

      expect(r.adopted).toBe(1);
      expect(r.removed).toBe(0);
      expect(fs.existsSync(dir)).toBe(true);
      expect(hasMarker(dir)).toBe(true);
    });

    it('adopts at the owner’s real last-use time when a session still knows it', () => {
      process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
      const dir = seedScope('ag-1', 'ou_gone');
      // Archived session: still evidence of when they last used this agent.
      seedSession({
        id: 's-old',
        agentGroupId: 'ag-1',
        ownerUserId: 'ou_gone',
        status: 'archived',
        lastActiveAgedDays: 200,
      });

      const r = sweepExpiredScopes(NOW);

      // Evidence says 200 days idle > 30-day window: adopted AND expired on
      // the same tick — the operator's policy takes effect immediately.
      expect(r.adopted).toBe(1);
      expect(r.removed).toBe(1);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('adopts at NOW when no session evidence remains — one grace window, never instant deletion', () => {
      process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
      const dir = seedScope('ag-1', 'ou_orphan'); // no marker, no sessions

      const first = sweepExpiredScopes(NOW);
      expect(first.adopted).toBe(1);
      expect(first.removed).toBe(0);
      expect(fs.existsSync(dir)).toBe(true);

      // Still inside the window a week later...
      expect(sweepExpiredScopes(NOW + 7 * DAY).removed).toBe(0);
      expect(fs.existsSync(dir)).toBe(true);

      // ...and expired once the adopted stamp itself ages out.
      expect(sweepExpiredScopes(NOW + 31 * DAY).removed).toBe(1);
      expect(fs.existsSync(dir)).toBe(false);
    });
  });

  it('NEVER expires a scope an active session still resolves to, however old', () => {
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
    const dir = seedScope('ag-1', 'ou_live', { markerAgedDays: 500 });
    seedSession({ id: 'sess-live', agentGroupId: 'ag-1', ownerUserId: 'ou_live', lastActiveAgedDays: 500 });

    const r = sweepExpiredScopes(NOW);

    expect(r.skippedLive).toBe(1);
    expect(r.removed).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('dry run reports what would go and deletes nothing', () => {
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
    process.env.AGENTDESK_SCOPE_TTL_DRY_RUN = 'true';
    const dir = seedScope('ag-1', 'ou_ghost', { markerAgedDays: 90 });
    const unmarked = seedScope('ag-1', 'ou_legacy');

    const r = sweepExpiredScopes(NOW);

    expect(r.wouldRemove).toBe(1);
    expect(r.removed).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
    // A preview must not mutate anything — including adoption stamps.
    expect(hasMarker(unmarked)).toBe(false);
  });

  it('writes the audit row BEFORE deleting', async () => {
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
    seedScope('ag-1', 'ou_ghost', { markerAgedDays: 90 });

    sweepExpiredScopes(NOW);

    const { getDb } = await import('./db/connection.js');
    const rows = getDb()
      .prepare("SELECT agent_group_id, details FROM enterprise_audit WHERE event_type = 'scope_retention_expired'")
      .all() as Array<{ agent_group_id: string; details: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_group_id).toBe('ag-1');
    expect(JSON.parse(rows[0].details).retainDays).toBe(30);
  });

  it('a stuck delete audits ONCE, not once per tick', async () => {
    // "Audit before effect" turns a permanently failing rmSync into one
    // governance row per tick unless the pending-delete set dedupes it — and
    // audit purging is opt-in/default-off, so nothing else bounds the growth.
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
    seedScope('ag-1', 'ou_stuck', { markerAgedDays: 90 });
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EACCES: immutable');
    });
    try {
      sweepExpiredScopes(NOW);
      sweepExpiredScopes(NOW);
      sweepExpiredScopes(NOW);
    } finally {
      rmSpy.mockRestore();
    }

    const { getDb } = await import('./db/connection.js');
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM enterprise_audit WHERE event_type = 'scope_retention_expired'")
      .get() as { n: number };
    expect(rows.n).toBe(1); // three ticks, one row

    // Once the obstruction clears, the delete still goes through.
    expect(sweepExpiredScopes(NOW).removed).toBe(1);
  });

  it('sweeps across agent groups and tolerates non-directory clutter', () => {
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
    const a = seedScope('ag-1', 'ou_ghost', { markerAgedDays: 90 });
    // Orphaned group (no DB row): ages out through the same path.
    const b = seedScope('ag-2', 'ou_ghost', { markerAgedDays: 90 });
    fs.writeFileSync(path.join(SCOPES, 'stray-file'), 'not a directory');

    const r = sweepExpiredScopes(NOW);

    expect(r.removed).toBe(2);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
  });

  it('is a no-op when the scope root does not exist yet', () => {
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
    fs.rmSync(SCOPES, { recursive: true });

    expect(() => sweepExpiredScopes(NOW)).not.toThrow();
  });
});
