/**
 * Compliance audit export (roadmap 5.4).
 *
 * Produces a DETERMINISTIC, optionally HMAC-SHA256-SIGNED snapshot of the
 * append-only audit tables (gateway_audit, enterprise_audit, dm_audit) over a
 * time window, so an auditor can pull a tamper-evident bundle ("who did what,
 * when") instead of hand-querying SQLite. Deterministic serialization (rows
 * ordered by occurred_at,id; object keys sorted) is what makes the signature
 * reproducible/verifiable. Read-only — never mutates the audit tables.
 *
 * The signing key comes from `AGENTDESK_AUDIT_EXPORT_KEY` (or an explicit arg).
 * Without it the export is still produced but UNSIGNED (the caller is warned),
 * so a misconfigured deploy gets data rather than a hard failure.
 */
import crypto from 'crypto';

import { getDb, hasTable } from './connection.js';

export const AUDIT_TABLES = ['gateway_audit', 'enterprise_audit', 'dm_audit'] as const;
export type AuditTable = (typeof AUDIT_TABLES)[number];

export interface AuditExport {
  generatedFor: { since: string | null; until: string | null; tables: string[] };
  rowCounts: Record<string, number>;
  rows: Record<string, Array<Record<string, unknown>>>;
}

export interface SignedAuditExport {
  payload: string; // canonical JSON of an AuditExport — sign/verify over THIS exact string
  algorithm: 'HMAC-SHA256' | 'none';
  signature: string | null;
  signed: boolean;
  rowCounts: Record<string, number>;
}

export interface AuditExportOptions {
  since?: string | null; // inclusive lower bound on occurred_at (ISO/SQLite string)
  until?: string | null; // inclusive upper bound
  tables?: AuditTable[];
  signingKey?: string | null;
}

/** Collect audit rows in [since, until] from the requested tables, deterministically ordered. */
export function buildAuditExport(opts: AuditExportOptions = {}): AuditExport {
  const since = opts.since ?? null;
  const until = opts.until ?? null;
  const requested = opts.tables && opts.tables.length ? opts.tables : [...AUDIT_TABLES];
  const tables = requested.filter((t): t is AuditTable => (AUDIT_TABLES as readonly string[]).includes(t));
  const db = getDb();
  const rows: Record<string, Array<Record<string, unknown>>> = {};
  const rowCounts: Record<string, number> = {};
  for (const t of tables) {
    if (!hasTable(db, t)) {
      rows[t] = [];
      rowCounts[t] = 0;
      continue;
    }
    const conds: string[] = [];
    const params: string[] = [];
    if (since) {
      conds.push('occurred_at >= ?');
      params.push(since);
    }
    if (until) {
      conds.push('occurred_at <= ?');
      params.push(until);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    // Stable order: occurred_at then the autoincrement id (tie-break).
    const r = db.prepare(`SELECT * FROM ${t} ${where} ORDER BY occurred_at ASC, id ASC`).all(...params) as Array<
      Record<string, unknown>
    >;
    rows[t] = r;
    rowCounts[t] = r.length;
  }
  return { generatedFor: { since, until, tables }, rowCounts, rows };
}

/** JSON with recursively sorted object keys → identical bytes for identical data. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = obj[k];
          return acc;
        }, {});
    }
    return val;
  });
}

/**
 * Build the export and (if a key is available) sign it. Verify later by
 * recomputing `HMAC-SHA256(payload)` with the same key and constant-time
 * comparing to `signature`.
 */
export function exportAuditForCompliance(opts: AuditExportOptions = {}): SignedAuditExport {
  const data = buildAuditExport(opts);
  const payload = canonicalJson(data);
  const key = opts.signingKey ?? process.env.AGENTDESK_AUDIT_EXPORT_KEY ?? null;
  const signature = key ? crypto.createHmac('sha256', key).update(payload).digest('hex') : null;
  return {
    payload,
    algorithm: signature ? 'HMAC-SHA256' : 'none',
    signature,
    signed: signature != null,
    rowCounts: data.rowCounts,
  };
}
