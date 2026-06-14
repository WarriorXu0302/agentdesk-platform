/**
 * Out-of-band cancel for pending interactive requests (ADR-0042, roadmap 6.6).
 *
 * A user who sent a misfired request (wrong order id, wrong recipient) can stop
 * it by typing an exact cancel command — `/cancel`, `cancel`, `取消`, or `停止`
 * — instead of waiting for the agent to finish and then asking for a rollback
 * (especially bad for approval flows). The host resolves the user's own pending
 * question(s) with a `__cancelled__` sentinel down the SAME `question_response`
 * wire a button click uses, so the container's `ask_user_question` unblocks and
 * the agent learns the request was withdrawn.
 *
 * Isolation (load-bearing): a cancel resolves ONLY the sender's own pending
 * question(s), scoped by the session's host-established `owner_user_id` (see
 * findCancelablePendingQuestions). In shared / per-thread / agent-shared
 * sessions `owner_user_id` is NULL, so the lookup matches nothing and cancel is
 * a structural no-op there — one user can never cancel another's request.
 *
 * Conservative interception: only EXACT whole-message cancel tokens are matched
 * (never substrings, so "cancel my 3pm meeting" routes to the agent normally),
 * and the message is consumed only when the sender actually has a cancelable
 * pending question — otherwise it passes through untouched. Any error degrades
 * to pass-through so a cancel failure never disrupts normal routing.
 */
import { CANCEL_SENTINEL } from '../../channels/ask-question.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { findCancelablePendingQuestions, getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { resolveSender, setMessageInterceptor } from '../../router.js';
import { resolvePendingQuestion } from './index.js';

/** Exact whole-message tokens that mean "cancel my pending request". */
const CANCEL_TOKENS = new Set(['/cancel', 'cancel', '取消', '停止']);

function readText(event: InboundEvent): string | undefined {
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    return typeof parsed.text === 'string' ? parsed.text.trim() : undefined;
  } catch {
    return undefined;
  }
}

setMessageInterceptor(async (event: InboundEvent): Promise<boolean> => {
  try {
    // Cheap gate first: only exact whole-message cancel tokens reach the DB.
    const text = readText(event);
    if (!text || !CANCEL_TOKENS.has(text.toLowerCase())) return false;

    // Host-established sender identity — never an agent/sender-claimed field.
    const userId = resolveSender(event);
    if (!userId) return false; // can't scope safely → let it route normally

    const pending = findCancelablePendingQuestions(userId);
    if (pending.length === 0) return false; // nothing of theirs → pass through to the agent

    for (const pq of pending) {
      const session = getSession(pq.session_id);
      if (!session) continue;
      await resolvePendingQuestion(session, pq, CANCEL_SENTINEL, userId, { cancelled: true });
    }

    // Acknowledge on the same channel the user typed from (best-effort).
    const adapter = getDeliveryAdapter();
    if (adapter) {
      const n = pending.length;
      adapter
        .deliver(
          event.channelType,
          event.platformId,
          event.threadId,
          'chat-sdk',
          JSON.stringify({ text: `Cancelled ${n} pending request${n > 1 ? 's' : ''}.` }),
        )
        .catch(() => {});
    }

    log.info('Out-of-band cancel resolved pending question(s)', { userId, count: pending.length });
    return true; // consumed
  } catch (err) {
    log.warn('Cancel interceptor error — passing message through', { err });
    return false; // never disrupt routing
  }
});
