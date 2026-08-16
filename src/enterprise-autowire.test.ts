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
import { getAgentGroupByFolder, setAgentGroupRole } from './db/agent-groups.js';
import { getMessagingGroupAgentByPair } from './db/messaging-groups.js';
import {
  createDestination,
  getDestinationByName,
  getDestinations,
  hasDestination,
} from './modules/agent-to-agent/db/agent-destinations.js';
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

  it('a DM (p2p) wires per-user so the owner gets their own state scope (ADR-0055)', () => {
    // Regression: p2p wired session_mode='shared' (owner_user_id NULL), so
    // every DM user's session mounted the GROUP scope — all DM users of one
    // frontdesk shared workspace/memory.
    process.env.ENTERPRISE_AUTO_WIRE_P2P = 'true';
    seedFrontdesk();
    const { mg, event } = seedChannel('p2p_alice', false);
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);
    expect(getMessagingGroupAgentByPair(mg.id, 'ag-fd')!.session_mode).toBe('per-user');
  });

  it('clones prompts/ so an ADR-0054 routing-enabled clone can actually boot', () => {
    // Regression (ADR-0053 × ADR-0054): the clone copied container.json but not
    // the prompts/ dir its llm.routing.promptFile points at — provisioning and
    // wiring succeeded, then every spawn threw in resolveRoutingPromptMount.
    process.env.ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED = 'true';
    seedFrontdesk();
    fs.mkdirSync(`${TEST_DIR}/groups/fd/prompts`, { recursive: true });
    fs.writeFileSync(`${TEST_DIR}/groups/fd/prompts/frontdesk-routing.md`, 'routing prompt');
    fs.writeFileSync(
      `${TEST_DIR}/groups/fd/container.json`,
      JSON.stringify({
        skills: ['lookup'],
        llm: {
          routing: { enabled: true, provider: 'openai', model: 'm', promptFile: 'prompts/frontdesk-routing.md' },
        },
      }),
    );
    const { mg, event } = seedChannel('oc_sales', true);
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);

    const folder = perGroupAgentFolder('fd', 'oc_sales');
    expect(fs.existsSync(`${TEST_DIR}/groups/${folder}/container.json`)).toBe(true);
    expect(fs.readFileSync(`${TEST_DIR}/groups/${folder}/prompts/frontdesk-routing.md`, 'utf8')).toBe('routing prompt');
  });

  it('mirrors delegation edges onto the clone and grants workers a reply edge', () => {
    // Regression (ADR-0053): config travels on the filesystem but delegability
    // travels in agent_destinations (keyed by agent_group_id). The clone has a
    // new id, so it inherited routing yet had zero authorized workers — and the
    // a2a ACL has no reply exemption, so workers also need an edge BACK.
    process.env.ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED = 'true';
    seedFrontdesk();
    createAgentGroup({
      id: 'ag-worker',
      name: 'Finance',
      folder: 'worker-finance',
      agent_provider: null,
      created_at: now(),
    });
    createDestination({
      agent_group_id: 'ag-fd',
      local_name: 'finance',
      target_type: 'agent',
      target_id: 'ag-worker',
      created_at: now(),
    });
    const { mg, event } = seedChannel('oc_sales', true);
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);

    const clone = getAgentGroupByFolder(perGroupAgentFolder('fd', 'oc_sales'))!;
    // clone can delegate under the same local name the frontdesk used
    expect(getDestinationByName(clone.id, 'finance')?.target_id).toBe('ag-worker');
    // worker can answer: reply edge back to the clone
    expect(hasDestination('ag-worker', 'agent', clone.id)).toBe(true);
    // exactly one reply edge per worker — no duplicate spray
    expect(getDestinations('ag-worker').filter((d) => d.target_id === clone.id)).toHaveLength(1);
    // the frontdesk's own edges are untouched
    expect(getDestinationByName('ag-fd', 'finance')?.target_id).toBe('ag-worker');
  });

  it('the clone inherits the frontdesk topology role (ADR-0056)', () => {
    process.env.ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED = 'true';
    seedFrontdesk();
    setAgentGroupRole('ag-fd', 'frontdesk');
    const { mg, event } = seedChannel('oc_sales', true);
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);
    expect(getAgentGroupByFolder(perGroupAgentFolder('fd', 'oc_sales'))!.role).toBe('frontdesk');
  });

  it('a pre-role (NULL) clone is healed to the frontdesk role on re-resolve (ADR-0056)', () => {
    // Clones created before the role column exist with NULL; the topology
    // script never reaches auto-provisioned folders, so re-resolve fills it.
    process.env.ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED = 'true';
    seedFrontdesk();
    setAgentGroupRole('ag-fd', 'frontdesk');
    const folder = perGroupAgentFolder('fd', 'oc_sales');
    createAgentGroup({
      id: `ag-${folder}`,
      name: 'Pre-role clone',
      folder,
      agent_provider: null,
      created_at: now(),
      // no role — simulates a row created before migration 036
    });
    const { mg, event } = seedChannel('oc_sales', true);
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true);
    expect(getAgentGroupByFolder(folder)!.role).toBe('frontdesk');
  });

  it('warns (but proceeds) when the configured frontdesk has role=worker (ADR-0056)', async () => {
    const { log } = await import('./log.js');
    const warns: string[] = [];
    const spy = vi.spyOn(log, 'warn').mockImplementation((msg: unknown) => {
      warns.push(String(msg));
    });
    try {
      seedFrontdesk();
      setAgentGroupRole('ag-fd', 'worker');
      const { mg, event } = seedChannel('oc_sales', true);
      expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(true); // proceeds
      expect(warns.some((w) => w.includes('role=worker'))).toBe(true); // but complains
    } finally {
      spy.mockRestore();
    }
  });
});

describe('enterprise autowire — owner-denied channels (control-bypass fix)', () => {
  it('refuses to re-wire an owner-denied GROUP channel', () => {
    seedFrontdesk();
    const { mg, event } = seedChannel('oc_denied', true);
    mg.denied_at = now();
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(false);
    expect(getMessagingGroupAgentByPair(mg.id, 'ag-fd')).toBeUndefined();
  });

  it('refuses to re-wire an owner-denied DM (p2p) channel — not just groups', () => {
    // Regression: the denial guard used to be `isGroup && denied_at`, so a
    // denied DM was silently re-wired the moment ENTERPRISE_AUTO_WIRE_P2P was on
    // (wiring the frontdesk lifts agentCount past the router's denied-drop branch).
    process.env.ENTERPRISE_AUTO_WIRE_P2P = 'true';
    seedFrontdesk();
    const { mg, event } = seedChannel('p2p_denied', false);
    mg.denied_at = now();
    expect(maybeAutowireEnterpriseFrontdesk(mg, event)).toBe(false);
    expect(getMessagingGroupAgentByPair(mg.id, 'ag-fd')).toBeUndefined();
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
