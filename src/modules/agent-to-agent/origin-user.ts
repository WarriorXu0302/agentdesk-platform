/**
 * Resolve the "origin user" of an agent-to-agent hop.
 *
 * When session A emits an a2a message to session B, we want session B to
 * attribute downstream ERP calls to the same human employee who kicked off
 * the whole chain. This lookup walks the source session's inbound.db for
 * the most recent chat-origin row and pulls the namespaced user id from:
 *
 *   1. That row's `origin_user_id` column (set on earlier a2a hops —
 *      preserves identity across N-deep delegation chains), or
 *   2. The content JSON's `senderId` for fresh channel-side messages,
 *      normalized to `<channel>:<id>` form.
 *
 * Returns null when neither is present (e.g. scheduled tasks, or the
 * chain started with a system prompt and no human ever entered the loop).
 */
import type Database from 'better-sqlite3';

interface InboundOriginRow {
  origin_user_id: string | null;
  content: string;
  channel_type: string | null;
}

export function resolveOriginUserId(inboundDb: Database.Database): string | null {
  const row = inboundDb
    .prepare(
      `SELECT origin_user_id, content, channel_type
         FROM messages_in
         WHERE kind IN ('chat', 'chat-sdk')
         ORDER BY seq DESC
         LIMIT 1`,
    )
    .get() as InboundOriginRow | undefined;
  if (!row) return null;
  if (row.origin_user_id && row.origin_user_id.length > 0) return row.origin_user_id;

  try {
    const parsed = JSON.parse(row.content ?? '{}') as Record<string, unknown>;
    const raw = typeof parsed.senderId === 'string' ? parsed.senderId.trim() : '';
    if (!raw) return null;
    if (raw.includes(':') || !row.channel_type) return raw;
    return `${row.channel_type}:${raw}`;
  } catch {
    return null;
  }
}
