import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './connection.js';
import { purgeClassificationLog, recordClassification } from './classification-log.js';
import { purgeDmAudit, recordDmAudit } from './dm-audit.js';
import { purgeEnterpriseAudit, recordEnterpriseAudit } from './enterprise-audit.js';
import { closeDb, initTestDb, runMigrations } from './index.js';

beforeEach(() => {
  runMigrations(initTestDb());
});
afterEach(() => closeDb());

const OLD = new Date('2020-01-01T00:00:00.000Z');
const RECENT = new Date();
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

function count(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

// Smoke test the opt-in retention purges. The real value: a table-name typo in
// any purge would silently delete nothing — these catch that, and pin "only
// rows older than the cutoff are deleted".
describe('audit retention purge (opt-in, AGENTDESK_AUDIT_RETAIN_DAYS)', () => {
  it('purgeClassificationLog deletes only rows older than the cutoff', () => {
    recordClassification({ action: 'answer_self' }, OLD);
    recordClassification({ action: 'answer_self' }, RECENT);
    expect(purgeClassificationLog(THIRTY_DAYS_MS)).toBe(1);
    expect(count('classification_log')).toBe(1);
  });

  it('purgeEnterpriseAudit deletes only rows older than the cutoff', () => {
    recordEnterpriseAudit({ eventType: 'group.created' }, OLD);
    recordEnterpriseAudit({ eventType: 'group.created' }, RECENT);
    expect(purgeEnterpriseAudit(THIRTY_DAYS_MS)).toBe(1);
    expect(count('enterprise_audit')).toBe(1);
  });

  it('purgeDmAudit deletes only rows older than the cutoff', () => {
    recordDmAudit({ scopeId: 's1', decision: 'rejected', reason: 'test' }, OLD);
    recordDmAudit({ scopeId: 's1', decision: 'delivered' }, RECENT);
    expect(purgeDmAudit(THIRTY_DAYS_MS)).toBe(1);
    expect(count('dm_audit')).toBe(1);
  });
});
