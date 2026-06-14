import { describe, expect, it } from 'bun:test';

import {
  bulkExecuteRequestSchema,
  bulkExecuteResponseSchema,
  REQUEST_SCHEMAS,
  RESPONSE_SCHEMAS,
} from './gateway-contract.js';

// /bulk_execute contract (ADR-0036, roadmap 3.1).
describe('bulkExecuteRequestSchema', () => {
  const envelope = {
    contractVersion: 1,
    agent: { agentGroupId: 'ag1', groupName: 'FD', assistantName: 'FD' },
    requester: { userId: 'feishu:ou_alice' },
    requesterSource: 'session' as const,
    context: {},
    dryRun: false,
  };

  it('parses a valid batch with per-operation idempotency keys', () => {
    const parsed = bulkExecuteRequestSchema.parse({
      ...envelope,
      operations: [
        { operation: 'sales.order.create', input: { sku: 'A', quantity: 1 }, idempotencyKey: 'k1' },
        { operation: 'sales.order.create', input: { sku: 'B', quantity: 2 }, idempotencyKey: 'k2' },
      ],
      atomic: true,
    });
    expect(parsed.operations).toHaveLength(2);
    expect(parsed.operations[0].idempotencyKey).toBe('k1');
    expect(parsed.atomic).toBe(true);
  });

  it('allows a null per-operation idempotencyKey (dryRun) and omitted atomic', () => {
    const parsed = bulkExecuteRequestSchema.parse({
      ...envelope,
      dryRun: true,
      operations: [{ operation: 'conformance.noop', input: {}, idempotencyKey: null }],
    });
    expect(parsed.operations[0].idempotencyKey).toBeNull();
    expect(parsed.atomic).toBeUndefined();
  });

  it('rejects an empty operations array', () => {
    expect(() => bulkExecuteRequestSchema.parse({ ...envelope, operations: [] })).toThrow();
  });

  it('rejects an operation missing its name', () => {
    expect(() =>
      bulkExecuteRequestSchema.parse({ ...envelope, operations: [{ input: {}, idempotencyKey: null }] }),
    ).toThrow();
  });

  it('is registered as a gateway path on both request and response sides', () => {
    expect('/bulk_execute' in REQUEST_SCHEMAS).toBe(true);
    expect('/bulk_execute' in RESPONSE_SCHEMAS).toBe(true);
  });
});

describe('bulkExecuteResponseSchema', () => {
  it('parses a best-effort response with per-op results and partial flag', () => {
    const parsed = bulkExecuteResponseSchema.parse({
      ok: false,
      partial: true,
      results: [
        { ok: true, result: { committed: true }, auditId: 'a1' },
        { ok: false, error: { code: 'OPERATION_NOT_FOUND', message: 'unknown operation: x' } },
      ],
    });
    expect(parsed.partial).toBe(true);
    expect(parsed.results).toHaveLength(2);
  });

  it('stays lenient — a backend may add fields and omit results', () => {
    const parsed = bulkExecuteResponseSchema.parse({ ok: true, backendId: 'erp-1' });
    expect(parsed.ok).toBe(true);
  });
});
