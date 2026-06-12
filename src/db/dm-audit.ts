/**
 * Roster directed-message audit log — host-side (ADR-0023).
 *
 * Every roster DM delivery DECISION writes one row here, win or lose. This is
 * the compliance paper trail for the directed-private-message surface, the
 * analogue of gateway_audit for backend calls. A rejected send (revoked grant,
 * raw-platform-id smuggle attempt, rate-limit, scope mismatch) is just as
 * important to record as a delivered one, so the gate calls this on both paths.
 *
 * Central v2.db only, host single-writer. Never touches a session DB.
 */
import { getDb } from './connection.js';

export type DmAuditDecision = 'delivered' | 'rejected';

export interface DmAuditEntry {
  scopeId: string;
  agentGroupId?: string | null;
  sessionId?: string | null;
  slotLabel?: string | null;
  grantId?: string | null;
  participantOpenId?: string | null;
  dmPlatformId?: string | null;
  messageOutId?: string | null;
  decision: DmAuditDecision;
  /** Deny reason on rejection; null/omitted on delivered. */
  reason?: string | null;
}

export function recordDmAudit(entry: DmAuditEntry, now: Date = new Date()): void {
  getDb()
    .prepare(
      `INSERT INTO dm_audit
         (occurred_at, scope_id, agent_group_id, session_id, slot_label, grant_id,
          participant_open_id, dm_platform_id, message_out_id, decision, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now.toISOString(),
      entry.scopeId,
      entry.agentGroupId ?? null,
      entry.sessionId ?? null,
      entry.slotLabel ?? null,
      entry.grantId ?? null,
      entry.participantOpenId ?? null,
      entry.dmPlatformId ?? null,
      entry.messageOutId ?? null,
      entry.decision,
      entry.reason ?? null,
    );
}

export interface DmAuditQueryOptions {
  scopeId?: string;
  limit?: number;
}

export function queryDmAudit(options: DmAuditQueryOptions = {}): Array<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  if (options.scopeId) {
    return getDb()
      .prepare('SELECT * FROM dm_audit WHERE scope_id = ? ORDER BY id DESC LIMIT ?')
      .all(options.scopeId, limit) as Array<Record<string, unknown>>;
  }
  return getDb().prepare('SELECT * FROM dm_audit ORDER BY id DESC LIMIT ?').all(limit) as Array<
    Record<string, unknown>
  >;
}
