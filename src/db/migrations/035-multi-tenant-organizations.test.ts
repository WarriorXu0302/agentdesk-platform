import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migration035 } from './035-multi-tenant-organizations.js';

/**
 * Backfill (ADR-0052 Stage A, sub-decision #3): simulate a brownfield UPGRADE —
 * a populated pre-035 DB — and assert the migration enrolls everyone reachable
 * so nobody is locked out, while global roles stay org-NULL.
 */
function preMigrationDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, kind TEXT, display_name TEXT, created_at TEXT);
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT, folder TEXT, agent_provider TEXT, created_at TEXT);
    CREATE TABLE agent_group_members (
      user_id TEXT, agent_group_id TEXT, added_by TEXT, added_at TEXT,
      PRIMARY KEY (user_id, agent_group_id)
    );
    CREATE TABLE user_roles (
      user_id TEXT, role TEXT, agent_group_id TEXT, granted_by TEXT, granted_at TEXT,
      PRIMARY KEY (user_id, role, agent_group_id)
    );
  `);
  return db;
}

describe('migration 035 backfill (ADR-0052)', () => {
  it('enrolls every reachable user into org-default and inherits group-scoped role orgs', () => {
    const db = preMigrationDb();
    const t = '2026-06-16T00:00:00.000Z';
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('u-owner', 'tg', null, t);
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('u-member', 'tg', null, t);
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('u-sadmin', 'tg', null, t);
    db.prepare('INSERT INTO agent_groups VALUES (?,?,?,?,?)').run('ag-1', 'A1', 'a1', null, t);
    db.prepare('INSERT INTO agent_group_members VALUES (?,?,?,?)').run('u-member', 'ag-1', null, t);
    db.prepare('INSERT INTO user_roles VALUES (?,?,?,?,?)').run('u-owner', 'owner', null, null, t);
    db.prepare('INSERT INTO user_roles VALUES (?,?,?,?,?)').run('u-sadmin', 'admin', 'ag-1', null, t);

    migration035.up(db);

    // org-default materialized; agent group backfilled to it
    expect(db.prepare('SELECT slug FROM organizations').get()).toEqual({ slug: 'default' });
    expect(db.prepare('SELECT organization_id FROM agent_groups WHERE id=?').get('ag-1')).toEqual({
      organization_id: 'org-default',
    });

    // every reachable user (member + role-holders) enrolled — nobody locked out
    const members = (
      db.prepare('SELECT user_id FROM organization_members WHERE organization_id=?').all('org-default') as Array<{
        user_id: string;
      }>
    )
      .map((r) => r.user_id)
      .sort();
    expect(members).toEqual(['u-member', 'u-owner', 'u-sadmin']);

    // group-scoped role inherits its group's org; the GLOBAL owner stays org-NULL
    expect(db.prepare("SELECT organization_id FROM user_roles WHERE user_id='u-sadmin'").get()).toEqual({
      organization_id: 'org-default',
    });
    expect(db.prepare("SELECT organization_id FROM user_roles WHERE user_id='u-owner'").get()).toEqual({
      organization_id: null,
    });
  });

  it('is idempotent and a no-op on an empty deployment (no default org materialized)', () => {
    const empty = preMigrationDb();
    migration035.up(empty);
    expect(empty.prepare('SELECT COUNT(*) AS n FROM organizations').get()).toEqual({ n: 0 });

    const populated = preMigrationDb();
    const t = '2026-06-16T00:00:00.000Z';
    populated.prepare('INSERT INTO agent_groups VALUES (?,?,?,?,?)').run('ag-1', 'A1', 'a1', null, t);
    migration035.up(populated);
    // re-running must not duplicate the org or re-orphan the backfill
    migration035.up(populated);
    expect(populated.prepare('SELECT COUNT(*) AS n FROM organizations').get()).toEqual({ n: 1 });
    expect(populated.prepare('SELECT organization_id FROM agent_groups WHERE id=?').get('ag-1')).toEqual({
      organization_id: 'org-default',
    });
  });
});
