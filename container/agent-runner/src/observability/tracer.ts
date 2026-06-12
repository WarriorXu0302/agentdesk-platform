/**
 * Runner-side tracer helpers (ADR-0026).
 *
 * Thin wrapper over the OTel API. When the SDK is not started (host tracing
 * off, see ./init.ts), `trace.getTracer()` returns a no-op tracer and every
 * helper here degrades to zero-cost noops — so callers never need an `if
 * (tracingEnabled)` guard around their instrumentation.
 *
 * The host->runner trace bridge is W3C-standard and travels through the
 * `OTEL_TRACEPARENT` env var (injected by the host at container spawn,
 * src/container-runner.ts) plus the in-process OTel active context. It does
 * NOT travel through SQLite — the three-DB single-writer invariant is
 * untouched by tracing.
 */
import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  type Tracer,
  type Span,
  type Context,
} from '@opentelemetry/api';

import { PLATFORM_PROTOCOL_NAMESPACE } from '../branding.js';

const TRACER_NAME = `${PLATFORM_PROTOCOL_NAMESPACE}-runner`;

/** OpenInference span-kind values used by the runner. */
export type RunnerSpanKind = 'AGENT' | 'LLM' | 'TOOL';

const OPENINFERENCE_SPAN_KIND = 'openinference.span.kind';

/** Tracer singleton — reads the global provider lazily (noop until SDK start). */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Build a parent OTel Context from the host-injected `OTEL_TRACEPARENT`.
 * Returns the active context when no carrier is present (pure no-op path).
 *
 * This is the single point where the host's trace id crosses the process
 * boundary: `propagation.extract` parses the W3C traceparent into a
 * SpanContext and stamps it onto the returned Context, so any span started
 * under `context.with(parentContextFromEnv(), ...)` becomes a child of the
 * host's session-root span (same trace id).
 */
export function parentContextFromEnv(env: NodeJS.ProcessEnv = process.env): Context {
  const traceparent = env.OTEL_TRACEPARENT;
  if (!traceparent) return context.active();
  const carrier: Record<string, string> = { traceparent };
  if (env.OTEL_TRACESTATE) carrier.tracestate = env.OTEL_TRACESTATE;
  return propagation.extract(context.active(), carrier);
}

/** Stamp the OpenInference semantic span kind. */
export function setKind(span: Span, kind: RunnerSpanKind): void {
  span.setAttribute(OPENINFERENCE_SPAN_KIND, kind);
}

/**
 * OTel + OpenInference compatible error recording (schema §9.3):
 * recordException + ERROR status + a stable business failure category under
 * the brand-namespaced key (default `agentdesk.failure.category`).
 */
export function recordError(span: Span, err: unknown, category: string): void {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error) {
    span.recordException(err);
  } else {
    span.recordException({ message });
  }
  span.setAttribute(`${PLATFORM_PROTOCOL_NAMESPACE}.failure.category`, category);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

export { context };
