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
 * Three design rules, each one a documented trap in comparable systems:
 *
 * 1. ACCESS-REFRESHED, not absolute-age. An absolute-age clock deletes
 *    exactly the memories that are still in daily use, because those are the
 *    oldest ones. `touchScopeAccess` stamps the scope on every container
 *    spawn, so the clock measures ABANDONMENT: scopes nobody talks to age
 *    out, active ones never do.
 *
 * 2. NOT retroactive-blind. A retention knob that only governs data written
 *    after it was switched on reports a compliance posture it does not
 *    deliver. Scopes predating this feature have no marker, so the sweep
 *    falls back to the scope directory's own mtime — existing data is
 *    covered from the first tick, no backfill migration needed.
 *
 * 3. NO separate sweep interval. A retention policy whose sweeper is
 *    configured separately is a policy that silently never runs when the
 *    second knob is left unset. This piggybacks the existing host-sweep
 *    tick: setting the TTL is the only action required.
 *
 * SAFETY: a scope backing any ACTIVE session is never removed, whatever its
 * age — the live-session set is the authority, not the timestamp. (The
 * general form of "retire the discovery surface before the payload": here
 * the sessions table IS the discovery surface, so a scope it still points at
 * is off-limits.)
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
import { getActiveSessions } from './db/sessions.js';
import { log } from './log.js';
import { SCOPE_ACCESS_MARKER, scopesBaseDir, userScopeKey } from './state-scope.js';

/**
 * Retention window for per-user scopes, in days. Default 0 = OFF — the house
 * rule for anything that deletes operator data: never silently, always opt-in.
 */
export function scopeRetentionDays(): number {
  const raw = parseInt(process.env.AGENTDESK_SCOPE_TTL_DAYS || '0', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Last-access time for a scope: marker mtime, else the dir's own mtime. */
function lastAccessMs(scopeDir: string): number | null {
  try {
    return fs.statSync(path.join(scopeDir, SCOPE_ACCESS_MARKER)).mtimeMs;
  } catch {
    // Pre-ADR-0061 scope (no marker yet): fall back to the directory itself so
    // existing data is covered from the first sweep rather than being treated
    // as brand new (or, worse, as infinitely old).
    try {
      return fs.statSync(scopeDir).mtimeMs;
    } catch {
      return null;
    }
  }
}

/** `agentGroupId/userScopeKey` pairs that an active session still resolves to. */
function liveScopeKeys(): Set<string> {
  const live = new Set<string>();
  for (const session of getActiveSessions()) {
    if (!session.owner_user_id) continue;
    live.add(`${session.agent_group_id}/${userScopeKey(session.owner_user_id)}`);
  }
  return live;
}

let loggedPolicy = false;

export interface ScopeSweepResult {
  scanned: number;
  removed: number;
  skippedLive: number;
}

/**
 * Remove per-user scopes whose last access predates the retention window.
 * No-op when `AGENTDESK_SCOPE_TTL_DAYS` is unset. Safe to call every tick.
 *
 * Orphaned scopes (their agent group was deleted outside
 * `delete-cli-agent`) need no special case: nothing references them, so they
 * age out through the same path.
 */
export function sweepExpiredScopes(now: number = Date.now()): ScopeSweepResult {
  const result: ScopeSweepResult = { scanned: 0, removed: 0, skippedLive: 0 };
  const days = scopeRetentionDays();

  if (!loggedPolicy) {
    loggedPolicy = true;
    log.info('Per-user scope retention policy (ADR-0061)', {
      enabled: days > 0,
      retainDays: days,
      note: days > 0 ? 'access-refreshed; active sessions never expire' : 'OFF — scopes are kept indefinitely',
    });
  }
  if (days === 0) return result;

  const root = path.join(DATA_DIR, 'v2-scopes');
  if (!fs.existsSync(root)) return result;

  const cutoff = now - days * 24 * 60 * 60_000;
  const live = liveScopeKeys();

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
      if (live.has(`${agentGroupId}/${scopeKey}`)) {
        result.skippedLive++;
        continue;
      }
      const scopeDir = path.join(agentScopes, scopeKey);
      const accessed = lastAccessMs(scopeDir);
      if (accessed === null || accessed > cutoff) continue;

      try {
        fs.rmSync(scopeDir, { recursive: true, force: true });
        result.removed++;
        // Deleting a person's memory and transcripts is a governance event:
        // record it where the operator already looks for such things.
        recordEnterpriseAudit({
          eventType: 'scope_retention_expired',
          agentGroupId,
          details: {
            scopeKey,
            retainDays: days,
            lastAccessAt: new Date(accessed).toISOString(),
          },
        });
        log.info('Expired per-user state scope (ADR-0061)', {
          agentGroupId,
          scopeKey,
          retainDays: days,
          lastAccessAt: new Date(accessed).toISOString(),
        });
      } catch (err) {
        log.warn('Scope retention: delete failed', { agentGroupId, scopeKey, err });
      }
    }
  }

  return result;
}

/** Test seam — the policy log fires once per process. */
export function resetScopeRetentionPolicyLog(): void {
  loggedPolicy = false;
}
