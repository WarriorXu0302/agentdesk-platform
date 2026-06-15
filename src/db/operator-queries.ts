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
 *
 * Org scoping (ADR-0052 FIX-5): an OPTIONAL `orgScope` restricts results to a
 * set of organizations. It is computed by the CALLER (e.g. scripts/trace.ts
 * --as, from the actor's role/membership) so this stays a pure DB-layer module
 * with no permissions import. Semantics:
 *   - `undefined` → no scoping (OS-gated caller — the documented residual until
 *     a real operator endpoint exists; NOT silently fleet-open, it's a conscious
 *     caller choice).
 *   - `'all'` → an explicit fleet-wide actor (owner / global-admin / global
 *     operator|viewer) — no predicate.
 *   - `string[]` → restrict to sessions whose agent group is in one of these
 *     orgs. FAIL-CLOSED: an empty list returns zero rows. NULL-org (legacy)
 *     sessions are excluded for a scoped actor. Keyed on organization_id /
 *     agent_group_id (structural), never conversation_thread_id (ADR-0039).
 */
import type { Session } from '../types.js';
import { getDb, hasTable } from './connection.js';

export type OrgScope = 'all' | string[];

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
export function listSessions(filter: SessionFilter = {}, orgScope?: OrgScope): Session[] {
  if (Array.isArray(orgScope) && orgScope.length === 0) return []; // fail-closed: scoped actor with no orgs
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
  // FIX-5 org scope: structural JOIN to the session's agent group; restrict to
  // the actor's orgs. (NULL-org sessions are excluded for a scoped actor.)
  let agJoin = '';
  if (Array.isArray(orgScope)) {
    agJoin = 'LEFT JOIN agent_groups ag ON s.agent_group_id = ag.id';
    where.push(`ag.organization_id IN (${orgScope.map(() => '?').join(',')})`);
    params.push(...orgScope);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 1000) : 200;
  // NULL last_active sorts last under DESC (SQLite ranks NULL lowest).
  return getDb()
    .prepare(
      `SELECT s.* FROM sessions s
         LEFT JOIN messaging_groups mg ON s.messaging_group_id = mg.id
         ${agJoin}
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
export function traceRequest(rootSessionId: string, orgScope?: OrgScope): RequestTrace {
  const db = getDb();
  if (Array.isArray(orgScope) && orgScope.length === 0) {
    return { rootSessionId, sessions: [], classifications: [] }; // fail-closed
  }
  // FIX-5 (ADR-0052): filter PER SESSION ROW, not per-root — a delegation tree
  // rooted in org X could (defense-in-depth) contain a worker hop in another org;
  // a scoped actor must only see the sessions in their orgs, and classifications
  // are then constrained to the surviving session ids.
  const sessions = (
    Array.isArray(orgScope)
      ? db
          .prepare(
            `SELECT s.* FROM sessions s
               LEFT JOIN agent_groups ag ON s.agent_group_id = ag.id
               WHERE s.root_session_id = ? AND ag.organization_id IN (${orgScope.map(() => '?').join(',')})
               ORDER BY s.created_at ASC`,
          )
          .all(rootSessionId, ...orgScope)
      : db.prepare('SELECT * FROM sessions WHERE root_session_id = ? ORDER BY created_at ASC').all(rootSessionId)
  ) as Session[];
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
