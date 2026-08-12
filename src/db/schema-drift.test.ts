/**
 * Guard: `SCHEMA` in schema.ts must describe exactly the database the migration
 * chain produces.
 *
 * `SCHEMA` is documentation-by-code — nothing executes it at runtime (the central
 * DB is built solely by runMigrations, see initDb + migration 001), and
 * docs/architecture.md points readers here to understand the schema. That made it
 * silently driftable, and it had drifted badly: 19 tables and 29 indexes behind,
 * missing the entire audit chain (gateway_audit / enterprise_audit), roster DM
 * (dm_grants), approvals, dedup and ingress. Anyone — human or agent —
 * onboarding via this file got a picture that was ~60% complete and wrong in a
 * way nothing would tell them about.
 *
 * This test makes that impossible to repeat: add a migration that changes shape,
 * mirror it here, and this stays green. Columns are compared by
 * name/type/notnull/default/pk and indexes by name + normalized SQL, so
 * formatting is free but shape is not.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './migrations/index.js';
import { SCHEMA } from './schema.js';

function tables(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
      name: string;
    }>
  )
    .map((r) => r.name)
    .sort();
}

function columns(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>
  )
    .map(
      (c) =>
        `${c.name}:${c.type}${c.notnull ? ' NOT NULL' : ''}` +
        `${c.dflt_value != null ? ` DEFAULT=${String(c.dflt_value)}` : ''}${c.pk ? ` PK${c.pk}` : ''}`,
    )
    .sort();
}

function indexes(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
      .all(table) as Array<{ name: string; sql: string }>
  )
    .map((r) => `${r.name} :: ${r.sql.replace(/\s+/g, ' ').trim()}`)
    .sort();
}

const migrated = new Database(':memory:');
runMigrations(migrated);
const documented = new Database(':memory:');
documented.exec(SCHEMA);

describe('schema.ts reference vs the migration chain', () => {
  it('documents exactly the same tables', () => {
    expect(tables(documented)).toEqual(tables(migrated));
  });

  it('documents the same columns in every table', () => {
    const diffs: Record<string, { migratedOnly: string[]; documentedOnly: string[] }> = {};
    for (const t of tables(migrated)) {
      if (!tables(documented).includes(t)) continue;
      const a = columns(migrated, t);
      const b = columns(documented, t);
      const migratedOnly = a.filter((c) => !b.includes(c));
      const documentedOnly = b.filter((c) => !a.includes(c));
      if (migratedOnly.length || documentedOnly.length) diffs[t] = { migratedOnly, documentedOnly };
    }
    expect(diffs).toEqual({});
  });

  it('documents the same indexes in every table', () => {
    const diffs: Record<string, { migratedOnly: string[]; documentedOnly: string[] }> = {};
    for (const t of tables(migrated)) {
      if (!tables(documented).includes(t)) continue;
      const names = (list: string[]): string[] => list.map((s) => s.split(' :: ')[0]!);
      const a = names(indexes(migrated, t));
      const b = names(indexes(documented, t));
      const migratedOnly = a.filter((n) => !b.includes(n));
      const documentedOnly = b.filter((n) => !a.includes(n));
      if (migratedOnly.length || documentedOnly.length) diffs[t] = { migratedOnly, documentedOnly };
    }
    expect(diffs).toEqual({});
  });
});
