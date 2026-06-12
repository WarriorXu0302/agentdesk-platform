import { context } from '@opentelemetry/api';
import { getAttributesFromContext } from '@arizeai/openinference-core';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { getActiveSpan } from './tracer.js';
import {
  MAX_OPENINFERENCE_TEXT_CHARS,
  MimeType,
  OpenInferenceSpanKind,
  SemanticConventions,
  applyContextAttrsToSpan,
  createSessionContext,
  outputAttrs,
  rootInputAttrs,
  runInDetachedRoot,
  safeAttributeText,
  setOutputAttrs,
  setRootAttrs,
  setSpanKind,
} from './openinference.js';
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

beforeEach(() => {
  exporter.reset();
});

describe('openinference helper', () => {
  test('createSessionContext adds session.id and optional user.id to context attributes', () => {
    const withUser = getAttributesFromContext(createSessionContext({ sessionId: 'sess-42', userId: 'user-7' }));

    expect(withUser[SemanticConventions.SESSION_ID]).toBe('sess-42');
    expect(withUser[SemanticConventions.USER_ID]).toBe('user-7');

    const withoutUser = getAttributesFromContext(createSessionContext({ sessionId: 'sess-43', userId: null }));

    expect(withoutUser[SemanticConventions.SESSION_ID]).toBe('sess-43');
    expect(withoutUser[SemanticConventions.USER_ID]).toBeUndefined();
  });

  test('safeAttributeText leaves short text unchanged', () => {
    const value = 'hello openinference';
    const result = safeAttributeText(value);

    expect(result).toEqual({ value, redacted: false });
  });

  test('safeAttributeText truncates long text and marks redaction', () => {
    const source = 'x'.repeat(4200);
    const result = safeAttributeText(source);

    expect(result.redacted).toBe(true);
    expect(result.value).toBe(`${source.slice(0, MAX_OPENINFERENCE_TEXT_CHARS)}…`);
    expect(result.value).toHaveLength(MAX_OPENINFERENCE_TEXT_CHARS + 1);
  });

  test('rootInputAttrs returns required root attrs and redaction only when truncated', () => {
    const shortAttrs = rootInputAttrs({
      sessionId: 'sess-42',
      userId: 'user-7',
      inputValue: 'hello PR-O2 phase 2 verify',
    });

    expect(shortAttrs[SemanticConventions.OPENINFERENCE_SPAN_KIND]).toBe(OpenInferenceSpanKind.AGENT);
    expect(shortAttrs[SemanticConventions.SESSION_ID]).toBe('sess-42');
    expect(shortAttrs[SemanticConventions.USER_ID]).toBe('user-7');
    expect(shortAttrs[SemanticConventions.INPUT_VALUE]).toBe('hello PR-O2 phase 2 verify');
    expect(shortAttrs[SemanticConventions.INPUT_MIME_TYPE]).toBe(MimeType.TEXT);
    expect(shortAttrs['attribute.redacted']).toBeUndefined();

    const longAttrs = rootInputAttrs({
      sessionId: 'sess-99',
      userId: 'user-9',
      inputValue: 'x'.repeat(4200),
    });

    expect(longAttrs['attribute.redacted']).toBe(true);
    expect(String(longAttrs[SemanticConventions.INPUT_VALUE])).toHaveLength(MAX_OPENINFERENCE_TEXT_CHARS + 1);
  });

  test('outputAttrs returns CHAIN kind plus output text attrs', () => {
    const textAttrs = outputAttrs('assistant reply');

    expect(textAttrs[SemanticConventions.OPENINFERENCE_SPAN_KIND]).toBe(OpenInferenceSpanKind.CHAIN);
    expect(textAttrs[SemanticConventions.OUTPUT_VALUE]).toBe('assistant reply');
    expect(textAttrs[SemanticConventions.OUTPUT_MIME_TYPE]).toBe(MimeType.TEXT);
    expect(textAttrs['attribute.redacted']).toBeUndefined();

    const jsonAttrs = outputAttrs('{"ok":true}', 'json');

    expect(jsonAttrs[SemanticConventions.OUTPUT_MIME_TYPE]).toBe(MimeType.JSON);
  });

  test('span attribute helpers apply context, root input, output, and kind attrs', async () => {
    await context.with(createSessionContext({ sessionId: 'sess-ctx', userId: 'user-ctx' }), async () => {
      await withSpan('test.openinference.helpers', undefined, async () => {
        const span = getActiveSpan();

        expect(span).toBeDefined();
        if (!span) return;

        setSpanKind(span, OpenInferenceSpanKind.CHAIN);
        applyContextAttrsToSpan(span);
        setRootAttrs(span, {
          sessionId: 'sess-ctx',
          userId: 'user-ctx',
          inputValue: 'input payload',
        });
        setOutputAttrs(span, 'output payload');
      });
    });

    const helperSpan = exporter.getFinishedSpans().find((span) => span.name === 'test.openinference.helpers');

    expect(helperSpan).toBeDefined();
    expect(helperSpan?.attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND]).toBe(OpenInferenceSpanKind.CHAIN);
    expect(helperSpan?.attributes[SemanticConventions.SESSION_ID]).toBe('sess-ctx');
    expect(helperSpan?.attributes[SemanticConventions.USER_ID]).toBe('user-ctx');
    expect(helperSpan?.attributes[SemanticConventions.INPUT_VALUE]).toBe('input payload');
    expect(helperSpan?.attributes[SemanticConventions.OUTPUT_VALUE]).toBe('output payload');
  });

  test('runInDetachedRoot starts a detached span in a separate trace from the active outer span', async () => {
    let outerTraceId: string | undefined;
    let outerSpanId: string | undefined;
    let innerTraceId: string | undefined;
    let restoredSpanId: string | undefined;

    await withSpan('test.openinference.outer', undefined, async () => {
      const outer = getActiveSpan();
      outerTraceId = outer?.spanContext().traceId;
      outerSpanId = outer?.spanContext().spanId;

      await runInDetachedRoot(() =>
        withSpan('test.openinference.inner', undefined, async () => {
          innerTraceId = getActiveSpan()?.spanContext().traceId;
        }),
      );

      restoredSpanId = getActiveSpan()?.spanContext().spanId;
    });

    expect(outerTraceId).toBeDefined();
    expect(innerTraceId).toBeDefined();
    expect(innerTraceId).not.toBe(outerTraceId);
    expect(restoredSpanId).toBe(outerSpanId);
  });
});
