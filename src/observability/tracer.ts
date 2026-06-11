import { trace, type Tracer, type Span } from '@opentelemetry/api';

import { PLATFORM_PROTOCOL_NAMESPACE } from '../branding.js';

const TRACER_NAME = `${PLATFORM_PROTOCOL_NAMESPACE}-host`;

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export function getActiveSpan(): Span | undefined {
  return trace.getActiveSpan();
}
