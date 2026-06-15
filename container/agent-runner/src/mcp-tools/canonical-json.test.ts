import { describe, expect, it } from 'bun:test';

import { canonicalJSON } from './gateway.js';

describe('canonicalJSON (ADR-0048: stable hashing for audit input_hash + idempotency key)', () => {
  it('is key-order independent for objects (the whole point)', () => {
    expect(canonicalJSON({ a: 1, b: 2 })).toBe(canonicalJSON({ b: 2, a: 1 }));
    expect(canonicalJSON({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it('sorts keys recursively at every depth', () => {
    const x = canonicalJSON({ outer: { z: 1, a: 2 }, first: [{ y: 1, x: 2 }] });
    const y = canonicalJSON({ first: [{ x: 2, y: 1 }], outer: { a: 2, z: 1 } });
    expect(x).toBe(y);
    expect(x).toBe('{"first":[{"x":2,"y":1}],"outer":{"a":2,"z":1}}');
  });

  it('preserves array ORDER (arrays are sequences, not sets)', () => {
    expect(canonicalJSON([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJSON([1, 2, 3])).not.toBe(canonicalJSON([3, 2, 1]));
  });

  it('drops undefined object values (matches JSON.stringify) but keeps null', () => {
    expect(canonicalJSON({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
  });

  it('handles primitives, null, and nested empties', () => {
    expect(canonicalJSON(null)).toBe('null');
    expect(canonicalJSON(42)).toBe('42');
    expect(canonicalJSON('hi')).toBe('"hi"');
    expect(canonicalJSON(true)).toBe('true');
    expect(canonicalJSON({})).toBe('{}');
    expect(canonicalJSON([])).toBe('[]');
  });

  it('throws on a circular reference (caller falls back)', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJSON(a)).toThrow(/circular/);
  });

  it('allows the same object referenced twice (DAG, not a cycle)', () => {
    const shared = { k: 1 };
    expect(() => canonicalJSON({ a: shared, b: shared })).not.toThrow();
    expect(canonicalJSON({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});
