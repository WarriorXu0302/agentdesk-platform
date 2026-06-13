/**
 * Tests for startup config validation (ADR-0025).
 *
 * Emphasis on the conservative contract: the minimal CLI-only deployment and
 * Feishu long-connection mode must NOT be tripped by the new checks, while a
 * genuinely broken/forgeable config (placeholder secret, webhook mode missing
 * its verification key, half-configured app credentials, openai-without-key)
 * fails fast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive `.env` values through the mock so no real file is read. The validator
// resolves process.env first, then this dotenv map; tests clear process.env for
// the inspected keys so the dotenv map is authoritative.
const dotenvValues: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: (keys: string[]) => {
    const out: Record<string, string> = {};
    for (const k of keys) if (dotenvValues[k] !== undefined) out[k] = dotenvValues[k];
    return out;
  },
}));

// Silence + capture the soft warning path.
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

import { validateStartupConfig } from './config-validate.js';
import { log } from './log.js';

const INSPECTED_KEYS = [
  'GATEWAY_SIGNING_KEY',
  'METRICS_AUTH_TOKEN',
  'ONECLI_API_KEY',
  'FEISHU_APP_SECRET',
  'FEISHU_ENCRYPT_KEY',
  'FEISHU_VERIFICATION_TOKEN',
  'OPENAI_API_KEY',
  'FEISHU_EVENT_MODE',
  'FEISHU_APP_ID',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_REASONING_EFFORT',
  'OPENAI_TIMEOUT_MS',
  'OPENAI_COMPACT_MODEL',
  'OTEL_CAPTURE_CONTENT',
  'AGENTDESK_OPENAI_VIA_ONECLI',
  'ONECLI_URL',
];

const savedProcessEnv: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string>): void {
  for (const [k, v] of Object.entries(values)) dotenvValues[k] = v;
}

beforeEach(() => {
  // Clear any inspected key from process.env so the dotenv mock is the only
  // source, and remember originals to restore.
  for (const k of INSPECTED_KEYS) {
    savedProcessEnv[k] = process.env[k];
    delete process.env[k];
    delete dotenvValues[k];
  }
  vi.clearAllMocks();
});

afterEach(() => {
  for (const k of INSPECTED_KEYS) {
    if (savedProcessEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProcessEnv[k];
    delete dotenvValues[k];
  }
});

describe('validateStartupConfig — conservative no-regression', () => {
  it('passes a minimal CLI-only deployment (nothing configured)', () => {
    expect(() => validateStartupConfig()).not.toThrow();
  });

  it('passes Feishu long-connection mode without the webhook verification secrets', () => {
    setEnv({
      FEISHU_EVENT_MODE: 'long-connection',
      FEISHU_APP_ID: 'cli_real-app-id',
      FEISHU_APP_SECRET: 'a-real-feishu-secret-value-9f3c',
    });
    expect(() => validateStartupConfig()).not.toThrow();
  });

  it('does not fail on optional secrets simply being unset', () => {
    // No GATEWAY_SIGNING_KEY / ONECLI_API_KEY / etc. set at all.
    expect(() => validateStartupConfig()).not.toThrow();
  });

  it('warns (does not throw) when METRICS_AUTH_TOKEN is unset', () => {
    validateStartupConfig();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('METRICS_AUTH_TOKEN'));
  });
});

describe('validateStartupConfig — known-weak secret rejection', () => {
  it('rejects a placeholder GATEWAY_SIGNING_KEY', () => {
    setEnv({ GATEWAY_SIGNING_KEY: 'replace-me-openssl-rand-hex-32' });
    expect(() => validateStartupConfig()).toThrow(/GATEWAY_SIGNING_KEY/);
  });

  it('rejects a lazy METRICS_AUTH_TOKEN', () => {
    setEnv({ METRICS_AUTH_TOKEN: 'changeme' });
    expect(() => validateStartupConfig()).toThrow(/METRICS_AUTH_TOKEN/);
  });

  it('passes a real random GATEWAY_SIGNING_KEY', () => {
    setEnv({ GATEWAY_SIGNING_KEY: '3f9a1c0b7e2d4a8f6c5b9e1d2a7f4c8b3e6d9a0c1f2b4e7d8a9c0b1e2f3a4d5c' });
    expect(() => validateStartupConfig()).not.toThrow();
  });

  it('reads a weak value from process.env (precedence over .env)', () => {
    process.env.ONECLI_API_KEY = 'password';
    expect(() => validateStartupConfig()).toThrow(/ONECLI_API_KEY/);
  });
});

describe('validateStartupConfig — Feishu webhook mode', () => {
  it('fails webhook mode missing FEISHU_ENCRYPT_KEY', () => {
    setEnv({
      FEISHU_EVENT_MODE: 'webhook',
      FEISHU_APP_ID: 'cli_real-app-id',
      FEISHU_APP_SECRET: 'a-real-feishu-secret-value-9f3c',
      FEISHU_VERIFICATION_TOKEN: 'a-real-verification-token-7b2e',
    });
    expect(() => validateStartupConfig()).toThrow(/FEISHU_ENCRYPT_KEY/);
  });

  it('fails webhook mode missing FEISHU_VERIFICATION_TOKEN', () => {
    setEnv({
      FEISHU_EVENT_MODE: 'webhook',
      FEISHU_APP_ID: 'cli_real-app-id',
      FEISHU_APP_SECRET: 'a-real-feishu-secret-value-9f3c',
      FEISHU_ENCRYPT_KEY: 'a-real-encrypt-key-3d1f',
    });
    expect(() => validateStartupConfig()).toThrow(/FEISHU_VERIFICATION_TOKEN/);
  });

  it('fails hybrid mode the same way as webhook', () => {
    setEnv({ FEISHU_EVENT_MODE: 'hybrid' });
    expect(() => validateStartupConfig()).toThrow(/FEISHU_ENCRYPT_KEY/);
  });

  it('passes webhook mode with both verification secrets present', () => {
    setEnv({
      FEISHU_EVENT_MODE: 'webhook',
      FEISHU_APP_ID: 'cli_real-app-id',
      FEISHU_APP_SECRET: 'a-real-feishu-secret-value-9f3c',
      FEISHU_ENCRYPT_KEY: 'a-real-encrypt-key-3d1f',
      FEISHU_VERIFICATION_TOKEN: 'a-real-verification-token-7b2e',
    });
    expect(() => validateStartupConfig()).not.toThrow();
  });
});

describe('validateStartupConfig — Feishu app credential pairing', () => {
  it('fails when FEISHU_APP_ID is set without FEISHU_APP_SECRET', () => {
    setEnv({ FEISHU_APP_ID: 'cli_real-app-id' });
    expect(() => validateStartupConfig()).toThrow(/FEISHU_APP_SECRET/);
  });

  it('fails when FEISHU_APP_SECRET is set without FEISHU_APP_ID', () => {
    setEnv({ FEISHU_APP_SECRET: 'a-real-feishu-secret-value-9f3c' });
    expect(() => validateStartupConfig()).toThrow(/FEISHU_APP_ID/);
  });

  it('passes when both are present', () => {
    setEnv({ FEISHU_APP_ID: 'cli_real-app-id', FEISHU_APP_SECRET: 'a-real-feishu-secret-value-9f3c' });
    expect(() => validateStartupConfig()).not.toThrow();
  });
});

describe('validateStartupConfig — OpenAI provider', () => {
  it('fails when OPENAI_BASE_URL is set but OPENAI_API_KEY is missing', () => {
    setEnv({ OPENAI_BASE_URL: 'https://gw.example.com/v1' });
    expect(() => validateStartupConfig()).toThrow(/OPENAI_API_KEY/);
  });

  it('fails when OPENAI_MODEL is set but OPENAI_API_KEY is missing', () => {
    setEnv({ OPENAI_MODEL: 'gpt-5.4' });
    expect(() => validateStartupConfig()).toThrow(/OPENAI_API_KEY/);
  });

  it('passes when OpenAI is fully configured', () => {
    setEnv({
      OPENAI_BASE_URL: 'https://gw.example.com/v1',
      OPENAI_MODEL: 'gpt-5.4',
      OPENAI_API_KEY: 'sk-proj-9XzQ2mTn4pVbWcKdReFgHjLm',
    });
    expect(() => validateStartupConfig()).not.toThrow();
  });

  it('does not require OPENAI_API_KEY when no OpenAI vars are set (claude-only)', () => {
    expect(() => validateStartupConfig()).not.toThrow();
  });

  it('rejects a placeholder OPENAI_API_KEY even when otherwise configured', () => {
    setEnv({
      OPENAI_BASE_URL: 'https://gw.example.com/v1',
      OPENAI_API_KEY: 'sk-your-openai-api-key',
    });
    expect(() => validateStartupConfig()).toThrow(/OPENAI_API_KEY/);
  });

  // ADR-0035 vault mode: the key is intentionally NOT on the host.
  it('does NOT require OPENAI_API_KEY in vault mode (key lives in the vault)', () => {
    setEnv({
      AGENTDESK_OPENAI_VIA_ONECLI: 'true',
      OPENAI_BASE_URL: 'https://gw.example.com/v1',
      OPENAI_MODEL: 'gpt-5.4',
      // vault mode needs the OneCLI control plane configured (URL + key), but
      // NOT the OpenAI key on the host — the vault injects it.
      ONECLI_URL: 'https://vault.internal',
      ONECLI_API_KEY: 'a-real-onecli-key-9f3c2a',
      // no OPENAI_API_KEY on purpose
    });
    expect(() => validateStartupConfig()).not.toThrow();
  });

  it('requires ONECLI_URL in vault mode (the vault cannot inject without it)', () => {
    setEnv({
      AGENTDESK_OPENAI_VIA_ONECLI: 'true',
      OPENAI_BASE_URL: 'https://gw.example.com/v1',
      // no ONECLI_URL
    });
    expect(() => validateStartupConfig()).toThrow(/ONECLI_URL/);
  });
});

describe('validateStartupConfig — OneCLI control-plane pairing', () => {
  it('fails when ONECLI_URL is set without ONECLI_API_KEY', () => {
    setEnv({ ONECLI_URL: 'https://vault.internal' });
    expect(() => validateStartupConfig()).toThrow(/ONECLI_API_KEY/);
  });

  it('passes when both are present', () => {
    setEnv({ ONECLI_URL: 'https://vault.internal', ONECLI_API_KEY: 'a-real-onecli-key-9f3c2a' });
    expect(() => validateStartupConfig()).not.toThrow();
  });

  it('does not require ONECLI_API_KEY when ONECLI_URL is unset', () => {
    expect(() => validateStartupConfig()).not.toThrow();
  });
});

describe('validateStartupConfig — OTEL_CAPTURE_CONTENT privacy warning (ADR-0027)', () => {
  function warnedAboutCapture(): boolean {
    return (log.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (args) => typeof args[0] === 'string' && args[0].includes('OTEL_CAPTURE_CONTENT'),
    );
  }

  it('warns (does not throw) when OTEL_CAPTURE_CONTENT=true', () => {
    setEnv({ OTEL_CAPTURE_CONTENT: 'true' });
    expect(() => validateStartupConfig()).not.toThrow();
    expect(warnedAboutCapture()).toBe(true);
  });

  it('warns case-insensitively (TRUE)', () => {
    setEnv({ OTEL_CAPTURE_CONTENT: 'TRUE' });
    validateStartupConfig();
    expect(warnedAboutCapture()).toBe(true);
  });

  it('does not warn when OTEL_CAPTURE_CONTENT is unset', () => {
    validateStartupConfig();
    expect(warnedAboutCapture()).toBe(false);
  });

  it('does not warn when OTEL_CAPTURE_CONTENT=false', () => {
    setEnv({ OTEL_CAPTURE_CONTENT: 'false' });
    validateStartupConfig();
    expect(warnedAboutCapture()).toBe(false);
  });

  it('does not warn for a non-true value (e.g. 0)', () => {
    setEnv({ OTEL_CAPTURE_CONTENT: '0' });
    validateStartupConfig();
    expect(warnedAboutCapture()).toBe(false);
  });
});
