import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { queryClassificationLog } from '../../db/classification-log.js';
import { getDb } from '../../db/connection.js';
import type { DeliveryActionHandler } from '../../delivery.js';
import type { Session } from '../../types.js';

/**
 * A minimal host-written inbound.db carrying the given namespaced origins as
 * chat rows — the "legitimate identity set" the recording handlers cross-
 * validate a container-claimed actor against on an owner-less session.
 */
function fakeInboundDb(origins: string[]): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE messages_in (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, origin_user_id TEXT, content TEXT, channel_type TEXT)',
  );
  const ins = db.prepare(
    "INSERT INTO messages_in (kind, origin_user_id, content, channel_type) VALUES ('chat', ?, '{}', 'feishu')",
  );
  for (const o of origins) ins.run(o);
  return db;
}

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

    // Owner-less (shared) session: the claimed actor is honored because alice
    // genuinely appeared in this session's host-written inbound.db.
    const inDb = fakeInboundDb(['feishu:ou_alice']);
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
      inDb,
    );
    inDb.close();

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

  it('owner-less session: DROPS a forged actor that never appeared in the session (+ counts the rejection)', async () => {
    const { recordingActorRejectedTotal } = await import('../../metrics.js');
    const sum = async () => (await recordingActorRejectedTotal.get()).values.reduce((s, v) => s + v.value, 0);
    const before = await sum();

    const handler = captured.get('classify_intent')!;
    // Only alice is a legitimate origin; the container claims an arbitrary victim.
    const inDb = fakeInboundDb(['feishu:ou_alice']);
    await handler(
      {
        action: 'classify_intent',
        userMessage: 'x',
        confidence: 0.5,
        action_taken: 'delegate',
        userId: 'feishu:ou_victim',
      },
      session(),
      inDb,
    );
    inDb.close();

    // Forged attribution is dropped to null (not persisted as the victim).
    expect(queryClassificationLog()[0]!.user_id).toBeNull();
    expect(await sum()).toBeGreaterThan(before);
  });

  it('owner-less session: KEEPS a claimed actor that genuinely appeared in the session', async () => {
    const handler = captured.get('classify_intent')!;
    const inDb = fakeInboundDb(['feishu:ou_alice', 'feishu:ou_bob']);
    await handler(
      {
        action: 'classify_intent',
        userMessage: 'x',
        confidence: 0.5,
        action_taken: 'delegate',
        userId: 'feishu:ou_bob',
      },
      session(),
      inDb,
    );
    inDb.close();
    // Correct attribution to a real session participant is preserved.
    expect(queryClassificationLog()[0]!.user_id).toBe('feishu:ou_bob');
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

  it('owner-less session: a forged actor lands as NULL in the agent_escalation audit (not the victim)', async () => {
    const handler = captured.get('escalate')!;
    const inDb = fakeInboundDb(['feishu:ou_alice']); // victim never appeared
    await handler(
      { action: 'escalate', escalation_reason: 'frame the victim', urgency_level: 'high', userId: 'feishu:ou_victim' },
      session(),
      inDb,
    );
    inDb.close();
    const audit = auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBeNull(); // forged attribution dropped, not stamped as the victim
    expect(queryClassificationLog()[0]!.user_id).toBeNull();
  });
});

describe('routing_feedback delivery action (ADR-0040, roadmap 2.1/2.5)', () => {
  function auditRows(): Array<{ actor: string | null; details: string | null }> {
    return getDb()
      .prepare("SELECT actor, details FROM enterprise_audit WHERE event_type = 'agent_routing_feedback'")
      .all() as Array<{ actor: string | null; details: string | null }>;
  }

  it('records a misroute row + agent_routing_feedback audit, trusting the session owner', async () => {
    const handler = captured.get('routing_feedback');
    expect(handler).toBeDefined();
    const sess = session();
    sess.agent_group_id = 'ag-finance-worker';
    sess.owner_user_id = 'feishu:ou_alice';

    await handler!(
      {
        action: 'routing_feedback',
        userId: 'feishu:ou_forged',
        feedback_kind: 'misroute',
        feedback_reason: 'this is an HR question, not finance',
        suggested_target: 'hr-worker',
        classificationId: 'cls-orig-7',
      },
      sess,
      {} as never,
    );

    const row = queryClassificationLog()[0]!;
    expect(row.action).toBe('routing_feedback');
    expect(row.feedback_kind).toBe('misroute');
    expect(row.reasoning).toBe('this is an HR question, not finance');
    expect(row.recommended_worker).toBe('hr-worker'); // verbatim suggested-target hint
    expect(row.classification_id).toBe('cls-orig-7'); // correlation back to the original classify row
    expect(row.outcome_ref).toBe('feedback:misroute'); // terminal self-stamp
    expect(row.user_id).toBe('feishu:ou_alice'); // session owner, not the forged claim
    expect(row.agent_group_id).toBe('ag-finance-worker'); // the worker that reported

    const audit = auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe('feishu:ou_alice');
    expect(JSON.parse(audit[0].details!)).toMatchObject({
      kind: 'misroute',
      suggestedTarget: 'hr-worker',
      misroutedClassificationId: 'cls-orig-7',
    });
  });

  it('coerces an out-of-enum feedback_kind to "unknown" (host boundary)', async () => {
    const handler = captured.get('routing_feedback')!;
    await handler({ action: 'routing_feedback', feedback_kind: 'DROP TABLE' }, session(), {} as never);
    const row = queryClassificationLog()[0]!;
    expect(row.feedback_kind).toBe('unknown');
    expect(row.outcome_ref).toBe('feedback:unknown');
  });

  it('records a nack with self-stamped outcome', async () => {
    const handler = captured.get('routing_feedback')!;
    await handler(
      { action: 'routing_feedback', feedback_kind: 'nack', feedback_reason: 'cannot complete this turn' },
      session(),
      {} as never,
    );
    const row = queryClassificationLog()[0]!;
    expect(row.feedback_kind).toBe('nack');
    expect(row.outcome_ref).toBe('feedback:nack');
  });

  it('stores suggested_target verbatim WITHOUT validating it against destinations (ADR-0040)', async () => {
    const handler = captured.get('routing_feedback')!;
    // A target this worker (or anyone) cannot reach — the host must NOT reject,
    // resolve, or route on it; it is an operator-facing hint only.
    await handler(
      { action: 'routing_feedback', feedback_kind: 'misroute', suggested_target: 'totally-made-up-worker-xyz' },
      session(),
      {} as never,
    );
    expect(queryClassificationLog()[0]!.recommended_worker).toBe('totally-made-up-worker-xyz');
  });

  it('increments routing_feedback_total{kind,reported_by}', async () => {
    const { routingFeedbackTotal } = await import('../../metrics.js');
    const sum = async () => (await routingFeedbackTotal.get()).values.reduce((s, v) => s + v.value, 0);
    const before = await sum();
    const handler = captured.get('routing_feedback')!;
    await handler({ action: 'routing_feedback', feedback_kind: 'misroute' }, session(), {} as never);
    expect(await sum()).toBeGreaterThan(before);
  });

  it('is provably recording-only: the module references no send/route/inbound-write primitive', async () => {
    // ADR-0040: the handler must have NO reroute path — active reroute was
    // rejected. Guard structurally so a future edit that wires routing in fails.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    for (const forbidden of ['routeAgentMessage', 'writeSessionMessage', 'writeMessageOut', 'resolveTargetSession']) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });
});
