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

import { parseSqliteUtc } from '../host-sweep.js';
import { getDb } from './connection.js';

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
            created_at, expires_at, revoked_at, max_sends, sends_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)
         ON CONFLICT(scope_id, slot_label) DO UPDATE SET
           participant_open_id    = excluded.participant_open_id,
           dm_platform_id         = excluded.dm_platform_id,
           channel_type           = excluded.channel_type,
           consent_source         = excluded.consent_source,
           consent_inbound_msg_id = excluded.consent_inbound_msg_id,
           consent_origin_user_id = excluded.consent_origin_user_id,
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
  return getDb()
    .prepare('UPDATE dm_grants SET revoked_at = ? WHERE scope_id = ? AND revoked_at IS NULL')
    .run(nowIso, scopeId).changes;
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
 * is under its limit. Conservative defaults; deployment-level tuning is
 * harden-after (item 14).
 */
export const DEFAULT_RATE_WINDOWS: Record<'grant' | 'scope' | 'participant' | 'deploy', RateWindow> = {
  grant: { windowSec: 60, limit: 3 },
  participant: { windowSec: 60, limit: 5 },
  scope: { windowSec: 60, limit: 20 },
  deploy: { windowSec: 60, limit: 100 },
};

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
  return getDb().prepare('DELETE FROM dm_rate_ledger WHERE window_start < ?').run(cutoff).changes;
}
