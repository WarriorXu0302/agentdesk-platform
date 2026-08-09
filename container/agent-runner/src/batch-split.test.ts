import { describe, expect, it } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import { splitBatchByTrigger, splitBatchByTurn } from './request-identity.js';

function row(partial: Partial<MessageInRow> & { id: string }): MessageInRow {
  return {
    seq: 2,
    kind: 'chat',
    timestamp: '2026-05-13T00:00:00Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: 'feishu:p1',
    channel_type: 'feishu',
    thread_id: null,
    content: JSON.stringify({ senderId: 'feishu:ou_alice' }),
    origin_user_id: null,
    ...partial,
  };
}

describe('splitBatchByTurn', () => {
  it('returns empty keep/defer for empty batch', () => {
    expect(splitBatchByTurn([])).toEqual({ keep: [], defer: [] });
  });

  it('keeps a single-user batch entirely', () => {
    const batch = [
      row({ id: 'm1' }),
      row({ id: 'm2' }),
      row({ id: 'm3' }),
    ];
    const { keep, defer } = splitBatchByTurn(batch);
    expect(keep.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(defer).toHaveLength(0);
  });

  it('defers rows from a different user (Bob) when Alice anchors the batch', () => {
    const alice = row({ id: 'alice-1', content: JSON.stringify({ senderId: 'feishu:ou_alice' }) });
    const bob = row({ id: 'bob-1', content: JSON.stringify({ senderId: 'feishu:ou_bob' }) });
    const { keep, defer } = splitBatchByTurn([alice, bob]);
    expect(keep.map((m) => m.id)).toEqual(['alice-1']);
    expect(defer.map((m) => m.id)).toEqual(['bob-1']);
  });

  it('defers same-user messages on a different thread', () => {
    const aliceT1 = row({ id: 'a-t1', thread_id: 'thread-1' });
    const aliceT2 = row({ id: 'a-t2', thread_id: 'thread-2' });
    const { keep, defer } = splitBatchByTurn([aliceT1, aliceT2]);
    expect(keep.map((m) => m.id)).toEqual(['a-t1']);
    expect(defer.map((m) => m.id)).toEqual(['a-t2']);
  });

  it('defers same-user messages on a different chat (group vs DM)', () => {
    const aliceGroup = row({ id: 'a-group', platform_id: 'feishu:oc_group_A' });
    const aliceDM = row({ id: 'a-dm', platform_id: 'feishu:p2p:ou_alice' });
    const { keep, defer } = splitBatchByTurn([aliceGroup, aliceDM]);
    expect(keep.map((m) => m.id)).toEqual(['a-group']);
    expect(defer.map((m) => m.id)).toEqual(['a-dm']);
  });

  it('keeps non-chat rows with the anchor (tasks, system, webhook)', () => {
    const alice = row({ id: 'alice-1' });
    const task = row({ id: 't-1', kind: 'task', content: '{}' });
    const sys = row({ id: 's-1', kind: 'system', content: '{}' });
    const { keep, defer } = splitBatchByTurn([alice, task, sys]);
    expect(keep.map((m) => m.id)).toEqual(['alice-1', 't-1', 's-1']);
    expect(defer).toHaveLength(0);
  });

  it('keeps everything together when anchor identity is agent-asserted', () => {
    // No senderId / no origin_user_id — resolveBatchIdentity will mark
    // this as agent-asserted. The split rule is opt-out when the anchor
    // isn't trusted, to avoid splitting on noisy data.
    const anonymous1 = row({ id: 'a', content: '{}' });
    const anonymous2 = row({ id: 'b', content: '{}', platform_id: 'feishu:other' });
    const { keep, defer } = splitBatchByTurn([anonymous1, anonymous2]);
    expect(keep.map((m) => m.id)).toEqual(['a', 'b']);
    expect(defer).toHaveLength(0);
  });

  it('preserves origin_user_id priority over content.senderId when splitting', () => {
    // a2a delivery case: anchor came via a2a with origin_user_id='alice',
    // a second a2a follow-up came with origin_user_id='bob'. Must split.
    const aliceA2a = row({ id: 'a', origin_user_id: 'feishu:ou_alice', content: '{}' });
    const bobA2a = row({ id: 'b', origin_user_id: 'feishu:ou_bob', content: '{}' });
    const { keep, defer } = splitBatchByTurn([aliceA2a, bobA2a]);
    expect(keep.map((m) => m.id)).toEqual(['a']);
    expect(defer.map((m) => m.id)).toEqual(['b']);
  });
});

describe('splitBatchByTrigger', () => {
  it('keeps accumulated context with the first trigger and defers the next trigger', () => {
    const context = row({ id: 'context', trigger: 0 });
    const first = row({ id: 'first', trigger: 1 });
    const between = row({ id: 'between', trigger: 0 });
    const second = row({ id: 'second', trigger: 1 });
    const split = splitBatchByTrigger([context, first, between, second]);
    expect(split.keep.map((m) => m.id)).toEqual(['context', 'first', 'between']);
    expect(split.defer.map((m) => m.id)).toEqual(['second']);
  });

  it('separates same-user consecutive user triggers', () => {
    const first = row({ id: 'first', trigger: 1 });
    const second = row({ id: 'second', trigger: 1 });
    const split = splitBatchByTrigger([first, second]);
    expect(split.keep.map((m) => m.id)).toEqual(['first']);
    expect(split.defer.map((m) => m.id)).toEqual(['second']);
  });
});
