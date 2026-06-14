import { getDb } from './connection.js';

/** Opt-in retention: delete classification_log rows older than `olderThanMs`
 *  (idx_classification_log_at). Gated default-OFF by the caller (host-sweep). */
export function purgeClassificationLog(olderThanMs: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  return getDb().prepare(`DELETE FROM classification_log WHERE occurred_at < ?`).run(cutoff).changes;
}

export interface ClassificationLogEntry {
  classificationId?: string | null;
  sessionId?: string | null;
  agentGroupId?: string | null;
  userId?: string | null;
  channelType?: string | null;
  platformId?: string | null;
  threadId?: string | null;
  userMessage?: string | null;
  recommendedWorker?: string | null;
  confidence?: number | null;
  candidates?: string[] | null;
  reasoning?: string | null;
  action: 'delegate' | 'clarify' | 'reject' | 'answer_self' | 'escalate';
  outcomeRef?: string | null;
  // Escalation hook (ADR-0038). Only set when action='escalate'. Both are
  // untrusted agent-supplied metadata recorded for observability/audit — never
  // an input to any authz/priority decision. `urgencyLevel` is coerced to a
  // closed enum at the host boundary before it reaches here.
  escalationReason?: string | null;
  urgencyLevel?: string | null;
  // Top-level conversation correlation id (ADR-0039). Read from the host session
  // (not the agent payload), so a multi-hop chain shares one id. NULL until a
  // thread is minted. Pure correlation — never an authz/routing input.
  conversationThreadId?: string | null;
}

export function recordClassification(entry: ClassificationLogEntry, now: Date = new Date()): void {
  getDb()
    .prepare(
      `INSERT INTO classification_log
         (occurred_at, classification_id, session_id, agent_group_id, user_id,
          channel_type, platform_id, thread_id, user_message,
          recommended_worker, confidence, candidates, reasoning, action, outcome_ref,
          escalation_reason, urgency_level, conversation_thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now.toISOString(),
      entry.classificationId ?? null,
      entry.sessionId ?? null,
      entry.agentGroupId ?? null,
      entry.userId ?? null,
      entry.channelType ?? null,
      entry.platformId ?? null,
      entry.threadId ?? null,
      entry.userMessage ? entry.userMessage.slice(0, 500) : null,
      entry.recommendedWorker ?? null,
      entry.confidence ?? null,
      entry.candidates ? JSON.stringify(entry.candidates) : null,
      entry.reasoning ? entry.reasoning.slice(0, 1000) : null,
      entry.action,
      entry.outcomeRef ?? null,
      entry.escalationReason ? entry.escalationReason.slice(0, 500) : null,
      entry.urgencyLevel ?? null,
      entry.conversationThreadId ?? null,
    );
}

/**
 * Look up a classification by the id the tool returned. Returns the row
 * or undefined. Used by the delivery path to find a prior classification
 * and stamp outcome_ref on it.
 */
export function findClassificationById(classificationId: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare('SELECT * FROM classification_log WHERE classification_id = ? LIMIT 1')
    .get(classificationId) as Record<string, unknown> | undefined;
}

/**
 * Stamp `outcome_ref` onto an existing row. Session-bound so a stale
 * classificationId reused across sessions can't link an outcome onto a
 * different turn's audit row. Idempotent: if outcome_ref is already
 * set (earlier delivery already linked something) we leave it alone —
 * the first delivery wins.
 *
 * Returns true when we actually wrote.
 */
export function linkOutcome(classificationId: string, outcomeRef: string, sessionId: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE classification_log
         SET outcome_ref = ?
         WHERE classification_id = ?
           AND session_id = ?
           AND (outcome_ref IS NULL OR outcome_ref = '')`,
    )
    .run(outcomeRef, classificationId, sessionId);
  return info.changes > 0;
}

export interface ClassificationQueryOptions {
  limit?: number;
  userId?: string;
  recommendedWorker?: string;
  action?: ClassificationLogEntry['action'];
  since?: string;
}

export function queryClassificationLog(options: ClassificationQueryOptions = {}): Array<Record<string, unknown>> {
  const where: string[] = [];
  const params: Array<string> = [];
  if (options.userId) {
    where.push('user_id = ?');
    params.push(options.userId);
  }
  if (options.recommendedWorker) {
    where.push('recommended_worker = ?');
    params.push(options.recommendedWorker);
  }
  if (options.action) {
    where.push('action = ?');
    params.push(options.action);
  }
  if (options.since) {
    where.push('occurred_at >= ?');
    params.push(options.since);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  return getDb()
    .prepare(`SELECT * FROM classification_log ${whereClause} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as Array<Record<string, unknown>>;
}
