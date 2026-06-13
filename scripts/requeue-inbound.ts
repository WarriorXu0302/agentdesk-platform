/**
 * scripts/requeue-inbound.ts — dead-letter inspector for inbound messages that
 * exhausted their container-processing retries.
 *
 * When a container repeatedly crashes / is killed on a message, host-sweep
 * resets it MAX_TRIES (5) times and then marks the `messages_in` row
 * status='failed' — it is never re-polled and the user's request is silently
 * dropped (surfaced via the agentdesk_inbound_processing_permanent_failures_total
 * metric + AgentDeskInboundProcessingPermanentFailures alert). This is the
 * inbound mirror of scripts/dlq.ts (which handles the OUTBOUND delivered table).
 *
 * Usage:
 *   pnpm exec tsx scripts/requeue-inbound.ts --list                              # list all failed inbound
 *   pnpm exec tsx scripts/requeue-inbound.ts --session <sessionId> --message <id> # requeue one
 *   pnpm exec tsx scripts/requeue-inbound.ts --requeue-all                       # requeue everything
 *
 * Single-writer caution (same as dlq.ts): each session's inbound.db is
 * host-written. This uses the host's open-write-close pattern (journal_mode=
 * DELETE, busy_timeout=5000), so a write either wins the file lock or fails
 * loudly with SQLITE_BUSY — it cannot corrupt the DB. Prefer requeuing while
 * the host is stopped or during low traffic. ONLY requeue after you've fixed
 * the underlying crash (see RUNBOOK §3.4 / §3.7) — otherwise it dead-letters
 * again on the next cycle.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getAllSessions, getSession } from '../src/db/sessions.js';
import { listFailedInbound, requeueFailedInbound } from '../src/db/session-db.js';
import { openInboundDb } from '../src/session-manager.js';
import type { Session } from '../src/types.js';

function usage(): never {
  console.error(
    'usage: pnpm exec tsx scripts/requeue-inbound.ts [--list | --session <sessionId> --message <messageId> | --requeue-all]',
  );
  process.exit(2);
}

/** Open-write-close around a session's inbound.db; null when not yet provisioned. */
function withInboundDb<T>(session: Session, fn: (db: ReturnType<typeof openInboundDb>) => T): T | null {
  let db: ReturnType<typeof openInboundDb>;
  try {
    db = openInboundDb(session.agent_group_id, session.id);
  } catch {
    return null;
  }
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function listAll(sessions: Session[]): void {
  let total = 0;
  for (const session of sessions) {
    const failed = withInboundDb(session, (db) => listFailedInbound(db));
    if (!failed || failed.length === 0) continue;
    console.log(`session ${session.id} (agent group ${session.agent_group_id})`);
    for (const row of failed) {
      total++;
      console.log(
        `  ${row.id}  kind=${row.kind}  tries=${row.tries}  ts=${row.timestamp}  origin=${row.origin_user_id ?? '—'}`,
      );
    }
  }
  console.log(
    total === 0
      ? 'No dead-lettered inbound messages.'
      : `${total} failed inbound row(s). Fix the crash first (RUNBOOK §3.4), then requeue.`,
  );
}

function requeueOne(sessionId: string, messageId: string): void {
  const session = getSession(sessionId);
  if (!session) {
    console.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }
  const ok = withInboundDb(session, (db) => requeueFailedInbound(db, messageId));
  if (!ok) {
    console.error(`No failed inbound row for message ${messageId} in session ${sessionId}.`);
    process.exit(1);
  }
  console.log(`Requeued ${messageId} (session ${sessionId}) — next wake/sweep will re-deliver it.`);
}

function requeueAll(sessions: Session[]): void {
  let count = 0;
  for (const session of sessions) {
    const requeued = withInboundDb(session, (db) => {
      let n = 0;
      for (const row of listFailedInbound(db)) {
        if (requeueFailedInbound(db, row.id)) n++;
      }
      return n;
    });
    if (requeued) count += requeued;
  }
  console.log(`Requeued ${count} failed inbound row(s).`);
}

const argv = process.argv.slice(2);
const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

if (argv.length === 0 || (argv.length === 1 && argv[0] === '--list')) {
  listAll(getAllSessions());
} else if (argv[0] === '--requeue-all' && argv.length === 1) {
  requeueAll(getAllSessions());
} else if (argv[0] === '--session' && argv[2] === '--message' && argv.length === 4) {
  requeueOne(argv[1], argv[3]);
} else {
  usage();
}
