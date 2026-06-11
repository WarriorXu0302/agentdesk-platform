import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './index.js';
import { queryGatewayAudit, recordGatewayAudit } from './gateway-audit.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('gateway_audit', () => {
  it('records an entry with all fields', () => {
    recordGatewayAudit({
      sessionId: 's1',
      agentGroupId: 'ag-frontdesk',
      userId: 'feishu:ou_1',
      path: '/execute',
      operation: 'sales.order.create',
      requesterSource: 'session',
      status: 'ok',
      httpStatus: 200,
      durationMs: 123,
      idempotencyKey: 'idem-1',
      inputHash: 'abc123',
    });

    const rows = queryGatewayAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 's1',
      agent_group_id: 'ag-frontdesk',
      user_id: 'feishu:ou_1',
      path: '/execute',
      operation: 'sales.order.create',
      requester_source: 'session',
      status: 'ok',
      http_status: 200,
      duration_ms: 123,
      idempotency_key: 'idem-1',
      input_hash: 'abc123',
      error_msg: null,
    });
  });

  it('filters by userId and operation', () => {
    recordGatewayAudit({ path: '/execute', operation: 'a', requesterSource: 'session', status: 'ok', userId: 'u1' });
    recordGatewayAudit({ path: '/execute', operation: 'b', requesterSource: 'session', status: 'ok', userId: 'u1' });
    recordGatewayAudit({ path: '/execute', operation: 'a', requesterSource: 'session', status: 'ok', userId: 'u2' });

    expect(queryGatewayAudit({ userId: 'u1' })).toHaveLength(2);
    expect(queryGatewayAudit({ operation: 'a' })).toHaveLength(2);
    expect(queryGatewayAudit({ userId: 'u1', operation: 'a' })).toHaveLength(1);
  });

  it('respects the limit parameter and returns most recent first', () => {
    for (let i = 0; i < 5; i++) {
      recordGatewayAudit({ path: '/execute', requesterSource: 'session', status: 'ok', operation: `op-${i}` });
    }
    const rows = queryGatewayAudit({ limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.operation).toBe('op-4');
    expect(rows[1]!.operation).toBe('op-3');
  });

  it('records error entries with error_msg', () => {
    recordGatewayAudit({
      path: '/execute',
      requesterSource: 'agent-asserted',
      status: 'error',
      httpStatus: 403,
      errorMsg: 'Permission denied',
    });

    const rows = queryGatewayAudit();
    expect(rows[0]).toMatchObject({
      status: 'error',
      http_status: 403,
      error_msg: 'Permission denied',
      requester_source: 'agent-asserted',
    });
  });
});
