/**
 * Runner-side branding — mirrors the host's `src/branding.ts` namespace so
 * the MCP server name and gateway signing-header prefix match across the
 * host/container boundary.
 *
 * The host injects `BRAND_NAMESPACE` at container spawn (see
 * `src/container-runner.ts`). When unset (e.g. a standalone runner in a
 * test), it falls back to the same `agentdesk` default the host uses.
 *
 * Keep this in sync with `src/branding.ts` — they are two separate builds
 * (Node host vs. Bun runner) and cannot share a module.
 */
function sanitizeNamespace(raw: string | undefined, fallback: string): string {
  const slug = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export const PLATFORM_PROTOCOL_NAMESPACE = sanitizeNamespace(process.env.BRAND_NAMESPACE, 'agentdesk');

/** Built-in MCP server name. */
export const MCP_SERVER_NAME = PLATFORM_PROTOCOL_NAMESPACE;

/** Default gateway signing header names, derived from the namespace. */
export const SIGNING_TIMESTAMP_HEADER = `x-${PLATFORM_PROTOCOL_NAMESPACE}-timestamp`;
export const SIGNING_NONCE_HEADER = `x-${PLATFORM_PROTOCOL_NAMESPACE}-nonce`;
export const SIGNING_SIGNATURE_HEADER = `x-${PLATFORM_PROTOCOL_NAMESPACE}-signature`;
