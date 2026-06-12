import { findByName, findByRouting, getAllDestinations, type DestinationEntry } from './destinations.js';
import {
  getPendingMessages,
  markProcessing,
  markCompleted,
  releaseProcessing,
  type MessageInRow,
} from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { getInboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import { clearContinuation, migrateLegacyContinuation, setContinuation } from './db/session-state.js';
import { a2aOriginUserId } from './a2a-origin.js';
import {
  clearCurrentClassificationId,
  clearCurrentInReplyTo,
  getCurrentClassificationId,
  setCurrentInReplyTo,
} from './current-batch.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import { clearRequestIdentity, getRequestIdentity, setRequestIdentity } from './request-context.js';
import { resolveBatchIdentity, splitBatchByTurn } from './request-identity.js';
import { context, getTracer, parentContextFromEnv, recordError } from './observability/tracer.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Pure decision for the idle-exit check. Exported so unit tests can
 * exercise the boundary without having to spin up the whole poll loop.
 *
 * When `idleExitMs <= 0` the feature is off: never exit. Otherwise, exit
 * once elapsed time since the last trigger batch has crossed the window.
 */
export function shouldExitIdle(idleExitMs: number, lastWorkAt: number, now: number = Date.now()): boolean {
  if (idleExitMs <= 0) return false;
  return now - lastWorkAt >= idleExitMs;
}

/**
 * Pure decision for the follow-up turn-change guard.
 *
 * Ends the active query when the incoming batch doesn't belong to the
 * same "turn" as the currently running one. A turn is pinned not just
 * by userId but by the full (userId, channelType, platformId, threadId)
 * tuple — otherwise the same user hopping from one chat / thread to
 * another mid-turn keeps the old routing context, and the agent's
 * send_message / a2a in_reply_to / currentInReplyTo all get stamped
 * with the stale thread. Before this change, the guard only compared
 * userId, so Alice switching from group A to a DM mid-turn would get
 * her DM reply delivered back to group A.
 *
 * Exported for unit testing.
 */
export interface TurnContext {
  userId: string | null;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  source: 'session' | 'agent-asserted';
}

export function shouldEndForTurnChange(current: TurnContext | null, incoming: TurnContext): boolean {
  if (!current) return false;
  if (current.source !== 'session' || !current.userId) return false;
  if (incoming.source !== 'session' || !incoming.userId) return false;
  if (current.userId !== incoming.userId) return true;
  // Same user, but on a different routing surface — group vs DM, or
  // different thread in the same chat. Follow-up must start a fresh
  // turn so currentInReplyTo / session routing get re-pinned.
  if ((current.channelType ?? '') !== (incoming.channelType ?? '')) return true;
  if ((current.platformId ?? '') !== (incoming.platformId ?? '')) return true;
  if ((current.threadId ?? null) !== (incoming.threadId ?? null)) return true;
  return false;
}

/**
 * @deprecated Use shouldEndForTurnChange. Kept as a thin wrapper so any
 * external tests / callers that imported the old predicate still work.
 */
export function shouldEndForIdentityChange(
  current: { userId: string | null; source: 'session' | 'agent-asserted' } | null,
  incoming: { userId: string | null; source: 'session' | 'agent-asserted' },
): boolean {
  return shouldEndForTurnChange(
    current
      ? { userId: current.userId, channelType: null, platformId: null, threadId: null, source: current.source }
      : null,
    { userId: incoming.userId, channelType: null, platformId: null, threadId: null, source: incoming.source },
  );
}

/**
 * Pick a short, stable label for the provider_error metric's `code` dim.
 * The message itself is free-form and changes between providers /
 * versions — using it as a label would cardinality-bomb Prometheus.
 *
 * Exported for unit testing.
 */
export function classifyProviderError(errMsg: string, sessionInvalid: boolean): string {
  if (sessionInvalid) return 'session_invalid';
  const normalized = errMsg.toLowerCase();
  if (/\b(502|503|504)\b/.test(normalized)) return 'gateway_5xx';
  if (normalized.includes('timed out') || normalized.includes('timeout')) return 'timeout';
  if (/\b401\b/.test(normalized)) return 'unauthorized';
  if (/\b429\b/.test(normalized)) return 'rate_limited';
  if (/\b4\d\d\b/.test(normalized)) return 'client_4xx';
  if (/\b5\d\d\b/.test(normalized)) return 'server_5xx';
  if (normalized.includes('non-json')) return 'bad_response';
  return 'unknown';
}

function formatUserFacingError(errMsg: string): string {
  const normalized = errMsg.toLowerCase();
  if (
    normalized.includes('openai endpoint returned non-json response (502)') ||
    normalized.includes('openai request failed with status 502') ||
    normalized.includes('openai request failed with status 503') ||
    normalized.includes('openai request failed with status 504') ||
    normalized.includes('request timed out')
  ) {
    return '模型服务暂时不可用，请稍后重试。';
  }
  return `Error: ${errMsg}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  /**
   * Idle exit window in milliseconds. When > 0, the loop exits cleanly
   * (process.exit 0) once this many ms has elapsed without a
   * trigger-eligible pending batch — freeing container memory for other
   * sessions. When 0, the loop stays alive indefinitely (legacy behavior)
   * until host-sweep kills it at the absolute ceiling (30 min).
   */
  idleExitMs?: number;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  const idleExitMs = config.idleExitMs ?? 0;
  let lastWorkAt = Date.now();

  let pollCount = 0;
  while (true) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages().filter((m) => m.kind !== 'system');
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      if (shouldExitIdle(idleExitMs, lastWorkAt)) {
        log(`Idle exit: no trigger-eligible batch for ${idleExitMs}ms; releasing container`);
        process.exit(0);
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      if (shouldExitIdle(idleExitMs, lastWorkAt)) {
        log(`Idle exit: only accumulate-context rows pending for ${idleExitMs}ms; releasing container`);
        process.exit(0);
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // We saw a real trigger batch — reset the idle clock so follow-up
    // messages from the same user keep the container warm.
    lastWorkAt = Date.now();

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    // Batch-split FIRST — before /clear handling and before routing
    // extraction. Two reasons:
    //
    //   1. /clear handling used to run against pre-split `messages`
    //      with pre-split `routing`. If Bob's /clear landed in the same
    //      tick as Alice's trigger message (or vice versa), the "Session
    //      cleared." ack would be stamped with the wrong anchor's thread
    //      / in_reply_to.
    //   2. extractRouting on the pre-split batch can inherit routing
    //      from a deferred row (accumulated context from a different
    //      user), so every downstream routing consumer read the wrong
    //      thread.
    //
    // Splitting early means both /clear and extractRouting see only the
    // rows that belong to this turn's anchor identity.
    const split = splitBatchByTurn(messages);
    if (split.defer.length > 0) {
      releaseProcessing(split.defer.map((m) => m.id));
      log(
        `Batch split: kept ${split.keep.length} row(s) for this turn, deferred ${split.defer.length} from different user/thread`,
      );
    }
    const turnMessages = split.keep;
    if (turnMessages.length === 0) {
      log('Batch split left nothing in the anchor group, looping');
      continue;
    }

    const turnRouting = extractRouting(turnMessages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of turnMessages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: turnRouting.platformId,
          channel_type: turnRouting.channelType,
          thread_id: turnRouting.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = turnMessages.map((m) => m.id).filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${turnMessages.length} message(s) in this turn were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages.
    // turnMessages already excludes the deferred rows (split happened
    // up-front), so we just filter out the turn's own /clear commands
    // and any rows the pre-task script gated.
    const skippedSet = new Set(skipped);
    const commandSet = new Set(commandIds);
    const processingIds = turnMessages
      .map((m) => m.id)
      .filter((id) => !commandSet.has(id) && !skippedSet.has(id));
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    // Use turnRouting (post-split) so deferred messages don't leak their
    // in_reply_to into this turn's outbound stamps.
    setCurrentInReplyTo(turnRouting.inReplyTo);
    // Publish the batch's trusted requester identity so MCP tools (e.g.
    // ERP gateway) can attribute calls to the actual human employee
    // instead of whatever the agent asserts. Identity is derived from the
    // batch — not from "the latest inbound row at call time" — to avoid
    // cross-user misattribution in group/shared sessions.
    setRequestIdentity(resolveBatchIdentity(keep));
    try {
      const result = await processQuery(query, turnRouting, processingIds, config.providerName);
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      const sessionInvalid = Boolean(continuation && config.provider.isSessionInvalid(err));
      if (sessionInvalid) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      // Emit a provider_error system action so the host can bump the
      // <namespace>_provider_errors_total metric. Without this, dashboards
      // that watch for provider trouble stay at 0 regardless of what's
      // happening — the opposite of "no signal is no problem".
      writeMessageOut({
        id: generateId(),
        kind: 'system',
        content: JSON.stringify({
          action: 'provider_error',
          provider: config.providerName,
          code: classifyProviderError(errMsg, sessionInvalid),
          message: errMsg.slice(0, 500),
        }),
      });

      // Write error response so the user knows something went wrong.
      // Route to the post-split batch surface — otherwise a deferred
      // first-message from an unrelated user can steal the error
      // message into their thread.
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: turnRouting.platformId,
        channel_type: turnRouting.channelType,
        thread_id: turnRouting.threadId,
        content: JSON.stringify({ text: formatUserFacingError(errMsg) }),
      });
    } finally {
      clearCurrentInReplyTo();
      clearRequestIdentity();
      clearCurrentClassificationId();
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${turnMessages.length} message(s) this turn (${ids.length} claimed at tick start)`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

/**
 * agent.turn (AGENT) span (ADR-0026). One think/act/respond iteration of the
 * runner. Parented under the host session-root span via OTEL_TRACEPARENT so
 * the whole turn — and any provider.request / mcp.* children — lands in the
 * same Phoenix trace as the host. No-op when host tracing is off.
 *
 * Span only READS routing.* / provider name as attributes; it never mutates
 * the message flow, identity chain, or session DBs.
 */
async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
): Promise<QueryResult> {
  const tracer = getTracer();
  return context.with(parentContextFromEnv(), () =>
    tracer.startActiveSpan('agent.turn', async (turnSpan) => {
      // Inline literal kind so the static coverage scanner sees it; setKind()
      // would set the same key at runtime but is invisible to the regex gate.
      turnSpan.setAttribute('openinference.span.kind', 'AGENT');
      if (routing.channelType) turnSpan.setAttribute('channel.type', routing.channelType);
      turnSpan.setAttribute('provider', providerName);
      try {
        return await runQuery(query, routing, initialBatchIds, providerName);
      } catch (err) {
        recordError(turnSpan, err, 'agent_turn_error');
        throw err;
      } finally {
        turnSpan.end();
      }
    }),
  );
}

async function runQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. End the stream and leave the rows
        // pending; the outer loop handles them on next iteration via the
        // canonical command path + formatMessagesWithCommands.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — ending stream so outer loop can process');
          endedForCommand = true;
          query.end();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        // Batch-split the follow-up the same way the initial batch was
        // split: if the poll tick picked up rows from multiple
        // user/thread surfaces, only rows matching the follow-up's
        // anchor identity ride along with this push. The rest are
        // released back to pending for a fresh turn.
        const followupSplit = splitBatchByTurn(keep);
        if (followupSplit.defer.length > 0) {
          releaseProcessing(followupSplit.defer.map((m) => m.id));
          log(
            `Follow-up batch split: ${followupSplit.keep.length} row(s) match active turn, ${followupSplit.defer.length} deferred`,
          );
        }
        keep = followupSplit.keep;
        if (keep.length === 0) return;

        // Turn-guard: even after split, the anchor identity of the
        // follow-up may still differ from the currently running turn's
        // identity (all rows in this tick were from a different user).
        // End the stream so the outer loop re-pins routing for the
        // new turn.
        const current = getRequestIdentity();
        const incoming = resolveBatchIdentity(keep);
        if (shouldEndForTurnChange(current, incoming)) {
          log(
            `Turn surface changed mid-stream (user=${current?.userId ?? 'unknown'}@${current?.platformId ?? '?'}/${current?.threadId ?? '-'} -> ${incoming.userId}@${incoming.platformId ?? '?'}/${incoming.threadId ?? '-'}) — ending stream so outer loop starts a fresh turn`,
          );
          // Release the claim on the new messages so the outer loop can
          // re-claim them with the correct identity. markCompleted would
          // be wrong — they haven't been processed.
          releaseProcessing(keep.map((m) => m.id));
          endedForCommand = true;
          query.end();
          return;
        }

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        query.push(prompt);
        markCompleted(keptIds);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        if (event.text) {
          dispatchResultText(event.text, routing);
        }
      } else if (event.type === 'compacted') {
        // The SDK auto-compacted the conversation. After compaction the
        // model often drops the learned `<message to="…">` wrapping
        // discipline (the destinations are still in the system prompt,
        // but the behavioral pattern is summarized away). Inject a
        // reminder back into the live query so the next turn re-anchors
        // on the destination model. Only do this when there's >1
        // destination — single-destination groups have a fallback that
        // works without wrapping. See qwibitai/nanoclaw#2325.
        const destinations = getAllDestinations();
        if (destinations.length > 1) {
          const names = destinations.map((d) => d.name).join(', ');
          query.push(
            `[system] Context was just compacted. Reminder: you have ${destinations.length} destinations (${names}). ` +
              `Use <message to="name"> blocks to address them. Bare text goes to the scratchpad fallback only.`,
          );
        }
      } else if (event.type === 'usage') {
        // provider.request (LLM) span (ADR-0026). Each usage event marks one
        // completed model invocation. agent.turn is the active span, so this
        // auto-nests as its child. Synchronous start+end: usage arrives after
        // the call already finished, so the span is a zero-duration marker
        // carrying model + token attributes (the canonical LLM boundary for
        // Phoenix). This wave does NOT attach prompt/completion text — that is
        // a follow-up wave gated on full redaction.
        const llmTracer = getTracer();
        llmTracer.startActiveSpan('provider.request', (llmSpan) => {
          llmSpan.setAttribute('openinference.span.kind', 'LLM');
          llmSpan.setAttribute('llm.system', providerName);
          llmSpan.setAttribute('llm.model_name', event.model);
          if (event.inputTokens !== undefined) {
            llmSpan.setAttribute('llm.token_count.prompt', event.inputTokens);
          }
          if (event.outputTokens !== undefined) {
            llmSpan.setAttribute('llm.token_count.completion', event.outputTokens);
          }
          if (event.totalTokens !== undefined) {
            llmSpan.setAttribute('llm.token_count.total', event.totalTokens);
          }
          if (event.durationMs !== undefined) {
            llmSpan.setAttribute('llm.duration_ms', event.durationMs);
          }
          if (event.transport) llmSpan.setAttribute('llm.transport', event.transport);
          llmSpan.end();
        });
        // Per-LLM-call cost/latency record. Persisted as a sentinel row in
        // outbound.db with kind='llm-usage' so host-side observability can
        // attribute spend to the originating turn without instrumenting
        // each provider individually. Not user-facing — the host router
        // filters these out before delivery.
        writeMessageOut({
          id: generateId(),
          kind: 'llm-usage',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({
            model: event.model,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            totalTokens: event.totalTokens,
            durationMs: event.durationMs,
            transport: event.transport,
          }),
        });
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { continuation: queryContinuation };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
    case 'compacted':
      log(`Compacted: ${event.text}`);
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
/**
 * Pre-clean common LLM typos in `<message>` wrapping. The strict parser
 * silently drops blocks like `/message to="x">` (missing leading `<`) or
 * `< message to="x">` (stray space). Normalize them before regex matching.
 *
 * Exported for unit testing.
 */
export function normalizeMessageBlocks(text: string): string {
  return text
    .replace(/(^|[\s>])\/message(?=\s+to=)/g, '$1<message')
    .replace(/<\s+message(?=\s+to=)/g, '<message')
    .replace(/<\/\s*message\s*>/g, '</message>')
    .replace(/<\s*\/\s*message\s*>/g, '</message>');
}

function dispatchResultText(text: string, routing: RoutingContext): void {
  const cleaned = normalizeMessageBlocks(text);
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(cleaned.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < cleaned.length) {
    scratchpadParts.push(cleaned.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  if (sent === 0 && cleaned.trim()) {
    // Fallback: many models (especially after a long tool-call chain) emit
    // a final result as bare text instead of wrapping in <message to="name">.
    // Rather than dropping it to scratchpad, deliver to the inbound's source
    // destination (the same place an unwrapped reply would naturally go).
    // Falls through to the WARNING if the group has multiple destinations and
    // we can't determine the source — that's a real ambiguity worth flagging.
    const sourceDest = findByRouting(routing.channelType, routing.platformId);
    if (sourceDest) {
      const body = cleaned.trim();
      log(`Reply-source fallback: delivering ${body.length}B bare text to "${sourceDest.name}"`);
      sendToDestination(sourceDest, body, routing);
      return;
    }
    const all = getAllDestinations();
    if (all.length === 1) {
      const body = cleaned.trim();
      log(`Single-destination fallback: delivering ${body.length}B bare text to "${all[0].name}"`);
      sendToDestination(all[0], body, routing);
      return;
    }
    const sample = text.replace(/\s+/g, ' ').slice(0, 200);
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent. text[0..200]="${sample}"`);
  }
}

export function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);

  // Attribution + classification closure for the main delegation
  // protocol: agents write <message to="worker">...</message> and this
  // function dispatches. The MCP send_message path already carries
  // origin_user_id / _classificationId; this path did NOT until now,
  // so final <message> delegations silently fell into the host's
  // "most recent chat" heuristic for identity and were never linked
  // to any classify_intent row.
  //
  // ONLY attach _classificationId when the destination is actually a
  // worker (channel_type === 'agent'). Frontdesk often emits multiple
  // blocks per turn — e.g. a "I'll check on that" channel reply AND a
  // <message to="worker"> delegation. If we stamped both with the same
  // turn's classificationId, the channel reply would race to
  // reconcile first and occupy outcome_ref (it's first-write-wins),
  // leaving the real delegation unable to link. Classification is a
  // delegation-flow concept; don't leak it to channel acks.
  const content: Record<string, unknown> = { text: body };
  const isA2a = channelType === 'agent';
  const classificationId = isA2a ? getCurrentClassificationId() : null;
  if (classificationId) content._classificationId = classificationId;

  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify(content),
    origin_user_id: a2aOriginUserId(channelType),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
