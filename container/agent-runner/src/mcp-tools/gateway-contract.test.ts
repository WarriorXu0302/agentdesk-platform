import { describe, expect, it } from 'bun:test';

import {
  bulkExecuteRequestSchema,
  bulkExecuteResponseSchema,
  executeRequestSchema,
  memorySearchResponseSchema,
  memorySearchResultSchema,
  REQUEST_SCHEMAS,
  RESPONSE_SCHEMAS,
  taskStatusRequestSchema,
  taskStatusResponseSchema,
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

// Async tasks (ADR-0037, roadmap 3.2).
describe('async task contract', () => {
  const envelope = {
    contractVersion: 1,
    agent: { agentGroupId: 'ag1', groupName: 'FD', assistantName: 'FD' },
    requester: { userId: 'feishu:ou_alice' },
    requesterSource: 'session' as const,
  };

  it('execute accepts an optional submitAsync flag (backward-compatible)', () => {
    expect(
      executeRequestSchema.parse({
        ...envelope,
        operation: 'finance.ledger.post',
        input: {},
        context: {},
        dryRun: false,
        idempotencyKey: 'k',
        submitAsync: true,
      }).submitAsync,
    ).toBe(true);
    // Omitting it stays valid (the common synchronous case).
    expect(
      executeRequestSchema.parse({
        ...envelope,
        operation: 'x',
        input: {},
        context: {},
        dryRun: false,
        idempotencyKey: 'k',
      }).submitAsync,
    ).toBeUndefined();
  });

  it('taskStatusRequestSchema requires a taskId', () => {
    expect(taskStatusRequestSchema.parse({ ...envelope, taskId: 'task-1', context: {} }).taskId).toBe('task-1');
    expect(() => taskStatusRequestSchema.parse({ ...envelope, taskId: '', context: {} })).toThrow();
  });

  it('taskStatusResponseSchema parses each status shape and stays lenient', () => {
    expect(taskStatusResponseSchema.parse({ ok: true, status: 'running', progress: 0.5 }).status).toBe('running');
    expect(taskStatusResponseSchema.parse({ ok: true, status: 'succeeded', result: { committed: true } }).ok).toBe(
      true,
    );
    expect(
      taskStatusResponseSchema.parse({ ok: true, status: 'failed', error: { code: 'TIMEOUT', message: 'x' } }).status,
    ).toBe('failed');
  });

  it('/task/status is registered as a gateway path on both sides', () => {
    expect('/task/status' in REQUEST_SCHEMAS).toBe(true);
    expect('/task/status' in RESPONSE_SCHEMAS).toBe(true);
  });
});

// Temporal-validity memory contract (ADR-0050).
describe('memory temporal validity', () => {
  it('memorySearchResultSchema parses optional validAt / invalidAt', () => {
    const live = memorySearchResultSchema.parse({
      value: { city: 'SF' },
      validAt: '2026-06-15T00:00:00.000Z',
    });
    expect(live.validAt).toBe('2026-06-15T00:00:00.000Z');
    expect(live.invalidAt).toBeUndefined();

    const superseded = memorySearchResultSchema.parse({
      value: { city: 'NYC' },
      validAt: '2026-06-01T00:00:00.000Z',
      invalidAt: '2026-06-15T00:00:00.000Z',
    });
    expect(superseded.invalidAt).toBe('2026-06-15T00:00:00.000Z');
  });

  it('a result without temporal fields stays conformant (backward-compatible)', () => {
    const parsed = memorySearchResultSchema.parse({ value: { ok: true }, score: 0.5 });
    expect(parsed.validAt).toBeUndefined();
    expect(parsed.invalidAt).toBeUndefined();
  });

  it('search response carries temporal results through the lenient envelope', () => {
    const parsed = memorySearchResponseSchema.parse({
      ok: true,
      results: [
        { value: { city: 'SF' }, validAt: '2026-06-15T00:00:00.000Z' },
        { value: { city: 'NYC' }, validAt: '2026-06-01T00:00:00.000Z', invalidAt: '2026-06-15T00:00:00.000Z' },
      ],
    });
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results?.[1]?.invalidAt).toBe('2026-06-15T00:00:00.000Z');
  });
});
