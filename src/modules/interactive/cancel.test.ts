import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createPendingQuestion, createSession } from '../../db/sessions.js';
import { CANCEL_SENTINEL } from '../../channels/ask-question.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessageInterceptorFn } from '../../router.js';
import type { Session } from '../../types.js';

let captured: MessageInterceptorFn | undefined;
const senderSpy = vi.fn((_e: InboundEvent): string | null => null);
const resolveSpy = vi.fn(async (..._args: unknown[]): Promise<void> => {});
const deliverSpy = vi.fn(() => Promise.resolve());

vi.mock('../../router.js', () => ({
  setMessageInterceptor: (fn: MessageInterceptorFn) => {
    captured = fn;
  },
  resolveSender: (e: InboundEvent) => senderSpy(e),
}));
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverSpy }),
}));
// Avoid the real session-DB write/wake — we assert the interceptor's decision +
// scoping; resolvePendingQuestion's wire is covered by the interactive handler.
vi.mock('./index.js', () => ({ resolvePendingQuestion: resolveSpy }));

// Side-effect import registers the interceptor (captured above).
await import('./cancel.js');

function session(id: string, owner: string | null): Session {
  return {
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: owner,
    root_session_id: id,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

function seedQuestion(questionId: string, sessionId: string): void {
  createPendingQuestion({
    question_id: questionId,
    session_id: sessionId,
    message_out_id: `mo-${questionId}`,
    platform_id: 'p1',
    channel_type: 'feishu',
    thread_id: null,
    title: 'Confirm',
    options: [{ label: 'a', selectedLabel: 'a', value: 'a' }],
    created_at: new Date().toISOString(),
  });
}

function event(text: string): InboundEvent {
  return {
    channelType: 'feishu',
    platformId: 'p1',
    threadId: null,
    message: { id: 'm1', kind: 'chat', content: JSON.stringify({ text }), timestamp: new Date().toISOString() },
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  senderSpy.mockReset();
  senderSpy.mockReturnValue(null);
  resolveSpy.mockClear();
  deliverSpy.mockClear();
});

afterEach(() => closeDb());

describe('out-of-band cancel interceptor (ADR-0042, roadmap 6.6)', () => {
  it('registered a message interceptor', () => {
    expect(captured).toBeDefined();
  });

  it("cancels the sender's own pending question in a per-user session", async () => {
    createSession(session('s-alice', 'feishu:ou_alice'));
    seedQuestion('q1', 's-alice');
    senderSpy.mockReturnValue('feishu:ou_alice');

    const consumed = await captured!(event('/cancel'));

    expect(consumed).toBe(true);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    // (session, pq, selectedOption, userId, opts)
    expect(resolveSpy.mock.calls[0][2]).toBe(CANCEL_SENTINEL);
    expect(resolveSpy.mock.calls[0][3]).toBe('feishu:ou_alice');
    expect(resolveSpy.mock.calls[0][4]).toEqual({ cancelled: true });
    expect(deliverSpy).toHaveBeenCalledTimes(1);
  });

  it('is a structural no-op in a shared session (owner_user_id NULL) — cross-user safe', async () => {
    createSession(session('s-shared', null)); // shared: no owner
    seedQuestion('q1', 's-shared');
    senderSpy.mockReturnValue('feishu:ou_alice');

    const consumed = await captured!(event('/cancel'));

    expect(consumed).toBe(false); // nothing matched → message routes to the agent
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("user B cannot cancel user A's pending question", async () => {
    createSession(session('s-alice', 'feishu:ou_alice'));
    seedQuestion('q1', 's-alice');
    senderSpy.mockReturnValue('feishu:ou_bob'); // different user

    const consumed = await captured!(event('/cancel'));

    expect(consumed).toBe(false);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('passes through non-cancel messages without resolving the sender', async () => {
    createSession(session('s-alice', 'feishu:ou_alice'));
    seedQuestion('q1', 's-alice');
    // substring match must NOT trigger — only exact whole-message tokens.
    const consumed = await captured!(event('please cancel my 3pm meeting'));
    expect(consumed).toBe(false);
    expect(senderSpy).not.toHaveBeenCalled();
  });

  it('passes through an exact cancel token when the sender has no pending question', async () => {
    senderSpy.mockReturnValue('feishu:ou_nobody');
    const consumed = await captured!(event('取消'));
    expect(consumed).toBe(false);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('matches 取消 as an exact whole message', async () => {
    createSession(session('s-alice', 'feishu:ou_alice'));
    seedQuestion('q1', 's-alice');
    senderSpy.mockReturnValue('feishu:ou_alice');
    expect(await captured!(event('取消'))).toBe(true);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it('never throws — a resolver error degrades to pass-through', async () => {
    senderSpy.mockImplementation(() => {
      throw new Error('boom');
    });
    const consumed = await captured!(event('/cancel'));
    expect(consumed).toBe(false);
  });
});
