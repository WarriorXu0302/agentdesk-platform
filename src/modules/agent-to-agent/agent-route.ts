/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied into the
 * target's inbound DB; if the source message had `files` (from `send_file`),
 * the actual bytes are copied from the source's outbox into the target's
 * `inbox/<a2a-msg-id>/` directory and surfaced to the target agent as
 * `attachments` (existing formatter convention — see formatter.ts:230).
 * The target agent can then forward the file onward via its own `send_file`
 * call using the absolute `/workspace/inbox/<a2a-msg-id>/<filename>` path.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import fs from 'fs';
import path from 'path';

import { isSafeAttachmentName } from '../../attachment-safety.js';
import { readContainerConfig, type A2aSessionMode } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { recordEnterpriseAudit } from '../../db/enterprise-audit.js';
import {
  getInboundSourceSessionId,
  getMostRecentPeerSourceSessionId,
  latestConversationThreadId,
} from '../../db/session-db.js';
import { getSession, setSessionConversationThreadId } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { a2aOriginRejectedTotal } from '../../metrics.js';
import { openInboundDb, resolveSession, sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { hasDestination } from './db/agent-destinations.js';
import { collectLegitimateOrigins, resolveOriginUserId } from './origin-user.js';

export { isSafeAttachmentName };

const DEFAULT_MAX_SPAWN_DEPTH = 2;

/**
 * Cap for spawn-chain depth, a configurable default (2).
 * Read at each call so operators can tune without a restart (the host process
 * doesn't cache `process.env`). Invalid / non-positive values fall back to the
 * default rather than disabling the cap — a typo shouldn't widen the blast
 * radius.
 */
function resolveMaxSpawnDepth(): number {
  const raw = process.env.AGENTDESK_MAX_SPAWN_DEPTH;
  if (!raw) return DEFAULT_MAX_SPAWN_DEPTH;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_SPAWN_DEPTH;
  return parsed;
}

export interface ForwardedAttachment {
  name: string;
  filename: string;
  type: 'file';
  localPath: string;
}

/**
 * Copy file attachments from the source agent's outbox into the target
 * agent's inbox. Returns attachments using the formatter's existing
 * `{name, type, localPath}` convention — target agent reads `localPath`
 * as relative to `/workspace/`, matching how channel-inbound attachments
 * are surfaced today.
 *
 * Missing source files and unsafe (path-traversal) filenames are skipped
 * with a warning rather than failing the whole route — a bad filename
 * reference shouldn't kill the accompanying text.
 */
export function forwardAttachedFiles(
  source: { agentGroupId: string; sessionId: string; messageId: string; filenames: string[] },
  target: { agentGroupId: string; sessionId: string; messageId: string },
): ForwardedAttachment[] {
  if (source.filenames.length === 0) return [];

  const sourceDir = path.join(sessionDir(source.agentGroupId, source.sessionId), 'outbox', source.messageId);
  if (!fs.existsSync(sourceDir)) {
    log.warn('agent-route: source outbox dir missing, no files forwarded', {
      sourceMsgId: source.messageId,
      sourceDir,
    });
    return [];
  }

  const targetInboxDir = path.join(sessionDir(target.agentGroupId, target.sessionId), 'inbox', target.messageId);
  fs.mkdirSync(targetInboxDir, { recursive: true });

  const attachments: ForwardedAttachment[] = [];
  for (const filename of source.filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('agent-route: rejecting unsafe attachment filename (path traversal attempt?)', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const src = path.join(sourceDir, filename);
    if (!fs.existsSync(src)) {
      log.warn('agent-route: referenced file missing in source outbox, skipped', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const dst = path.join(targetInboxDir, filename);
    fs.copyFileSync(src, dst);
    attachments.push({
      name: filename,
      filename,
      type: 'file',
      localPath: `inbox/${target.messageId}/${filename}`,
    });
  }
  return attachments;
}

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  content: string;
  /**
   * For replies, the id of the inbound message being replied to. The
   * container's formatter sets this from the first inbound in the batch
   * (`container/agent-runner/src/formatter.ts`). Used here to route the
   * reply back to the originating session — see `resolveTargetSession`.
   */
  in_reply_to: string | null;
  /**
   * Namespaced user id of the human whose turn produced this delegation,
   * stamped by the container at emit time. Preferred over
   * `resolveOriginUserId(sourceInboundDb)` because it was captured when
   * the turn was actually running — the source session's "most recent
   * chat" may already belong to a different user by the time delivery
   * processes this row. Null on older containers that predate the column,
   * in which case we fall back to the source-side lookup.
   *
   * ⚠ Container-written and therefore UNTRUSTED. This value lives in the
   * source session's outbound.db, which a compromised/prompt-injected agent
   * can write arbitrarily. It is honored only after host-side
   * cross-validation against the source session's legitimate identity set
   * (see resolveOriginUserId block in routeAgentMessage + ADR-0017).
   */
  origin_user_id?: string | null;
}

/**
 * Pick which session of `targetAgentGroupId` should receive this a2a message.
 *
 * Three layers, highest-fidelity first:
 *
 * 1. **Direct return-path** (in_reply_to lookup): if the message is a reply
 *    (`in_reply_to` set), open the source agent's inbound DB and read the
 *    triggering row's `source_session_id`. That column was stamped when the
 *    original outbound was routed — it's the session that started the
 *    conversation, and replies should land there even when the target has
 *    multiple active sessions.
 *
 * 2. **Peer-affinity fallback**: if (1) misses (in_reply_to is null or the
 *    referenced row isn't an a2a inbound), look up the most recent a2a
 *    inbound *from the target agent group* in source's inbound and use its
 *    `source_session_id`. The intuition: the last time this peer talked to
 *    me, which target session was driving? Route the reply there, since
 *    that's the session most plausibly in active conversation.
 *
 * 3. **Newest active session**: legacy heuristic. Used when no prior a2a
 *    has been recorded with `source_session_id` (e.g. fresh installs,
 *    pre-migration data).
 */
function resolveTargetSession(msg: RoutableAgentMessage, sourceSession: Session, targetAgentGroupId: string): Session {
  const srcDb = openInboundDb(sourceSession.agent_group_id, sourceSession.id);
  let originSessionId: string | null = null;
  try {
    if (msg.in_reply_to) {
      originSessionId = getInboundSourceSessionId(srcDb, msg.in_reply_to);
    }
    if (!originSessionId) {
      // Peer-affinity fallback — covers the case where the container's
      // outbound write didn't carry in_reply_to (e.g. legacy MCP send_message
      // path, container running pre-fix code).
      originSessionId = getMostRecentPeerSourceSessionId(srcDb, targetAgentGroupId);
    }
  } finally {
    srcDb.close();
  }
  if (originSessionId) {
    const candidate = getSession(originSessionId);
    if (candidate && candidate.agent_group_id === targetAgentGroupId && candidate.status === 'active') {
      return candidate;
    }
  }

  const sourceDepth = sourceSession.spawn_depth ?? 0;
  const targetConfig = getTargetA2aSessionMode(targetAgentGroupId);
  if (targetConfig === 'root-session') {
    const rootSessionId = sourceSession.root_session_id ?? sourceSession.id;
    return resolveSession(
      targetAgentGroupId,
      null,
      null,
      'agent-shared',
      sourceSession.owner_user_id,
      rootSessionId,
      sourceDepth,
    ).session;
  }

  return resolveSession(targetAgentGroupId, null, null, 'agent-shared', null, null, sourceDepth).session;
}

function getTargetA2aSessionMode(targetAgentGroupId: string): A2aSessionMode {
  const target = getAgentGroup(targetAgentGroupId);
  if (!target) return 'agent-shared';
  return readContainerConfig(target.folder).a2aSessionMode ?? 'agent-shared';
}

export async function routeAgentMessage(msg: RoutableAgentMessage, session: Session): Promise<void> {
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }
  if (
    targetAgentGroupId !== session.agent_group_id &&
    !hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)
  ) {
    throw new Error(
      `unauthorized agent-to-agent: ${session.agent_group_id} has no destination for ${targetAgentGroupId}`,
    );
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
  }

  // Spawn-depth cap. Self-messages (system notifications looped back into the
  // same session) don't bump depth so they're never blocked. Cross-agent
  // edges: `target.depth = source.depth + 1`; reject if that would exceed
  // AGENTDESK_MAX_SPAWN_DEPTH (default 2). The agent_destinations ACL is still the primary
  // protection — this is the runtime defense-in-depth that catches a
  // misconfigured destination table.
  if (targetAgentGroupId !== session.agent_group_id) {
    const cap = resolveMaxSpawnDepth();
    const sourceDepth = session.spawn_depth ?? 0;
    if (sourceDepth >= cap) {
      throw new Error(
        `spawn-depth cap exceeded: source ${session.agent_group_id} session ${session.id} is at depth ${sourceDepth}, AGENTDESK_MAX_SPAWN_DEPTH=${cap}`,
      );
    }
  }

  const targetSession = resolveTargetSession(msg, session, targetAgentGroupId);
  const a2aMsgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // If the source message references files (via `send_file`), forward the
  // bytes from the source's outbox into the target's inbox so the target
  // agent can actually see and re-send them. Without this, agent-to-agent
  // file attachments look like they arrive but the target has no way to
  // read the bytes — they live in a session dir it doesn't mount.
  const forwardedContent = forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id);

  // Propagate the origin user so the worker can attribute ERP calls to the
  // real employee. The container's self-reported value (msg.origin_user_id)
  // lives in the source session's outbound.db — container-written and NOT
  // trusted (ADR-0017). A prompt-injected agent can stamp an arbitrary
  // victim id there. We therefore cross-validate against the source
  // session's inbound.db (host-written, trusted) before honoring it. Both
  // the validation set and the fallback lookup read the same DB, so it is
  // opened once.
  //
  // Priority:
  //   1. msg.origin_user_id — stamped by the container at emit time
  //      (container/agent-runner/src/mcp-tools/core.ts), accepted ONLY if it
  //      is a member of the source session's legitimate identity set (i.e.
  //      that user actually appeared in this session). This captures "whose
  //      turn was running when this delegation was produced" — the source
  //      session's most-recent-chat can already belong to a different user
  //      by the time delivery processes this row. A claim that fails
  //      validation is treated as forged: dropped, counted, and we fall
  //      through to (2).
  //   2. resolveOriginUserId(sourceInboundDb) — host-side lookup of the
  //      session's most recent real chat (trusted). Also the path for older
  //      containers that predate the column.
  //   3. session.owner_user_id — last resort for per-user-pinned sessions.
  let originUserId: string | null = null;
  // Conversation thread id (ADR-0039): pure correlation, read from the SOURCE
  // session's inbound.db AFTER the origin cross-validation below. inbound.db is
  // authoritative per-message, so this chains across hops (each hop's inbound row
  // carries the id the previous hop wrote). Null-safe — never an authz input,
  // never blocks routing.
  let conversationThreadId: string | null = null;
  const srcDbForOrigin = openInboundDb(session.agent_group_id, session.id);
  try {
    const claimed = msg.origin_user_id ?? null;
    if (claimed) {
      const legitimate = collectLegitimateOrigins(srcDbForOrigin);
      if (legitimate.has(claimed)) {
        originUserId = claimed;
      } else {
        a2aOriginRejectedTotal.inc({ source_agent_group: session.agent_group_id });
        log.warn('agent-route: rejecting container-claimed origin_user_id not in source session identity set', {
          from: session.agent_group_id,
          sourceSession: session.id,
          claimedOriginUserId: claimed,
        });
      }
    }
    if (!originUserId) {
      originUserId = resolveOriginUserId(srcDbForOrigin);
    }
    conversationThreadId = latestConversationThreadId(srcDbForOrigin);
  } finally {
    srcDbForOrigin.close();
  }
  if (!originUserId) originUserId = session.owner_user_id ?? null;

  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: a2aMsgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: forwardedContent,
    sourceSessionId: session.id,
    originUserId,
    conversationThreadId,
  });
  // Carry the thread id onto the target session row too, so the target's own
  // classify_intent (which reads the session row) records the same id and the
  // target becomes a valid source for its own downstream hops (ADR-0039).
  if (conversationThreadId) setSessionConversationThreadId(targetSession.id, conversationThreadId);
  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
    a2aMsgId,
    forwardedFileCount: countForwardedFiles(forwardedContent),
    originUserId,
  });
  // Audit the delegation hop (roadmap 5.5): the gateway layer audits backend
  // calls, but the AgentDesk delegation boundary had no breadcrumb — a multi-hop
  // approval chain (frontdesk → approver → finance worker) was invisible in the
  // platform's own audit. Cross-agent edges only; self-messages are system
  // loopbacks, not delegations. Actor is the cross-validated origin user.
  if (targetAgentGroupId !== session.agent_group_id) {
    recordEnterpriseAudit({
      eventType: 'agent_delegation',
      agentGroupId: session.agent_group_id,
      actor: originUserId,
      details: {
        from: session.agent_group_id,
        to: targetAgentGroupId,
        sourceSessionId: session.id,
        targetSessionId: targetSession.id,
        a2aMsgId,
        spawnDepth: session.spawn_depth ?? 0,
      },
    });
  }
  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);
}

/**
 * Parse source content, copy any referenced `files` from source outbox to
 * target inbox, and return a JSON string with an `attachments` array added
 * (formatter.ts:223 already knows how to render this shape).
 *
 * If the source content isn't JSON or has no files, returns the original
 * content string unchanged — this is safe to call on every route.
 */
function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  const files = parsed.files as unknown;
  if (!Array.isArray(files) || files.length === 0) return msg.content;
  const filenames = files.filter((f): f is string => typeof f === 'string');
  if (filenames.length === 0) return msg.content;

  const attachments = forwardAttachedFiles(
    {
      agentGroupId: sourceSession.agent_group_id,
      sessionId: sourceSession.id,
      messageId: msg.id,
      filenames,
    },
    {
      agentGroupId: targetAgentGroupId,
      sessionId: targetSessionId,
      messageId: a2aMsgId,
    },
  );

  // Merge into any existing `attachments` (unlikely in a2a context but safe).
  const existing = Array.isArray(parsed.attachments) ? (parsed.attachments as Record<string, unknown>[]) : [];
  parsed.attachments = [...existing, ...attachments];

  return JSON.stringify(parsed);
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}
