import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './index.js';
import { markInboundSeen, pruneInboundDedup } from './inbound-dedup.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('markInboundSeen', () => {
  it('returns true on first insert, false on subsequent calls', () => {
    expect(markInboundSeen('feishu', 'evt-1')).toBe(true);
    expect(markInboundSeen('feishu', 'evt-1')).toBe(false);
  });

  it('scopes dedup by channel', () => {
    expect(markInboundSeen('feishu', 'evt-1')).toBe(true);
    expect(markInboundSeen('slack', 'evt-1')).toBe(true);
  });

  it('ignores empty event ids', () => {
    expect(markInboundSeen('feishu', '   ')).toBe(true);
    expect(markInboundSeen('feishu', '')).toBe(true);
  });
});

describe('pruneInboundDedup', () => {
  it('removes rows older than the cutoff', () => {
    const old = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-02T00:00:00Z');
    markInboundSeen('feishu', 'old', old);
    markInboundSeen('feishu', 'new', now);

    const removed = pruneInboundDedup(60 * 60_000, now);
    expect(removed).toBe(1);

    expect(markInboundSeen('feishu', 'old', now)).toBe(true);
    expect(markInboundSeen('feishu', 'new', now)).toBe(false);
  });
});
