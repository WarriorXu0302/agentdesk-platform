/**
 * Runner OTel bootstrap + bridge tests (ADR-0026).
 *
 * Covers:
 *   1. init gating: disabled / no-traceparent => false, never throws.
 *   2. parentContextFromEnv: extracted parent trace-id == injected trace-id
 *      (the end-to-end host->runner bridge core).
 *   3. span tree: a fake turn produces agent.turn with a provider.request
 *      child, both on the host trace id from OTEL_TRACEPARENT.
 *   4. fail-open: an unreachable exporter never blocks the turn.
 *   5. mcp span-name mapping stays inside the schema grammar.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { context, propagation, trace } from '@opentelemetry/api';

import { initRunnerObservability, shouldInitObservability } from './init.js';
import {
  MAX_CONTENT_ATTRIBUTE_CHARS,
  capContent,
  captureContentEnabled,
  getTracer,
  parentContextFromEnv,
  recordError,
} from './tracer.js';
import { mcpSpanName } from './mcp-span-name.js';

// A deterministic W3C traceparent: version-traceid(32hex)-spanid(16hex)-flags.
const HOST_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const HOST_SPAN_ID = 'b7ad6b7169203331';
const HOST_TRACEPARENT = `00-${HOST_TRACE_ID}-${HOST_SPAN_ID}-01`;

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncHooksContextManager;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  // Register as the global provider so getTracer() returns recording spans.
  trace.setGlobalTracerProvider(provider);
  // Production's NodeSDK registers the W3C propagator from OTEL_PROPAGATORS
  // (default tracecontext) at start; mirror that here so parentContextFromEnv
  // can extract the injected traceparent.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  // NodeSDK also registers an async-hooks context manager; without it
  // context.with() is a noop and parent linkage (the whole point) is lost.
  contextManager = new AsyncHooksContextManager().enable();
  context.setGlobalContextManager(contextManager);
});

afterEach(async () => {
  exporter.reset();
  contextManager.disable();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe('initRunnerObservability gating (fail-open)', () => {
  it('returns false and does not throw when OTEL_SDK_DISABLED=true', () => {
    expect(shouldInitObservability({ OTEL_SDK_DISABLED: 'true', OTEL_TRACEPARENT: HOST_TRACEPARENT })).toBe(false);
  });

  it('returns false when OTEL_TRACEPARENT is absent (host tracing off)', () => {
    expect(shouldInitObservability({})).toBe(false);
    // initRunnerObservability with a fresh env object must not throw either.
    expect(() => initRunnerObservability({})).not.toThrow();
  });

  it('would activate when a traceparent is present and not disabled', () => {
    expect(shouldInitObservability({ OTEL_TRACEPARENT: HOST_TRACEPARENT })).toBe(true);
  });
});

describe('parentContextFromEnv bridge', () => {
  it('extracts the host trace id from OTEL_TRACEPARENT', () => {
    const parent = parentContextFromEnv({ OTEL_TRACEPARENT: HOST_TRACEPARENT });
    const spanContext = trace.getSpanContext(parent);
    expect(spanContext?.traceId).toBe(HOST_TRACE_ID);
    expect(spanContext?.spanId).toBe(HOST_SPAN_ID);
  });

  it('falls back to active context when no traceparent', () => {
    const parent = parentContextFromEnv({});
    // No span context stamped => undefined (pure no-op path).
    expect(trace.getSpanContext(parent)).toBeUndefined();
  });
});

// Mirrors the production agent.turn + provider.request shape from poll-loop.ts
// without spinning up the whole loop. When `content` is provided AND the env
// opts content capture on, it stamps the same content attributes the real
// poll-loop / mcp server would, so the gating + cap behavior can be asserted
// here without a live container.
interface FakeContent {
  prompt: string;
  result: string;
  inputMessages: Array<{ role: string; content: string }>;
  outputText: string;
}

async function fakeTurn(env: NodeJS.ProcessEnv, content?: FakeContent): Promise<void> {
  const tracer = getTracer();
  const capture = captureContentEnabled(env);
  await context.with(parentContextFromEnv(env), () =>
    tracer.startActiveSpan('agent.turn', async (turnSpan) => {
      turnSpan.setAttribute('openinference.span.kind', 'AGENT');
      if (capture && content) {
        turnSpan.setAttribute('input.value', capContent(content.prompt));
        turnSpan.setAttribute('input.mime_type', 'text/plain');
      }
      try {
        tracer.startActiveSpan('provider.request', (llmSpan) => {
          llmSpan.setAttribute('openinference.span.kind', 'LLM');
          llmSpan.setAttribute('llm.model_name', 'test-model');
          if (capture && content) {
            content.inputMessages.forEach((m, i) => {
              llmSpan.setAttribute(`llm.input_messages.${i}.message.role`, m.role);
              llmSpan.setAttribute(`llm.input_messages.${i}.message.content`, capContent(m.content));
            });
            llmSpan.setAttribute('output.value', capContent(content.outputText));
            llmSpan.setAttribute('output.mime_type', 'text/plain');
          }
          llmSpan.end();
        });
        if (capture && content) {
          turnSpan.setAttribute('output.value', capContent(content.result));
          turnSpan.setAttribute('output.mime_type', 'text/plain');
        }
      } finally {
        turnSpan.end();
      }
    }),
  );
}

const SAMPLE_CONTENT: FakeContent = {
  prompt: 'what is the order status for PO-42?',
  result: 'Your order PO-42 shipped today.',
  inputMessages: [
    { role: 'system', content: 'you are a helpful assistant' },
    { role: 'user', content: 'what is the order status for PO-42?' },
  ],
  outputText: 'Your order PO-42 shipped today.',
};

describe('span tree on the host trace', () => {
  it('agent.turn carries the host trace id and parents provider.request', async () => {
    await fakeTurn({ OTEL_TRACEPARENT: HOST_TRACEPARENT });

    const spans: ReadableSpan[] = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === 'agent.turn');
    const llm = spans.find((s) => s.name === 'provider.request');

    expect(turn).toBeDefined();
    expect(llm).toBeDefined();

    // agent.turn joins the host trace.
    expect(turn?.spanContext().traceId).toBe(HOST_TRACE_ID);
    // agent.turn's parent is the host root span.
    expect(turn?.parentSpanId).toBe(HOST_SPAN_ID);
    // provider.request is a child of agent.turn, same trace.
    expect(llm?.spanContext().traceId).toBe(HOST_TRACE_ID);
    expect(llm?.parentSpanId).toBe(turn?.spanContext().spanId);
    expect(turn?.attributes['openinference.span.kind']).toBe('AGENT');
    expect(llm?.attributes['openinference.span.kind']).toBe('LLM');
  });
});

describe('captureContentEnabled gate (ADR-0027)', () => {
  it('is on only for the literal string "true"', () => {
    expect(captureContentEnabled({ OTEL_CAPTURE_CONTENT: 'true' })).toBe(true);
    expect(captureContentEnabled({ OTEL_CAPTURE_CONTENT: 'TRUE' })).toBe(false);
    expect(captureContentEnabled({ OTEL_CAPTURE_CONTENT: '1' })).toBe(false);
    expect(captureContentEnabled({ OTEL_CAPTURE_CONTENT: 'yes' })).toBe(false);
    expect(captureContentEnabled({})).toBe(false);
  });
});

describe('content capture on agent.turn + provider.request (ADR-0027)', () => {
  it('stamps full-plaintext input/output content when OTEL_CAPTURE_CONTENT=true', async () => {
    await fakeTurn({ OTEL_TRACEPARENT: HOST_TRACEPARENT, OTEL_CAPTURE_CONTENT: 'true' }, SAMPLE_CONTENT);

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === 'agent.turn');
    const llm = spans.find((s) => s.name === 'provider.request');

    // agent.turn carries the full prompt + result verbatim.
    expect(turn?.attributes['input.value']).toBe(SAMPLE_CONTENT.prompt);
    expect(turn?.attributes['input.mime_type']).toBe('text/plain');
    expect(turn?.attributes['output.value']).toBe(SAMPLE_CONTENT.result);
    expect(turn?.attributes['output.mime_type']).toBe('text/plain');

    // provider.request carries the LLM input messages + output verbatim.
    expect(llm?.attributes['llm.input_messages.0.message.role']).toBe('system');
    expect(llm?.attributes['llm.input_messages.0.message.content']).toBe('you are a helpful assistant');
    expect(llm?.attributes['llm.input_messages.1.message.role']).toBe('user');
    expect(llm?.attributes['llm.input_messages.1.message.content']).toBe(SAMPLE_CONTENT.inputMessages[1].content);
    expect(llm?.attributes['output.value']).toBe(SAMPLE_CONTENT.outputText);
  });

  it('emits ZERO content attributes when capture is off (metadata-only, pre-ADR-0027 behavior)', async () => {
    await fakeTurn({ OTEL_TRACEPARENT: HOST_TRACEPARENT }, SAMPLE_CONTENT);

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === 'agent.turn');
    const llm = spans.find((s) => s.name === 'provider.request');

    // Not a single content key on either span.
    expect(turn?.attributes['input.value']).toBeUndefined();
    expect(turn?.attributes['output.value']).toBeUndefined();
    expect(llm?.attributes['llm.input_messages.0.message.content']).toBeUndefined();
    expect(llm?.attributes['output.value']).toBeUndefined();

    // Metadata is still present — this is exactly the pre-ADR-0027 surface.
    expect(turn?.attributes['openinference.span.kind']).toBe('AGENT');
    expect(llm?.attributes['llm.model_name']).toBe('test-model');
  });
});

describe('capContent export-safety hard cap (ADR-0027, not redaction)', () => {
  it('passes through values within the cap unchanged', () => {
    expect(capContent('hello')).toBe('hello');
    const exact = 'x'.repeat(MAX_CONTENT_ATTRIBUTE_CHARS);
    expect(capContent(exact)).toBe(exact);
  });

  it('truncates oversized values and appends a <truncated> marker', () => {
    const huge = 'x'.repeat(MAX_CONTENT_ATTRIBUTE_CHARS + 5000);
    const capped = capContent(huge);
    expect(capped.length).toBe(MAX_CONTENT_ATTRIBUTE_CHARS + '…<truncated>'.length);
    expect(capped.startsWith('x'.repeat(MAX_CONTENT_ATTRIBUTE_CHARS))).toBe(true);
    expect(capped.endsWith('<truncated>')).toBe(true);
  });

  it('the cap reaches the span when content is oversized', async () => {
    const huge = 'y'.repeat(MAX_CONTENT_ATTRIBUTE_CHARS + 100);
    await fakeTurn(
      { OTEL_TRACEPARENT: HOST_TRACEPARENT, OTEL_CAPTURE_CONTENT: 'true' },
      { ...SAMPLE_CONTENT, prompt: huge },
    );
    const turn = exporter.getFinishedSpans().find((s) => s.name === 'agent.turn');
    const value = turn?.attributes['input.value'] as string;
    expect(value.endsWith('<truncated>')).toBe(true);
    expect(value.length).toBe(MAX_CONTENT_ATTRIBUTE_CHARS + '…<truncated>'.length);
  });
});

describe('fail-open: turn completes even if export work would fail', () => {
  it('completes the fake turn with no traceparent (noop spans), no throw', async () => {
    // No traceparent => parent is empty context; spans still record locally but
    // the turn body must run to completion regardless.
    let completed = false;
    await context.with(parentContextFromEnv({}), () =>
      getTracer().startActiveSpan('agent.turn', async (span) => {
        span.setAttribute('openinference.span.kind', 'AGENT');
        completed = true; // simulates markCompleted-style work
        span.end();
      }),
    );
    expect(completed).toBe(true);
  });

  it('recordError stamps ERROR status + failure category without throwing', () => {
    getTracer().startActiveSpan('agent.turn', (span) => {
      expect(() => recordError(span, new Error('boom'), 'agent_turn_error')).not.toThrow();
      span.end();
    });
    const turn = exporter.getFinishedSpans().find((s) => s.name === 'agent.turn');
    expect(turn?.status.code).toBe(2 /* SpanStatusCode.ERROR */);
    // brand-namespaced failure category present (default agentdesk).
    const categoryKey = Object.keys(turn?.attributes ?? {}).find((k) => k.endsWith('.failure.category'));
    expect(categoryKey).toBeDefined();
    expect(turn?.attributes[categoryKey as string]).toBe('agent_turn_error');
  });
});

describe('mcpSpanName grammar', () => {
  it('maps core tools to mcp.core.<tool>', () => {
    expect(mcpSpanName('send_message')).toBe('mcp.core.send_message');
    expect(mcpSpanName('add_reaction')).toBe('mcp.core.add_reaction');
  });

  it('maps gateway_* tools to mcp.erp.<slot>', () => {
    expect(mcpSpanName('gateway_execute')).toBe('mcp.erp.execute');
    expect(mcpSpanName('gateway_memory_get')).toBe('mcp.erp.memory_get');
  });

  it('always produces exactly 3 lowercase snake_case segments', () => {
    for (const tool of ['Weird-Name!', 'send_message', 'gateway_execute', '', 'a.b.c']) {
      const span = mcpSpanName(tool);
      const segments = span.split('.');
      expect(segments.length).toBe(3);
      expect(segments[0]).toBe('mcp');
      for (const seg of segments) {
        expect(seg).toMatch(/^[a-z0-9_]+$/);
      }
    }
  });
});
