/**
 * Interactive module — generic ask_user_question flow.
 *
 * Container-side `ask_user_question` writes a chat-sdk card to outbound.db +
 * polls inbound.db for a `question_response` system message. On the host side
 * this module handles the button-click response: look up the pending_questions
 * row, write the response into the session's inbound.db, wake the container.
 *
 * The `createPendingQuestion` call in `deliverMessage` (delivery.ts) stays
 * inline in core — it's 15 lines guarded by `hasTable('pending_questions')`,
 * modularizing it adds more registry surface than it saves.
 */
import { getDb, hasTable } from '../../db/connection.js';
import { deletePendingQuestion, getPendingQuestion, getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingQuestion, Session } from '../../types.js';

/**
 * Resolve a pending question: write the `question_response` system message the
 * container's ask_user_question is polling for, delete the pending row, and wake
 * the container. Shared by the button-click handler and the out-of-band cancel
 * path (ADR-0042) so both use the identical, proven resolution wire.
 *
 * `cancelled` adds an additive `cancelled: true` field (older readers ignore it)
 * alongside the `__cancelled__` sentinel so the agent can tell a withdrawal from
 * a real answer. The host is the sole writer of the session inbound.db here
 * (three-DB single-writer), via the same writeSessionMessage path as a click.
 */
export async function resolvePendingQuestion(
  session: Session,
  pq: PendingQuestion,
  selectedOption: string,
  userId: string | null,
  opts: { cancelled?: boolean } = {},
): Promise<void> {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${pq.question_id}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: pq.platform_id,
    channelType: pq.channel_type,
    threadId: pq.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId: pq.question_id,
      selectedOption,
      userId: userId ?? '',
      ...(opts.cancelled ? { cancelled: true } : {}),
    }),
  });

  deletePendingQuestion(pq.question_id);
  await wakeContainer(session);
}

async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!hasTable(getDb(), 'pending_questions')) return false;

  const pq = getPendingQuestion(payload.questionId);
  if (!pq) return false;

  const session = getSession(pq.session_id);
  if (!session) {
    log.warn('Session not found for pending question', { questionId: payload.questionId, sessionId: pq.session_id });
    deletePendingQuestion(payload.questionId);
    return true; // claimed — we owned this questionId even though the session is gone
  }

  await resolvePendingQuestion(session, pq, payload.value, payload.userId);
  log.info('Question response routed', {
    questionId: payload.questionId,
    selectedOption: payload.value,
    sessionId: session.id,
  });

  return true;
}

registerResponseHandler(handleInteractiveResponse);
