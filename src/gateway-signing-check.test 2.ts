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

import { writeContainerConfig, readContainerConfig, initContainerConfig } from './container-config.js';
import { checkGatewaySigningCoverage } from './gateway-signing-check.js';
import { gatewayUnsignedGroups } from './metrics.js';

function makeGroup(folder: string): void {
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', folder), { recursive: true });
}

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups'), { recursive: true });
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

    expect(result).toEqual(['unsigned']);
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

    expect(result).toEqual([]);
    expect(setSpy).toHaveBeenCalledWith(0);
  });

  it('treats a whitespace-only signingKey as unsigned', () => {
    makeGroup('blank-key');
    initContainerConfig('blank-key');
    const cfg = readContainerConfig('blank-key');
    cfg.backendGateway = { baseUrl: 'https://gw.internal/api', signingKey: '   ' };
    writeContainerConfig('blank-key', cfg);

    const result = checkGatewaySigningCoverage();
    expect(result).toEqual(['blank-key']);
  });
});
