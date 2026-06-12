import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * RUNBOOK ↔ schema drift guard.
 *
 * docs/RUNBOOK.md hands operators copy-paste SQL against the central DB and
 * the per-session inbound/outbound DBs. When a column gets renamed in a
 * migration but the RUNBOOK keeps the old name, every one of those queries
 * silently fails at 3am. This test pins the (table, column) pairs the RUNBOOK
 * actually references and asserts each one exists in the real schema source.
 *
 * The schema is split across two sources, both of which we parse:
 *   - src/db/schema.ts        — core central tables + session inbound/outbound
 *   - src/db/migrations/*.ts  — audit/dedup tables and later ALTER ADD COLUMN
 *
 * If you add a new RUNBOOK query touching a new column, add the pair here.
 * If a column legitimately gets renamed, this test fails until both the
 * migration set and the RUNBOOK agree again — which is the point.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'src', 'db', 'schema.ts');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'src', 'db', 'migrations');
const RUNBOOK_PATH = path.join(REPO_ROOT, 'docs', 'RUNBOOK.md');

/**
 * (table, column) pairs that copy-paste SQL in RUNBOOK depends on. Keyed by
 * table; each column here appears in at least one RUNBOOK query. Grouped by
 * the section that uses them so a future editor can find the source query.
 */
const RUNBOOK_COLUMN_REFERENCES: Record<string, string[]> = {
  // §3.1 / §7.1 — inbound arrival check
  inbound_dedup: ['channel', 'event_id', 'seen_at'],
  // §3.1 / §3.4 / §3.6 / §7.1 — session lookup + lifecycle
  sessions: ['id', 'agent_group_id', 'owner_user_id', 'last_active', 'status'],
  // §3.1 / §7.1 — per-session inbound rows
  messages_in: ['id', 'status', 'kind', 'tries', 'timestamp', 'origin_user_id', 'content'],
  // §3.1 / §7.1 — per-session outbound rows (no status column; delivery state
  // lives in the host-owned `delivered` table)
  messages_out: ['id', 'kind', 'in_reply_to', 'timestamp'],
  // §3.1 decision tree — delivery outcome is host-tracked here, not in messages_out
  delivered: ['message_out_id', 'status'],
  // §3.3 / §7.1 — classification log
  classification_log: [
    'occurred_at',
    'session_id',
    'classification_id',
    'action',
    'recommended_worker',
    'confidence',
    'outcome_ref',
  ],
  // §3.5 / §5.2 / §7.1 / §7.2 — gateway audit
  gateway_audit: [
    'occurred_at',
    'user_id',
    'operation',
    'requester_source',
    'status',
    'http_status',
    'duration_ms',
    'input_hash',
  ],
};

/**
 * Columns the RUNBOOK was historically WRONG about (renamed away in a
 * migration). If any of these reappear in a RUNBOOK SQL block, the doc has
 * regressed to the pre-fix names. Keyed by the correct column it was confused
 * with, so the failure message is actionable.
 */
const RUNBOOK_FORBIDDEN_COLUMN_TOKENS: Array<{ token: string; correct: string }> = [
  { token: 'last_active_at', correct: 'sessions.last_active' },
  // `created_at` is a real column on several core tables (sessions, users,
  // etc.), so we cannot blanket-ban it. The drift was specifically using it on
  // tables that key on occurred_at/seen_at/timestamp; that is covered by the
  // positive (table, column) assertions above plus the table-scoped check below.
];

function parseColumnsFromCreateBlocks(sql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  // Match: CREATE TABLE [IF NOT EXISTS] <name> ( ... );
  const createRe = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/g;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql)) !== null) {
    const tableName = m[1];
    const body = m[2];
    const cols = tables.get(tableName) ?? new Set<string>();
    for (const rawLine of body.split('\n')) {
      // Strip trailing line comments and surrounding whitespace.
      const line = rawLine.replace(/--.*$/, '').trim();
      if (!line) continue;
      // Skip table-level constraints / indexes embedded in the body.
      if (/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|CONSTRAINT|CREATE INDEX)\b/i.test(line)) continue;
      const colMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\b/.exec(line);
      if (!colMatch) continue;
      // First token of a column definition is the column name.
      const candidate = colMatch[1];
      if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)$/i.test(candidate)) continue;
      cols.add(candidate);
    }
    tables.set(tableName, cols);
  }
  return tables;
}

function parseAlterAddColumns(sql: string): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = [];
  const alterRe =
    /ALTER TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = alterRe.exec(sql)) !== null) {
    out.push({ table: m[1], column: m[2] });
  }
  return out;
}

/** Build the authoritative table → columns map from schema.ts + all migrations. */
function buildSchemaColumnMap(): Map<string, Set<string>> {
  const sources: string[] = [fs.readFileSync(SCHEMA_PATH, 'utf8')];
  for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    sources.push(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }

  const tables = new Map<string, Set<string>>();
  for (const sql of sources) {
    for (const [table, cols] of parseColumnsFromCreateBlocks(sql)) {
      const merged = tables.get(table) ?? new Set<string>();
      for (const c of cols) merged.add(c);
      tables.set(table, merged);
    }
    for (const { table, column } of parseAlterAddColumns(sql)) {
      const merged = tables.get(table) ?? new Set<string>();
      merged.add(column);
      tables.set(table, merged);
    }
  }
  return tables;
}

/** Extract the bodies of every ```...``` fenced block in the RUNBOOK. */
function runbookCodeBlocks(): string {
  const md = fs.readFileSync(RUNBOOK_PATH, 'utf8');
  const blocks: string[] = [];
  const fenceRe = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(md)) !== null) {
    blocks.push(m[1]);
  }
  return blocks.join('\n');
}

describe('RUNBOOK ↔ schema consistency', () => {
  const schema = buildSchemaColumnMap();

  it('parses the schema sources into a non-trivial table map', () => {
    // Sanity: the parser actually found the core + audit tables.
    expect(schema.has('sessions')).toBe(true);
    expect(schema.has('messages_in')).toBe(true);
    expect(schema.has('gateway_audit')).toBe(true);
    expect(schema.has('classification_log')).toBe(true);
    expect(schema.has('inbound_dedup')).toBe(true);
  });

  it('every RUNBOOK-referenced column exists in the real schema', () => {
    const missing: string[] = [];
    for (const [table, columns] of Object.entries(RUNBOOK_COLUMN_REFERENCES)) {
      const known = schema.get(table);
      if (!known) {
        missing.push(`${table}.* (table not found in schema source)`);
        continue;
      }
      for (const column of columns) {
        if (!known.has(column)) missing.push(`${table}.${column}`);
      }
    }
    expect(missing, `RUNBOOK references columns absent from schema: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('the classification_log columns the RUNBOOK queries were added by migration 024', () => {
    // Guards the specific drift this test was written for: classification_id
    // and the identity-context columns only exist after migration 024, not in
    // the original 023 DDL. If a future refactor drops the ALTER parsing, these
    // would silently vanish from the map.
    const cols = schema.get('classification_log');
    expect(cols?.has('classification_id')).toBe(true);
    expect(cols?.has('channel_type')).toBe(true);
  });

  it('does not reintroduce the historical wrong column names', () => {
    const code = runbookCodeBlocks();
    const offenders: string[] = [];
    for (const { token, correct } of RUNBOOK_FORBIDDEN_COLUMN_TOKENS) {
      // Word-boundary match so e.g. `last_active` does not trip `last_active_at`.
      const re = new RegExp(`\\b${token}\\b`);
      if (re.test(code)) offenders.push(`${token} (use ${correct})`);
    }
    expect(offenders, `RUNBOOK uses renamed-away columns: ${offenders.join(', ')}`).toHaveLength(0);
  });

  it('does not query created_at on tables that key on a different timestamp column', () => {
    // inbound_dedup→seen_at, gateway_audit/classification_log→occurred_at,
    // messages_in/messages_out→timestamp. None of these have a created_at
    // column; a created_at reference inside a SQL block touching them is drift.
    const code = runbookCodeBlocks();
    const timestampOnlyTables = ['inbound_dedup', 'gateway_audit', 'classification_log', 'messages_out', 'messages_in'];
    for (const table of timestampOnlyTables) {
      const known = schema.get(table);
      // Precondition: confirm these really lack created_at, so the check below
      // is meaningful rather than vacuously true.
      expect(known?.has('created_at'), `${table} unexpectedly has created_at`).toBeFalsy();
    }

    // Find SQL blocks (lines mentioning a timestamp-only table) that also use
    // created_at on the same statement region.
    const offenders: string[] = [];
    for (const block of [code]) {
      for (const table of timestampOnlyTables) {
        // crude statement window: from the table name to the next blank line.
        const tableIdx = block.indexOf(table);
        if (tableIdx === -1) continue;
        // Scan every occurrence.
        let idx = tableIdx;
        while (idx !== -1) {
          const window = block.slice(idx, idx + 400);
          if (/\bcreated_at\b/.test(window)) {
            offenders.push(`${table}: created_at appears near a query on this table`);
          }
          idx = block.indexOf(table, idx + table.length);
        }
      }
    }
    expect(offenders, offenders.join('; ')).toHaveLength(0);
  });
});
