import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectLegitimateOrigins, resolveOriginUserId } from './origin-user.js';
import { INBOUND_SCHEMA } from '../../db/schema.js';

/**
 * Direct unit coverage of the trusted-identity helpers. These read a
 * host-written inbound.db (in-memory here) and must derive the same
 * namespaced `<channel>:<id>` form used by the host at delivery time.
 */
let db: Database.Database;
let seq = 0;

function insertChat(row: {
  kind?: string;
  channel_type: string | null;
  content: string;
  origin_user_id?: string | null;
}): void {
  seq += 2;
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, channel_type, content, series_id, origin_user_id)
     VALUES (@id, @seq, @kind, datetime('now'), 'pending', @channel_type, @content, @id, @origin_user_id)`,
  ).run({
    id: `m-${seq}`,
    seq,
    kind: row.kind ?? 'chat',
    channel_type: row.channel_type,
    content: row.content,
    origin_user_id: row.origin_user_id ?? null,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(INBOUND_SCHEMA);
  seq = 0;
});

afterEach(() => {
  db.close();
});

describe('collectLegitimateOrigins', () => {
  it('returns the empty set when there are no chat rows', () => {
    expect(collectLegitimateOrigins(db).size).toBe(0);
  });

  it('namespaces bare senderIds with the row channel_type', () => {
    insertChat({ channel_type: 'feishu', content: JSON.stringify({ senderId: 'ou_alice' }) });
    insertChat({ channel_type: 'slack', content: JSON.stringify({ senderId: 'U123' }) });
    expect(collectLegitimateOrigins(db)).toEqual(new Set(['feishu:ou_alice', 'slack:U123']));
  });

  it('includes propagated origin_user_id from prior a2a hops', () => {
    insertChat({
      kind: 'chat',
      channel_type: 'agent',
      content: JSON.stringify({ text: 'delegated' }),
      origin_user_id: 'feishu:ou_employee',
    });
    expect(collectLegitimateOrigins(db)).toEqual(new Set(['feishu:ou_employee']));
  });

  it('takes an already-namespaced senderId verbatim', () => {
    insertChat({ channel_type: 'feishu', content: JSON.stringify({ senderId: 'feishu:ou_bob' }) });
    expect(collectLegitimateOrigins(db)).toEqual(new Set(['feishu:ou_bob']));
  });

  it('IGNORES content.senderId on agent rows — a2a identity is the origin_user_id column only (ADR-0017)', () => {
    // A prompt-injected container can forge content.senderId on its outbound
    // row; the host forwards content verbatim. If we derived identity from it,
    // the fabricated victim id would enter the legitimate set and defeat the
    // next-hop cross-validation. Agent rows with no origin_user_id contribute
    // nothing.
    insertChat({
      channel_type: 'agent',
      content: JSON.stringify({ text: 'delegated', senderId: 'feishu:ou_victim' }),
      origin_user_id: null,
    });
    expect(collectLegitimateOrigins(db).size).toBe(0);
  });

  it('skips synthetic system-sender rows', () => {
    insertChat({ channel_type: 'feishu', content: JSON.stringify({ sender: 'system', senderId: 'system' }) });
    expect(collectLegitimateOrigins(db).size).toBe(0);
  });

  it('covers chat-sdk rows and skips rows with no resolvable identity', () => {
    insertChat({ kind: 'chat-sdk', channel_type: 'cli', content: JSON.stringify({ senderId: 'dev' }) });
    insertChat({ channel_type: 'feishu', content: JSON.stringify({ text: 'no sender here' }) });
    insertChat({ channel_type: 'feishu', content: 'not json at all' });
    expect(collectLegitimateOrigins(db)).toEqual(new Set(['cli:dev']));
  });

  it('agrees with resolveOriginUserId for the most-recent row', () => {
    insertChat({ channel_type: 'feishu', content: JSON.stringify({ senderId: 'ou_alice' }) });
    insertChat({ channel_type: 'feishu', content: JSON.stringify({ senderId: 'ou_bob' }) });
    // resolveOriginUserId picks the newest; collect returns both.
    expect(resolveOriginUserId(db)).toBe('feishu:ou_bob');
    expect(collectLegitimateOrigins(db).has('feishu:ou_bob')).toBe(true);
    expect(collectLegitimateOrigins(db).has('feishu:ou_alice')).toBe(true);
  });
});
