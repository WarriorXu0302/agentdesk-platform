/**
 * Session lifecycle: folders, DBs, messages, container status.
 *
 * Two-DB split — inbound.db (host writes) + outbound.db (container writes).
 * Three cross-mount invariants are load-bearing:
 *   1. journal_mode=DELETE — WAL's mmapped -shm doesn't refresh host→guest;
 *      the container would silently miss every new message.
 *   2. Host opens-writes-CLOSES per op — close invalidates the container's
 *      page cache; a long-lived connection freezes its view at first read.
 *   3. One writer per file — DELETE-mode journal-unlink isn't atomic across
 *      the mount; concurrent writers corrupt the DB.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { deriveAttachmentName } from './attachment-naming.js';
import { isSafeAttachmentName } from './attachment-safety.js';
import type { OutboundFile } from './channels/adapter.js';
import { DATA_DIR } from './config.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import {
  createSession,
  findSessionByAgentGroup,
  findSessionForAgent,
  findSessionForAgentOwner,
  findSessionForAgentRoot,
  getSession,
  updateSession,
} from './db/sessions.js';
import {
  ensureSchema,
  openInboundDb as openInboundDbRaw,
  openOutboundDb as openOutboundDbRaw,
  openOutboundDbRw as openOutboundDbRwRaw,
  openOutboundDbForRacyWrite as openOutboundDbForRacyWriteRaw,
  upsertSessionRouting,
  insertMessage,
  migrateMessagesInTable,
} from './db/session-db.js';
import { log } from './log.js';
import type { Session } from './types.js';

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Root directory for all session data. */
export function sessionsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-sessions');
}

/** Directory for a specific session: sessions/{agent_group_id}/{session_id}/ */
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
}

/** Path to the host-owned inbound DB (messages_in + delivered). */
export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'inbound.db');
}

/** Path to the container-owned outbound DB (messages_out + processing_ack). */
export function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'outbound.db');
}

/** Path to the container heartbeat file (touched instead of DB writes). */
export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.heartbeat');
}

/**
 * @deprecated Use inboundDbPath / outboundDbPath instead.
 * Kept temporarily for test compatibility during migration.
 */
export function sessionDbPath(agentGroupId: string, sessionId: string): string {
  return inboundDbPath(agentGroupId, sessionId);
}

function generateId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isUserScopedSessionMode(
  sessionMode: 'shared' | 'per-thread' | 'agent-shared' | 'per-user' | 'per-user-per-thread',
): sessionMode is 'per-user' | 'per-user-per-thread' {
  return sessionMode === 'per-user' || sessionMode === 'per-user-per-thread';
}

/**
 * Find or create a session for a messaging group + thread.
 *
 * Session modes:
 * - 'shared': one session per messaging group (ignores threadId)
 * - 'per-thread': one session per (messaging group, thread)
 * - 'agent-shared': one session per agent group — all messaging groups
 *   wired with this mode share a single session (e.g. GitHub + Slack)
 * - 'per-user': one session per (messaging group, sender)
 * - 'per-user-per-thread': one session per (messaging group, sender, thread)
 *
 * `rootSessionId` is an internal a2a lane override. When present, it scopes
 * the resolved session to a stable business/root conversation rather than the
 * target agent group as a whole.
 *
 * `sourceDepth` (a2a-only) is the spawn_depth of the session that triggered
 * this resolve. New sessions are created at `sourceDepth + 1`; existing
 * sessions are returned unchanged. Channel-entry callers leave this null so
 * frontdesk-style sessions start at 0.
 */
export function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared' | 'per-user' | 'per-user-per-thread',
  ownerUserId: string | null = null,
  rootSessionId: string | null = null,
  sourceDepth: number | null = null,
): { session: Session; created: boolean } {
  if (isUserScopedSessionMode(sessionMode) && !ownerUserId) {
    throw new Error(`ownerUserId is required for session_mode=${sessionMode}`);
  }

  if (rootSessionId) {
    const existing = findSessionForAgentRoot(agentGroupId, rootSessionId);
    if (existing) {
      return { session: existing, created: false };
    }
  }

  if (!rootSessionId) {
    // agent-shared: single session per agent group, regardless of messaging group
    if (sessionMode === 'agent-shared') {
      const existing = findSessionByAgentGroup(agentGroupId);
      if (existing) {
        return { session: existing, created: false };
      }
    } else if (messagingGroupId) {
      const lookupThreadId = sessionMode === 'shared' || sessionMode === 'per-user' ? null : threadId;
      let existing: Session | undefined;
      if (isUserScopedSessionMode(sessionMode)) {
        existing = findSessionForAgentOwner(agentGroupId, messagingGroupId, ownerUserId as string, lookupThreadId);
      } else {
        // Scope lookup by agent_group_id so fan-out to multiple agents in the
        // same chat doesn't accidentally deliver to the wrong agent's session.
        existing = findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
      }
      if (existing) {
        return { session: existing, created: false };
      }
    }
  }

  const id = generateId();
  const lookupThreadId = sessionMode === 'per-thread' || sessionMode === 'per-user-per-thread' ? threadId : null;
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: lookupThreadId,
    owner_user_id: rootSessionId ? ownerUserId : isUserScopedSessionMode(sessionMode) ? ownerUserId : null,
    root_session_id: rootSessionId ?? id,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    spawn_depth: sourceDepth === null ? 0 : sourceDepth + 1,
    created_at: new Date().toISOString(),
  };

  createSession(session);
  initSessionFolder(agentGroupId, id);
  log.info('Session created', {
    id,
    agentGroupId,
    messagingGroupId,
    threadId: lookupThreadId,
    ownerUserId: session.owner_user_id,
    rootSessionId: session.root_session_id,
    spawnDepth: session.spawn_depth,
    sessionMode,
  });

  return { session, created: true };
}

/** Create the session folder and initialize both DBs. */
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });

  ensureSchema(inboundDbPath(agentGroupId, sessionId), 'inbound');
  ensureSchema(outboundDbPath(agentGroupId, sessionId), 'outbound');
}

/**
 * Write the default reply routing for a session into its inbound.db.
 *
 * The container reads this as the default (channel_type, platform_id, thread_id)
 * for outbound messages when the agent doesn't specify an explicit destination.
 * Derived from session.messaging_group_id → messaging_groups row + session.thread_id.
 *
 * Called on every container wake alongside the agent-to-agent module's
 * writeDestinations() (when installed) so the latest routing is always in
 * place, including after admin rewiring.
 */
export function writeSessionRouting(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const session = getSession(sessionId);
  if (!session) return;

  let channelType: string | null = null;
  let platformId: string | null = null;
  if (session.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg) {
      channelType = mg.channel_type;
      platformId = mg.platform_id;
    }
  }

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    upsertSessionRouting(db, {
      channel_type: channelType,
      platform_id: platformId,
      thread_id: session.thread_id,
    });
  } finally {
    db.close();
  }
  log.debug('Session routing written', { sessionId, channelType, platformId, threadId: session.thread_id });
}

/**
 * Write a message to a session's inbound DB (messages_in). Host-only.
 *
 * ⚠ Opens and closes the DB on every call. Do not refactor to reuse a
 * long-lived connection — see the "Cross-mount visibility invariants" note
 * at the top of this file.
 */
export function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    platformId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
    content: string;
    processAfter?: string | null;
    recurrence?: string | null;
    /**
     * 1 = this message should wake the agent (the default); 0 = accumulate
     * as context only, don't wake. Host's countDueMessages gates on this
     * column; the container still reads all prior messages as context when
     * a trigger-1 message does arrive.
     */
    trigger?: 0 | 1;
    /**
     * For agent-to-agent inbound: the source session id that emitted the
     * outbound message which became this inbound row. Used as the return
     * path so the target's reply routes back to that exact session.
     */
    sourceSessionId?: string | null;
    /**
     * For agent-to-agent inbound: the namespaced user id of the employee
     * who ultimately triggered the chain. Propagates identity into worker
     * sessions so downstream ERP calls don't fall back to agent-asserted.
     * NULL on channel-side inbound (senderId already embedded in content).
     */
    originUserId?: string | null;
  },
): void {
  // Extract base64 attachment data, save to inbox, replace with file paths
  const content = extractAttachmentFiles(agentGroupId, sessionId, message.id, message.content);

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    insertMessage(db, {
      id: message.id,
      kind: message.kind,
      timestamp: message.timestamp,
      platformId: message.platformId ?? null,
      channelType: message.channelType ?? null,
      threadId: message.threadId ?? null,
      content,
      processAfter: message.processAfter ?? null,
      recurrence: message.recurrence ?? null,
      trigger: message.trigger ?? 1,
      sourceSessionId: message.sourceSessionId ?? null,
      originUserId: message.originUserId ?? null,
    });
  } finally {
    db.close();
  }

  updateSession(sessionId, { last_active: new Date().toISOString() });
}

/**
 * If message content has attachments with base64 `data`, save them to
 * the session's inbox directory and replace with `localPath`.
 *
 * Both `messageId` and `att.name` originate in untrusted input. WhatsApp
 * passes `msg.key.id` through raw (and that field is client generated, so a
 * peer can craft it), and other adapters may follow. The session dir is
 * mounted writable into the container, so a compromised agent can also
 * pre-place a symlink at `inbox/<future msgId>/` and wait for a chat message
 * with a matching id to redirect the host's write.
 *
 * Defenses, mirrored from the outbound side:
 *   1. basename check on `messageId` and `filename`.
 *   2. lstat of the inbox dir to refuse pre-placed symlinks.
 *   3. realpath-based containment under the session inbox root.
 *   4. `wx` flag on writeFileSync to refuse following a pre-existing symlink
 *      at the target file path or overwriting any existing file.
 */
function extractAttachmentFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  contentStr: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return contentStr;
  }

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments)) return contentStr;

  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe inbound message id', { messageId });
    return contentStr;
  }

  let changed = false;
  for (const att of attachments) {
    if (typeof att.data !== 'string') continue;

    const rawName = deriveAttachmentName(att);
    const filename = isSafeAttachmentName(rawName) ? rawName : `attachment-${Date.now()}`;
    if (filename !== rawName) {
      log.warn('Refused unsafe attachment filename, would escape inbox', {
        messageId,
        rawName,
        replacement: filename,
      });
    }

    const inboxDir = path.join(sessionDir(agentGroupId, sessionId), 'inbox', messageId);

    // Refuse to mkdir through a symlink that the container may have pre placed
    // at inboxDir. With recursive:true, mkdirSync would silently no op on a
    // pre existing symlink and the subsequent writeFileSync would follow it.
    if (fs.existsSync(inboxDir)) {
      const stat = fs.lstatSync(inboxDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        log.warn('Rejecting unsafe inbox directory', { messageId, inboxDir });
        continue;
      }
    }
    fs.mkdirSync(inboxDir, { recursive: true });

    let realInboxDir: string;
    try {
      realInboxDir = fs.realpathSync(inboxDir);
    } catch (err) {
      log.warn('Failed to resolve inbox directory', { messageId, err });
      continue;
    }
    const inboxRoot = path.join(sessionDir(agentGroupId, sessionId), 'inbox');
    if (!isPathInside(fs.realpathSync(inboxRoot), realInboxDir)) {
      log.warn('Inbox directory escaped session inbox root', { messageId, inboxDir });
      continue;
    }

    const filePath = path.join(inboxDir, filename);
    try {
      // wx = exclusive create. Refuses to follow a pre existing symlink or
      // overwrite any existing file. The host expects to be the sole writer
      // of these attachments.
      fs.writeFileSync(filePath, Buffer.from(att.data as string, 'base64'), { flag: 'wx' });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EEXIST') {
        log.warn('Inbox attachment target already exists, refusing to overwrite', {
          messageId,
          filename,
        });
        continue;
      }
      throw err;
    }

    att.name = filename;
    att.localPath = `inbox/${messageId}/${filename}`;
    delete att.data;
    changed = true;
    log.debug('Saved attachment to inbox', { messageId, filename, size: att.size });
  }

  return changed ? JSON.stringify(parsed) : contentStr;
}

/** Open the inbound DB for a session (host reads/writes). */
export function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  const db = openInboundDbRaw(inboundDbPath(agentGroupId, sessionId));
  migrateMessagesInTable(db);
  return db;
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRaw(outboundDbPath(agentGroupId, sessionId));
}

/** Open the outbound DB for a session with write access. Only safe to call when no container is running. */
export function openOutboundDbRw(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRwRaw(outboundDbPath(agentGroupId, sessionId));
}

/**
 * Open outbound.db for a brief, racy write (host short-circuit, admin
 * deny-command response). Short busy_timeout — caller must handle SQLite
 * busy errors as a soft failure (fall back to LLM path).
 */
export function openOutboundDbForRacyWrite(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbForRacyWriteRaw(outboundDbPath(agentGroupId, sessionId));
}

/**
 * Write a message directly to a session's outbound DB so the host delivery
 * loop picks it up. Used by:
 *   - the command gate to send denial responses without waking a container
 *   - the semantic-router short-circuit for fixed-template replies
 *
 * Returns `true` on success, `false` on database-busy / write failure
 * (caller should fall back to the regular routing path). The container
 * normally owns this DB as sole writer; a short busy_timeout (500ms) keeps
 * the host's routing thread responsive when the container is busy. WAL
 * mode is intentionally NOT used (Docker bind-mount + -shm/-wal files are
 * unreliable across host/container boundaries).
 */
export function writeOutboundDirect(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
    inReplyTo?: string | null;
  },
): boolean {
  let db: Database.Database | null = null;
  try {
    db = openOutboundDbForRacyWrite(agentGroupId, sessionId);
    db.prepare(
      `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content, in_reply_to)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'), ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.kind,
      message.platformId,
      message.channelType,
      message.threadId,
      message.content,
      message.inReplyTo ?? null,
    );
    return true;
  } catch (err) {
    // Most likely SQLITE_BUSY — container holds an exclusive lock. Caller
    // falls back to LLM path; the user message still gets a reply, just
    // not via the short-circuit fast path.
    return false;
  } finally {
    db?.close();
  }
}

/**
 * @deprecated Use openInboundDb / openOutboundDb instead.
 */
export function openSessionDb(agentGroupId: string, sessionId: string): Database.Database {
  return openInboundDb(agentGroupId, sessionId);
}

/** Write a system response to a session's inbound.db so the container's findQuestionResponse() picks it up. */
export function writeSystemResponse(
  agentGroupId: string,
  sessionId: string,
  requestId: string,
  status: string,
  result: Record<string, unknown>,
): void {
  writeSessionMessage(agentGroupId, sessionId, {
    id: `sys-resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      type: 'question_response',
      questionId: requestId,
      status,
      result,
    }),
  });
}

/**
 * Load outbox attachments for a delivered message.
 *
 * Symmetric with `extractAttachmentFiles` on the inbound side: the container
 * writes files into the session's `outbox/<messageId>/` directory alongside
 * its `messages_out` row, and the host reads them back at delivery time.
 *
 * Returns undefined when the outbox dir is missing or no declared file was
 * actually on disk — delivery continues without attachments rather than
 * failing the whole message.
 */
export function readOutboxFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  filenames: string[],
): OutboundFile[] | undefined {
  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe outbox message id', { messageId });
    return undefined;
  }

  const outboxDir = path.join(sessionDir(agentGroupId, sessionId), 'outbox', messageId);
  if (!fs.existsSync(outboxDir)) return undefined;

  let realOutboxDir: string;
  try {
    const stat = fs.lstatSync(outboxDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      log.warn('Rejecting unsafe outbox directory', { messageId, outboxDir });
      return undefined;
    }
    realOutboxDir = fs.realpathSync(outboxDir);
  } catch (err) {
    log.warn('Failed to inspect outbox directory', { messageId, err });
    return undefined;
  }

  const files: OutboundFile[] = [];
  for (const filename of filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('Refused unsafe outbox filename, would escape outbox', { messageId, filename });
      continue;
    }

    const filePath = path.join(outboxDir, filename);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        log.warn('Rejecting unsafe outbox file', { messageId, filename });
        continue;
      }
      const realFilePath = fs.realpathSync(filePath);
      if (!isPathInside(realOutboxDir, realFilePath)) {
        log.warn('Rejecting outbox file outside message directory', { messageId, filename });
        continue;
      }
      files.push({ filename, data: fs.readFileSync(realFilePath) });
    } catch {
      log.warn('Outbox file not found', { messageId, filename });
    }
  }
  return files.length > 0 ? files : undefined;
}

/**
 * Remove a message's outbox directory after successful delivery. Best-effort:
 * failures log and swallow. A cleanup failure must NOT propagate to the
 * delivery caller — the message is already on the user's screen, and a
 * thrown error would trigger the delivery retry path and deliver twice.
 */
export function clearOutbox(agentGroupId: string, sessionId: string, messageId: string): void {
  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe outbox cleanup message id', { messageId });
    return;
  }

  const outboxDir = path.join(sessionDir(agentGroupId, sessionId), 'outbox', messageId);
  if (!fs.existsSync(outboxDir)) return;
  try {
    const stat = fs.lstatSync(outboxDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      log.warn('Rejecting unsafe outbox cleanup directory', { messageId, outboxDir });
      return;
    }
    const realOutboxBase = fs.realpathSync(path.join(sessionDir(agentGroupId, sessionId), 'outbox'));
    const realOutboxDir = fs.realpathSync(outboxDir);
    if (!isPathInside(realOutboxBase, realOutboxDir)) {
      log.warn('Rejecting outbox cleanup outside session outbox', { messageId, outboxDir });
      return;
    }
    fs.rmSync(realOutboxDir, { recursive: true, force: true });
  } catch (err) {
    log.warn('Outbox cleanup failed (message already delivered)', { messageId, err });
  }
}

/** Mark a container as running for a session. */
export function markContainerRunning(sessionId: string): void {
  updateSession(sessionId, { container_status: 'running', last_active: new Date().toISOString() });
}

/** Mark a container as idle for a session. */
export function markContainerIdle(sessionId: string): void {
  updateSession(sessionId, { container_status: 'idle' });
}

/** Mark a container as stopped for a session. */
export function markContainerStopped(sessionId: string): void {
  updateSession(sessionId, { container_status: 'stopped' });
}
