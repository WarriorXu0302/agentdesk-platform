import { trace, type Tracer, type Span } from '@opentelemetry/api';

const TRACER_NAME = 'frontlane-host';

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export function getActiveSpan(): Span | undefined {
  return trace.getActiveSpan();
}
