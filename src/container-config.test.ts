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

  it('ociRuntime round-trips; an invalid value degrades to unset (ADR-0058)', () => {
    writeRaw('sandboxed', JSON.stringify({ ociRuntime: 'runsc' }));
    expect(readContainerConfig('sandboxed').ociRuntime).toBe('runsc');

    // Fail-safe: a typo must fall back to the engine default, never produce
    // a config that blocks the spawn.
    writeRaw('sandboxed-bad', JSON.stringify({ ociRuntime: 'runsc; rm -rf /' }));
    expect(readContainerConfig('sandboxed-bad').ociRuntime).toBeUndefined();
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

describe('dual LLM configuration', () => {
  it('round-trips centralized routing and execution configuration', () => {
    writeContainerConfig('frontdesk', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      llm: {
        routing: {
          enabled: true,
          provider: 'opencode-go',
          model: 'mimo-v2.5',
          transport: 'chat-completions',
          promptFile: 'prompts/frontdesk-routing.md',
          timeoutMs: 10_000,
          retryTimes: 1,
          context: { maxMessages: 4, maxChars: 12_000 },
          confidence: { threshold: 0.7, belowThresholdAction: 'clarify' },
          fallback: { action: 'clarify' },
        },
        execution: {
          provider: 'opencode-go',
          model: 'deepseek-v4-flash',
          transport: 'chat-completions',
        },
      },
    });

    expect(readContainerConfig('frontdesk').llm).toEqual({
      routing: {
        enabled: true,
        provider: 'opencode-go',
        model: 'mimo-v2.5',
        transport: 'chat-completions',
        promptFile: 'prompts/frontdesk-routing.md',
        timeoutMs: 10_000,
        retryTimes: 1,
        context: { maxMessages: 4, maxChars: 12_000 },
        confidence: { threshold: 0.7, belowThresholdAction: 'clarify' },
        fallback: { action: 'clarify' },
      },
      execution: {
        provider: 'opencode-go',
        model: 'deepseek-v4-flash',
        transport: 'chat-completions',
      },
    });
  });

  it('fails closed when an enabled routing config is explicitly invalid', () => {
    const groupDir = path.join(tmpState.root, 'groups', 'invalid-frontdesk');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'container.json'),
      JSON.stringify({
        llm: {
          routing: {
            enabled: true,
            provider: 'opencode-go',
            model: 'mimo-v2.5',
            promptFile: '../escape.md',
            transport: 'bogus',
          },
        },
      }),
    );

    expect(() => readContainerConfig('invalid-frontdesk')).toThrow(/llm\.routing/i);
  });

  it('rejects an explicit invalid routing transport even when the prompt path is valid', () => {
    const groupDir = path.join(tmpState.root, 'groups', 'invalid-transport');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'container.json'),
      JSON.stringify({
        llm: {
          routing: {
            enabled: true,
            provider: 'opencode-go',
            model: 'mimo-v2.5',
            promptFile: 'prompts/frontdesk-routing.md',
            transport: 'bogus',
          },
        },
      }),
    );

    expect(() => readContainerConfig('invalid-transport')).toThrow(/routing\.transport/i);
  });

  it('preserves a DISABLED routing block across the read-modify-write round trip', () => {
    // Regression: normalizeDualLlmConfig returns undefined for enabled!==true, and
    // that undefined used to clobber the config, so the next write-back deleted a
    // dormant-but-configured routing block. It must survive instead.
    const dir = path.join(tmpState.root, 'groups', 'dormant');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'container.json'),
      JSON.stringify({
        llm: { routing: { enabled: false, provider: 'opencode-go', model: 'mimo-v2.5' } },
      }),
    );

    const cfg = readContainerConfig('dormant');
    expect(cfg.llm?.routing).toEqual({ enabled: false, provider: 'opencode-go', model: 'mimo-v2.5' });

    writeContainerConfig('dormant', cfg);
    expect(readContainerConfig('dormant').llm?.routing).toEqual({
      enabled: false,
      provider: 'opencode-go',
      model: 'mimo-v2.5',
    });
  });
});
