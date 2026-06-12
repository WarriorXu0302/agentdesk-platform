/**
 * Feishu roster-DM consent capture (ADR-0023). Host-side; called from the
 * Feishu adapter's message-receive and card-action handlers when the inbound
 * payload is a roster opt-in. Writes the grant into the central v2.db
 * (host-single-writer) — the Feishu adapter itself never touches grant state.
 *
 * Two — and only two — consent sources are minted here:
 *
 *   (a) 'p2p-ingress'  — the participant sent the bot a DIRECT (p2p) message
 *                        carrying a roster opt-in. The open_id is taken from
 *                        `sender.sender_id.open_id` of THAT inbound event.
 *
 *   (b) 'directed-card'— the participant clicked a card whose `expectedUserId`
 *                        was set to their OWN member open_id. The card action is
 *                        validated fail-closed via cardActionOperatorAllowed
 *                        (an empty expectedUserId means "anyone can click" and
 *                        is rejected here — a roster card MUST be member-scoped).
 *
 * Hard rules (R1, R2):
 *   - consent NEVER derives from an a2a origin or any accumulated cross-session
 *     identity — only from the open_id of the direct channel-ingress action.
 *   - participant_open_id + dm_platform_id are derived atomically from the SAME
 *     open_id via parseConsentTarget (round-trip asserted). union_id / user_id /
 *     chat_id are rejected.
 *   - a GROUP-chat join only records intent (a log line); it NEVER mints a grant
 *     and NEVER creates a p2p messaging group (no chat_id → p2p channel minting).
 */
import { log } from '../../log.js';
import { getMessagingGroupByPlatform, createMessagingGroup } from '../../db/messaging-groups.js';
import { insertDmGrant } from '../../db/dm-grants.js';
import { parseConsentTarget } from '../../roster-dm.js';
import { cardActionOperatorAllowed } from '../feishu.js';
import { isRecord, readString } from './primitives.js';

export interface RosterOptInPayload {
  /** Discriminator inside a card action value or a parsed p2p command. */
  kind: 'roster.optin';
  scopeId: string;
  slotLabel: string;
  agentGroupId: string;
  /** Card-only: the member open_id the card was scoped to (fail-closed match). */
  expectedUserId?: string;
  /** Optional absolute expiry (ISO-8601 UTC). */
  expiresAt?: string;
  /** Optional per-grant total-send cap. */
  maxSends?: number;
}

/**
 * Parse a roster opt-in payload out of an arbitrary record (card action value
 * or decoded p2p command JSON). Returns null when the shape doesn't match —
 * callers treat null as "not a roster opt-in" and fall through to normal
 * handling. scopeId / slotLabel / agentGroupId are all required; without a
 * host-meaningful scope binding there is nothing to consent to.
 */
export function parseRosterOptIn(value: unknown): RosterOptInPayload | null {
  if (!isRecord(value)) return null;
  if (value.kind !== 'roster.optin') return null;
  const scopeId = readString(value.scopeId);
  const slotLabel = readString(value.slotLabel);
  const agentGroupId = readString(value.agentGroupId);
  if (!scopeId || !slotLabel || !agentGroupId) return null;
  const expectedUserId = readString(value.expectedUserId);
  const expiresAt = readString(value.expiresAt);
  const maxSends =
    typeof value.maxSends === 'number' && Number.isFinite(value.maxSends) && value.maxSends > 0
      ? Math.floor(value.maxSends)
      : undefined;
  return { kind: 'roster.optin', scopeId, slotLabel, agentGroupId, expectedUserId, expiresAt, maxSends };
}

/**
 * Ensure a p2p messaging group exists for a consented open_id so the delivery
 * gate's getMessagingGroupByPlatform resolves to is_group=0. Safe to create
 * ONLY from a legitimate p2p / directed-card consent source — the open_id came
 * from a direct channel-ingress action, not from group context. We never mint
 * this from a chat_id. Idempotent.
 */
function ensureP2pMessagingGroup(dmPlatformId: string, now: string): void {
  const existing = getMessagingGroupByPlatform('feishu', dmPlatformId);
  if (existing) return;
  createMessagingGroup({
    id: `mg-roster-${dmPlatformId.replace(/[^a-zA-Z0-9_]/g, '_')}`,
    channel_type: 'feishu',
    platform_id: dmPlatformId,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
}

export interface ConsentResult {
  ok: boolean;
  reason?: string;
  grantId?: string;
}

/**
 * Capture consent from a DIRECT (p2p) inbound message. `senderOpenId` MUST be
 * the open_id from `event.sender.sender_id.open_id` of the same inbound event
 * that carried the opt-in. `isGroup` guards R2: a group-chat message records
 * intent only and mints nothing.
 */
export function captureP2pIngressConsent(args: {
  optIn: RosterOptInPayload;
  senderOpenId: string | undefined;
  inboundMsgId: string;
  isGroup: boolean;
  originUserId?: string | null;
  /**
   * Source group platform id (`feishu:<chat_id>`) the consent was given in, for
   * leave-revoke (item 11b). For a pure p2p opt-in there is no group to leave,
   * so callers pass null/omit — those grants are torn down only by explicit
   * opt-out or scope finish. A group-chat consent is rejected upstream anyway
   * (group_intent_only), so in practice this stays null for p2p-ingress.
   */
  originPlatformId?: string | null;
  now?: Date;
}): ConsentResult {
  if (args.isGroup) {
    // Group-chat join: record intent only. Never mint a grant, never create a
    // p2p channel from group context (R2).
    log.info('roster-dm: group-chat join intent recorded (no grant minted)', {
      scopeId: args.optIn.scopeId,
      slotLabel: args.optIn.slotLabel,
      agentGroupId: args.optIn.agentGroupId,
    });
    return { ok: false, reason: 'group_intent_only' };
  }
  const target = parseConsentTarget(args.senderOpenId);
  if (!target) {
    log.warn('roster-dm: p2p consent rejected — sender open_id failed atomic derivation', {
      scopeId: args.optIn.scopeId,
      slotLabel: args.optIn.slotLabel,
    });
    return { ok: false, reason: 'bad_open_id' };
  }
  return mintGrant({
    optIn: args.optIn,
    target,
    consentSource: 'p2p-ingress',
    inboundMsgId: args.inboundMsgId,
    originUserId: args.originUserId ?? null,
    originPlatformId: args.originPlatformId ?? null,
    now: args.now,
  });
}

/**
 * Capture consent from a DIRECTED card click. The card MUST have been scoped to
 * the participant's own member open_id (`expectedUserId`); we re-run the
 * fail-closed operator check here so an empty/mismatched expectedUserId can
 * never produce a grant (R2). `operatorOpenId` MUST be the card action
 * operator's open_id.
 */
export function captureDirectedCardConsent(args: {
  optIn: RosterOptInPayload;
  operatorOpenId: string | undefined;
  inboundMsgId: string;
  originUserId?: string | null;
  /**
   * Source group platform id (`feishu:<chat_id>`) the card was clicked in, for
   * leave-revoke (item 11b). A directed card is typically posted in a group, so
   * the host passes `feishu:<context.chat_id>`; null when there's no group
   * context.
   */
  originPlatformId?: string | null;
  now?: Date;
}): ConsentResult {
  const expectedUserId = args.optIn.expectedUserId;
  // Roster cards MUST be member-scoped: an empty expectedUserId means the card
  // is clickable by anyone, which we refuse to turn into a consent grant.
  if (!expectedUserId) {
    log.warn('roster-dm: directed-card consent rejected — card not scoped to a member (empty expectedUserId)', {
      scopeId: args.optIn.scopeId,
      slotLabel: args.optIn.slotLabel,
    });
    return { ok: false, reason: 'unscoped_card' };
  }
  const operator = args.operatorOpenId ?? '';
  if (!cardActionOperatorAllowed(expectedUserId, operator)) {
    log.warn('roster-dm: directed-card consent rejected — operator identity unconfirmed or mismatched', {
      scopeId: args.optIn.scopeId,
      expectedUserId,
      operatorOpenId: operator || null,
    });
    return { ok: false, reason: 'operator_mismatch' };
  }
  // Derive the target from the operator's open_id (the confirmed clicker),
  // which equals expectedUserId at this point. parseConsentTarget rejects any
  // non-open_id form.
  const target = parseConsentTarget(operator);
  if (!target) {
    return { ok: false, reason: 'bad_open_id' };
  }
  return mintGrant({
    optIn: args.optIn,
    target,
    consentSource: 'directed-card',
    inboundMsgId: args.inboundMsgId,
    originUserId: args.originUserId ?? null,
    originPlatformId: args.originPlatformId ?? null,
    now: args.now,
  });
}

function mintGrant(args: {
  optIn: RosterOptInPayload;
  target: { participantOpenId: string; dmPlatformId: string; channelType: 'feishu' };
  consentSource: 'p2p-ingress' | 'directed-card';
  inboundMsgId: string;
  originUserId: string | null;
  originPlatformId: string | null;
  now?: Date;
}): ConsentResult {
  const now = args.now ?? new Date();
  ensureP2pMessagingGroup(args.target.dmPlatformId, now.toISOString());
  const grantId = insertDmGrant({
    scopeId: args.optIn.scopeId,
    agentGroupId: args.optIn.agentGroupId,
    slotLabel: args.optIn.slotLabel,
    participantOpenId: args.target.participantOpenId,
    dmPlatformId: args.target.dmPlatformId,
    channelType: args.target.channelType,
    consentSource: args.consentSource,
    consentInboundMsgId: args.inboundMsgId,
    consentOriginUserId: args.originUserId,
    originPlatformId: args.originPlatformId,
    maxSends: args.optIn.maxSends,
    expiresAt: args.optIn.expiresAt ?? null,
    now,
  });
  if (!grantId) {
    log.warn('roster-dm: grant insert rejected (slot or participant already occupied in scope)', {
      scopeId: args.optIn.scopeId,
      slotLabel: args.optIn.slotLabel,
    });
    return { ok: false, reason: 'slot_or_participant_taken' };
  }
  log.info('roster-dm: consent grant minted', {
    grantId,
    scopeId: args.optIn.scopeId,
    slotLabel: args.optIn.slotLabel,
    consentSource: args.consentSource,
    dmPlatformId: args.target.dmPlatformId,
  });
  return { ok: true, grantId };
}
