/**
 * Desensitized parameter summary for TOOL spans (ADR-0026).
 *
 * This wave deliberately does NOT put raw tool arguments on spans — only a
 * coarse, low-risk shape: the sorted list of top-level argument keys and the
 * key count. No values, no nested payloads. This keeps `tool.parameters`
 * queryable ("which params were passed") without leaking message bodies,
 * credentials, ERP payloads, or PII.
 *
 * Putting raw input/output on spans is explicitly a FOLLOW-UP wave that must
 * ship together with full ADR-0007 R16 redaction — see ADR-0026 §Consequences.
 */
export function redactedParamSummary(args: unknown): string {
  if (args === null || args === undefined) return '{redacted, 0 keys}';
  if (typeof args !== 'object' || Array.isArray(args)) {
    // Non-object args (rare): report the type only, never the value.
    return `{redacted, type=${Array.isArray(args) ? 'array' : typeof args}}`;
  }
  const keys = Object.keys(args as Record<string, unknown>).sort();
  if (keys.length === 0) return '{redacted, 0 keys}';
  return `{redacted, ${keys.length} keys: ${keys.join(',')}}`;
}
