import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb } from '../db/connection.js';
import { getContinuation } from '../db/session-state.js';
import type { ProviderEvent } from './types.js';
import { OpenAIProvider } from './openai.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  initTestSessionDb();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function runQuery(provider: OpenAIProvider, prompt: string, continuation?: string): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  const query = provider.query({
    prompt,
    continuation,
    cwd: '/tmp',
  });

  for await (const event of query.events) {
    events.push(event);
  }

  return events;
}

describe('OpenAIProvider', () => {
  it('falls back to stateless replay when previous_response_id is unsupported', async () => {
    const requests: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);

      switch (requests.length) {
        case 1:
          expect(body.previous_response_id).toBeUndefined();
          return jsonResponse({
            id: 'resp_1',
            output: [
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'noop',
                arguments: '{}',
              },
            ],
          });
        case 2:
          expect(body.previous_response_id).toBe('resp_1');
          return jsonResponse(
            {
              error: {
                message: 'previous_response_id is only supported on Responses WebSocket v2',
              },
            },
            400,
          );
        case 3:
          expect(body.previous_response_id).toBeUndefined();
          expect(body.input).toEqual([
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'hello' }],
            },
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'noop',
              arguments: '{}',
            },
            {
              type: 'function_call_output',
              call_id: 'call_1',
              output: 'Unknown MCP tool: noop',
            },
          ]);
          return jsonResponse({
            id: 'resp_2',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'done' }],
              },
            ],
          });
        case 4:
          expect(body.previous_response_id).toBeUndefined();
          // F2: function_call + function_call_output entries are stripped from
          // the persisted continuation, so a cross-turn restore replays only
          // plain message turns. See stripStaleToolCallTranscript in openai.ts.
          expect(body.input).toEqual([
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'hello' }],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'done' }],
            },
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'next turn' }],
            },
          ]);
          return jsonResponse({
            id: 'resp_3',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'second done' }],
              },
            ],
          });
        default:
          throw new Error(`Unexpected request #${requests.length}`);
      }
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'https://example.com',
      },
    });

    const firstEvents = await runQuery(provider, 'hello');
    const firstInit = firstEvents.find((event) => event.type === 'init');
    const firstResult = firstEvents.find((event) => event.type === 'result');

    expect(firstInit?.type).toBe('init');
    expect(firstResult).toEqual({ type: 'result', text: 'done' });

    const firstState = JSON.parse(firstInit?.type === 'init' ? firstInit.continuation : '{}') as {
      mode?: string;
      transcript?: unknown[];
    };
    expect(firstState.mode).toBe('stateless');
    // F2: persisted transcript drops function_call/function_call_output so a
    // cross-restart restore can't replay orphan tool ids. The in-memory turn
    // above still saw all 4 items; only the serialized form is trimmed.
    expect(firstState.transcript).toHaveLength(2);

    const secondEvents = await runQuery(
      provider,
      'next turn',
      firstInit?.type === 'init' ? firstInit.continuation : undefined,
    );
    const secondResult = secondEvents.find((event) => event.type === 'result');

    expect(secondResult).toEqual({ type: 'result', text: 'second done' });
    expect(requests).toHaveLength(4);
  });

  it('F2: strips stale function_call entries when restoring a cross-session stateless continuation', async () => {
    const staleContinuation = JSON.stringify({
      v: 2,
      mode: 'stateless',
      transport: 'responses',
      transcript: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'yesterday hi' }],
        },
        {
          type: 'function_call',
          call_id: 'call_stale_abc',
          name: 'mcp__agentdesk__web_fetch',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_stale_abc',
          output: 'stale tool result from a previous day',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'yesterday done' }],
        },
      ],
    });

    const requests: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);

      // The replayed transcript must NOT carry the stale tool_call/tool_output;
      // otherwise the upstream API rejects with "tool result's tool id not found".
      const input = body.input as Array<Record<string, unknown>>;
      for (const item of input) {
        expect(item.type).not.toBe('function_call');
        expect(item.type).not.toBe('function_call_output');
      }
      expect(input.map((item) => item.type)).toEqual(['message', 'message', 'message']);

      return jsonResponse({
        id: 'resp_recovered',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'recovered' }],
          },
        ],
      });
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'https://example.com',
      },
    });

    const events = await runQuery(provider, 'today hi', staleContinuation);
    const result = events.find((event) => event.type === 'result');
    const init = events.find((event) => event.type === 'init');

    expect(result).toEqual({ type: 'result', text: 'recovered' });
    expect(requests).toHaveLength(1);

    // Persisted continuation must also stay clean for the next restore.
    const nextState = JSON.parse(init?.type === 'init' ? init.continuation : '{}') as {
      transcript?: Array<{ type?: string }>;
    };
    for (const item of nextState.transcript ?? []) {
      expect(item.type).not.toBe('function_call');
      expect(item.type).not.toBe('function_call_output');
    }
  });

  it('F2: strips stale function_call entries when restoring a chat-completions stateless continuation', async () => {
    const staleContinuation = JSON.stringify({
      v: 2,
      mode: 'stateless',
      transport: 'chat-completions',
      transcript: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'yesterday hi' }],
        },
        {
          type: 'function_call',
          call_id: 'call_stale_chat',
          name: 'noop',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_stale_chat',
          output: 'stale tool output',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'yesterday done' }],
        },
      ],
    });

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });

      // Must route to chat-completions endpoint (restored transport).
      expect(url).toContain('/chat/completions');

      // After F2 strip, no message should carry a tool_calls array or be a
      // role=tool entry, since MiniMax would reject those for an unknown id.
      const messages = body.messages as Array<Record<string, unknown>>;
      for (const m of messages) {
        expect(m.tool_calls).toBeUndefined();
        expect(m.role).not.toBe('tool');
        expect(m.tool_call_id).toBeUndefined();
      }
      // Only the three plain message turns remain (old user / old assistant / new user).
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

      return jsonResponse({
        id: 'chatcmpl_recovered',
        choices: [
          {
            message: { role: 'assistant', content: 'recovered' },
            finish_reason: 'stop',
          },
        ],
      });
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'https://example.com',
      },
    });

    const events = await runQuery(provider, 'today hi', staleContinuation);
    const result = events.find((event) => event.type === 'result');

    expect(result).toEqual({ type: 'result', text: 'recovered' });
    expect(requests).toHaveLength(1);
  });

  it('falls back from responses to chat completions when the gateway returns 502', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });

      if (url.endsWith('/responses')) {
        return new Response('<html>bad gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        });
      }

      if (url.endsWith('/chat/completions')) {
        expect(body.messages).toEqual([
          {
            role: 'user',
            content: 'hello',
          },
        ]);
        return jsonResponse({
          id: 'chatcmpl_1',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'pong',
              },
              finish_reason: 'stop',
            },
          ],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'https://example.com',
      },
    });

    const events = await runQuery(provider, 'hello');
    const init = events.find((event) => event.type === 'init');
    const result = events.find((event) => event.type === 'result');

    expect(result).toEqual({ type: 'result', text: 'pong' });
    expect(init?.type).toBe('init');

    const state = JSON.parse(init?.type === 'init' ? init.continuation : '{}') as {
      transport?: string;
      mode?: string;
    };
    expect(state.transport).toBe('chat-completions');
    expect(state.mode).toBe('stateless');
    expect(requests.map((request) => request.url)).toEqual([
      'https://example.com/v1/responses',
      'https://example.com/v1/responses',
      'https://example.com/v1/responses',
      'https://example.com/v1/chat/completions',
    ]);
  });

  // ── Summary-based context compaction (ADR-0024) ──

  // The compaction soft threshold is 150_000 chars of serialized transcript.
  // Build a stored continuation whose transcript is large enough to trip it.
  // We keep each item small but pad enough plain `message` items to cross the
  // threshold. Plain messages also survive stripStaleToolCallTranscript so the
  // restore is faithful.
  function bigMessageTranscript(itemCount: number, charsPerItem: number): Array<Record<string, unknown>> {
    const filler = 'x'.repeat(charsPerItem);
    const items: Array<Record<string, unknown>> = [];
    for (let i = 0; i < itemCount; i += 1) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      const blockType = role === 'user' ? 'input_text' : 'output_text';
      items.push({
        type: 'message',
        role,
        content: [{ type: blockType, text: `turn ${i} ${filler}` }],
      });
    }
    return items;
  }

  function statelessContinuation(transcript: Array<Record<string, unknown>>): string {
    return JSON.stringify({ v: 2, mode: 'stateless', transport: 'responses', transcript });
  }

  it('triggers summary compaction over the soft threshold and replaces the old window', async () => {
    // ~30 items * ~6_000 chars ≈ 180k chars, comfortably over 150k.
    const stored = bigMessageTranscript(30, 6_000);

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });

      // The summary call hits chat/completions first (no tools, compact model).
      if (url.endsWith('/chat/completions')) {
        expect(body.tools).toBeUndefined();
        return jsonResponse({
          id: 'chatcmpl_summary',
          choices: [{ message: { role: 'assistant', content: 'SUMMARY OF OLD WINDOW' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 },
        });
      }

      // The main turn then runs as a stateless /responses replay.
      if (url.endsWith('/responses')) {
        const replay = body.input as Array<Record<string, unknown>>;
        // First item is the compacted summary message.
        const first = replay[0];
        const firstText = (first.content as Array<{ text?: string }>)[0]?.text ?? '';
        expect(firstText).toContain('<compacted_summary>');
        expect(firstText).toContain('SUMMARY OF OLD WINDOW');
        // Old window collapsed to a single summary message; replay is far
        // shorter than the 30 stored items + the new prompt.
        expect(replay.length).toBeLessThan(30);
        return jsonResponse({
          id: 'resp_compacted',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after compaction' }] }],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://example.com' },
    });

    const events = await runQuery(provider, 'newest message', statelessContinuation(stored));

    const initIdx = events.findIndex((e) => e.type === 'init');
    const compactedIdx = events.findIndex((e) => e.type === 'compacted');
    const resultIdx = events.findIndex((e) => e.type === 'result');

    // compacted fires after init and before result.
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(compactedIdx).toBeGreaterThan(initIdx);
    expect(resultIdx).toBeGreaterThan(compactedIdx);

    const compacted = events[compactedIdx];
    expect(compacted.type === 'compacted' && compacted.text).toContain('Context compacted');
    // The compaction summary rides the event so the poll-loop can flush it to
    // durable memory (ADR-0041). It's the same text compaction already spent —
    // no extra model call.
    expect(compacted.type === 'compacted' && compacted.summary).toBe('SUMMARY OF OLD WINDOW');

    const result = events.find((e) => e.type === 'result');
    expect(result).toEqual({ type: 'result', text: 'after compaction' });

    // First request was the summary; second was the compacted main turn.
    expect(calls[0].url).toContain('/chat/completions');
    expect(calls[1].url).toContain('/responses');
  });

  it('compacts a "few but huge" transcript (over char threshold, under item count)', async () => {
    // 6 items * ~28k chars ≈ 168k (over the 150k trigger) but only 6 items —
    // well under KEEP_RECENT_ITEMS=20. The old item-count-only boundary skipped
    // compaction here and silently hard-trimmed; the char-budget boundary must
    // now summarize the oldest large items instead (ADR-0024 review fix).
    const stored = bigMessageTranscript(6, 28_000);

    const calls: Array<{ url: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url });
      if (url.endsWith('/chat/completions')) {
        return jsonResponse({
          id: 'chatcmpl_summary',
          choices: [{ message: { role: 'assistant', content: 'SUMMARY OF OLD WINDOW' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 },
        });
      }
      if (url.endsWith('/responses')) {
        const replay = init ? (JSON.parse(String(init.body)).input as Array<Record<string, unknown>>) : [];
        const firstText = (replay[0]?.content as Array<{ text?: string }>)?.[0]?.text ?? '';
        // The oldest large items were summarized, not silently dropped.
        expect(firstText).toContain('<compacted_summary>');
        return jsonResponse({
          id: 'resp_compacted',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://example.com' },
    });

    const events = await runQuery(provider, 'newest message', statelessContinuation(stored));

    // The summary call fired and a compacted event was emitted — NOT a silent
    // hard-trim (the pre-fix behavior in this scenario).
    expect(calls[0].url).toContain('/chat/completions');
    expect(events.some((e) => e.type === 'compacted')).toBe(true);
    expect(events.find((e) => e.type === 'result')).toEqual({ type: 'result', text: 'done' });
  });

  it('does not compact or emit compacted under the threshold', async () => {
    const calls: Array<{ url: string }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url });
      JSON.parse(String(init?.body));
      // Only the main turn should run — no summary call.
      return jsonResponse({
        id: 'resp_small',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      });
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://example.com' },
    });

    const events = await runQuery(provider, 'short');

    expect(events.some((e) => e.type === 'compacted')).toBe(false);
    expect(events.find((e) => e.type === 'result')).toEqual({ type: 'result', text: 'ok' });
    // Exactly one request: the main turn. No /chat/completions summary call.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/responses');
  });

  it('keeps tool-call pairs together at the compaction boundary (no orphan call_id)', async () => {
    // Build a big transcript whose recent window opens with a tool pair so the
    // boundary code must pull the function_call into the recent window.
    const stored = bigMessageTranscript(40, 5_000);
    // Append a contiguous function_call + function_call_output pair near the
    // tail (within the would-be KEEP_RECENT_ITEMS window). These plain pairs
    // are exactly what must not be split.
    stored.push(
      { type: 'function_call', call_id: 'call_boundary', name: 'noop', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_boundary', output: 'tool result' },
    );

    let summaryInput: Array<Record<string, unknown>> | null = null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

      if (url.endsWith('/chat/completions')) {
        summaryInput = body.messages as Array<Record<string, unknown>>;
        return jsonResponse({
          id: 'chatcmpl_summary',
          choices: [{ message: { role: 'assistant', content: 'SUMMARY' }, finish_reason: 'stop' }],
        });
      }

      if (url.endsWith('/responses')) {
        const replay = body.input as Array<Record<string, unknown>>;
        // Every function_call_output in the replay must have its originating
        // function_call earlier in the same replay — no orphans.
        const callIds = new Set<string>();
        for (const item of replay) {
          if (item.type === 'function_call') callIds.add(item.call_id as string);
          if (item.type === 'function_call_output') {
            expect(callIds.has(item.call_id as string)).toBe(true);
          }
        }
        return jsonResponse({
          id: 'resp_ok',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://example.com' },
    });

    const events = await runQuery(provider, 'newest', statelessContinuation(stored));
    expect(events.some((e) => e.type === 'compacted')).toBe(true);
    expect(events.find((e) => e.type === 'result')).toEqual({ type: 'result', text: 'done' });

    // The summary call must NOT have been fed a dangling tool pair either —
    // transcriptToChatMessages keeps call/output together, but the boundary
    // means the pair stays in the recent window, so the summary's old window
    // should not reference call_boundary.
    expect(summaryInput).not.toBeNull();
    const summaryText = JSON.stringify(summaryInput);
    expect(summaryText).not.toContain('call_boundary');
  });

  it('forces stateless replay after compacting a responses+responseId continuation', async () => {
    // Stored as responses transport WITH a responseId — i.e. the backend would
    // normally let us continue via previous_response_id. After local
    // compaction we must drop it and replay the full transcript.
    const stored = bigMessageTranscript(30, 6_000);
    const continuation = JSON.stringify({
      v: 2,
      mode: 'responses',
      transport: 'responses',
      responseId: 'resp_prev_stored',
      transcript: stored,
    });

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });

      if (url.endsWith('/chat/completions')) {
        return jsonResponse({
          id: 'chatcmpl_summary',
          choices: [{ message: { role: 'assistant', content: 'SUMMARY' }, finish_reason: 'stop' }],
        });
      }

      if (url.endsWith('/responses')) {
        // Compaction forces stateless: no previous_response_id, full input array.
        expect(body.previous_response_id).toBeUndefined();
        expect(Array.isArray(body.input)).toBe(true);
        return jsonResponse({
          id: 'resp_new',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://example.com' },
    });

    const events = await runQuery(provider, 'newest', continuation);
    const init = events.find((e) => e.type === 'init');

    expect(events.some((e) => e.type === 'compacted')).toBe(true);
    const state = JSON.parse(init?.type === 'init' ? init.continuation : '{}') as {
      mode?: string;
      responseId?: string;
    };
    expect(state.mode).toBe('stateless');
    // Persisted continuation no longer carries the old server response id.
    expect(state.responseId).toBeUndefined();
  });

  it('falls back to hard trim and still completes when the summary call fails', async () => {
    const stored = bigMessageTranscript(30, 6_000);

    const calls: Array<{ url: string }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url });
      JSON.parse(String(init?.body));

      if (url.endsWith('/chat/completions')) {
        // Summary call fails hard (non-retryable 400).
        return jsonResponse({ error: { message: 'summary model unavailable' } }, 400);
      }

      if (url.endsWith('/responses')) {
        return jsonResponse({
          id: 'resp_trimmed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'still done' }] }],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://example.com' },
    });

    const events = await runQuery(provider, 'newest', statelessContinuation(stored));

    // No compacted event on fallback; the turn still completes via hard trim.
    expect(events.some((e) => e.type === 'compacted')).toBe(false);
    expect(events.find((e) => e.type === 'result')).toEqual({ type: 'result', text: 'still done' });
    // Summary attempted (and failed), then the main turn ran anyway.
    expect(calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/responses'))).toBe(true);
  });

  // ── Stream-reanchor reminder after compaction (task C) ──
  //
  // When OpenAI compacts and the session has >1 destination, the poll-loop
  // reacts to the `compacted` event by injecting a destination reminder. That
  // reminder MUST NOT re-run runTurn (a full extra LLM call + extra
  // provider.request span + possible re-compaction). pushSystemReminder folds
  // it into the NEXT real turn's transcript instead.
  it('pushSystemReminder after compaction does not trigger an extra LLM call and rides into the next real turn', async () => {
    const stored = bigMessageTranscript(30, 6_000);

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });

      if (url.endsWith('/chat/completions')) {
        return jsonResponse({
          id: 'chatcmpl_summary',
          choices: [{ message: { role: 'assistant', content: 'SUMMARY OF OLD WINDOW' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 },
        });
      }
      if (url.endsWith('/responses')) {
        return jsonResponse({
          id: `resp_${calls.length}`,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after compaction' }] }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://example.com' },
    });

    // Drive the stream the way the poll-loop does: when a `compacted` event
    // arrives mid-stream, synchronously call pushSystemReminder on the live
    // query handle. The reminder must NOT add another LLM call.
    const query = provider.query({ prompt: 'newest message', continuation: statelessContinuation(stored), cwd: '/tmp' });
    const events: ProviderEvent[] = [];
    let sawCompacted = false;
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'compacted') {
        sawCompacted = true;
        query.pushSystemReminder(
          '[system] Context was just compacted. Reminder: you have 2 destinations (alpha, beta). ' +
            'Use <message to="name"> blocks to address them. Bare text goes to the scratchpad fallback only.',
        );
      }
    }

    expect(sawCompacted).toBe(true);
    // Compaction fired exactly two LLM calls this turn: the summary
    // (chat/completions) and the compacted main turn (responses). The reminder
    // injected mid-stream added NO third call.
    const callCountAfterFirstTurn = calls.length;
    expect(callCountAfterFirstTurn).toBe(2);
    expect(calls[0].url).toContain('/chat/completions');
    expect(calls[1].url).toContain('/responses');
    expect(events.find((e) => e.type === 'result')).toEqual({ type: 'result', text: 'after compaction' });

    // The reminder is durable: pushSystemReminder re-persists the continuation
    // (per-provider) with the reminder folded in. The next poll-loop iteration
    // restores from exactly this persisted continuation — read it back the same
    // way the runner would.
    const nextContinuation = getContinuation('openai');
    expect(nextContinuation).toBeDefined();

    // Now run the NEXT real turn restoring from that continuation. The reminder
    // must appear verbatim in the replayed input the model actually sees.
    calls.length = 0;
    const secondEvents = await runQuery(provider, 'next real user message', nextContinuation);
    expect(secondEvents.find((e) => e.type === 'result')).toBeDefined();

    // The next real turn made its own LLM call(s); find the one carrying the
    // replayed transcript and assert the reminder rode along.
    const replayCall = calls.find((c) => c.url.endsWith('/responses') || c.url.endsWith('/chat/completions'));
    expect(replayCall).toBeDefined();
    const serialized = JSON.stringify(replayCall!.body);
    expect(serialized).toContain('Context was just compacted');
    expect(serialized).toContain('2 destinations');
    // ...and the new real user message is also present.
    expect(serialized).toContain('next real user message');
  });

  it('pushSystemReminder is idempotent-safe and never aborts an in-flight turn', async () => {
    // A small (non-compacting) turn. Even outside compaction, calling
    // pushSystemReminder must not abort the running turn or add an LLM call.
    const calls: Array<{ url: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url });
      JSON.parse(String(init?.body));
      return jsonResponse({
        id: 'resp_small',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      });
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://example.com' },
    });

    const query = provider.query({ prompt: 'hello', cwd: '/tmp' });
    const events: ProviderEvent[] = [];
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'init') {
        // Inject a reminder mid-stream — must be a no-op for LLM traffic.
        query.pushSystemReminder('[system] reanchor reminder');
      }
    }

    expect(events.find((e) => e.type === 'result')).toEqual({ type: 'result', text: 'ok' });
    // Exactly one LLM call — the reminder added none and did not spawn a turn.
    expect(calls).toHaveLength(1);
  });

  it('emits a usage event for the summary call using the compact model', async () => {
    const stored = bigMessageTranscript(30, 6_000);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      JSON.parse(String(init?.body));

      if (url.endsWith('/chat/completions')) {
        return jsonResponse({
          id: 'chatcmpl_summary',
          choices: [{ message: { role: 'assistant', content: 'SUMMARY' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2000, completion_tokens: 80, total_tokens: 2080 },
        });
      }

      if (url.endsWith('/responses')) {
        return jsonResponse({
          id: 'resp_ok',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
          usage: { input_tokens: 500, output_tokens: 30, total_tokens: 530 },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'https://example.com',
        OPENAI_MODEL: 'gpt-main',
        OPENAI_COMPACT_MODEL: 'gpt-cheap',
      },
    });

    const events = await runQuery(provider, 'newest', statelessContinuation(stored));
    const usages = events.filter((e): e is Extract<ProviderEvent, { type: 'usage' }> => e.type === 'usage');

    // One usage from the summary call (compact model), one from the main turn.
    const summaryUsage = usages.find((u) => u.model === 'gpt-cheap');
    const mainUsage = usages.find((u) => u.model === 'gpt-main');
    expect(summaryUsage).toBeDefined();
    expect(summaryUsage?.transport).toBe('chat-completions');
    expect(summaryUsage?.inputTokens).toBe(2000);
    expect(mainUsage).toBeDefined();
  });
});

describe('OpenAIProvider vault mode (ADR-0035)', () => {
  it('requires no API key and sends NO Authorization header (the OneCLI vault injects it)', async () => {
    const capturedHeaders: Record<string, string> = {};
    let url = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      const raw = init?.headers ?? {};
      if (raw instanceof Headers) {
        raw.forEach((value, key) => {
          capturedHeaders[key.toLowerCase()] = value;
        });
      } else {
        for (const [key, value] of Object.entries(raw as Record<string, string>)) {
          capturedHeaders[String(key).toLowerCase()] = String(value);
        }
      }
      return jsonResponse({
        id: 'resp_1',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
      });
    }) as typeof fetch;

    // No OPENAI_API_KEY — vault mode must not throw on the missing key.
    const provider = new OpenAIProvider({
      env: { OPENAI_CREDENTIAL_VIA_PROXY: 'true', OPENAI_BASE_URL: 'https://api.openai.example' },
    });

    const events = await runQuery(provider, 'hello');
    const result = events.find((event) => event.type === 'result');
    expect(result).toEqual({ type: 'result', text: 'done' });
    // Routed to the real OpenAI host (HTTPS_PROXY → vault redirects transparently).
    expect(url).toContain('https://api.openai.example');
    // The container sends no auth of its own; content-type still set.
    expect(capturedHeaders['authorization']).toBeUndefined();
    expect(capturedHeaders['content-type']).toBe('application/json');
  });

  it('direct mode still sends Authorization: Bearer <key>', async () => {
    const capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const raw = init?.headers ?? {};
      for (const [key, value] of Object.entries(raw as Record<string, string>)) {
        capturedHeaders[String(key).toLowerCase()] = String(value);
      }
      return jsonResponse({
        id: 'resp_1',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
      });
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      env: { OPENAI_API_KEY: 'sk-direct', OPENAI_BASE_URL: 'https://api.openai.example' },
    });
    await runQuery(provider, 'hello');
    expect(capturedHeaders['authorization']).toBe('Bearer sk-direct');
  });
});
