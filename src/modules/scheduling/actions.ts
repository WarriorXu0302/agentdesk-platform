/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change to inbound.db here.
 *
 * Every field below comes from `messages_out.content`, i.e. from the untrusted
 * side, and is read through the strict readers rather than cast (ADR-0063).
 * The casts these replaced were not cosmetic:
 *
 *   - `taskId` becomes a row id and is later matched by cancel/pause/resume. A
 *     non-string one persists a coerced key that no later call can address, so
 *     the task is unschedulable AND uncancellable.
 *   - `processAfter` is compared against SQLite `datetime()`. A non-string is
 *     coerced by the comparison, producing a task that either never fires or
 *     fires immediately — silently, with no error anywhere.
 *   - `recurrence` is handed to the cron parser on every sweep tick. The
 *     recurrence handler catches per message, so a bad value is logged rather
 *     than thrown, but it retries forever.
 *   - `platformId` / `channelType` decide where the woken message is delivered.
 */
import type Database from 'better-sqlite3';

import { wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { readString } from '../../outbound-contract.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { cancelTask, insertTask, pauseTask, resumeTask, updateTask, type TaskUpdate } from './db.js';

/** Longest prompt/script a scheduled task may carry. */
const MAX_PROMPT_LEN = 64 * 1024;

/**
 * Refuse a malformed scheduling request.
 *
 * Logged rather than thrown: the row is already past the outbound contract, so
 * it is structurally sound and merely wrong at the field level. Throwing would
 * send it round the delivery retry loop ten times for a payload whose bytes
 * will not change.
 */
function refuse(action: string, reason: string): void {
  log.warn('Scheduling request refused at the outbound boundary', { action, reason });
}

export async function handleScheduleTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = readString(content, 'taskId', { required: true, maxLength: 128 });
  if (!taskId.ok) return refuse('schedule_task', taskId.reason);
  const processAfter = readString(content, 'processAfter', { required: true, maxLength: 64 });
  if (!processAfter.ok) return refuse('schedule_task', processAfter.reason);
  const prompt = readString(content, 'prompt', { maxLength: MAX_PROMPT_LEN });
  if (!prompt.ok) return refuse('schedule_task', prompt.reason);
  const script = readString(content, 'script', { maxLength: MAX_PROMPT_LEN });
  if (!script.ok) return refuse('schedule_task', script.reason);
  const recurrence = readString(content, 'recurrence', { maxLength: 128 });
  if (!recurrence.ok) return refuse('schedule_task', recurrence.reason);
  const platformId = readString(content, 'platformId', { maxLength: 256 });
  if (!platformId.ok) return refuse('schedule_task', platformId.reason);
  const channelType = readString(content, 'channelType', { maxLength: 64 });
  if (!channelType.ok) return refuse('schedule_task', channelType.reason);
  const threadId = readString(content, 'threadId', { maxLength: 256 });
  if (!threadId.ok) return refuse('schedule_task', threadId.reason);

  insertTask(inDb, {
    id: taskId.value,
    processAfter: processAfter.value,
    recurrence: recurrence.value || null,
    platformId: platformId.value || null,
    channelType: channelType.value || null,
    threadId: threadId.value || null,
    // Shape note, stated accurately rather than glossed: the old cast left
    // `script` as `undefined` when the field was absent, and JSON.stringify
    // drops undefined keys, so the stored JSON simply had no `script`. It now
    // always carries an explicit null. That is a real shape change, not a
    // byte-identical one — it is safe because the ONLY consumer is
    // container/agent-runner/src/scheduling/task-script.ts, which reads
    // `typeof content.script === 'string' ? content.script : null` and so
    // cannot tell absent from null. Existing rows keep their old shape and are
    // read the same way.
    content: JSON.stringify({ prompt: prompt.value, script: script.value || null }),
  });
  log.info('Scheduled task created', {
    taskId: taskId.value,
    processAfter: processAfter.value,
    recurrence: recurrence.value || null,
  });
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = readString(content, 'taskId', { required: true, maxLength: 128 });
  if (!taskId.ok) return refuse('cancel_task', taskId.reason);
  cancelTask(inDb, taskId.value);
  log.info('Task cancelled', { taskId: taskId.value });
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = readString(content, 'taskId', { required: true, maxLength: 128 });
  if (!taskId.ok) return refuse('pause_task', taskId.reason);
  pauseTask(inDb, taskId.value);
  log.info('Task paused', { taskId: taskId.value });
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = readString(content, 'taskId', { required: true, maxLength: 128 });
  if (!taskId.ok) return refuse('resume_task', taskId.reason);
  resumeTask(inDb, taskId.value);
  log.info('Task resumed', { taskId: taskId.value });
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskIdR = readString(content, 'taskId', { required: true, maxLength: 128 });
  if (!taskIdR.ok) return refuse('update_task', taskIdR.reason);
  const taskId = taskIdR.value;

  // update_task is PARTIAL by design: an absent field means "leave it alone",
  // and `recurrence: null` / `script: null` mean "clear it". So presence and
  // type are read directly here rather than through the readers, which cannot
  // express that three-way distinction — but the type discipline is the same,
  // and a present-but-wrong-typed field is now a refusal instead of a silent
  // skip that reported success.
  const update: TaskUpdate = {};
  for (const field of ['prompt', 'processAfter'] as const) {
    if (field in content && content[field] !== undefined) {
      if (typeof content[field] !== 'string') return refuse('update_task', `"${field}" must be a string`);
      update[field] = content[field];
    }
  }
  for (const field of ['recurrence', 'script'] as const) {
    if (field in content && content[field] !== undefined) {
      if (content[field] !== null && typeof content[field] !== 'string') {
        return refuse('update_task', `"${field}" must be a string or null`);
      }
      update[field] = content[field] as string | null;
    }
  }
  const touched = updateTask(inDb, taskId, update);
  log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
  if (touched === 0) {
    // Notify the agent that update_task matched nothing. Replicates the
    // old notifyAgent helper that used to live in delivery.ts — inlined
    // here so scheduling doesn't depend on delivery's private helpers.
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `update_task: no live task matched id "${taskId}".`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) =>
        log.error('Failed to wake container after update_task notification', { err }),
      );
    }
  }
}
