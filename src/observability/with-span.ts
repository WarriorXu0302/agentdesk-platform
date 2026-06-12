import { Attributes, SpanStatusCode } from '@opentelemetry/api';

import { getTracer } from './tracer.js';

export async function withSpan<T>(
  name: string,
  attributes: Record<string, unknown> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = getTracer();

  return tracer.startActiveSpan(name, { attributes: attributes as Attributes | undefined }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result as T;
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      } else {
        span.recordException(new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

export function withSpanSync<T>(name: string, attributes: Record<string, unknown> | undefined, fn: () => T): T {
  const tracer = getTracer();

  return tracer.startActiveSpan(name, { attributes: attributes as Attributes | undefined }, (span) => {
    try {
      const result = fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result as T;
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      } else {
        span.recordException(new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      }
      throw error;
    } finally {
      span.end();
    }
  });
}
