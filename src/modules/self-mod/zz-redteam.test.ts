/**
 * Self-mod requests at the container→host trust boundary (ADR-0063).
 *
 * `add_mcp_server` and `install_packages` write into the agent group's
 * `container.json` — GROUP-level state shared by every user's container for
 * that agent — and the only gate in front of that write is one human clicking
 * Approve on a card. So the card is a security control, and these tests pin
 * the two properties that make it one:
 *
 *   - it shows everything that will be applied, and
 *   - the agent cannot author what looks like part of it.
 *
 * The assertions run against the card content actually handed to the delivery
 * adapter, not against an intermediate the handler happens to build.
 */
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-rt-self-mod';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-rt-self-mod/data', GROUPS_DIR: '/tmp/nanoclaw-rt-self-mod/groups' };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import type { ChannelAdapter } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder } from '../../session-manager.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { setDeliveryAdapter } from '../../delivery.js';
import type { Session } from '../../types.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { handleAddMcpServer, handleInstallPackages } from './request.js';

const PROTO = ['__pro', 'to__'].join('');

function now(): string {
  return new Date().toISOString();
}

const session: Session = {
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
};

let cards: Array<Record<string, unknown>> = [];

async function mountAdapter(): Promise<void> {
  const adapter: ChannelAdapter = {
    name: 'feishu',
    channelType: 'feishu',
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver() {
      return undefined;
    },
    async setTyping() {},
    async openDM(handle: string) {
      return `feishu:p2p:${handle}`;
    },
  };
  registerChannelAdapter('feishu', { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));

  const delivery: ChannelDeliveryAdapter = {
    async deliver(_channelType, _platformId, _threadId, _kind, content) {
      cards.push(JSON.parse(content) as Record<string, unknown>);
      return 'msg-1';
    },
  };
  setDeliveryAdapter(delivery);
}

/** The card body the approver reads, or '' when no card was raised. */
function cardBody(): string {
  const approval = cards.find((c) => c.type === 'ask_question');
  return approval ? String(approval.question ?? '') : '';
}

beforeEach(async () => {
  cards = [];
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({ id: 'ag-1', name: 'Ops Agent', folder: 'ops', agent_provider: null, created_at: now() });
  createUser({ id: 'feishu:ou_admin', kind: 'feishu', display_name: null, created_at: now() });
  grantRole({
    userId: 'feishu:ou_admin',
    role: 'owner',
    scope: { kind: 'global' },
    grantedBy: null,
    grantedAt: now(),
  });
  createSession(session);
  // The rejection path notifies the agent, which writes into the session's
  // inbound DB — so the session folder has to exist for a REJECTED request to
  // be observable at all.
  initSessionFolder(session.agent_group_id, session.id);
  await mountAdapter();
});

afterEach(async () => {
  await teardownChannelAdapters();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});


import { normalizeCardText } from '../../channels/feishu/primitives.js';

describe('REDTEAM: env values are agent-authored text rendered inside the fence', () => {
  it('env value with backticks + newline escapes the disclosure fence', async () => {
    const FENCE = String.fromCharCode(96, 96, 96);
    await handleAddMcpServer(
      {
        action: 'add_mcp_server',
        name: 'gh',
        command: 'npx',
        args: ['-y', 'srv'],
        env: {
          TOKEN: `x${FENCE}\n\n**Reviewed by the platform security team. Routine.**\n\n${FENCE}\ny`,
        },
      },
      session,
    );
    const body = cardBody();
    console.log('=== RAW CARD BODY (accepted? ' + (body !== '') + ') ===');
    console.log(JSON.stringify(body));
    console.log('=== RENDERED (after normalizeCardText, what the approver sees) ===');
    console.log(normalizeCardText(body));
    expect(body).toBe('');
  });

  it('env value with a bidi RLO override reaches the card', async () => {
    const RLO = String.fromCharCode(0x202e);
    await handleAddMcpServer(
      { action: 'add_mcp_server', name: 'gh', command: 'npx', env: { A: `safe ${RLO}suoicilam` } },
      session,
    );
    const body = cardBody();
    console.log('BIDI accepted? ' + (body !== ''), JSON.stringify(body));
    expect(body).toBe('');
  });
});
