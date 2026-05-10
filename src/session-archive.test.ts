import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpState: { root: string } = { root: '' };

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    get DATA_DIR(): string {
      return path.join(tmpState.root, 'data');
    },
    get GROUPS_DIR(): string {
      return path.join(tmpState.root, 'groups');
    },
  };
});

const { closeDb, initTestDb, runMigrations } = await import('./db/index.js');
const { createAgentGroup } = await import('./db/agent-groups.js');
const { createSession, getSession, getSessionsByAgentGroup, updateSession } = await import('./db/sessions.js');
const { sessionDir } = await import('./session-manager.js');
const { archiveSession, hardDeleteArchivedSession, runSessionLifecycleSweep } = await import('./session-archive.js');

function now(): string {
  return new Date().toISOString();
}

function seedSession(args: {
  id: string;
  agentGroupId: string;
  lastActive?: string | null;
  containerStatus?: 'running' | 'idle' | 'stopped';
  status?: 'active' | 'archived' | 'closed';
  archivedAt?: string | null;
}): void {
  createSession({
    id: args.id,
    agent_group_id: args.agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: null,
    root_session_id: args.id,
    agent_provider: null,
    status: args.status ?? 'active',
    container_status: args.containerStatus ?? 'stopped',
    last_active: args.lastActive ?? null,
    archived_at: args.archivedAt ?? null,
    created_at: now(),
  });
  // drop some dummy content in the session dir so tar has something to capture
  const dir = sessionDir(args.agentGroupId, args.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'inbound.db'), 'fake-sqlite');
  fs.writeFileSync(path.join(dir, 'outbound.db'), 'fake-sqlite');
}

beforeEach(() => {
  tmpState.root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontlane-session-archive-'));
  fs.mkdirSync(path.join(tmpState.root, 'data'), { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'A1', folder: 'ag-1', agent_provider: null, created_at: now() });
});

afterEach(() => {
  closeDb();
  delete process.env.FRONTLANE_SESSION_TTL_DAYS;
  delete process.env.FRONTLANE_ARCHIVE_HARD_DELETE_DAYS;
  if (fs.existsSync(tmpState.root)) fs.rmSync(tmpState.root, { recursive: true, force: true });
});

describe('archiveSession', () => {
  it('tars the session dir, removes the source, and flips status', async () => {
    seedSession({ id: 's1', agentGroupId: 'ag-1' });
    const src = sessionDir('ag-1', 's1');
    expect(fs.existsSync(src)).toBe(true);

    await archiveSession(getSession('s1')!);

    expect(fs.existsSync(src)).toBe(false);
    const archivePath = path.join(tmpState.root, 'data', 'v2-sessions-archive', 'ag-1', 's1.tar.gz');
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(getSession('s1')!.status).toBe('archived');
  });

  it('is idempotent-ish: missing source dir does not throw, status still flips', async () => {
    seedSession({ id: 's1', agentGroupId: 'ag-1' });
    fs.rmSync(sessionDir('ag-1', 's1'), { recursive: true, force: true });

    const ok = await archiveSession(getSession('s1')!);
    expect(ok).toBe(true);
    expect(getSession('s1')!.status).toBe('archived');
  });
});

describe('hardDeleteArchivedSession', () => {
  it('removes tarball and DB row', async () => {
    seedSession({ id: 's1', agentGroupId: 'ag-1' });
    await archiveSession(getSession('s1')!);

    const archivePath = path.join(tmpState.root, 'data', 'v2-sessions-archive', 'ag-1', 's1.tar.gz');
    expect(fs.existsSync(archivePath)).toBe(true);

    hardDeleteArchivedSession(getSession('s1')!);

    expect(fs.existsSync(archivePath)).toBe(false);
    expect(getSession('s1')).toBeUndefined();
  });
});

describe('runSessionLifecycleSweep', () => {
  it('is a no-op when FRONTLANE_SESSION_TTL_DAYS is unset', async () => {
    const old = new Date(Date.now() - 365 * 86_400_000).toISOString();
    seedSession({ id: 's1', agentGroupId: 'ag-1', lastActive: old });

    const result = await runSessionLifecycleSweep();
    expect(result.archived).toBe(0);
    expect(getSession('s1')!.status).toBe('active');
  });

  it('archives sessions past the TTL window', async () => {
    process.env.FRONTLANE_SESSION_TTL_DAYS = '7';
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    seedSession({ id: 's-old', agentGroupId: 'ag-1', lastActive: old });
    seedSession({ id: 's-new', agentGroupId: 'ag-1', lastActive: now() });

    const result = await runSessionLifecycleSweep();
    expect(result.archived).toBe(1);
    expect(getSession('s-old')!.status).toBe('archived');
    expect(getSession('s-new')!.status).toBe('active');
  });

  it('does not archive sessions whose container is still running', async () => {
    process.env.FRONTLANE_SESSION_TTL_DAYS = '1';
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    seedSession({ id: 's-alive', agentGroupId: 'ag-1', lastActive: old, containerStatus: 'running' });

    const result = await runSessionLifecycleSweep();
    expect(result.archived).toBe(0);
    expect(getSession('s-alive')!.status).toBe('active');
  });

  it('does not archive sessions with null last_active', async () => {
    process.env.FRONTLANE_SESSION_TTL_DAYS = '1';
    seedSession({ id: 's-fresh', agentGroupId: 'ag-1', lastActive: null });

    const result = await runSessionLifecycleSweep();
    expect(result.archived).toBe(0);
  });

  it('does NOT hard-delete a session the same tick it was archived', async () => {
    // An ancient-but-only-just-archived session must get the full
    // FRONTLANE_ARCHIVE_HARD_DELETE_DAYS retention window starting from
    // archive time — not immediately unlinked because its last_active is
    // already older than the hard-delete threshold. This is the bug the
    // `archived_at` column fixes.
    process.env.FRONTLANE_SESSION_TTL_DAYS = '7';
    process.env.FRONTLANE_ARCHIVE_HARD_DELETE_DAYS = '30';
    const ancient = new Date(Date.now() - 365 * 86_400_000).toISOString();

    seedSession({ id: 's-old', agentGroupId: 'ag-1', lastActive: ancient });

    const result = await runSessionLifecycleSweep();
    expect(result.archived).toBe(1);
    expect(result.hardDeleted).toBe(0);
    const row = getSession('s-old')!;
    expect(row.status).toBe('archived');
    expect(row.archived_at).toBeTruthy();
  });

  it('hard-deletes archived sessions once their retention window elapses', async () => {
    process.env.FRONTLANE_SESSION_TTL_DAYS = '7';
    process.env.FRONTLANE_ARCHIVE_HARD_DELETE_DAYS = '30';

    // Seed a row already in the archived state with an archived_at that's
    // older than the retention window. Simulates a session archived by a
    // past sweep tick.
    const archivedAt = new Date(Date.now() - 60 * 86_400_000).toISOString();
    seedSession({
      id: 's-old-archived',
      agentGroupId: 'ag-1',
      status: 'archived',
      lastActive: archivedAt,
      archivedAt,
    });

    const result = await runSessionLifecycleSweep();
    expect(result.hardDeleted).toBe(1);
    expect(getSession('s-old-archived')).toBeUndefined();
  });

  it('does NOT hard-delete an archived session whose retention window has not elapsed', async () => {
    process.env.FRONTLANE_SESSION_TTL_DAYS = '7';
    process.env.FRONTLANE_ARCHIVE_HARD_DELETE_DAYS = '30';

    const archivedAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
    seedSession({
      id: 's-recent-archived',
      agentGroupId: 'ag-1',
      status: 'archived',
      lastActive: archivedAt,
      archivedAt,
    });

    const result = await runSessionLifecycleSweep();
    expect(result.hardDeleted).toBe(0);
    expect(getSession('s-recent-archived')).toBeDefined();
  });

  it('reports counts for the sweep result', async () => {
    process.env.FRONTLANE_SESSION_TTL_DAYS = '1';
    seedSession({ id: 's-archive-me', agentGroupId: 'ag-1', lastActive: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    seedSession({ id: 's-keep', agentGroupId: 'ag-1', lastActive: now() });

    const result = await runSessionLifecycleSweep();
    expect(result.archived).toBe(1);
    expect(result.activeCount).toBe(2); // snapshot taken before the archive step
  });

  it('handles an empty session table', async () => {
    process.env.FRONTLANE_SESSION_TTL_DAYS = '7';
    const result = await runSessionLifecycleSweep();
    expect(result.archived).toBe(0);
    expect(result.activeCount).toBe(0);
    expect(result.archivedCount).toBe(0);
  });

  it('caps per-tick work to the batch limit', async () => {
    process.env.FRONTLANE_SESSION_TTL_DAYS = '1';
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    // Seed 150 — larger than ARCHIVE_BATCH_LIMIT (100).
    for (let i = 0; i < 150; i++) {
      seedSession({ id: `s-${i}`, agentGroupId: 'ag-1', lastActive: old });
    }
    const result = await runSessionLifecycleSweep();
    expect(result.archived).toBe(100);
    expect(getSessionsByAgentGroup('ag-1').filter((s) => s.status === 'active')).toHaveLength(50);
  });
});
