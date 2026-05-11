import { describe, expect, it } from 'bun:test';

import { classifyProviderError } from './poll-loop.js';

describe('classifyProviderError', () => {
  it('maps sessionInvalid=true to session_invalid regardless of message', () => {
    expect(classifyProviderError('anything at all', true)).toBe('session_invalid');
  });

  it('classifies 502/503/504 as gateway_5xx', () => {
    expect(classifyProviderError('OpenAI endpoint returned non-JSON response (502)', false)).toBe('gateway_5xx');
    expect(classifyProviderError('upstream returned 503', false)).toBe('gateway_5xx');
    expect(classifyProviderError('timed out 504', false)).toBe('gateway_5xx');
  });

  it('classifies timeouts', () => {
    expect(classifyProviderError('Request timed out after 30s', false)).toBe('timeout');
    expect(classifyProviderError('connection timeout', false)).toBe('timeout');
  });

  it('classifies 401 / 429 precisely', () => {
    expect(classifyProviderError('status 401', false)).toBe('unauthorized');
    expect(classifyProviderError('status 429 rate limited', false)).toBe('rate_limited');
  });

  it('classifies other 4xx / 5xx as generic buckets', () => {
    expect(classifyProviderError('request failed 403 forbidden', false)).toBe('client_4xx');
    expect(classifyProviderError('request failed 500 boom', false)).toBe('server_5xx');
  });

  it('classifies non-JSON responses', () => {
    expect(classifyProviderError('OpenAI endpoint returned non-JSON response', false)).toBe('bad_response');
  });

  it('falls back to unknown', () => {
    expect(classifyProviderError('weird transport error', false)).toBe('unknown');
  });

  it('prioritizes gateway_5xx over timeout when both appear', () => {
    // A 502 that also mentions timeout should still bucket as gateway — the
    // upstream status is the more actionable signal.
    expect(classifyProviderError('503 service timeout', false)).toBe('gateway_5xx');
  });
});
