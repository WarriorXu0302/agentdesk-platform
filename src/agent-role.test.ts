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
const { log } = await import('./log.js');
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

describe('role × routing coherence warn (ADR-0056, red-team corrected)', () => {
  // Red-team round: the original HARD throw was wrong twice over — routing is
  // inert on a2a turns (a worker's routing config burns nothing), mixed-role
  // mid-tier desks are legitimate, and a throw would land in wakeContainer's
  // transient-retry catch and become a silent 60s-forever wake loop. The gate
  // is therefore a warn-once, never a refusal.
  function collectWarns(): { warns: string[]; restore: () => void } {
    const warns: string[] = [];
    const spy = vi.spyOn(log, 'warn').mockImplementation((msg: unknown) => {
      warns.push(String(msg));
    });
    return { warns, restore: () => spy.mockRestore() };
  }

  it('worker + routing BOOTS (never throws) and warns exactly once per group', () => {
    seedRoutingPrompt();
    const { warns, restore } = collectWarns();
    try {
      const group = makeGroup('worker');
      const mounts = buildMounts(group, makeSession('s1'), ROUTING_CFG, {});
      buildMounts(group, makeSession('s2'), ROUTING_CFG, {});
      // boots: the routing prompt mount is present, nothing threw
      expect(mounts.find((m) => m.containerPath === '/workspace/agent/prompts/frontdesk-routing.md')).toBeDefined();
      // warned once across two spawns of the same group
      expect(warns.filter((w) => w.includes('role=worker with llm.routing.enabled'))).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('NULL role (legacy/unclassified) + routing neither throws nor warns', () => {
    seedRoutingPrompt();
    const { warns, restore } = collectWarns();
    try {
      buildMounts(makeGroup(null), makeSession('s1'), ROUTING_CFG, {});
      expect(warns.filter((w) => w.includes('role=worker'))).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('frontdesk + routing is the intended configuration — silent', () => {
    seedRoutingPrompt();
    const { warns, restore } = collectWarns();
    try {
      expect(() => buildMounts(makeGroup('frontdesk'), makeSession('s1'), ROUTING_CFG, {})).not.toThrow();
      expect(warns.filter((w) => w.includes('role=worker'))).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('worker WITHOUT routing is unaffected', () => {
    const { warns, restore } = collectWarns();
    try {
      expect(() => buildMounts(makeGroup('worker'), makeSession('s1'), CFG, {})).not.toThrow();
      expect(warns.filter((w) => w.includes('role=worker'))).toHaveLength(0);
    } finally {
      restore();
    }
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
