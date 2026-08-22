/**
 * Scheduling handlers at the container→host boundary (ADR-0063).
 *
 * These five actions were the largest remaining group reading agent-authored
 * fields through type assertions. The casts were not cosmetic — each one
 * produced a distinct silent wrong state rather than an error:
 *
 *   - a non-string `taskId` persists a coerced row id that no later
 *     cancel/pause/resume can address: the task is both unschedulable and
 *     uncancellable, and nothing reports it;
 *   - a non-string `processAfter` is coerced by the SQLite `datetime()`
 *     comparison into a task that never fires or fires immediately;
 *   - `platformId` / `channelType` decide where the woken message is delivered.
 *
 * So what is pinned here is that a malformed field WRITES NOTHING, which is
 * the only outcome that leaves the operator's scheduled tasks trustworthy.
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';
import {
  handleCancelTask,
  handlePauseTask,
  handleResumeTask,
  handleScheduleTask,
  handleUpdateTask,
} from './actions.js';

const TEST_DIR = '/tmp/nanoclaw-scheduling-actions-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

const session = { id: 's-1', agent_group_id: 'ag-1', status: 'active' } as Session;

let db: ReturnType<typeof openInboundDb>;

interface TaskRow {
  id: string;
  process_after: string | null;
  recurrence: string | null;
  platform_id: string | null;
  content: string;
  status: string;
}

function tasks(): TaskRow[] {
  return db
    .prepare("SELECT id, process_after, recurrence, platform_id, content, status FROM messages_in WHERE kind = 'task'")
    .all() as TaskRow[];
}

function schedule(overrides: Record<string, unknown> = {}): Promise<void> {
  return handleScheduleTask(
    {
      action: 'schedule_task',
      taskId: 'task-1',
      prompt: 'water the plants',
      processAfter: '2026-09-01 09:00:00',
      ...overrides,
    },
    session,
    db,
  );
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  db = openInboundDb(DB_PATH);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('schedule_task', () => {
  it('writes the task when every field is well formed', async () => {
    await schedule({ recurrence: '0 9 * * *', platformId: 'feishu:oc_1', channelType: 'feishu' });

    const rows = tasks();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('task-1');
    expect(rows[0].recurrence).toBe('0 9 * * *');
    expect(rows[0].platform_id).toBe('feishu:oc_1');
    expect(JSON.parse(rows[0].content)).toEqual({ prompt: 'water the plants', script: null });
  });

  it('writes NOTHING when taskId is not a string', async () => {
    await schedule({ taskId: 12345 });
    expect(tasks()).toHaveLength(0);
  });

  it('writes NOTHING when processAfter is not a string', async () => {
    await schedule({ processAfter: { $gt: 0 } });
    expect(tasks()).toHaveLength(0);
  });

  it('writes NOTHING when recurrence or the routing fields are not strings', async () => {
    await schedule({ recurrence: 42 });
    expect(tasks()).toHaveLength(0);

    await schedule({ platformId: ['feishu:oc_1'] });
    expect(tasks()).toHaveLength(0);

    await schedule({ channelType: { type: 'feishu' } });
    expect(tasks()).toHaveLength(0);
  });

  it('requires taskId and processAfter to be present at all', async () => {
    await handleScheduleTask({ action: 'schedule_task', prompt: 'x' }, session, db);
    expect(tasks()).toHaveLength(0);
  });

  it('keeps an absent script as null rather than the empty string', async () => {
    await schedule();
    expect(JSON.parse(tasks()[0].content)).toEqual({ prompt: 'water the plants', script: null });
  });
});

describe('cancel / pause / resume', () => {
  const cases = [
    ['cancel_task', handleCancelTask],
    ['pause_task', handlePauseTask],
    ['resume_task', handleResumeTask],
  ] as const;

  it.each(cases)('%s refuses a non-string taskId instead of coercing it into a lookup', async (action, handler) => {
    await schedule();
    const before = tasks()[0].status;

    await handler({ action, taskId: { id: 'task-1' } }, session, db);

    expect(tasks()[0].status).toBe(before);
  });

  it('cancel_task still works on a well-formed id', async () => {
    await schedule();
    await handleCancelTask({ action: 'cancel_task', taskId: 'task-1' }, session, db);
    expect(tasks()[0].status).toBe('completed');
  });
});

describe('update_task', () => {
  /**
   * update_task is partial: an absent field means "leave it", and an explicit
   * null on recurrence/script means "clear it". Previously a present-but-wrong
   * type was SILENTLY SKIPPED and the call still reported success, so an agent
   * could believe it had changed a schedule that never moved.
   */
  it('applies a well-formed partial update', async () => {
    await schedule({ recurrence: '0 9 * * *' });
    await handleUpdateTask({ action: 'update_task', taskId: 'task-1', prompt: 'feed the cat' }, session, db);

    expect(JSON.parse(tasks()[0].content).prompt).toBe('feed the cat');
    expect(tasks()[0].recurrence).toBe('0 9 * * *'); // untouched
  });

  it('clears recurrence on an explicit null', async () => {
    await schedule({ recurrence: '0 9 * * *' });
    await handleUpdateTask({ action: 'update_task', taskId: 'task-1', recurrence: null }, session, db);
    expect(tasks()[0].recurrence).toBeNull();
  });

  it('refuses the whole update when one present field has the wrong type', async () => {
    await schedule({ recurrence: '0 9 * * *' });
    await handleUpdateTask(
      { action: 'update_task', taskId: 'task-1', prompt: 'feed the cat', processAfter: 999 },
      session,
      db,
    );

    // All-or-nothing: the valid prompt is not applied either, because a
    // half-applied update is a schedule the agent believes it set and did not.
    expect(JSON.parse(tasks()[0].content).prompt).toBe('water the plants');
  });

  it('refuses a non-string taskId', async () => {
    await schedule();
    await handleUpdateTask({ action: 'update_task', taskId: null, prompt: 'x' }, session, db);
    expect(JSON.parse(tasks()[0].content).prompt).toBe('water the plants');
  });
});
