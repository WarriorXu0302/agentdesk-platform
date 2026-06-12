/**
 * Roster directed-message tests (ADR-0023).
 *
 * Covers the adversarial cases the design's red-team收敛 around (R1-R5):
 *   - forged a2a origin cannot mint consent (R1)
 *   - a container writing a raw platform_id is rejected and overwritten (R3)
 *   - the same slot label in two scopes never collides (R4, UNIQUE)
 *   - chat_id / union_id / user_id consent targets are rejected (R2)
 *   - a directed card with empty expectedUserId mints no consent (R2)
 *   - a finished/revoked scope fails the live re-check; in-flight roster row is
 *     rejected on the next drain (R5)
 *   - rate-limit over the cap rejects (R5)
 *   - max_sends auto-revokes (R5)
 *   - root-session is enforced (agent-shared enable throws) (R4)
 *
 * Harness mirrors delivery.test.ts (real central + session DBs, a fake adapter).
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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-roster', DELIVERY_TIMEOUT_MS: 300 };
});

// Control the per-group opt-in flag + a2a session mode without touching the
// real groups/ directory. rosterDmEnabledForGroup reads container.json env;
// stub readContainerConfig so the flag and mode are test-driven.
let mockRosterEnabled = true;
let mockA2aMode: 'agent-shared' | 'root-session' = 'root-session';
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

const TEST_DIR = '/tmp/nanoclaw-test-roster';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDb } from './db/connection.js';
import { resolveSession, outboundDbPath, inboundDbPath } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import {
  insertDmGrant,
  getBySlot,
  checkGrantLive,
  revokeScope,
  checkRateKeys,
  recordRateConsumption,
} from './db/dm-grants.js';
import { assertRootSessionForRosterDm, parseConsentTarget, looksLikeRawPlatformId } from './roster-dm.js';
import { captureP2pIngressConsent, captureDirectedCardConsent } from './channels/feishu/roster-consent.js';
import type { Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

const PARTICIPANT = 'ou_participant_1';
const DM_PLATFORM = `feishu:p2p:${PARTICIPANT}`;

function seed(): void {
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'ag-1', agent_provider: null, created_at: now() });
}

/** Insert a kind='roster' outbound row addressing a slot (no real destination). */
function insertRosterOutbound(
  sessionId: string,
  msgId: string,
  opts: {
    slot?: string;
    platformId?: string | null;
    text?: string;
    deliverAfter?: string | null;
    recurrence?: string | null;
  } = {},
): void {
  const db = new Database(outboundDbPath('ag-1', sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content, deliver_after, recurrence)
     VALUES (?, datetime('now'), 'roster', ?, 'feishu', ?, ?, ?)`,
  ).run(
    msgId,
    opts.platformId ?? null,
    JSON.stringify({ text: opts.text ?? 'hi', ...(opts.slot ? { slot: opts.slot } : {}) }),
    opts.deliverAfter ?? null,
    opts.recurrence ?? null,
  );
  db.close();
}

interface DeliveredRow {
  status: string;
}
function readDelivered(sessionId: string, msgId: string): DeliveredRow | undefined {
  const db = new Database(inboundDbPath('ag-1', sessionId));
  try {
    return db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(msgId) as DeliveredRow | undefined;
  } finally {
    db.close();
  }
}

function lastAudit(scopeId: string): { decision: string; reason: string | null } | undefined {
  return getDb()
    .prepare('SELECT decision, reason FROM dm_audit WHERE scope_id = ? ORDER BY id DESC LIMIT 1')
    .get(scopeId) as { decision: string; reason: string | null } | undefined;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  mockRosterEnabled = true;
  mockA2aMode = 'root-session';
  runMigrations(initTestDb());
  seed();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// --- consent capture (R1, R2) --------------------------------------------

describe('consent capture', () => {
  const optIn = (over: Record<string, unknown> = {}) => ({
    kind: 'roster.optin' as const,
    scopeId: 'scope-A',
    slotLabel: 'reviewer',
    agentGroupId: 'ag-1',
    ...over,
  });

  it('R1: consent only comes from channel-ingress open_id, never a fabricated a2a origin', () => {
    // The consent API takes the open_id from the inbound event itself. There is
    // no parameter through which an a2a origin could supply it — the only way to
    // mint is to pass an open_id we derived from a real p2p event. Passing a
    // non-open_id (what an a2a origin id would look like) is rejected.
    const forged = captureP2pIngressConsent({
      optIn: optIn(),
      senderOpenId: 'a2a:labops:some-session', // not an ou_ open_id
      inboundMsgId: 'msg:1',
      isGroup: false,
    });
    expect(forged.ok).toBe(false);
    expect(getBySlot('scope-A', 'reviewer')).toBeUndefined();

    // A genuine p2p open_id mints the grant.
    const good = captureP2pIngressConsent({
      optIn: optIn(),
      senderOpenId: PARTICIPANT,
      inboundMsgId: 'msg:2',
      isGroup: false,
    });
    expect(good.ok).toBe(true);
    const row = getBySlot('scope-A', 'reviewer');
    expect(row?.participant_open_id).toBe(PARTICIPANT);
    expect(row?.dm_platform_id).toBe(DM_PLATFORM);
    expect(row?.consent_source).toBe('p2p-ingress');
  });

  it('R2: chat_id / union_id / user_id targets are rejected by atomic derivation', () => {
    expect(parseConsentTarget('oc_group_chat_id')).toBeNull(); // group chat id
    expect(parseConsentTarget('on_union_id')).toBeNull(); // union id shape
    expect(parseConsentTarget('user_123')).toBeNull(); // user id shape
    expect(parseConsentTarget(undefined)).toBeNull();
    const ok = parseConsentTarget(PARTICIPANT);
    expect(ok).toEqual({ participantOpenId: PARTICIPANT, dmPlatformId: DM_PLATFORM, channelType: 'feishu' });
  });

  it('R2: a group-chat join records intent only — no grant, no p2p channel minted', () => {
    const res = captureP2pIngressConsent({
      optIn: optIn(),
      senderOpenId: PARTICIPANT,
      inboundMsgId: 'msg:grp',
      isGroup: true,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('group_intent_only');
    expect(getBySlot('scope-A', 'reviewer')).toBeUndefined();
    // No p2p messaging group minted from group context.
    const mg = getDb().prepare('SELECT * FROM messaging_groups WHERE platform_id = ?').get(DM_PLATFORM);
    expect(mg).toBeUndefined();
  });

  it('R2: a directed card with empty expectedUserId mints no consent', () => {
    const res = captureDirectedCardConsent({
      optIn: optIn({ expectedUserId: undefined }),
      operatorOpenId: PARTICIPANT,
      inboundMsgId: 'action:1',
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unscoped_card');
    expect(getBySlot('scope-A', 'reviewer')).toBeUndefined();
  });

  it('R2: a directed card whose operator != expectedUserId is rejected (fail-closed)', () => {
    const res = captureDirectedCardConsent({
      optIn: optIn({ expectedUserId: PARTICIPANT }),
      operatorOpenId: 'ou_someone_else',
      inboundMsgId: 'action:2',
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('operator_mismatch');
    expect(getBySlot('scope-A', 'reviewer')).toBeUndefined();
  });

  it('R4: a different participant cannot steal an occupied slot in the same scope', () => {
    expect(
      captureP2pIngressConsent({ optIn: optIn(), senderOpenId: PARTICIPANT, inboundMsgId: 'm1', isGroup: false }).ok,
    ).toBe(true);
    // Different participant, same scope + slot — must be rejected, slot keeps the original holder.
    const steal = captureP2pIngressConsent({
      optIn: optIn(),
      senderOpenId: 'ou_attacker',
      inboundMsgId: 'm2',
      isGroup: false,
    });
    expect(steal.ok).toBe(false);
    expect(getBySlot('scope-A', 'reviewer')?.participant_open_id).toBe(PARTICIPANT);
  });

  it('same participant re-consenting the same slot refreshes the grant (succeeds)', () => {
    const first = captureP2pIngressConsent({
      optIn: optIn(),
      senderOpenId: PARTICIPANT,
      inboundMsgId: 'm1',
      isGroup: false,
    });
    expect(first.ok).toBe(true);
    const again = captureP2pIngressConsent({
      optIn: optIn(),
      senderOpenId: PARTICIPANT,
      inboundMsgId: 'm2',
      isGroup: false,
    });
    expect(again.ok).toBe(true);
    expect(getBySlot('scope-A', 'reviewer')?.consent_inbound_msg_id).toBe('m2');
  });

  it('R4: the same slot label in two scopes does not collide (UNIQUE per scope)', () => {
    expect(
      captureP2pIngressConsent({
        optIn: optIn({ scopeId: 'scope-A' }),
        senderOpenId: PARTICIPANT,
        inboundMsgId: 'm1',
        isGroup: false,
      }).ok,
    ).toBe(true);
    // Same slot label, different scope, different participant — independent.
    expect(
      captureP2pIngressConsent({
        optIn: optIn({ scopeId: 'scope-B' }),
        senderOpenId: 'ou_participant_2',
        inboundMsgId: 'm2',
        isGroup: false,
      }).ok,
    ).toBe(true);
    expect(getBySlot('scope-A', 'reviewer')?.participant_open_id).toBe(PARTICIPANT);
    expect(getBySlot('scope-B', 'reviewer')?.participant_open_id).toBe('ou_participant_2');
  });
});

// --- raw platform id helper (R3) -----------------------------------------

describe('looksLikeRawPlatformId (R3)', () => {
  it('flags prefixed and bare raw destinations', () => {
    expect(looksLikeRawPlatformId('feishu:p2p:ou_x')).toBe(true);
    expect(looksLikeRawPlatformId('ou_x')).toBe(true);
    expect(looksLikeRawPlatformId('oc_group')).toBe(true);
    expect(looksLikeRawPlatformId('chat:oc_group')).toBe(true);
    expect(looksLikeRawPlatformId('reviewer')).toBe(false); // a slot label
    expect(looksLikeRawPlatformId(null)).toBe(false);
  });
});

// --- root-session enforcement (R4) ---------------------------------------

describe('root-session enforcement (R4)', () => {
  it('throws when a roster-DM-enabled group runs agent-shared a2a sessions', () => {
    mockRosterEnabled = true;
    mockA2aMode = 'agent-shared';
    expect(() => assertRootSessionForRosterDm('ag-1')).toThrowError(/root-session/);
  });

  it('passes when the group runs root-session mode', () => {
    mockRosterEnabled = true;
    mockA2aMode = 'root-session';
    expect(() => assertRootSessionForRosterDm('ag-1')).not.toThrow();
  });

  it('is a no-op when the flag is off, regardless of mode', () => {
    mockRosterEnabled = false;
    mockA2aMode = 'agent-shared';
    expect(() => assertRootSessionForRosterDm('ag-1')).not.toThrow();
  });
});

// --- grant lifecycle (R5) ------------------------------------------------

describe('grant lifecycle (R5)', () => {
  function mintGrant(over: Record<string, unknown> = {}): string {
    const id = insertDmGrant({
      scopeId: 'scope-A',
      agentGroupId: 'ag-1',
      slotLabel: 'reviewer',
      participantOpenId: PARTICIPANT,
      dmPlatformId: DM_PLATFORM,
      consentSource: 'p2p-ingress',
      consentInboundMsgId: 'msg:1',
      maxSends: 5,
      ...over,
    });
    expect(id).not.toBeNull();
    return id as string;
  }

  it('revokeScope makes a live grant fail the re-check', () => {
    mintGrant();
    expect(checkGrantLive('scope-A', 'reviewer').ok).toBe(true);
    expect(revokeScope('scope-A')).toBe(1);
    const after = checkGrantLive('scope-A', 'reviewer');
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('revoked');
  });

  it('an expired grant fails the live re-check', () => {
    mintGrant({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = checkGrantLive('scope-A', 'reviewer');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('expired');
  });

  it('rate limit blocks once the per-grant window is over the limit', () => {
    const id = mintGrant();
    const keys = { grant: id, scope: 'scope-A', participant: PARTICIPANT, deploy: 'global' };
    // grant window limit is 3 — record 3 then expect block.
    for (let i = 0; i < 3; i++) {
      expect(checkRateKeys(keys).allowed).toBe(true);
      recordRateConsumption(keys);
    }
    expect(checkRateKeys(keys).allowed).toBe(false);
  });
});

// --- delivery gate (R3, R5) ----------------------------------------------

describe('delivery gate', () => {
  function rootSession(): Session {
    const { session } = resolveSession('ag-1', null, null, 'agent-shared');
    return session;
  }

  function mintGrantForScope(scopeId: string, opts: { maxSends?: number } = {}): void {
    insertDmGrant({
      scopeId,
      agentGroupId: 'ag-1',
      slotLabel: 'reviewer',
      participantOpenId: PARTICIPANT,
      dmPlatformId: DM_PLATFORM,
      consentSource: 'p2p-ingress',
      consentInboundMsgId: 'msg:1',
      maxSends: opts.maxSends ?? 0,
    });
    // The grant target must resolve to a p2p messaging group (is_group=0).
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

  it('R3: delivers a roster row to the grant target, overwriting a smuggled raw platform_id', async () => {
    const session = rootSession();
    mintGrantForScope(session.id);
    // Container writes a raw, attacker-chosen destination on a roster row.
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer', platformId: 'feishu:p2p:ou_attacker' });

    const calls: Array<{ channelType: string; platformId: string }> = [];
    setDeliveryAdapter({
      async deliver(channelType, platformId) {
        calls.push({ channelType, platformId });
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);

    // The smuggled raw platform_id is rejected outright (R3) — looksLikeRawPlatformId.
    expect(calls).toHaveLength(0);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('failed');
    expect(lastAudit(session.id)?.reason).toBe('raw_platform_id');
  });

  it('R3: delivers a slot-addressed roster row to the grant-authoritative target', async () => {
    const session = rootSession();
    mintGrantForScope(session.id);
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' }); // no platform_id — pure slot

    const calls: Array<{ channelType: string; platformId: string }> = [];
    setDeliveryAdapter({
      async deliver(channelType, platformId) {
        calls.push({ channelType, platformId });
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ channelType: 'feishu', platformId: DM_PLATFORM }]);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('delivered');
    expect(lastAudit(session.id)?.decision).toBe('delivered');
  });

  it('R5: a revoked scope rejects an in-flight roster row on its drain tick', async () => {
    const session = rootSession();
    mintGrantForScope(session.id);
    revokeScope(session.id); // scope finished before the row drains
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toBe(0);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('failed');
    expect(lastAudit(session.id)?.reason).toBe('revoked');
  });

  it('R5: max_sends auto-revokes after the cap is reached', async () => {
    const session = rootSession();
    mintGrantForScope(session.id, { maxSends: 1 });

    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });

    insertRosterOutbound(session.id, 'out-1', { slot: 'reviewer' });
    await deliverSessionMessages(session);
    expect(readDelivered(session.id, 'out-1')?.status).toBe('delivered');

    // Grant should now be auto-revoked (sends_used reached max_sends=1).
    expect(getBySlot(session.id, 'reviewer')?.revoked_at).not.toBeNull();

    insertRosterOutbound(session.id, 'out-2', { slot: 'reviewer' });
    await deliverSessionMessages(session);
    expect(readDelivered(session.id, 'out-2')?.status).toBe('failed');
    expect(lastAudit(session.id)?.reason).toBe('revoked');
  });

  it('R4: a roster-enabled group running agent-shared is rejected at delivery time (not just enable-time assert)', async () => {
    const session = rootSession();
    mintGrantForScope(session.id);
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });
    // Misconfigured: flag on but agent-shared. The enable-time assert is not on
    // the delivery path, so the runtime gate must reject fail-closed.
    mockA2aMode = 'agent-shared';

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toBe(0);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('failed');
    expect(lastAudit(session.id)?.reason).toBe('agent_shared_mode');
  });

  it('R5: a failed/timed-out deliver does NOT burn the grant budget (count only after success)', async () => {
    const session = rootSession();
    mintGrantForScope(session.id, { maxSends: 3 });
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });

    setDeliveryAdapter({
      async deliver() {
        throw new Error('channel boom'); // transient failure → row goes to retry
      },
    });

    await deliverSessionMessages(session);

    // The send failed and will be retried; sends_used (and rate consumption,
    // which moves together) must stay at 0 so retries don't prematurely exhaust
    // max_sends on a flaky channel (R5 review finding).
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('failed');
    expect(getBySlot(session.id, 'reviewer')?.sends_used).toBe(0);
    expect(getBySlot(session.id, 'reviewer')?.revoked_at ?? null).toBeNull();
  });

  it('R6: a roster row carrying deliver_after is rejected', async () => {
    const session = rootSession();
    mintGrantForScope(session.id);
    insertRosterOutbound(session.id, 'out-sched', {
      slot: 'reviewer',
      deliverAfter: new Date(Date.now() - 1000).toISOString().replace('T', ' ').slice(0, 19),
    });

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toBe(0);
    expect(readDelivered(session.id, 'out-sched')?.status).toBe('failed');
    expect(lastAudit(session.id)?.reason).toBe('scheduled_or_recurring');
  });

  it('flag off: roster delivery is rejected even with a valid grant', async () => {
    mockRosterEnabled = false;
    const session = rootSession();
    mintGrantForScope(session.id);
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toBe(0);
    expect(lastAudit(session.id)?.reason).toBe('flag_disabled');
  });
});
