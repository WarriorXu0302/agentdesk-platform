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

export interface GatewayAuditQueryOptions {
  limit?: number;
  userId?: string;
  operation?: string;
  since?: string;
}

export function queryGatewayAudit(options: GatewayAuditQueryOptions = {}): Array<Record<string, unknown>> {
  const where: string[] = [];
  const params: Array<string> = [];
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
