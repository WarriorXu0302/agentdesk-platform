import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  clearCurrentClassificationId,
  clearCurrentInReplyTo,
  setCurrentClassificationId,
  setCurrentInReplyTo,
} from './current-batch.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { clearRequestIdentity, setRequestIdentity } from './request-context.js';
import { clearRoutingGate, setRoutingGate } from './routing/gate.js';
import { sendToDestination } from './poll-loop.js';
import type { RoutingContext } from './formatter.js';

function seedDestinations() {
  const stmt = getInboundDb().prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  stmt.run('worker', 'Worker', 'agent', null, null, 'ag-worker');
  stmt.run('chan', 'Chan', 'channel', 'feishu', 'feishu:p2p:ou_alice', null);
  stmt.run('other-chan', 'Other Chan', 'channel', 'feishu', 'feishu:group:other', null);
}

function routing(): RoutingContext {
  return {
    platformId: 'feishu:p2p:ou_alice',
    channelType: 'feishu',
    threadId: null,
    inReplyTo: 'original-inbound',
  };
}

function lastOutbound(): {
  content: string;
  origin_user_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
} {
  return getOutboundDb()
    .prepare('SELECT content, origin_user_id, channel_type, thread_id FROM messages_out ORDER BY seq DESC LIMIT 1')
    .get() as { content: string; origin_user_id: string | null; channel_type: string | null; thread_id: string | null };
}

beforeEach(() => {
  initTestSessionDb();
  seedDestinations();
});

afterEach(() => {
  clearRequestIdentity();
  clearCurrentInReplyTo();
  clearCurrentClassificationId();
  clearRoutingGate();
  closeSessionDb();
});

describe('sendToDestination — final <message> dispatch', () => {
  it('stamps origin_user_id on agent-destination sends when identity is trusted', () => {
    setRequestIdentity({
      userId: 'feishu:ou_alice',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_alice',
      threadId: null,
      source: 'session',
    });
    setCurrentInReplyTo('original-inbound');
    sendToDestination({ name: 'worker', type: 'agent', agentGroupId: 'ag-worker' }, 'hello worker', routing());

    const row = lastOutbound();
    expect(row.channel_type).toBe('agent');
    expect(row.origin_user_id).toBe('feishu:ou_alice');
  });

  it('does NOT stamp origin_user_id on plain channel sends', () => {
    setRequestIdentity({
      userId: 'feishu:ou_alice',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_alice',
      threadId: null,
      source: 'session',
    });
    sendToDestination(
      { name: 'chan', type: 'channel', channelType: 'feishu', platformId: 'feishu:p2p:ou_alice' },
      'hi',
      routing(),
    );
    const row = lastOutbound();
    expect(row.channel_type).toBe('feishu');
    expect(row.origin_user_id).toBeNull();
  });

  it('does NOT stamp origin_user_id when identity is agent-asserted', () => {
    setRequestIdentity({
      userId: 'feishu:ou_forged',
      channelType: null,
      platformId: null,
      threadId: null,
      source: 'agent-asserted',
    });
    sendToDestination({ name: 'worker', type: 'agent', agentGroupId: 'ag-worker' }, 'x', routing());
    expect(lastOutbound().origin_user_id).toBeNull();
  });

  it('auto-attaches currentClassificationId to the outbound content', () => {
    setRequestIdentity({
      userId: 'feishu:ou_alice',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_alice',
      threadId: null,
      source: 'session',
    });
    setCurrentClassificationId('cls-abc');
    sendToDestination({ name: 'worker', type: 'agent', agentGroupId: 'ag-worker' }, 'work for you', routing());

    const content = JSON.parse(lastOutbound().content);
    expect(content.text).toBe('work for you');
    expect(content._classificationId).toBe('cls-abc');
  });

  it('omits _classificationId when no classify_intent was called in this turn', () => {
    setRequestIdentity({
      userId: 'feishu:ou_alice',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_alice',
      threadId: null,
      source: 'session',
    });
    // No setCurrentClassificationId — simulates frontdesk forgetting.
    sendToDestination({ name: 'worker', type: 'agent', agentGroupId: 'ag-worker' }, 'bare', routing());

    const content = JSON.parse(lastOutbound().content);
    expect(content.text).toBe('bare');
    expect(content._classificationId).toBeUndefined();
  });

  it('does NOT attach classificationId to channel sends, even when turn has one published', () => {
    // The critical regression fix: agent in a single turn first writes a
    // user-visible channel reply ("I'll check on it") then delegates to
    // a worker. Both go through sendToDestination. If we stamp the
    // channel reply with the turn's classificationId, the host-side
    // reconcile (first-write-wins on outcome_ref) locks onto the user
    // confirmation and the real delegation can never link its audit row.
    setRequestIdentity({
      userId: 'feishu:ou_alice',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_alice',
      threadId: null,
      source: 'session',
    });
    setCurrentClassificationId('cls-turn-42');

    sendToDestination(
      { name: 'chan', type: 'channel', channelType: 'feishu', platformId: 'feishu:p2p:ou_alice' },
      "I'll check on that",
      routing(),
    );
    const channelReply = JSON.parse(lastOutbound().content);
    expect(channelReply._classificationId).toBeUndefined();

    sendToDestination({ name: 'worker', type: 'agent', agentGroupId: 'ag-worker' }, 'do the work', routing());
    const workerMsg = JSON.parse(lastOutbound().content);
    expect(workerMsg._classificationId).toBe('cls-turn-42');
  });

  it('blocks a final XML agent destination that conflicts with answer_self', () => {
    setRoutingGate({
      decisionId: 'route-1',
      anchorId: 'original-inbound',
      action: 'answer_self',
      originChannelType: 'feishu',
      originPlatformId: 'feishu:p2p:ou_alice',
    });
    sendToDestination({ name: 'worker', type: 'agent', agentGroupId: 'ag-worker' }, 'override', routing());
    const count = getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('stamps the routing decision id on a user-facing channel result', () => {
    setRoutingGate({
      decisionId: 'route-2',
      anchorId: 'original-inbound',
      action: 'answer_self',
      originChannelType: 'feishu',
      originPlatformId: 'feishu:p2p:ou_alice',
    });
    sendToDestination(
      { name: 'chan', type: 'channel', channelType: 'feishu', platformId: 'feishu:p2p:ou_alice' },
      'hello',
      routing(),
    );
    expect(JSON.parse(lastOutbound().content)._classificationId).toBe('route-2');
  });

  it('blocks a final XML reply to a non-origin channel during routed execution', () => {
    setRoutingGate({
      decisionId: 'route-3',
      anchorId: 'original-inbound',
      action: 'clarify',
      originChannelType: 'feishu',
      originPlatformId: 'feishu:p2p:ou_alice',
    });
    sendToDestination(
      { name: 'other-chan', type: 'channel', channelType: 'feishu', platformId: 'feishu:group:other' },
      'wrong surface',
      routing(),
    );
    const count = getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('pins a routed channel reply to the current origin thread instead of a newer unrelated thread', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in
          (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES ('newer-other-thread', 99, 'chat', datetime('now'), 'completed', 1,
           'feishu:p2p:ou_alice', 'feishu', 'thread-newer', '{"text":"other"}')`,
      )
      .run();
    const currentRouting: RoutingContext = {
      ...routing(),
      threadId: 'thread-current',
    };
    setRoutingGate({
      decisionId: 'route-thread',
      anchorId: 'original-inbound',
      action: 'answer_self',
      originChannelType: 'feishu',
      originPlatformId: 'feishu:p2p:ou_alice',
      originThreadId: 'thread-current',
    });

    sendToDestination(
      { name: 'chan', type: 'channel', channelType: 'feishu', platformId: 'feishu:p2p:ou_alice' },
      'current thread only',
      currentRouting,
    );

    expect(lastOutbound().thread_id).toBe('thread-current');
  });
});
