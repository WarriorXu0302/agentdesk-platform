import { getDb } from './connection.js';

export interface GatewayAuditEntry {
  sessionId?: string | null;
  agentGroupId?: string | null;
  userId?: string | null;
  path: string;
  operation?: string | null;
  requesterSource: string;
  status: 'ok' | 'error';
  httpStatus?: number | null;
  durationMs?: number | null;
  idempotencyKey?: string | null;
  inputHash?: string | null;
  errorMsg?: string | null;
}

export function recordGatewayAudit(entry: GatewayAuditEntry, now: Date = new Date()): void {
  getDb()
    .prepare(
      `INSERT INTO gateway_audit
         (occurred_at, session_id, agent_group_id, user_id, path, operation, requester_source,
          status, http_status, duration_ms, idempotency_key, input_hash, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now.toISOString(),
      entry.sessionId ?? null,
      entry.agentGroupId ?? null,
      entry.userId ?? null,
      entry.path,
      entry.operation ?? null,
      entry.requesterSource,
      entry.status,
      entry.httpStatus ?? null,
      entry.durationMs ?? null,
      entry.idempotencyKey ?? null,
      entry.inputHash ?? null,
      entry.errorMsg ?? null,
    );
}

/**
 * Two-phase audit for the host signing proxy (ADR-0034).
 *
 * The proxy writes the AUTHORITATIVE audit row for a signed-on-behalf call:
 * facts only the host knows (which group it actually signed as, the token jti,
 * whether the container's claimed group mismatched). It writes in two phases so
 * a crash between "decided to sign" and "got a response" still leaves a forensic
 * row:
 *   - `recordGatewayProxyIntent` writes an `audit_phase='intent'`, `status='pending'`
 *     row BEFORE forwarding to the backend.
 *   - `finalizeGatewayProxyAudit` updates it to `audit_phase='final'` with the
 *     outcome AFTER the backend responds (or the forward fails).
 *
 * These rows coexist with the container-driven rows from `recordGatewayAudit`;
 * the host row is the authority and the two are never deduped/merged.
 */
export interface GatewayProxyIntent {
  proxyRequestId: string;
  sessionId?: string | null;
  /** Authoritative group from the token (what we sign as). */
  agentGroupId?: string | null;
  signedAsGroup?: string | null;
  tokenJti?: string | null;
  path: string;
  operation?: string | null;
  userId?: string | null;
  requesterSource: string;
  requesterSourceCoerced?: boolean;
  identityMismatch?: boolean;
  idempotencyKey?: string | null;
  inputHash?: string | null;
  errorMsg?: string | null;
}

export function recordGatewayProxyIntent(intent: GatewayProxyIntent, now: Date = new Date()): void {
  getDb()
    .prepare(
      `INSERT INTO gateway_audit
         (occurred_at, session_id, agent_group_id, user_id, path, operation, requester_source,
          status, http_status, duration_ms, idempotency_key, input_hash, error_msg,
          signed_as_group, token_jti, proxy_request_id, identity_mismatch, requester_source_coerced, audit_phase)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'intent')`,
    )
    .run(
      now.toISOString(),
      intent.sessionId ?? null,
      intent.agentGroupId ?? null,
      intent.userId ?? null,
      intent.path,
      intent.operation ?? null,
      intent.requesterSource,
      intent.idempotencyKey ?? null,
      intent.inputHash ?? null,
      intent.errorMsg ?? null,
      intent.signedAsGroup ?? null,
      intent.tokenJti ?? null,
      intent.proxyRequestId,
      intent.identityMismatch ? 1 : 0,
      intent.requesterSourceCoerced ? 1 : 0,
    );
}

export interface GatewayProxyOutcome {
  status: 'ok' | 'error';
  httpStatus?: number | null;
  durationMs?: number | null;
  errorMsg?: string | null;
}

export function finalizeGatewayProxyAudit(proxyRequestId: string, outcome: GatewayProxyOutcome): void {
  getDb()
    .prepare(
      `UPDATE gateway_audit
         SET status = ?, http_status = ?, duration_ms = ?, error_msg = ?, audit_phase = 'final'
         WHERE proxy_request_id = ? AND audit_phase = 'intent'`,
    )
    .run(
      outcome.status,
      outcome.httpStatus ?? null,
      outcome.durationMs ?? null,
      outcome.errorMsg ?? null,
      proxyRequestId,
    );
}

/**
 * Reconcile audit rows stranded at audit_phase='intent' by a host crash between
 * the intent write and finalize. The signing proxy is single-process, so any
 * 'intent' row present at startup is by definition orphaned — no live request
 * owns it. Move them to a terminal state so the pending set stays bounded and
 * every row has an outcome. Returns the number reconciled. Run once at startup.
 */
export function reconcileOrphanedProxyAudit(): number {
  return getDb()
    .prepare(
      `UPDATE gateway_audit
         SET status = 'error', audit_phase = 'final',
             error_msg = COALESCE(error_msg, '') || ' [orphaned_intent_reconciled]'
         WHERE audit_phase = 'intent'`,
    )
    .run().changes;
}

/**
 * Delete gateway_audit rows older than `olderThanMs`. Append-only audit tables
 * grow unbounded on the single central DB (the signing proxy adds rows per
 * gateway call); this gives operators a retention lever. Opt-in / default-off
 * at the caller (host-sweep gates on AGENTDESK_AUDIT_RETAIN_DAYS) — audit data
 * is never deleted silently. Uses idx_gateway_audit_at(occurred_at). Returns
 * rows deleted. (The same pattern extends to classification_log /
 * enterprise_audit / dm_audit as a follow-up.)
 */
export function purgeGatewayAudit(olderThanMs: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  return getDb().prepare(`DELETE FROM gateway_audit WHERE occurred_at < ?`).run(cutoff).changes;
}

export interface GatewayAuditQueryOptions {
  limit?: number;
  userId?: string;
  operation?: string;
  since?: string;
  /**
   * Include non-final proxy rows (audit_phase='intent', status='pending').
   * Default false: the operator trail keeps the documented {ok,error} status
   * domain and only shows terminal rows. Intent rows are transient (finalized
   * after the forward) or orphaned (reconciled to 'final' at startup); set true
   * to inspect in-flight rows explicitly.
   */
  includeNonFinal?: boolean;
}

export function queryGatewayAudit(options: GatewayAuditQueryOptions = {}): Array<Record<string, unknown>> {
  const where: string[] = [];
  const params: Array<string> = [];
  if (!options.includeNonFinal) {
    // Container-driven rows have audit_phase = NULL; proxy rows are 'intent'
    // (non-final) or 'final'. Exclude the transient/orphaned 'intent' rows from
    // the default operator view so status stays within {ok,error}.
    where.push("(audit_phase IS NULL OR audit_phase = 'final')");
  }
  if (options.userId) {
    where.push('user_id = ?');
    params.push(options.userId);
  }
  if (options.operation) {
    where.push('operation = ?');
    params.push(options.operation);
  }
  if (options.since) {
    where.push('occurred_at >= ?');
    params.push(options.since);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  return getDb()
    .prepare(`SELECT * FROM gateway_audit ${whereClause} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as Array<Record<string, unknown>>;
}
