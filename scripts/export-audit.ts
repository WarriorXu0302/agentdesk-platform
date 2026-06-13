/**
 * scripts/export-audit.ts — compliance audit export (roadmap 5.4).
 *
 * Pulls a DETERMINISTIC, optionally HMAC-SHA256-SIGNED snapshot of the
 * append-only audit tables (gateway_audit, enterprise_audit, dm_audit) over a
 * time window — the bundle an auditor takes for "who did what, when" without
 * hand-querying SQLite. Read-only; never mutates the audit tables.
 *
 * Usage:
 *   pnpm exec tsx scripts/export-audit.ts                                  # everything, to stdout
 *   pnpm exec tsx scripts/export-audit.ts --since 2026-06-01T00:00:00Z --until 2026-07-01T00:00:00Z
 *   pnpm exec tsx scripts/export-audit.ts --tables enterprise_audit,gateway_audit --out audit.json
 *
 * Set AGENTDESK_AUDIT_EXPORT_KEY to sign the bundle. Verify later with:
 *   HMAC-SHA256(<payload string>, key) === <signature>   (constant-time compare)
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { exportAuditForCompliance, type AuditTable } from '../src/db/audit-export.js';
import { initDb } from '../src/db/connection.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    'Usage: pnpm exec tsx scripts/export-audit.ts [--since ISO] [--until ISO] [--tables a,b] [--out file]\n' +
      'Set AGENTDESK_AUDIT_EXPORT_KEY to HMAC-SHA256-sign the bundle (tamper-evidence).\n',
  );
  process.exit(0);
}

initDb(path.join(DATA_DIR, 'v2.db'));

const since = arg('--since') ?? null;
const until = arg('--until') ?? null;
const tablesArg = arg('--tables');
const tables = tablesArg ? (tablesArg.split(',').map((t) => t.trim()) as AuditTable[]) : undefined;
const out = arg('--out');

const result = exportAuditForCompliance({ since, until, tables });
const bundle = JSON.stringify(result, null, 2);

if (out) {
  fs.writeFileSync(out, bundle);
  console.error(`Wrote ${out} — rows=${JSON.stringify(result.rowCounts)}, signed=${result.signed}`);
} else {
  process.stdout.write(bundle + '\n');
}
if (!result.signed) {
  console.error('WARNING: AGENTDESK_AUDIT_EXPORT_KEY not set — export is UNSIGNED (no tamper-evidence).');
}
