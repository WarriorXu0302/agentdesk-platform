import { describe, expect, it } from 'vitest';

import { checkBaseImage, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('checkBaseImage', () => {
  it('inspects the wake-path image (namespace + agent-v2 + install slug) and passes when present', () => {
    const inspected: string[] = [];
    const result = checkBaseImage((image) => {
      inspected.push(image);
      return true;
    });
    expect(result).toBe(true);
    expect(inspected).toHaveLength(1);
    // Same constant the wake path resolves (config CONTAINER_IMAGE), not a
    // second hand-rolled construction — assert the derived shape only, since
    // namespace and slug vary per environment.
    expect(inspected[0]).toMatch(/^[a-z0-9-]+-agent-v2-[0-9a-f]{8}:latest$/);
  });

  it('returns false without throwing when the image is missing (non-fatal precheck)', () => {
    expect(checkBaseImage(() => false)).toBe(false);
  });
});
