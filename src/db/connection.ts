import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

export function initDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  // Give writers a retry window instead of an immediate SQLITE_BUSY when a
  // concurrent writer holds the lock (online backup `.backup`, a maintenance
  // script, or a WAL checkpoint). The per-session DBs already set this (see
  // session-db.ts); the central DB was missing it. 5s matches that convention.
  _db.pragma('busy_timeout = 5000');
  // Durability boundary (documented in docs/db-central.md / RUNBOOK): WAL +
  // synchronous=NORMAL is the default — durable across an app/process crash,
  // but the last committed transactions can be lost on host POWER loss. That is
  // an accepted trade for the single-host target; set it explicitly so the
  // boundary is visible. Operators needing stronger audit durability can raise
  // it via the env override below.
  _db.pragma(`synchronous = ${process.env.AGENTDESK_DB_SYNCHRONOUS === 'FULL' ? 'FULL' : 'NORMAL'}`);
  log.info('Central DB initialized', { path: dbPath });
  return _db;
}

/** For tests only — creates an in-memory DB and runs migrations. */
export function initTestDb(): Database.Database {
  _db = new Database(':memory:');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

/**
 * Check whether a table exists. Used by core code that touches
 * module-owned tables so that an uninstalled module degrades silently
 * instead of raising SQLite errors. Cheap: a single indexed lookup on
 * sqlite_master. Results are not cached — a module install adds the
 * table at runtime (next service start), and callers may run before
 * or after that boundary.
 */
export function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`).get(name) as
    | { '1': number }
    | undefined;
  return row !== undefined;
}
