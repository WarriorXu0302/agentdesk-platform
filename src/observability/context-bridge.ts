import type { Span, SpanContext } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';

/**
 * In-memory bridge: sessionId -> SpanContext
 *
 * Note: concurrent writes for the same sessionId result in last-write-wins.
 * This is an accepted lossy behavior for the current use case.
 */
const bridge = new Map<string, SpanContext>();

/**
 * Live root span bridge: sessionId -> Span
 *
 * Stores the actual Span instance so delivery can set output attributes
 * and end the span after all messages are delivered. The root span is
 * intentionally NOT ended by the router — its lifecycle extends until
 * delivery completes (or a safety timeout fires).
 */
const rootSpanBridge = new Map<string, Span>();

export function storeSessionSpanContext(sessionId: string, spanContext: SpanContext): void {
  bridge.set(sessionId, spanContext);
}

export function getSessionSpanContext(sessionId: string): SpanContext | undefined {
  return bridge.get(sessionId);
}

export function consumeSessionSpanContext(sessionId: string): SpanContext | undefined {
  const ctx = bridge.get(sessionId);
  if (ctx) {
    bridge.delete(sessionId);
  }
  return ctx;
}

export function clearSessionSpanContext(sessionId: string): void {
  bridge.delete(sessionId);
}

export function storeSessionRootSpan(sessionId: string, span: Span): void {
  rootSpanBridge.set(sessionId, span);
}

export function getSessionRootSpan(sessionId: string): Span | undefined {
  return rootSpanBridge.get(sessionId);
}

/**
 * End and remove the root span for a session. Sets output attributes,
 * marks OK, and calls span.end(). Safe to call multiple times (second
 * call is a no-op since the span is already removed from the map).
 */
export function endSessionRootSpan(sessionId: string, outputValue?: string): void {
  const span = rootSpanBridge.get(sessionId);
  if (!span) return;
  rootSpanBridge.delete(sessionId);

  if (outputValue !== undefined) {
    span.setAttribute('output.value', outputValue);
    span.setAttribute('output.mime_type', 'text/plain');
  }
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

/**
 * Force-end a root span on failure (e.g. container wake failed).
 */
export function failSessionRootSpan(sessionId: string, error?: string): void {
  const span = rootSpanBridge.get(sessionId);
  if (!span) return;
  rootSpanBridge.delete(sessionId);

  span.setStatus({ code: SpanStatusCode.ERROR, message: error ?? 'delivery failed' });
  span.end();
}
