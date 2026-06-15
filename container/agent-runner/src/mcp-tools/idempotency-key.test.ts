/**
 * Stable gateway idempotency key (ADR-0048).
 *
 * The key is sourced from `processing_ack` (outbound.db) — the host-written turn
 * marker that crosses the MCP child process boundary (poll-loop module state does
 * NOT). These tests seed processing_ack and capture the key the handler sends via
 * mocked fetch, exercising the SAME DB-read code path the real child runs — so
 * they are a faithful boundary test without Docker (the false-green the design
 * review warned about was specific to module-state designs, which this is not).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { clearRequestIdentity, setRequestIdentity, type RequestIdentity } from '../request-context.js';
import {
  __resetIdempotencyOccurrenceForTests,
  handleGatewayBulkExecute,
  handleGatewayExecute,
} from './gateway.js';

const runtime = {
  assistantName: 'FD',
  groupName: 'FD',
  agentGroupId: 'ag-1',
  backendGateway: { baseUrl: 'https://erp.example' },
};
const originalFetch = globalThis.fetch;

function identity(): RequestIdentity {
  return {
    userId: 'feishu:ou_1',
    channelType: 'feishu',
    platformId: 'feishu:p2p:ou_1',
    threadId: null,
    source: 'session',
  };
}

/** Seed the host's per-turn processing marker (what markProcessing writes). */
function markProcessing(ids: string[], statusChanged: string): void {
  const db = getOutboundDb();
  db.prepare('DELETE FROM processing_ack').run();
  const stmt = db.prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)');
  for (const id of ids) stmt.run(id, 'processing', statusChanged);
}

/** Capture every idempotencyKey the handler sends to the backend. */
const sentKeys: string[] = [];
const sentBulkKeys: string[][] = [];
function mockGateway(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      idempotencyKey?: string;
      operations?: Array<{ idempotencyKey?: string }>;
    };
    if (String(input).endsWith('/bulk_execute')) {
      sentBulkKeys.push((body.operations ?? []).map((o) => o.idempotencyKey ?? '∅'));
    } else {
      sentKeys.push(body.idempotencyKey ?? '∅');
    }
    return new Response(JSON.stringify({ status: 'ok', result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  initTestSessionDb();
  setRequestIdentity(identity());
  __resetIdempotencyOccurrenceForTests();
  sentKeys.length = 0;
  sentBulkKeys.length = 0;
  mockGateway();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearRequestIdentity();
  closeSessionDb();
});

const exec = (over: Record<string, unknown> = {}) =>
  handleGatewayExecute(runtime, { operation: 'finance.invoice.approve', input: { id: 'INV-1' }, ...over });

describe('stable idempotency key (ADR-0048)', () => {
  it('a re-drive of the same turn reproduces the SAME key (dedupe across crash-replay)', async () => {
    markProcessing(['m1'], '2026-06-15 10:00:00');
    await exec();
    // Re-drive: same inbound row re-marked later (>=60s backoff). Counter resets
    // via the new status_changed signal, but the key (anchor-based) is unchanged.
    __resetIdempotencyOccurrenceForTests(); // simulate a fresh child/turn-execution
    markProcessing(['m1'], '2026-06-15 10:01:30');
    await exec();
    expect(sentKeys[0]).toStartWith('idem:');
    expect(sentKeys[1]).toBe(sentKeys[0]); // SAME key -> backend dedupes the double write
  });

  it('two DISTINCT writes in one turn never collide (no data-loss folding)', async () => {
    markProcessing(['m1'], '2026-06-15 10:00:00');
    await exec({ operation: 'a.x', input: { v: 1 } });
    await exec({ operation: 'b.y', input: { v: 2 } });
    expect(sentKeys[0]).not.toBe(sentKeys[1]);
  });

  it('two INTENTIONALLY-identical writes in one turn get distinct keys (occurrence index)', async () => {
    markProcessing(['m1'], '2026-06-15 10:00:00');
    await exec(); // occurrence 0
    await exec(); // occurrence 1 — same content, distinct key
    expect(sentKeys[0]).not.toBe(sentKeys[1]);
    // ...and a replay reproduces the SAME 0,1 sequence:
    __resetIdempotencyOccurrenceForTests();
    markProcessing(['m1'], '2026-06-15 10:02:00');
    await exec();
    await exec();
    expect(sentKeys[2]).toBe(sentKeys[0]);
    expect(sentKeys[3]).toBe(sentKeys[1]);
  });

  it('falls back to a random key when there is no processing batch (no stable anchor)', async () => {
    // no markProcessing -> resolveTurn() null -> random UUID per call
    await exec();
    await exec();
    expect(sentKeys[0]).not.toStartWith('idem:');
    expect(sentKeys[0]).not.toBe(sentKeys[1]); // random -> distinct
  });

  it('an explicit agent-supplied key always wins', async () => {
    markProcessing(['m1'], '2026-06-15 10:00:00');
    await exec({ idempotencyKey: 'agent-chosen-key' });
    expect(sentKeys[0]).toBe('agent-chosen-key');
  });

  it('dryRun carries no key', async () => {
    markProcessing(['m1'], '2026-06-15 10:00:00');
    await exec({ dryRun: true });
    expect(sentKeys[0]).toBe('∅');
  });

  it('bulk_execute: each op gets a distinct stable key; a re-drive reproduces them', async () => {
    markProcessing(['m1'], '2026-06-15 10:00:00');
    await handleGatewayBulkExecute(runtime, {
      operations: [
        { operation: 'a.x', input: { v: 1 } },
        { operation: 'a.x', input: { v: 1 } }, // intentionally identical -> still distinct (callsite/occurrence)
        { operation: 'b.y', input: { v: 2 } },
      ],
    });
    const first = sentBulkKeys[0];
    expect(new Set(first).size).toBe(3); // all distinct, no collision
    expect(first.every((k) => k.startsWith('idem:'))).toBe(true);

    __resetIdempotencyOccurrenceForTests();
    markProcessing(['m1'], '2026-06-15 10:03:00');
    await handleGatewayBulkExecute(runtime, {
      operations: [
        { operation: 'a.x', input: { v: 1 } },
        { operation: 'a.x', input: { v: 1 } },
        { operation: 'b.y', input: { v: 2 } },
      ],
    });
    expect(sentBulkKeys[1]).toEqual(first); // replay reproduces the same keys
  });
});
