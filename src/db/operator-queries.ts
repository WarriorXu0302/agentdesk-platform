/**
 * Operator triage queries (ADR-0049): a curated, read-only governance surface
 * for running MANY concurrent users / orgs / sessions on one deployment.
 *
 * Operability-at-scale, not capacity-scale: the platform is deliberately
 * single-machine (multi-node HA is an explicit non-goal — it would break the
 * three-DB single-writer invariant). What this adds is the ability to OBSERVE
 * and TRIAGE the fleet without hand-writing JOINs in scripts/q.ts:
 *
 *  - listSessions(filter): filter the session fleet by agent group / owner /
 *    thread / root / status / container-state / channel.
 *  - traceRequest(rootSessionId): assemble ONE request's full fan-out across the
 *    frontdesk -> worker sessions that share a root_session_id (the delegation
 *    tree), plus the classification_log decisions along the way — the
 *    cross-session view that is awkward to reconstruct from raw SQL.
 *
 * Keys: lookups bind to root_session_id / session_id (structural routing keys).
 * conversation_thread_id (ADR-0039) is a pure CORRELATION id — it is only
 * displayed here (read via SELECT *, for cross-referencing OTel traces), never an
 * equality lookup/filter key (enforced by conversation-thread-id-guard.test.ts).
 *
 * Read-only by construction (SELECT only). These read the central DB, which is
 * operator-owned; the CLI (scripts/trace.ts) is an operator tool, so access is
 * gated by who can run it, not an in-band role check.
 */
import type { Session } from '../types.js';
import { getDb, hasTable } from './connection.js';

export interface SessionFilter {
  agentGroupId?: string;
  ownerUserId?: string;
  threadId?: string;
  rootSessionId?: string;
  status?: string;
  containerStatus?: string;
  channelType?: string;
  limit?: number;
}

/**
 * List sessions matching every provided filter (AND), newest activity first.
 * channelType joins through the session's messaging group. Caps at 1000 rows so
 * a fat fleet can't return an unbounded result; default 200.
 */
export function listSessions(filter: SessionFilter = {}): Session[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.agentGroupId) {
    where.push('s.agent_group_id = ?');
    params.push(filter.agentGroupId);
  }
  if (filter.ownerUserId) {
    where.push('s.owner_user_id = ?');
    params.push(filter.ownerUserId);
  }
  if (filter.threadId) {
    where.push('s.thread_id = ?');
    params.push(filter.threadId);
  }
  if (filter.rootSessionId) {
    where.push('s.root_session_id = ?');
    params.push(filter.rootSessionId);
  }
  if (filter.status) {
    where.push('s.status = ?');
    params.push(filter.status);
  }
  if (filter.containerStatus) {
    where.push('s.container_status = ?');
    params.push(filter.containerStatus);
  }
  if (filter.channelType) {
    where.push('mg.channel_type = ?');
    params.push(filter.channelType);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 1000) : 200;
  // NULL last_active sorts last under DESC (SQLite ranks NULL lowest).
  return getDb()
    .prepare(
      `SELECT s.* FROM sessions s
         LEFT JOIN messaging_groups mg ON s.messaging_group_id = mg.id
         ${clause}
         ORDER BY s.last_active DESC
         LIMIT ?`,
    )
    .all(...params, limit) as Session[];
}

export interface RequestTrace {
  rootSessionId: string;
  /** Every session in this request's delegation tree, oldest first. */
  sessions: Session[];
  /** classify_intent / escalate / routing_feedback decisions across the tree. */
  classifications: Array<Record<string, unknown>>;
}

/**
 * Assemble one request's full multi-hop fan-out from its root_session_id: every
 * session in the delegation tree (frontdesk root + each delegated worker, which
 * inherit root_session_id in root-session mode) and every classification_log
 * decision recorded by those sessions. The cross-session "what happened to this
 * request" view. (Each session also carries conversation_thread_id for
 * cross-referencing an OTel trace — displayed, not used as a lookup key.)
 */
export function traceRequest(rootSessionId: string): RequestTrace {
  const db = getDb();
  const sessions = db
    .prepare('SELECT * FROM sessions WHERE root_session_id = ? ORDER BY created_at ASC')
    .all(rootSessionId) as Session[];
  let classifications: Array<Record<string, unknown>> = [];
  if (sessions.length > 0 && hasTable(db, 'classification_log')) {
    const ids = sessions.map((s) => s.id);
    const placeholders = ids.map(() => '?').join(',');
    classifications = db
      .prepare(`SELECT * FROM classification_log WHERE session_id IN (${placeholders}) ORDER BY id ASC`)
      .all(...ids) as Array<Record<string, unknown>>;
  }
  return { rootSessionId, sessions, classifications };
}
