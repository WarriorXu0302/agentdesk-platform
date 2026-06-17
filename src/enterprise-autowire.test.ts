import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: vi.mock is hoisted above imports + consts, so the factory must use a
// LITERAL path (it cannot reference TEST_DIR). Keep the two in sync.
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GROUPS_DIR: '/tmp/nanoclaw-test-autowire/groups', DATA_DIR: '/tmp/nanoclaw-test-autowire/data' };
});
const TEST_DIR = '/tmp/nanoclaw-test-autowire';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  getAllAgentGroups,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { getMessagingGroupAgentByPair } from './db/messaging-groups.js';
import {
  maybeAutowireEnterpriseFrontdesk,
  perGroupAgentFolder,
  registerGroupAgentStrategy,
} from './enterprise-autowire.js';
import type { InboundEvent } from './channels/adapter.js';
import type { MessagingGroup } from './types.js';

function now(): string {
  return new Date().toISOString();
}

const ENV_KEYS = [
  'ENTERPRISE_FRONTDESK_FOLDER',
  'ENTERPRISE_AUTO_WIRE_CHANNELS',
  'ENTERPRISE_AUTO_WIRE_P2P',
  'ENTERPRISE_AUTO_WIRE_GROUPS',
  'ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED',
  'ENTERPRISE_AUTO_WIRE_GROUP_STRATEGY',
];
let savedEnv: Record<string, string | undefined>;

function seedFrontdesk(): void {
  createAgentGroup({ id: 'ag-fd', name: 'Frontdesk', folder: 'fd', agent_provider: null, created_at: now() });
  fs.mkdirSync(`${TEST_DIR}/groups/fd`, { recursive: true });
  fs.writeFileSync(`${TEST_DIR}/groups/fd/container.json`, JSON.stringify({ skills: ['lookup'] }));
}

/** Create a messaging group + the inbound event the router would hand autowire. */
function seedChannel(platformId: string, isGroup: boolean): { mg: MessagingGroup; event: InboundEvent } {
  const mg: MessagingGroup = {
    id: `mg-${platformId}`,
    channel_type: 'feishu',
    platform_id: platformId,
    name: isGroup ? 'Sales Chat' : null,
    is_group: isGroup ? 1 : 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  } as MessagingGroup;
  createMessagingGroup(mg);
  const event = {
    channelType: 'feishu',
    platformId,
    message: isGroup ? { isGroup: true, isMention: true, content: '{}' } : { isGroup: false, content: '{}' },
  } as unknown as InboundEvent;
  return { mg, event };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(`${TEST_DIR}/groups`, { recursive: true });
  runMigrations(initTestDb());
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ENTERPRISE_FRONTDESK_FOLDER = 'fd';
  process.env.ENTERPRISE_AUTO_WIRE_CHANNELS = 'feishu';
  process.env.ENTERPRISE_AUTO_WIRE_GROUPS = 'true';
  delete process.env.ENTERPRISE_AUTO_WIRE_P2P;
  delete process.env.ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED;
  delete process.env.ENTERPRISE_AUTO_WIRE_GROUP_STRATEGY;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('enterprise autowire — per-group isolation (ADR-0053)', () => {
  it('ISOLATED on: a new group gets its OWN cloned agent, NOT the shared frontdesk', () => {
    process.env.ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED = 'true';
    seedFrontdesk();
    const { mg, event } = seedChannel('oc_sales', true);

    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);

    const folder = perGroupAgentFolder('fd', 'oc_sales');
    expect(folder).toMatch(/^fd-g-oc-sales-[0-9a-f]{8}$/); // readable slug + fingerprint
    const perGroup = getAgentGroupByFolder(folder);
    expect(perGroup).toBeDefined();
    expect(perGroup!.id).toBe(`ag-${folder}`);
    expect(getMessagingGroupAgentByPair(mg.id, perGroup!.id)).toBeDefined();
    expect(getMessagingGroupAgentByPair(mg.id, 'ag-fd')).toBeUndefined(); // NOT the shared frontdesk
    expect(fs.existsSync(`${TEST_DIR}/groups/${folder}/container.json`)).toBe(true); // cloned config
  });

  it('is idempotent: re-firing reuses the per-group agent (no duplicate)', () => {
    process.env.ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED = 'true';
    seedFrontdesk();
    const { mg, event } = seedChannel('oc_sales', true);
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);
    const before = getAllAgentGroups().length;
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);
    expect(getAllAgentGroups().length).toBe(before); // no new agent group on re-fire
  });

  it('two different groups get two different agents', () => {
    process.env.ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED = 'true';
    seedFrontdesk();
    const a = seedChannel('oc_sales', true);
    const b = seedChannel('oc_eng', true);
    maybeAutowireEnterpriseFrontdesk(a.mg, a.event);
    maybeAutowireEnterpriseFrontdesk(b.mg, b.event);
    expect(getAgentGroupByFolder(perGroupAgentFolder('fd', 'oc_sales'))!.id).not.toBe(
      getAgentGroupByFolder(perGroupAgentFolder('fd', 'oc_eng'))!.id,
    );
  });

  it('two platform_ids that slugify identically still get DISTINCT agents (no collision)', () => {
    // `oc_sales` and `oc.sales` both slugify to `oc-sales`; the folder fingerprint
    // must keep them on separate per-group agents (no silent cross-group recall).
    process.env.ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED = 'true';
    seedFrontdesk();
    const a = seedChannel('oc_sales', true);
    const b = seedChannel('oc.sales', true);
    maybeAutowireEnterpriseFrontdesk(a.mg, a.event);
    maybeAutowireEnterpriseFrontdesk(b.mg, b.event);

    const folderA = perGroupAgentFolder('fd', 'oc_sales');
    const folderB = perGroupAgentFolder('fd', 'oc.sales');
    expect(folderA).not.toBe(folderB); // same slug, different fingerprint
    expect(getMessagingGroupAgentByPair(a.mg.id, `ag-${folderA}`)).toBeDefined();
    expect(getMessagingGroupAgentByPair(b.mg.id, `ag-${folderB}`)).toBeDefined();
    // neither group is wired to the OTHER's agent
    expect(getMessagingGroupAgentByPair(a.mg.id, `ag-${folderB}`)).toBeUndefined();
    expect(getMessagingGroupAgentByPair(b.mg.id, `ag-${folderA}`)).toBeUndefined();
  });

  it('ISOLATED off (default): a group still wires to the shared frontdesk', () => {
    seedFrontdesk();
    const { mg, event } = seedChannel('oc_sales', true);
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);
    expect(getMessagingGroupAgentByPair(mg.id, 'ag-fd')).toBeDefined();
    expect(getAgentGroupByFolder(perGroupAgentFolder('fd', 'oc_sales'))).toBeUndefined();
  });

  it('ISOLATED on but a DM (p2p) stays on the shared frontdesk', () => {
    process.env.ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED = 'true';
    process.env.ENTERPRISE_AUTO_WIRE_P2P = 'true';
    seedFrontdesk();
    const { mg, event } = seedChannel('p2p_alice', false);
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);
    expect(getMessagingGroupAgentByPair(mg.id, 'ag-fd')).toBeDefined(); // shared frontdesk, not isolated
    expect(getAgentGroupByFolder(perGroupAgentFolder('fd', 'p2p_alice'))).toBeUndefined();
  });
});

describe('enterprise autowire — pluggable group→agent strategy (ADR-0053)', () => {
  it('explicit STRATEGY=per-group behaves like the isolated alias', () => {
    process.env.ENTERPRISE_AUTO_WIRE_GROUP_STRATEGY = 'per-group';
    seedFrontdesk();
    const { mg, event } = seedChannel('oc_sales', true);
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);
    expect(getMessagingGroupAgentByPair(mg.id, `ag-${perGroupAgentFolder('fd', 'oc_sales')}`)).toBeDefined();
  });

  it('a CUSTOM registered strategy decides the target agent (pluggable, no core edit)', () => {
    // An operator-style custom strategy: pin every group to a pre-existing agent.
    createAgentGroup({ id: 'ag-special', name: 'Special', folder: 'special', agent_provider: null, created_at: now() });
    registerGroupAgentStrategy('test-pin-special', ({ frontdesk }) => {
      void frontdesk;
      return getAgentGroupByFolder('special')!;
    });
    process.env.ENTERPRISE_AUTO_WIRE_GROUP_STRATEGY = 'test-pin-special';
    seedFrontdesk();
    const { mg, event } = seedChannel('oc_sales', true);
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);
    expect(getMessagingGroupAgentByPair(mg.id, 'ag-special')).toBeDefined(); // wired by the custom strategy
    expect(getMessagingGroupAgentByPair(mg.id, 'ag-fd')).toBeUndefined();
  });

  it('an unknown strategy name fails SAFE to the shared frontdesk (never drops)', () => {
    process.env.ENTERPRISE_AUTO_WIRE_GROUP_STRATEGY = 'does-not-exist';
    seedFrontdesk();
    const { mg, event } = seedChannel('oc_sales', true);
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);
    expect(getMessagingGroupAgentByPair(mg.id, 'ag-fd')).toBeDefined(); // fell back to shared
  });
});
