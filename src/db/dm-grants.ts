/**
 * Roster directed-message grants — host-side access layer (ADR-0023).
 *
 * Every function here runs on the host against the central v2.db (WAL,
 * host-single-writer). v2.db is never mounted into a container, so the agent
 * runner has no handle to these tables: consent capture, the live revoke/expiry
 * re-check, the rate ledger, and the total-volume cap are all enforced on the
 * trusted side of the mount boundary.
 *
 * Time discipline: every timestamp is written as an ISO-8601 UTC string
 * (`new Date().toISOString()`), and every comparison parses with the same
 * UTC-anchored parser the host sweep uses (`parseSqliteUtc`). We NEVER read a
 * container-supplied timestamp here.
 *
 * Style mirrors src/db/inbound-ingress.ts: thin, parameterized, no ORM.
 */
import { randomUUID } from 'crypto';

import { readEnvFile } from '../env.js';
import { parseSqliteUtc } from '../host-sweep.js';
import { getDb } from './connection.js';
import { recordEnterpriseAudit } from './enterprise-audit.js';

export type DmConsentSource = 'p2p-ingress' | 'directed-card';

/** consent_source values the delivery gate accepts. Anything else fails closed. */
export const ALLOWED_CONSENT_SOURCES: readonly DmConsentSource[] = ['p2p-ingress', 'directed-card'];

export interface DmGrantRow {
  id: string;
  scope_id: string;
  agent_group_id: string;
  slot_label: string;
  participant_open_id: string;
  dm_platform_id: string;
  channel_type: string;
  consent_source: DmConsentSource;
  consent_inbound_msg_id: string;
  consent_origin_user_id: string | null;
  /**
   * The `feishu:<chat_id>` of the group the participant was acting in when they
   * consented, or null for a pure p2p opt-in with no group context (item 11b).
   * NEVER a routing field — routing authority is dm_platform_id. Used only to
   * scope a platform leave/disband revoke to the chat the participant left.
   */
  origin_platform_id: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  max_sends: number;
  sends_used: number;
}

export interface InsertDmGrantArgs {
  scopeId: string;
  agentGroupId: string;
  slotLabel: string;
  participantOpenId: string;
  dmPlatformId: string;
  channelType?: string;
  consentSource: DmConsentSource;
  consentInboundMsgId: string;
  consentOriginUserId?: string | null;
  /** Source group platform id (`feishu:<chat_id>`) for leave-revoke (item 11b). Null for pure p2p. */
  originPlatformId?: string | null;
  /** Total messages this grant may ever send before it auto-revokes. <=0 disables the cap. */
  maxSends?: number;
  /** Optional absolute expiry. ISO-8601 UTC string. */
  expiresAt?: string | null;
  now?: Date;
}

/**
 * Record a consented grant. Upsert on (scope_id, slot_label): re-consent by the
 * SAME participant for the same slot refreshes the grant; a DIFFERENT
 * participant cannot steal an occupied slot because the UNIQUE(scope_id,
 * participant_open_id) constraint also guards cross-slot collisions. Returns the
 * grant id, or null if a constraint rejected the insert (e.g. the participant
 * already holds a different slot in this scope).
 *
 * The caller (feishu consent hook) MUST have already:
 *   - parsed participant_open_id + dm_platform_id atomically from one inbound
 *     event and asserted they resolve to the same open_id (R2);
 *   - confirmed consent_source is a channel-ingress action, never an a2a origin
 *     (R1).
 */
export function insertDmGrant(args: InsertDmGrantArgs): string | null {
  const id = randomUUID();
  const now = (args.now ?? new Date()).toISOString();
  const channelType = args.channelType ?? 'feishu';
  const maxSends = args.maxSends && args.maxSends > 0 ? Math.floor(args.maxSends) : 0;
  try {
    getDb()
      .prepare(
        `INSERT INTO dm_grants
           (id, scope_id, agent_group_id, slot_label, participant_open_id, dm_platform_id,
            channel_type, consent_source, consent_inbound_msg_id, consent_origin_user_id,
            origin_platform_id, created_at, expires_at, revoked_at, max_sends, sends_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)
         ON CONFLICT(scope_id, slot_label) DO UPDATE SET
           participant_open_id    = excluded.participant_open_id,
           dm_platform_id         = excluded.dm_platform_id,
           channel_type           = excluded.channel_type,
           consent_source         = excluded.consent_source,
           consent_inbound_msg_id = excluded.consent_inbound_msg_id,
           consent_origin_user_id = excluded.consent_origin_user_id,
           origin_platform_id     = excluded.origin_platform_id,
           expires_at             = excluded.expires_at,
           revoked_at             = NULL
         WHERE dm_grants.participant_open_id = excluded.participant_open_id`,
      )
      .run(
        id,
        args.scopeId,
        args.agentGroupId,
        args.slotLabel,
        args.participantOpenId,
        args.dmPlatformId,
        channelType,
        args.consentSource,
        args.consentInboundMsgId,
        args.consentOriginUserId ?? null,
        args.originPlatformId ?? null,
        now,
        args.expiresAt ?? null,
        maxSends,
      );
  } catch {
    // UNIQUE(scope_id, participant_open_id) violation — this participant already
    // holds a DIFFERENT slot in this scope. Fail closed: do not mint a second grant.
    return null;
  }
  // Determine the outcome by reading the resulting slot row:
  //   - fresh insert            → row.id === id (new uuid), participant matches.
  //   - same-participant refresh → conflict-update fired, row keeps its OLD id
  //     but participant matches → still a success (consent refreshed).
  //   - different-participant on an occupied slot → conflict-update WHERE clause
  //     did not match, the old row (a different participant) is untouched → reject.
  const row = getBySlot(args.scopeId, args.slotLabel);
  if (!row) return null;
  if (row.participant_open_id !== args.participantOpenId) return null;
  // Audit the consent grant (roadmap 5.7): dm_audit records each DELIVERY
  // decision, but reconstructing "when was consent granted, by whom" needs the
  // grant lifecycle in enterprise_audit too. Actor is the real consenting user.
  recordEnterpriseAudit({
    eventType: 'roster_grant_created',
    agentGroupId: args.agentGroupId,
    actor: args.consentOriginUserId ?? null,
    details: {
      grantId: row.id,
      scopeId: args.scopeId,
      slotLabel: args.slotLabel,
      participantOpenId: args.participantOpenId,
      expiresAt: args.expiresAt ?? null,
    },
  });
  return row.id;
}

export function getBySlot(scopeId: string, slotLabel: string): DmGrantRow | undefined {
  return getDb().prepare('SELECT * FROM dm_grants WHERE scope_id = ? AND slot_label = ?').get(scopeId, slotLabel) as
    | DmGrantRow
    | undefined;
}

export function getByParticipant(scopeId: string, participantOpenId: string): DmGrantRow | undefined {
  return getDb()
    .prepare('SELECT * FROM dm_grants WHERE scope_id = ? AND participant_open_id = ?')
    .get(scopeId, participantOpenId) as DmGrantRow | undefined;
}

export function listGrantsForScope(scopeId: string): DmGrantRow[] {
  return getDb()
    .prepare('SELECT * FROM dm_grants WHERE scope_id = ? ORDER BY created_at ASC')
    .all(scopeId) as DmGrantRow[];
}

/** All live (non-revoked) grants a participant currently holds, across scopes. */
export function listLiveGrantsForParticipant(participantOpenId: string): DmGrantRow[] {
  return getDb()
    .prepare('SELECT * FROM dm_grants WHERE participant_open_id = ? AND revoked_at IS NULL')
    .all(participantOpenId) as DmGrantRow[];
}

/**
 * Is this grant deliverable right now? Re-evaluated inside the delivery
 * critical section before EVERY adapter call (incl. each retry) and again
 * before markDelivered (R5). Returns a reason on rejection for the audit row.
 *
 * Checks, in order: row present, consent_source allow-listed, scope match,
 * not revoked, not expired (host clock), total-volume cap not reached.
 */
export type DmGrantLiveResult =
  | { ok: true; grant: DmGrantRow }
  | { ok: false; reason: 'no_grant' | 'bad_consent_source' | 'scope_mismatch' | 'revoked' | 'expired' | 'max_sends' };

export function checkGrantLive(scopeId: string, slotLabel: string, now: Date = new Date()): DmGrantLiveResult {
  const grant = getBySlot(scopeId, slotLabel);
  if (!grant) return { ok: false, reason: 'no_grant' };
  if (!ALLOWED_CONSENT_SOURCES.includes(grant.consent_source)) {
    return { ok: false, reason: 'bad_consent_source' };
  }
  if (grant.scope_id !== scopeId) return { ok: false, reason: 'scope_mismatch' };
  if (grant.revoked_at) return { ok: false, reason: 'revoked' };
  if (grant.expires_at && parseSqliteUtc(grant.expires_at) <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  if (grant.max_sends > 0 && grant.sends_used >= grant.max_sends) {
    return { ok: false, reason: 'max_sends' };
  }
  return { ok: true, grant };
}

/**
 * Increment sends_used for a grant and auto-revoke when it reaches max_sends.
 * Returns the post-increment row. Called only AFTER a roster DM is actually
 * accepted for delivery. Single statement so the increment + auto-revoke can't
 * interleave with a concurrent drain.
 *
 * Now wrapped by reserveRosterSend (the reserve-before-send path, ADR-0023
 * concurrency fix). Kept exported for the conditional/atomic increment used
 * there and because callers/tests reference its shape; do NOT call it on the
 * post-success path anymore — accounting is now a pre-send reservation.
 */
export function incrementSends(grantId: string, now: Date = new Date()): DmGrantRow | undefined {
  const nowIso = now.toISOString();
  getDb()
    .prepare(
      `UPDATE dm_grants
         SET sends_used = sends_used + 1,
             revoked_at = CASE
               WHEN max_sends > 0 AND sends_used + 1 >= max_sends THEN COALESCE(revoked_at, ?)
               ELSE revoked_at
             END
         WHERE id = ?`,
    )
    .run(nowIso, grantId);
  return getDb().prepare('SELECT * FROM dm_grants WHERE id = ?').get(grantId) as DmGrantRow | undefined;
}

/**
 * Revoke every grant in a scope (scope finish / explicit revoke). Idempotent —
 * already-revoked rows keep their original revoked_at. Returns the number of
 * rows newly revoked.
 */
export function revokeScope(scopeId: string, now: Date = new Date()): number {
  const nowIso = now.toISOString();
  const changes = getDb()
    .prepare('UPDATE dm_grants SET revoked_at = ? WHERE scope_id = ? AND revoked_at IS NULL')
    .run(nowIso, scopeId).changes;
  if (changes > 0) {
    recordEnterpriseAudit({
      eventType: 'roster_grant_revoked',
      details: { scopeId, revoked: changes, reason: 'scope_revoked' },
    });
  }
  return changes;
}

/**
 * Revoke a single participant's live grant in one scope (item 11a, explicit
 * opt-out). The participant DM'd the bot a leave/opt-out command, or clicked an
 * "exit" card; the host tears down only THAT participant's grant in THAT scope.
 * Idempotent. Returns the number of rows newly revoked (0 or 1, given the
 * UNIQUE(scope_id, participant_open_id) constraint).
 */
export function revokeParticipantInScope(scopeId: string, participantOpenId: string, now: Date = new Date()): number {
  const changes = getDb()
    .prepare(
      'UPDATE dm_grants SET revoked_at = ? WHERE scope_id = ? AND participant_open_id = ? AND revoked_at IS NULL',
    )
    .run(now.toISOString(), scopeId, participantOpenId).changes;
  if (changes > 0) {
    recordEnterpriseAudit({
      eventType: 'roster_grant_revoked',
      actor: participantOpenId,
      details: { scopeId, participantOpenId, revoked: changes, reason: 'participant_opt_out' },
    });
  }
  return changes;
}

/**
 * Revoke every live grant a leaver held that was consented in the chat they
 * just left (item 11b, best-effort platform leave/disband event). Matches on
 * (origin_platform_id = the chat they left) AND (participant_open_id = the
 * leaver). Pure-p2p grants (origin_platform_id IS NULL) are intentionally NOT
 * touched — there is no "leaving" a p2p conversation with the bot; those are
 * torn down by explicit opt-out or scope finish only. Idempotent. Returns the
 * count newly revoked.
 *
 * On `im.chat.disbanded_v1` there is no single leaver, so callers pass
 * participantOpenId = null to revoke ALL live grants whose origin was that chat.
 */
export function revokeGrantsForLeaver(
  originPlatformId: string,
  participantOpenId: string | null,
  now: Date = new Date(),
): number {
  const nowIso = now.toISOString();
  const changes = participantOpenId
    ? getDb()
        .prepare(
          `UPDATE dm_grants SET revoked_at = ?
           WHERE origin_platform_id = ? AND participant_open_id = ? AND revoked_at IS NULL`,
        )
        .run(nowIso, originPlatformId, participantOpenId).changes
    : // Disband: revoke every live grant whose origin was this chat.
      getDb()
        .prepare('UPDATE dm_grants SET revoked_at = ? WHERE origin_platform_id = ? AND revoked_at IS NULL')
        .run(nowIso, originPlatformId).changes;
  if (changes > 0) {
    recordEnterpriseAudit({
      eventType: 'roster_grant_revoked_by_platform_event',
      actor: participantOpenId,
      details: {
        originPlatformId,
        participantOpenId,
        revoked: changes,
        event: participantOpenId ? 'member_left' : 'chat_disbanded',
      },
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Multi-key sliding-window rate limit (R5)
// ---------------------------------------------------------------------------

export interface RateWindow {
  /** Window length in seconds. */
  windowSec: number;
  /** Max sends allowed within the window for this key. */
  limit: number;
}

/**
 * Default per-key windows. AND semantics: a send is allowed only if EVERY key
 * is under its limit. Conservative defaults; the deploy bucket is env-tunable
 * via resolveDeployQuota (item 14).
 */
export const DEFAULT_RATE_WINDOWS: Record<'grant' | 'scope' | 'participant' | 'deploy', RateWindow> = {
  grant: { windowSec: 60, limit: 3 },
  participant: { windowSec: 60, limit: 5 },
  scope: { windowSec: 60, limit: 20 },
  deploy: { windowSec: 60, limit: 100 },
};

/**
 * Deployment-level blast-radius quota (item 14). The `deploy` rate key was a
 * hardcoded 60s/100 window keyed on the literal string 'global'. Operators can
 * now tune the per-minute deploy window AND add a separate rolling 24h cap so a
 * compromised agent cannot drip-send under the per-minute limit indefinitely.
 *
 * Resolution mirrors the rest of the host config convention: process env →
 * `.env` → default. Read lazily (per send) so a config reload doesn't require a
 * process bounce and tests can drive it via process.env.
 *
 *   ROSTER_DEPLOY_WINDOW_SEC   per-minute-style window length   (default 60)
 *   ROSTER_DEPLOY_WINDOW_CAP   sends allowed in that window      (default 100)
 *   ROSTER_DEPLOY_DAILY_CAP    sends allowed per rolling 24h     (default 0 = off)
 *   ROSTER_DEPLOY_KEY          deploy ledger key suffix          (default 'global')
 */
function readRosterEnvInt(key: string): number | undefined {
  const fromProc = process.env[key];
  const raw = fromProc !== undefined ? fromProc : readEnvFile([key])[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function readRosterEnvStr(key: string): string | undefined {
  const fromProc = process.env[key];
  const raw = fromProc !== undefined ? fromProc : readEnvFile([key])[key];
  const v = raw?.trim();
  return v ? v : undefined;
}

export interface DeployQuotaConfig {
  /** Ledger key suffix for the deploy bucket (allows partitioning if ever needed). */
  key: string;
  /** Short rolling window (the existing per-minute-style deploy bucket). */
  window: RateWindow;
  /** Rolling 24h cap. limit<=0 disables the daily layer. */
  dailyCap: number;
  dailyWindowSec: number;
}

export function resolveDeployQuota(): DeployQuotaConfig {
  return {
    key: readRosterEnvStr('ROSTER_DEPLOY_KEY') ?? 'global',
    window: {
      windowSec: readRosterEnvInt('ROSTER_DEPLOY_WINDOW_SEC') ?? DEFAULT_RATE_WINDOWS.deploy.windowSec,
      limit: readRosterEnvInt('ROSTER_DEPLOY_WINDOW_CAP') ?? DEFAULT_RATE_WINDOWS.deploy.limit,
    },
    dailyCap: readRosterEnvInt('ROSTER_DEPLOY_DAILY_CAP') ?? 0,
    dailyWindowSec: 86_400,
  };
}

/**
 * Read-only check of the deployment-level daily cap (item 14). Returns blocked
 * when the daily deploy bucket is at/over ROSTER_DEPLOY_DAILY_CAP. This is a
 * TUMBLING window (floored to the dailyWindowSec boundary), not a true sliding
 * 24h sum — cheap and restart-stable. Known edge: up to ~2× the cap can land
 * across a boundary; acceptable for a defense-in-depth blast-radius ceiling
 * (primary controls are consent + per-grant max_sends). The short deploy window
 * is still enforced by checkRateKeys via the same ledger; this adds the
 * long-horizon ceiling. Does NOT mutate — consumption is recorded by
 * recordDeployDailyConsumption only after the send commits.
 */
export function checkDeployDailyCap(quota: DeployQuotaConfig, now: Date = new Date()): RateCheckResult {
  if (quota.dailyCap <= 0) return { allowed: true };
  const ledgerKey = `deploy-daily:${quota.key}`;
  const ws = windowStartIso(now, quota.dailyWindowSec);
  if (currentCount(ledgerKey, ws) >= quota.dailyCap) {
    return { allowed: false, blockedKey: ledgerKey };
  }
  return { allowed: true };
}

/** Persist one unit against the daily deploy bucket (tumbling window, see
 *  checkDeployDailyCap). No-op when the cap is off. */
export function recordDeployDailyConsumption(quota: DeployQuotaConfig, now: Date = new Date()): void {
  if (quota.dailyCap <= 0) return;
  const ws = windowStartIso(now, quota.dailyWindowSec);
  getDb()
    .prepare(
      `INSERT INTO dm_rate_ledger (key, window_start, count)
         VALUES (?, ?, 1)
         ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1`,
    )
    .run(`deploy-daily:${quota.key}`, ws);
}

function windowStartIso(now: Date, windowSec: number): string {
  // Floor the current time to the window boundary so all sends in the same
  // window share a ledger row. Tumbling window (cheap + restart-stable).
  const ms = now.getTime();
  const windowMs = windowSec * 1000;
  return new Date(Math.floor(ms / windowMs) * windowMs).toISOString();
}

function currentCount(key: string, windowStart: string): number {
  const row = getDb()
    .prepare('SELECT count FROM dm_rate_ledger WHERE key = ? AND window_start = ?')
    .get(key, windowStart) as { count: number } | undefined;
  return row?.count ?? 0;
}

export interface RateCheckResult {
  allowed: boolean;
  /** The first key that is at/over its limit (for the audit row). Undefined when allowed. */
  blockedKey?: string;
}

/**
 * Read-only check: would a send be allowed for all of these keys right now?
 * Does NOT mutate the ledger — call recordRateConsumption only after the send
 * is committed for delivery, so a rejected/over-limit attempt never burns quota.
 */
export function checkRateKeys(
  keys: { grant: string; scope: string; participant: string; deploy: string },
  windows: typeof DEFAULT_RATE_WINDOWS = DEFAULT_RATE_WINDOWS,
  now: Date = new Date(),
): RateCheckResult {
  for (const k of ['grant', 'participant', 'scope', 'deploy'] as const) {
    const win = windows[k];
    const ledgerKey = `${k}:${keys[k]}`;
    const ws = windowStartIso(now, win.windowSec);
    if (currentCount(ledgerKey, ws) >= win.limit) {
      return { allowed: false, blockedKey: ledgerKey };
    }
  }
  return { allowed: true };
}

/**
 * Persist one unit of consumption against every key (host single-writer, so the
 * count survives restarts). Called after checkRateKeys passes AND the send is
 * accepted for delivery.
 */
export function recordRateConsumption(
  keys: { grant: string; scope: string; participant: string; deploy: string },
  windows: typeof DEFAULT_RATE_WINDOWS = DEFAULT_RATE_WINDOWS,
  now: Date = new Date(),
): void {
  const stmt = getDb().prepare(
    `INSERT INTO dm_rate_ledger (key, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1`,
  );
  for (const k of ['grant', 'participant', 'scope', 'deploy'] as const) {
    const ws = windowStartIso(now, windows[k].windowSec);
    stmt.run(`${k}:${keys[k]}`, ws);
  }
}

/** Prune ledger rows older than `keepSec` (housekeeping; safe to call any time). */
export function pruneRateLedger(keepSec = 3600, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - keepSec * 1000).toISOString();
  // Reservation markers (sentinel window) and tumbling daily buckets must NOT be
  // pruned by the short-window housekeeping pass — a live reservation is the
  // idempotency key for an in-flight/timed-out message and the daily bucket is a
  // rolling-24h ceiling. Their window_start sorts above any real short-window
  // start (RESERVE_SENTINEL_WINDOW = a far-future ISO string), so the cutoff
  // comparison already excludes them; the explicit guard documents the intent.
  return getDb().prepare("DELETE FROM dm_rate_ledger WHERE window_start < ? AND key NOT LIKE 'reserve:%'").run(cutoff)
    .changes;
}

// ---------------------------------------------------------------------------
// Reserve-before-send accounting (ADR-0023 concurrency + at-least-once fix)
// ---------------------------------------------------------------------------
//
// Background. The original roster-DM gate did "read-only check → await deliver()
// → record". Two independent bugs lived in that gap:
//
//   (#1 TOCTOU) await deliver() yields the event loop. ADR-0016's bounded
//     delivery pool (DELIVERY_CONCURRENCY) drains several sessions at once, and
//     a root+worker pair shares one host scope (hostScopeForSession). Two
//     drains could both pass the read-only max_sends / rate / deploy-daily
//     checks before EITHER recorded — overshooting every cap by up to
//     (concurrency-1), and letting max_sends=1 deliver two DMs to one
//     participant.
//
//   (#4 timeout double-count) withDeliveryTimeout is at-least-once: a timeout
//     may have already been delivered downstream. Recording only on success
//     meant a timed-out-but-delivered message counted 0 and got re-sent next
//     tick — the participant could receive N copies while sends_used < N.
//
// Fix: reserve budget ATOMICALLY before the adapter call. A single SQLite
// transaction conditionally decrements max_sends, every rate-limit key, and the
// daily deploy bucket; if any is over its limit the whole transaction rolls
// back and nothing is consumed (no overshoot under concurrency — SQLite's
// write lock serializes the reservations). On success a reservation MARKER row
// keyed by message_out_id is written, making the reservation idempotent across
// retries: a redelivery of the same message reuses its existing reservation
// instead of double-charging.
//
// The marker lives in dm_rate_ledger (host-single-writer, restart-stable, no
// new migration) under key `reserve:<message_out_id>` at a fixed sentinel
// window so it never collides with a real rate window and survives ledger
// pruning. Send outcomes:
//   - success            → keep the reservation (already charged).
//   - timeout            → keep the reservation (#4: may have been delivered;
//                           do NOT roll back — the next tick sees the marker and
//                           will not re-charge, and the message is not re-sent
//                           because the host marks it delivered).
//   - explicit failure   → roll back the reservation so ADR-0016's retry loop
//                           re-reserves cleanly on a later tick.

/** Fixed window_start for reservation marker rows. Sorts above any real
 *  short-window start so pruneRateLedger never collects a live reservation. */
const RESERVE_SENTINEL_WINDOW = '9999-01-01T00:00:00.000Z';

function reserveKey(messageOutId: string): string {
  return `reserve:${messageOutId}`;
}

/** Has budget already been reserved for this message (a prior tick / retry)? */
export function hasRosterReservation(messageOutId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM dm_rate_ledger WHERE key = ? AND window_start = ?')
    .get(reserveKey(messageOutId), RESERVE_SENTINEL_WINDOW) as { '1': number } | undefined;
  return row !== undefined;
}

export type RateKeys = { grant: string; scope: string; participant: string; deploy: string };

export type ReserveResult =
  | { ok: true; fresh: boolean }
  | { ok: false; reason: 'max_sends' | 'rate_limited' | 'deploy_daily_cap'; blockedKey?: string };

/**
 * Atomically reserve one unit of every budget (per-grant max_sends, each
 * sliding-window rate key, the daily deploy cap) for a roster send, BEFORE the
 * adapter call. Idempotent per messageOutId: if a reservation already exists
 * (prior tick / retry), returns { ok: true, fresh: false } WITHOUT charging
 * again. A fresh reservation charges every budget in one transaction; if any is
 * over its limit the transaction rolls back and nothing is consumed.
 *
 * The grant decrement reuses the conditional UPDATE shape (changes===1 only
 * when max_sends<=0 OR sends_used<max_sends) and auto-revokes at the cap, so a
 * concurrent reservation can never push sends_used past max_sends.
 */
export function reserveRosterSend(
  messageOutId: string,
  grantId: string,
  rateKeys: RateKeys,
  windows: typeof DEFAULT_RATE_WINDOWS,
  deploy: DeployQuotaConfig,
  now: Date = new Date(),
): ReserveResult {
  const db = getDb();
  const nowIso = now.toISOString();
  const tx = db.transaction((): ReserveResult => {
    // Idempotent: a reservation already standing for this message means a prior
    // tick charged it (e.g. a timed-out send we deliberately did not roll back).
    // Do NOT charge again — this is exactly what stops #4 from over-counting.
    if (hasRosterReservation(messageOutId)) return { ok: true, fresh: false };

    // 1. Per-grant max_sends — conditional atomic increment + auto-revoke.
    const changed = db
      .prepare(
        `UPDATE dm_grants
           SET sends_used = sends_used + 1,
               revoked_at = CASE
                 WHEN max_sends > 0 AND sends_used + 1 >= max_sends THEN COALESCE(revoked_at, ?)
                 ELSE revoked_at
               END
         WHERE id = ? AND (max_sends <= 0 OR sends_used < max_sends)`,
      )
      .run(nowIso, grantId).changes;
    if (changed !== 1) {
      // Over the cap (or grant vanished) → abort; rollback discards any partial.
      throw new ReserveAbort('max_sends');
    }

    // 2. Every sliding-window rate key (AND semantics) — check-under-limit then bump.
    for (const k of ['grant', 'participant', 'scope', 'deploy'] as const) {
      const win = windows[k];
      const ledgerKey = `${k}:${rateKeys[k]}`;
      const ws = windowStartIso(now, win.windowSec);
      if (currentCount(ledgerKey, ws) >= win.limit) throw new ReserveAbort('rate_limited', ledgerKey);
      bumpLedger(ledgerKey, ws);
    }

    // 3. Daily deploy blast-radius cap (tumbling window). Off when dailyCap<=0.
    if (deploy.dailyCap > 0) {
      const ledgerKey = `deploy-daily:${deploy.key}`;
      const ws = windowStartIso(now, deploy.dailyWindowSec);
      if (currentCount(ledgerKey, ws) >= deploy.dailyCap) throw new ReserveAbort('deploy_daily_cap', ledgerKey);
      bumpLedger(ledgerKey, ws);
    }

    // 4. Persist the idempotency marker so retries reuse this reservation.
    bumpLedger(reserveKey(messageOutId), RESERVE_SENTINEL_WINDOW);
    return { ok: true, fresh: true };
  });

  try {
    return tx();
  } catch (err) {
    if (err instanceof ReserveAbort) return { ok: false, reason: err.reason, blockedKey: err.blockedKey };
    throw err;
  }
}

class ReserveAbort extends Error {
  constructor(
    readonly reason: 'max_sends' | 'rate_limited' | 'deploy_daily_cap',
    readonly blockedKey?: string,
  ) {
    super(reason);
  }
}

/**
 * Roll back a reservation when the send FAILED for a non-at-least-once reason
 * (explicit error, not a timeout). Decrements every budget the reservation
 * charged, un-revokes the grant if THIS reservation auto-revoked it at the cap,
 * and deletes the idempotency marker so ADR-0016's retry re-reserves cleanly.
 * Floors counts at 0. No-op (returns false) when no reservation exists — so a
 * double rollback, or a rollback after a kept (timed-out) reservation, is safe.
 */
export function rollbackRosterReservation(
  messageOutId: string,
  grantId: string,
  rateKeys: RateKeys,
  windows: typeof DEFAULT_RATE_WINDOWS,
  deploy: DeployQuotaConfig,
  now: Date = new Date(),
): boolean {
  const db = getDb();
  const tx = db.transaction((): boolean => {
    if (!hasRosterReservation(messageOutId)) return false;

    // Reverse the grant decrement. Un-revoke ONLY when the row is at/above the
    // cap (i.e. this reservation drove the auto-revoke) — an independently
    // revoked grant (opt-out / leave / scope finish) keeps its revoked_at.
    db.prepare(
      `UPDATE dm_grants
         SET sends_used = MAX(sends_used - 1, 0),
             revoked_at = CASE
               WHEN max_sends > 0 AND sends_used >= max_sends THEN NULL
               ELSE revoked_at
             END
         WHERE id = ?`,
    ).run(grantId);

    for (const k of ['grant', 'participant', 'scope', 'deploy'] as const) {
      const ws = windowStartIso(now, windows[k].windowSec);
      decLedger(`${k}:${rateKeys[k]}`, ws);
    }
    if (deploy.dailyCap > 0) {
      decLedger(`deploy-daily:${deploy.key}`, windowStartIso(now, deploy.dailyWindowSec));
    }

    db.prepare('DELETE FROM dm_rate_ledger WHERE key = ? AND window_start = ?').run(
      reserveKey(messageOutId),
      RESERVE_SENTINEL_WINDOW,
    );
    return true;
  });
  return tx();
}

/** Drop a reservation marker without reversing budget (kept-but-no-longer-tracked).
 *  Currently unused on the hot path; exported for housekeeping / DLQ tooling. */
export function clearRosterReservationMarker(messageOutId: string): void {
  getDb()
    .prepare('DELETE FROM dm_rate_ledger WHERE key = ? AND window_start = ?')
    .run(reserveKey(messageOutId), RESERVE_SENTINEL_WINDOW);
}

function bumpLedger(key: string, windowStart: string): void {
  getDb()
    .prepare(
      `INSERT INTO dm_rate_ledger (key, window_start, count)
         VALUES (?, ?, 1)
         ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1`,
    )
    .run(key, windowStart);
}

function decLedger(key: string, windowStart: string): void {
  // Floor at 0 so an over-rollback (shouldn't happen, but defensive) can't drive
  // a counter negative and silently widen the budget.
  getDb()
    .prepare('UPDATE dm_rate_ledger SET count = MAX(count - 1, 0) WHERE key = ? AND window_start = ?')
    .run(key, windowStart);
}
