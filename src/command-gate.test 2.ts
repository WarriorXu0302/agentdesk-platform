/**
 * Tests for the host-side command gate, with emphasis on the fail-closed
 * admin default (ADR-0019): a missing user_roles table denies admin commands
 * unless the ALLOW_ADMIN_WITHOUT_ROLES escape hatch is set.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Control the escape hatch without touching a real .env on disk. command-gate
// reads it once and caches per-process, so each test resets the module
// registry and re-imports a fresh gate that re-reads this value.
const envValues: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: (keys: string[]) => {
    const out: Record<string, string> = {};
    for (const k of keys) if (envValues[k] !== undefined) out[k] = envValues[k];
    return out;
  },
}));

function chat(text: string) {
  return JSON.stringify({ text });
}

/**
 * Reset module state, then import db + gate fresh so the gate's escape-hatch
 * cache is re-evaluated against the current envValues. `withTable` controls
 * whether the central DB has the user_roles table (i.e. permissions module
 * installed or not).
 */
async function freshGate(opts: { withTable: boolean }) {
  vi.resetModules();
  const db = await import('./db/index.js');
  const conn = db.initTestDb();
  if (opts.withTable) db.runMigrations(conn);
  const { gateCommand } = await import('./command-gate.js');
  return { gateCommand, conn, db };
}

let lastDb: { closeDb: () => void } | null = null;

beforeEach(() => {
  for (const k of Object.keys(envValues)) delete envValues[k];
});

afterEach(() => {
  lastDb?.closeDb();
  lastDb = null;
});

describe('gateCommand admin fail-closed default', () => {
  it('denies admin commands when user_roles table is absent (no permissions module)', async () => {
    const { gateCommand, db } = await freshGate({ withTable: false });
    lastDb = db;

    expect(gateCommand(chat('/clear'), 'user-1', 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
    expect(gateCommand(chat('/compact'), 'user-1', 'ag-1')).toEqual({ action: 'deny', command: '/compact' });
  });

  it('still passes admin commands for an owner row when the table exists', async () => {
    const { gateCommand, conn, db } = await freshGate({ withTable: true });
    lastDb = db;
    seedOwner(conn, 'user-1');

    expect(gateCommand(chat('/clear'), 'user-1', 'ag-1')).toEqual({ action: 'pass' });
    // A sender with no role row is denied even though the table exists.
    expect(gateCommand(chat('/clear'), 'user-2', 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('ALLOW_ADMIN_WITHOUT_ROLES=true restores allow-all when the table is absent', async () => {
    envValues.ALLOW_ADMIN_WITHOUT_ROLES = 'true';
    const { gateCommand, db } = await freshGate({ withTable: false });
    lastDb = db;

    expect(gateCommand(chat('/clear'), 'user-1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('warns exactly once when the escape hatch is engaged', async () => {
    envValues.ALLOW_ADMIN_WITHOUT_ROLES = 'true';
    vi.resetModules();
    const dbMod = await import('./db/index.js');
    dbMod.initTestDb();
    lastDb = dbMod;
    const { log } = await import('./log.js');
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { gateCommand } = await import('./command-gate.js');

    gateCommand(chat('/clear'), 'user-1', 'ag-1');
    gateCommand(chat('/compact'), 'user-2', 'ag-1');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('denies admin commands for an anonymous (null) sender regardless of escape hatch', async () => {
    envValues.ALLOW_ADMIN_WITHOUT_ROLES = 'true';
    const { gateCommand, db } = await freshGate({ withTable: false });
    lastDb = db;

    expect(gateCommand(chat('/clear'), null, 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });
});

describe('gateCommand non-admin classification (unchanged)', () => {
  it('passes normal chat messages', async () => {
    const { gateCommand, db } = await freshGate({ withTable: false });
    lastDb = db;
    expect(gateCommand(chat('hello there'), 'user-1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('silently filters client-only slash commands', async () => {
    const { gateCommand, db } = await freshGate({ withTable: false });
    lastDb = db;
    expect(gateCommand(chat('/help'), 'user-1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('passes unknown slash commands through to the agent', async () => {
    const { gateCommand, db } = await freshGate({ withTable: false });
    lastDb = db;
    expect(gateCommand(chat('/weather tokyo'), 'user-1', 'ag-1')).toEqual({ action: 'pass' });
  });
});

function seedOwner(conn: Database.Database, userId: string) {
  const ts = new Date().toISOString();
  conn
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'test', ?, ?)`)
    .run(userId, userId, ts);
  // granted_by left NULL to avoid a second FK dependency on a granter row.
  conn
    .prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, NULL, ?)`,
    )
    .run(userId, ts);
}
