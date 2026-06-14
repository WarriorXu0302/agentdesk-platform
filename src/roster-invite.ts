/**
 * Roster-DM opt-in INVITE handler (ADR-0044 Stage 3) — the third, most sensitive
 * leg of the host-mediated send/discover/invite triple.
 *
 * The container's invite_to_roster tool writes a thin `kind='system'`
 * `{action:'roster.invite', member, slotLabel}` row. This handler (registered as
 * a delivery action) decides EVERYTHING: it re-derives the scope + agent group
 * from the session, validates the target, requires current group membership,
 * suppresses re-invites, rate-limits, and STAMPS + sends the directed consent
 * card. The container authors none of those security-critical fields.
 *
 * Invite is a NEW-CONTACT vector — it posts a consent card to someone with no
 * grant yet — so its bar is deliberately STRICTER than the send gate
 * (deliverRosterMessage): membership is mandatory (unknown also rejects), each
 * (scope, member) is invited at most once ever, and the card carries a 24h
 * expiry so a stale click can't mint a live grant days later.
 *
 * ── LOAD-BEARING INVARIANT (do not weaken) ────────────────────────────────
 * captureDirectedCardConsent (channels/feishu/roster-consent.ts) TRUSTS the
 * `expectedUserId` and `scopeId` carried in the card's action value — it does
 * NOT re-derive them when a click arrives. Therefore the card-BUILD path MUST
 * stay host-controlled, and THIS handler is the ONLY place that builds a roster
 * opt-in card. Any future code that constructs a roster.optin card outside this
 * handler would let a container choose the grant's scope + audience, blowing
 * open R2 (atomic identity) and R4 (per-scope key). See ADR-0044 + ADR-0023.
 * ───────────────────────────────────────────────────────────────────────────
 */
import type Database from 'better-sqlite3';

import { getDeliveryAdapter, registerDeliveryAction } from './delivery.js';
import { recordDmAudit } from './db/dm-audit.js';
import { checkInviteRate, getByParticipant, recordInviteConsumption, resolveDeployQuota } from './db/dm-grants.js';
import { log } from './log.js';
import { rosterInviteRejectedTotal } from './metrics.js';
import {
  hostScopeForSession,
  isRootSessionModeForRosterDm,
  originGroupForSession,
  parseConsentTarget,
  rosterDmEnabledForGroup,
} from './roster-dm.js';
import type { Session } from './types.js';

/**
 * Directed-card TTL. The opt-in card mints a grant whose `expires_at` is
 * now+24h, so a card clicked AFTER 24h mints an already-expired (dead-on-arrival)
 * grant that the live-check / discovery projection both treat as not deliverable.
 */
const INVITE_CARD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Handle a `roster.invite` system action. Never throws: a guard rejection is a
 * PERMANENT refusal (retrying re-runs the same guards), so we audit + count +
 * return, letting the kind='system' row be consumed rather than re-driven. Only
 * genuinely transient adapter failures are swallowed-and-logged (the agent can
 * re-invite later); the invite budget stays charged either way (conservative).
 */
export async function handleRosterInvite(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  // (2) scopeId + agentGroupId are HOST-derived from the session. We NEVER read
  // them from `content` — even if the container wrote scopeId/agentGroupId there,
  // they are ignored (R4 unguessable per-scope key, R2 audience binding).
  const agentGroupId = session.agent_group_id;
  const scopeId = hostScopeForSession(session);

  const reject = (reason: string, extra: Record<string, unknown> = {}): void => {
    rosterInviteRejectedTotal.labels(reason).inc();
    recordDmAudit({ scopeId, agentGroupId, sessionId: session.id, decision: 'rejected', reason, ...extra });
    log.warn('roster-invite rejected', { reason, scopeId, agentGroupId, sessionId: session.id, ...extra });
  };

  // (1) fail-closed: roster DM enabled AND root-session mode (same bar the send
  // gate enforces at delivery time — a config-time assert nothing calls at
  // runtime is no enforcement).
  if (!rosterDmEnabledForGroup(agentGroupId)) return reject('flag_disabled');
  if (!isRootSessionModeForRosterDm(agentGroupId)) return reject('agent_shared_mode');

  // The origin group must resolve to exactly ONE feishu group chat — both to
  // post the card into and to check membership against. Ambiguous / non-group /
  // missing → fail closed (do not guess which group; ADR-0044 multi-group note).
  const origin = originGroupForSession(session);
  if (!origin) return reject('ambiguous_origin');

  // (3) target shape: parseConsentTarget rejects anything that isn't a real p2p
  // open_id (ou_…) — group chat ids, union_id, user_id all fail (R2).
  const memberRaw = typeof content.member === 'string' ? content.member.trim() : '';
  const target = parseConsentTarget(memberRaw);
  if (!target) return reject('bad_member', { participantOpenId: memberRaw || null });
  const member = target.participantOpenId;

  const slotLabel = typeof content.slotLabel === 'string' && content.slotLabel.trim() ? content.slotLabel.trim() : null;
  if (!slotLabel) return reject('bad_slot', { participantOpenId: member });

  // (4) one-shot per (scope, member): ANY existing grant row — LIVE or already
  // revoked / opted-out — suppresses a re-invite. This is a harassment guard, not
  // a rate limit: a person who already chose (in OR out) is never re-asked.
  if (getByParticipant(scopeId, member)) {
    return reject('already_invited', { participantOpenId: member, slotLabel });
  }

  // (5) membership: the target MUST be a CURRENT member of the origin group, or
  // we fail closed. undefined/unknown ALSO rejects — for a new-contact vector the
  // bar is absolute (the send path may fall back to item-11 revokes on unknown;
  // invite may not, because there is no grant yet to revoke).
  const adapter = getDeliveryAdapter();
  if (!adapter) return reject('no_adapter', { participantOpenId: member, slotLabel });
  let isMember: boolean | undefined;
  try {
    isMember = adapter.isMember ? await adapter.isMember(origin.channelType, origin.platformId, member) : undefined;
  } catch (err) {
    log.warn('roster-invite isMember threw — treating as unknown (reject)', { scopeId, err });
    isMember = undefined;
  }
  if (isMember !== true) {
    return reject('not_member', { participantOpenId: member, slotLabel, dmPlatformId: origin.platformId });
  }

  // Rate limit, charged BEFORE building/sending the card (ADR-0044): per-scope
  // 60s/3 window + the deployment daily cap. An over-limit invite rejects here.
  const deploy = resolveDeployQuota();
  if (!checkInviteRate(scopeId, deploy).allowed) {
    return reject('rate_limited', { participantOpenId: member, slotLabel });
  }
  recordInviteConsumption(scopeId, deploy);

  // HOST-STAMPED directed consent card. Every security-critical field is set
  // here from host-derived values — the container supplied ONLY `member`
  // (validated to ou_…) and a slot label. See the LOAD-BEARING INVARIANT above.
  const optIn = {
    kind: 'roster.optin' as const,
    scopeId,
    slotLabel,
    agentGroupId,
    // Only THIS member's click mints consent (captureDirectedCardConsent runs
    // cardActionOperatorAllowed against expectedUserId, fail-closed).
    expectedUserId: member,
    // Host-stamped 24h expiry — a card clicked later mints a dead grant.
    expiresAt: new Date(Date.now() + INVITE_CARD_TTL_MS).toISOString(),
  };
  try {
    await adapter.deliver(
      origin.channelType,
      origin.platformId,
      null, // post into the group, not a thread
      'roster.invite',
      JSON.stringify({ type: 'roster_invite', slotLabel, optIn }),
    );
  } catch (err) {
    // Best-effort: a failed card send is logged but NOT retried (would re-run
    // guards + re-charge) and NOT rolled back (budget stays charged). The agent
    // can re-invite later. We do not throw, so the system row is consumed.
    log.warn('roster-invite card send failed', { scopeId, slotLabel, err });
    return;
  }

  recordDmAudit({
    scopeId,
    agentGroupId,
    sessionId: session.id,
    slotLabel,
    participantOpenId: member,
    dmPlatformId: origin.platformId,
    decision: 'delivered',
  });
  log.info('roster-invite card sent', { scopeId, slotLabel });
}

registerDeliveryAction('roster.invite', handleRosterInvite);
