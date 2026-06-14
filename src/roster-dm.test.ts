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
let mockBackendGateway: import('./container-config.js').BackendGatewayConfig | undefined;
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
      backendGateway: mockBackendGateway,
      env: { ALLOW_ROSTER_DM: mockRosterEnabled ? 'true' : 'false' },
    })),
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-roster';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDb } from './db/connection.js';
import { createSession } from './db/sessions.js';
import { resolveSession, initSessionFolder, outboundDbPath, inboundDbPath } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter, __clearMembershipCacheForTests } from './delivery.js';
import {
  insertDmGrant,
  getBySlot,
  getByParticipant,
  checkGrantLive,
  listLiveGrantsForScope,
  revokeScope,
  revokeGrantsForLeaver,
  checkRateKeys,
  recordRateConsumption,
  reserveRosterSend,
  rollbackRosterReservation,
  hasRosterReservation,
  resolveDeployQuota,
  DEFAULT_RATE_WINDOWS,
} from './db/dm-grants.js';
import {
  assertRootSessionForRosterDm,
  parseConsentTarget,
  looksLikeRawPlatformId,
  parseRosterOptOut,
  optOutParticipant,
  writeRosterSlots,
} from './roster-dm.js';
import { authorizeDm } from './roster-gateway.js';
import {
  captureP2pIngressConsent,
  captureDirectedCardConsent,
  parseRosterOptIn,
} from './channels/feishu/roster-consent.js';
// Side-effect import: registers the registerDeliveryAction('roster.invite') handler
// so deliverSessionMessages -> handleSystemAction can dispatch invite rows.
import './roster-invite.js';
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

const ROSTER_ENV_KEYS = [
  'ROSTER_GATEWAY_AUTHORITY',
  'ROSTER_VERIFY_MEMBERSHIP',
  'ROSTER_DEPLOY_DAILY_CAP',
  'ROSTER_DEPLOY_WINDOW_SEC',
  'ROSTER_DEPLOY_WINDOW_CAP',
  'ROSTER_DEPLOY_KEY',
];

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  mockRosterEnabled = true;
  mockA2aMode = 'root-session';
  mockBackendGateway = undefined;
  for (const k of ROSTER_ENV_KEYS) delete process.env[k];
  __clearMembershipCacheForTests();
  runMigrations(initTestDb());
  seed();
});

afterEach(() => {
  closeDb();
  for (const k of ROSTER_ENV_KEYS) delete process.env[k];
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

  it('audits grant creation + revocation in enterprise_audit (roadmap 5.7)', () => {
    const auditRows = (et: string) =>
      getDb().prepare('SELECT actor, details FROM enterprise_audit WHERE event_type = ?').all(et) as Array<{
        actor: string | null;
        details: string | null;
      }>;
    mintGrant({ consentOriginUserId: 'u-real' });
    const created = auditRows('roster_grant_created');
    expect(created).toHaveLength(1);
    expect(created[0].actor).toBe('u-real');
    expect(JSON.parse(created[0].details!)).toMatchObject({ scopeId: 'scope-A', slotLabel: 'reviewer' });
    expect(revokeScope('scope-A')).toBe(1);
    const revoked = auditRows('roster_grant_revoked');
    expect(revoked).toHaveLength(1);
    expect(JSON.parse(revoked[0].details!)).toMatchObject({ scopeId: 'scope-A', reason: 'scope_revoked' });
  });

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

  function mintGrantForScope(scopeId: string, opts: { maxSends?: number; originPlatformId?: string } = {}): void {
    insertDmGrant({
      scopeId,
      agentGroupId: 'ag-1',
      slotLabel: 'reviewer',
      participantOpenId: PARTICIPANT,
      dmPlatformId: DM_PLATFORM,
      consentSource: 'p2p-ingress',
      consentInboundMsgId: 'msg:1',
      originPlatformId: opts.originPlatformId ?? null,
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

// --- harden-after (ADR-0023 items 11-14) ---------------------------------

const ORIGIN_GROUP = 'feishu:oc_origin_group';

function rootSession2(): Session {
  const { session } = resolveSession('ag-1', null, null, 'agent-shared');
  return session;
}

function mintGrant2(
  scopeId: string,
  opts: { maxSends?: number; originPlatformId?: string | null; slot?: string } = {},
): string | null {
  const id = insertDmGrant({
    scopeId,
    agentGroupId: 'ag-1',
    slotLabel: opts.slot ?? 'reviewer',
    participantOpenId: PARTICIPANT,
    dmPlatformId: DM_PLATFORM,
    consentSource: 'p2p-ingress',
    consentInboundMsgId: 'msg:1',
    originPlatformId: opts.originPlatformId ?? null,
    maxSends: opts.maxSends ?? 0,
  });
  if (!getDb().prepare('SELECT 1 FROM messaging_groups WHERE platform_id = ?').get(DM_PLATFORM)) {
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
  return id;
}

// --- item 11a: explicit opt-out (leave) ----------------------------------

describe('item 11a — explicit opt-out / leave', () => {
  it('parses structured and plain-text leave commands; ignores chatter', () => {
    expect(parseRosterOptOut({ kind: 'roster.optout', scopeId: 'scope-X' })).toEqual({ scopeId: 'scope-X' });
    expect(parseRosterOptOut({ kind: 'roster.optout' })).toEqual({ scopeId: null });
    expect(parseRosterOptOut(null, 'leave')).toEqual({ scopeId: null });
    expect(parseRosterOptOut(null, '@bot leave')).toEqual({ scopeId: null });
    expect(parseRosterOptOut(null, '退出')).toEqual({ scopeId: null });
    expect(parseRosterOptOut(null, 'unsubscribe')).toEqual({ scopeId: null });
    expect(parseRosterOptOut(null, 'please review the doc')).toBeNull();
    expect(parseRosterOptOut(null, undefined)).toBeNull();
  });

  it('scoped opt-out revokes only that participant in that scope', () => {
    mintGrant2('scope-A');
    expect(checkGrantLive('scope-A', 'reviewer').ok).toBe(true);
    expect(optOutParticipant(PARTICIPANT, 'scope-A')).toBe(1);
    const after = checkGrantLive('scope-A', 'reviewer');
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('revoked');
  });

  it('plain-text opt-out (no scope) revokes the participant across all scopes', () => {
    mintGrant2('scope-A');
    insertDmGrant({
      scopeId: 'scope-B',
      agentGroupId: 'ag-1',
      slotLabel: 'reviewer',
      participantOpenId: PARTICIPANT,
      dmPlatformId: DM_PLATFORM,
      consentSource: 'p2p-ingress',
      consentInboundMsgId: 'm2',
    });
    expect(optOutParticipant(PARTICIPANT, null)).toBe(2);
    expect(checkGrantLive('scope-A', 'reviewer').ok).toBe(false);
    expect(checkGrantLive('scope-B', 'reviewer').ok).toBe(false);
  });

  it('a non-open_id sender cannot opt out (fail-safe)', () => {
    mintGrant2('scope-A');
    expect(optOutParticipant('not_an_open_id', 'scope-A')).toBe(0);
    expect(checkGrantLive('scope-A', 'reviewer').ok).toBe(true);
  });

  it('opt-out drops a not-yet-delivered roster row on its drain tick', async () => {
    const session = rootSession2();
    mintGrant2(session.id);
    optOutParticipant(PARTICIPANT, session.id);
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
});

// --- item 11b: platform leave/disband revoke -----------------------------

describe('item 11b — leave/disband event revoke', () => {
  it('revokeGrantsForLeaver revokes only grants from the chat the leaver left', () => {
    // Two grants for the same participant, different origin chats + scopes.
    insertDmGrant({
      scopeId: 'scope-A',
      agentGroupId: 'ag-1',
      slotLabel: 'reviewer',
      participantOpenId: PARTICIPANT,
      dmPlatformId: DM_PLATFORM,
      consentSource: 'directed-card',
      consentInboundMsgId: 'm1',
      originPlatformId: ORIGIN_GROUP,
    });
    insertDmGrant({
      scopeId: 'scope-B',
      agentGroupId: 'ag-1',
      slotLabel: 'reviewer',
      participantOpenId: PARTICIPANT,
      dmPlatformId: DM_PLATFORM,
      consentSource: 'directed-card',
      consentInboundMsgId: 'm2',
      originPlatformId: 'feishu:oc_other_group',
    });
    expect(revokeGrantsForLeaver(ORIGIN_GROUP, PARTICIPANT)).toBe(1);
    expect(getByParticipant('scope-A', PARTICIPANT)?.revoked_at).not.toBeNull();
    // The grant from a different origin chat is untouched.
    expect(getByParticipant('scope-B', PARTICIPANT)?.revoked_at ?? null).toBeNull();
  });

  it('a pure p2p grant (null origin) is NOT touched by a leave event', () => {
    mintGrant2('scope-A', { originPlatformId: null });
    expect(revokeGrantsForLeaver(ORIGIN_GROUP, PARTICIPANT)).toBe(0);
    expect(checkGrantLive('scope-A', 'reviewer').ok).toBe(true);
  });

  it('disband revokes every live grant originating in the disbanded chat', () => {
    insertDmGrant({
      scopeId: 'scope-A',
      agentGroupId: 'ag-1',
      slotLabel: 'reviewer',
      participantOpenId: PARTICIPANT,
      dmPlatformId: DM_PLATFORM,
      consentSource: 'directed-card',
      consentInboundMsgId: 'm1',
      originPlatformId: ORIGIN_GROUP,
    });
    insertDmGrant({
      scopeId: 'scope-A',
      agentGroupId: 'ag-1',
      slotLabel: 'approver',
      participantOpenId: 'ou_participant_2',
      dmPlatformId: 'feishu:p2p:ou_participant_2',
      consentSource: 'directed-card',
      consentInboundMsgId: 'm2',
      originPlatformId: ORIGIN_GROUP,
    });
    // null leaver = disband: revoke all from this origin.
    expect(revokeGrantsForLeaver(ORIGIN_GROUP, null)).toBe(2);
  });
});

// --- item 12: send-time membership re-check (fail-closed) ----------------

describe('item 12 — ROSTER_VERIFY_MEMBERSHIP strong check', () => {
  it('fail-closed: a participant the adapter reports as NOT a member is rejected + revoked', async () => {
    process.env.ROSTER_VERIFY_MEMBERSHIP = 'true';
    const session = rootSession2();
    mintGrant2(session.id, { originPlatformId: ORIGIN_GROUP });
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });

    const checked: Array<{ platformId: string; userHandle: string }> = [];
    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
      async isMember(_ct, platformId, userHandle) {
        checked.push({ platformId, userHandle });
        return false; // definitively not a member
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toBe(0);
    expect(checked).toEqual([{ platformId: ORIGIN_GROUP, userHandle: PARTICIPANT }]);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('failed');
    expect(lastAudit(session.id)?.reason).toBe('not_in_scope');
    // Fail-closed also tears down the grant.
    expect(getBySlot(session.id, 'reviewer')?.revoked_at).not.toBeNull();
  });

  it('still a member → delivers normally', async () => {
    process.env.ROSTER_VERIFY_MEMBERSHIP = 'true';
    const session = rootSession2();
    mintGrant2(session.id, { originPlatformId: ORIGIN_GROUP });
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });
    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, platformId) {
        calls.push(platformId);
        return 'plat-1';
      },
      async isMember() {
        return true;
      },
    });
    await deliverSessionMessages(session);
    expect(calls).toEqual([DM_PLATFORM]);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('delivered');
  });

  it('unknown membership (adapter returns undefined) falls back to item-11 and delivers', async () => {
    process.env.ROSTER_VERIFY_MEMBERSHIP = 'true';
    const session = rootSession2();
    mintGrant2(session.id, { originPlatformId: ORIGIN_GROUP });
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });
    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
      async isMember() {
        return undefined; // can't determine — fall back, do not drop
      },
    });
    await deliverSessionMessages(session);
    expect(calls).toBe(1);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('delivered');
  });

  it('adapter without isMember (flag on) delivers — relies on item 11', async () => {
    process.env.ROSTER_VERIFY_MEMBERSHIP = 'true';
    const session = rootSession2();
    mintGrant2(session.id, { originPlatformId: ORIGIN_GROUP });
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });
    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
    });
    await deliverSessionMessages(session);
    expect(calls).toBe(1);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('delivered');
  });

  it('flag OFF: isMember is never consulted', async () => {
    // ROSTER_VERIFY_MEMBERSHIP unset by beforeEach.
    const session = rootSession2();
    mintGrant2(session.id, { originPlatformId: ORIGIN_GROUP });
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });
    let memberChecks = 0;
    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
      async isMember() {
        memberChecks++;
        return false;
      },
    });
    await deliverSessionMessages(session);
    expect(memberChecks).toBe(0);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('delivered');
  });
});

// --- item 13: gateway authority (allow / deny / unreachable fail-closed) --

describe('item 13 — gateway authority', () => {
  it('authorizeDm: allow lets the send proceed; signs with HMAC header when key set', async () => {
    const seen: { headers: Record<string, string>; body: string } = { headers: {}, body: '' };
    const fakeFetch = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.headers = init.headers;
      seen.body = init.body;
      return { ok: true, status: 200, text: async () => JSON.stringify({ decision: 'allow' }) } as Response;
    }) as unknown as typeof fetch;
    const decision = await authorizeDm(
      { baseUrl: 'https://gw.example', signingKey: 'k' },
      {
        scopeId: 's',
        slotLabel: 'reviewer',
        participantOpenId: PARTICIPANT,
        dmPlatformId: DM_PLATFORM,
        agentGroupId: 'ag-1',
        channelType: 'feishu',
      },
      fakeFetch,
    );
    expect(decision.decision).toBe('allow');
    // A signature header is present (exact name depends on namespace).
    expect(Object.keys(seen.headers).some((h) => h.endsWith('-signature'))).toBe(true);
  });

  it('authorizeDm: explicit deny rejects', async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ decision: 'deny', reason: 'no_role' }),
      }) as Response) as unknown as typeof fetch;
    const decision = await authorizeDm(
      { baseUrl: 'https://gw.example' },
      {
        scopeId: 's',
        slotLabel: 'r',
        participantOpenId: PARTICIPANT,
        dmPlatformId: DM_PLATFORM,
        agentGroupId: 'ag-1',
        channelType: 'feishu',
      },
      fakeFetch,
    );
    expect(decision.decision).toBe('deny');
  });

  it('authorizeDm: unreachable / non-2xx → fail-closed deny', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const d1 = await authorizeDm(
      { baseUrl: 'https://gw.example' },
      {
        scopeId: 's',
        slotLabel: 'r',
        participantOpenId: PARTICIPANT,
        dmPlatformId: DM_PLATFORM,
        agentGroupId: 'ag-1',
        channelType: 'feishu',
      },
      boom,
    );
    expect(d1.decision).toBe('deny');
    const http500 = (async () =>
      ({ ok: false, status: 500, text: async () => 'err' }) as Response) as unknown as typeof fetch;
    const d2 = await authorizeDm(
      { baseUrl: 'https://gw.example' },
      {
        scopeId: 's',
        slotLabel: 'r',
        participantOpenId: PARTICIPANT,
        dmPlatformId: DM_PLATFORM,
        agentGroupId: 'ag-1',
        channelType: 'feishu',
      },
      http500,
    );
    expect(d2.decision).toBe('deny');
  });

  it('delivery gate: gateway DENY rejects even with a valid local grant', async () => {
    process.env.ROSTER_GATEWAY_AUTHORITY = 'true';
    // Authority path requires a signing key (#7): an unsigned gateway is rejected
    // before any call. A correctly-configured authority gateway signs.
    mockBackendGateway = { baseUrl: 'https://gw.example', signingKey: 'k' };
    // Force the gateway to deny by pointing it at a fetch that returns deny.
    vi.stubGlobal(
      'fetch',
      (async () =>
        ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ decision: 'deny' }),
        }) as Response) as unknown as typeof fetch,
    );
    const session = rootSession2();
    mintGrant2(session.id);
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });
    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
    });
    await deliverSessionMessages(session);
    vi.unstubAllGlobals();
    expect(calls).toBe(0);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('failed');
    expect(lastAudit(session.id)?.reason).toBe('gateway_denied');
  });

  it('delivery gate: gateway unreachable → fail-closed reject', async () => {
    process.env.ROSTER_GATEWAY_AUTHORITY = 'true';
    mockBackendGateway = { baseUrl: 'https://gw.example', signingKey: 'k' };
    vi.stubGlobal('fetch', (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    const session = rootSession2();
    mintGrant2(session.id);
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });
    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
    });
    await deliverSessionMessages(session);
    vi.unstubAllGlobals();
    expect(calls).toBe(0);
    expect(lastAudit(session.id)?.reason).toBe('gateway_denied');
  });

  it('delivery gate: gateway ALLOW delivers', async () => {
    process.env.ROSTER_GATEWAY_AUTHORITY = 'true';
    mockBackendGateway = { baseUrl: 'https://gw.example', signingKey: 'k' };
    vi.stubGlobal(
      'fetch',
      (async () =>
        ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ decision: 'allow' }),
        }) as Response) as unknown as typeof fetch,
    );
    const session = rootSession2();
    mintGrant2(session.id);
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });
    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, platformId) {
        calls.push(platformId);
        return 'plat-1';
      },
    });
    await deliverSessionMessages(session);
    vi.unstubAllGlobals();
    expect(calls).toEqual([DM_PLATFORM]);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('delivered');
  });

  it('delivery gate: flag on but no gateway configured → local table remains authoritative', async () => {
    process.env.ROSTER_GATEWAY_AUTHORITY = 'true';
    mockBackendGateway = undefined; // group has no gateway
    const session = rootSession2();
    mintGrant2(session.id);
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });
    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, platformId) {
        calls.push(platformId);
        return 'plat-1';
      },
    });
    await deliverSessionMessages(session);
    expect(calls).toEqual([DM_PLATFORM]);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('delivered');
  });

  // #7: authority path with an UNSIGNED gateway is a forgeable-allow bypass.
  it('#7: authority=true but gateway has no signingKey → fail-closed reject, gateway never called', async () => {
    process.env.ROSTER_GATEWAY_AUTHORITY = 'true';
    mockBackendGateway = { baseUrl: 'https://gw.example' }; // NO signingKey
    let fetched = 0;
    vi.stubGlobal('fetch', (async () => {
      // An attacker controlling baseUrl would answer allow. It must never even
      // be asked: the host rejects before any request goes out.
      fetched++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ decision: 'allow' }) } as Response;
    }) as unknown as typeof fetch);
    const session = rootSession2();
    mintGrant2(session.id);
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });
    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
    });
    await deliverSessionMessages(session);
    vi.unstubAllGlobals();
    expect(fetched).toBe(0); // unsigned authority is rejected before the call
    expect(calls).toBe(0);
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('failed');
    expect(lastAudit(session.id)?.reason).toBe('gateway_unsigned_authority');
  });
});

// --- item 14: deployment-level blast-radius daily cap --------------------

describe('item 14 — deploy daily cap', () => {
  it('rejects once the rolling-24h deploy cap is reached', async () => {
    process.env.ROSTER_DEPLOY_DAILY_CAP = '1';
    const session = rootSession2();
    mintGrant2(session.id);
    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });
    insertRosterOutbound(session.id, 'out-1', { slot: 'reviewer' });
    await deliverSessionMessages(session);
    expect(readDelivered(session.id, 'out-1')?.status).toBe('delivered');

    // Second send in the same day is over the deploy cap.
    insertRosterOutbound(session.id, 'out-2', { slot: 'reviewer' });
    await deliverSessionMessages(session);
    expect(readDelivered(session.id, 'out-2')?.status).toBe('failed');
    expect(lastAudit(session.id)?.reason).toBe('deploy_daily_cap');
  });

  it('cap unset (default 0) does not block', async () => {
    // ROSTER_DEPLOY_DAILY_CAP unset.
    const session = rootSession2();
    mintGrant2(session.id);
    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });
    insertRosterOutbound(session.id, 'out-1', { slot: 'reviewer' });
    insertRosterOutbound(session.id, 'out-2', { slot: 'reviewer' });
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(readDelivered(session.id, 'out-1')?.status).toBe('delivered');
    expect(readDelivered(session.id, 'out-2')?.status).toBe('delivered');
  });
});

// --- reserve-before-send: concurrency (#1) + timeout (#4) correctness -----

/**
 * A worker session that shares the SAME host scope (root_session_id) as `root`.
 * hostScopeForSession = root_session_id ?? id, so root + this worker resolve to
 * one scope_id — they share the grant, the per-scope/participant rate keys, AND
 * the grant's max_sends. This is the cross-session pair the TOCTOU bug (#1)
 * over-delivered to.
 */
function workerSessionSharingScope(root: Session): Session {
  const id = `${root.id}-worker`;
  const worker: Session = {
    id,
    agent_group_id: root.agent_group_id,
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: null,
    root_session_id: root.id,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    spawn_depth: 1,
    created_at: now(),
  };
  createSession(worker);
  initSessionFolder(root.agent_group_id, id);
  return worker;
}

describe('reserve-before-send (#1 concurrency, #4 timeout)', () => {
  it('#1: two sessions sharing one scope + a barrier in deliver() respect max_sends=1 (only one delivers)', async () => {
    const root = rootSession2();
    // max_sends=1 on the shared scope grant. Both sessions resolve to this grant.
    mintGrant2(root.id, { maxSends: 1 });
    const worker = workerSessionSharingScope(root);

    insertRosterOutbound(root.id, 'out-root', { slot: 'reviewer' });
    insertRosterOutbound(worker.id, 'out-worker', { slot: 'reviewer' });

    // Barrier: hold BOTH deliver() calls in flight simultaneously so, under the
    // OLD read-only-check-then-send code, both would have passed the cap check
    // before either recorded. With reserve-before-send the reservation happens
    // BEFORE deliver(), so only one call ever reaches the adapter.
    let inFlight = 0;
    let release!: () => void;
    const bothInFlight = new Promise<void>((r) => {
      release = () => r();
    });
    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, platformId) {
        inFlight++;
        // If a second call ever arrives, unblock the first; otherwise the single
        // admitted call releases itself after a microtask so the test doesn't hang.
        if (inFlight >= 2) release();
        else void Promise.resolve().then(() => release());
        await bothInFlight;
        delivered.push(platformId);
        return 'plat-1';
      },
    });

    await Promise.all([deliverSessionMessages(root), deliverSessionMessages(worker)]);

    // Exactly ONE send reached the adapter — the cap was not breached by the race.
    expect(delivered).toHaveLength(1);
    expect(getBySlot(root.id, 'reviewer')?.sends_used).toBe(1);
    // The grant auto-revoked at the cap; the loser was rejected before deliver().
    expect(getBySlot(root.id, 'reviewer')?.revoked_at).not.toBeNull();
    const statuses = [readDelivered(root.id, 'out-root')?.status, readDelivered(worker.id, 'out-worker')?.status];
    expect(statuses.filter((s) => s === 'delivered')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'failed')).toHaveLength(1);
  });

  /** A second, INDEPENDENT root scope (its own root_session_id → its own scope). */
  function independentRoot(template: Session, suffix: string): Session {
    const id = `${template.id}-${suffix}`;
    const s: Session = {
      id,
      agent_group_id: template.agent_group_id,
      messaging_group_id: null,
      thread_id: null,
      owner_user_id: null,
      root_session_id: id,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      spawn_depth: 0,
      created_at: now(),
    };
    createSession(s);
    initSessionFolder(template.agent_group_id, id);
    return s;
  }

  it('#1: deploy daily cap=1 holds GLOBALLY across two concurrently-draining scopes', async () => {
    process.env.ROSTER_DEPLOY_DAILY_CAP = '1';
    // Two INDEPENDENT scopes (different grants, no shared max_sends) — only the
    // deployment-wide daily cap should bound them.
    const rootA = rootSession2();
    mintGrant2(rootA.id, { slot: 'reviewer' });
    const rootB = independentRoot(rootA, 'B');
    mintGrant2(rootB.id, { slot: 'reviewer' });

    insertRosterOutbound(rootA.id, 'out-A', { slot: 'reviewer' });
    insertRosterOutbound(rootB.id, 'out-B', { slot: 'reviewer' });

    let inFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = () => r()));
    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, platformId) {
        inFlight++;
        if (inFlight >= 2) release();
        else void Promise.resolve().then(() => release());
        await gate;
        delivered.push(platformId);
        return 'plat-1';
      },
    });

    await Promise.all([deliverSessionMessages(rootA), deliverSessionMessages(rootB)]);

    // The global daily cap=1 admits exactly one send despite two scopes racing.
    expect(delivered).toHaveLength(1);
    const statuses = [readDelivered(rootA.id, 'out-A')?.status, readDelivered(rootB.id, 'out-B')?.status];
    expect(statuses.filter((s) => s === 'delivered')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'failed')).toHaveLength(1);
  });

  it('#4: a timeout (possibly delivered downstream) KEEPS the reservation — no rollback, no re-charge on retry', async () => {
    const root = rootSession2();
    mintGrant2(root.id, { maxSends: 3 });
    insertRosterOutbound(root.id, 'out-roster', { slot: 'reviewer' });

    // deliver() never resolves before DELIVERY_TIMEOUT_MS (300ms in test config),
    // so withDeliveryTimeout throws DeliveryTimeoutError — but the underlying call
    // may have ALREADY delivered. The reservation must NOT be rolled back.
    setDeliveryAdapter({
      async deliver() {
        await new Promise((r) => setTimeout(r, 5_000)); // outlives the 300ms timeout
        return 'plat-1';
      },
    });

    await deliverSessionMessages(root);

    // Row went to retry (at-least-once), but budget stays charged at 1.
    expect(readDelivered(root.id, 'out-roster')?.status).toBe('failed');
    expect(getBySlot(root.id, 'reviewer')?.sends_used).toBe(1);
    expect(hasRosterReservation('out-roster')).toBe(true);

    // The retry reuses the standing reservation — re-reserving the SAME message
    // id does not charge a second time (this is what stops #4 from delivering N
    // copies while sends_used < N).
    const deploy = resolveDeployQuota();
    const grantId = getBySlot(root.id, 'reviewer')!.id;
    const keys = { grant: grantId, scope: root.id, participant: PARTICIPANT, deploy: deploy.key };
    const again = reserveRosterSend('out-roster', grantId, keys, DEFAULT_RATE_WINDOWS, deploy);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.fresh).toBe(false);
    expect(getBySlot(root.id, 'reviewer')?.sends_used).toBe(1); // still 1, not 2
  });

  it('explicit (non-timeout) failure rolls the reservation back so the retry re-reserves cleanly', async () => {
    const root = rootSession2();
    mintGrant2(root.id, { maxSends: 3 });
    insertRosterOutbound(root.id, 'out-roster', { slot: 'reviewer' });
    setDeliveryAdapter({
      async deliver() {
        throw new Error('channel boom'); // explicit, definitely-not-delivered failure
      },
    });
    await deliverSessionMessages(root);
    expect(readDelivered(root.id, 'out-roster')?.status).toBe('failed');
    // Rolled back: budget and the marker are both released.
    expect(getBySlot(root.id, 'reviewer')?.sends_used).toBe(0);
    expect(hasRosterReservation('out-roster')).toBe(false);
  });

  it('reserveRosterSend is atomic: an over-cap reservation consumes NO rate budget (rolls back)', () => {
    const grantId = mintGrant2('scope-Z', { maxSends: 1 }) as string;
    const deploy = resolveDeployQuota();
    const keys = { grant: grantId, scope: 'scope-Z', participant: PARTICIPANT, deploy: deploy.key };
    // First reservation succeeds and hits the cap.
    const first = reserveRosterSend('m-1', grantId, keys, DEFAULT_RATE_WINDOWS, deploy);
    expect(first.ok).toBe(true);
    // Rate ledger charged exactly once for the grant key.
    expect(checkRateKeys(keys).allowed).toBe(true); // grant window limit is 3
    // Second reservation (different message) is over max_sends → must NOT have
    // charged any rate key (full transaction rollback).
    const before = checkRateKeys(keys);
    const second = reserveRosterSend('m-2', grantId, keys, DEFAULT_RATE_WINDOWS, deploy);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('max_sends');
    // No partial charge: the grant rate key count is unchanged by the failed reserve.
    expect(checkRateKeys(keys).allowed).toBe(before.allowed);
    expect(hasRosterReservation('m-2')).toBe(false);
  });

  it('rollbackRosterReservation un-revokes a grant that THIS reservation auto-revoked', () => {
    const grantId = mintGrant2('scope-Y', { maxSends: 1 }) as string;
    const deploy = resolveDeployQuota();
    const keys = { grant: grantId, scope: 'scope-Y', participant: PARTICIPANT, deploy: deploy.key };
    const r = reserveRosterSend('m-rev', grantId, keys, DEFAULT_RATE_WINDOWS, deploy);
    expect(r.ok).toBe(true);
    // Reservation drove sends_used to the cap → auto-revoked.
    expect(getBySlot('scope-Y', 'reviewer')?.revoked_at).not.toBeNull();
    expect(getBySlot('scope-Y', 'reviewer')?.sends_used).toBe(1);
    // Rolling back (explicit failure path) restores it to live + un-charged.
    expect(rollbackRosterReservation('m-rev', grantId, keys, DEFAULT_RATE_WINDOWS, deploy)).toBe(true);
    expect(getBySlot('scope-Y', 'reviewer')?.sends_used).toBe(0);
    expect(getBySlot('scope-Y', 'reviewer')?.revoked_at ?? null).toBeNull();
    expect(checkGrantLive('scope-Y', 'reviewer').ok).toBe(true);
  });
});

// --- listLiveGrantsForScope (ADR-0044 agent slot discovery) ----------------
describe('listLiveGrantsForScope', () => {
  const base = {
    agentGroupId: 'ag-1',
    consentSource: 'directed-card' as const,
    consentInboundMsgId: 'm-consent',
  };
  function grant(scopeId: string, slot: string, openId: string, extra: Record<string, unknown> = {}): void {
    insertDmGrant({
      ...base,
      scopeId,
      slotLabel: slot,
      participantOpenId: openId,
      dmPlatformId: `feishu:p2p:${openId}`,
      ...extra,
    });
  }

  it('returns only deliverable slots — excludes revoked / expired / other-scope', () => {
    grant('scope-A', 'approver', 'ou_live');
    grant('scope-A', 'stale', 'ou_exp', { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    grant('scope-A', 'gone', 'ou_rev');
    // revoke the 'gone' slot directly (test-local)
    getDb()
      .prepare('UPDATE dm_grants SET revoked_at = ? WHERE scope_id = ? AND slot_label = ?')
      .run(new Date().toISOString(), 'scope-A', 'gone');
    grant('scope-OTHER', 'approver', 'ou_other'); // scope isolation

    const live = listLiveGrantsForScope('scope-A');
    expect(live.map((g) => g.slot_label).sort()).toEqual(['approver']);
    // matches the delivery gate's own liveness verdict
    expect(checkGrantLive('scope-A', 'approver').ok).toBe(true);
    expect(checkGrantLive('scope-A', 'stale').ok).toBe(false);
    expect(checkGrantLive('scope-A', 'gone').ok).toBe(false);
  });

  it('excludes a grant whose max_sends is exhausted', () => {
    grant('scope-M', 'capped', 'ou_cap', { maxSends: 1 });
    getDb()
      .prepare('UPDATE dm_grants SET sends_used = max_sends WHERE scope_id = ? AND slot_label = ?')
      .run('scope-M', 'capped');
    expect(listLiveGrantsForScope('scope-M')).toHaveLength(0);
  });
});

// --- writeRosterSlots (ADR-0044 Stage 1 discovery projection) ---------------
describe('writeRosterSlots', () => {
  interface SlotRow {
    slot_label: string;
    sends_remaining: number | null;
    expires_at: string | null;
  }
  function readRosterSlots(sessionId: string): SlotRow[] {
    const db = new Database(inboundDbPath('ag-1', sessionId));
    try {
      return db.prepare('SELECT * FROM roster_slots ORDER BY slot_label').all() as SlotRow[];
    } catch {
      return []; // table absent
    } finally {
      db.close();
    }
  }
  // A second participant — the UNIQUE(scope_id, participant_open_id) constraint
  // means each scope holds at most one slot per participant, so multi-slot
  // fixtures need distinct open_ids.
  const PARTICIPANT_2 = 'ou_participant_2';
  function rootSession(): Session {
    const { session } = resolveSession('ag-1', null, null, 'agent-shared');
    return session;
  }

  it('projects only LIVE slots, with zero identity fields, scope-isolated', () => {
    const session = rootSession();
    const scope = session.id;
    // live, uncapped
    insertDmGrant({
      scopeId: scope,
      agentGroupId: 'ag-1',
      slotLabel: 'approver',
      participantOpenId: PARTICIPANT,
      dmPlatformId: DM_PLATFORM,
      consentSource: 'directed-card',
      consentInboundMsgId: 'm1',
    });
    // live, capped 5, 2 used → 3 remaining
    insertDmGrant({
      scopeId: scope,
      agentGroupId: 'ag-1',
      slotLabel: 'ops',
      participantOpenId: PARTICIPANT_2,
      dmPlatformId: `feishu:p2p:${PARTICIPANT_2}`,
      consentSource: 'directed-card',
      consentInboundMsgId: 'm2',
      maxSends: 5,
    });
    getDb().prepare('UPDATE dm_grants SET sends_used = 2 WHERE scope_id = ? AND slot_label = ?').run(scope, 'ops');
    // revoked
    insertDmGrant({
      scopeId: scope,
      agentGroupId: 'ag-1',
      slotLabel: 'gone',
      participantOpenId: 'ou_rev',
      dmPlatformId: 'feishu:p2p:ou_rev',
      consentSource: 'directed-card',
      consentInboundMsgId: 'm3',
    });
    getDb()
      .prepare('UPDATE dm_grants SET revoked_at = ? WHERE scope_id = ? AND slot_label = ?')
      .run(now(), scope, 'gone');
    // expired
    insertDmGrant({
      scopeId: scope,
      agentGroupId: 'ag-1',
      slotLabel: 'stale',
      participantOpenId: 'ou_exp',
      dmPlatformId: 'feishu:p2p:ou_exp',
      consentSource: 'directed-card',
      consentInboundMsgId: 'm4',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // different scope — must not leak in
    insertDmGrant({
      scopeId: 'scope-OTHER',
      agentGroupId: 'ag-1',
      slotLabel: 'approver',
      participantOpenId: 'ou_other',
      dmPlatformId: 'feishu:p2p:ou_other',
      consentSource: 'directed-card',
      consentInboundMsgId: 'm5',
    });

    writeRosterSlots('ag-1', session.id);

    const rows = readRosterSlots(session.id);
    expect(rows.map((r) => r.slot_label)).toEqual(['approver', 'ops']);
    expect(rows.find((r) => r.slot_label === 'approver')?.sends_remaining).toBeNull(); // uncapped
    expect(rows.find((r) => r.slot_label === 'ops')?.sends_remaining).toBe(3); // 5 - 2
    // ZERO identity fields — the row has EXACTLY these three columns.
    expect(Object.keys(rows[0]).sort()).toEqual(['expires_at', 'sends_remaining', 'slot_label']);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('ou_');
    expect(serialized).not.toContain('feishu:p2p');
  });

  it('flag OFF writes nothing (empty projection even with a live grant)', () => {
    mockRosterEnabled = false;
    const session = rootSession();
    insertDmGrant({
      scopeId: session.id,
      agentGroupId: 'ag-1',
      slotLabel: 'approver',
      participantOpenId: PARTICIPANT,
      dmPlatformId: DM_PLATFORM,
      consentSource: 'directed-card',
      consentInboundMsgId: 'm1',
    });
    writeRosterSlots('ag-1', session.id);
    expect(readRosterSlots(session.id)).toHaveLength(0);
  });

  it('re-projecting on the next wake drops a since-revoked slot', () => {
    const session = rootSession();
    insertDmGrant({
      scopeId: session.id,
      agentGroupId: 'ag-1',
      slotLabel: 'approver',
      participantOpenId: PARTICIPANT,
      dmPlatformId: DM_PLATFORM,
      consentSource: 'directed-card',
      consentInboundMsgId: 'm1',
    });
    writeRosterSlots('ag-1', session.id);
    expect(readRosterSlots(session.id).map((r) => r.slot_label)).toEqual(['approver']);
    // Grant revoked between wakes — the full DELETE+INSERT replace drops it.
    revokeScope(session.id);
    writeRosterSlots('ag-1', session.id);
    expect(readRosterSlots(session.id)).toHaveLength(0);
  });
});

// --- invite_to_roster (ADR-0044 Stage 3 — new-contact vector) ---------------
describe('invite_to_roster handler', () => {
  const NEW_MEMBER = 'ou_new_contact';
  const INVITE_GROUP_CHAT = 'oc_invite_group';
  const INVITE_GROUP_PLATFORM = `feishu:${INVITE_GROUP_CHAT}`;

  /** A root session WIRED to a feishu group chat — the invite's origin group. */
  function groupSession(): Session {
    if (!getDb().prepare('SELECT 1 FROM messaging_groups WHERE id = ?').get('mg-invite-group')) {
      createMessagingGroup({
        id: 'mg-invite-group',
        channel_type: 'feishu',
        platform_id: INVITE_GROUP_CHAT,
        name: 'Ops',
        is_group: 1,
        unknown_sender_policy: 'strict',
        created_at: now(),
      });
    }
    const { session } = resolveSession('ag-1', 'mg-invite-group', null, 'shared');
    return session;
  }

  function insertInviteOutbound(sessionId: string, msgId: string, member: string, slotLabel: string): void {
    const db = new Database(outboundDbPath('ag-1', sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'system', NULL, NULL, ?)`,
    ).run(msgId, JSON.stringify({ action: 'roster.invite', member, slotLabel }));
    db.close();
  }

  interface DeliverCall {
    channelType: string;
    platformId: string;
    kind: string;
    content: string;
  }
  /** Fake adapter capturing deliver() calls with a fixed isMember verdict. */
  function fakeAdapter(isMemberVerdict: boolean | undefined, calls: DeliverCall[]): void {
    setDeliveryAdapter({
      async deliver(channelType, platformId, _threadId, kind, content) {
        calls.push({ channelType, platformId, kind, content });
        return 'plat-1';
      },
      async isMember() {
        return isMemberVerdict;
      },
    });
  }

  it('happy path: a member invite stamps a host-controlled directed card to the origin group', async () => {
    const session = groupSession();
    const calls: DeliverCall[] = [];
    fakeAdapter(true, calls);
    insertInviteOutbound(session.id, 'inv-1', NEW_MEMBER, 'approver');

    await deliverSessionMessages(session);

    expect(calls).toHaveLength(1);
    expect(calls[0].channelType).toBe('feishu');
    expect(calls[0].platformId).toBe(INVITE_GROUP_PLATFORM); // posted INTO the origin group
    const payload = JSON.parse(calls[0].content) as { type: string; optIn: Record<string, unknown> };
    expect(payload.type).toBe('roster_invite');
    // Every security-critical field is HOST-stamped (scope = root session id here).
    expect(payload.optIn).toMatchObject({
      kind: 'roster.optin',
      scopeId: session.id,
      slotLabel: 'approver',
      agentGroupId: 'ag-1',
      expectedUserId: NEW_MEMBER,
    });
    expect(typeof payload.optIn.expiresAt).toBe('string'); // host-stamped 24h expiry
    expect(lastAudit(session.id)?.decision).toBe('delivered');
  });

  it('non-member is rejected fail-closed (no card sent)', async () => {
    const session = groupSession();
    const calls: DeliverCall[] = [];
    fakeAdapter(false, calls);
    insertInviteOutbound(session.id, 'inv-1', NEW_MEMBER, 'approver');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(0);
    expect(lastAudit(session.id)?.reason).toBe('not_member');
  });

  it('unknown membership (isMember undefined) ALSO rejects — the bar is absolute for a new contact', async () => {
    const session = groupSession();
    const calls: DeliverCall[] = [];
    fakeAdapter(undefined, calls);
    insertInviteOutbound(session.id, 'inv-1', NEW_MEMBER, 'approver');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(0);
    expect(lastAudit(session.id)?.reason).toBe('not_member');
  });

  it('suppresses a re-invite when ANY grant row already exists (live OR opted-out)', async () => {
    const session = groupSession();
    // The member opted in once then opted out → a revoked grant row remains.
    insertDmGrant({
      scopeId: session.id,
      agentGroupId: 'ag-1',
      slotLabel: 'approver',
      participantOpenId: NEW_MEMBER,
      dmPlatformId: `feishu:p2p:${NEW_MEMBER}`,
      consentSource: 'directed-card',
      consentInboundMsgId: 'prior',
    });
    getDb()
      .prepare('UPDATE dm_grants SET revoked_at = ? WHERE scope_id = ? AND participant_open_id = ?')
      .run(now(), session.id, NEW_MEMBER);
    const calls: DeliverCall[] = [];
    fakeAdapter(true, calls);
    insertInviteOutbound(session.id, 'inv-1', NEW_MEMBER, 'approver');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(0); // never re-asked — harassment guard
    expect(lastAudit(session.id)?.reason).toBe('already_invited');
  });

  it('rejects a non-ou_ member target (R2)', async () => {
    const session = groupSession();
    const calls: DeliverCall[] = [];
    fakeAdapter(true, calls);
    insertInviteOutbound(session.id, 'inv-1', 'oc_a_group', 'approver'); // a group chat id, not a person
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(0);
    expect(lastAudit(session.id)?.reason).toBe('bad_member');
  });

  it('fail-closed when the origin group is ambiguous (session not wired to a feishu group)', async () => {
    // agent-shared session with no messaging group → originGroupForSession null.
    const { session } = resolveSession('ag-1', null, null, 'agent-shared');
    const calls: DeliverCall[] = [];
    fakeAdapter(true, calls);
    insertInviteOutbound(session.id, 'inv-1', NEW_MEMBER, 'approver');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(0);
    expect(lastAudit(session.id)?.reason).toBe('ambiguous_origin');
  });

  it('flag OFF rejects the invite', async () => {
    mockRosterEnabled = false;
    const session = groupSession();
    const calls: DeliverCall[] = [];
    fakeAdapter(true, calls);
    insertInviteOutbound(session.id, 'inv-1', NEW_MEMBER, 'approver');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(0);
    expect(lastAudit(session.id)?.reason).toBe('flag_disabled');
  });

  it('rate-limits: the 4th invite in a scope window is rejected (scope 60s/3)', async () => {
    const session = groupSession();
    const calls: DeliverCall[] = [];
    fakeAdapter(true, calls);
    // Four invites to four DISTINCT members so the one-shot suppression never trips.
    insertInviteOutbound(session.id, 'inv-1', 'ou_m1', 'approver');
    insertInviteOutbound(session.id, 'inv-2', 'ou_m2', 'approver');
    insertInviteOutbound(session.id, 'inv-3', 'ou_m3', 'approver');
    insertInviteOutbound(session.id, 'inv-4', 'ou_m4', 'approver');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(3); // 3 cards sent; the 4th is over the per-scope window
    const rl = getDb()
      .prepare("SELECT COUNT(*) AS c FROM dm_audit WHERE scope_id = ? AND reason = 'rate_limited'")
      .get(session.id) as { c: number };
    expect(rl.c).toBe(1);
  });

  it('full e2e: invite → click mints grant → slot appears in discovery → send_roster_dm delivers', async () => {
    const session = groupSession();
    const calls: DeliverCall[] = [];
    fakeAdapter(true, calls);

    // 1. Invite — captures the host-stamped opt-in card payload.
    insertInviteOutbound(session.id, 'inv-1', NEW_MEMBER, 'approver');
    await deliverSessionMessages(session);
    const cardPayload = JSON.parse(calls[0].content) as { optIn: unknown };
    calls.length = 0;

    // 2. The member clicks the card — the SAME parser the real feishu card-action
    //    handler uses round-trips the host-stamped payload, then mints the grant.
    const optIn = parseRosterOptIn(cardPayload.optIn);
    expect(optIn).not.toBeNull();
    const consent = captureDirectedCardConsent({
      optIn: optIn as NonNullable<typeof optIn>,
      operatorOpenId: NEW_MEMBER,
      inboundMsgId: 'action:click',
    });
    expect(consent.ok).toBe(true);

    // 3. Discovery projection now surfaces the slot on the next wake.
    writeRosterSlots('ag-1', session.id);
    const slotDb = new Database(inboundDbPath('ag-1', session.id));
    const slots = slotDb.prepare('SELECT slot_label FROM roster_slots').all() as Array<{ slot_label: string }>;
    slotDb.close();
    expect(slots.map((s) => s.slot_label)).toEqual(['approver']);

    // 4. send_roster_dm addressed to the slot delivers to the consented member's p2p.
    insertRosterOutbound(session.id, 'send-1', { slot: 'approver' });
    await deliverSessionMessages(session);
    const sendCall = calls.find((c) => c.platformId === `feishu:p2p:${NEW_MEMBER}`);
    expect(sendCall).toBeDefined();
    expect(readDelivered(session.id, 'send-1')?.status).toBe('delivered');
  });
});

// --- red-team hardening (adversarial audit 2026-06-15) ----------------------
// Three bugs a 5-lens red-team (3-skeptic verified) confirmed against the merged
// roster surface; each test fails on the pre-fix code and passes after the fix:
//   #1 (critical) container-FORGED opt-in consent card on a plain channel row,
//                 bypassing handleRosterInvite (the documented only card builder)
//   #2 (medium)   a revoke landing during the membership/gateway await was missed
//                 because reserveRosterSend didn't re-check revoked_at
//   #3 (high)     a non-timeout failure on a RETRY rolled back a KEPT (already-
//                 charged, possibly-delivered) reservation → duplicate send
describe('red-team hardening (audit 2026-06-15)', () => {
  /** A NON-roster (kind='chat') outbound row with arbitrary content — the
   *  raw-DB write a compromised container uses to bypass the curated MCP tools. */
  function insertChatOutbound(sessionId: string, msgId: string, content: unknown, platformId = ORIGIN_GROUP): void {
    const db = new Database(outboundDbPath('ag-1', sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', ?, 'feishu', ?)`,
    ).run(msgId, platformId, JSON.stringify(content));
    db.close();
  }

  const forgedOptIn = (over: Record<string, unknown> = {}) => ({
    kind: 'roster.optin',
    scopeId: 'attacker-scope',
    slotLabel: 'approver',
    agentGroupId: 'ag-1',
    expectedUserId: 'ou_victim',
    expiresAt: '2099-01-01T00:00:00Z',
    maxSends: 9999,
    ...over,
  });

  it('#1: a container-forged opt-in card (content.type=roster_invite) on a plain channel row is rejected — host-built only', async () => {
    const session = rootSession2();
    insertChatOutbound(session.id, 'out-forge', { type: 'roster_invite', slotLabel: 'approver', optIn: forgedOptIn() });

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
    });
    await deliverSessionMessages(session);

    expect(calls).toBe(0); // never reaches the adapter → no consent card posted
    expect(readDelivered(session.id, 'out-forge')?.status).toBe('failed');
    expect(lastAudit(session.id)?.reason).toBe('forged_optin_card');
  });

  it('#1: the guard also catches a roster.optin payload smuggled under a different content.type (defense in depth)', async () => {
    const session = rootSession2();
    insertChatOutbound(session.id, 'out-forge2', { type: 'card', optIn: forgedOptIn() });

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
    });
    await deliverSessionMessages(session);

    expect(calls).toBe(0);
    expect(lastAudit(session.id)?.reason).toBe('forged_optin_card');
  });

  it('#2: a revoke landing DURING the membership await is honored — the DM is NOT delivered post-revocation', async () => {
    process.env.ROSTER_VERIFY_MEMBERSHIP = 'true';
    const session = rootSession2();
    mintGrant2(session.id, { originPlatformId: ORIGIN_GROUP });
    insertRosterOutbound(session.id, 'out-roster', { slot: 'reviewer' });

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'plat-1';
      },
      async isMember() {
        // Simulate a concurrent opt-out/leave landing while delivery is parked on
        // this membership await: revoke the grant, then report the participant is
        // STILL a member — so only reserveRosterSend's revoked_at backstop can
        // stop the send (the membership gate itself is satisfied).
        revokeScope(session.id);
        return true;
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toBe(0); // reserveRosterSend rejects the now-revoked grant
    expect(readDelivered(session.id, 'out-roster')?.status).toBe('failed');
  });

  it('#3: a non-timeout failure on a RETRY does NOT roll back a kept (carried-over) reservation — no duplicate send', async () => {
    const root = rootSession2();
    mintGrant2(root.id, { maxSends: 3 });
    const grantId = getBySlot(root.id, 'reviewer')!.id;
    const deploy = resolveDeployQuota();
    const keys = { grant: grantId, scope: root.id, participant: PARTICIPANT, deploy: deploy.key };

    // Simulate a PRIOR tick that reserved then TIMED OUT (reservation deliberately
    // kept, because a timeout is at-least-once and may already have delivered).
    const prior = reserveRosterSend('out-roster', grantId, keys, DEFAULT_RATE_WINDOWS, deploy);
    expect(prior.ok && prior.fresh).toBe(true);
    expect(getBySlot(root.id, 'reviewer')?.sends_used).toBe(1);

    // The retry tick drains the SAME message; the adapter now fails with a
    // NON-timeout error. The standing reservation must be KEPT — rolling it back
    // would un-count the (possibly-delivered) prior send, re-open budget, and let
    // the next tick re-reserve fresh and deliver a DUPLICATE.
    insertRosterOutbound(root.id, 'out-roster', { slot: 'reviewer' });
    setDeliveryAdapter({
      async deliver() {
        throw new Error('channel boom on retry');
      },
    });
    await deliverSessionMessages(root);

    expect(readDelivered(root.id, 'out-roster')?.status).toBe('failed');
    expect(getBySlot(root.id, 'reviewer')?.sends_used).toBe(1); // kept at 1, NOT rolled back to 0
    expect(hasRosterReservation('out-roster')).toBe(true); // marker kept → retry reuses it, no re-charge
  });
});
