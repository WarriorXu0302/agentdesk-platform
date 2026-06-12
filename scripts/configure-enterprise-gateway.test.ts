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

const FRONTDESK_FOLDER = 'agentdesk-frontdesk';
const FINANCE_WORKER_FOLDER = 'agentdesk-finance-worker';

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', FRONTDESK_FOLDER), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', FINANCE_WORKER_FOLDER), { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('configure-enterprise-gateway', () => {
  it('writes gateway config into the selected group container configs', async () => {
    await run([
      '--base-url',
      'https://gateway.internal/api/agent',
      '--folders',
      `${FRONTDESK_FOLDER},${FINANCE_WORKER_FOLDER}`,
      '--timeout-ms',
      '20000',
      '--header',
      'x-tenant=a',
    ]);

    const frontdesk = readContainerConfig(FRONTDESK_FOLDER);
    const finance = readContainerConfig(FINANCE_WORKER_FOLDER);

    expect(frontdesk.backendGateway).toEqual({
      baseUrl: 'https://gateway.internal/api/agent',
      timeoutMs: 20000,
      defaultHeaders: { 'x-tenant': 'a' },
    });
    expect(frontdesk.memoryMode).toBe('gateway');
    expect(frontdesk.a2aSessionMode).toBe('root-session');
    expect(finance.backendGateway).toEqual({
      baseUrl: 'https://gateway.internal/api/agent',
      timeoutMs: 20000,
      defaultHeaders: { 'x-tenant': 'a' },
    });
    expect(finance.memoryMode).toBe('gateway');
    expect(finance.a2aSessionMode).toBe('root-session');
  });

  it('targets the template frontdesk by default', async () => {
    await run(['--base-url', 'https://gateway.internal/api/agent']);

    const frontdesk = readContainerConfig(FRONTDESK_FOLDER);
    expect(frontdesk.backendGateway?.baseUrl).toBe('https://gateway.internal/api/agent');
    expect(frontdesk.memoryMode).toBe('gateway');
    expect(frontdesk.a2aSessionMode).toBe('root-session');
  });

  it('falls back to GATEWAY_BASE_URL when --base-url is omitted', async () => {
    const prev = process.env.GATEWAY_BASE_URL;
    process.env.GATEWAY_BASE_URL = 'https://gateway-from-env.example/api/agent';
    try {
      await run(['--folders', FRONTDESK_FOLDER]);

      const frontdesk = readContainerConfig(FRONTDESK_FOLDER);
      expect(frontdesk.backendGateway?.baseUrl).toBe('https://gateway-from-env.example/api/agent');
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_BASE_URL;
      else process.env.GATEWAY_BASE_URL = prev;
    }
  });

  it('preserves existing defaultHeaders and timeoutMs (merge semantics)', async () => {
    const { writeContainerConfig } = await import('../src/container-config.js');
    const seeded = readContainerConfig(FINANCE_WORKER_FOLDER);
    seeded.backendGateway = {
      baseUrl: '${GATEWAY_BASE_URL}',
      timeoutMs: 30000,
      defaultHeaders: { 'X-Agent-Source': 'finance-worker' },
    };
    writeContainerConfig(FINANCE_WORKER_FOLDER, seeded);

    await run([
      '--base-url',
      'https://gateway.internal/api/agent',
      '--folders',
      FINANCE_WORKER_FOLDER,
      '--header',
      'x-tenant=a',
    ]);

    const after = readContainerConfig(FINANCE_WORKER_FOLDER);
    expect(after.backendGateway?.baseUrl).toBe('https://gateway.internal/api/agent');
    expect(after.backendGateway?.timeoutMs).toBe(30000);
    expect(after.backendGateway?.defaultHeaders).toEqual({
      'X-Agent-Source': 'finance-worker',
      'x-tenant': 'a',
    });
  });

  it('CLI --header overrides a same-key header from the existing config', async () => {
    const { writeContainerConfig } = await import('../src/container-config.js');
    const seeded = readContainerConfig(FRONTDESK_FOLDER);
    seeded.backendGateway = {
      baseUrl: '${GATEWAY_BASE_URL}',
      defaultHeaders: { 'x-tenant': 'old' },
    };
    writeContainerConfig(FRONTDESK_FOLDER, seeded);

    await run([
      '--base-url',
      'https://gateway.internal/api/agent',
      '--folders',
      FRONTDESK_FOLDER,
      '--header',
      'x-tenant=new',
    ]);

    const after = readContainerConfig(FRONTDESK_FOLDER);
    expect(after.backendGateway?.defaultHeaders).toEqual({ 'x-tenant': 'new' });
  });

  it('writes --signing-key into the gateway config and never prints it in the clear', async () => {
    const secret = 'super-secret-signing-key-1234567890';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let printed = '';
    try {
      await run([
        '--base-url',
        'https://gateway.internal/api/agent',
        '--folders',
        FRONTDESK_FOLDER,
        '--signing-key',
        secret,
      ]);
      printed = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      logSpy.mockRestore();
    }

    const frontdesk = readContainerConfig(FRONTDESK_FOLDER);
    expect(frontdesk.backendGateway?.signingKey).toBe(secret);

    expect(printed).not.toContain(secret);
    // Masked form shows it's set + a short prefix, not the full key.
    expect(printed).toContain('signingKey: set (supe');
  });

  it('maps --signing-headers CSV onto timestamp/nonce/signature names', async () => {
    await run([
      '--base-url',
      'https://gateway.internal/api/agent',
      '--folders',
      FRONTDESK_FOLDER,
      '--signing-key',
      'k',
      '--signing-headers',
      'x-ts,x-nonce,x-sig',
    ]);

    const frontdesk = readContainerConfig(FRONTDESK_FOLDER);
    expect(frontdesk.backendGateway?.signingHeaders).toEqual({
      timestamp: 'x-ts',
      nonce: 'x-nonce',
      signature: 'x-sig',
    });
  });

  it('preserves an existing signingKey when a later run omits --signing-key', async () => {
    const { writeContainerConfig } = await import('../src/container-config.js');
    const seeded = readContainerConfig(FRONTDESK_FOLDER);
    seeded.backendGateway = { baseUrl: '${GATEWAY_BASE_URL}', signingKey: 'kept-key' };
    writeContainerConfig(FRONTDESK_FOLDER, seeded);

    await run(['--base-url', 'https://gateway.internal/api/agent', '--folders', FRONTDESK_FOLDER]);

    const after = readContainerConfig(FRONTDESK_FOLDER);
    expect(after.backendGateway?.signingKey).toBe('kept-key');
  });

  it('falls back to GATEWAY_SIGNING_KEY from the environment', async () => {
    const prev = process.env.GATEWAY_SIGNING_KEY;
    process.env.GATEWAY_SIGNING_KEY = 'env-key';
    try {
      await run(['--base-url', 'https://gateway.internal/api/agent', '--folders', FRONTDESK_FOLDER]);
      const frontdesk = readContainerConfig(FRONTDESK_FOLDER);
      expect(frontdesk.backendGateway?.signingKey).toBe('env-key');
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_SIGNING_KEY;
      else process.env.GATEWAY_SIGNING_KEY = prev;
    }
  });

  describe('rejects a known-weak signing key (ADR-0025)', () => {
    // fatal() calls process.exit(2); make it throw so the test can assert and
    // so it never aborts the test runner.
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code}`);
      }) as never);
      errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('fatals on a placeholder --signing-key and never writes it', async () => {
      await expect(
        run([
          '--base-url',
          'https://gateway.internal/api/agent',
          '--folders',
          FRONTDESK_FOLDER,
          '--signing-key',
          'replace-me-openssl-rand-hex-32',
        ]),
      ).rejects.toThrow('process.exit:2');

      const printed = errSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(printed).toContain('--signing-key');
      expect(printed).toMatch(/placeholder\/weak/);

      // The weak key must not have been persisted.
      const frontdesk = readContainerConfig(FRONTDESK_FOLDER);
      expect(frontdesk.backendGateway?.signingKey).toBeUndefined();
    });

    it('fatals on a lazy --signing-key (changeme)', async () => {
      await expect(
        run([
          '--base-url',
          'https://gateway.internal/api/agent',
          '--folders',
          FRONTDESK_FOLDER,
          '--signing-key',
          'changeme',
        ]),
      ).rejects.toThrow('process.exit:2');
    });

    it('fatals on a known-weak GATEWAY_SIGNING_KEY from the environment', async () => {
      const prev = process.env.GATEWAY_SIGNING_KEY;
      process.env.GATEWAY_SIGNING_KEY = 'replace-me-openssl-rand-hex-32';
      try {
        await expect(
          run(['--base-url', 'https://gateway.internal/api/agent', '--folders', FRONTDESK_FOLDER]),
        ).rejects.toThrow('process.exit:2');
        const printed = errSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(printed).toContain('GATEWAY_SIGNING_KEY');
      } finally {
        if (prev === undefined) delete process.env.GATEWAY_SIGNING_KEY;
        else process.env.GATEWAY_SIGNING_KEY = prev;
      }
    });

    it('accepts a real random --signing-key', async () => {
      await run([
        '--base-url',
        'https://gateway.internal/api/agent',
        '--folders',
        FRONTDESK_FOLDER,
        '--signing-key',
        '3f9a1c0b7e2d4a8f6c5b9e1d2a7f4c8b3e6d9a0c1f2b4e7d8a9c0b1e2f3a4d5c',
      ]);
      const frontdesk = readContainerConfig(FRONTDESK_FOLDER);
      expect(frontdesk.backendGateway?.signingKey).toBe(
        '3f9a1c0b7e2d4a8f6c5b9e1d2a7f4c8b3e6d9a0c1f2b4e7d8a9c0b1e2f3a4d5c',
      );
    });
  });
});
