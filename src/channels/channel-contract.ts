/**
 * Channel adapter contract verifier.
 *
 * `assertChannelAdapterContract` is a small, dependency-free runtime check
 * that an object satisfies the structural half of the {@link ChannelAdapter}
 * contract: the required identity/lifecycle/delivery surface is present and
 * well-typed, and every OPTIONAL method, IF present, is a function.
 *
 * This is published as a reusable asset so a third-party adapter author can
 * `import { assertChannelAdapterContract } from '@.../channels/channel-contract'`
 * and self-test their adapter in their own suite — the platform treats a
 * passing assertion as the structural admission gate for an adapter (ADR-0030).
 *
 * It deliberately does NOT exercise behavior (no network, no `setup`/`deliver`
 * calls) — TypeScript already checks call signatures at compile time; this
 * guards the runtime shape (e.g. a Chat-SDK-bridged adapter assembled from a
 * loosely typed object, or an adapter compiled from JS) and the
 * "optional method is either absent or a function" rule the router relies on.
 */
import type { ChannelAdapter } from './adapter.js';

/** Optional members of {@link ChannelAdapter} that, when present, must be functions. */
const OPTIONAL_METHODS = [
  'setTyping',
  'syncConversations',
  'resolveChannelName',
  'isMember',
  'subscribe',
  'openDM',
] as const;

function fail(adapterLabel: string, problem: string): never {
  throw new Error(`ChannelAdapter contract violation [${adapterLabel}]: ${problem}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Assert that `adapter` structurally satisfies the {@link ChannelAdapter}
 * contract. Throws an Error describing the first violation; returns the adapter
 * (narrowed) on success so it can be used inline.
 *
 * Required:
 *   - `name` / `channelType` — non-empty strings
 *   - `supportsThreads` — boolean
 *   - `setup` / `teardown` / `isConnected` / `deliver` — functions
 *
 * Optional (validated only if present): `setTyping`, `syncConversations`,
 * `resolveChannelName`, `isMember`, `subscribe`, `openDM` — must be functions.
 */
export function assertChannelAdapterContract(adapter: unknown): ChannelAdapter {
  if (adapter === null || typeof adapter !== 'object') {
    fail('unknown', `expected an object, got ${adapter === null ? 'null' : typeof adapter}`);
  }
  const a = adapter as Record<string, unknown>;
  const label = isNonEmptyString(a.name) ? a.name : isNonEmptyString(a.channelType) ? a.channelType : 'unnamed';

  if (!isNonEmptyString(a.name)) fail(label, '`name` must be a non-empty string');
  if (!isNonEmptyString(a.channelType)) fail(label, '`channelType` must be a non-empty string');
  if (typeof a.supportsThreads !== 'boolean') fail(label, '`supportsThreads` must be a boolean');

  for (const method of ['setup', 'teardown', 'isConnected', 'deliver'] as const) {
    if (typeof a[method] !== 'function') fail(label, `\`${method}\` must be a function`);
  }

  for (const method of OPTIONAL_METHODS) {
    const value = a[method];
    if (value !== undefined && typeof value !== 'function') {
      fail(label, `optional \`${method}\`, when present, must be a function (got ${typeof value})`);
    }
  }

  return adapter as ChannelAdapter;
}
