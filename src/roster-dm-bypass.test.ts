/**
 * Adversarial: can a malicious container reach a consented p2p open_id target
 * via the CHANNEL branch (kind != 'roster'), bypassing the (scope_id, slot_label)
 * reverse lookup? (Core verification point 2 for ADR-0023 R3.)
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-roster-bypass', DELIVERY_TIMEOUT_MS: 300 };
});

let mockRosterEnabled = true;
const mockA2aMode: 'agent-shared' | 'root-session' = 'root-session';
vi.mock('./container-config.js', async () => {
  const actual = await vi.importActual<typeof import('./container-config.js')>('./container-config.js');
  return {
    ...actual,
    readContainerConfig: vi.fn(() => ({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
      a2aSessionMode: mockA2aMode,
      env: { ALLOW_ROSTER_DM: mockRosterEnabled ? 'true' : 'false' },
    })),
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-roster-bypass';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { resolveSession, outboundDbPath, inboundDbPath } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import { insertDmGrant } from './db/dm-grants.js';
import type { Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

const PARTICIPANT = 'ou_participant_1';
const DM_PLATFORM = `feishu:p2p:${PARTICIPANT}`;

/** Insert a PLAIN CHANNEL outbound row (attacker-controlled kind/channel/platform). */
function insertChannelOutbound(
  sessionId: string,
  msgId: string,
  opts: { kind?: string; channelType?: string | null; platformId?: string | null; text?: string },
): void {
  const db = new Database(outboundDbPath('ag-1', sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), ?, ?, ?, ?)`,
  ).run(
    msgId,
    opts.kind ?? 'chat',
    opts.platformId ?? null,
    opts.channelType ?? 'feishu',
    JSON.stringify({ text: opts.text ?? 'attacker text' }),
  );
  db.close();
}

function readDelivered(sessionId: string, msgId: string): { status: string } | undefined {
  const db = new Database(inboundDbPath('ag-1', sessionId));
  try {
    return db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(msgId) as
      | { status: string }
      | undefined;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  mockRosterEnabled = true;
  runMigrations(initTestDb());
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'ag-1', agent_provider: null, created_at: now() });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function rootSession(): Session {
  const { session } = resolveSession('ag-1', null, null, 'agent-shared');
  return session;
}

/**
 * Simulate the state after a participant has consented: a grant exists AND
 * the consent flow's ensureP2pMessagingGroup created a feishu:p2p messaging
 * group (is_group=0) for the participant. This is what makes the channel
 * branch's getMessagingGroupByPlatform resolve.
 */
function consentState(scopeId: string): void {
  insertDmGrant({
    scopeId,
    agentGroupId: 'ag-1',
    slotLabel: 'reviewer',
    participantOpenId: PARTICIPANT,
    dmPlatformId: DM_PLATFORM,
    consentSource: 'p2p-ingress',
    consentInboundMsgId: 'msg:1',
  });
  createMessagingGroup({
    id: 'mg-p2p',
    channel_type: 'feishu',
    platform_id: DM_PLATFORM,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
}

describe('channel-branch bypass to a p2p open_id (R3)', () => {
  // The forms below all reach the victim's open_id via resolveReceiveTarget.
  // Each is tried as a PLAIN channel row (kind='chat'), bypassing the slot lookup.
  const variants: Array<{ name: string; platformId: string }> = [
    { name: 'literal feishu:p2p prefix', platformId: DM_PLATFORM },
    { name: 'feishu:open_id alias', platformId: `feishu:open_id:${PARTICIPANT}` },
    { name: 'feishu:user alias', platformId: `feishu:user:${PARTICIPANT}` },
    { name: 'feishu:dm alias', platformId: `feishu:dm:${PARTICIPANT}` },
    { name: 'feishu: bare ou_', platformId: `feishu:${PARTICIPANT}` },
    { name: 'bare ou_ no channel prefix', platformId: PARTICIPANT },
    { name: 'p2p: no channel prefix', platformId: `p2p:${PARTICIPANT}` },
    { name: 'uppercase P2P', platformId: `feishu:P2P:${PARTICIPANT}` },
  ];

  for (const v of variants) {
    it(`NO module ACL: plain channel row [${v.name}] must NOT reach the participant`, async () => {
      const session = rootSession();
      consentState(session.id);
      // Drop agent_destinations so the channel-branch ACL is SKIPPED — this is
      // the weakest supported config (agent-to-agent module absent). CLAUDE.md:
      // "without the module ... we permit all non-origin channel sends".
      const { getDb } = await import('./db/connection.js');
      getDb().exec('DROP TABLE IF EXISTS agent_destinations');

      insertChannelOutbound(session.id, `out-${v.name}`, {
        kind: 'chat',
        channelType: 'feishu',
        platformId: v.platformId,
      });

      const calls: Array<{ channelType: string; platformId: string }> = [];
      setDeliveryAdapter({
        async deliver(channelType, platformId) {
          calls.push({ channelType, platformId });
          return 'plat-1';
        },
      });

      await deliverSessionMessages(session);

      const reachedVictim = calls.some(
        (c) =>
          c.channelType === 'feishu' &&
          // resolveReceiveTarget would turn any of these into the victim open_id.
          (c.platformId === v.platformId || c.platformId === DM_PLATFORM),
      );
      // SECURITY ASSERTION: a plain channel row must never deliver to the
      // consented participant while roster DM is enabled.
      expect({ variant: v.name, reachedVictim, calls }).toMatchObject({ reachedVictim: false });
      expect(readDelivered(session.id, `out-${v.name}`)?.status ?? 'none').not.toBe('delivered');
    });
  }
});
