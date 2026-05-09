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

export function resolveBatchIdentity(batch: MessageInRow[]): RequestIdentity {
  const trigger = batch.find((m) => m.trigger === 1 && (m.kind === 'chat' || m.kind === 'chat-sdk')) ?? batch[0];
  if (!trigger) {
    return { userId: null, channelType: null, platformId: null, threadId: null, source: 'agent-asserted' };
  }

  const origin = trigger.origin_user_id?.trim();
  if (origin) {
    return {
      userId: origin,
      channelType: trigger.channel_type ?? null,
      platformId: trigger.platform_id ?? null,
      threadId: trigger.thread_id ?? null,
      source: 'session',
    };
  }

  let userId: string | null = null;
  try {
    const parsed = JSON.parse(trigger.content ?? '{}') as Record<string, unknown>;
    const rawSenderId = typeof parsed.senderId === 'string' ? parsed.senderId.trim() : '';
    if (rawSenderId) {
      userId = rawSenderId.includes(':') || !trigger.channel_type
        ? rawSenderId
        : `${trigger.channel_type}:${rawSenderId}`;
    }
  } catch {
    // content not JSON — leave userId null
  }

  return {
    userId,
    channelType: trigger.channel_type ?? null,
    platformId: trigger.platform_id ?? null,
    threadId: trigger.thread_id ?? null,
    source: userId ? 'session' : 'agent-asserted',
  };
}
