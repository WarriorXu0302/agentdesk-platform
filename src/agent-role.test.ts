import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: vi.mock is hoisted above imports + consts, so the factory must use a
// LITERAL path (it cannot reference TEST_DIR). Keep the two in sync.
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-agent-role/groups',
    DATA_DIR: '/tmp/nanoclaw-test-agent-role/data',
  };
});
const TEST_DIR = '/tmp/nanoclaw-test-agent-role';

const { buildMounts } = await import('./container-runner.js');
const { closeDb, initTestDb, runMigrations } = await import('./db/index.js');
const { createAgentGroup, getAgentGroup, setAgentGroupRole } = await import('./db/agent-groups.js');
import type { AgentGroup, Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

const CFG = { skills: [], mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [] };

const ROUTING_CFG = {
  ...CFG,
  llm: {
    routing: { enabled: true, provider: 'openai', model: 'm', promptFile: 'prompts/frontdesk-routing.md' },
  },
} as Parameters<typeof buildMounts>[2];

function makeGroup(role: AgentGroup['role']): AgentGroup {
  return {
    id: 'ag-fd',
    name: 'Frontdesk',
    folder: 'fd',
    agent_provider: null,
    created_at: now(),
    organization_id: null,
    role,
  };
}

function makeSession(id: string): Session {
  return {
    id,
    agent_group_id: 'ag-fd',
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: null,
    root_session_id: id,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    archived_at: null,
    created_at: now(),
  } as Session;
}

function seedRoutingPrompt(): void {
  fs.mkdirSync(`${TEST_DIR}/groups/fd/prompts`, { recursive: true });
  fs.writeFileSync(`${TEST_DIR}/groups/fd/prompts/frontdesk-routing.md`, 'route');
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(`${TEST_DIR}/groups`, { recursive: true });
  fs.mkdirSync(`${TEST_DIR}/data`, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('agent_groups.role column (ADR-0056)', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
  });
  afterEach(() => {
    closeDb();
  });

  it('role round-trips through create + get, and NULL stays the default', () => {
    createAgentGroup({ id: 'ag-w', name: 'W', folder: 'w', agent_provider: null, created_at: now(), role: 'worker' });
    createAgentGroup({ id: 'ag-x', name: 'X', folder: 'x', agent_provider: null, created_at: now() });
    expect(getAgentGroup('ag-w')!.role).toBe('worker');
    expect(getAgentGroup('ag-x')!.role).toBeNull();
  });

  it('setAgentGroupRole stamps and re-stamps (idempotent topology authority)', () => {
    createAgentGroup({ id: 'ag-x', name: 'X', folder: 'x', agent_provider: null, created_at: now() });
    setAgentGroupRole('ag-x', 'frontdesk');
    expect(getAgentGroup('ag-x')!.role).toBe('frontdesk');
    setAgentGroupRole('ag-x', 'worker');
    expect(getAgentGroup('ag-x')!.role).toBe('worker');
  });
});

describe('role × routing contradiction gate (ADR-0056)', () => {
  it('refuses to build mounts for a WORKER with enforced routing', () => {
    seedRoutingPrompt();
    expect(() => buildMounts(makeGroup('worker'), makeSession('s1'), ROUTING_CFG, {})).toThrow(/role=worker/);
  });

  it('NULL role (legacy/unclassified) + routing stays permitted', () => {
    seedRoutingPrompt();
    const mounts = buildMounts(makeGroup(null), makeSession('s1'), ROUTING_CFG, {});
    expect(mounts.find((m) => m.containerPath === '/workspace/agent/prompts/frontdesk-routing.md')).toBeDefined();
  });

  it('frontdesk + routing is the intended configuration', () => {
    seedRoutingPrompt();
    expect(() => buildMounts(makeGroup('frontdesk'), makeSession('s1'), ROUTING_CFG, {})).not.toThrow();
  });

  it('worker WITHOUT routing is unaffected by the gate', () => {
    expect(() => buildMounts(makeGroup('worker'), makeSession('s1'), CFG, {})).not.toThrow();
  });
});

describe('template prompts/ hardening (ADR-0056)', () => {
  it('prompts/ is RO-shadowed whenever it exists — routing or not', () => {
    seedRoutingPrompt();
    const mounts = buildMounts(makeGroup(null), makeSession('s1'), CFG, {});
    const dirMount = mounts.find((m) => m.containerPath === '/workspace/agent/prompts');
    expect(dirMount).toMatchObject({ hostPath: `${TEST_DIR}/groups/fd/prompts`, readonly: true });
  });

  it('no prompts/ dir → no mount (nothing to protect)', () => {
    const mounts = buildMounts(makeGroup(null), makeSession('s1'), CFG, {});
    expect(mounts.find((m) => m.containerPath === '/workspace/agent/prompts')).toBeUndefined();
  });
});
