import { describe, expect, it } from 'bun:test';

import { claudeUsageEvent } from './claude-usage.js';

describe('claudeUsageEvent (ADR-0026 Claude LLM span)', () => {
  it('builds a usage event from a realistic SDK result message', () => {
    const event = claudeUsageEvent({
      usage: {
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 100,
      },
      modelUsage: { 'claude-opus-4-8': { inputTokens: 2000, outputTokens: 340 } },
      duration_api_ms: 4200,
      duration_ms: 5000,
    });
    expect(event).not.toBeNull();
    expect(event!.type).toBe('usage');
    expect(event!.model).toBe('claude-opus-4-8');
    // prompt tokens include the cache read/creation halves
    expect(event!.inputTokens).toBe(1200 + 800 + 100);
    expect(event!.outputTokens).toBe(340);
    expect(event!.totalTokens).toBe(2100 + 340);
    // prefers duration_api_ms over duration_ms
    expect(event!.durationMs).toBe(4200);
    expect(event!.transport).toBe('claude-agent-sdk');
  });

  it('falls back to duration_ms when duration_api_ms is absent', () => {
    const event = claudeUsageEvent({
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: { 'claude-opus-4-8': {} },
      duration_ms: 999,
    });
    expect(event!.durationMs).toBe(999);
  });

  it('joins multiple models (e.g. a separate compaction model)', () => {
    const event = claudeUsageEvent({
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { 'claude-opus-4-8': {}, 'claude-haiku-4-5': {} },
    });
    expect(event!.model).toBe('claude-opus-4-8+claude-haiku-4-5');
  });

  it('defaults the model to "claude" when modelUsage is empty', () => {
    const event = claudeUsageEvent({ usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} });
    expect(event!.model).toBe('claude');
  });

  it('omits durationMs when no duration is present', () => {
    const event = claudeUsageEvent({ usage: { input_tokens: 1, output_tokens: 1 } });
    expect(event!.durationMs).toBeUndefined();
  });

  it('returns null when the SDK exposed no usage/modelUsage (older SDK)', () => {
    expect(claudeUsageEvent({})).toBeNull();
    expect(claudeUsageEvent({ duration_ms: 100 })).toBeNull();
  });

  it('treats missing/garbage token fields as zero rather than throwing', () => {
    const event = claudeUsageEvent({ usage: { input_tokens: 'oops', output_tokens: -3 } as never });
    expect(event!.inputTokens).toBe(0);
    expect(event!.outputTokens).toBe(0);
    expect(event!.totalTokens).toBe(0);
  });
});
