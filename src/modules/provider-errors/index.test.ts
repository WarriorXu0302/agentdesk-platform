import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import type { DeliveryActionHandler } from '../../delivery.js';
import { providerErrorsTotal } from '../../metrics.js';
import type { Session } from '../../types.js';

const captured: Map<string, DeliveryActionHandler> = new Map();

vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: DeliveryActionHandler) => {
    captured.set(action, handler);
  },
}));

// Side-effect import registers the handler.
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

async function valueFor(provider: string, code: string): Promise<number> {
  const all = await providerErrorsTotal.get();
  const match = all.values.find(
    (v) => v.labels.provider === provider && v.labels.code === code,
  );
  return match?.value ?? 0;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  providerErrorsTotal.reset();
});

afterEach(() => {
  closeDb();
});

describe('provider_error delivery action', () => {
  it('increments the metric with the reported provider + code', async () => {
    const handler = captured.get('provider_error');
    expect(handler).toBeDefined();
    expect(await valueFor('claude', 'timeout')).toBe(0);

    await handler!(
      { action: 'provider_error', provider: 'claude', code: 'timeout', message: 'request timed out' },
      session(),
      {} as never,
    );

    expect(await valueFor('claude', 'timeout')).toBe(1);
  });

  it('keeps counts separate per (provider, code)', async () => {
    const handler = captured.get('provider_error')!;
    await handler({ action: 'provider_error', provider: 'openai', code: 'gateway_5xx' }, session(), {} as never);
    await handler({ action: 'provider_error', provider: 'openai', code: 'gateway_5xx' }, session(), {} as never);
    await handler({ action: 'provider_error', provider: 'openai', code: 'rate_limited' }, session(), {} as never);
    await handler({ action: 'provider_error', provider: 'claude', code: 'gateway_5xx' }, session(), {} as never);

    expect(await valueFor('openai', 'gateway_5xx')).toBe(2);
    expect(await valueFor('openai', 'rate_limited')).toBe(1);
    expect(await valueFor('claude', 'gateway_5xx')).toBe(1);
  });

  it('falls back to "unknown" labels when fields are missing', async () => {
    const handler = captured.get('provider_error')!;
    await handler({ action: 'provider_error' }, session(), {} as never);

    expect(await valueFor('unknown', 'unknown')).toBe(1);
  });
});
