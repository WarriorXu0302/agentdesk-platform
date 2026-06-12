/**
 * Map a flat MCP tool name (e.g. `send_message`, `gateway_execute`) to a
 * schema-compliant `mcp.<group>.<tool>` span name (ADR-0026, span schema §4.9).
 *
 * Hard rules enforced here so a future tool name can never produce an
 * out-of-grammar span name:
 *   - exactly 3 segments: `mcp` . <group> . <tool>
 *   - all lowercase snake_case (illegal chars -> `_`)
 *   - second segment (group) stays coarse: `core`, `erp`, ...
 *   - business detail (the real tool name) ALSO rides on the `tool.name`
 *     attribute; the span name is a low-cardinality label only.
 *
 * Grouping:
 *   - `gateway_*`  -> group `erp`,  tool = remainder (gateway_execute -> mcp.erp.execute)
 *   - everything else -> group `core`, tool = sanitized name
 */

const GATEWAY_PREFIX = 'gateway_';

function sanitizeSegment(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'unknown';
}

export function mcpSpanName(toolName: string): string {
  const name = (toolName ?? '').trim();
  if (name.toLowerCase().startsWith(GATEWAY_PREFIX)) {
    const slot = sanitizeSegment(name.slice(GATEWAY_PREFIX.length));
    return `mcp.erp.${slot}`;
  }
  return `mcp.core.${sanitizeSegment(name)}`;
}
