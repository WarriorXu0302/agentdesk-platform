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
import { log } from '../../log.js';
import { classificationLogFailuresTotal, classificationsTotal } from '../../metrics.js';
import type { Session } from '../../types.js';

const ACTIONS: ReadonlyArray<ClassificationLogEntry['action']> = ['delegate', 'clarify', 'reject', 'answer_self'];

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
