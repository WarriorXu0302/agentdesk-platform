import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { queryGatewayAudit } from '../../db/gateway-audit.js';
import type { DeliveryActionHandler } from '../../delivery.js';
import type { Session } from '../../types.js';

const captured: Map<string, DeliveryActionHandler> = new Map();

vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: DeliveryActionHandler) => {
    captured.set(action, handler);
  },
}));

// Importing the module triggers registerDeliveryAction as a side effect.
await import('./index.js');

function session(): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: null,
    root_session_id: 'sess-1',
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('gateway_audit delivery action', () => {
  it('persists a well-formed audit payload', async () => {
    const handler = captured.get('gateway_audit');
    expect(handler).toBeDefined();
    await handler!(
      {
        action: 'gateway_audit',
        path: '/execute',
        operation: 'finance.invoice.approve',
        userId: 'feishu:ou_1',
        requesterSource: 'session',
        status: 'ok',
        httpStatus: 200,
        durationMs: 42,
        idempotencyKey: 'idem-xyz',
        inputHash: 'deadbeef',
      },
      session(),
      // inDb is only used by schedulers; gateway_audit writes central DB directly.
      {} as never,
    );

    const rows = queryGatewayAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'sess-1',
      agent_group_id: 'ag-1',
      user_id: 'feishu:ou_1',
      path: '/execute',
      operation: 'finance.invoice.approve',
      requester_source: 'session',
      status: 'ok',
      http_status: 200,
      duration_ms: 42,
      idempotency_key: 'idem-xyz',
      input_hash: 'deadbeef',
    });
  });

  it('drops payloads missing required fields', async () => {
    const handler = captured.get('gateway_audit')!;
    await handler({ action: 'gateway_audit' }, session(), {} as never);
    expect(queryGatewayAudit()).toHaveLength(0);
  });

  it('coerces unknown status to error', async () => {
    const handler = captured.get('gateway_audit')!;
    await handler(
      { action: 'gateway_audit', path: '/execute', requesterSource: 'session', status: 'weird' },
      session(),
      {} as never,
    );
    expect(queryGatewayAudit()[0]!.status).toBe('error');
  });
});
