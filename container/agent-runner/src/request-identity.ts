/**
 * Build a trusted RequestIdentity from a batch of pending inbound messages.
 *
 * Trust hierarchy (highest first):
 *
 *   1. a2a inbound row's `origin_user_id` — host-written on the a2a
 *      forward, carries the originating employee's id across delegation
 *      chains. The container cannot forge this column.
 *   2. chat/chat-sdk inbound row's content.senderId — host-written from
 *      the channel adapter. Namespaced to `<channel>:<id>` when missing
 *      the namespace prefix.
 *
 * Scope: we pick the FIRST trigger=1 message in chronological order
 * (oldest first) — that's the one the agent will reply to. Accumulated
 * context-only rows (trigger=0) are ignored for identity; they may be
 * interleaved from other users in group sessions, and using "most recent"
 * would let a race-in message override who gets attributed to the reply.
 */
import type { MessageInRow } from './db/messages-in.js';
import type { RequestIdentity } from './request-context.js';

/**
 * System-injected rows (e.g. host-pushed tool failures, kind=chat with
 * sender='system') must not be picked as the identity trigger — otherwise
 * they appear as a fake user 'agent:system' and trip the poll-loop's
 * identity-change guard mid-turn. They carry no real operator identity.
 */
function isSystemSenderRow(row: MessageInRow): boolean {
  if (!row.content) return false;
  try {
    const parsed = JSON.parse(row.content) as Record<string, unknown>;
    return parsed.sender === 'system';
  } catch {
    return false;
  }
}

/**
 * Extract identity for a single inbound row. Exported because batch
 * splitting wants per-row identities, not just the head-of-batch one.
 */
export function rowIdentity(row: MessageInRow): RequestIdentity {
  const origin = row.origin_user_id?.trim();
  if (origin) {
    return {
      userId: origin,
      channelType: row.channel_type ?? null,
      platformId: row.platform_id ?? null,
      threadId: row.thread_id ?? null,
      source: 'session',
    };
  }

  // An a2a row (channel_type='agent') carries identity ONLY in the
  // host-written origin_user_id column checked above. Its content is
  // forwarded agent output and may carry a forged senderId; deriving identity
  // from it here would let an honest worker re-assert a fabricated origin on
  // its own outbound hop (source='session'), which the host then accepts.
  // Treat agent rows with no origin column as identity-less. See ADR-0017.
  let userId: string | null = null;
  if (row.channel_type !== 'agent') {
    try {
      const parsed = JSON.parse(row.content ?? '{}') as Record<string, unknown>;
      const rawSenderId = typeof parsed.senderId === 'string' ? parsed.senderId.trim() : '';
      if (rawSenderId) {
        userId =
          rawSenderId.includes(':') || !row.channel_type ? rawSenderId : `${row.channel_type}:${rawSenderId}`;
      }
    } catch {
      // content not JSON — leave userId null
    }
  }

  return {
    userId,
    channelType: row.channel_type ?? null,
    platformId: row.platform_id ?? null,
    threadId: row.thread_id ?? null,
    source: userId ? 'session' : 'agent-asserted',
  };
}

/**
 * Pick the identity that anchors a batch (first trigger=1 chat row,
 * falling back to head-of-batch for all-accumulate or task-only
 * batches). Exported so the turn-change guard can compare incoming
 * batches' anchor identity against the turn's.
 */
export function resolveBatchIdentity(batch: MessageInRow[]): RequestIdentity {
  const trigger =
    batch.find(
      (m) => m.trigger === 1 && (m.kind === 'chat' || m.kind === 'chat-sdk') && !isSystemSenderRow(m),
    ) ?? batch[0];
  if (!trigger) {
    return { userId: null, channelType: null, platformId: null, threadId: null, source: 'agent-asserted' };
  }
  if (isSystemSenderRow(trigger)) {
    return { userId: null, channelType: null, platformId: null, threadId: null, source: 'agent-asserted' };
  }
  return rowIdentity(trigger);
}

/**
 * Split a batch into:
 *   - `keep`: rows that share the anchor identity's routing surface
 *     (same user, channel, platform, thread). These are safe to push
 *     into the active turn.
 *   - `defer`: rows belonging to a different user / channel / thread,
 *     which must be returned to pending so a fresh turn picks them up
 *     with the correct identity pinned.
 *
 * Pure function — caller decides what to do with `defer` (today:
 * release their processing_ack claims so getPendingMessages yields
 * them again next tick).
 *
 * Non-chat kinds (task / system / webhook) ride with the anchor.
 * They have no user identity to compare against; keeping them together
 * matches the pre-split behavior for those message kinds.
 */
export function splitBatchByTurn(batch: MessageInRow[]): { keep: MessageInRow[]; defer: MessageInRow[] } {
  if (batch.length === 0) return { keep: [], defer: [] };
  const anchor = resolveBatchIdentity(batch);
  const keep: MessageInRow[] = [];
  const defer: MessageInRow[] = [];
  for (const row of batch) {
    // Non-chat rows stay with the anchor batch — they aren't routed by
    // user identity (tasks fire under whatever turn is active at their
    // deliver_after time, webhooks are shared across users, etc.).
    if (row.kind !== 'chat' && row.kind !== 'chat-sdk') {
      keep.push(row);
      continue;
    }
    const rowId = rowIdentity(row);
    // Only split on session-trusted mismatches. If either side is
    // agent-asserted there's nothing reliable to match against, so we
    // keep everything together — matches the existing turn-guard
    // semantics in shouldEndForTurnChange.
    if (anchor.source !== 'session' || rowId.source !== 'session') {
      keep.push(row);
      continue;
    }
    const sameUser = anchor.userId === rowId.userId;
    const sameChannel = (anchor.channelType ?? '') === (rowId.channelType ?? '');
    const samePlatform = (anchor.platformId ?? '') === (rowId.platformId ?? '');
    const sameThread = (anchor.threadId ?? null) === (rowId.threadId ?? null);
    if (sameUser && sameChannel && samePlatform && sameThread) {
      keep.push(row);
    } else {
      defer.push(row);
    }
  }
  return { keep, defer };
}
