import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildOpenAIContribution, openaiViaOneCliEnabled } from './openai.js';

const FLAG = 'AGENTDESK_OPENAI_VIA_ONECLI';
const KEY = 'OPENAI_API_KEY';
const BASE = 'OPENAI_BASE_URL';

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { [FLAG]: process.env[FLAG], [KEY]: process.env[KEY], [BASE]: process.env[BASE] };
});

afterEach(() => {
  for (const k of [FLAG, KEY, BASE]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('openaiViaOneCliEnabled (ADR-0035)', () => {
  it('defaults OFF', () => {
    delete process.env[FLAG];
    expect(openaiViaOneCliEnabled()).toBe(false);
  });

  it('is ON only for the exact "true" value', () => {
    process.env[FLAG] = 'true';
    expect(openaiViaOneCliEnabled()).toBe(true);
    process.env[FLAG] = 'yes';
    expect(openaiViaOneCliEnabled()).toBe(false);
  });
});

describe('buildOpenAIContribution (ADR-0035 vault mode)', () => {
  it('direct mode (default): forwards the API key, no vault flag', () => {
    delete process.env[FLAG];
    process.env[KEY] = 'sk-secret';
    process.env[BASE] = 'https://api.openai.example';
    const { env } = buildOpenAIContribution();
    expect(env?.OPENAI_API_KEY).toBeDefined();
    expect(env?.OPENAI_CREDENTIAL_VIA_PROXY).toBeUndefined();
    expect(env?.OPENAI_BASE_URL).toBe('https://api.openai.example');
  });

  it('vault mode: withholds the API key from the container and flags it', () => {
    process.env[FLAG] = 'true';
    process.env[KEY] = 'sk-secret';
    process.env[BASE] = 'https://api.openai.example';
    const { env } = buildOpenAIContribution();
    // The key MUST NOT enter the container in vault mode.
    expect(env?.OPENAI_API_KEY).toBeUndefined();
    // The container is told it is in vault mode.
    expect(env?.OPENAI_CREDENTIAL_VIA_PROXY).toBe('true');
    // baseUrl still rides along so requests target the real host the vault intercepts.
    expect(env?.OPENAI_BASE_URL).toBe('https://api.openai.example');
  });
});
