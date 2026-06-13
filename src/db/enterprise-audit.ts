import { getDb } from './connection.js';

/** Opt-in retention: delete enterprise_audit rows older than `olderThanMs`
 *  (idx_enterprise_audit_at). Gated default-OFF by the caller (host-sweep). */
export function purgeEnterpriseAudit(olderThanMs: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  return getDb().prepare(`DELETE FROM enterprise_audit WHERE occurred_at < ?`).run(cutoff).changes;
}

export interface EnterpriseAuditEntry {
  eventType: string;
  messagingGroupId?: string | null;
  agentGroupId?: string | null;
  actor?: string | null;
  details?: Record<string, unknown>;
}

export function recordEnterpriseAudit(entry: EnterpriseAuditEntry, now: Date = new Date()): void {
  getDb()
    .prepare(
      `INSERT INTO enterprise_audit
         (occurred_at, event_type, messaging_group_id, agent_group_id, actor, details)
         VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now.toISOString(),
      entry.eventType,
      entry.messagingGroupId ?? null,
      entry.agentGroupId ?? null,
      entry.actor ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    );
}
