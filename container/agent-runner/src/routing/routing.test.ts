import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RoutingLlmConfig } from '../config.js';
import type { MessageInRow } from '../db/messages-in.js';
import { MockProvider } from '../providers/mock.js';
import type { AgentProvider } from '../providers/types.js';
import { buildRoutingContext, loadRoutingPrompt, routeFrontdeskTurn } from './index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempAgentRoot(prompt = 'Return routing JSON only.'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-routing-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'prompts'));
  fs.writeFileSync(path.join(root, 'prompts/frontdesk-routing.md'), prompt);
  return root;
}

function message(id: string, text: string, overrides: Partial<MessageInRow> = {}): MessageInRow {
  return {
    id,
    seq: null,
    kind: 'chat',
    timestamp: '2026-07-19T00:00:00.000Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: 'secret-platform-id',
    channel_type: 'cli',
    thread_id: 'secret-thread-id',
    content: JSON.stringify({ sender: 'Alice', senderId: 'secret-user-id', text }),
    ...overrides,
  };
}

function config(overrides: Partial<RoutingLlmConfig> = {}): RoutingLlmConfig {
  return {
    enabled: true,
    provider: 'mock',
    model: 'mimo-v2.5',
    transport: 'chat-completions',
    promptFile: 'prompts/frontdesk-routing.md',
    timeoutMs: 1000,
    retryTimes: 1,
    context: { maxMessages: 4, maxChars: 12_000 },
    confidence: { threshold: 0.7, belowThresholdAction: 'clarify' },
    fallback: { action: 'clarify' },
    ...overrides,
  };
}

describe('Routing context boundary', () => {
  it('includes current messages and live workers but excludes routing IDs and identities', () => {
    const rendered = buildRoutingContext({
      messages: [message('m1', 'please check an invoice')],
      workers: [
        { name: 'finance', displayName: 'Finance', type: 'agent', agentGroupId: 'ag-finance' },
        { name: 'cli-local', displayName: 'CLI', type: 'channel', channelType: 'cli', platformId: 'local' },
      ],
      maxMessages: 4,
      maxChars: 12_000,
    });

    expect(rendered).toContain('<worker name="finance" display_name="Finance" />');
    expect(rendered).toMatch(/<metadata timezone="[^"]+" input_kind="chat"/);
    expect(rendered).not.toContain('cli-local');
    expect(rendered).toContain('please check an invoice');
    expect(rendered).not.toContain('secret-platform-id');
    expect(rendered).not.toContain('secret-thread-id');
    expect(rendered).not.toContain('secret-user-id');
  });

  it('preserves the trigger anchor, drops oldest accumulated rows first, and returns valid bounded XML', () => {
    const rendered = buildRoutingContext({
      messages: [
        message('anchor', 'A'.repeat(1500), { seq: 1, trigger: 1 }),
        message('old', 'OLD-' + 'B'.repeat(1200), { seq: 2, trigger: 0 }),
        message('new', 'NEW-' + 'C'.repeat(1200), { seq: 3, trigger: 0 }),
      ],
      workers: [],
      maxMessages: 3,
      maxChars: 2200,
    });

    expect(rendered.length).toBeLessThanOrEqual(2200);
    expect(rendered).toEndWith('</routing_request>');
    expect(rendered).toContain('A'.repeat(1000));
    expect(rendered).toContain('NEW-');
    expect(rendered).not.toContain('OLD-');
    expect(rendered).toContain('<truncated />');
  });

  it('keeps chronological input order when maxMessages re-adds an anchor without sequence numbers', () => {
    const rendered = buildRoutingContext({
      messages: [
        message('anchor', 'ANCHOR', { seq: null, trigger: 1 }),
        message('middle', 'MIDDLE', { seq: null, trigger: 0 }),
        message('latest', 'LATEST', { seq: null, trigger: 0 }),
      ],
      workers: [],
      maxMessages: 2,
      maxChars: 4000,
    });

    expect(rendered).toContain('ANCHOR');
    expect(rendered).not.toContain('MIDDLE');
    expect(rendered).toContain('LATEST');
    expect(rendered.indexOf('ANCHOR')).toBeLessThan(rendered.indexOf('LATEST'));
  });

  it('fails closed instead of returning malformed XML when trusted structural metadata exceeds maxChars', () => {
    expect(() =>
      buildRoutingContext({
        messages: [message('anchor', 'hello')],
        workers: [
          {
            name: 'worker',
            displayName: 'W'.repeat(3000),
            type: 'agent',
            agentGroupId: 'ag-worker',
          },
        ],
        maxMessages: 4,
        maxChars: 1000,
      }),
    ).toThrow(/context.*maxChars/i);
  });
});

describe('Routing prompt loader', () => {
  it('reads at request time and changes the hash after an operator edit', () => {
    const root = tempAgentRoot('version one');
    const first = loadRoutingPrompt(root, 'prompts/frontdesk-routing.md');
    fs.writeFileSync(path.join(root, 'prompts/frontdesk-routing.md'), 'version two');
    const second = loadRoutingPrompt(root, 'prompts/frontdesk-routing.md');
    expect(first.text).toBe('version one');
    expect(second.text).toBe('version two');
    expect(second.hash).not.toBe(first.hash);
  });

  it('rejects traversal outside the prompts directory', () => {
    const root = tempAgentRoot();
    expect(() => loadRoutingPrompt(root, '../secret')).toThrow(/prompts/i);
  });

  it('rejects prompt bytes that are not valid UTF-8', () => {
    const root = tempAgentRoot();
    fs.writeFileSync(path.join(root, 'prompts/frontdesk-routing.md'), Buffer.from([0xc3, 0x28]));
    expect(() => loadRoutingPrompt(root, 'prompts/frontdesk-routing.md')).toThrow(/UTF-8/i);
  });
});

describe('Enforced Routing controller', () => {
  it('retries invalid output, validates the live worker, and returns a normalized delegate decision', async () => {
    const root = tempAgentRoot();
    let calls = 0;
    const provider = new MockProvider({}, () => {
      calls += 1;
      return calls === 1
        ? 'not-json'
        : JSON.stringify({ action: 'delegate', target: 'finance', confidence: 0.91, reason: 'invoice request' });
    });

    const result = await routeFrontdeskTurn({
      provider,
      config: config(),
      agentRoot: root,
      messages: [message('m1', 'check invoice')],
      getWorkers: () => [{ name: 'finance', displayName: 'Finance', type: 'agent', agentGroupId: 'ag-finance' }],
    });

    expect(calls).toBe(2);
    expect(result.decision).toMatchObject({
      action: 'delegate',
      target: 'finance',
      targetAgentGroupId: 'ag-finance',
      confidence: 0.91,
      source: 'routing_llm',
      attempts: 2,
      model: 'mimo-v2.5',
    });
    expect(result.decision.id).toMatch(/^route-/);
    expect(result.decision.promptHash).toHaveLength(64);
  });

  it('rebuilds the live worker list before every Routing attempt', async () => {
    const root = tempAgentRoot();
    let providerCalls = 0;
    let workerReads = 0;
    const provider = new MockProvider({}, () => {
      providerCalls += 1;
      return providerCalls === 1
        ? 'not-json'
        : JSON.stringify({ action: 'delegate', target: 'finance-v2', confidence: 0.95, reason: 'live target' });
    });

    const result = await routeFrontdeskTurn({
      provider,
      config: config(),
      agentRoot: root,
      messages: [message('m1', 'check invoice')],
      getWorkers: () => {
        workerReads += 1;
        return workerReads === 1
          ? [{ name: 'finance-v1', displayName: 'Finance v1', type: 'agent' as const, agentGroupId: 'ag-v1' }]
          : [{ name: 'finance-v2', displayName: 'Finance v2', type: 'agent' as const, agentGroupId: 'ag-v2' }];
      },
    });

    expect(providerCalls).toBe(2);
    expect(workerReads).toBe(2);
    expect(result.decision).toMatchObject({
      action: 'delegate',
      target: 'finance-v2',
      targetAgentGroupId: 'ag-v2',
      attempts: 2,
    });
  });

  it('coerces a low-confidence delegate to the configured non-delegating action', async () => {
    const root = tempAgentRoot();
    const provider = new MockProvider({}, () =>
      JSON.stringify({ action: 'delegate', target: 'finance', confidence: 0.4, reason: 'maybe finance' }),
    );
    const result = await routeFrontdeskTurn({
      provider,
      config: config({ retryTimes: 0 }),
      agentRoot: root,
      messages: [message('m1', 'unclear request')],
      getWorkers: () => [{ name: 'finance', displayName: 'Finance', type: 'agent', agentGroupId: 'ag-finance' }],
    });
    expect(result.decision).toMatchObject({
      action: 'clarify',
      confidence: 0.4,
      source: 'fallback',
      fallbackReason: 'low_confidence',
    });
    expect(result.decision.target).toBeUndefined();
  });

  it('uses configured fallback after attempts are exhausted', async () => {
    const root = tempAgentRoot();
    const provider = new MockProvider({}, () => '{bad');
    const result = await routeFrontdeskTurn({
      provider,
      config: config({ retryTimes: 0, fallback: { action: 'reject' } }),
      agentRoot: root,
      messages: [message('m1', 'hello')],
      getWorkers: () => [],
    });
    expect(result.decision).toMatchObject({
      action: 'reject',
      confidence: 0,
      source: 'fallback',
      fallbackReason: 'invalid_json',
      attempts: 1,
    });
  });

  it('classifies provider generator failures as transport errors', async () => {
    const root = tempAgentRoot();
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query: () => ({
        push() {},
        pushSystemReminder() {},
        end() {},
        abort() {},
        events: {
          async *[Symbol.asyncIterator]() {
            throw new Error('upstream 503');
          },
        },
      }),
    };

    const result = await routeFrontdeskTurn({
      provider,
      config: config({ retryTimes: 0 }),
      agentRoot: root,
      messages: [message('m1', 'hello')],
      getWorkers: () => [],
    });

    expect(result.decision).toMatchObject({ source: 'fallback', fallbackReason: 'transport_error' });
  });

  it('does not retry a non-retryable provider error', async () => {
    const root = tempAgentRoot();
    let calls = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query: () => {
        calls += 1;
        return {
          push() {},
          pushSystemReminder() {},
          end() {},
          abort() {},
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'error' as const, message: 'quota exhausted', retryable: false, classification: 'quota' };
            },
          },
        };
      },
    };

    const result = await routeFrontdeskTurn({
      provider,
      config: config({ retryTimes: 3 }),
      agentRoot: root,
      messages: [message('m1', 'hello')],
      getWorkers: () => [],
    });

    expect(calls).toBe(1);
    expect(result.decision.attempts).toBe(1);
    expect(result.decision.fallbackReason).toBe('transport_error');
  });

  it('does not retry a missing routing prompt', async () => {
    const root = tempAgentRoot();
    fs.rmSync(path.join(root, 'prompts/frontdesk-routing.md'));
    let calls = 0;
    const provider = new MockProvider({}, () => {
      calls += 1;
      return JSON.stringify({ action: 'answer_self', confidence: 1, reason: 'unused' });
    });

    const result = await routeFrontdeskTurn({
      provider,
      config: config({ retryTimes: 3 }),
      agentRoot: root,
      messages: [message('m1', 'hello')],
      getWorkers: () => [],
    });

    expect(calls).toBe(0);
    expect(result.decision.attempts).toBe(1);
    expect(result.decision.fallbackReason).toBe('prompt_unavailable');
  });
});
