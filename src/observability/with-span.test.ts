import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { getActiveSpan } from './tracer.js';
import { withSpan } from './with-span.js';

const exporter = new tracing.InMemorySpanExporter();
const sdk = new NodeSDK({
  autoDetectResources: false,
  instrumentations: [],
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  sdk.start();
});

afterAll(async () => {
  await sdk.shutdown();
});

describe('withSpan', () => {
  test('preserves active parent context across nested async spans', async () => {
    let outerTraceId: string | undefined;
    let outerSpanId: string | undefined;
    let innerTraceId: string | undefined;
    let innerSpanId: string | undefined;
    let restoredSpanId: string | undefined;

    await withSpan('test.outer', undefined, async () => {
      const outer = getActiveSpan();
      outerTraceId = outer?.spanContext().traceId;
      outerSpanId = outer?.spanContext().spanId;

      await Promise.resolve();

      await withSpan('test.inner', undefined, async () => {
        const inner = getActiveSpan();
        innerTraceId = inner?.spanContext().traceId;
        innerSpanId = inner?.spanContext().spanId;

        await Promise.resolve();
      });

      restoredSpanId = getActiveSpan()?.spanContext().spanId;
    });

    expect(outerTraceId).toBeDefined();
    expect(outerSpanId).toBeDefined();
    expect(innerTraceId).toBe(outerTraceId);
    expect(innerSpanId).toBeDefined();
    expect(innerSpanId).not.toBe(outerSpanId);
    expect(restoredSpanId).toBe(outerSpanId);
  });
});
