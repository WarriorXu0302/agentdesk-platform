/**
 * Tests for the fork-free channel extension loader (ADR-0031).
 *
 * Uses real temp-dir fixtures: each test writes a `manifest.json` + a `.ts`
 * entry module under a fresh extensions dir, points the loader at it, and
 * asserts on the registry side effects + the returned summary.
 *
 * The entry modules import the REAL `channel-registry` by absolute path so the
 * `registerChannelAdapter` call lands in the same registry instance the loader
 * (and these assertions) read — vitest dedupes modules by resolved id, so an
 * absolute path to the in-tree module is the same singleton.
 *
 * The fixtures are written defensively under unique dirs and torn down after
 * each test; each registers a unique channelType so they don't collide with
 * the built-in cli/feishu registrations that other suites import.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getRegisteredChannelNames, getRegisteredFactory, unregisterChannelAdapter } from './channel-registry.js';
import { loadChannelExtensions, readHostVersion } from './extension-loader.js';
import { parseChannelExtensionManifest } from './extension-manifest.js';

// Absolute path to the real registry module, used inside generated entry files
// so their registerChannelAdapter call hits the same singleton this test reads.
const REGISTRY_PATH = path.resolve(__dirname, 'channel-registry.ts');
const CONTRACT_PATH = path.resolve(__dirname, 'channel-contract.ts');

const HOST_VERSION = '2.0.44';

let rootDir: string;
const registeredInTest: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-ext-test-'));
  return dir;
}

/** Write an extension dir with a manifest + entry. Returns the dir name. */
function writeExtension(opts: {
  dirName: string;
  manifest: Record<string, unknown> | string; // object → JSON.stringify, string → written raw
  entrySource?: string; // contents of the entry file (omit to skip writing one)
  entryFile?: string; // entry filename (default index.ts)
}): void {
  const extDir = path.join(rootDir, opts.dirName);
  fs.mkdirSync(extDir, { recursive: true });
  const manifestText = typeof opts.manifest === 'string' ? opts.manifest : JSON.stringify(opts.manifest, null, 2);
  fs.writeFileSync(path.join(extDir, 'manifest.json'), manifestText);
  const entryFile = opts.entryFile ?? 'index.ts';
  if (opts.entrySource !== undefined) {
    fs.writeFileSync(path.join(extDir, entryFile), opts.entrySource);
  }
}

/** Source for an entry that registers a conforming adapter under `channelType`. */
function conformingEntrySource(channelType: string): string {
  return `
import { registerChannelAdapter } from ${JSON.stringify(REGISTRY_PATH)};
registerChannelAdapter(${JSON.stringify(channelType)}, {
  factory: () => ({
    name: ${JSON.stringify(channelType)},
    channelType: ${JSON.stringify(channelType)},
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() { return false; },
    async deliver() { return undefined; },
  }),
});
`;
}

/** Source for an entry that registers a STRUCTURALLY BROKEN adapter (deliver missing). */
function brokenEntrySource(channelType: string): string {
  return `
import { registerChannelAdapter } from ${JSON.stringify(REGISTRY_PATH)};
registerChannelAdapter(${JSON.stringify(channelType)}, {
  // deliver is not a function — fails assertChannelAdapterContract.
  factory: () => ({
    name: ${JSON.stringify(channelType)},
    channelType: ${JSON.stringify(channelType)},
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() { return false; },
    deliver: 123,
  }),
});
`;
}

beforeEach(() => {
  rootDir = freshDir();
  registeredInTest.length = 0;
});

afterEach(() => {
  // Clean up any registrations the loader added so suites stay isolated.
  for (const name of registeredInTest) unregisterChannelAdapter(name);
  if (fs.existsSync(rootDir)) fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('parseChannelExtensionManifest', () => {
  const valid = {
    id: 'acme-echo',
    kind: 'channel',
    name: 'Acme Echo',
    channelType: 'acme-echo',
    minHostVersion: '^2.0.0',
    entry: './index.js',
  };

  it('accepts a well-formed manifest and normalizes it', () => {
    const r = parseChannelExtensionManifest({ ...valid, capabilities: ['text'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.id).toBe('acme-echo');
      expect(r.manifest.kind).toBe('channel');
      expect(r.manifest.capabilities).toEqual(['text']);
    }
  });

  it('rejects a non-object', () => {
    expect(parseChannelExtensionManifest(null)).toMatchObject({ ok: false });
    expect(parseChannelExtensionManifest('nope')).toMatchObject({ ok: false });
    expect(parseChannelExtensionManifest([])).toMatchObject({ ok: false });
  });

  it('rejects a wrong/missing kind', () => {
    const r = parseChannelExtensionManifest({ ...valid, kind: 'plugin' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/kind/);
  });

  it('rejects missing required string fields', () => {
    for (const field of ['id', 'name', 'channelType', 'minHostVersion', 'entry'] as const) {
      const bad = { ...valid } as Record<string, unknown>;
      delete bad[field];
      const r = parseChannelExtensionManifest(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(new RegExp(field));
    }
  });

  it('rejects a path-traversal or absolute entry', () => {
    expect(parseChannelExtensionManifest({ ...valid, entry: '../evil.js' })).toMatchObject({ ok: false });
    expect(parseChannelExtensionManifest({ ...valid, entry: '/etc/passwd' })).toMatchObject({ ok: false });
    expect(parseChannelExtensionManifest({ ...valid, entry: 'sub/../../x.js' })).toMatchObject({ ok: false });
  });

  it('rejects non-string-array capabilities', () => {
    const r = parseChannelExtensionManifest({ ...valid, capabilities: [1, 2] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/capabilities/);
  });
});

describe('loadChannelExtensions', () => {
  it('returns an empty summary with zero effect when EXTENSIONS_DIR is missing', async () => {
    const missing = path.join(rootDir, 'does-not-exist');
    const before = getRegisteredChannelNames().slice();
    const summary = await loadChannelExtensions({ extensionsDir: missing, hostVersion: HOST_VERSION });
    expect(summary.loaded).toHaveLength(0);
    expect(summary.skipped).toHaveLength(0);
    // Registry unchanged.
    expect(getRegisteredChannelNames().sort()).toEqual(before.sort());
  });

  it('loads a conforming extension and registers its adapter', async () => {
    const channelType = 'ext-conforming-' + Date.now();
    registeredInTest.push(channelType);
    writeExtension({
      dirName: 'conforming',
      manifest: {
        id: 'conforming-ext',
        kind: 'channel',
        name: 'Conforming Ext',
        channelType,
        minHostVersion: '^2.0.0',
        entry: './index.ts',
      },
      entrySource: conformingEntrySource(channelType),
    });

    const summary = await loadChannelExtensions({ extensionsDir: rootDir, hostVersion: HOST_VERSION });

    expect(summary.loaded).toHaveLength(1);
    expect(summary.loaded[0]).toMatchObject({ id: 'conforming-ext', channelType, status: 'loaded' });
    expect(getRegisteredChannelNames()).toContain(channelType);
    // The factory is retrievable and yields a conforming adapter.
    const factory = getRegisteredFactory(channelType);
    expect(factory).toBeTypeOf('function');
  });

  it('skips an extension whose minHostVersion the host does not satisfy', async () => {
    const channelType = 'ext-incompat-' + Date.now();
    registeredInTest.push(channelType);
    writeExtension({
      dirName: 'incompatible',
      manifest: {
        id: 'incompat-ext',
        kind: 'channel',
        name: 'Incompatible Ext',
        channelType,
        minHostVersion: '^3.0.0', // host is 2.x → not satisfied
        entry: './index.ts',
      },
      entrySource: conformingEntrySource(channelType),
    });

    const summary = await loadChannelExtensions({ extensionsDir: rootDir, hostVersion: HOST_VERSION });

    expect(summary.loaded).toHaveLength(0);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0].reason).toMatch(/minHostVersion/);
    // Crucially, the incompatible entry was NEVER imported, so nothing registered.
    expect(getRegisteredChannelNames()).not.toContain(channelType);
  });

  it('rejects + unregisters an adapter that fails the contract gate', async () => {
    const channelType = 'ext-broken-' + Date.now();
    registeredInTest.push(channelType);
    writeExtension({
      dirName: 'broken-contract',
      manifest: {
        id: 'broken-ext',
        kind: 'channel',
        name: 'Broken Ext',
        channelType,
        minHostVersion: '*',
        entry: './index.ts',
      },
      entrySource: brokenEntrySource(channelType),
    });

    const summary = await loadChannelExtensions({ extensionsDir: rootDir, hostVersion: HOST_VERSION });

    expect(summary.loaded).toHaveLength(0);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0].reason).toMatch(/contract gate/);
    // The self-registered-but-rejected adapter was backed out of the registry.
    expect(getRegisteredChannelNames()).not.toContain(channelType);
  });

  it('skips (fail-open) a broken manifest without crashing', async () => {
    writeExtension({
      dirName: 'bad-json',
      manifest: '{ this is not valid json',
      entrySource: '// never imported',
    });

    const summary = await loadChannelExtensions({ extensionsDir: rootDir, hostVersion: HOST_VERSION });
    expect(summary.loaded).toHaveLength(0);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0].reason).toMatch(/invalid manifest\.json/);
  });

  it('skips (fail-open) when the entry import throws, without crashing', async () => {
    const channelType = 'ext-throw-' + Date.now();
    registeredInTest.push(channelType);
    writeExtension({
      dirName: 'throwing-entry',
      manifest: {
        id: 'throwing-ext',
        kind: 'channel',
        name: 'Throwing Ext',
        channelType,
        minHostVersion: '*',
        entry: './index.ts',
      },
      entrySource: `throw new Error('boom at import time');`,
    });

    const summary = await loadChannelExtensions({ extensionsDir: rootDir, hostVersion: HOST_VERSION });
    expect(summary.loaded).toHaveLength(0);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0].reason).toMatch(/import threw/);
    expect(getRegisteredChannelNames()).not.toContain(channelType);
  });

  it('skips an entry that imports fine but registers nothing', async () => {
    writeExtension({
      dirName: 'no-register',
      manifest: {
        id: 'inert-ext',
        kind: 'channel',
        name: 'Inert Ext',
        channelType: 'inert',
        minHostVersion: '*',
        entry: './index.ts',
      },
      entrySource: `// imports cleanly but never calls registerChannelAdapter`,
    });

    const summary = await loadChannelExtensions({ extensionsDir: rootDir, hostVersion: HOST_VERSION });
    expect(summary.loaded).toHaveLength(0);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0].reason).toMatch(/did not call registerChannelAdapter/);
  });

  it('skips an extension with a missing entry file', async () => {
    writeExtension({
      dirName: 'missing-entry',
      manifest: {
        id: 'missing-entry-ext',
        kind: 'channel',
        name: 'Missing Entry Ext',
        channelType: 'missing-entry',
        minHostVersion: '*',
        entry: './index.ts',
      },
      // no entrySource → file not written
    });

    const summary = await loadChannelExtensions({ extensionsDir: rootDir, hostVersion: HOST_VERSION });
    expect(summary.loaded).toHaveLength(0);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0].reason).toMatch(/entry not found/);
  });

  it('readHostVersion resolves the repo package.json version', () => {
    // Sanity: the real host version parses to a 2.x semver. The contract gate
    // and version gate both depend on this being read correctly.
    expect(readHostVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  // Keep the contract module path referenced so a rename surfaces here too.
  it('contract module exists at the documented path', () => {
    expect(fs.existsSync(CONTRACT_PATH)).toBe(true);
  });
});
