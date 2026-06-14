/**
 * Classification-log delivery-action handler.
 *
 * Frontdesk's `classify_intent` MCP tool emits a system outbound with
 * `action='classify_intent'`. We persist it into the classification_log
 * table so you can:
 *
 *   - see what frontdesk is routing (and why)
 *   - build a regression test corpus of real user messages + the
 *     classifier's decision
 *   - correlate downstream worker failures back to the intent
 *
 * Best-effort writes (same pattern as gateway_audit): a DB failure logs and
 * drops — don't block the container's message flow on metric bookkeeping.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { recordClassification, type ClassificationLogEntry } from '../../db/classification-log.js';
import { recordEnterpriseAudit } from '../../db/enterprise-audit.js';
import { log } from '../../log.js';
import { classificationLogFailuresTotal, classificationsTotal, escalationTotal } from '../../metrics.js';
import type { Session } from '../../types.js';

const ACTIONS: ReadonlyArray<ClassificationLogEntry['action']> = ['delegate', 'clarify', 'reject', 'answer_self'];

const URGENCY_LEVELS = new Set(['low', 'medium', 'high', 'critical']);

/** Coerce agent-supplied urgency to a closed enum at the host boundary (ADR-0038). */
function coerceUrgency(raw: unknown): string {
  return typeof raw === 'string' && URGENCY_LEVELS.has(raw) ? raw : 'unknown';
}

/**
 * Bucket a free-text reason into a bounded slug for the metric label only
 * (ADR-0038 — prevent Prometheus cardinality blowup). The FULL reason text goes
 * to classification_log + the enterprise_audit row; this is just the label.
 * Operators further constrain the agent's reason vocabulary via the frontdesk
 * prompt, so in practice this stays a small set.
 */
function bucketReason(reason: string | null): string {
  if (!reason) return 'unspecified';
  const slug = reason
    .trim()
    .toLowerCase()
    .split(/\s+/)[0]
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 24);
  return slug || 'other';
}

function readString(content: Record<string, unknown>, key: string): string | undefined {
  const value = content[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(content: Record<string, unknown>, key: string): number | undefined {
  const value = content[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(content: Record<string, unknown>, key: string): string[] | undefined {
  const value = content[key];
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : undefined;
}

function toAction(raw: unknown): ClassificationLogEntry['action'] {
  return typeof raw === 'string' && (ACTIONS as readonly string[]).includes(raw)
    ? (raw as ClassificationLogEntry['action'])
    : 'delegate';
}

async function handleClassifyIntent(content: Record<string, unknown>, session: Session): Promise<void> {
  const action = toAction(content.action_taken);

  // Prefer the session's owner_user_id (host-established identity) over
  // whatever the agent wrote in the payload. If they disagree we warn
  // and still trust session. Matters because this table is documented as
  // audit-level ground truth — it can't take an agent-spoofable field
  // at face value.
  const claimedUserId = readString(content, 'userId') ?? null;
  const trustedUserId = session.owner_user_id ?? claimedUserId ?? null;
  if (claimedUserId && session.owner_user_id && claimedUserId !== session.owner_user_id) {
    log.warn('classify_intent userId mismatch — trusting session owner', {
      sessionId: session.id,
      claimed: claimedUserId,
      session: session.owner_user_id,
    });
  }

  const entry: ClassificationLogEntry = {
    classificationId: readString(content, 'classificationId') ?? null,
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    userId: trustedUserId,
    channelType: readString(content, 'channelType') ?? null,
    platformId: readString(content, 'platformId') ?? null,
    threadId: readString(content, 'threadId') ?? null,
    userMessage: readString(content, 'userMessage') ?? null,
    recommendedWorker: readString(content, 'recommendedWorker') ?? null,
    confidence: readNumber(content, 'confidence') ?? null,
    candidates: readStringArray(content, 'candidates') ?? null,
    reasoning: readString(content, 'reasoning') ?? null,
    action,
    outcomeRef: readString(content, 'outcomeRef') ?? null,
    // Conversation thread id from the host session (ADR-0039) — not the agent
    // payload — so a multi-hop chain shares one id. NULL until a thread is minted.
    conversationThreadId: session.conversation_thread_id ?? null,
  };

  // For actions that produce no further outbound (reject / answer_self),
  // stamp outcome_ref inline so those rows aren't permanently NULL.
  // delegate / clarify will have their outcome_ref filled later by the
  // delivery reconciliation path when the actual send_message /
  // ask_user_question fires.
  if ((action === 'reject' || action === 'answer_self') && !entry.outcomeRef) {
    entry.outcomeRef = `self:${action}`;
  }

  try {
    recordClassification(entry);
  } catch (err) {
    classificationLogFailuresTotal.labels('write_error').inc();
    log.error('classification_log write failed', { sessionId: session.id, err });
    return;
  }

  classificationsTotal.labels(action).inc();
}

registerDeliveryAction('classify_intent', handleClassifyIntent);

/**
 * Explicit AI→human escalation (ADR-0038, roadmap 2.3). The frontdesk emits a
 * SEPARATE `escalate` system action (orthogonal to classify_intent — never a
 * worker-routing decision) carrying escalation_reason + urgency_level. The host
 * RECORDS it: a classification_log row (action='escalate'), an enterprise_audit
 * `agent_escalation` breadcrumb, and the escalation_total metric. Core does NOT
 * route to a human or apply queue priority — that is the operator gateway's job,
 * which reads these records. reason/urgency are untrusted agent metadata: logged
 * + audited + (bucketed) metric label only, NEVER an input to any decision.
 */
async function handleEscalate(content: Record<string, unknown>, session: Session): Promise<void> {
  // Trust the host-established session owner over any agent-claimed userId —
  // same rule as classify_intent (this is a frontdesk decision within the
  // session, not a cross-session a2a hop, so origin cross-validation does not
  // apply; the session owner is the authoritative actor).
  const claimedUserId = readString(content, 'userId') ?? null;
  const trustedUserId = session.owner_user_id ?? claimedUserId ?? null;
  if (claimedUserId && session.owner_user_id && claimedUserId !== session.owner_user_id) {
    log.warn('escalate userId mismatch — trusting session owner', {
      sessionId: session.id,
      claimed: claimedUserId,
      session: session.owner_user_id,
    });
  }

  const reason = readString(content, 'escalation_reason') ?? null;
  const urgency = coerceUrgency(content.urgency_level);

  const entry: ClassificationLogEntry = {
    classificationId: readString(content, 'classificationId') ?? null,
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    userId: trustedUserId,
    channelType: readString(content, 'channelType') ?? null,
    platformId: readString(content, 'platformId') ?? null,
    threadId: readString(content, 'threadId') ?? null,
    userMessage: readString(content, 'userMessage') ?? null,
    action: 'escalate',
    outcomeRef: 'escalated',
    escalationReason: reason,
    urgencyLevel: urgency,
    conversationThreadId: session.conversation_thread_id ?? null,
  };

  try {
    recordClassification(entry);
  } catch (err) {
    classificationLogFailuresTotal.labels('write_error').inc();
    log.error('escalation classification_log write failed', { sessionId: session.id, err });
    // Still emit the audit + metric below — the durable governance breadcrumb
    // shouldn't depend on the analytics-table write succeeding.
  }

  // Durable governance breadcrumb: the operator gateway reads this row to route
  // the escalation. The full free-text reason lives here (not just the metric).
  recordEnterpriseAudit({
    eventType: 'agent_escalation',
    agentGroupId: session.agent_group_id,
    actor: trustedUserId,
    details: {
      reason,
      urgency,
      sourceSessionId: session.id,
      classificationId: entry.classificationId,
    },
  });

  escalationTotal.inc({ reason: bucketReason(reason), urgency, outcome: 'recorded' });
}

registerDeliveryAction('escalate', handleEscalate);
