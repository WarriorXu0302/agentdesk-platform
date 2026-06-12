/**
 * Provider self-registration registry.
 *
 * Mirrors `src/channels/channel-registry.ts` on the host. Each provider module
 * calls `registerProvider()` at top level; the barrel (`providers/index.ts`)
 * imports every provider module for its side effect so registrations fire
 * before `createProvider()` is called.
 */
import type { AgentProvider, ProviderOptions } from './types.js';

export type ProviderFactory = (options: ProviderOptions) => AgentProvider;

const registry = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  if (registry.has(name)) {
    throw new Error(`Provider already registered: ${name}`);
  }
  registry.set(name, factory);
}

export function getProviderFactory(name: string): ProviderFactory {
  const factory = registry.get(name);
  if (!factory) {
    // The 'sdk-openai' toy provider (Vercel AI SDK, no tools/transcript) was
    // removed in favor of the full 'openai' provider. Point operators there
    // explicitly so an old container.json doesn't fail with a generic error.
    if (name === 'sdk-openai') {
      throw new Error("Unknown provider: sdk-openai. It was removed — use provider 'openai' instead.");
    }
    const known = [...registry.keys()].join(', ') || '(none)';
    throw new Error(`Unknown provider: ${name}. Registered: ${known}`);
  }
  return factory;
}

export function listProviderNames(): string[] {
  return [...registry.keys()];
}
