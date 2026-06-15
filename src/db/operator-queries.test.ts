import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './index.js';
import { createAgentGroup } from './agent-groups.js';
import { recordClassification } from './classification-log.js';
import { createMessagingGroup } from './messaging-groups.js';
import { listSessions, traceRequest } from './operator-queries.js';
import { createSession } from './sessions.js';
import type { Session } from '../types.js';

function now(): string {
  return new Date().toISOString();
}

function session(over: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    agent_group_id: 'ag-frontdesk',
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: null,
    root_session_id: over.id,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    spawn_depth: 0,
    created_at: now(),
    ...over,
  };
}

beforeEach(() => {
  runMigrations(initTestDb());
  createAgentGroup({ id: 'ag-frontdesk', name: 'FD', folder: 'fd', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-finance', name: 'Fin', folder: 'fin', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-feishu',
    channel_type: 'feishu',
    platform_id: 'oc_main',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
});

describe('listSessions (ADR-0049 operator triage)', () => {
  it('filters by owner, status, channel, agent group (AND semantics)', () => {
    createSession(session({ id: 's-alice', owner_user_id: 'feishu:ou_alice', messaging_group_id: 'mg-feishu' }));
    createSession(session({ id: 's-bob', owner_user_id: 'feishu:ou_bob', messaging_group_id: 'mg-feishu' }));
    createSession(session({ id: 's-archived', owner_user_id: 'feishu:ou_alice', status: 'archived' }));
    createSession(session({ id: 's-worker', agent_group_id: 'ag-finance', owner_user_id: 'feishu:ou_alice' }));

    expect(
      listSessions({ ownerUserId: 'feishu:ou_alice' })
        .map((s) => s.id)
        .sort(),
    ).toEqual(['s-alice', 's-archived', 's-worker']);
    expect(
      listSessions({ ownerUserId: 'feishu:ou_alice', status: 'active' })
        .map((s) => s.id)
        .sort(),
    ).toEqual(['s-alice', 's-worker']);
    expect(
      listSessions({ channelType: 'feishu' })
        .map((s) => s.id)
        .sort(),
    ).toEqual(['s-alice', 's-bob']);
    expect(listSessions({ agentGroupId: 'ag-finance' }).map((s) => s.id)).toEqual(['s-worker']);
  });

  it('no filter returns all; limit caps the result', () => {
    for (let i = 0; i < 5; i++) createSession(session({ id: `s-${i}` }));
    expect(listSessions()).toHaveLength(5);
    expect(listSessions({ limit: 2 })).toHaveLength(2);
  });
});

describe('traceRequest (ADR-0049 fan-out by root_session_id, ADR-0039-safe)', () => {
  it('assembles every session in the delegation tree + their classifications', () => {
    const conv = 'conv-xyz';
    // Frontdesk root (root_session_id defaults to its own id) + a delegated
    // worker that inherits root_session_id='s-fd'. conv id is carried for display.
    createSession(session({ id: 's-fd', conversation_thread_id: conv, owner_user_id: 'feishu:ou_alice' }));
    createSession(
      session({
        id: 's-fin',
        agent_group_id: 'ag-finance',
        root_session_id: 's-fd',
        conversation_thread_id: conv,
        owner_user_id: 'feishu:ou_alice',
      }),
    );
    // An unrelated request (its own root) must NOT appear.
    createSession(session({ id: 's-other' }));

    recordClassification({
      classificationId: 'c1',
      sessionId: 's-fd',
      agentGroupId: 'ag-frontdesk',
      userId: 'feishu:ou_alice',
      action: 'delegate',
      recommendedWorker: 'ag-finance',
      conversationThreadId: conv,
    });
    // A classification on an unrelated session — must be excluded (keyed by session_id).
    recordClassification({
      classificationId: 'c2',
      sessionId: 's-other',
      agentGroupId: 'ag-frontdesk',
      userId: 'feishu:ou_bob',
      action: 'delegate',
    });

    const trace = traceRequest('s-fd');
    expect(trace.sessions.map((s) => s.id).sort()).toEqual(['s-fd', 's-fin']);
    expect(trace.classifications).toHaveLength(1);
    expect(trace.classifications[0]!.classification_id).toBe('c1');
  });

  it('returns empty arrays for an unknown root session id', () => {
    const trace = traceRequest('nope');
    expect(trace.sessions).toEqual([]);
    expect(trace.classifications).toEqual([]);
  });
});
