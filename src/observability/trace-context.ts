import { trace, context, propagation } from '@opentelemetry/api';
import type { SpanContext, Context } from '@opentelemetry/api';

export { context };

export function setSpanContextWithActive(spanContext: SpanContext): Context {
  return trace.setSpanContext(context.active(), spanContext);
}

export function injectTraceContext(carrier: Record<string, string>): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  propagation.inject(trace.setSpanContext(context.active(), span.spanContext()), carrier);
}
