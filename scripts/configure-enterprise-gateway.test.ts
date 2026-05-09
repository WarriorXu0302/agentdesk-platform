import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({
  TEST_ROOT: '/tmp/nanoclaw-test-enterprise-gateway',
}));

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
  return {
    ...actual,
    GROUPS_DIR: path.join(TEST_ROOT, 'groups'),
  };
});

import { readContainerConfig } from '../src/container-config.js';
import { run } from './configure-enterprise-gateway.js';

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', 'frontlane-frontdesk'), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', 'frontlane-finance-worker'), { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('configure-enterprise-gateway', () => {
  it('writes gateway config into the selected group container configs', async () => {
    await run([
      '--base-url',
      'https://erp-gateway.internal/api/agent',
      '--folders',
      'frontlane-frontdesk,frontlane-finance-worker',
      '--timeout-ms',
      '20000',
      '--header',
      'x-tenant=erp-a',
    ]);

    const frontdesk = readContainerConfig('frontlane-frontdesk');
    const finance = readContainerConfig('frontlane-finance-worker');

    expect(frontdesk.enterpriseGateway).toEqual({
      baseUrl: 'https://erp-gateway.internal/api/agent',
      timeoutMs: 20000,
      defaultHeaders: { 'x-tenant': 'erp-a' },
    });
    expect(frontdesk.memoryMode).toBe('erp');
    expect(frontdesk.a2aSessionMode).toBe('root-session');
    expect(finance.enterpriseGateway).toEqual({
      baseUrl: 'https://erp-gateway.internal/api/agent',
      timeoutMs: 20000,
      defaultHeaders: { 'x-tenant': 'erp-a' },
    });
    expect(finance.memoryMode).toBe('erp');
    expect(finance.a2aSessionMode).toBe('root-session');
  });
});
