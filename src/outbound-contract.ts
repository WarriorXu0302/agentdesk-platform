/**
 * The container→host trust boundary (ADR-0063).
 *
 * `outbound.db` is the ONE table the untrusted side writes and the host reads.
 * Everything in `messages_out.content` is agent-authored JSON: a confused or
 * compromised agent controls every byte of it. Before this module the host
 * decoded that payload eleven different ways — `JSON.parse` at the call site,
 * then `content.x as string` in each delivery-action handler — so the actual
 * contract lived in eleven independent casts of varying fidelity, and a cast
 * is not a check: `content.apt as string[]` compiles for a payload that is a
 * number, and TypeScript is gone at runtime.
 *
 * This module is the single decode point. It answers two questions the
 * handlers should never have to ask again:
 *
 *   1. Is this payload structurally admissible at all?  (`parseOutboundContent`)
 *   2. Is this field the type the handler believes it is?  (`readString` etc.)
 *
 * Both answer with a REASON, not a boolean, because the caller must be able to
 * tell a permanent contract violation from a transient failure. A malformed
 * payload is deterministically malformed: retrying it burns the delivery
 * budget and head-of-line-blocks the session's queue for nothing.
 *
 * Deliberately dependency-free. Adding a validation library to a security
 * boundary would put a supply-chain surface directly astride the trust line
 * this file exists to defend; the whole contract fits in a page you can read.
 */

/** Hard ceiling on a single outbound payload. */
export const MAX_OUTBOUND_CONTENT_BYTES = 4 * 1024 * 1024;

/**
 * Keys that mutate an object's prototype chain when used as an assignment
 * target. The concrete hazard here is NOT global `Object.prototype` pollution
 * — `obj[k] = v` for these keys touches only that object — it is that the
 * write SILENTLY DOES NOTHING an observer can see: `JSON.stringify` skips the
 * prototype, so a config write appears to succeed and the operator is told it
 * succeeded, while nothing was persisted. A boundary that can be made to lie
 * about its own effect is worse than one that rejects.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Nesting depth beyond which we stop trusting the payload's shape. */
const MAX_DEPTH = 12;

export type OutboundParseResult = { ok: true; content: Record<string, unknown> } | { ok: false; reason: string };

function scan(value: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH) return `payload nests deeper than ${MAX_DEPTH} levels`;
  if (Array.isArray(value)) {
    for (const item of value) {
      const bad = scan(item, depth + 1);
      if (bad) return bad;
    }
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return `payload contains forbidden key "${key}"`;
    const bad = scan((value as Record<string, unknown>)[key], depth + 1);
    if (bad) return bad;
  }
  return null;
}

/**
 * Decode one `messages_out.content` blob.
 *
 * Rejects — as PERMANENT, never-retriable failures — anything that is not a
 * plain JSON object within the size, depth, and key rules above. Note that
 * `JSON.parse` itself already drops a literal `"__proto__"` key into an own
 * property rather than invoking the setter, so the scan below is what makes
 * that key visible instead of letting it reach an assignment target later.
 */
export function parseOutboundContent(raw: string): OutboundParseResult {
  if (Buffer.byteLength(raw, 'utf8') > MAX_OUTBOUND_CONTENT_BYTES) {
    return { ok: false, reason: `payload exceeds ${MAX_OUTBOUND_CONTENT_BYTES} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `payload is ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed}, expected a JSON object`,
    };
  }
  const bad = scan(parsed, 0);
  if (bad) return { ok: false, reason: bad };
  return { ok: true, content: parsed as Record<string, unknown> };
}

/**
 * Field readers.
 *
 * All of them are STRICT: no coercion, ever. `APT_RE.test(123)` passes because
 * `RegExp.test` stringifies its argument, so a validator built on casts will
 * happily wave a number through a name check and hand it to a shell. These
 * readers reject the wrong type instead of repairing it — the agent gets told
 * what it got wrong, which is more useful than a silently coerced value.
 */

export type FieldResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function readString(
  content: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; maxLength?: number; pattern?: RegExp; default?: string } = {},
): FieldResult<string> {
  const raw = content[key];
  if (raw === undefined || raw === null) {
    if (opts.required) return { ok: false, reason: `"${key}" is required` };
    return { ok: true, value: opts.default ?? '' };
  }
  if (typeof raw !== 'string') return { ok: false, reason: `"${key}" must be a string, got ${describe(raw)}` };
  if (opts.maxLength !== undefined && raw.length > opts.maxLength) {
    return { ok: false, reason: `"${key}" exceeds ${opts.maxLength} characters` };
  }
  if (opts.pattern && !opts.pattern.test(raw)) {
    return { ok: false, reason: `"${key}" has a disallowed value: ${JSON.stringify(raw.slice(0, 64))}` };
  }
  return { ok: true, value: raw };
}

export function readStringArray(
  content: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; maxItems?: number; maxLength?: number; pattern?: RegExp } = {},
): FieldResult<string[]> {
  const raw = content[key];
  if (raw === undefined || raw === null) {
    if (opts.required) return { ok: false, reason: `"${key}" is required` };
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) return { ok: false, reason: `"${key}" must be an array, got ${describe(raw)}` };
  if (opts.maxItems !== undefined && raw.length > opts.maxItems) {
    return { ok: false, reason: `"${key}" has more than ${opts.maxItems} entries` };
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'string')
      return { ok: false, reason: `"${key}[${i}]" must be a string, got ${describe(item)}` };
    if (opts.maxLength !== undefined && item.length > opts.maxLength) {
      return { ok: false, reason: `"${key}[${i}]" exceeds ${opts.maxLength} characters` };
    }
    if (opts.pattern && !opts.pattern.test(item)) {
      return { ok: false, reason: `"${key}[${i}]" has a disallowed value: ${JSON.stringify(item.slice(0, 64))}` };
    }
    out.push(item);
  }
  return { ok: true, value: out };
}

export function readStringRecord(
  content: Record<string, unknown>,
  key: string,
  opts: { maxEntries?: number; maxLength?: number; keyPattern?: RegExp } = {},
): FieldResult<Record<string, string>> {
  const raw = content[key];
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `"${key}" must be an object, got ${describe(raw)}` };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (opts.maxEntries !== undefined && entries.length > opts.maxEntries) {
    return { ok: false, reason: `"${key}" has more than ${opts.maxEntries} entries` };
  }
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of entries) {
    if (opts.keyPattern && !opts.keyPattern.test(k)) {
      return { ok: false, reason: `"${key}" has a disallowed key: ${JSON.stringify(k.slice(0, 64))}` };
    }
    if (typeof v !== 'string') return { ok: false, reason: `"${key}.${k}" must be a string, got ${describe(v)}` };
    if (opts.maxLength !== undefined && v.length > opts.maxLength) {
      return { ok: false, reason: `"${key}.${k}" exceeds ${opts.maxLength} characters` };
    }
    out[k] = v;
  }
  return { ok: true, value: { ...out } };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Thrown when the container wrote something the contract forbids.
 *
 * Carried as a distinct type so the delivery loop can dead-letter it on the
 * FIRST attempt: no amount of retrying makes a malformed row well-formed, and
 * each pointless retry delays every later row in that session's queue.
 */
export class OutboundContractError extends Error {
  constructor(reason: string) {
    super(`outbound contract violation: ${reason}`);
    this.name = 'OutboundContractError';
  }
}
