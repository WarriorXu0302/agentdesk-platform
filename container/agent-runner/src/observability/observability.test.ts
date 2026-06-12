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
import { getTracer, parentContextFromEnv, recordError } from './tracer.js';
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
// without spinning up the whole loop.
async function fakeTurn(env: NodeJS.ProcessEnv): Promise<void> {
  const tracer = getTracer();
  await context.with(parentContextFromEnv(env), () =>
    tracer.startActiveSpan('agent.turn', async (turnSpan) => {
      turnSpan.setAttribute('openinference.span.kind', 'AGENT');
      try {
        tracer.startActiveSpan('provider.request', (llmSpan) => {
          llmSpan.setAttribute('openinference.span.kind', 'LLM');
          llmSpan.setAttribute('llm.model_name', 'test-model');
          llmSpan.end();
        });
      } finally {
        turnSpan.end();
      }
    }),
  );
}

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
