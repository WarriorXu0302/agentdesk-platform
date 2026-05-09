import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb } from '../db/connection.js';
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
    expect(firstState.transcript).toHaveLength(4);

    const secondEvents = await runQuery(
      provider,
      'next turn',
      firstInit?.type === 'init' ? firstInit.continuation : undefined,
    );
    const secondResult = secondEvents.find((event) => event.type === 'result');

    expect(secondResult).toEqual({ type: 'result', text: 'second done' });
    expect(requests).toHaveLength(4);
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
});
