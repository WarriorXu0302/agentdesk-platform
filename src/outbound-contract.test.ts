/**
 * The container→host trust boundary (ADR-0063).
 *
 * These tests exist because a TypeScript cast is not a runtime check. The
 * handlers on the host side used to read agent-authored payloads as
 * `content.apt as string[]`, which compiles for a payload that is a number,
 * an object, or absent — and the compiler is gone by the time the container
 * writes the row. Each case below is a shape a compromised or merely confused
 * runner can put in `messages_out.content` today.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_OUTBOUND_CONTENT_BYTES,
  parseOutboundContent,
  readString,
  readStringArray,
  readStringRecord,
} from './outbound-contract.js';

const PROTO = ['__pro', 'to__'].join(''); // avoid a literal __proto__ key in this file's own source

function ok(raw: unknown): Record<string, unknown> {
  const r = parseOutboundContent(JSON.stringify(raw));
  if (!r.ok) throw new Error(`expected parse to succeed, got: ${r.reason}`);
  return r.content;
}

function reason(raw: string): string {
  const r = parseOutboundContent(raw);
  if (r.ok) throw new Error('expected parse to fail');
  return r.reason;
}

describe('parseOutboundContent — structural admissibility', () => {
  it('accepts a plain object and hands back its fields', () => {
    expect(ok({ action: 'schedule_task', when: 'tomorrow' })).toEqual({
      action: 'schedule_task',
      when: 'tomorrow',
    });
  });

  it('rejects every non-object JSON top level, naming what it got', () => {
    expect(reason('null')).toContain('null');
    expect(reason('[1,2,3]')).toContain('an array');
    expect(reason('42')).toContain('number');
    expect(reason('"just a string"')).toContain('string');
  });

  it('rejects malformed JSON instead of letting it throw at the call site', () => {
    expect(reason('{"action":')).toContain('not valid JSON');
  });

  it('rejects a payload past the size ceiling', () => {
    const huge = JSON.stringify({ text: 'x'.repeat(MAX_OUTBOUND_CONTENT_BYTES) });
    expect(reason(huge)).toContain('exceeds');
  });

  it('rejects prototype-mutating keys at the top level and nested', () => {
    expect(reason(`{"${PROTO}":{"command":"evil"}}`)).toContain(PROTO);
    expect(reason(`{"a":{"b":[{"${PROTO}":1}]}}`)).toContain(PROTO);
    expect(reason('{"constructor":1}')).toContain('constructor');
    expect(reason('{"prototype":1}')).toContain('prototype');
  });

  it('rejects a payload nested past the depth bound', () => {
    let nested = '1';
    for (let i = 0; i < 40; i++) nested = `{"a":${nested}}`;
    expect(reason(nested)).toContain('nests deeper');
  });

  /**
   * The concrete harm the forbidden-key rule prevents. Without it, a name of
   * `__proto__` reaches `cfg.mcpServers[name] = entry` in the self-mod apply
   * path, where the assignment sets that object's prototype instead of an own
   * property: JSON.stringify skips it, so NOTHING is persisted — and the
   * operator is told the change succeeded. A boundary that can be made to lie
   * about its own effect is worse than one that rejects.
   */
  it('pins the silent-no-op that makes the key dangerous', () => {
    const cfg: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
    cfg.mcpServers[PROTO] = { command: 'evil' };
    expect(Object.keys(cfg.mcpServers)).toHaveLength(0);
    expect(JSON.stringify(cfg)).toBe('{"mcpServers":{}}');
  });
});

describe('readString', () => {
  it('returns the value and enforces required', () => {
    expect(readString({ a: 'x' }, 'a')).toEqual({ ok: true, value: 'x' });
    expect(readString({}, 'a', { required: true }).ok).toBe(false);
    expect(readString({}, 'a', { default: 'fallback' })).toEqual({ ok: true, value: 'fallback' });
  });

  it('refuses to coerce — a number is a rejection, not a stringification', () => {
    const r = readString({ a: 42 }, 'a');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('must be a string');
  });

  it('enforces maxLength and pattern', () => {
    expect(readString({ a: 'abcdef' }, 'a', { maxLength: 3 }).ok).toBe(false);
    expect(readString({ a: 'has space' }, 'a', { pattern: /^\S+$/ }).ok).toBe(false);
    expect(readString({ a: 'nospace' }, 'a', { pattern: /^\S+$/ }).ok).toBe(true);
  });
});

describe('readStringArray', () => {
  it('rejects a non-array where a cast would have accepted it', () => {
    // `content.apt as string[]` on a string yields something with .length and
    // no .find — the old code threw a TypeError several lines later.
    const r = readStringArray({ apt: 'curl' }, 'apt');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('must be an array');
  });

  /**
   * The coercion trap, in one assertion.
   *
   * `/^[a-z0-9][a-z0-9._+-]*$/.test(123)` is TRUE — RegExp.test stringifies
   * its argument — so the previous validator waved a number straight through a
   * package-name check and into a list bound for a shell. A strict reader has
   * to reject on TYPE before the pattern is ever consulted.
   */
  it('rejects a non-string element even when the pattern would pass its coercion', () => {
    const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
    expect(APT_RE.test(123 as unknown as string)).toBe(true); // the trap, pinned

    const r = readStringArray({ apt: [123] }, 'apt', { pattern: APT_RE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('apt[0]');
  });

  it('rejects a nested array whose join happens to look like a valid name', () => {
    const r = readStringArray({ apt: [['curl']] }, 'apt', { pattern: /^[a-z0-9][a-z0-9._+-]*$/ });
    expect(r.ok).toBe(false);
  });

  it('enforces maxItems, per-item maxLength, and pattern', () => {
    expect(readStringArray({ a: ['x', 'y'] }, 'a', { maxItems: 1 }).ok).toBe(false);
    expect(readStringArray({ a: ['toolong'] }, 'a', { maxLength: 3 }).ok).toBe(false);
    expect(readStringArray({ a: ['UPPER'] }, 'a', { pattern: /^[a-z]+$/ }).ok).toBe(false);
    expect(readStringArray({ a: ['fine'] }, 'a', { pattern: /^[a-z]+$/ })).toEqual({ ok: true, value: ['fine'] });
  });

  it('treats a missing field as empty unless required', () => {
    expect(readStringArray({}, 'a')).toEqual({ ok: true, value: [] });
    expect(readStringArray({}, 'a', { required: true }).ok).toBe(false);
  });
});

describe('readStringRecord', () => {
  it('rejects an array and a non-string value', () => {
    expect(readStringRecord({ env: [] }, 'env').ok).toBe(false);
    const r = readStringRecord({ env: { TOKEN: { nested: true } } }, 'env');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('env.TOKEN');
  });

  it('enforces key pattern, entry count, and value length', () => {
    expect(readStringRecord({ env: { '9bad': 'v' } }, 'env', { keyPattern: /^[A-Za-z_]\w*$/ }).ok).toBe(false);
    expect(readStringRecord({ env: { A: '1', B: '2' } }, 'env', { maxEntries: 1 }).ok).toBe(false);
    expect(readStringRecord({ env: { A: 'toolong' } }, 'env', { maxLength: 3 }).ok).toBe(false);
  });

  it('returns a normal object with an ordinary prototype', () => {
    const r = readStringRecord({ env: { A: '1' } }, 'env');
    expect(r).toEqual({ ok: true, value: { A: '1' } });
    if (r.ok) expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
  });

  it('treats a missing field as empty', () => {
    expect(readStringRecord({}, 'env')).toEqual({ ok: true, value: {} });
  });
});
