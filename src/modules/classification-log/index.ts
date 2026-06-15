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
import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../../delivery.js';
import { recordClassification, type ClassificationLogEntry } from '../../db/classification-log.js';
import { recordEnterpriseAudit } from '../../db/enterprise-audit.js';
import { log } from '../../log.js';
import {
  classificationActorRejectedTotal,
  classificationLogFailuresTotal,
  classificationsTotal,
  escalationTotal,
  routingFeedbackTotal,
} from '../../metrics.js';
// Pure leaf helper (type-only deps, no side effects) — reused so the actor
// cross-validation uses the EXACT same namespacing as the a2a origin check.
import { collectLegitimateOrigins } from '../agent-to-agent/origin-user.js';
import type { Session } from '../../types.js';

const ACTIONS: ReadonlyArray<ClassificationLogEntry['action']> = ['delegate', 'clarify', 'reject', 'answer_self'];

const URGENCY_LEVELS = new Set(['low', 'medium', 'high', 'critical']);

/** Coerce agent-supplied urgency to a closed enum at the host boundary (ADR-0038). */
function coerceUrgency(raw: unknown): string {
  return typeof raw === 'string' && URGENCY_LEVELS.has(raw) ? raw : 'unknown';
}

const FEEDBACK_KINDS = new Set(['misroute', 'nack']);

/** Coerce worker-supplied routing-feedback kind to a closed enum at the host boundary (ADR-0040). */
function coerceFeedbackKind(raw: unknown): string {
  return typeof raw === 'string' && FEEDBACK_KINDS.has(raw) ? raw : 'unknown';
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

/**
 * Resolve the host-trusted actor for a recording-surface row (classify_intent /
 * escalate / routing_feedback). These tables are audit-level ground truth, so
 * the actor must stay host-anchored — never an agent-spoofable field:
 *
 *  - A session with a host-established owner (per-user / per-user-per-thread, or
 *    a root-pinned session) IS the authoritative actor; a container-claimed
 *    userId that disagrees is ignored + warned (prior behavior, unchanged).
 *  - With NO owner (shared / per-thread / agent-shared frontdesk group sessions —
 *    owner_user_id is NULL) a container-claimed userId is accepted ONLY if that
 *    user genuinely appeared in this session, cross-validated against the
 *    HOST-written inbound.db (the same check the a2a hop uses, ADR-0017). A
 *    fabricated victim id that never entered the session is dropped to null +
 *    counted, so a prompt-injected frontdesk/worker cannot stamp an arbitrary
 *    actor into the audit corpus. (ADR-0017 identity trust chain; closes the
 *    owner-NULL dead spot found by the as-merged recording-surface audit.)
 */
function resolveTrustedActor(
  action: string,
  session: Session,
  claimedUserId: string | null,
  inDb: Database.Database,
): string | null {
  if (session.owner_user_id) {
    if (claimedUserId && claimedUserId !== session.owner_user_id) {
      log.warn(`${action} userId mismatch — trusting session owner`, {
        sessionId: session.id,
        claimed: claimedUserId,
        session: session.owner_user_id,
      });
    }
    return session.owner_user_id;
  }
  // No host-established owner: a claimed id is only trustworthy if the host saw
  // that user pass through this session. Anything else is unverifiable → null.
  if (!claimedUserId) return null;
  let legitimate: Set<string>;
  try {
    legitimate = collectLegitimateOrigins(inDb);
  } catch (err) {
    log.warn(`${action}: legitimate-origin lookup failed — dropping unverifiable actor`, {
      sessionId: session.id,
      err,
    });
    return null;
  }
  if (legitimate.has(claimedUserId)) return claimedUserId;
  classificationActorRejectedTotal.labels(action).inc();
  log.warn(`${action}: rejecting container-claimed userId not in session identity set`, {
    sessionId: session.id,
    claimed: claimedUserId,
  });
  return null;
}

async function handleClassifyIntent(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const action = toAction(content.action_taken);

  // Host-anchored actor: session owner when set, else cross-validate the
  // container-claimed userId against the host-written inbound.db (audit-level
  // ground truth can't take an agent-spoofable field at face value).
  const claimedUserId = readString(content, 'userId') ?? null;
  const trustedUserId = resolveTrustedActor('classify_intent', session, claimedUserId, inDb);

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
async function handleEscalate(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  // Host-anchored actor: session owner when set, else accept the agent-claimed
  // userId only if that user genuinely appeared in this session (owner-NULL
  // shared/group frontdesk). See resolveTrustedActor.
  const claimedUserId = readString(content, 'userId') ?? null;
  const trustedUserId = resolveTrustedActor('escalate', session, claimedUserId, inDb);

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

/**
 * Worker routing feedback (ADR-0040, roadmap 2.1 misroute + 2.5 nack). A worker
 * emits a SEPARATE `routing_feedback` system action (orthogonal to classify_intent
 * and escalate — never a routing decision value) carrying kind (misroute|nack) +
 * an optional free-text reason + an optional suggested-target hint. The host
 * RECORDS it: a classification_log row (action='routing_feedback'), an
 * enterprise_audit `agent_routing_feedback` breadcrumb, and the
 * routing_feedback_total metric.
 *
 * Core does NOT re-route — that was REJECTED in ADR-0040 (agent-shared inbound.db
 * identity pollution + double return-path), so real reroute is the operator
 * gateway's job. This handler has NO send/inbound write path by construction:
 * worker-claimed fields are untrusted, the actor is the host-established session
 * owner, kind is coerced to a closed enum, and the suggested-target is stored
 * verbatim for operator dashboards but NEVER resolved/authz-checked/routed.
 */
async function handleRoutingFeedback(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  // Host-anchored actor: session owner when set, else accept the agent-claimed
  // userId only if that user genuinely appeared in this session. See
  // resolveTrustedActor.
  const claimedUserId = readString(content, 'userId') ?? null;
  const trustedUserId = resolveTrustedActor('routing_feedback', session, claimedUserId, inDb);

  const kind = coerceFeedbackKind(content.feedback_kind);
  const reason = readString(content, 'feedback_reason') ?? null;
  // Worker's "should have gone to X" hint — recorded verbatim, NEVER validated
  // against destinations / resolved to a session / used to route (ADR-0040).
  const suggestedTarget = readString(content, 'suggested_target') ?? null;
  // Correlation back to frontdesk's original classify row (host runtime attaches
  // it across the a2a hop). Untrusted hint for an operator join only — never used
  // in linkOutcome, never mutates the original row.
  const misroutedClassificationId = readString(content, 'classificationId') ?? null;

  const entry: ClassificationLogEntry = {
    classificationId: misroutedClassificationId,
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    userId: trustedUserId,
    channelType: readString(content, 'channelType') ?? null,
    platformId: readString(content, 'platformId') ?? null,
    threadId: readString(content, 'threadId') ?? null,
    // Reuse recommended_worker as the verbatim, UNVALIDATED suggested-target hint.
    recommendedWorker: suggestedTarget ? suggestedTarget.slice(0, 120) : null,
    reasoning: reason,
    action: 'routing_feedback',
    // Recording-only is terminal — no further outbound — so self-stamp the
    // outcome (mirrors escalate's 'escalated' and classify's 'self:reject').
    outcomeRef: `feedback:${kind}`,
    feedbackKind: kind,
    conversationThreadId: session.conversation_thread_id ?? null,
  };

  try {
    recordClassification(entry);
  } catch (err) {
    classificationLogFailuresTotal.labels('write_error').inc();
    log.error('routing_feedback classification_log write failed', { sessionId: session.id, err });
    // Still emit the audit + metric below — the governance breadcrumb shouldn't
    // depend on the analytics-table write succeeding.
  }

  recordEnterpriseAudit({
    eventType: 'agent_routing_feedback',
    agentGroupId: session.agent_group_id,
    actor: trustedUserId,
    details: {
      kind,
      reason,
      suggestedTarget,
      misroutedClassificationId,
      sourceSessionId: session.id,
    },
  });

  // `reported_by` = the worker group that raised the feedback (bounded). The
  // suggested-target is deliberately NOT a label — it lives in the row above.
  routingFeedbackTotal.inc({ kind, reported_by: session.agent_group_id ?? 'unknown' });
}

registerDeliveryAction('routing_feedback', handleRoutingFeedback);
