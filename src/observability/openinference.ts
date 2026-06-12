import { ROOT_CONTEXT, context } from '@opentelemetry/api';
import type { AttributeValue, Attributes, Context, Span } from '@opentelemetry/api';
import {
  getAttributesFromContext,
  getInputAttributes,
  getOutputAttributes,
  setSession,
  setUser,
} from '@arizeai/openinference-core';
import { MimeType, OpenInferenceSpanKind, SemanticConventions } from '@arizeai/openinference-semantic-conventions';

export { MimeType, OpenInferenceSpanKind, SemanticConventions };

export const MAX_OPENINFERENCE_TEXT_CHARS = 4096;

const REDACTED_ATTRIBUTE_KEY = 'attribute.redacted';

function isAttributeValue(value: unknown): value is AttributeValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) &&
      value.every((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'))
  );
}

function toSpanAttributes(attrs: Record<string, unknown>): Attributes {
  const result: Attributes = {};

  for (const [key, value] of Object.entries(attrs)) {
    if (isAttributeValue(value)) {
      result[key] = value;
    }
  }

  return result;
}

export function createSessionContext(opts: { sessionId: string; userId?: string | null }): Context {
  let currentContext = setSession(context.active(), { sessionId: opts.sessionId });

  if (opts.userId) {
    currentContext = setUser(currentContext, { userId: opts.userId });
  }

  return currentContext;
}

export function applyContextAttrsToSpan(span: Span): void {
  span.setAttributes(getAttributesFromContext(context.active()));
}

export function safeAttributeText(value: string): { value: string; redacted: boolean } {
  if (value.length <= MAX_OPENINFERENCE_TEXT_CHARS) {
    return { value, redacted: false };
  }

  return {
    value: `${value.slice(0, MAX_OPENINFERENCE_TEXT_CHARS)}…`,
    redacted: true,
  };
}

export function inputAttrsForText(inputValue: string): Record<string, unknown> {
  const safe = safeAttributeText(inputValue);
  const attrs = getInputAttributes({
    value: safe.value,
    mimeType: MimeType.TEXT,
  });

  return safe.redacted ? { ...attrs, [REDACTED_ATTRIBUTE_KEY]: true } : attrs;
}

export function chainAttrs(attrs: Record<string, unknown> = {}): Record<string, unknown> {
  const filteredAttrs = Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== undefined));

  return {
    [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
    ...filteredAttrs,
  };
}

export function agentAttrs(attrs: Record<string, unknown> = {}): Record<string, unknown> {
  const filteredAttrs = Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== undefined));

  return {
    [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
    ...filteredAttrs,
  };
}

export function rootInputAttrs(opts: {
  sessionId: string;
  userId?: string | null;
  inputValue: string;
}): Record<string, unknown> {
  return agentAttrs({
    'session.id': opts.sessionId,
    ...(opts.userId ? { 'user.id': opts.userId } : {}),
    ...inputAttrsForText(opts.inputValue),
  });
}

export function outputAttrs(output: string, mime: 'text' | 'json' = 'text'): Record<string, unknown> {
  const safe = safeAttributeText(output);
  const attrs = getOutputAttributes({
    value: safe.value,
    mimeType: mime === 'json' ? MimeType.JSON : MimeType.TEXT,
  });

  return chainAttrs(safe.redacted ? { ...attrs, [REDACTED_ATTRIBUTE_KEY]: true } : attrs);
}

export function setRootAttrs(
  span: Span,
  opts: { sessionId: string; userId?: string | null; inputValue: string },
): void {
  span.setAttributes(toSpanAttributes(rootInputAttrs(opts)));
}

export function setOutputAttrs(span: Span, output: string, mime: 'text' | 'json' = 'text'): void {
  span.setAttributes(toSpanAttributes(outputAttrs(output, mime)));
}

export function setSpanKind(span: Span, kind: OpenInferenceSpanKind): void {
  span.setAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, kind);
}

export async function runInDetachedRoot<T>(fn: () => Promise<T>): Promise<T> {
  return context.with(ROOT_CONTEXT, fn);
}
