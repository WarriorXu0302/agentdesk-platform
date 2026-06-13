/**
 * Shared host-side gateway HMAC signing primitive.
 *
 * Two host-side callers sign backend-gateway requests with the same algorithm:
 *   1. roster-gateway.ts — the roster-DM authority call (ADR-0023).
 *   2. modules/gateway-signing-proxy — the per-session signing credential proxy
 *      that signs on behalf of containers so the signingKey never enters a
 *      container (ADR-0034).
 *
 * The canonical form and header naming MUST stay byte-identical to what the
 * container signer produces (container/agent-runner/src/mcp-tools/gateway.ts),
 * because a backend validates one HMAC regardless of who signed. The container
 * is a separate build and cannot import this module — keep the two in sync.
 *
 * Canonical signing form: `<timestamp>.<nonce>.<body>` — the separators are a
 * byte that cannot appear in a base-10 integer or a hex nonce, so there is no
 * ambiguity between the timestamp and the body.
 */
import crypto from 'node:crypto';

import { PLATFORM_PROTOCOL_NAMESPACE } from './branding.js';

/** Default signing header names, derived from the brand namespace. */
export const SIGNING_TIMESTAMP_HEADER = `x-${PLATFORM_PROTOCOL_NAMESPACE}-timestamp`;
export const SIGNING_NONCE_HEADER = `x-${PLATFORM_PROTOCOL_NAMESPACE}-nonce`;
export const SIGNING_SIGNATURE_HEADER = `x-${PLATFORM_PROTOCOL_NAMESPACE}-signature`;

/** Optional per-gateway overrides for the three signing header names. */
export interface SigningHeaderNames {
  timestamp?: string;
  nonce?: string;
  signature?: string;
}

/**
 * Compute the HMAC-SHA256 signature for a gateway request over the canonical
 * `<timestamp>.<nonce>.<body>` form.
 */
export function computeGatewaySignature(key: string, timestamp: string, nonce: string, body: string): string {
  return crypto.createHmac('sha256', key).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

/**
 * Stamp the three signing headers (timestamp / nonce / signature) onto a header
 * map for the EXACT bytes of `body`. The caller must forward the same `body`
 * string it passed here, unchanged — re-serializing would change the bytes and
 * break the signature the backend recomputes.
 *
 * Returns the timestamp/nonce used so a caller (e.g. the proxy audit) can log
 * them.
 */
export function applyGatewaySigningHeaders(
  headers: Record<string, string>,
  key: string,
  body: string,
  opts?: { names?: SigningHeaderNames; now?: number },
): { timestamp: string; nonce: string } {
  const timestamp = Math.floor((opts?.now ?? Date.now()) / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  headers[opts?.names?.timestamp || SIGNING_TIMESTAMP_HEADER] = timestamp;
  headers[opts?.names?.nonce || SIGNING_NONCE_HEADER] = nonce;
  headers[opts?.names?.signature || SIGNING_SIGNATURE_HEADER] = computeGatewaySignature(key, timestamp, nonce, body);
  return { timestamp, nonce };
}
