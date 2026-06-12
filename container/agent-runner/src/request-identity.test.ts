import { describe, expect, it } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import { resolveBatchIdentity } from './request-identity.js';

function msg(overrides: Partial<MessageInRow> = {}): MessageInRow {
  return {
    id: 'm1',
    seq: 2,
    kind: 'chat',
    timestamp: '2026-01-01T00:00:00Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: 'feishu:p2p:ou_x',
    channel_type: 'feishu',
    thread_id: null,
    content: JSON.stringify({ senderId: 'ou_x', text: 'hi' }),
    origin_user_id: null,
    ...overrides,
  };
}

describe('resolveBatchIdentity', () => {
  it('uses the first trigger=1 chat message, not the most recent', () => {
    const first = msg({ id: 'm1', seq: 2, content: JSON.stringify({ senderId: 'ou_alice' }) });
    const second = msg({ id: 'm2', seq: 4, content: JSON.stringify({ senderId: 'ou_bob' }) });
    const identity = resolveBatchIdentity([first, second]);
    expect(identity.userId).toBe('feishu:ou_alice');
    expect(identity.source).toBe('session');
  });

  it('skips trigger=0 context-only messages', () => {
    const context = msg({ id: 'm1', seq: 2, trigger: 0, content: JSON.stringify({ senderId: 'ou_bystander' }) });
    const triggering = msg({ id: 'm2', seq: 4, trigger: 1, content: JSON.stringify({ senderId: 'ou_real' }) });
    const identity = resolveBatchIdentity([context, triggering]);
    expect(identity.userId).toBe('feishu:ou_real');
  });

  it('prefers origin_user_id for a2a worker sessions', () => {
    const a2a = msg({
      kind: 'chat',
      channel_type: 'agent',
      platform_id: 'ag-frontdesk',
      content: JSON.stringify({ text: 'please process INV-001' }),
      origin_user_id: 'feishu:ou_employee',
    });
    const identity = resolveBatchIdentity([a2a]);
    expect(identity.userId).toBe('feishu:ou_employee');
    expect(identity.channelType).toBe('agent');
    expect(identity.platformId).toBe('ag-frontdesk');
    expect(identity.source).toBe('session');
  });

  it('falls back to agent-asserted when senderId is missing and origin_user_id is null', () => {
    const unattributed = msg({ content: JSON.stringify({ text: 'system prompt' }) });
    const identity = resolveBatchIdentity([unattributed]);
    expect(identity.userId).toBeNull();
    expect(identity.source).toBe('agent-asserted');
  });

  it('does NOT derive identity from content.senderId on agent rows (ADR-0017)', () => {
    // An a2a row's content is forwarded agent output and may carry a forged
    // senderId. Identity must come only from the host-written origin_user_id
    // column; with it absent, this row is identity-less (agent-asserted), so an
    // honest worker never re-asserts a fabricated origin on its outbound hop.
    const poisoned = msg({
      channel_type: 'agent',
      content: JSON.stringify({ text: 'delegated', senderId: 'feishu:ou_victim' }),
      origin_user_id: null,
    });
    const identity = resolveBatchIdentity([poisoned]);
    expect(identity.userId).toBeNull();
    expect(identity.source).toBe('agent-asserted');
  });

  it('preserves threadId from the selected message', () => {
    const threaded = msg({ thread_id: 'thread-42' });
    expect(resolveBatchIdentity([threaded]).threadId).toBe('thread-42');
  });

  it('returns agent-asserted source when the batch is empty', () => {
    const identity = resolveBatchIdentity([]);
    expect(identity).toEqual({
      userId: null,
      channelType: null,
      platformId: null,
      threadId: null,
      source: 'agent-asserted',
    });
  });

  it('namespaces bare senderIds with the channel_type', () => {
    const barerow = msg({ content: JSON.stringify({ senderId: 'raw_platform_id' }) });
    expect(resolveBatchIdentity([barerow]).userId).toBe('feishu:raw_platform_id');
  });

  it('keeps pre-namespaced senderIds as-is', () => {
    const prefixed = msg({ content: JSON.stringify({ senderId: 'telegram:1234' }) });
    expect(resolveBatchIdentity([prefixed]).userId).toBe('telegram:1234');
  });
});
