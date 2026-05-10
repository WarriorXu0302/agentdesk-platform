/**
 * Session lifecycle: archive idle sessions and optionally hard-delete the
 * archive tarballs after a longer TTL.
 *
 * Runs from the host sweep. Sessions are archived when:
 *   - `FRONTLANE_SESSION_TTL_DAYS` is set (> 0)
 *   - session.status = 'active'
 *   - session.container_status = 'stopped'  (never archive under a running container)
 *   - session.last_active older than the TTL window
 *
 * Archived sessions have their on-disk state (`data/v2-sessions/<ag>/<id>/`)
 * tar-gzipped into `data/v2-sessions-archive/<ag>/<id>.tar.gz` and the DB
 * row's status flipped to 'archived'. The session row is kept so audit
 * queries can still resolve the id to an agent group / user.
 *
 * Hard delete (optional) removes archived tarballs + DB rows once
 * `FRONTLANE_ARCHIVE_HARD_DELETE_DAYS` has also elapsed. Default 0 =
 * disabled; archives live forever unless an operator clears them.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  countSessionsByStatus,
  deleteSession,
  findArchivableSessions,
  findArchivedSessionsOlderThan,
  updateSession,
} from './db/sessions.js';
import { log } from './log.js';
import { sessionDir } from './session-manager.js';
import type { Session } from './types.js';

const ARCHIVE_BATCH_LIMIT = 100;

function archiveBaseDir(): string {
  return path.join(DATA_DIR, 'v2-sessions-archive');
}

function archivePathFor(session: Session): string {
  return path.join(archiveBaseDir(), session.agent_group_id, `${session.id}.tar.gz`);
}

function parsePositiveInt(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function sessionTtlDays(): number {
  return parsePositiveInt(process.env.FRONTLANE_SESSION_TTL_DAYS);
}

export function hardDeleteAfterDays(): number {
  return parsePositiveInt(process.env.FRONTLANE_ARCHIVE_HARD_DELETE_DAYS);
}

function cutoffIso(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * Tar + gzip a session's directory into the archive tree. Idempotent:
 * overwrites an existing archive with the same id (in practice only
 * happens if a prior archive crashed mid-run).
 */
export function archiveSessionFiles(session: Session): string | null {
  const src = sessionDir(session.agent_group_id, session.id);
  if (!fs.existsSync(src)) return null;

  const dst = archivePathFor(session);
  fs.mkdirSync(path.dirname(dst), { recursive: true });

  // Use tar with relative paths so the archive extracts cleanly as
  // `<agent_group_id>/<session_id>/...`. -C parents lets us tar without
  // embedding the absolute path.
  const parentDir = path.dirname(src);
  const leaf = path.basename(src);
  execSync(`tar -czf ${JSON.stringify(dst)} -C ${JSON.stringify(parentDir)} ${JSON.stringify(leaf)}`);

  fs.rmSync(src, { recursive: true, force: true });
  return dst;
}

/**
 * Archive a single session: stop container if it's somehow still listed,
 * tar the directory, flip status to 'archived'. Called one session at a
 * time so one bad tar doesn't block the whole sweep.
 */
export async function archiveSession(session: Session, now: Date = new Date()): Promise<boolean> {
  try {
    const archivePath = archiveSessionFiles(session);
    // `archived_at` is the hard-delete gate. Set it to now so the retention
    // window (FRONTLANE_ARCHIVE_HARD_DELETE_DAYS) starts here, not at
    // last_active — otherwise an ancient idle session gets tarred and
    // unlinked inside the same sweep tick.
    updateSession(session.id, { status: 'archived', archived_at: now.toISOString() });
    log.info('Session archived', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      archivePath,
    });
    return true;
  } catch (err) {
    log.error('Session archive failed', { sessionId: session.id, err });
    return false;
  }
}

/**
 * Hard-delete an archived session: remove the tarball and the DB row.
 * Only fires when FRONTLANE_ARCHIVE_HARD_DELETE_DAYS is set.
 */
export function hardDeleteArchivedSession(session: Session): boolean {
  try {
    const archivePath = archivePathFor(session);
    if (fs.existsSync(archivePath)) {
      fs.rmSync(archivePath, { force: true });
    }
    deleteSession(session.id);
    log.info('Archived session hard-deleted', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
    });
    return true;
  } catch (err) {
    log.error('Hard delete failed', { sessionId: session.id, err });
    return false;
  }
}

export interface LifecycleSweepResult {
  archived: number;
  hardDeleted: number;
  activeCount: number;
  archivedCount: number;
}

/**
 * One pass of the session lifecycle sweep. Intended to be called once per
 * host-sweep tick. Returns counts so the sweep can log + emit metrics.
 */
export async function runSessionLifecycleSweep(now: Date = new Date()): Promise<LifecycleSweepResult> {
  const counts = countSessionsByStatus();
  const activeCount = counts.find((c) => c.status === 'active')?.count ?? 0;
  const archivedCount = counts.find((c) => c.status === 'archived')?.count ?? 0;

  const ttlDays = sessionTtlDays();
  const hardDays = hardDeleteAfterDays();

  let archived = 0;
  let hardDeleted = 0;

  if (ttlDays > 0) {
    const beforeIso = cutoffIso(ttlDays, now);
    const candidates = findArchivableSessions(beforeIso, ARCHIVE_BATCH_LIMIT);
    for (const session of candidates) {
      if (await archiveSession(session, now)) archived++;
    }
  }

  if (hardDays > 0) {
    const beforeIso = cutoffIso(hardDays, now);
    const candidates = findArchivedSessionsOlderThan(beforeIso, ARCHIVE_BATCH_LIMIT);
    for (const session of candidates) {
      if (hardDeleteArchivedSession(session)) hardDeleted++;
    }
  }

  return { archived, hardDeleted, activeCount, archivedCount };
}
