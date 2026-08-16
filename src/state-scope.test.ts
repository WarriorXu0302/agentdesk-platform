import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: vi.mock is hoisted above imports + consts, so the factory must use a
// LITERAL path (it cannot reference TEST_DIR). Keep the two in sync.
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-state-scope/groups',
    DATA_DIR: '/tmp/nanoclaw-test-state-scope/data',
  };
});
const TEST_DIR = '/tmp/nanoclaw-test-state-scope';

const { ensureStateScope, resolveStateScope, userScopeKey } = await import('./state-scope.js');
const { buildMounts } = await import('./container-runner.js');
import type { AgentGroup, Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

const CFG = { skills: [], mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [] };

const AG: AgentGroup = {
  id: 'ag-fd',
  name: 'Frontdesk',
  folder: 'fd',
  agent_provider: null,
  created_at: now(),
  organization_id: null,
};

function makeSession(args: { id: string; ownerUserId?: string | null; messagingGroupId?: string | null }): Session {
  return {
    id: args.id,
    agent_group_id: AG.id,
    messaging_group_id: args.messagingGroupId ?? null,
    thread_id: null,
    owner_user_id: args.ownerUserId ?? null,
    root_session_id: args.id,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    archived_at: null,
    created_at: now(),
  } as Session;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(`${TEST_DIR}/groups`, { recursive: true });
  fs.mkdirSync(`${TEST_DIR}/data`, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('resolveStateScope (ADR-0055)', () => {
  it('ownerless session → legacy group scope, byte-for-byte the historical paths', () => {
    const scope = resolveStateScope(AG, makeSession({ id: 's1' }));
    expect(scope.kind).toBe('group');
    expect(scope.workspaceDir).toBe(`${TEST_DIR}/groups/fd`);
    expect(scope.claudeDir).toBe(`${TEST_DIR}/data/v2-sessions/ag-fd/.claude-shared`);
  });

  it('owned session → per-user scope under v2-scopes', () => {
    const scope = resolveStateScope(AG, makeSession({ id: 's1', ownerUserId: 'ou_alice' }));
    expect(scope.kind).toBe('user');
    const key = userScopeKey('ou_alice');
    expect(scope.workspaceDir).toBe(`${TEST_DIR}/data/v2-scopes/ag-fd/${key}/workspace`);
    expect(scope.claudeDir).toBe(`${TEST_DIR}/data/v2-scopes/ag-fd/${key}/claude`);
  });

  it('same user across sessions and messaging groups shares ONE scope; users differ', () => {
    // The personal-agent property: memory follows the person, not the chat room.
    const a1 = resolveStateScope(AG, makeSession({ id: 's1', ownerUserId: 'ou_alice', messagingGroupId: 'mg-1' }));
    const a2 = resolveStateScope(AG, makeSession({ id: 's2', ownerUserId: 'ou_alice', messagingGroupId: 'mg-2' }));
    const b = resolveStateScope(AG, makeSession({ id: 's3', ownerUserId: 'ou_bob', messagingGroupId: 'mg-1' }));
    expect(a1.workspaceDir).toBe(a2.workspaceDir);
    expect(a1.workspaceDir).not.toBe(b.workspaceDir);
  });

  it('user ids that slugify identically still get DISTINCT scopes (fingerprint)', () => {
    expect(userScopeKey('ou.alice')).not.toBe(userScopeKey('ou_alice'));
    expect(userScopeKey('ou.alice')).toMatch(/^u-ou-alice-[0-9a-f]{8}$/);
  });
});

describe('ensureStateScope (ADR-0055)', () => {
  it('materializes a user scope: memory seed, conversations/, shared-base link, claude state', () => {
    const scope = resolveStateScope(AG, makeSession({ id: 's1', ownerUserId: 'ou_alice' }));
    ensureStateScope(scope, { disableAutoMemory: false });

    expect(fs.readFileSync(path.join(scope.workspaceDir, 'CLAUDE.local.md'), 'utf8')).toBe('');
    expect(fs.statSync(path.join(scope.workspaceDir, 'conversations')).isDirectory()).toBe(true);
    // the composed CLAUDE.md (RO-mounted from the group dir) imports
    // @./.claude-shared.md relative to /workspace/agent — the scope must carry it
    expect(fs.readlinkSync(path.join(scope.workspaceDir, '.claude-shared.md'))).toBe('/app/CLAUDE.md');
    const settings = JSON.parse(fs.readFileSync(path.join(scope.claudeDir, 'settings.json'), 'utf8'));
    expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
    expect(fs.statSync(path.join(scope.claudeDir, 'skills')).isDirectory()).toBe(true);
  });

  it('is idempotent and never clobbers agent-written memory', () => {
    const scope = resolveStateScope(AG, makeSession({ id: 's1', ownerUserId: 'ou_alice' }));
    ensureStateScope(scope, { disableAutoMemory: false });
    fs.writeFileSync(path.join(scope.workspaceDir, 'CLAUDE.local.md'), 'alice prefers protocol X\n');
    ensureStateScope(scope, { disableAutoMemory: false });
    expect(fs.readFileSync(path.join(scope.workspaceDir, 'CLAUDE.local.md'), 'utf8')).toBe(
      'alice prefers protocol X\n',
    );
  });

  it('gateway memoryMode disables Claude auto-memory in the scope settings', () => {
    const scope = resolveStateScope(AG, makeSession({ id: 's1', ownerUserId: 'ou_alice' }));
    ensureStateScope(scope, { disableAutoMemory: true });
    const settings = JSON.parse(fs.readFileSync(path.join(scope.claudeDir, 'settings.json'), 'utf8'));
    expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  it('group scope is a no-op (initGroupFilesystem owns that layout)', () => {
    const scope = resolveStateScope(AG, makeSession({ id: 's1' }));
    ensureStateScope(scope, { disableAutoMemory: false });
    expect(fs.existsSync(scope.workspaceDir)).toBe(false); // untouched
  });
});

describe('buildMounts × state scope (ADR-0055)', () => {
  function mountFor(mounts: { hostPath: string; containerPath: string; readonly: boolean }[], containerPath: string) {
    return mounts.find((m) => m.containerPath === containerPath);
  }

  it('ownerless session mounts the legacy group layout unchanged', () => {
    const mounts = buildMounts(AG, makeSession({ id: 's1' }), CFG, {});
    expect(mountFor(mounts, '/workspace/agent')).toMatchObject({
      hostPath: `${TEST_DIR}/groups/fd`,
      readonly: false,
    });
    expect(mountFor(mounts, '/home/node/.claude')).toMatchObject({
      hostPath: `${TEST_DIR}/data/v2-sessions/ag-fd/.claude-shared`,
      readonly: false,
    });
  });

  it('owned session mounts the per-user scope; config stays group-level and read-only', () => {
    const mounts = buildMounts(AG, makeSession({ id: 's1', ownerUserId: 'ou_alice' }), CFG, {});
    const key = userScopeKey('ou_alice');

    expect(mountFor(mounts, '/workspace/agent')).toMatchObject({
      hostPath: `${TEST_DIR}/data/v2-scopes/ag-fd/${key}/workspace`,
      readonly: false,
    });
    expect(mountFor(mounts, '/home/node/.claude')).toMatchObject({
      hostPath: `${TEST_DIR}/data/v2-scopes/ag-fd/${key}/claude`,
      readonly: false,
    });
    // template layer shadows the scope at the same container paths, read-only,
    // and keeps coming from the GROUP dir
    expect(mountFor(mounts, '/workspace/agent/container.json')).toMatchObject({
      hostPath: `${TEST_DIR}/groups/fd/container.json`,
      readonly: true,
    });
    expect(mountFor(mounts, '/workspace/agent/CLAUDE.md')).toMatchObject({
      hostPath: `${TEST_DIR}/groups/fd/CLAUDE.md`,
      readonly: true,
    });
    // and the scope was materialized on disk before docker would bind it
    expect(fs.existsSync(`${TEST_DIR}/data/v2-scopes/ag-fd/${key}/workspace/CLAUDE.local.md`)).toBe(true);
  });

  it('two owners of one agent group get disjoint writable state', () => {
    const a = buildMounts(AG, makeSession({ id: 's1', ownerUserId: 'ou_alice' }), CFG, {});
    const b = buildMounts(AG, makeSession({ id: 's2', ownerUserId: 'ou_bob' }), CFG, {});
    expect(mountFor(a, '/workspace/agent')!.hostPath).not.toBe(mountFor(b, '/workspace/agent')!.hostPath);
    expect(mountFor(a, '/home/node/.claude')!.hostPath).not.toBe(mountFor(b, '/home/node/.claude')!.hostPath);
  });
});
