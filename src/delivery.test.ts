/**
 * Delivery race tests.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages. A running session
 * sits in both result sets, so the two timer chains can race on the same
 * outbound row — read-undelivered → call channel API → markDelivered. The
 * INSERT OR IGNORE in markDelivered makes the DB write idempotent, but
 * the channel API has already fired twice → user sees the message twice.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  // Short delivery timeout so the hung-adapter test completes quickly.
  // Kept well above the 100ms adapter hold used by the race test.
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery', DELIVERY_TIMEOUT_MS: 300 };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { migrateDeliveredTable } from './db/session-db.js';
import { resolveSession, inboundDbPath, outboundDbPath } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter, drainInflightDeliveries } from './delivery.js';
import { maybeStartProgressStatus } from './modules/progress-status/index.js';
import { consumeSessionSpanContext, storeSessionSpanContext } from './observability/context-bridge.js';
import type { SpanContext } from '@opentelemetry/api';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function seedFeishuChannel(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'feishu',
    platform_id: 'feishu:p2p:ou_test',
    name: 'Feishu Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertOutbound(
  agentGroupId: string,
  sessionId: string,
  msgId: string,
  channelType = 'telegram',
  platformId = 'telegram:123',
  timestamp?: string,
): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, COALESCE(?, datetime('now')), 'chat', ?, ?, ?)`,
  ).run(msgId, timestamp ?? null, platformId, channelType, JSON.stringify({ text: 'hello' }));
  db.close();
}

interface DeliveredRow {
  status: string;
  attempts: number;
  next_retry_at: string | null;
  platform_message_id: string | null;
}

function readDeliveredRow(agentGroupId: string, sessionId: string, msgId: string): DeliveredRow | undefined {
  const db = new Database(inboundDbPath(agentGroupId, sessionId));
  try {
    return db
      .prepare('SELECT status, attempts, next_retry_at, platform_message_id FROM delivered WHERE message_out_id = ?')
      .get(msgId) as DeliveredRow | undefined;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('deliverSessionMessages — concurrent invocations', () => {
  it('keeps bridged trace context across empty polls until outbound work is processed', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const spanContext: SpanContext = {
      traceId: '11111111111111111111111111111111',
      spanId: '2222222222222222',
      traceFlags: 1,
      isRemote: false,
    };

    storeSessionSpanContext(session.id, spanContext);
    await deliverSessionMessages(session);

    expect(consumeSessionSpanContext(session.id)).toEqual(spanContext);

    storeSessionSpanContext(session.id, spanContext);
    insertOutbound('ag-1', session.id, 'out-with-context');
    setDeliveryAdapter({
      async deliver() {
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);

    expect(consumeSessionSpanContext(session.id)).toBeUndefined();
  });

  it('delivers a message exactly once when active and sweep polls overlap', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        // Hold long enough that the second concurrent caller can race the
        // read-undelivered → markDelivered window.
        await new Promise((r) => setTimeout(r, 100));
        return 'plat-msg-1';
      },
    });

    // Two concurrent calls — simulating active (1s) and sweep (60s) polls
    // hitting the same running session at the same moment.
    await Promise.all([deliverSessionMessages(session), deliverSessionMessages(session)]);

    expect(calls).toHaveLength(1);
  });

  it('still delivers on a subsequent call after the first finishes', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-first');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);

    // Insert a second outbound message and deliver again — the lock from
    // the first call must have been released.
    insertOutbound('ag-1', session.id, 'out-second');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('does not re-deliver when retried after a successful send (cleanup-after-send safety)', async () => {
    // If something post-send throws (e.g. outbox cleanup), the message has
    // still landed on the user's screen — the catch path must not trigger
    // a re-send. We simulate by having the adapter succeed on the first
    // call and recording how many times it's invoked across two attempts.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-once');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    // Re-invoke — should be idempotent because the message is now in the
    // delivered table; the channel adapter must not be called again.
    await deliverSessionMessages(session);

    expect(callCount).toBe(1);
  });

  it('removes a Feishu progress reaction after the first user-facing reply', async () => {
    seedFeishuChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-feishu', 'feishu', 'feishu:p2p:ou_test');

    const calls: string[] = [];
    const adapter = {
      async deliver(
        _channelType: string,
        _platformId: string,
        _threadId: string | null,
        _kind: string,
        content: string,
      ) {
        calls.push(content);
        return calls.length === 1 ? 'reaction-id' : 'real-msg';
      },
    };
    setDeliveryAdapter(adapter);

    await maybeStartProgressStatus(session.id, 'feishu', 'feishu:p2p:ou_test', null, 'om_source', adapter);
    await deliverSessionMessages(session);

    expect(calls).toEqual([
      JSON.stringify({
        operation: 'reaction',
        action: 'add',
        messageId: 'om_source',
        emoji: 'THINKING',
      }),
      JSON.stringify({ text: 'hello' }),
      JSON.stringify({
        operation: 'reaction',
        action: 'remove',
        messageId: 'om_source',
        reactionId: 'reaction-id',
        emoji: 'THINKING',
      }),
    ]);
  });
});

describe('delivery resilience — timeout, ordering, persisted backoff (ADR-0016)', () => {
  it('treats a hung adapter call as a failed attempt after DELIVERY_TIMEOUT_MS', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-hang');

    let calls = 0;
    setDeliveryAdapter({
      deliver() {
        calls++;
        return new Promise(() => {}); // never settles — simulates a stuck channel API
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toBe(1);
    const row = readDeliveredRow('ag-1', session.id, 'out-hang');
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(1);
    expect(row?.next_retry_at).not.toBeNull();
  });

  it('stops draining the session for the tick once a message fails (no overtaking)', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-a', 'telegram', 'telegram:123', '2026-01-01 00:00:01');
    insertOutbound('ag-1', session.id, 'out-b', 'telegram', 'telegram:123', '2026-01-01 00:00:02');

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        throw new Error('channel down');
      },
    });

    await deliverSessionMessages(session);

    // Only the first message may be attempted; out-b must not overtake out-a.
    expect(calls).toBe(1);
    expect(readDeliveredRow('ag-1', session.id, 'out-a')?.status).toBe('failed');
    expect(readDeliveredRow('ag-1', session.id, 'out-b')).toBeUndefined();
  });

  it('notifies the user with a plain-text notice when delivery permanently fails (roadmap 6.1)', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-doomed');

    // Seed one attempt below the cap with an overdue retry window, so the next
    // failed attempt crosses DELIVERY_MAX_ATTEMPTS → permanent-failure branch.
    const seedDb = new Database(inboundDbPath('ag-1', session.id));
    migrateDeliveredTable(seedDb);
    seedDb
      .prepare(
        `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at, attempts, next_retry_at)
         VALUES (?, NULL, 'failed', datetime('now'), 9, datetime('now', '-1 hour'))`,
      )
      .run('out-doomed');
    seedDb.close();

    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct: string, _pid: string, _tid: string | null, _kind: string, content: string) {
        sent.push(content);
        throw new Error('channel down');
      },
    });

    await deliverSessionMessages(session);

    // The message is permanently failed AND a best-effort user-facing notice was
    // attempted (it also fails here since the mock always throws, but the
    // attempt — with the human-readable text — is observable).
    expect(readDeliveredRow('ag-1', session.id, 'out-doomed')?.status).toBe('failed');
    expect(sent.some((c) => c.includes("couldn't deliver my last reply"))).toBe(true);
  });

  it('respects next_retry_at backoff and redelivers once the window opens', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-retry');

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        if (calls === 1) throw new Error('transient channel error');
        return 'plat-after-retry';
      },
    });

    await deliverSessionMessages(session); // fails → attempts=1, next_retry_at ≈ +60s
    expect(calls).toBe(1);

    await deliverSessionMessages(session); // backoff window still closed → no attempt
    expect(calls).toBe(1);

    // Open the retry window, as if the backoff elapsed.
    const inDb = new Database(inboundDbPath('ag-1', session.id));
    inDb
      .prepare("UPDATE delivered SET next_retry_at = datetime('now', '-1 second') WHERE message_out_id = ?")
      .run('out-retry');
    inDb.close();

    await deliverSessionMessages(session);
    expect(calls).toBe(2);
    const row = readDeliveredRow('ag-1', session.id, 'out-retry');
    expect(row?.status).toBe('delivered');
    expect(row?.platform_message_id).toBe('plat-after-retry');
    expect(row?.attempts).toBe(1); // kept as historical failure count
  });

  it('stops auto-retrying once the attempts cap is reached, even when due', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-exhausted');

    // Simulate an exhausted message: attempts at the cap, retry long overdue.
    const inDb = new Database(inboundDbPath('ag-1', session.id));
    migrateDeliveredTable(inDb);
    inDb
      .prepare(
        `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at, attempts, next_retry_at)
         VALUES (?, NULL, 'failed', datetime('now'), 10, datetime('now', '-1 hour'))`,
      )
      .run('out-exhausted');
    inDb.close();

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return 'should-not-happen';
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toBe(0);
    expect(readDeliveredRow('ag-1', session.id, 'out-exhausted')?.status).toBe('failed');
  });
});

describe('drainInflightDeliveries — graceful shutdown drain (ADR-0020)', () => {
  it('resolves immediately when nothing is in flight', async () => {
    const start = Date.now();
    await drainInflightDeliveries(5000);
    // No work means no waiting — should return well under the timeout.
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('waits for an in-flight drain to finish before resolving', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-drain');

    let delivered = false;
    let releaseAdapter: () => void = () => {};
    setDeliveryAdapter({
      async deliver() {
        await new Promise<void>((resolve) => {
          releaseAdapter = resolve;
        });
        delivered = true;
        return 'plat-msg-drain';
      },
    });

    // Start a delivery but don't await it — it's now "in flight" (the adapter
    // is parked on the unresolved promise above).
    const inFlight = deliverSessionMessages(session);

    // Drain with a generous timeout; release the adapter shortly after so the
    // drain completes within the window.
    const drainPromise = drainInflightDeliveries(5000);
    setTimeout(() => releaseAdapter(), 50);

    await drainPromise;
    // By the time drain resolves, the in-flight delivery must have completed.
    expect(delivered).toBe(true);
    await inFlight;
  });

  it('gives up after the timeout when a delivery never settles', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-stuck');

    setDeliveryAdapter({
      // Never settles within the drain timeout. Note DELIVERY_TIMEOUT_MS is
      // 300ms (mocked), so the adapter call itself eventually times out as a
      // failed attempt — we only care that the drain itself respects its own
      // bound and doesn't hang shutdown.
      deliver() {
        return new Promise(() => {});
      },
    });

    const inFlight = deliverSessionMessages(session);

    const start = Date.now();
    await drainInflightDeliveries(100); // shorter than DELIVERY_TIMEOUT_MS (300ms)
    const elapsed = Date.now() - start;
    // Drain must return around its own timeout, not block on the stuck send.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(290);

    await inFlight; // let the underlying delivery time out so the test cleans up
  });
});

describe('outbound contract violations dead-letter on the first attempt (ADR-0063)', () => {
  /** Label sets currently present on the contract-violation counter. */
  async function violationSeries(): Promise<string[]> {
    const { outboundContractViolationsTotal } = await import('./metrics.js');
    const v = await outboundContractViolationsTotal.get();
    return v.values.map((x) => `kind="${String((x.labels as { kind?: string }).kind ?? '')}"`);
  }

  /**
   * A malformed payload is malformed deterministically: the row's bytes never
   * change, so the ten retries the normal path grants it are ten guaranteed
   * failures that also hold up every later row in the same session queue —
   * the drain is sequential. Failing it once is the whole point.
   */
  function insertRawOutbound(agentGroupId: string, sessionId: string, msgId: string, raw: string): void {
    const db = new Database(outboundDbPath(agentGroupId, sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
    ).run(msgId, raw);
    db.close();
  }

  it('never sends the payload and never retries it', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        sent.push(content);
        return 'sent';
      },
    });

    insertRawOutbound('ag-1', session.id, 'bad-1', '"i am a string, not an object"');

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    // The rejected payload never reached a channel. The one adapter call that
    // DOES happen is the host telling the waiting user their reply was lost —
    // a chat row silently vanishing is the worse outcome, so this is wanted.
    expect(sent.some((c) => c.includes('i am a string'))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("couldn't deliver");

    // Three polls, exactly one attempt, no retry scheduled.
    const row = readDeliveredRow('ag-1', session.id, 'bad-1');
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(1);
    expect(row?.next_retry_at).toBeNull();
  });

  it('dead-letters a payload carrying a prototype-mutating key', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    setDeliveryAdapter({
      async deliver() {
        return 'sent';
      },
    });

    const proto = ['__pro', 'to__'].join('');
    insertRawOutbound('ag-1', session.id, 'bad-2', `{"text":"hi","${proto}":{"polluted":true}}`);
    await deliverSessionMessages(session);

    const row = readDeliveredRow('ag-1', session.id, 'bad-2');
    expect(row?.attempts).toBe(1);
    // `attempts === 1` alone does NOT discriminate: an ordinary first failure
    // records attempts=1 too. `status` does not discriminate either —
    // markDeliveryFailed hardcodes 'failed' on both paths. Only a null
    // next_retry_at separates dead-lettered from scheduled-for-retry, which is
    // what makes this assertion the one that can fail if the permanent branch
    // is ever narrowed away from the forbidden-key class.
    expect(row?.status).toBe('failed');
    expect(row?.next_retry_at).toBeNull();
  });

  /**
   * `messages_out.kind` is written by the container. Labelling a counter with
   * it raw would let the untrusted side mint unbounded Prometheus series — in
   * the one change whose subject is not trusting that side.
   */
  it('buckets an unrecognised kind instead of minting a label for it', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    setDeliveryAdapter({
      async deliver() {
        return 'sent';
      },
    });

    const before = await violationSeries();
    const db = new Database(outboundDbPath('ag-1', session.id));
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
         VALUES (?, datetime('now'), ?, 'telegram:123', 'telegram', '[]')`,
      ).run(`k-${i}`, `attacker-kind-${i}`);
    }
    db.close();
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    const after = await violationSeries();
    expect(after.some((l) => l.includes('attacker-kind'))).toBe(false);
    expect(after.some((l) => l.includes('kind="other"'))).toBe(true);
    // Five hostile kinds, at most one new series.
    expect(after.length - before.length).toBeLessThanOrEqual(1);
  });

  /**
   * The negative result that kept `files` a cast, kept as a test so the next
   * person does not re-derive it: a non-string entry is SKIPPED, not crashed,
   * because `isSafeAttachmentName` type-checks before it does anything else.
   * The message still goes out with its valid attachment. Tightening this into
   * a rejection would trade graceful degradation for a dead-lettered reply.
   */
  it('skips a non-string entry in files and still delivers the message', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        sent.push(content);
        return 'sent';
      },
    });

    const outboxDir = path.join(TEST_DIR, 'v2-sessions', 'ag-1', session.id, 'outbox', 'files-1');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'ok.txt'), 'attachment');

    insertRawOutbound('ag-1', session.id, 'files-1', JSON.stringify({ text: 'here', files: ['ok.txt', 123] }));
    await deliverSessionMessages(session);

    expect(readDeliveredRow('ag-1', session.id, 'files-1')?.status).toBe('delivered');
    expect(sent.some((c) => c.includes('here'))).toBe(true);
  });

  it('leaves a well-formed payload on the normal path', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    let adapterCalls = 0;
    setDeliveryAdapter({
      async deliver() {
        adapterCalls++;
        return 'sent';
      },
    });

    insertOutbound('ag-1', session.id, 'good-1');
    await deliverSessionMessages(session);

    expect(adapterCalls).toBe(1);
    expect(readDeliveredRow('ag-1', session.id, 'good-1')?.status).toBe('delivered');
  });
});
