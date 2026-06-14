import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { queryClassificationLog } from '../../db/classification-log.js';
import { getDb } from '../../db/connection.js';
import type { DeliveryActionHandler } from '../../delivery.js';
import type { Session } from '../../types.js';

const captured: Map<string, DeliveryActionHandler> = new Map();

vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: DeliveryActionHandler) => {
    captured.set(action, handler);
  },
}));

// Side-effect import registers the handler.
await import('./index.js');

function session(): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-frontdesk',
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: null,
    root_session_id: 'sess-1',
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('classify_intent delivery action', () => {
  it('persists a normal classification into the log', async () => {
    const handler = captured.get('classify_intent');
    expect(handler).toBeDefined();

    await handler!(
      {
        action: 'classify_intent',
        userId: 'feishu:ou_alice',
        userMessage: 'please approve invoice INV-001',
        recommendedWorker: 'finance-worker',
        confidence: 0.91,
        candidates: ['finance-worker'],
        reasoning: 'mentions invoice + approve keywords',
        action_taken: 'delegate',
      },
      session(),
      {} as never,
    );

    const rows = queryClassificationLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: 'feishu:ou_alice',
      recommended_worker: 'finance-worker',
      confidence: 0.91,
      action: 'delegate',
      session_id: 'sess-1',
      agent_group_id: 'ag-frontdesk',
    });
  });

  it('defaults to action=delegate when the payload omits a recognized action_taken', async () => {
    const handler = captured.get('classify_intent')!;
    await handler({ action: 'classify_intent', userMessage: 'hi', confidence: 0.5 }, session(), {} as never);
    expect(queryClassificationLog()[0]!.action).toBe('delegate');
  });

  it('accepts each of the four action variants', async () => {
    const handler = captured.get('classify_intent')!;
    for (const a of ['delegate', 'clarify', 'reject', 'answer_self'] as const) {
      await handler(
        { action: 'classify_intent', userMessage: `msg-${a}`, confidence: 0.5, action_taken: a },
        session(),
        {} as never,
      );
    }
    const rows = queryClassificationLog();
    expect(rows.map((r) => r.action).sort()).toEqual(['answer_self', 'clarify', 'delegate', 'reject']);
  });

  it('trusts session.owner_user_id over agent-claimed userId', async () => {
    const handler = captured.get('classify_intent')!;
    const sess = session();
    sess.owner_user_id = 'feishu:ou_real';
    await handler(
      {
        action: 'classify_intent',
        userMessage: 'who am I',
        confidence: 0.9,
        action_taken: 'delegate',
        userId: 'feishu:ou_forged',
      },
      sess,
      {} as never,
    );
    const row = queryClassificationLog()[0]!;
    expect(row.user_id).toBe('feishu:ou_real');
  });

  it('records the session conversation_thread_id (ADR-0039), not an agent-claimed one', async () => {
    const handler = captured.get('classify_intent')!;
    const sess = session();
    sess.conversation_thread_id = 'conv-abc';
    await handler(
      // even if the agent tries to supply a different thread id, the host
      // records the session's (host-owned) value.
      {
        action: 'classify_intent',
        userMessage: 'hi',
        confidence: 0.8,
        action_taken: 'delegate',
        conversation_thread_id: 'conv-FORGED',
      },
      sess,
      {} as never,
    );
    expect(queryClassificationLog()[0]!.conversation_thread_id).toBe('conv-abc');
  });

  it('persists channel/platform/thread fields from the payload', async () => {
    const handler = captured.get('classify_intent')!;
    await handler(
      {
        action: 'classify_intent',
        classificationId: 'cls-42',
        userMessage: 'hello',
        confidence: 0.8,
        action_taken: 'delegate',
        channelType: 'feishu',
        platformId: 'feishu:oc_group_1',
        threadId: 'thread-7',
      },
      session(),
      {} as never,
    );
    const row = queryClassificationLog()[0]!;
    expect(row.classification_id).toBe('cls-42');
    expect(row.channel_type).toBe('feishu');
    expect(row.platform_id).toBe('feishu:oc_group_1');
    expect(row.thread_id).toBe('thread-7');
  });
});

describe('escalate delivery action (ADR-0038)', () => {
  function auditRows(): Array<{ actor: string | null; details: string | null }> {
    return getDb()
      .prepare("SELECT actor, details FROM enterprise_audit WHERE event_type = 'agent_escalation'")
      .all() as Array<{ actor: string | null; details: string | null }>;
  }

  it('records an escalation row + agent_escalation audit, trusting the session owner', async () => {
    const handler = captured.get('escalate');
    expect(handler).toBeDefined();
    const sess = session();
    sess.owner_user_id = 'feishu:ou_alice';

    await handler!(
      {
        action: 'escalate',
        userId: 'feishu:ou_forged',
        userMessage: 'I need a human',
        escalation_reason: 'refund dispute beyond policy',
        urgency_level: 'high',
      },
      sess,
      {} as never,
    );

    const row = queryClassificationLog()[0]!;
    expect(row.action).toBe('escalate');
    expect(row.escalation_reason).toBe('refund dispute beyond policy');
    expect(row.urgency_level).toBe('high');
    expect(row.user_id).toBe('feishu:ou_alice'); // session owner, not the forged claim

    const audit = auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe('feishu:ou_alice');
    expect(JSON.parse(audit[0].details!)).toMatchObject({ urgency: 'high', reason: 'refund dispute beyond policy' });
  });

  it('coerces an out-of-enum urgency to "unknown" (host boundary)', async () => {
    const handler = captured.get('escalate')!;
    await handler({ action: 'escalate', escalation_reason: 'x', urgency_level: 'SUPER_DUPER' }, session(), {} as never);
    expect(queryClassificationLog()[0]!.urgency_level).toBe('unknown');
  });

  it('increments escalation_total', async () => {
    const { escalationTotal } = await import('../../metrics.js');
    const sum = async () => (await escalationTotal.get()).values.reduce((s, v) => s + v.value, 0);
    const before = await sum();
    const handler = captured.get('escalate')!;
    await handler(
      { action: 'escalate', escalation_reason: 'urgent thing', urgency_level: 'critical' },
      session(),
      {} as never,
    );
    expect(await sum()).toBeGreaterThan(before);
  });
});
