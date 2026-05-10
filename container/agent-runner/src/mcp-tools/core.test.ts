/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { setRequestIdentity, clearRequestIdentity } from '../request-context.js';
import { sendMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  clearRequestIdentity();
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_message MCP tool — a2a origin_user_id stamping', () => {
  it('stamps origin_user_id on agent-destination rows when a session-trusted identity is active', async () => {
    setRequestIdentity({
      userId: 'feishu:ou_alice',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_alice',
      threadId: null,
      source: 'session',
    });

    await sendMessage.handler({ to: 'peer', text: 'delegate this' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('agent');
    expect(out[0].origin_user_id).toBe('feishu:ou_alice');
  });

  it('does NOT stamp origin_user_id when the turn has agent-asserted identity', async () => {
    // agent-asserted identity must not leak into the a2a trust chain —
    // fallback path (source-session lookup) is safer.
    setRequestIdentity({
      userId: 'feishu:ou_spoofed',
      channelType: null,
      platformId: null,
      threadId: null,
      source: 'agent-asserted',
    });

    await sendMessage.handler({ to: 'peer', text: 'hi' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].origin_user_id).toBeNull();
  });

  it('does NOT stamp origin_user_id on channel-delivered (non-a2a) rows', async () => {
    // Seed a channel-type destination.
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('chan', 'Chan', 'channel', 'feishu', 'feishu:p2p:ou_alice', NULL)`,
      )
      .run();
    setRequestIdentity({
      userId: 'feishu:ou_alice',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_alice',
      threadId: null,
      source: 'session',
    });

    await sendMessage.handler({ to: 'chan', text: 'hi' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('feishu');
    expect(out[0].origin_user_id).toBeNull();
  });
});
