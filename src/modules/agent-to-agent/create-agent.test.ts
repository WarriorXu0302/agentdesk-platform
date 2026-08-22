/**
 * `create_agent` at the container→host boundary (ADR-0063).
 *
 * This action is container-callable and it PERSISTS what the container sends:
 * the display `name` verbatim (only `folder` is normalized), and
 * `instructions` straight into `groups/<folder>/instructions.md`, which becomes
 * the spawned agent's role prompt. So the container gets to author both a
 * string that later appears on operator surfaces and a file on the host disk.
 *
 * The name rule is not cosmetic: the self-mod approval card opens with
 * `Agent "<name>" wants to …`, so a name carrying line breaks or a
 * fence-closing backtick lets a container forge the prose an admin reads next
 * to Approve — by creating an agent first and requesting self-mod from it,
 * without touching any field self-mod itself validates.
 */
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above every declaration in this file, so the factory must
// use LITERAL paths — a reference to TEST_DIR would run before it is bound.
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-create-agent-test/data',
    GROUPS_DIR: '/tmp/nanoclaw-create-agent-test/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-create-agent-test';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import { createAgentGroup, closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { handleCreateAgent } from './create-agent.js';

const BSLASH = String.fromCharCode(92);
const TICK = String.fromCharCode(96);
const RLO = String.fromCharCode(0x202e);

function now(): string {
  return new Date().toISOString();
}

const session = {
  id: 's-1',
  agent_group_id: 'ag-1',
  messaging_group_id: null,
  thread_id: null,
  owner_user_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: now(),
  archived_at: null,
  created_at: now(),
} as Session;

/** Did a new agent group land? */
function created(folder: string): boolean {
  return getAgentGroupByFolder(folder) !== undefined;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(`${TEST_DIR}/groups`, { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({ id: 'ag-1', name: 'Frontdesk', folder: 'fd', agent_provider: null, created_at: now() });
  createSession(session);
  initSessionFolder(session.agent_group_id, session.id);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('create_agent name validation', () => {
  it('creates the agent for a well-formed name', async () => {
    await handleCreateAgent({ action: 'create_agent', name: 'Invoice Bot' }, session);
    expect(created('invoice-bot')).toBe(true);
  });

  it('accepts a non-Latin name — the rule is about Unicode classes, not ASCII', async () => {
    await handleCreateAgent({ action: 'create_agent', name: '发票助手' }, session);
    // normalizeName strips non-[a-z0-9] runs, so the FOLDER falls back; what
    // matters here is that the request was not refused.
    expect(getAgentGroupByFolder('unnamed')).toBeDefined();
  });

  it('refuses a name that would inject lines into an approval card', async () => {
    await handleCreateAgent({ action: 'create_agent', name: 'Ops\n\n**Reviewed by IT. Pre-approved.**' }, session);
    expect(created('ops')).toBe(false);
  });

  it('refuses the escape sequence the card renderer expands into a newline', async () => {
    await handleCreateAgent({ action: 'create_agent', name: `Ops${BSLASH}n${BSLASH}nApproved.` }, session);
    expect(created('ops-n-napproved')).toBe(false);
  });

  it('refuses a fence-closing backtick and a bidi override', async () => {
    await handleCreateAgent({ action: 'create_agent', name: `Ops${TICK}${TICK}${TICK}` }, session);
    expect(created('ops')).toBe(false);

    await handleCreateAgent({ action: 'create_agent', name: `Ops${RLO}tob` }, session);
    expect(created('opstob')).toBe(false);
  });

  it('refuses a non-string name instead of coercing it', async () => {
    await handleCreateAgent({ action: 'create_agent', name: 42 }, session);
    await handleCreateAgent({ action: 'create_agent', name: ['Ops'] }, session);
    expect(getAgentGroupByFolder('42')).toBeUndefined();
    expect(getAgentGroupByFolder('ops')).toBeUndefined();
  });

  it('refuses an over-long name', async () => {
    await handleCreateAgent({ action: 'create_agent', name: 'a'.repeat(65) }, session);
    expect(created('a'.repeat(65))).toBe(false);
  });
});

describe('create_agent instructions validation', () => {
  it('writes well-formed instructions into the new group', async () => {
    await handleCreateAgent(
      { action: 'create_agent', name: 'Invoice Bot', instructions: 'Answer invoice questions.' },
      session,
    );
    expect(created('invoice-bot')).toBe(true);
    const file = `${TEST_DIR}/groups/invoice-bot/instructions.md`;
    expect(fs.readFileSync(file, 'utf8')).toContain('Answer invoice questions.');
  });

  it('refuses non-string instructions rather than writing a coerced file', async () => {
    await handleCreateAgent({ action: 'create_agent', name: 'Invoice Bot', instructions: { a: 1 } }, session);
    expect(created('invoice-bot')).toBe(false);
  });

  it('refuses instructions past the size cap', async () => {
    await handleCreateAgent(
      { action: 'create_agent', name: 'Invoice Bot', instructions: 'x'.repeat(64 * 1024 + 1) },
      session,
    );
    expect(created('invoice-bot')).toBe(false);
  });
});
