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
const { userScopeKey, touchScopeAccess } = await import('./state-scope.js');
const { closeDb, initTestDb, runMigrations } = await import('./db/index.js');
const { createAgentGroup } = await import('./db/agent-groups.js');
const { createSession } = await import('./db/sessions.js');
import type { Session } from './types.js';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 7, 20);

function now(): string {
  return new Date(NOW).toISOString();
}

/** Materialize a scope with content, and set its last-access age in days. */
function seedScope(agentGroupId: string, userId: string, agedDays: number, opts: { marker?: boolean } = {}): string {
  const dir = path.join(SCOPES, agentGroupId, userScopeKey(userId));
  fs.mkdirSync(path.join(dir, 'workspace', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace', 'CLAUDE.local.md'), 'private memory');
  const when = new Date(NOW - agedDays * DAY);
  if (opts.marker !== false) {
    touchScopeAccess(dir);
    fs.utimesSync(path.join(dir, '.last-access'), when, when);
  }
  fs.utimesSync(dir, when, when);
  return dir;
}

function seedOwnedSession(id: string, agentGroupId: string, ownerUserId: string): void {
  createSession({
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: ownerUserId,
    root_session_id: id,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    archived_at: null,
    created_at: now(),
  } as Session);
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(SCOPES, { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
  resetScopeRetentionPolicyLog();
  delete process.env.AGENTDESK_SCOPE_TTL_DAYS;
});

afterEach(() => {
  closeDb();
  delete process.env.AGENTDESK_SCOPE_TTL_DAYS;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('scope retention (ADR-0061)', () => {
  it('is OFF by default — an ancient abandoned scope survives', () => {
    const dir = seedScope('ag-1', 'ou_ghost', 400);

    const r = sweepExpiredScopes(NOW);

    expect(r.removed).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('expires a scope whose last access predates the window', () => {
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '90';
    const stale = seedScope('ag-1', 'ou_ghost', 120);
    const fresh = seedScope('ag-1', 'ou_active', 3);

    const r = sweepExpiredScopes(NOW);

    expect(r.removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('ACCESS refreshes the clock — an old scope used yesterday is not expired', () => {
    // The trap this avoids: an absolute-age clock deletes exactly the
    // memories still in daily use, because those are the oldest ones.
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '90';
    const dir = seedScope('ag-1', 'ou_veteran', 400); // created long ago
    touchScopeAccess(dir); // ...but used just now

    const r = sweepExpiredScopes(NOW);

    expect(r.removed).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('covers data that predates the feature (no marker → directory mtime)', () => {
    // The trap this avoids: a retention knob that only governs data written
    // after it was switched on reports compliance it does not deliver.
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
    const legacy = seedScope('ag-1', 'ou_legacy', 200, { marker: false });
    expect(fs.existsSync(path.join(legacy, '.last-access'))).toBe(false);

    const r = sweepExpiredScopes(NOW);

    expect(r.removed).toBe(1);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('NEVER expires a scope an active session still resolves to, however old', () => {
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
    const dir = seedScope('ag-1', 'ou_live', 500);
    seedOwnedSession('sess-live', 'ag-1', 'ou_live');

    const r = sweepExpiredScopes(NOW);

    expect(r.skippedLive).toBe(1);
    expect(r.removed).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('records an audit row for every expiry', async () => {
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
    seedScope('ag-1', 'ou_ghost', 90);

    sweepExpiredScopes(NOW);

    const { getDb } = await import('./db/connection.js');
    const rows = getDb()
      .prepare("SELECT agent_group_id, details FROM enterprise_audit WHERE event_type = 'scope_retention_expired'")
      .all() as Array<{ agent_group_id: string; details: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_group_id).toBe('ag-1');
    expect(JSON.parse(rows[0].details).retainDays).toBe(30);
  });

  it('sweeps across agent groups and tolerates an unreadable one', () => {
    process.env.AGENTDESK_SCOPE_TTL_DAYS = '30';
    const a = seedScope('ag-1', 'ou_ghost', 90);
    const b = seedScope('ag-2', 'ou_ghost', 90); // orphaned group: no DB row, ages out the same way
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
