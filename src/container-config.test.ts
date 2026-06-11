import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every test runs inside an isolated GROUPS_DIR so fixtures don't stomp on
// the real groups/ folder. GROUPS_DIR is captured at import time — we mock
// the module once per describe and swap the underlying path per test.
const tmpState: { root: string } = { root: '' };

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    get GROUPS_DIR(): string {
      return path.join(tmpState.root, 'groups');
    },
  };
});

const { readContainerConfig, writeContainerConfig } = await import('./container-config.js');

beforeEach(() => {
  tmpState.root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-container-cfg-'));
  fs.mkdirSync(path.join(tmpState.root, 'groups'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpState.root, { recursive: true, force: true });
});

describe('container resources normalization', () => {
  it('accepts well-formed resource limits', () => {
    writeContainerConfig('g1', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      resources: { memoryMb: 512, cpus: 0.5, pidsLimit: 200 },
    });

    const cfg = readContainerConfig('g1');
    expect(cfg.resources).toEqual({ memoryMb: 512, cpus: 0.5, pidsLimit: 200 });
  });

  it('drops non-positive or non-numeric fields', () => {
    const groupDir = path.join(tmpState.root, 'groups', 'g2');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'container.json'),
      JSON.stringify({
        resources: { memoryMb: -1, cpus: 'two', pidsLimit: 0 },
      }),
    );

    const cfg = readContainerConfig('g2');
    expect(cfg.resources).toBeUndefined();
  });

  it('preserves only valid fields when the object is partial', () => {
    const groupDir = path.join(tmpState.root, 'groups', 'g3');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'container.json'),
      JSON.stringify({
        resources: { memoryMb: 1024, cpus: 'bogus' },
      }),
    );

    const cfg = readContainerConfig('g3');
    expect(cfg.resources).toEqual({ memoryMb: 1024 });
  });

  it('floors fractional memoryMb and pidsLimit but keeps fractional cpus', () => {
    writeContainerConfig('g4', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      resources: { memoryMb: 512.9, cpus: 0.25, pidsLimit: 128.8 },
    });

    const cfg = readContainerConfig('g4');
    expect(cfg.resources).toEqual({ memoryMb: 512, cpus: 0.25, pidsLimit: 128 });
  });

  it('returns undefined when resources field is absent', () => {
    writeContainerConfig('g5', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    const cfg = readContainerConfig('g5');
    expect(cfg.resources).toBeUndefined();
  });
});
