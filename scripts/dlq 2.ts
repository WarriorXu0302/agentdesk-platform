/**
 * scripts/dlq.ts — dead-letter inspector for failed outbound deliveries.
 *
 * Lists `delivered` rows with status='failed' across all active sessions
 * (attempts, next retry time, message summary), and can requeue them so the
 * host's poll/sweep loops re-attempt delivery. See ADR-0016.
 *
 * Usage:
 *   pnpm exec tsx scripts/dlq.ts                                   # list
 *   pnpm exec tsx scripts/dlq.ts --requeue <sessionId> <messageId> # requeue one
 *   pnpm exec tsx scripts/dlq.ts --requeue-all                     # requeue everything
 *
 * Single-writer caution: each session's inbound.db is host-written. This
 * script uses the same open-write-close pattern as the host
 * (journal_mode=DELETE, busy_timeout=5000), so a write either wins the file
 * lock or fails loudly with SQLITE_BUSY — it cannot corrupt the DB. But
 * every requeue write still competes with the live host process for the
 * lock: prefer running requeue operations while the host is stopped or
 * during low traffic. Listing is read-only in effect, except that opening a
 * pre-upgrade inbound.db applies the delivered-table column migration (the
 * same idempotent ALTER the host applies on first touch).
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getActiveSessions, getSession } from '../src/db/sessions.js';
import {
  listFailedDeliveries,
  migrateDeliveredTable,
  requeueFailedDelivery,
  type FailedDeliveryRow,
} from '../src/db/session-db.js';
import { openInboundDb, openOutboundDb } from '../src/session-manager.js';
import type { Session } from '../src/types.js';

function usage(): never {
  console.error('usage: pnpm exec tsx scripts/dlq.ts [--requeue <sessionId> <messageId> | --requeue-all]');
  process.exit(2);
}

/** First ~80 chars of the user-visible text (or raw content) of an outbound row. */
function summarizeMessage(session: Session, messageOutId: string): string {
  try {
    const outDb = openOutboundDb(session.agent_group_id, session.id);
    try {
      const row = outDb.prepare('SELECT kind, content FROM messages_out WHERE id = ?').get(messageOutId) as
        | { kind: string; content: string }
        | undefined;
      if (!row) return '(outbound row missing)';
      let text = row.content;
      try {
        const parsed = JSON.parse(row.content) as Record<string, unknown>;
        if (typeof parsed.text === 'string') text = parsed.text;
      } catch {
        /* raw content */
      }
      const oneLine = text.replace(/\s+/g, ' ').trim();
      return `kind=${row.kind} "${oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine}"`;
    } finally {
      outDb.close();
    }
  } catch {
    return '(outbound.db unreadable)';
  }
}

/** Open-write-close around a session's inbound.db; returns null when the DB doesn't exist. */
function withInboundDb<T>(session: Session, fn: (db: ReturnType<typeof openInboundDb>) => T): T | null {
  let db: ReturnType<typeof openInboundDb>;
  try {
    db = openInboundDb(session.agent_group_id, session.id);
  } catch {
    return null; // session folder not provisioned yet
  }
  try {
    migrateDeliveredTable(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function listAll(sessions: Session[]): void {
  let total = 0;
  for (const session of sessions) {
    const failed = withInboundDb(session, (db) => listFailedDeliveries(db));
    if (!failed || failed.length === 0) continue;
    console.log(`session ${session.id} (agent group ${session.agent_group_id})`);
    for (const row of failed) {
      total++;
      console.log(
        `  ${row.message_out_id}  attempts=${row.attempts}  next_retry_at=${row.next_retry_at ?? 'none (parked)'}  last_failure=${row.delivered_at}  ${summarizeMessage(session, row.message_out_id)}`,
      );
    }
  }
  console.log(total === 0 ? 'No failed deliveries.' : `${total} failed delivery row(s).`);
}

function requeueOne(sessionId: string, messageId: string): void {
  const session = getSession(sessionId);
  if (!session) {
    console.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }
  const ok = withInboundDb(session, (db) => requeueFailedDelivery(db, messageId));
  if (!ok) {
    console.error(`No failed delivery row for message ${messageId} in session ${sessionId}.`);
    process.exit(1);
  }
  console.log(`Requeued ${messageId} (session ${sessionId}) — next poll/sweep will re-attempt delivery.`);
}

function requeueAll(sessions: Session[]): void {
  let count = 0;
  for (const session of sessions) {
    const requeued = withInboundDb(session, (db) => {
      let n = 0;
      for (const row of listFailedDeliveries(db)) {
        if (requeueFailedDelivery(db, row.message_out_id)) n++;
      }
      return n;
    });
    if (requeued) count += requeued;
  }
  console.log(`Requeued ${count} failed delivery row(s).`);
}

const argv = process.argv.slice(2);
const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

if (argv.length === 0) {
  listAll(getActiveSessions());
} else if (argv[0] === '--requeue-all' && argv.length === 1) {
  requeueAll(getActiveSessions());
} else if (argv[0] === '--requeue' && argv.length === 3) {
  requeueOne(argv[1], argv[2]);
} else {
  usage();
}
