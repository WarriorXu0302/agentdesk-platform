/**
 * Session lifecycle: archive idle sessions and optionally hard-delete the
 * archive tarballs after a longer TTL.
 *
 * Runs from the host sweep. Sessions are archived when:
 *   - `AGENTDESK_SESSION_TTL_DAYS` is set (> 0)
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
 * `AGENTDESK_ARCHIVE_HARD_DELETE_DAYS` has also elapsed. Default 0 =
 * disabled; archives live forever unless an operator clears them.
 */
import { spawn } from 'child_process';
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

/**
 * Session ids currently being tar'd in the background. The sweep fires
 * one tick per 60s — without this set a long-running tar from the prior
 * tick would be re-issued on the next one because the DB row still says
 * `status='active'` until the tar finishes. Cleared in the finally arm
 * of spawnTarAsync().
 */
const archivesInProgress = new Set<string>();

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
  return parsePositiveInt(process.env.AGENTDESK_SESSION_TTL_DAYS);
}

export function hardDeleteAfterDays(): number {
  return parsePositiveInt(process.env.AGENTDESK_ARCHIVE_HARD_DELETE_DAYS);
}

function cutoffIso(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * Run `tar -czf ...` in a child process and wait for it via a Promise —
 * yields the event loop instead of blocking it. Big session folders
 * (conversations/, outbox/, etc.) can tar for hundreds of ms to several
 * seconds each; the sweep batch limit is 100, so the old execSync path
 * would freeze the entire host loop for minutes in the worst case.
 *
 * Resolves to the archive path on success, or null when the source dir
 * no longer exists. Rejects if tar exits non-zero.
 */
async function spawnTarAsync(src: string, dst: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const parentDir = path.dirname(src);
    const leaf = path.basename(src);
    const child = spawn('tar', ['-czf', dst, '-C', parentDir, leaf], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrBuf = '';
    child.stderr?.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderrBuf.slice(0, 500)}`));
    });
  });
}

/**
 * Tar + gzip a session's directory into the archive tree. Async.
 * Idempotent: overwrites an existing archive with the same id (in
 * practice only happens if a prior archive crashed mid-run).
 */
export async function archiveSessionFiles(session: Session): Promise<string | null> {
  const src = sessionDir(session.agent_group_id, session.id);
  if (!fs.existsSync(src)) return null;

  const dst = archivePathFor(session);
  fs.mkdirSync(path.dirname(dst), { recursive: true });

  await spawnTarAsync(src, dst);

  fs.rmSync(src, { recursive: true, force: true });
  return dst;
}

/**
 * Archive a single session: tar the directory, flip status to 'archived'.
 * Called one session at a time so one bad tar doesn't block the whole
 * sweep; the tar itself is async (spawn) so the sweep loop keeps
 * yielding.
 *
 * Reentrancy guard: if the same session is already being archived by a
 * prior (still-running) sweep tick, we short-circuit with false. The
 * in-progress tick owns the DB flip.
 */
export async function archiveSession(session: Session, now: Date = new Date()): Promise<boolean> {
  if (archivesInProgress.has(session.id)) {
    return false;
  }
  archivesInProgress.add(session.id);
  try {
    const archivePath = await archiveSessionFiles(session);
    // `archived_at` is the hard-delete gate. Set it to now so the retention
    // window (AGENTDESK_ARCHIVE_HARD_DELETE_DAYS) starts here, not at
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
  } finally {
    archivesInProgress.delete(session.id);
  }
}

/**
 * Hard-delete an archived session: remove the tarball and the DB row.
 * Only fires when AGENTDESK_ARCHIVE_HARD_DELETE_DAYS is set.
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
    // Run the tar-per-session jobs concurrently. Each archive forks a
    // `tar` subprocess (spawnTarAsync) which runs outside the event loop,
    // so the concurrency here is CPU/IO-bound by the kernel, not by
    // JavaScript — we're just not serializing their waits. On the old
    // execSync path a batch of 100 stacking to ~1 second per session
    // would block the sweep (and everything else) for minutes; now the
    // sweep returns quickly and the tars finish whenever.
    const outcomes = await Promise.all(candidates.map((session) => archiveSession(session, now)));
    archived = outcomes.filter((ok) => ok).length;
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
