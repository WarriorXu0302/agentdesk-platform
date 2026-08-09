import crypto from 'crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAuditExport, exportAuditForCompliance } from './audit-export.js';
import { recordEnterpriseAudit } from './enterprise-audit.js';
import { closeDb, initTestDb, runMigrations } from './index.js';

beforeEach(() => {
  runMigrations(initTestDb());
});
afterEach(() => closeDb());

const WIN = { since: '2026-06-01T00:00:00.000Z', until: '2026-06-30T00:00:00.000Z' };

describe('exportAuditForCompliance (roadmap 5.4)', () => {
  it('exports only in-window rows, signs deterministically, and the signature verifies', () => {
    recordEnterpriseAudit(
      { eventType: 'user_role_granted', actor: 'u1', details: { x: 1 } },
      new Date('2026-06-10T00:00:00Z'),
    );
    recordEnterpriseAudit(
      { eventType: 'approval_resolved', actor: 'u2', details: { y: 2 } },
      new Date('2026-06-12T00:00:00Z'),
    );
    recordEnterpriseAudit({ eventType: 'too_old', actor: 'u3' }, new Date('2026-01-01T00:00:00Z'));

    const out = exportAuditForCompliance({ ...WIN, signingKey: 'secret' });
    expect(out.signed).toBe(true);
    expect(out.algorithm).toBe('HMAC-SHA256');
    expect(out.rowCounts.enterprise_audit).toBe(2); // too_old excluded by the window

    // The signature is HMAC-SHA256 over the exact payload string (verifiable).
    expect(out.signature).toBe(crypto.createHmac('sha256', 'secret').update(out.payload).digest('hex'));

    // Deterministic: identical data + key → identical signature across runs.
    const again = exportAuditForCompliance({ ...WIN, signingKey: 'secret' });
    expect(again.signature).toBe(out.signature);
  });

  it('produces an UNSIGNED export when no key is configured', () => {
    recordEnterpriseAudit({ eventType: 'e', actor: null });
    const out = exportAuditForCompliance({ signingKey: null });
    expect(out.signed).toBe(false);
    expect(out.algorithm).toBe('none');
    expect(out.signature).toBeNull();
    expect(out.rowCounts.enterprise_audit).toBe(1);
  });

  it('can target a subset of audit tables', () => {
    recordEnterpriseAudit({ eventType: 'e' });
    const out = exportAuditForCompliance({ tables: ['enterprise_audit'] });
    expect(Object.keys((JSON.parse(out.payload) as { rows: Record<string, unknown> }).rows)).toEqual([
      'enterprise_audit',
    ]);
  });
});

describe('audit export input validation', () => {
  it('rejects an unknown table instead of signing an empty bundle', () => {
    // Regression: unknown names were filtered out, so a typo like the
    // hyphenated spelling used in migration filenames / doc prose produced a
    // signed bundle attesting ZERO audit activity for the window — a
    // cryptographically valid false negative handed to an auditor.
    expect(() => buildAuditExport({ tables: ['gateway-audit' as never] })).toThrow(/unknown audit table/);
    expect(() => buildAuditExport({ tables: ['gateway_audit', 'nope' as never] })).toThrow(/nope/);
  });

  it('still accepts the real table names', () => {
    const out = buildAuditExport({ tables: ['gateway_audit'] });
    expect(out.generatedFor.tables).toEqual(['gateway_audit']);
  });
});
