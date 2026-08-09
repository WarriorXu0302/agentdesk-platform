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

describe('container.json read-modify-write safety', () => {
  function writeRaw(folder: string, text: string): string {
    const dir = path.join(tmpState.root, 'groups', folder);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'container.json');
    fs.writeFileSync(p, text);
    return p;
  }

  it('fails CLOSED on a corrupt file and preserves it instead of overwriting', () => {
    // Regression: a parse failure returned emptyConfig(), silently dropping the
    // group's isolation settings (network:"none", resources, skills whitelist,
    // memoryMode, provider) — and the next ensureRuntimeFields write-back
    // persisted that empty config, destroying the operator's file.
    const p = writeRaw('broken', '{ "network": "none", }'); // trailing comma

    expect(() => readContainerConfig('broken')).toThrow(/failed to parse/);
    // Original still on disk, plus a preserved copy for the operator.
    expect(fs.readFileSync(p, 'utf8')).toContain('"network"');
    expect(fs.existsSync(`${p}.corrupt`)).toBe(true);
  });

  it('rejects a non-object top level', () => {
    writeRaw('arr', '[1,2,3]');
    expect(() => readContainerConfig('arr')).toThrow(/failed to parse/);
  });

  it('preserves operator keys this interface does not model (round-trip is lossless)', () => {
    // Regression: the reader mapped only its known keys into a fresh object, so
    // documented runner-read fields (idleExitMs, confidenceThreshold) vanished
    // and the next write-back deleted them permanently.
    writeRaw('extra', JSON.stringify({ idleExitMs: 300000, confidenceThreshold: 0.85, network: 'none' }));

    const cfg = readContainerConfig('extra') as unknown as Record<string, unknown>;
    expect(cfg.idleExitMs).toBe(300000);
    expect(cfg.confidenceThreshold).toBe(0.85);

    // Survives the read-modify-write round trip every mutator performs.
    writeContainerConfig('extra', cfg as never);
    const again = readContainerConfig('extra') as unknown as Record<string, unknown>;
    expect(again.idleExitMs).toBe(300000);
    expect(again.confidenceThreshold).toBe(0.85);
    expect(again.network).toBe('none');
  });

  it('normalizes a bare-string `skills` instead of iterating it per character', () => {
    // Regression: 'all' is a legal bare string, so "skills": "knowledge" was a
    // natural typo — and a string is iterable, so consumers walked it letter by
    // letter: zero skill fragments composed, and every real skill symlink pruned
    // in favour of dangling one-letter links.
    writeRaw('skl', JSON.stringify({ skills: 'knowledge' }));
    expect(readContainerConfig('skl').skills).toBe('all');

    writeRaw('skl2', JSON.stringify({ skills: ['knowledge', '../escape', 42] }));
    expect(readContainerConfig('skl2').skills).toEqual(['knowledge']);

    writeRaw('skl3', JSON.stringify({ skills: 'all' }));
    expect(readContainerConfig('skl3').skills).toBe('all');
  });
});
