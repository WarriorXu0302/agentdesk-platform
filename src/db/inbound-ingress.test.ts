import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from './index.js';
import {
  countIngressByStatus,
  deleteIngress,
  getIngress,
  insertIngress,
  listIngress,
  markIngressFailed,
} from './inbound-ingress.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

function insert(channel = 'feishu'): string {
  return insertIngress({
    channelType: channel,
    platformId: `${channel}:chat-1`,
    threadId: null,
    messageJson: JSON.stringify({ channelType: channel, platformId: `${channel}:chat-1`, threadId: null }),
  });
}

describe('inbound-ingress ledger', () => {
  it('inserts a row at status=received with a synthetic uuid id (not an event id)', () => {
    const id = insert();
    const row = getIngress(id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('received');
    expect(row!.attempts).toBe(0);
    expect(row!.last_error).toBeNull();
    // synthetic uuid, not a channel event id
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('deleteIngress removes the row (success/ignore path)', () => {
    const id = insert();
    deleteIngress(id);
    expect(getIngress(id)).toBeUndefined();
  });

  it('markIngressFailed flips status, bumps attempts, records error', () => {
    const id = insert();
    markIngressFailed(id, 'SqliteError: SQLITE_BUSY');
    const row = getIngress(id)!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('SqliteError: SQLITE_BUSY');

    markIngressFailed(id, 'second attempt');
    expect(getIngress(id)!.attempts).toBe(2);
  });

  it('truncates pathologically long error strings', () => {
    const id = insert();
    markIngressFailed(id, 'x'.repeat(5000));
    expect(getIngress(id)!.last_error!.length).toBe(2000);
  });

  it('listIngress filters by status and counts by status', () => {
    const a = insert('feishu');
    insert('discord');
    markIngressFailed(a, 'boom');

    expect(listIngress({ status: 'failed' }).map((r) => r.id)).toEqual([a]);
    expect(listIngress({ status: 'received' })).toHaveLength(1);
    expect(listIngress()).toHaveLength(2);

    expect(countIngressByStatus()).toEqual({ received: 1, failed: 1 });
  });

  it('migration is idempotent on an already-migrated DB', () => {
    // runMigrations already ran in beforeEach; re-running against the same live
    // connection must be a no-op and must not lose existing rows.
    const id = insert();
    runMigrations(getDb());
    expect(getIngress(id)).toBeDefined();
    // CREATE TABLE IF NOT EXISTS guards make a fresh re-apply harmless too.
    expect(() => runMigrations(getDb())).not.toThrow();
  });
});
