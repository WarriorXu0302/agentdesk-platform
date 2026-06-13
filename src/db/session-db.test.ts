/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  getDeliveryAttempts,
  getInboundSourceSessionId,
  getUndeliverableIds,
  listFailedInbound,
  markDelivered,
  markDeliveryFailed,
  markMessageFailed,
  migrateDeliveredTable,
  migrateMessagesInTable,
  requeueFailedDelivery,
  requeueFailedInbound,
} from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });
});

/** Build a fresh DB with the oldest known delivered-table shape. */
function makeLegacyDeliveredDb(): Database.Database {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE delivered (
      message_out_id TEXT PRIMARY KEY,
      delivered_at   TEXT NOT NULL
    );
  `);
  return db;
}

/** Legacy table + migration — what every runtime caller sees (ADR-0016). */
function makeMigratedDeliveredDb(): Database.Database {
  const db = makeLegacyDeliveredDb();
  migrateDeliveredTable(db);
  return db;
}

describe('migrateDeliveredTable', () => {
  it('adds attempts/next_retry_at on a legacy DB with safe defaults, is idempotent', () => {
    const db = makeLegacyDeliveredDb();
    db.prepare("INSERT INTO delivered (message_out_id, delivered_at) VALUES ('pre-existing', datetime('now'))").run();

    migrateDeliveredTable(db);
    migrateDeliveredTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('delivered')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['platform_message_id', 'status', 'attempts', 'next_retry_at']));

    // Pre-migration rows default to delivered / attempts=0 / no retry.
    const row = db
      .prepare("SELECT status, attempts, next_retry_at FROM delivered WHERE message_out_id = 'pre-existing'")
      .get() as { status: string; attempts: number; next_retry_at: string | null };
    expect(row).toEqual({ status: 'delivered', attempts: 0, next_retry_at: null });
    db.close();
  });
});

describe('delivered retry semantics', () => {
  it('getUndeliverableIds excludes only failed rows whose retry window is open', () => {
    const db = makeMigratedDeliveredDb();
    const insert = db.prepare(
      `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at, attempts, next_retry_at)
       VALUES (?, NULL, ?, datetime('now'), ?, ?)`,
    );
    insert.run('ok', 'delivered', 0, null);
    insert.run('failed-due', 'failed', 2, '2020-01-01 00:00:00');
    insert.run('failed-future', 'failed', 2, '2099-01-01 00:00:00');
    insert.run('failed-parked', 'failed', 0, null); // pre-migration / dlq-parked
    insert.run('failed-exhausted', 'failed', 10, '2020-01-01 00:00:00');

    const blocked = getUndeliverableIds(db, 10);
    expect(blocked.has('ok')).toBe(true);
    expect(blocked.has('failed-future')).toBe(true);
    expect(blocked.has('failed-parked')).toBe(true);
    expect(blocked.has('failed-exhausted')).toBe(true);
    expect(blocked.has('failed-due')).toBe(false); // eligible for redelivery
    db.close();
  });

  it('markDeliveryFailed persists attempts + schedules retry; null backoff parks the row', () => {
    const db = makeMigratedDeliveredDb();

    markDeliveryFailed(db, 'msg-1', 1, 60);
    expect(getDeliveryAttempts(db, 'msg-1')).toBe(1);
    let row = db.prepare("SELECT next_retry_at FROM delivered WHERE message_out_id = 'msg-1'").get() as {
      next_retry_at: string | null;
    };
    expect(row.next_retry_at).not.toBeNull();
    expect(getUndeliverableIds(db, 10).has('msg-1')).toBe(true); // +60s window still closed

    // Second failure (retry also failed) — conflict path updates in place.
    markDeliveryFailed(db, 'msg-1', 2, 300);
    expect(getDeliveryAttempts(db, 'msg-1')).toBe(2);

    // Attempts cap reached → no further automatic retry.
    markDeliveryFailed(db, 'msg-1', 10, null);
    row = db.prepare("SELECT next_retry_at FROM delivered WHERE message_out_id = 'msg-1'").get() as {
      next_retry_at: string | null;
    };
    expect(row.next_retry_at).toBeNull();
    expect(getUndeliverableIds(db, 10).has('msg-1')).toBe(true);
    db.close();
  });

  it('markDelivered flips a failed row to delivered but never downgrades a delivered row', () => {
    const db = makeMigratedDeliveredDb();

    markDeliveryFailed(db, 'msg-2', 3, 60);
    markDelivered(db, 'msg-2', 'plat-42');
    const row = db
      .prepare("SELECT status, platform_message_id, attempts FROM delivered WHERE message_out_id = 'msg-2'")
      .get() as { status: string; platform_message_id: string | null; attempts: number };
    expect(row.status).toBe('delivered');
    expect(row.platform_message_id).toBe('plat-42');
    expect(row.attempts).toBe(3); // historical failure count preserved

    // A late failure write (e.g. timed-out attempt whose send actually
    // landed, racing a successful retry) must not downgrade the row.
    markDeliveryFailed(db, 'msg-2', 4, 60);
    const after = db.prepare("SELECT status FROM delivered WHERE message_out_id = 'msg-2'").get() as { status: string };
    expect(after.status).toBe('delivered');
    db.close();
  });

  it('requeueFailedDelivery resets a failed row to immediately-due, only for failed rows', () => {
    const db = makeMigratedDeliveredDb();
    markDeliveryFailed(db, 'msg-3', 10, null); // exhausted + parked
    markDelivered(db, 'msg-4', 'plat-4');

    expect(requeueFailedDelivery(db, 'msg-3')).toBe(true);
    expect(getDeliveryAttempts(db, 'msg-3')).toBe(0);
    expect(getUndeliverableIds(db, 10).has('msg-3')).toBe(false); // due now

    expect(requeueFailedDelivery(db, 'msg-4')).toBe(false); // delivered row untouched
    expect(requeueFailedDelivery(db, 'no-such-row')).toBe(false);
    db.close();
  });
});

describe('inbound dead-letter requeue (status=failed)', () => {
  function freshInboundDb(): Database.Database {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
        status TEXT DEFAULT 'pending', process_after TEXT, tries INTEGER DEFAULT 0,
        origin_user_id TEXT, content TEXT NOT NULL
      );
    `);
    return db;
  }
  function insert(db: Database.Database, id: string, seq: number, status: string, tries = 0): void {
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, content) VALUES (?, ?, 'task', datetime('now'), ?, ?, '{}')",
    ).run(id, seq, status, tries);
  }

  it('listFailedInbound returns only status=failed rows', () => {
    const db = freshInboundDb();
    insert(db, 'ok-1', 1, 'completed');
    insert(db, 'pending-1', 2, 'pending');
    insert(db, 'failed-1', 3, 'failed', 5);
    markMessageFailed(db, 'pending-1'); // now also failed
    const failed = listFailedInbound(db);
    expect(failed.map((r) => r.id).sort()).toEqual(['failed-1', 'pending-1']);
    db.close();
  });

  it('requeueFailedInbound resets a failed row to pending/tries=0 and returns true', () => {
    const db = freshInboundDb();
    insert(db, 'failed-1', 1, 'failed', 5);
    db.prepare("UPDATE messages_in SET process_after = datetime('now','+1 hour') WHERE id = 'failed-1'").run();
    expect(requeueFailedInbound(db, 'failed-1')).toBe(true);
    const row = db.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('failed-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(0);
    expect(row.process_after).toBeNull();
    db.close();
  });

  it('requeueFailedInbound is a no-op on non-failed / missing rows', () => {
    const db = freshInboundDb();
    insert(db, 'pending-1', 1, 'pending');
    expect(requeueFailedInbound(db, 'pending-1')).toBe(false); // not failed
    expect(requeueFailedInbound(db, 'no-such-row')).toBe(false);
    expect((db.prepare("SELECT status FROM messages_in WHERE id='pending-1'").get() as { status: string }).status).toBe(
      'pending',
    );
    db.close();
  });
});
