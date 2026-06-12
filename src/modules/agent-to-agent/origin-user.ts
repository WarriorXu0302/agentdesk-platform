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
 *
 * ─── Trust model (load-bearing — see ADR-0017) ───────────────────────────
 * The source session's inbound.db is HOST-written and therefore trusted:
 * channel-side chat rows are stamped by the host at delivery time, and a2a
 * inbound rows carry `origin_user_id` values the host already cross-validated
 * on a prior hop. The source session's outbound.db is CONTAINER-written and
 * NOT trusted. `collectLegitimateOrigins` exists so the router can verify a
 * container-asserted origin against the set of identities that genuinely
 * passed through this session, rather than taking the container's word.
 */
import type Database from 'better-sqlite3';

interface InboundOriginRow {
  origin_user_id: string | null;
  content: string;
  channel_type: string | null;
}

/**
 * Derive the namespaced `<channel>:<id>` form of a chat row's sender.
 *
 * Returns the row's already-namespaced `origin_user_id` when present
 * (earlier a2a hops carry it), otherwise normalizes the content's
 * `senderId`: a bare id is prefixed with the row's `channel_type`, an id
 * that already contains `:` (or a row with no channel_type) is taken
 * verbatim. Returns null when neither identity is present.
 */
function namespacedOriginOf(row: InboundOriginRow): string | null {
  if (row.origin_user_id && row.origin_user_id.length > 0) return row.origin_user_id;

  // An a2a row (channel_type='agent') carries identity ONLY in the
  // host-written origin_user_id column above. Its `content` is forwarded
  // container output and is attacker-controllable — a prompt-injected
  // container can stamp `content.senderId='feishu:victim'`. Deriving identity
  // from it would let that forged id enter the legitimate-origin set on the
  // next hop and defeat the cross-validation. Never read content for agent
  // rows. See ADR-0017.
  if (row.channel_type === 'agent') return null;

  try {
    const parsed = JSON.parse(row.content ?? '{}') as Record<string, unknown>;
    // System-injected rows (host tool-failure pushes etc.) carry no operator
    // identity; excluding them keeps the synthetic 'system' sender out of the
    // legitimate-origin set. Mirrors isSystemSenderRow in the runner's
    // request-identity.ts.
    if (parsed.sender === 'system') return null;
    const raw = typeof parsed.senderId === 'string' ? parsed.senderId.trim() : '';
    if (!raw) return null;
    if (raw.includes(':') || !row.channel_type) return raw;
    return `${row.channel_type}:${raw}`;
  } catch {
    return null;
  }
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
  return namespacedOriginOf(row);
}

/**
 * Collect every identity that legitimately passed through this session.
 *
 * Scans all chat-origin rows in the (host-written, trusted) inbound.db and
 * returns the set of namespaced `<channel>:<id>` user ids derived from each
 * row — both the propagated `origin_user_id` column and the senderId of
 * channel-side rows. This is the session's "legitimate identity set".
 *
 * The a2a router uses it to cross-validate a container-asserted
 * `origin_user_id`: the assertion is honored only if it is a member of this
 * set, which proves the claimed user actually appeared in the source session.
 * A prompt-injected container that fabricates an arbitrary victim id (one
 * that never entered the session) is rejected because the fabricated id is
 * absent here. Legitimate multi-user sessions still work: every user who
 * genuinely spoke in the session is in the set, so correct attribution to
 * any of them passes.
 */
export function collectLegitimateOrigins(inboundDb: Database.Database): Set<string> {
  const rows = inboundDb
    .prepare(
      `SELECT origin_user_id, content, channel_type
         FROM messages_in
         WHERE kind IN ('chat', 'chat-sdk')`,
    )
    .all() as InboundOriginRow[];

  const origins = new Set<string>();
  for (const row of rows) {
    const id = namespacedOriginOf(row);
    if (id) origins.add(id);
  }
  return origins;
}
