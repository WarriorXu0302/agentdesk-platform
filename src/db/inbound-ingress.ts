/**
 * Inbound ingress recovery ledger (ADR-0022).
 *
 * The router persists the raw inbound envelope here BEFORE doing any
 * session-DB write, attachment staging, or container wake. The row is deleted
 * on a normal route completion (including the deliberate "ignore" returns —
 * unwired channel, non-mention), and flipped to status='failed' (with the
 * error + attempt count) when routeInboundInner throws. A host crash mid-route
 * leaves the row stuck at status='received', which surfaceOrphanedIngress()
 * reports at startup.
 *
 * This is a recovery ledger, NOT a dedup table. The id is a synthetic uuid —
 * never a channel event id — so it stays orthogonal to inbound_dedup (the
 * adapter-layer first-seen-wins table that runs before routeInbound). Replay
 * is an operator-explicit action via scripts/replay-inbound.ts; never automatic
 * (auto-replay would re-enter routeInbound below the dedup boundary and could
 * double-deliver). See ADR-0022.
 *
 * Central v2.db only (host single-writer, WAL). Never touches a session's
 * inbound/outbound.db.
 */
import { randomUUID } from 'crypto';

import { getDb } from './connection.js';

export type IngressStatus = 'received' | 'failed';

export interface IngressRow {
  id: string;
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  message_json: string;
  received_at: string;
  status: IngressStatus;
  attempts: number;
  last_error: string | null;
}

/**
 * Insert a fresh 'received' row for an inbound envelope and return its
 * synthetic id. `messageJson` is the serialized envelope (the InboundEvent)
 * the caller will route — replay reads it back verbatim.
 */
export function insertIngress(args: {
  channelType: string;
  platformId: string;
  threadId: string | null;
  messageJson: string;
  now?: Date;
}): string {
  const id = randomUUID();
  const now = (args.now ?? new Date()).toISOString();
  getDb()
    .prepare(
      `INSERT INTO inbound_ingress
         (id, channel_type, platform_id, thread_id, message_json, received_at, status, attempts, last_error)
         VALUES (?, ?, ?, ?, ?, ?, 'received', 0, NULL)`,
    )
    .run(id, args.channelType, args.platformId, args.threadId, args.messageJson, now);
  return id;
}

/** Drop a row after a successful (or deliberately-ignored) route — steady state keeps only in-flight + failed. */
export function deleteIngress(id: string): void {
  getDb().prepare('DELETE FROM inbound_ingress WHERE id = ?').run(id);
}

/**
 * Flip a row to status='failed', bumping attempts and recording the error.
 * Truncates the error string so a pathological exception can't bloat the row.
 */
export function markIngressFailed(id: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE inbound_ingress
         SET status = 'failed', attempts = attempts + 1, last_error = ?
         WHERE id = ?`,
    )
    .run(error.slice(0, 2000), id);
}

export function getIngress(id: string): IngressRow | undefined {
  return getDb().prepare('SELECT * FROM inbound_ingress WHERE id = ?').get(id) as IngressRow | undefined;
}

/**
 * List ledger rows for the replay CLI. Filter by status when given; oldest
 * first so an operator works the backlog in arrival order.
 */
export function listIngress(opts: { status?: IngressStatus; limit?: number } = {}): IngressRow[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  if (opts.status) {
    return getDb()
      .prepare('SELECT * FROM inbound_ingress WHERE status = ? ORDER BY received_at ASC LIMIT ?')
      .all(opts.status, limit) as IngressRow[];
  }
  return getDb().prepare('SELECT * FROM inbound_ingress ORDER BY received_at ASC LIMIT ?').all(limit) as IngressRow[];
}

/** Count rows by status — used by surfaceOrphanedIngress() at host startup. */
export function countIngressByStatus(): { received: number; failed: number } {
  const rows = getDb().prepare('SELECT status, COUNT(*) AS n FROM inbound_ingress GROUP BY status').all() as Array<{
    status: string;
    n: number;
  }>;
  const out = { received: 0, failed: 0 };
  for (const r of rows) {
    if (r.status === 'received') out.received = r.n;
    else if (r.status === 'failed') out.failed = r.n;
  }
  return out;
}
