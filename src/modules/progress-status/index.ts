/**
 * Lightweight progress-status hook for channels that lack a useful native
 * typing indicator (notably Feishu).
 *
 * Behavior:
 * - when an inbound message wakes an agent, we add a reaction to the user's
 *   original message
 * - when the first user-facing reply lands (or the wake/send fails), we
 *   remove that reaction
 *
 * State lives in `progress_reactions` (central DB) so it survives host
 * restarts and stays correct if the host is ever run as multiple processes.
 */
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

const DEFAULT_ENABLED_CHANNELS = new Set(['feishu']);
const DEFAULT_FEISHU_PROGRESS_EMOJI = 'THINKING';

interface ProgressReaction {
  channelType: string;
  platformId: string;
  threadId: string | null;
  sourceMessageId: string;
  reactionId: string;
  emoji: string;
}

interface ProgressReactionRow {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  source_message_id: string;
  reaction_id: string;
  emoji: string;
}

function rowToReaction(row: ProgressReactionRow): ProgressReaction {
  return {
    channelType: row.channel_type,
    platformId: row.platform_id,
    threadId: row.thread_id,
    sourceMessageId: row.source_message_id,
    reactionId: row.reaction_id,
    emoji: row.emoji,
  };
}

function getReaction(sessionId: string): ProgressReaction | null {
  const row = getDb()
    .prepare(
      `SELECT channel_type, platform_id, thread_id, source_message_id, reaction_id, emoji
         FROM progress_reactions
         WHERE session_id = ?`,
    )
    .get(sessionId) as ProgressReactionRow | undefined;
  return row ? rowToReaction(row) : null;
}

function hasReaction(sessionId: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM progress_reactions WHERE session_id = ? LIMIT 1').get(sessionId);
  return row !== undefined;
}

function saveReaction(sessionId: string, reaction: ProgressReaction): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO progress_reactions
       (session_id, channel_type, platform_id, thread_id, source_message_id, reaction_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      reaction.channelType,
      reaction.platformId,
      reaction.threadId,
      reaction.sourceMessageId,
      reaction.reactionId,
      reaction.emoji,
      new Date().toISOString(),
    );
}

function deleteReaction(sessionId: string): void {
  getDb().prepare('DELETE FROM progress_reactions WHERE session_id = ?').run(sessionId);
}

function parseEnabledChannels(raw: string | undefined): Set<string> {
  if (!raw) return new Set(DEFAULT_ENABLED_CHANNELS);
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === 'default') return new Set(DEFAULT_ENABLED_CHANNELS);
  if (normalized === 'none' || normalized === 'off' || normalized === 'false') return new Set();
  return new Set(
    normalized
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function enabledFor(channelType: string): boolean {
  return parseEnabledChannels(process.env.AGENTDESK_PROGRESS_STATUS_CHANNELS).has(channelType.toLowerCase());
}

function resolveReactionEmoji(channelType: string): string | null {
  switch (channelType.toLowerCase()) {
    case 'feishu':
      return process.env.AGENTDESK_PROGRESS_STATUS_FEISHU_EMOJI?.trim() || DEFAULT_FEISHU_PROGRESS_EMOJI;
    default:
      return null;
  }
}

export async function maybeStartProgressStatus(
  sessionId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  sourceMessageId: string | undefined,
  adapter: ChannelDeliveryAdapter | null,
): Promise<void> {
  if (!adapter) return;
  if (!enabledFor(channelType)) return;
  if (!sourceMessageId) return;
  if (hasReaction(sessionId)) return;

  const emoji = resolveReactionEmoji(channelType);
  if (!emoji) return;

  let reactionId: string | undefined;
  try {
    reactionId = await adapter.deliver(
      channelType,
      platformId,
      threadId,
      'chat',
      JSON.stringify({
        operation: 'reaction',
        action: 'add',
        messageId: sourceMessageId,
        emoji,
      }),
    );
  } catch (err) {
    log.warn('Progress reaction add failed', {
      sessionId,
      channelType,
      platformId,
      sourceMessageId,
      err,
    });
    return;
  }
  if (!reactionId) return;

  saveReaction(sessionId, {
    channelType,
    platformId,
    threadId,
    sourceMessageId,
    reactionId,
    emoji,
  });
}

async function clearProgressReaction(sessionId: string, adapter: ChannelDeliveryAdapter | null): Promise<void> {
  const entry = getReaction(sessionId);
  if (!entry) return;
  if (!adapter) {
    deleteReaction(sessionId);
    return;
  }

  try {
    await adapter.deliver(
      entry.channelType,
      entry.platformId,
      entry.threadId,
      'chat',
      JSON.stringify({
        operation: 'reaction',
        action: 'remove',
        messageId: entry.sourceMessageId,
        reactionId: entry.reactionId,
        emoji: entry.emoji,
      }),
    );
  } catch (err) {
    log.warn('Progress reaction remove failed', {
      sessionId,
      channelType: entry.channelType,
      platformId: entry.platformId,
      sourceMessageId: entry.sourceMessageId,
      reactionId: entry.reactionId,
      err,
    });
  } finally {
    deleteReaction(sessionId);
  }
}

export async function markProgressStatusCompleted(
  sessionId: string,
  adapter: ChannelDeliveryAdapter | null,
): Promise<void> {
  await clearProgressReaction(sessionId, adapter);
}

export async function markProgressStatusFailed(
  sessionId: string,
  adapter: ChannelDeliveryAdapter | null,
): Promise<void> {
  await clearProgressReaction(sessionId, adapter);
}

export function clearProgressStatus(sessionId: string): void {
  deleteReaction(sessionId);
}
