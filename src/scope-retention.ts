/**
 * Per-user state-scope retention (ADR-0061).
 *
 * ADR-0055 gave every owner their own scope under
 * `DATA_DIR/v2-scopes/<agentGroupId>/<userScopeKey>/` holding the most
 * sensitive data the platform stores on disk: the person's memory
 * (CLAUDE.local.md), verbatim conversation archives, and Claude's own state.
 * Nothing ever removed it — the session sweep only reaps
 * `data/v2-sessions/`, and `delete-cli-agent` only fires when a whole agent
 * group is decommissioned. A person who stopped using the platform a year
 * ago still had every transcript on disk.
 *
 * THE CLOCK. Retention is measured against a `.last-access` marker the
 * platform writes on every spawn that mounts the scope, so it measures
 * ABANDONMENT, not age: an absolute-age clock would delete exactly the
 * memories still in daily use, because those are the oldest ones.
 *
 * ADOPTION (the rule that makes this safe). A scope with no marker is never
 * deleted on the strength of the FILESYSTEM's word — it is ADOPTED: stamped
 * once, then aged from that stamp. (An adoption backed by session evidence
 * older than the window does expire on that same tick; that is the point —
 * the operator's policy takes effect immediately for people the DB can still
 * vouch for. Only an adoption with no evidence behind it gets a full grace
 * window.)
 * Deletion only ever measures against a marker this code wrote. The first
 * cut of this feature instead fell back to the scope directory's own mtime,
 * which was wrong in the most dangerous possible way: a POSIX directory's
 * mtime only advances when its OWN entries change, and a scope root's only
 * children (`workspace/`, `claude/`) are created once at init — every later
 * write lands deeper. That fallback therefore reported CREATION time
 * forever: exactly the absolute-age clock this design exists to avoid, for
 * 100% of the data present at rollout, ordered worst-first (longest-tenured
 * users deleted first). Adoption removes the class — the filesystem is never
 * asked a question it cannot answer.
 *
 * The adoption stamp prefers evidence over "now": the central DB knows when
 * each owner last used each agent (`sessions.last_active`, any status), so a
 * scope whose sessions still exist is adopted at its true last-use time and
 * expires on the operator's real schedule. Only when no session remains does
 * adoption fall back to now — costing that scope one grace window, which is
 * the safe direction to be wrong in.
 *
 * SAFETY: a scope backing any ACTIVE session is never removed, whatever its
 * age — the live-session set is the authority, not the timestamp. (The
 * general form of "retire the discovery surface before the payload": here
 * the sessions table IS the discovery surface, so a scope it still points at
 * is off-limits.)
 *
 * AUDIT BEFORE EFFECT: the governance row is written BEFORE the delete, and
 * a failed audit write ABORTS the delete. No irreversible destruction of a
 * person's data without a durable record of it, even if the host dies
 * mid-`rmSync`.
 *
 * PARTIAL DELETES (honest): `.last-access` lives inside the tree being
 * removed, so a partial `rmSync` failure can go either way. If the marker
 * survives, the next tick retries the delete (auditing only once — see
 * `auditedPendingDelete`). If it was removed first, the scope is re-adopted;
 * with no session evidence left it gets a fresh window before the retry.
 * Both are recoverable and neither destroys more than the delete already
 * intended.
 *
 * SCOPE (honest): this is expiry, NOT erasure. "Delete everything about this
 * person, now" is a different requirement — it spans audit rows the platform
 * is required to keep and backend-gateway memory the platform does not own —
 * and gets its own decision. See ADR-0061 § Non-goals.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { recordEnterpriseAudit } from './db/enterprise-audit.js';
import { getAllSessions } from './db/sessions.js';
import { log } from './log.js';
import { scopeRetentionTotal } from './metrics.js';
import { sessionTtlDays } from './session-archive.js';
import { SCOPE_ACCESS_MARKER, scopesBaseDir, touchScopeAccess, userScopeKey } from './state-scope.js';

/**
 * Retention window for per-user scopes, in days. Default 0 = OFF — the house
 * rule for anything that deletes operator data: never silently, always opt-in.
 */
export function scopeRetentionDays(): number {
  const raw = parseInt(process.env.AGENTDESK_SCOPE_TTL_DAYS || '0', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Report what WOULD be expired without deleting anything. The safe way to
 * choose a TTL on a live deployment: switch it on, read the log, switch off.
 */
function dryRunEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.AGENTDESK_SCOPE_TTL_DRY_RUN || '');
}

/** Marker mtime, or null when the scope has never been stamped (→ adopt). */
function markerMs(scopeDir: string): number | null {
  try {
    return fs.statSync(path.join(scopeDir, SCOPE_ACCESS_MARKER)).mtimeMs;
  } catch {
    return null;
  }
}

interface ScopeIndex {
  /** `agentGroupId/scopeKey` an ACTIVE session resolves to — never expire. */
  live: Set<string>;
  /** `agentGroupId/scopeKey` → newest sessions.last_active seen (any status). */
  lastUse: Map<string, number>;
}

/**
 * Build both views in one pass over the sessions table. Archived rows are
 * included on purpose: an archived session is still evidence of when that
 * person last used that agent, which is exactly what an adoption stamp wants.
 */
function indexScopes(): ScopeIndex {
  const live = new Set<string>();
  const lastUse = new Map<string, number>();
  // userScopeKey is a sha1; a busy deployment has many sessions per owner and
  // this runs on every sweep tick, so hash each owner id once.
  const keyMemo = new Map<string, string>();
  const keyFor = (ownerUserId: string): string => {
    let k = keyMemo.get(ownerUserId);
    if (k === undefined) {
      k = userScopeKey(ownerUserId);
      keyMemo.set(ownerUserId, k);
    }
    return k;
  };
  for (const session of getAllSessions()) {
    if (!session.owner_user_id) continue;
    const key = `${session.agent_group_id}/${keyFor(session.owner_user_id)}`;
    if (session.status === 'active') live.add(key);
    // Fall through to created_at on a missing OR unparseable last_active —
    // `?? ` alone would let an empty string swallow the fallback.
    let stamp = Date.parse(session.last_active ?? '');
    if (!Number.isFinite(stamp)) stamp = Date.parse(session.created_at ?? '');
    if (Number.isFinite(stamp)) {
      const prev = lastUse.get(key);
      if (prev === undefined || stamp > prev) lastUse.set(key, stamp);
    }
  }
  return { live, lastUse };
}

/**
 * Scopes whose audit row is already written but whose delete has not
 * succeeded yet. Without this, "audit before effect" turns a permanently
 * failing rmSync (immutable flag, EACCES, a stuck mount) into one
 * governance row per scope PER 60s TICK — and audit purging is opt-in and
 * default-off, so nothing would bound it. One row per stuck scope per
 * process; the retry itself still happens every tick.
 */
const auditedPendingDelete = new Set<string>();

let loggedPolicy = false;
let warnedSessionTtlDependency = false;

export interface ScopeSweepResult {
  scanned: number;
  /** Stamped for the first time — never deleted on the tick that adopts them. */
  adopted: number;
  removed: number;
  skippedLive: number;
  /** Would have been removed, but AGENTDESK_SCOPE_TTL_DRY_RUN is on. */
  wouldRemove: number;
}

/**
 * Expire per-user scopes whose last access predates the retention window.
 * No-op when `AGENTDESK_SCOPE_TTL_DAYS` is unset. Safe to call every tick.
 *
 * Orphaned scopes (their agent group was deleted outside `delete-cli-agent`)
 * need no special case: nothing references them, so they age out the same way.
 */
export function sweepExpiredScopes(now: number = Date.now()): ScopeSweepResult {
  const result: ScopeSweepResult = { scanned: 0, adopted: 0, removed: 0, skippedLive: 0, wouldRemove: 0 };
  const days = scopeRetentionDays();
  const preview = dryRunEnabled();

  if (!loggedPolicy) {
    loggedPolicy = true;
    log.info('Per-user scope retention policy (ADR-0061)', {
      enabled: days > 0,
      retainDays: days,
      dryRun: preview,
      note:
        days > 0
          ? 'access-refreshed; unseen scopes are adopted, never deleted on sight; active sessions never expire'
          : 'OFF — scopes are kept indefinitely',
    });
  }
  if (days === 0) return result;

  // Hard dependency, easy to miss: session archiving is default-off, and while
  // it is off every session row stays status='active' forever — so every scope
  // that has any session is skipped as live and can never expire. Scope TTL
  // alone would report a compliance posture the platform does not deliver.
  if (!warnedSessionTtlDependency && sessionTtlDays() === 0) {
    warnedSessionTtlDependency = true;
    log.warn(
      'AGENTDESK_SCOPE_TTL_DAYS is set but AGENTDESK_SESSION_TTL_DAYS is not — sessions never leave status=active, so scopes with any session are skipped as live and will not expire',
      { scopeRetainDays: days },
    );
  }

  const root = path.join(DATA_DIR, 'v2-scopes');
  if (!fs.existsSync(root)) return result;

  const cutoff = now - days * 24 * 60 * 60_000;
  const { live, lastUse } = indexScopes();

  let agentDirs: string[];
  try {
    agentDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    log.warn('Scope retention: cannot list scope root', { root, err });
    return result;
  }

  for (const agentGroupId of agentDirs) {
    const agentScopes = scopesBaseDir(agentGroupId);
    let userDirs: string[];
    try {
      userDirs = fs
        .readdirSync(agentScopes, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (err) {
      log.warn('Scope retention: cannot list agent scopes', { agentGroupId, err });
      continue;
    }

    for (const scopeKey of userDirs) {
      result.scanned++;
      const indexKey = `${agentGroupId}/${scopeKey}`;
      if (live.has(indexKey)) {
        result.skippedLive++;
        scopeRetentionTotal.labels('skipped_live').inc();
        continue;
      }

      const scopeDir = path.join(agentScopes, scopeKey);
      let accessed = markerMs(scopeDir);

      // ADOPTION: never delete a scope on the tick we first see it. Stamp it
      // with the best evidence available (the owner's newest session
      // last_active, else now) and let it age from a clock we control.
      if (accessed === null) {
        const evidence = lastUse.get(indexKey);
        accessed = evidence ?? now;
        if (!preview) {
          // Count what actually happened, not what was attempted: a scope
          // whose stamp can never land would otherwise report "adopted"
          // forever, once per tick, while its clock stays frozen.
          const stamped = touchScopeAccess(scopeDir, accessed);
          if (stamped) {
            result.adopted++;
            scopeRetentionTotal.labels('adopted').inc();
            log.info('Adopted pre-existing user state scope into retention (ADR-0061)', {
              agentGroupId,
              scopeKey,
              stampedAt: new Date(accessed).toISOString(),
              source: evidence !== undefined ? 'session-last-active' : 'now (no session evidence)',
            });
          } else {
            scopeRetentionTotal.labels('adopt_failed').inc();
          }
        }
        // Fall through — an evidence-backed stamp may already be past cutoff.
      }

      if (accessed > cutoff) continue;

      if (preview) {
        result.wouldRemove++;
        log.info('DRY RUN — would expire user state scope', {
          agentGroupId,
          scopeKey,
          retainDays: days,
          lastAccessAt: new Date(accessed).toISOString(),
        });
        continue;
      }

      // AUDIT BEFORE EFFECT. Deleting a person's memory and transcripts is a
      // governance event; the record must survive a crash mid-delete. A
      // failed audit write ABORTS the deletion — never destruction without a
      // durable record of it.
      if (!auditedPendingDelete.has(indexKey)) {
        try {
          recordEnterpriseAudit({
            eventType: 'scope_retention_expired',
            agentGroupId,
            details: { scopeKey, retainDays: days, lastAccessAt: new Date(accessed).toISOString() },
          });
          auditedPendingDelete.add(indexKey);
        } catch (err) {
          // Fail closed: no durable record of the destruction, no destruction.
          // Counted so a broken audit table cannot make the policy silently
          // stop running with every counter reading zero.
          scopeRetentionTotal.labels('audit_failed').inc();
          log.warn('Scope retention: audit write failed — NOT deleting', { agentGroupId, scopeKey, err });
          continue;
        }
      }

      try {
        fs.rmSync(scopeDir, { recursive: true, force: true });
        auditedPendingDelete.delete(indexKey);
        result.removed++;
        scopeRetentionTotal.labels('expired').inc();
        log.info('Expired per-user state scope (ADR-0061)', {
          agentGroupId,
          scopeKey,
          retainDays: days,
          lastAccessAt: new Date(accessed).toISOString(),
        });
      } catch (err) {
        // rmSync(recursive) is not atomic — it may have removed part of the
        // tree before failing. The audit row above already records the
        // intent, so the operator can see what was touched.
        scopeRetentionTotal.labels('delete_failed').inc();
        log.warn('Scope retention: delete failed — scope may be partially removed (audit row was written)', {
          agentGroupId,
          scopeKey,
          err,
        });
      }
    }
  }

  return result;
}

/** Test seam — the policy log fires once per process. */
export function resetScopeRetentionPolicyLog(): void {
  loggedPolicy = false;
  warnedSessionTtlDependency = false;
  auditedPendingDelete.clear();
}
