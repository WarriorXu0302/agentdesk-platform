/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import type Database from 'better-sqlite3';

import { getRunningSessions, getActiveSessions, createPendingQuestion } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { findClassificationById, linkOutcome } from './db/classification-log.js';
import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroupByPlatform } from './db/messaging-groups.js';
import {
  getDueOutboundMessages,
  getUndeliverableIds,
  getDeliveryAttempts,
  markDelivered,
  markDeliveryFailed,
  migrateDeliveredTable,
} from './db/session-db.js';
import {
  DELIVERY_BACKOFF_SCHEDULE_SEC,
  DELIVERY_CONCURRENCY,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_TIMEOUT_MS,
} from './config.js';
import { log } from './log.js';
import {
  classificationBypassTotal,
  deliveryFailuresTotal,
  deliveryPermanentFailuresTotal,
  deliveryRetriesTotal,
} from './metrics.js';
import { normalizeOptions } from './channels/ask-question.js';
import {
  checkGrantLive,
  reserveRosterSend,
  rollbackRosterReservation,
  resolveDeployQuota,
  revokeParticipantInScope,
  DEFAULT_RATE_WINDOWS,
  type RateKeys,
} from './db/dm-grants.js';
import { recordDmAudit } from './db/dm-audit.js';
import {
  hostScopeForSession,
  isRootSessionModeForRosterDm,
  looksLikeRawPlatformId,
  rosterDmEnabledForGroup,
  rosterVerifyMembershipEnabled,
  originGroupPlatformIdForGrant,
} from './roster-dm.js';
import { rosterGatewayAuthorityEnabled, authorizeDm, gatewayHasSigningKey } from './roster-gateway.js';
import { readContainerConfig } from './container-config.js';
import { rosterDmRejectedTotal } from './metrics.js';
import { clearOutbox, openInboundDb, openOutboundDb, readOutboxFiles } from './session-manager.js';
import { markProgressStatusCompleted, markProgressStatusFailed } from './modules/progress-status/index.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter } from './modules/typing/index.js';
import type { OutboundFile } from './channels/adapter.js';
import type { Session } from './types.js';
import { chainAttrs, outputAttrs } from './observability/openinference.js';
import { withSpan } from './observability/with-span.js';
import { getActiveSpan } from './observability/tracer.js';
import { clearSessionSpanContext, getSessionSpanContext, endSessionRootSpan } from './observability/context-bridge.js';
import { setSpanContextWithActive, context } from './observability/trace-context.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;

class DeliveryTimeoutError extends Error {
  constructor(ms: number) {
    super(`channel deliver() timed out after ${ms}ms`);
    this.name = 'DeliveryTimeoutError';
  }
}

/**
 * Bound a channel-adapter call. Rejecting here does NOT cancel the
 * underlying call — if it later succeeds anyway, the scheduled retry
 * re-sends and the user may see a duplicate. At-least-once is the
 * deliberate choice (ADR-0016): the alternative (assume delivered on
 * timeout) silently drops messages.
 */
function withDeliveryTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeliveryTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Sessions whose outbound queue is currently being drained.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages, and a running session
 * is in *both* result sets. Without this guard, the two timer chains can
 * race on the same outbound row: both read it as undelivered, both call
 * the channel adapter, both markDelivered (idempotent in the DB via the
 * status-gated upsert — but the user has already seen the message twice).
 *
 * Skipping (vs. queueing) is correct: any message left over when the
 * second caller skips will be picked up on the next poll tick (~1s).
 */
const inflightDeliveries = new Set<string>();

/**
 * Short-lived membership cache (ADR-0023 item 12). When ROSTER_VERIFY_MEMBERSHIP
 * is on, every roster send would otherwise hit the channel's group-member API;
 * a tiny TTL cache collapses bursts (e.g. a per-participant broadcast) into one
 * call per (group, member) per window without keeping a stale answer long
 * enough to matter for revocation latency. Keyed by `${channelType}|${platformId}|${userHandle}`.
 */
const MEMBERSHIP_CACHE_TTL_MS = 30_000;
const membershipCache = new Map<string, { value: boolean | undefined; expiresAt: number }>();

async function isMemberCached(
  adapter: ChannelDeliveryAdapter,
  channelType: string,
  groupPlatformId: string,
  userHandle: string,
  now: number = Date.now(),
): Promise<boolean | undefined> {
  if (!adapter.isMember) return undefined;
  const key = `${channelType}|${groupPlatformId}|${userHandle}`;
  const hit = membershipCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  let value: boolean | undefined;
  try {
    value = await adapter.isMember(channelType, groupPlatformId, userHandle);
  } catch (err) {
    // Treat an API error as "unknown" (undefined), NOT "not a member" — a flaky
    // members API must not start dropping legitimate DMs. Unknown falls back to
    // the item-11 revoke paths.
    log.warn('roster-dm: isMember check threw — treating as unknown', { groupPlatformId, err });
    value = undefined;
  }
  // Cache definite answers only; don't pin an "unknown" so a transient API blip
  // is retried on the next send rather than masking a real membership change.
  if (value !== undefined) membershipCache.set(key, { value, expiresAt: now + MEMBERSHIP_CACHE_TTL_MS });
  return value;
}

/** Test seam: clear the membership cache between cases. */
export function __clearMembershipCacheForTests(): void {
  membershipCache.clear();
}

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
  ): Promise<string | undefined>;
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
  /**
   * Optional strong membership check (ADR-0023 item 12). Returns whether
   * `userHandle` is still a member of the group `platformId`. A definite
   * boolean lets the roster gate fail-closed on "not a member"; `undefined`
   * means the channel can't answer right now (API error / unknown) and the
   * gate falls back to the item-11 revoke paths. Only consulted when
   * ROSTER_VERIFY_MEMBERSHIP=true. Channels that can't query membership omit
   * this method entirely.
   */
  isMember?(channelType: string, platformId: string, userHandle: string): Promise<boolean | undefined>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

/**
 * Callbacks fired when the delivery adapter is first set (and again if it's
 * replaced). Lets modules that need the adapter at boot (e.g. approvals →
 * OneCLI handler) hook in without core calling into the module directly.
 *
 * Not a general-purpose registry — narrow lifecycle hook only.
 */
type AdapterReadyCallback = (adapter: ChannelDeliveryAdapter) => void | Promise<void>;
const adapterReadyCallbacks: AdapterReadyCallback[] = [];

/** Current delivery adapter or null if not yet set. Modules use this in live
 *  message-flow handlers where the adapter is guaranteed to be set. For
 *  boot-time setup (before the adapter is ready), use onDeliveryAdapterReady. */
export function getDeliveryAdapter(): ChannelDeliveryAdapter | null {
  return deliveryAdapter;
}

export function onDeliveryAdapterReady(cb: AdapterReadyCallback): void {
  adapterReadyCallbacks.push(cb);
  if (deliveryAdapter) {
    // Already set — fire immediately so late registrations still run.
    void Promise.resolve()
      .then(() => cb(deliveryAdapter as ChannelDeliveryAdapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
  // Forward to the typing module so it can fire setTyping on its own
  // interval. Direct call, not a registry — typing is a default module.
  setTypingAdapter(adapter);
  for (const cb of adapterReadyCallbacks) {
    void Promise.resolve()
      .then(() => cb(adapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

/**
 * Drain a list of sessions through a bounded worker pool. The previous
 * serial loop had cross-session head-of-line blocking: one slow channel
 * call stalled delivery for every other session for its full duration.
 * Per-session ordering is unaffected — inflightDeliveries still rejects
 * concurrent drains of the same session, and one poll's session list never
 * contains duplicates.
 */
async function drainSessionsBounded(sessions: Session[], limit: number): Promise<void> {
  const queue = [...sessions];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let session = queue.shift(); session !== undefined; session = queue.shift()) {
      try {
        await deliverSessionMessages(session);
      } catch (err) {
        // Per-session isolation: one session's drain error must not abort
        // the remaining queue for this tick.
        log.error('Session delivery drain error', { sessionId: session.id, err });
      }
    }
  });
  await Promise.all(workers);
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    await drainSessionsBounded(getRunningSessions(), DELIVERY_CONCURRENCY);
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    await drainSessionsBounded(getActiveSessions(), DELIVERY_CONCURRENCY);
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(pollSweep, SWEEP_POLL_MS);
}

export async function deliverSessionMessages(session: Session): Promise<void> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above.
  if (inflightDeliveries.has(session.id)) return;
  inflightDeliveries.add(session.id);

  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}

async function drainSession(session: Session): Promise<void> {
  const parentSpanContext = getSessionSpanContext(session.id);
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return; // DBs might not exist yet
  }

  const allDue = getDueOutboundMessages(outDb);
  if (allDue.length === 0) {
    outDb.close();
    inDb.close();
    return;
  }

  // Bring the delivered table up to schema BEFORE querying it — the
  // undeliverable filter reads the attempts / next_retry_at columns, which
  // pre-existing session DBs don't have yet.
  migrateDeliveredTable(inDb);

  const undeliverable = getUndeliverableIds(inDb, DELIVERY_MAX_ATTEMPTS);
  const undelivered = allDue.filter((m) => !undeliverable.has(m.id));
  if (undelivered.length === 0) {
    outDb.close();
    inDb.close();
    return;
  }

  const drainFn = async () => {
    let handledOutbound = false;
    let lastDeliveredText: string | undefined;

    try {
      for (const msg of undelivered) {
        try {
          if (msg.kind === 'llm-usage') {
            const drainSpan = getActiveSpan();
            drainSpan?.addEvent('llm-usage.skipped', { 'msg.id': msg.id });
            markDelivered(inDb, msg.id, null);
            handledOutbound = true;
            continue;
          }
          const platformMsgId = await deliverMessage(msg, session, inDb);
          markDelivered(inDb, msg.id, platformMsgId ?? null);
          // Delete outbox attachment files only AFTER the delivered row is
          // durably recorded. The old order (clear inside deliverMessage,
          // before this markDelivered) meant a crash in between re-delivered
          // the message WITHOUT its attachments on the next run. Best-effort: a
          // cleanup failure must not flip an already-delivered message back
          // into the retry path (worst case: orphan outbox files, not loss).
          try {
            clearOutbox(session.agent_group_id, session.id, msg.id);
          } catch (err) {
            log.warn('clearOutbox after delivery failed — orphan outbox files left behind', { id: msg.id, err });
          }
          handledOutbound = true;

          if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
            try {
              const parsed = JSON.parse(msg.content);
              if (typeof parsed.text === 'string') {
                lastDeliveredText = parsed.text;
              }
            } catch {
              lastDeliveredText = msg.content;
            }
          }

          if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
            await markProgressStatusCompleted(session.id, deliveryAdapter);
            pauseTypingRefreshAfterDelivery(session.id);
          }
        } catch (err) {
          // Attempt counts are persisted in the delivered table (ADR-0016)
          // so retry state survives host restarts.
          const attempts = getDeliveryAttempts(inDb, msg.id) + 1;
          deliveryFailuresTotal.labels(err instanceof DeliveryTimeoutError ? 'timeout' : 'error').inc();
          if (attempts >= DELIVERY_MAX_ATTEMPTS) {
            markDeliveryFailed(inDb, msg.id, attempts, null);
            deliveryPermanentFailuresTotal.inc();
            log.error('Message delivery failed permanently, automatic retries exhausted', {
              messageId: msg.id,
              sessionId: session.id,
              attempts,
              err,
            });
            handledOutbound = true;
            if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
              await markProgressStatusFailed(session.id, deliveryAdapter);
              // Tell the user their reply couldn't be delivered, instead of
              // leaving them with a vanished "thinking" indicator and silence.
              // Best-effort + loop-safe: a DIRECT adapter call (not re-queued, so
              // it can never re-enter this permanent-failure path) using the same
              // adapter that just failed. If the channel is fully down this also
              // fails — but for message-specific failures (too long / bad format)
              // a short text note still gets through. Never throws. (roadmap 6.1)
              if (deliveryAdapter && msg.channel_type && msg.platform_id) {
                try {
                  await deliveryAdapter.deliver(
                    msg.channel_type,
                    msg.platform_id,
                    msg.thread_id,
                    'chat',
                    JSON.stringify({
                      text: "⚠️ I couldn't deliver my last reply — it kept failing, so I stopped retrying. Please ask again.",
                    }),
                    undefined,
                  );
                } catch (notifyErr) {
                  log.warn('Failed to notify user of permanent delivery failure', {
                    messageId: msg.id,
                    err: notifyErr,
                  });
                }
              }
            }
          } else {
            const backoffSec =
              DELIVERY_BACKOFF_SCHEDULE_SEC[Math.min(attempts - 1, DELIVERY_BACKOFF_SCHEDULE_SEC.length - 1)];
            markDeliveryFailed(inDb, msg.id, attempts, backoffSec);
            deliveryRetriesTotal.inc();
            log.warn('Message delivery failed, retry scheduled', {
              messageId: msg.id,
              sessionId: session.id,
              attempt: attempts,
              maxAttempts: DELIVERY_MAX_ATTEMPTS,
              backoffSec,
              err,
            });
          }
          // Stop draining this session for this tick — delivering msg N+1
          // right after msg N failed would reorder the user-visible stream.
          // Once msg N enters its backoff window, later ticks let the queue
          // move past it (eventual overtake is the accepted trade-off, see
          // ADR-0016).
          break;
        }
      }
    } finally {
      outDb.close();
      inDb.close();
      if (handledOutbound) {
        endSessionRootSpan(session.id, lastDeliveredText);
        clearSessionSpanContext(session.id);
      }
    }
  };

  const spanAttrs = chainAttrs({
    'session.id': session.id,
    'agent.group.id': session.agent_group_id,
    'message.count': undelivered.length,
  });

  if (parentSpanContext) {
    await context.with(setSpanContextWithActive(parentSpanContext), async () => {
      await withSpan('delivery.session.drain', spanAttrs, drainFn);
    });
  } else {
    await withSpan('delivery.session.drain', spanAttrs, drainFn);
  }
}

/**
 * Strip model reasoning tags from user-facing text. Some providers (notably
 * MiniMax over the chat-completions transport) inline `<think>…</think>`
 * reasoning into the message body; without this it leaks verbatim into the
 * channel. Paired blocks are removed; stray unmatched tags are also dropped
 * as a fallback. Non-think content is never touched.
 */
function stripThinkTags(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<\/?think(?:ing)?>/gi, '')
    .trim();
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
    in_reply_to: string | null;
    deliver_after?: string | null;
    recurrence?: string | null;
  },
  session: Session,
  inDb: Database.Database,
): Promise<string | undefined> {
  return withSpan('delivery.message.deliver', chainAttrs({ 'msg.id': msg.id, 'message.kind': msg.kind }), async () => {
    if (!deliveryAdapter) {
      log.warn('No delivery adapter configured, dropping message', { id: msg.id });
      return;
    }

    const content = JSON.parse(msg.content);

    // System actions — handle internally (schedule_task, cancel_task, etc.)
    if (msg.kind === 'system') {
      await handleSystemAction(content, session, inDb);
      return;
    }

    // Agent-to-agent — route to target session via the agent-to-agent module.
    // Guarded by the channel_type check. If the module isn't installed the
    // `agent_destinations` table won't exist and `routeAgentMessage`'s permission
    // check will throw, which falls into the normal retry → mark-failed path.
    if (msg.channel_type === 'agent') {
      if (!hasTable(getDb(), 'agent_destinations')) {
        throw new Error(`agent-to-agent module not installed — cannot route message ${msg.id}`);
      }
      // Classification loop-close: when frontdesk delegates, the outbound
      // should carry the classificationId from its preceding classify_intent
      // call. Stamp outcome_ref on that row (for the regression corpus) and
      // count any bypass (missing / stale id, action mismatch) so we can
      // see on /metrics when the LLM skips the REQUIRED tool.
      if (hasTable(getDb(), 'classification_log')) {
        reconcileClassification(content, msg.id, 'agent_send', session.id);
      }
      const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');
      await routeAgentMessage(msg, session);
      return;
    }

    // Roster directed-message — opt-in private-message-to-a-consented-participant
    // surface (ADR-0023). Parallel to and MUTUALLY EXCLUSIVE with the channel
    // branch below: a roster row addresses a SLOT, and the host reverse-looks-up
    // the grant by (scope_id, slot_label), then OVERWRITES whatever
    // channel_type/platform_id the container wrote. All consent/revoke/expiry/
    // rate/target re-checks happen here, in the same critical section, before
    // the adapter call. Returning early means a roster row NEVER falls through
    // to the channel-destination ACL path.
    if (msg.kind === 'roster') {
      return await deliverRosterMessage(msg, session, content);
    }

    // Permission check: the source agent must be allowed to deliver to this
    // channel destination. Two ways it passes:
    //
    //   1. The target is the session's own origin chat (session.messaging_group_id
    //      matches). An agent can always reply to the chat it was spawned from;
    //      requiring a destinations row for the obvious case is a footgun.
    //
    //   2. Otherwise, the agent must have an explicit agent_destinations row
    //      targeting that messaging group. createMessagingGroupAgent() inserts
    //      these automatically when wiring, so an operator wiring additional
    //      chats to the agent doesn't need a separate ACL step.
    //
    // Failures throw — unlike a silent `return`, an Error falls into the retry
    // path in deliverSessionMessages and eventually marks the message as failed
    // (instead of marking it delivered when nothing was actually delivered,
    // which was the pre-refactor bug).
    if (msg.channel_type && msg.platform_id) {
      // Anti-bypass (ADR-0023, R3): when roster DM is enabled for this agent
      // group, a container must NOT reach a participant by writing a raw
      // `feishu:p2p:ou_*` destination on a plain channel row — that would route
      // around the slot indirection, consent gate, rate limit, and revoke
      // re-check. Force such traffic through the roster surface (kind='roster').
      // Flag OFF preserves the legacy behavior exactly.
      if (
        msg.channel_type === 'feishu' &&
        /^feishu:p2p:/i.test(msg.platform_id) &&
        rosterDmEnabledForGroup(session.agent_group_id)
      ) {
        rosterDmRejectedTotal.labels('raw_platform_id').inc();
        recordDmAudit({
          scopeId: hostScopeForSession(session),
          agentGroupId: session.agent_group_id,
          sessionId: session.id,
          dmPlatformId: msg.platform_id,
          messageOutId: msg.id,
          decision: 'rejected',
          reason: 'channel_branch_p2p_bypass',
        });
        throw new Error(
          `roster-dm: agent group ${session.agent_group_id} attempted a direct p2p channel send to ${msg.platform_id} while roster DM is enabled — use kind='roster' with a slot (ADR-0023)`,
        );
      }
      const mg = getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
      if (!mg) {
        throw new Error(`unknown messaging group for ${msg.channel_type}/${msg.platform_id} (message ${msg.id})`);
      }
      const isOriginChat = session.messaging_group_id === mg.id;
      // Guarded: without the agent-to-agent module, `agent_destinations`
      // doesn't exist and we permit all non-origin channel sends (the
      // origin-chat case is always allowed regardless). Inlined SQL instead
      // of importing `hasDestination` so core doesn't depend on the module.
      if (!isOriginChat && hasTable(getDb(), 'agent_destinations')) {
        const row = getDb()
          .prepare(
            'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
          )
          .get(session.agent_group_id, 'channel', mg.id);
        if (!row) {
          throw new Error(
            `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
          );
        }
      }
    }

    // Classification loop-close for clarification cards. When frontdesk
    // says action=clarify, the card it emits via ask_user_question should
    // carry the classificationId; reconcile here so outcome_ref gets stamped.
    if (content.type === 'ask_question' && hasTable(getDb(), 'classification_log')) {
      reconcileClassification(content, msg.id, 'ask_user_question', session.id);
    }

    // Track pending questions for ask_user_question flow.
    // Guarded: without the interactive module, `pending_questions` doesn't
    // exist and we skip persistence — the card still delivers to the user,
    // but the response path has nowhere to land and will log unclaimed.
    if (content.type === 'ask_question' && content.questionId && hasTable(getDb(), 'pending_questions')) {
      const title = content.title as string | undefined;
      const rawOptions = content.options as unknown;
      if (!title || !Array.isArray(rawOptions)) {
        log.error('ask_question missing required title/options — not persisting', {
          questionId: content.questionId,
        });
      } else {
        const inserted = createPendingQuestion({
          question_id: content.questionId,
          session_id: session.id,
          message_out_id: msg.id,
          platform_id: msg.platform_id,
          channel_type: msg.channel_type,
          thread_id: msg.thread_id,
          title,
          options: normalizeOptions(rawOptions as never),
          created_at: new Date().toISOString(),
        });
        if (inserted) {
          log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
        }
      }
    }

    // Classification loop-close for channel-delivered replies that carry
    // a classificationId (answer_self path). Only reconcile when the
    // outbound actually references a classification — plain replies
    // don't need to enter the bypass accounting.
    if (
      typeof content._classificationId === 'string' &&
      content._classificationId.length > 0 &&
      hasTable(getDb(), 'classification_log')
    ) {
      reconcileClassification(content, msg.id, 'channel_send', session.id);
    }

    // Channel delivery
    if (!msg.channel_type || !msg.platform_id) {
      log.warn('Message missing routing fields', { id: msg.id });
      return;
    }

    // Read file attachments from outbox if the content declares files.
    // File I/O lives in session-manager.ts (symmetric with inbound
    // extractAttachmentFiles) — delivery just hands buffers to the adapter.
    const files =
      Array.isArray(content.files) && content.files.length > 0
        ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
        : undefined;

    // Defense-in-depth: scrub model reasoning tags from the user-facing text
    // before it reaches any channel. The agent prompt also forbids them, but a
    // misbehaving model shouldn't be able to leak `<think>` blobs to users.
    let outboundContent = msg.content;
    if (content && typeof content === 'object' && typeof content.text === 'string') {
      const cleaned = stripThinkTags(content.text);
      if (cleaned !== content.text) {
        outboundContent = JSON.stringify({ ...content, text: cleaned });
      }
    }

    const platformMsgId = await withSpan(
      'delivery.channel.send',
      chainAttrs({
        'channel.type': msg.channel_type,
        'platform.id': msg.platform_id,
        ...outputAttrs(
          typeof content === 'object' && typeof content.text === 'string' ? content.text : outboundContent,
        ),
      }),
      async () => {
        return await withDeliveryTimeout(
          deliveryAdapter!.deliver(
            msg.channel_type!,
            msg.platform_id!,
            msg.thread_id,
            msg.kind,
            outboundContent,
            files,
          ),
          DELIVERY_TIMEOUT_MS,
        );
      },
    );
    log.info('Message delivered', {
      id: msg.id,
      channelType: msg.channel_type,
      platformId: msg.platform_id,
      platformMsgId,
      fileCount: files?.length,
    });

    // Outbox cleanup is done by drainSession AFTER markDelivered, not here —
    // clearing before the delivered row is recorded risks re-delivery without
    // attachments on a crash. See drainSession.
    return platformMsgId;
  });
}

/**
 * Deliver a roster directed message (ADR-0023). Runs entirely on the host
 * (trusted side of the container mount). Every gate is re-evaluated here, in
 * the same critical section, immediately before the adapter call — there is no
 * window between the check and the send where a revoke / expiry / rate change
 * could be missed (R5).
 *
 * Order of enforcement (all fail-closed; each rejection writes a dm_audit row
 * and bumps roster_dm_rejected_total):
 *   1. opt-in flag ON for this agent group (R-flag).
 *   2. no deliver_after / recurrence on the row (R6 — DMs send now, never
 *      scheduled/recurring).
 *   3. slot_label present in content.
 *   4. host-derived scope_id (never a container field) (R4).
 *   5. the container did NOT smuggle a raw platform id (R3).
 *   6. live grant check: present, allow-listed consent_source, scope-bound,
 *      not revoked, not expired (host clock), under max_sends (R5).
 *   7. multi-key sliding-window rate limit (R5).
 *   8. target shape: messaging group is feishu p2p, is_group===0, receive id is
 *      an open_id, and feishu:p2p:<participant_open_id> === dm_platform_id (R2).
 * Only after ALL pass do we count the send, persist rate consumption, OVERWRITE
 * the routing fields from the grant, and call the adapter.
 */
async function deliverRosterMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
    deliver_after?: string | null;
    recurrence?: string | null;
  },
  session: Session,
  content: Record<string, unknown>,
): Promise<string | undefined> {
  const scopeId = hostScopeForSession(session);
  const auditBase = {
    scopeId,
    agentGroupId: session.agent_group_id,
    sessionId: session.id,
    messageOutId: msg.id,
  };
  const reject = (reason: string, extra: Record<string, unknown> = {}): never => {
    rosterDmRejectedTotal.labels(reason).inc();
    recordDmAudit({ ...auditBase, decision: 'rejected', reason, ...extra });
    throw new Error(`roster-dm rejected (${reason}) for message ${msg.id}`);
  };

  // 1. opt-in flag.
  if (!rosterDmEnabledForGroup(session.agent_group_id)) {
    return reject('flag_disabled');
  }

  // 1b. root-session enforcement at the binding path (R4 review finding):
  // a config-time assert nothing calls at runtime is no enforcement. If a
  // group enabled roster DM but runs agent-shared, the per-scope release key
  // collapses across conversations — reject fail-closed here.
  if (!isRootSessionModeForRosterDm(session.agent_group_id)) {
    return reject('agent_shared_mode');
  }

  // 2. no scheduling / recurrence on a roster row.
  if (msg.deliver_after || msg.recurrence) {
    return reject('scheduled_or_recurring');
  }

  // 3. slot_label.
  const slotLabel = typeof content.slot === 'string' && content.slot.trim() ? content.slot.trim() : null;
  if (!slotLabel) {
    return reject('missing_slot');
  }

  // 5. raw-platform-id smuggle attempt (container wrote a concrete destination).
  if (looksLikeRawPlatformId(msg.platform_id)) {
    return reject('raw_platform_id', { dmPlatformId: msg.platform_id ?? null });
  }

  // 6. live grant re-check (revoked / expired / scope / consent_source / max_sends).
  const live = checkGrantLive(scopeId, slotLabel);
  if (!live.ok) {
    return reject(live.reason, { slotLabel });
  }
  const grant = live.grant;

  // 8. target shape: resolve the messaging group from the grant's authoritative
  // destination and assert it is a feishu p2p open_id (not a group).
  const mg = getMessagingGroupByPlatform(grant.channel_type, grant.dm_platform_id);
  if (!mg) {
    return reject('no_grant', {
      slotLabel,
      grantId: grant.id,
      participantOpenId: grant.participant_open_id,
      dmPlatformId: grant.dm_platform_id,
    });
  }
  if (mg.is_group !== 0) {
    return reject('not_p2p_open_id', {
      slotLabel,
      grantId: grant.id,
      participantOpenId: grant.participant_open_id,
      dmPlatformId: grant.dm_platform_id,
    });
  }
  const expectedTarget = `feishu:p2p:${grant.participant_open_id}`;
  if (
    grant.channel_type !== 'feishu' ||
    !grant.participant_open_id.startsWith('ou_') ||
    expectedTarget !== grant.dm_platform_id
  ) {
    return reject('target_mismatch', {
      slotLabel,
      grantId: grant.id,
      participantOpenId: grant.participant_open_id,
      dmPlatformId: grant.dm_platform_id,
    });
  }

  // The destination the adapter will actually receive. Starts as the local
  // grant's authoritative target; the gateway (item 13) may override it.
  let deliverChannelType = grant.channel_type;
  let deliverPlatformId = grant.dm_platform_id;

  // 8b. Gateway authority (ADR-0023 item 13). When this agent group has a
  // backendGateway AND ROSTER_GATEWAY_AUTHORITY=true, the host asks the gateway
  // whether this DM may proceed BEFORE honoring the local grant — moving the
  // source of truth toward the "gateway is the only business path" invariant.
  // The local table degrades to a cache/audit layer (it still gated us this
  // far, but the gateway has the final say). fail-closed: a deny / unreachable
  // gateway rejects the send — if you configured a gateway authority you asked
  // to trust it, so a flaky gateway must NOT silently fall back to the local
  // table. When the flag is off or no gateway is configured, the local table
  // remains authoritative (documented PoC transitional state).
  if (rosterGatewayAuthorityEnabled()) {
    const group = getAgentGroup(session.agent_group_id);
    const gateway = group ? readContainerConfig(group.folder).backendGateway : undefined;
    if (gateway?.baseUrl) {
      // #7 fail-closed: the authority path treats the gateway's `allow` as the
      // final say, so the call MUST be HMAC-signed. A gateway with no signingKey
      // would post an unsigned body and unconditionally trust the reply, letting
      // anything that can reach baseUrl forge an `allow`. Reject before calling.
      if (!gatewayHasSigningKey(gateway)) {
        return reject('gateway_unsigned_authority', { slotLabel });
      }
      const decision = await authorizeDm(gateway, {
        scopeId,
        slotLabel,
        participantOpenId: grant.participant_open_id,
        dmPlatformId: grant.dm_platform_id,
        agentGroupId: session.agent_group_id,
        channelType: grant.channel_type,
      });
      if (decision.decision !== 'allow') {
        return reject('gateway_denied', {
          slotLabel,
          grantId: grant.id,
          participantOpenId: grant.participant_open_id,
          dmPlatformId: grant.dm_platform_id,
        });
      }
      // Optional authoritative target override from the gateway. Re-validate
      // its shape exactly like the local grant target so the gateway can't be
      // tricked (or misconfigured) into widening to a group/non-p2p target.
      if (decision.target?.dmPlatformId) {
        const t = decision.target;
        const ct = t.channelType ?? grant.channel_type;
        const pid = t.dmPlatformId as string;
        const tmg = getMessagingGroupByPlatform(ct, pid);
        if (ct !== 'feishu' || !/^feishu:p2p:ou_/i.test(pid) || !tmg || tmg.is_group !== 0) {
          return reject('gateway_target_invalid', {
            slotLabel,
            grantId: grant.id,
            participantOpenId: grant.participant_open_id,
            dmPlatformId: pid,
          });
        }
        deliverChannelType = ct;
        deliverPlatformId = pid;
      }
    }
    // No gateway configured for this group while the flag is on → fall through
    // to the local table (the flag is a deployment-wide intent; a group without
    // a gateway simply has nothing to delegate to). Documented in the ADR.
  }

  // 7. Build the rate-limit keys + windows (consumed by the reservation below).
  // The deploy bucket window/key are operator-tunable (item 14); build the
  // windows object so the deploy short-window matches resolveDeployQuota.
  const deployQuota = resolveDeployQuota();
  const rateKeys: RateKeys = {
    grant: grant.id,
    scope: scopeId,
    participant: grant.participant_open_id,
    deploy: deployQuota.key,
  };
  const rateWindows: typeof DEFAULT_RATE_WINDOWS = {
    grant: DEFAULT_RATE_WINDOWS.grant,
    participant: DEFAULT_RATE_WINDOWS.participant,
    scope: DEFAULT_RATE_WINDOWS.scope,
    deploy: deployQuota.window,
  };

  // All gates passed. Deliver with grant-authoritative routing (OVERWRITES the
  // container-written channel_type/platform_id entirely — R3).
  if (!deliveryAdapter) {
    return reject('no_adapter', {
      slotLabel,
      grantId: grant.id,
      participantOpenId: grant.participant_open_id,
      dmPlatformId: grant.dm_platform_id,
    });
  }

  // 9. Send-time membership re-check (ADR-0023 item 12, optional, default OFF).
  // The item-11 revoke paths (explicit opt-out + best-effort leave/disband
  // events) are the baseline. ROSTER_VERIFY_MEMBERSHIP=true adds a strong,
  // real-time check immediately before the adapter call (same critical section
  // as the send): confirm the participant is STILL in the scope's origin group
  // via the channel adapter's optional isMember. A definite "no" fails closed —
  // we reject AND revoke the participant's grant in this scope (a leaver who
  // slipped past the events). "unknown" (adapter has no isMember, or its API
  // erred) falls back to item 11 — see the doc trade-off.
  if (rosterVerifyMembershipEnabled()) {
    const originGroup = originGroupPlatformIdForGrant(grant);
    if (originGroup) {
      const stillMember = await isMemberCached(
        deliveryAdapter,
        grant.channel_type,
        originGroup,
        grant.participant_open_id,
      );
      if (stillMember === false) {
        // Fail-closed: drop the in-flight DM and tear down the grant so future
        // sends in this scope are rejected at the live check, not re-queried.
        revokeParticipantInScope(scopeId, grant.participant_open_id);
        membershipCache.delete(`${grant.channel_type}|${originGroup}|${grant.participant_open_id}`);
        return reject('not_in_scope', {
          slotLabel,
          grantId: grant.id,
          participantOpenId: grant.participant_open_id,
          dmPlatformId: grant.dm_platform_id,
        });
      }
    }
  }

  // RESERVE-BEFORE-SEND (#1 + #4). Atomically charge max_sends + every rate key
  // + the daily deploy cap in ONE transaction, BEFORE the adapter call. This
  // closes the TOCTOU window (#1): SQLite's write lock serializes concurrent
  // drains of two sessions sharing one host scope, so two reservations cannot
  // both pass — max_sends=1 admits exactly one, the deploy daily cap holds
  // globally, etc. The reservation is idempotent per message_out_id: a retry of
  // the same message reuses its standing reservation rather than charging again
  // (#4). On over-limit the transaction rolls back and nothing is consumed, so a
  // rejected attempt never burns quota.
  const reservation = reserveRosterSend(msg.id, grant.id, rateKeys, rateWindows, deployQuota);
  if (!reservation.ok) {
    return reject(reservation.reason, {
      slotLabel,
      grantId: grant.id,
      participantOpenId: grant.participant_open_id,
      dmPlatformId: grant.dm_platform_id,
    });
  }

  // Scrub model reasoning tags from user-facing text, same as the channel path.
  let outboundContent = msg.content;
  if (typeof content.text === 'string') {
    const cleaned = stripThinkTags(content.text);
    if (cleaned !== content.text) {
      outboundContent = JSON.stringify({ ...content, text: cleaned });
    }
  }

  let platformMsgId: string | undefined;
  try {
    platformMsgId = await withSpan(
      'delivery.roster.send',
      chainAttrs({
        'channel.type': deliverChannelType,
        'platform.id': deliverPlatformId,
        'roster.scope_id': scopeId,
        'roster.slot_label': slotLabel as string,
        ...outputAttrs(typeof content.text === 'string' ? content.text : outboundContent),
      }),
      async () => {
        return await withDeliveryTimeout(
          deliveryAdapter!.deliver(
            deliverChannelType,
            deliverPlatformId,
            null, // directed DMs are never threaded into a group
            msg.kind,
            outboundContent,
            undefined,
          ),
          DELIVERY_TIMEOUT_MS,
        );
      },
    );
  } catch (err) {
    if (err instanceof DeliveryTimeoutError) {
      // #4: a timeout is at-least-once — the adapter may have ALREADY delivered
      // downstream even though it threw. KEEP the reservation: it is the
      // idempotency key, so the inevitable retry (ADR-0016) reuses it instead of
      // charging a second time, and the participant cannot be counted < the
      // copies they may receive. We still rethrow so the delivery loop schedules
      // the retry / marks failed exactly as before.
      throw err;
    }
    // An EXPLICIT (non-timeout) failure means the send definitively did not
    // land. Roll the reservation back (sends_used-1, rate/deploy un-bump,
    // un-revoke if THIS reservation auto-revoked the grant, drop the marker) so
    // ADR-0016's retry re-reserves cleanly on a later tick and a flaky channel
    // never prematurely exhausts max_sends.
    rollbackRosterReservation(msg.id, grant.id, rateKeys, rateWindows, deployQuota);
    throw err;
  }

  recordDmAudit({
    ...auditBase,
    slotLabel,
    grantId: grant.id,
    participantOpenId: grant.participant_open_id,
    dmPlatformId: deliverPlatformId,
    decision: 'delivered',
  });
  log.info('Roster DM delivered', {
    id: msg.id,
    scopeId,
    slotLabel,
    grantId: grant.id,
    dmPlatformId: deliverPlatformId,
    platformMsgId,
  });

  // Outbox cleanup is done by drainSession AFTER markDelivered (see there) so a
  // crash can't re-deliver this roster DM without its attachments.
  return platformMsgId;
}

/**
 * Delivery action registry.
 *
 * Modules register handlers for system-kind outbound message actions via
 * `registerDeliveryAction`. Core checks the registry first in
 * `handleSystemAction` and falls through to the inline switch when no
 * handler is registered. The switch will shrink as modules are extracted
 * (scheduling, approvals, agent-to-agent) and eventually only its default
 * branch remains.
 *
 * Default when no handler registered and the switch doesn't match: log
 * "Unknown system action" and return.
 */
export type DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
) => Promise<void>;

const actionHandlers = new Map<string, DeliveryActionHandler>();

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler): void {
  if (actionHandlers.has(action)) {
    log.warn('Delivery action handler overwritten', { action });
  }
  actionHandlers.set(action, handler);
}

/**
 * Reconcile a routing action against the classify_intent log.
 *
 * Called when frontdesk is about to delegate (a2a send_message) or
 * clarify (ask_user_question). Three paths:
 *
 *   1. No classificationId on the outbound → bump bypass counter with
 *      `reason=no_classification_id`. The agent skipped the required
 *      tool call. Still deliver — this is observability, not
 *      enforcement.
 *   2. classificationId present but not in the log → the id is stale
 *      or made up. Bump `classification_not_found`.
 *   3. classificationId matches a log row → stamp outcome_ref with the
 *      delivery's outbound message id. Also check that the row's
 *      declared action matches the actual surface (delegate ↔ agent_send,
 *      clarify ↔ ask_user_question); bump `action_mismatch` otherwise.
 *
 * Kept deliberately cheap: one index lookup per agent/ask outbound.
 * Don't throw — a failure in this audit-ish path should never block
 * real user traffic.
 */
export type ReconcileSurface = 'agent_send' | 'ask_user_question' | 'channel_send';

const EXPECTED_ACTION_BY_SURFACE: Record<ReconcileSurface, 'delegate' | 'clarify' | 'answer_self'> = {
  agent_send: 'delegate',
  ask_user_question: 'clarify',
  channel_send: 'answer_self',
};

export function reconcileClassification(
  content: Record<string, unknown>,
  outcomeRef: string,
  surface: ReconcileSurface,
  sessionId: string,
): void {
  try {
    const raw = content._classificationId;
    const classificationId = typeof raw === 'string' && raw.length > 0 ? raw : null;
    if (!classificationId) {
      // channel_send only reaches this path when the outbound explicitly
      // carried a classificationId, so "no id" here is genuine bypass
      // across every surface we reconcile.
      classificationBypassTotal.labels('no_classification_id', surface).inc();
      return;
    }
    const row = findClassificationById(classificationId);
    if (!row) {
      classificationBypassTotal.labels('classification_not_found', surface).inc();
      return;
    }
    // Session-bind the match. Without this, an LLM that accidentally
    // reuses a classificationId from a prior turn (or a different
    // session) would silently stamp outcome_ref on the wrong audit row,
    // and bypass metric would NOT fire (id exists globally). Here we
    // treat "id belongs to a different session" as not-found.
    if (row.session_id !== sessionId) {
      classificationBypassTotal.labels('classification_not_found', surface).inc();
      return;
    }
    const declared = typeof row.action === 'string' ? row.action : '';
    const expected = EXPECTED_ACTION_BY_SURFACE[surface];
    if (declared !== expected) {
      // Record the mismatch and STOP — do NOT stamp outcome_ref.
      // Earlier revisions linked anyway on the logic that "a link is
      // better than no link"; that was wrong. Frontdesk routinely
      // emits multiple outbound rows per turn (e.g. a user-visible
      // 'I'll look into it' channel reply followed by a worker
      // delegation). Both can carry the same classificationId. Since
      // outcome_ref is first-write-wins, stamping on a mismatched
      // surface would let the user-confirmation reply claim the slot
      // and lock out the real delegation from its audit link.
      // Treating mismatch as a hard bypass keeps the slot open for the
      // next outbound whose surface DOES match the declared action.
      classificationBypassTotal.labels('action_mismatch', surface).inc();
      return;
    }
    linkOutcome(classificationId, outcomeRef, sessionId);
  } catch (err) {
    // Never block delivery on audit bookkeeping.
    log.warn('classify_intent reconciliation failed', { err });
  }
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  const registered = actionHandlers.get(action);
  if (registered) {
    await registered(content, session, inDb);
    return;
  }

  log.warn('Unknown system action', { action });
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}

/**
 * Wait for in-flight session drains to finish, or until `timeoutMs` elapses.
 *
 * Called during graceful shutdown AFTER the listener is stopped and the poll
 * loops are flagged off, so no NEW drains can start while we wait. This
 * shrinks (but does not eliminate) the at-least-once duplicate window from
 * ADR-0016: a drain caught mid-flight may have already called
 * adapter.deliver() successfully but not yet run markDelivered() — letting it
 * finish persists the delivered row so a restart won't re-send. A hard SIGKILL
 * (or a deliver() call that outlives timeoutMs) still leaves that window open,
 * which is why delivery stays idempotent at the DB layer and at-least-once
 * remains the contract.
 *
 * Resolves early once the set empties; otherwise resolves after the timeout
 * (it does not reject — shutdown must proceed regardless).
 */
export async function drainInflightDeliveries(timeoutMs = 10_000): Promise<void> {
  if (inflightDeliveries.size === 0) return;
  log.info('Draining in-flight deliveries before shutdown', { inflight: inflightDeliveries.size, timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (inflightDeliveries.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (inflightDeliveries.size > 0) {
    log.warn('Drain timed out with deliveries still in flight', { inflight: inflightDeliveries.size });
  } else {
    log.info('In-flight deliveries drained');
  }
}
