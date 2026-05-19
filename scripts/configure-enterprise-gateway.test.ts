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
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', 'frontlane-lab-frontdesk'), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', 'frontlane-access-worker'), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', 'frontlane-sales-worker'), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', 'frontlane-finance-worker'), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', 'frontlane-approval-worker'), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', 'frontlane-ops-worker'), { recursive: true });
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

  it('includes frontlane-lab-frontdesk in the default folder list', async () => {
    await run(['--base-url', 'https://erp-gateway.internal/api/agent']);

    const labDesk = readContainerConfig('frontlane-lab-frontdesk');
    expect(labDesk.enterpriseGateway?.baseUrl).toBe('https://erp-gateway.internal/api/agent');
    expect(labDesk.memoryMode).toBe('erp');
    expect(labDesk.a2aSessionMode).toBe('root-session');

    const frontdesk = readContainerConfig('frontlane-frontdesk');
    expect(frontdesk.enterpriseGateway?.baseUrl).toBe('https://erp-gateway.internal/api/agent');

    const opsWorker = readContainerConfig('frontlane-ops-worker');
    expect(opsWorker.enterpriseGateway?.baseUrl).toBe('https://erp-gateway.internal/api/agent');
  });

  it('falls back to ERP_GATEWAY_BASE_URL when --base-url is omitted', async () => {
    const prev = process.env.ERP_GATEWAY_BASE_URL;
    process.env.ERP_GATEWAY_BASE_URL = 'https://erp-gateway-from-env.example/api/agent';
    try {
      await run(['--folders', 'frontlane-frontdesk']);

      const frontdesk = readContainerConfig('frontlane-frontdesk');
      expect(frontdesk.enterpriseGateway?.baseUrl).toBe('https://erp-gateway-from-env.example/api/agent');
    } finally {
      if (prev === undefined) delete process.env.ERP_GATEWAY_BASE_URL;
      else process.env.ERP_GATEWAY_BASE_URL = prev;
    }
  });

  it('preserves pack-provided defaultHeaders and timeoutMs (ADR-0008 merge semantics)', async () => {
    const { writeContainerConfig } = await import('../src/container-config.js');
    const seeded = readContainerConfig('frontlane-lab-frontdesk');
    seeded.enterpriseGateway = {
      baseUrl: '${ERP_GATEWAY_BASE_URL}',
      timeoutMs: 30000,
      defaultHeaders: { 'X-FrontLane-Source': 'frontlane-lab-frontdesk' },
    };
    writeContainerConfig('frontlane-lab-frontdesk', seeded);

    await run([
      '--base-url',
      'https://erp-gateway.internal/api/agent',
      '--folders',
      'frontlane-lab-frontdesk',
      '--header',
      'x-tenant=erp-a',
    ]);

    const after = readContainerConfig('frontlane-lab-frontdesk');
    expect(after.enterpriseGateway?.baseUrl).toBe('https://erp-gateway.internal/api/agent');
    expect(after.enterpriseGateway?.timeoutMs).toBe(30000);
    expect(after.enterpriseGateway?.defaultHeaders).toEqual({
      'X-FrontLane-Source': 'frontlane-lab-frontdesk',
      'x-tenant': 'erp-a',
    });
  });

  it('CLI --header overrides a same-key header from the existing config', async () => {
    const { writeContainerConfig } = await import('../src/container-config.js');
    const seeded = readContainerConfig('frontlane-frontdesk');
    seeded.enterpriseGateway = {
      baseUrl: '${ERP_GATEWAY_BASE_URL}',
      defaultHeaders: { 'x-tenant': 'erp-old' },
    };
    writeContainerConfig('frontlane-frontdesk', seeded);

    await run([
      '--base-url',
      'https://erp-gateway.internal/api/agent',
      '--folders',
      'frontlane-frontdesk',
      '--header',
      'x-tenant=erp-new',
    ]);

    const after = readContainerConfig('frontlane-frontdesk');
    expect(after.enterpriseGateway?.defaultHeaders).toEqual({ 'x-tenant': 'erp-new' });
  });
});
