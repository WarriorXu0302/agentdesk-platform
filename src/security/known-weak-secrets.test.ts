/**
 * Tests for the known-weak secret deny-list (ADR-0025).
 *
 * Guards the zero-regression core: placeholders shipped in `.env.example` and
 * lazy throwaways are rejected; real random secrets pass; the empty string is
 * NOT treated as weak (that's config-validate's "is it set?" concern).
 */
import { describe, expect, it } from 'vitest';

import { KNOWN_WEAK_SECRET_PLACEHOLDERS, assertSecretNotKnownWeak, isKnownWeakSecret } from './known-weak-secrets.js';

describe('isKnownWeakSecret', () => {
  it('flags exact .env.example secret placeholders', () => {
    for (const v of [
      'replace-me-openssl-rand-hex-32',
      'replace-me-metrics-auth-token',
      'replace-me-onecli-api-key',
      'replace-me-feishu-encrypt-key',
      'replace-me-feishu-verification-token',
      'your-feishu-app-secret',
      'sk-your-openai-api-key',
    ]) {
      expect(isKnownWeakSecret(v)).toBe(true);
    }
  });

  it('flags universally-weak throwaway values', () => {
    for (const v of ['changeme', 'secret', 'password', 'test', 'xxx', 'placeholder', 'admin']) {
      expect(isKnownWeakSecret(v)).toBe(true);
    }
  });

  it('normalizes case and surrounding whitespace before matching', () => {
    expect(isKnownWeakSecret('  ChangeMe  ')).toBe(true);
    expect(isKnownWeakSecret('CHANGEME')).toBe(true);
    expect(isKnownWeakSecret('Replace-Me-OpenSSL-Rand-Hex-32')).toBe(true);
  });

  it('flags templated placeholder shapes via pattern', () => {
    expect(isKnownWeakSecret('your-thing-here')).toBe(true);
    expect(isKnownWeakSecret('replace-me-anything-else')).toBe(true);
    expect(isKnownWeakSecret('your-custom-token')).toBe(true);
  });

  it('passes real random-looking secrets', () => {
    // e.g. `openssl rand -hex 32`
    expect(isKnownWeakSecret('3f9a1c0b7e2d4a8f6c5b9e1d2a7f4c8b3e6d9a0c1f2b4e7d8a9c0b1e2f3a4d5c')).toBe(false);
    expect(isKnownWeakSecret('sk-proj-9XzQ2mTn4pVbWcKdReFgHjLm')).toBe(false);
    expect(isKnownWeakSecret('cli_a7f3c9d1e2b4')).toBe(false);
  });

  it('does NOT treat empty/whitespace as weak (that is config-validate concern)', () => {
    expect(isKnownWeakSecret('')).toBe(false);
    expect(isKnownWeakSecret('   ')).toBe(false);
  });

  it('exposes a normalized sentinel set with the expected members', () => {
    expect(KNOWN_WEAK_SECRET_PLACEHOLDERS.has('changeme')).toBe(true);
    expect(KNOWN_WEAK_SECRET_PLACEHOLDERS.has('replace-me-openssl-rand-hex-32')).toBe(true);
    // Stored normalized (lowercase) — a member is matched case-insensitively.
    expect(KNOWN_WEAK_SECRET_PLACEHOLDERS.has('CHANGEME')).toBe(false);
    expect(isKnownWeakSecret('CHANGEME')).toBe(true);
  });
});

describe('assertSecretNotKnownWeak', () => {
  it('throws with the variable name and a generate hint on a weak value', () => {
    expect(() => assertSecretNotKnownWeak('GATEWAY_SIGNING_KEY', 'changeme')).toThrow(/GATEWAY_SIGNING_KEY/);
    expect(() => assertSecretNotKnownWeak('GATEWAY_SIGNING_KEY', 'changeme')).toThrow(/openssl rand -hex 32/);
  });

  it('throws on the exact placeholder shipped for that variable', () => {
    expect(() => assertSecretNotKnownWeak('GATEWAY_SIGNING_KEY', 'replace-me-openssl-rand-hex-32')).toThrow();
    expect(() => assertSecretNotKnownWeak('FEISHU_APP_SECRET', 'your-feishu-app-secret')).toThrow();
  });

  it('does not throw on a real secret', () => {
    expect(() => assertSecretNotKnownWeak('GATEWAY_SIGNING_KEY', 'a3f9c0b7e2d4a8f6c5b9e1d2a7f4c8b3')).not.toThrow();
  });

  it('does not throw on an empty value', () => {
    expect(() => assertSecretNotKnownWeak('METRICS_AUTH_TOKEN', '')).not.toThrow();
  });
});
