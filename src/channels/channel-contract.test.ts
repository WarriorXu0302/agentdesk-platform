/**
 * Channel contract conformance tests (ADR-0030).
 *
 * Two layers:
 *   1. `assertChannelAdapterContract` unit checks — the reusable asset that a
 *      third-party adapter author imports to self-test. Verifies it accepts a
 *      well-formed adapter and rejects each structural violation.
 *   2. Registry conformance — every adapter registered in the in-tree registry
 *      (cli + feishu MUST be present) is run through the assertion, plus the
 *      finer-grained "deliver returns a Promise" / "optional methods are
 *      functions" checks the asset can't make without calling deliver. The
 *      adapters are pulled from the REAL registered factories (via a test
 *      seam) so this proves the in-tree registration, not a reconstruction.
 *
 * No network, no real setup() — purely structural, deterministic, fast.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { assertChannelAdapterContract } from './channel-contract.js';
import type { ChannelAdapter } from './adapter.js';

function fullAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    name: 'demo',
    channelType: 'demo',
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver() {
      return undefined;
    },
    ...overrides,
  };
}

describe('assertChannelAdapterContract — reusable adapter self-test asset', () => {
  it('accepts a well-formed adapter and returns it', () => {
    const adapter = fullAdapter();
    expect(assertChannelAdapterContract(adapter)).toBe(adapter);
  });

  it('accepts an adapter that declares the optional methods', () => {
    const adapter = fullAdapter({
      supportsThreads: true,
      async setTyping() {},
      async syncConversations() {
        return [];
      },
      async resolveChannelName() {
        return null;
      },
      async isMember() {
        return undefined;
      },
      async subscribe() {},
      async openDM() {
        return 'dm';
      },
    });
    expect(() => assertChannelAdapterContract(adapter)).not.toThrow();
  });

  it('rejects non-objects', () => {
    expect(() => assertChannelAdapterContract(null)).toThrow(/contract violation/);
    expect(() => assertChannelAdapterContract(undefined)).toThrow(/expected an object/);
    expect(() => assertChannelAdapterContract('feishu')).toThrow(/expected an object/);
  });

  it('rejects a missing or empty name / channelType', () => {
    expect(() => assertChannelAdapterContract(fullAdapter({ name: '' }))).toThrow(/`name` must be a non-empty string/);
    expect(() => assertChannelAdapterContract(fullAdapter({ name: '   ' }))).toThrow(/`name`/);
    expect(() => assertChannelAdapterContract(fullAdapter({ channelType: '' }))).toThrow(
      /`channelType` must be a non-empty string/,
    );
  });

  it('rejects a non-boolean supportsThreads', () => {
    expect(() => assertChannelAdapterContract(fullAdapter({ supportsThreads: 'yes' as unknown as boolean }))).toThrow(
      /`supportsThreads` must be a boolean/,
    );
  });

  it('rejects when a required lifecycle/delivery method is missing or not a function', () => {
    for (const method of ['setup', 'teardown', 'isConnected', 'deliver'] as const) {
      const broken = fullAdapter({ [method]: 123 as unknown as never });
      expect(() => assertChannelAdapterContract(broken)).toThrow(new RegExp(`\`${method}\` must be a function`));
    }
  });

  it('rejects when an optional method is present but not a function', () => {
    const broken = fullAdapter({ isMember: 'not-a-fn' as unknown as never });
    expect(() => assertChannelAdapterContract(broken)).toThrow(/optional `isMember`, when present, must be a function/);
  });

  it('names the offending adapter in the error for debuggability', () => {
    expect(() =>
      assertChannelAdapterContract(fullAdapter({ name: 'acme-chat', deliver: 5 as unknown as never })),
    ).toThrow(/\[acme-chat\]/);
  });
});

describe('registry conformance — in-tree adapters satisfy the contract', () => {
  // Feishu's env-driven factory returns null without credentials; provide a
  // minimal valid webhook config so the factory yields a real adapter that we
  // can run through the contract. We do NOT call setup() — just inspect shape.
  const ENV_KEYS = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_ENCRYPT_KEY', 'FEISHU_EVENT_MODE'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.FEISHU_APP_ID = 'cli_contract_test';
    process.env.FEISHU_APP_SECRET = 'secret_contract_test';
    process.env.FEISHU_ENCRYPT_KEY = 'encrypt_contract_test';
    process.env.FEISHU_EVENT_MODE = 'webhook';
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('cli and feishu are both registered', async () => {
    await import('./cli.js');
    await import('./feishu.js');
    const { getRegisteredChannelNames } = await import('./channel-registry.js');
    const names = getRegisteredChannelNames();
    expect(names).toContain('cli');
    expect(names).toContain('feishu');
  });

  it('every registered adapter (cli + feishu) satisfies the ChannelAdapter contract', async () => {
    await import('./cli.js');
    await import('./feishu.js');
    const { getRegisteredChannelNames, __getRegisteredFactoryForTests } = await import('./channel-registry.js');

    const names = getRegisteredChannelNames();
    // Guard: the two in-tree adapters must be present in the registered set.
    expect(names).toEqual(expect.arrayContaining(['cli', 'feishu']));

    let sawCli = false;
    let sawFeishu = false;

    for (const name of names) {
      const factory = __getRegisteredFactoryForTests(name);
      expect(factory).toBeTypeOf('function');
      const adapter = await factory!();
      // The feishu env we set guarantees a non-null adapter; cli is always
      // non-null. Any other registered channel without creds may be null —
      // skip those (nothing to assert about an un-instantiated factory).
      if (!adapter) continue;
      if (adapter.channelType === 'cli') sawCli = true;
      if (adapter.channelType === 'feishu') sawFeishu = true;

      // Structural contract (reusable asset).
      expect(() => assertChannelAdapterContract(adapter)).not.toThrow();

      // deliver must return a Promise — delivery.ts awaits it. Probe with a
      // target that resolves to a no-op (cli: no connected client) or an
      // eventual rejection (feishu: would attempt a token fetch); we only
      // assert the synchronous return is thenable, never await success.
      const ret = adapter.deliver('contract-probe:nonexistent', null, { kind: 'chat', content: { text: '' } });
      expect(ret).toBeInstanceOf(Promise);
      void Promise.resolve(ret).catch(() => undefined);

      // Optional methods, if present, are functions (mirrors the asset rule,
      // asserted directly against the live adapter for clarity).
      for (const m of [
        'setTyping',
        'syncConversations',
        'resolveChannelName',
        'isMember',
        'subscribe',
        'openDM',
      ] as const) {
        const v = (adapter as unknown as Record<string, unknown>)[m];
        if (v !== undefined) expect(typeof v).toBe('function');
      }
    }

    // Both in-tree adapters were actually instantiated and checked.
    expect(sawCli).toBe(true);
    expect(sawFeishu).toBe(true);
  });
});
