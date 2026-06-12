import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({
  TEST_ROOT: '/tmp/nanoclaw-test-gateway-signing-check',
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    GROUPS_DIR: path.join(TEST_ROOT, 'groups'),
  };
});

// Silence + capture the warning path so the weak-signed assertion can inspect it.
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

import { writeContainerConfig, readContainerConfig, initContainerConfig } from './container-config.js';
import { checkGatewaySigningCoverage } from './gateway-signing-check.js';
import { log } from './log.js';
import { gatewayUnsignedGroups } from './metrics.js';

function makeGroup(folder: string): void {
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', folder), { recursive: true });
}

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups'), { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  vi.restoreAllMocks();
});

describe('checkGatewaySigningCoverage', () => {
  it('flags groups with a gateway baseUrl but no signingKey', () => {
    makeGroup('signed');
    makeGroup('unsigned');
    initContainerConfig('signed');
    initContainerConfig('unsigned');

    const signed = readContainerConfig('signed');
    signed.backendGateway = { baseUrl: 'https://gw.internal/api', signingKey: 'secret-key' };
    writeContainerConfig('signed', signed);

    const unsigned = readContainerConfig('unsigned');
    unsigned.backendGateway = { baseUrl: 'https://gw.internal/api' };
    writeContainerConfig('unsigned', unsigned);

    const setSpy = vi.spyOn(gatewayUnsignedGroups, 'set');

    const result = checkGatewaySigningCoverage();

    expect(result.unsigned).toEqual(['unsigned']);
    expect(result.weakSigned).toEqual([]);
    expect(setSpy).toHaveBeenCalledWith(1);
  });

  it('reports zero when every gateway is signed and ignores groups without a gateway', () => {
    makeGroup('signed');
    makeGroup('no-gateway');
    initContainerConfig('signed');
    initContainerConfig('no-gateway');

    const signed = readContainerConfig('signed');
    signed.backendGateway = { baseUrl: 'https://gw.internal/api', signingKey: 'k' };
    writeContainerConfig('signed', signed);
    // no-gateway has no backendGateway block at all → not counted

    const setSpy = vi.spyOn(gatewayUnsignedGroups, 'set');

    const result = checkGatewaySigningCoverage();

    expect(result.unsigned).toEqual([]);
    expect(result.weakSigned).toEqual([]);
    expect(setSpy).toHaveBeenCalledWith(0);
  });

  it('treats a whitespace-only signingKey as unsigned', () => {
    makeGroup('blank-key');
    initContainerConfig('blank-key');
    const cfg = readContainerConfig('blank-key');
    cfg.backendGateway = { baseUrl: 'https://gw.internal/api', signingKey: '   ' };
    writeContainerConfig('blank-key', cfg);

    const result = checkGatewaySigningCoverage();
    expect(result.unsigned).toEqual(['blank-key']);
    expect(result.weakSigned).toEqual([]);
  });

  it('flags a known-weak/placeholder signingKey as weak-signed (distinct from unsigned)', () => {
    makeGroup('weak');
    makeGroup('unsigned');
    initContainerConfig('weak');
    initContainerConfig('unsigned');

    // The exact GATEWAY_SIGNING_KEY placeholder shipped in .env.example.
    const weak = readContainerConfig('weak');
    weak.backendGateway = {
      baseUrl: 'https://gw.internal/api',
      signingKey: 'replace-me-openssl-rand-hex-32',
    };
    writeContainerConfig('weak', weak);

    const unsigned = readContainerConfig('unsigned');
    unsigned.backendGateway = { baseUrl: 'https://gw.internal/api' };
    writeContainerConfig('unsigned', unsigned);

    const setSpy = vi.spyOn(gatewayUnsignedGroups, 'set');

    const result = checkGatewaySigningCoverage();

    expect(result.weakSigned).toEqual(['weak']);
    expect(result.unsigned).toEqual(['unsigned']);
    // Both buckets count against signing coverage.
    expect(setSpy).toHaveBeenCalledWith(2);
    // A distinct warning fires for the weak-signed case.
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('placeholder/weak'),
      expect.objectContaining({ folders: ['weak'] }),
    );
  });

  it('does not flag a real random signingKey', () => {
    makeGroup('real');
    initContainerConfig('real');
    const cfg = readContainerConfig('real');
    cfg.backendGateway = {
      baseUrl: 'https://gw.internal/api',
      signingKey: '3f9a1c0b7e2d4a8f6c5b9e1d2a7f4c8b3e6d9a0c1f2b4e7d8a9c0b1e2f3a4d5c',
    };
    writeContainerConfig('real', cfg);

    const result = checkGatewaySigningCoverage();
    expect(result.unsigned).toEqual([]);
    expect(result.weakSigned).toEqual([]);
  });
});
