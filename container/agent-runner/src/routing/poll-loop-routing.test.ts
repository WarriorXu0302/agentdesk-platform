import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { runPollLoop } from '../poll-loop.js';
import type { AgentProvider, AgentQuery, QueryInput } from '../providers/types.js';
import { setRoutingGate } from './gate.js';

class OneShotProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  calls: QueryInput[] = [];

  constructor(
    private readonly text: string,
    private readonly model: string,
  ) {}

  isSessionInvalid(): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    this.calls.push(input);
    let aborted = false;
    const model = this.model;
    const text = this.text;
    return {
      push() {},
      pushSystemReminder() {},
      end() {},
      abort() {
        aborted = true;
      },
      events: {
        async *[Symbol.asyncIterator]() {
          if (aborted) return;
          yield { type: 'init' as const, continuation: `one-shot-${Date.now()}` };
          yield {
            type: 'usage' as const,
            model,
            totalTokens: 7,
            durationMs: 5,
            transport: 'chat-completions',
          };
          yield { type: 'result' as const, text };
        },
      },
    };
  }
}

class HoldFirstExecutionProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  calls: QueryInput[] = [];
  pushCount = 0;
  endCount = 0;
  firstStarted = false;
  private finishFirstTurn: (() => void) | undefined;

  finishFirst(): void {
    this.finishFirstTurn?.();
  }

  isSessionInvalid(): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    this.calls.push(input);
    const call = this.calls.length;
    if (call > 1) {
      return new OneShotProvider('<message to="cli-local">second turn</message>', 'deepseek-v4-flash').query(input);
    }
    const provider = this;
    let release!: () => void;
    const ended = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.finishFirstTurn = release;
    return {
      push() {
        provider.pushCount += 1;
      },
      pushSystemReminder() {},
      end() {
        provider.endCount += 1;
        release();
      },
      abort() {
        release();
      },
      events: {
        async *[Symbol.asyncIterator]() {
          provider.firstStarted = true;
          yield { type: 'init' as const, continuation: 'held-first-turn' };
          await ended;
          yield { type: 'result' as const, text: '<message to="cli-local">first turn</message>' };
        },
      },
    };
  }
}

let root = '';
beforeEach(() => {
  initTestSessionDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-poll-routing-'));
  fs.mkdirSync(path.join(root, 'prompts'));
  fs.writeFileSync(path.join(root, 'prompts/frontdesk-routing.md'), 'Return one routing JSON object only.');
  const db = getInboundDb();
  db.prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ('cli-local', 'CLI', 'channel', 'cli', 'local', NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ('finance', 'Finance', 'agent', NULL, NULL, 'ag-finance')`,
  ).run();
  db.prepare(
    `INSERT INTO messages_in
      (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
     VALUES ('m1', 2, 'chat', datetime('now'), 'pending', 1, 'local', 'cli', NULL,
       '{"sender":"User","senderId":"local","text":"hello"}')`,
  ).run();
});

afterEach(() => {
  closeSessionDb();
  fs.rmSync(root, { recursive: true, force: true });
});

function routingConfig() {
  return {
    enabled: true as const,
    provider: 'opencode-go',
    model: 'mimo-v2.5',
    transport: 'chat-completions' as const,
    promptFile: 'prompts/frontdesk-routing.md',
    timeoutMs: 1000,
    retryTimes: 0,
    context: { maxMessages: 4, maxChars: 12_000 },
    confidence: { threshold: 0.7, belowThresholdAction: 'clarify' as const },
    fallback: { action: 'clarify' as const },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2500): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('poll loop enforced Routing + Execution', () => {
  it('queues a same-session follow-up and routes it independently after the active execution finishes', async () => {
    const routingProvider = new OneShotProvider(
      JSON.stringify({ action: 'answer_self', confidence: 0.99, reason: 'answer locally' }),
      'mimo-v2.5',
    );
    const executionProvider = new HoldFirstExecutionProvider();
    const controller = new AbortController();
    const loop = runPollLoop({
      provider: executionProvider,
      providerName: 'opencode-go',
      cwd: root,
      signal: controller.signal,
      routing: { provider: routingProvider, config: routingConfig(), agentRoot: root },
    });

    await waitFor(() => executionProvider.firstStarted);
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in
          (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES ('m2', 4, 'chat', datetime('now'), 'pending', 1, 'local', 'cli', NULL,
           '{"sender":"User","senderId":"local","text":"a distinct follow-up"}')`,
      )
      .run();

    // Release the held first turn deterministically, then the follow-up must be
    // routed as its OWN turn. Kept fast (no fixed sleep) so this integration-style
    // test's window doesn't straddle another file's DB reset under bun's parallel
    // file execution. endCount is intentionally not asserted: under an active gate
    // the loop ends the stream to hand off, but whether that beats finishFirst() is
    // a timing detail, not an invariant.
    executionProvider.finishFirst();
    await waitFor(() => routingProvider.calls.length === 2 && executionProvider.calls.length === 2, 8000);
    controller.abort();
    await loop;

    // The follow-up was never force-pushed into the first turn's stream, the first
    // turn's answer was delivered, and each trigger got its own routed turn.
    expect(executionProvider.pushCount).toBe(0);
    const firstTurnDelivered = (
      getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'chat'").all() as Array<{
        content: string;
      }>
    ).some((r) => r.content.includes('first turn'));
    expect(firstTurnDelivered).toBe(true);
    expect(routingProvider.calls[0].prompt).toContain('hello');
    expect(routingProvider.calls[0].prompt).not.toContain('a distinct follow-up');
    expect(routingProvider.calls[1].prompt).toContain('a distinct follow-up');
  });

  it('runs mimo routing before deepseek execution and correlates both usage rows', async () => {
    const routingProvider = new OneShotProvider(
      JSON.stringify({ action: 'answer_self', confidence: 0.99, reason: 'greeting' }),
      'mimo-v2.5',
    );
    const executionProvider = new OneShotProvider(
      '<message to="cli-local">hi im deepseek-v4-flash</message>',
      'deepseek-v4-flash',
    );
    const controller = new AbortController();
    const loop = runPollLoop({
      provider: executionProvider,
      providerName: 'opencode-go',
      cwd: root,
      signal: controller.signal,
      routing: { provider: routingProvider, config: routingConfig(), agentRoot: root },
    });

    await waitFor(
      () =>
        (getOutboundDb().prepare("SELECT COUNT(*) AS n FROM messages_out WHERE kind='chat'").get() as { n: number }).n >
        0,
    );
    controller.abort();
    await loop;

    expect(routingProvider.calls).toHaveLength(1);
    expect(executionProvider.calls).toHaveLength(1);
    const rows = getOutboundDb()
      .prepare('SELECT kind, channel_type, content FROM messages_out ORDER BY seq')
      .all() as Array<{
      kind: string;
      channel_type: string | null;
      content: string;
    }>;
    const usages = rows.filter((row) => row.kind === 'llm-usage').map((row) => JSON.parse(row.content));
    expect(usages.map((usage) => [usage.phase, usage.model])).toEqual([
      ['routing', 'mimo-v2.5'],
      ['execution', 'deepseek-v4-flash'],
    ]);
    expect(usages[0].routingDecisionId).toBe(usages[1].routingDecisionId);
    const reply = rows.find((row) => row.kind === 'chat' && row.channel_type === 'cli')!;
    expect(JSON.parse(reply.content)).toMatchObject({ text: 'hi im deepseek-v4-flash' });
    expect(JSON.parse(reply.content)._classificationId).toBe(usages[0].routingDecisionId);
  });

  it('enforces delegate directly without calling the frontdesk execution provider', async () => {
    const routingProvider = new OneShotProvider(
      JSON.stringify({ action: 'delegate', target: 'finance', confidence: 0.95, reason: 'finance request' }),
      'mimo-v2.5',
    );
    const executionProvider = new OneShotProvider('must not run', 'deepseek-v4-flash');
    const controller = new AbortController();
    const loop = runPollLoop({
      provider: executionProvider,
      providerName: 'opencode-go',
      cwd: root,
      signal: controller.signal,
      routing: { provider: routingProvider, config: routingConfig(), agentRoot: root },
    });
    await waitFor(
      () =>
        (
          getOutboundDb().prepare("SELECT COUNT(*) AS n FROM messages_out WHERE channel_type='agent'").get() as {
            n: number;
          }
        ).n > 0,
    );
    controller.abort();
    await loop;

    expect(routingProvider.calls).toHaveLength(1);
    expect(executionProvider.calls).toHaveLength(0);
    const delegated = getOutboundDb()
      .prepare("SELECT platform_id, content FROM messages_out WHERE channel_type='agent' LIMIT 1")
      .get() as { platform_id: string; content: string };
    expect(delegated.platform_id).toBe('ag-finance');
    expect(JSON.parse(delegated.content).text).toContain('hello');
  });

  it('clears a crash-stale routing gate before a new legacy turn starts', async () => {
    setRoutingGate({ decisionId: 'stale-route', anchorId: 'old-anchor', action: 'answer_self' });
    const executionProvider = new OneShotProvider(
      '<message to="finance">legacy delegation after restart</message>',
      'legacy-model',
    );
    const controller = new AbortController();
    const loop = runPollLoop({
      provider: executionProvider,
      providerName: 'mock',
      cwd: root,
      signal: controller.signal,
    });

    await waitFor(() =>
      Boolean(getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE channel_type='agent' LIMIT 1").get()),
    );
    controller.abort();
    await loop;

    expect(executionProvider.calls).toHaveLength(1);
  });

  it('bypasses Routing for a worker A2A turn even when the group is routing-enabled', async () => {
    getInboundDb()
      .prepare(
        `UPDATE messages_in
         SET channel_type='agent', platform_id='ag-finance', origin_user_id='cli:local'
         WHERE id='m1'`,
      )
      .run();
    const routingProvider = new OneShotProvider(
      JSON.stringify({ action: 'reject', confidence: 1, reason: 'must not run' }),
      'mimo-v2.5',
    );
    const executionProvider = new OneShotProvider('<message to="finance">worker result</message>', 'deepseek-v4-flash');
    const controller = new AbortController();
    const loop = runPollLoop({
      provider: executionProvider,
      providerName: 'opencode-go',
      cwd: root,
      signal: controller.signal,
      routing: { provider: routingProvider, config: routingConfig(), agentRoot: root },
    });

    await waitFor(() =>
      Boolean(getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE channel_type='agent' LIMIT 1").get()),
    );
    controller.abort();
    await loop;

    expect(routingProvider.calls).toHaveLength(0);
    expect(executionProvider.calls).toHaveLength(1);
  });
});
