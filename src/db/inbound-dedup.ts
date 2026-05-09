/**
 * Inbound message dedup — first-seen wins.
 *
 * Feishu (and a few other webhooks) deliver at-least-once under retries.
 * `markInboundSeen` does `INSERT OR IGNORE` on (channel, event_id) and
 * returns true when the row was newly inserted, false when it was already
 * present. Callers use the false return to short-circuit routing.
 */
import { getDb } from './connection.js';

export function markInboundSeen(channel: string, eventId: string, now: Date = new Date()): boolean {
  const trimmed = eventId.trim();
  if (!trimmed) return true;
  const stmt = getDb().prepare('INSERT OR IGNORE INTO inbound_dedup (channel, event_id, seen_at) VALUES (?, ?, ?)');
  const info = stmt.run(channel, trimmed, now.toISOString());
  return info.changes > 0;
}

export function pruneInboundDedup(olderThanMs: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  const info = getDb().prepare('DELETE FROM inbound_dedup WHERE seen_at < ?').run(cutoff);
  return info.changes;
}
