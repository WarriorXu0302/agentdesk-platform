/**
 * Host-side roster-DM gateway authority client (ADR-0023, item 13).
 *
 * Optional, default OFF. When an agent group's container.json declares a
 * `backendGateway` AND `ROSTER_GATEWAY_AUTHORITY=true`, the host asks the
 * gateway to authorize each roster DM BEFORE honoring the local grant table —
 * moving the source of truth toward the "gateway is the only business path"
 * invariant. When unset / off, the local grant table is authoritative (the
 * documented PoC transitional state).
 *
 * This is the FIRST host-originated backend-gateway call in the platform — the
 * gateway tools previously fired only from the container side
 * (container/agent-runner/src/mcp-tools/gateway.ts). To avoid weakening the
 * identity trust chain we reuse the exact same HMAC signing algorithm and
 * header naming the container uses (`HMAC-SHA256(key, ts.nonce.body)`), derived
 * from PLATFORM_PROTOCOL_NAMESPACE. The request carries only routing/scope
 * facts the host already owns (scopeId, slotLabel, participantOpenId,
 * agentGroupId) — never a container-supplied field.
 *
 * fail-closed: if the gateway is unreachable / errors / returns a malformed
 * body, authorize() returns { decision: 'deny' }. If you configured a gateway
 * authority, you asked to trust it — a flaky gateway must NOT silently fall
 * back to the local table (that would be a bypass).
 *
 * NOTE: read-only with respect to the identity trust chain and message flow —
 * this only gates whether a send proceeds; it never mutates grants, audit, or
 * the message itself.
 */
import crypto from 'node:crypto';

import { PLATFORM_PROTOCOL_NAMESPACE } from './branding.js';
import type { BackendGatewayConfig } from './container-config.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const TIMESTAMP_HEADER = `x-${PLATFORM_PROTOCOL_NAMESPACE}-timestamp`;
const NONCE_HEADER = `x-${PLATFORM_PROTOCOL_NAMESPACE}-nonce`;
const SIGNATURE_HEADER = `x-${PLATFORM_PROTOCOL_NAMESPACE}-signature`;

/**
 * Is the gateway the authority for roster-DM authorization? Default OFF.
 * Resolution: process env → `.env`. Read lazily so tests can drive it.
 */
export function rosterGatewayAuthorityEnabled(): boolean {
  const fromProc = process.env.ROSTER_GATEWAY_AUTHORITY;
  if (fromProc !== undefined) return fromProc.trim().toLowerCase() === 'true';
  const dotenv = readEnvFile(['ROSTER_GATEWAY_AUTHORITY']);
  return (dotenv.ROSTER_GATEWAY_AUTHORITY ?? '').trim().toLowerCase() === 'true';
}

/** Same canonical form as the container signer: `<timestamp>.<nonce>.<body>`. */
export function computeGatewaySignature(key: string, timestamp: string, nonce: string, body: string): string {
  return crypto.createHmac('sha256', key).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

/**
 * Does this gateway carry a usable HMAC signing key? The authority path
 * (ROSTER_GATEWAY_AUTHORITY=true) treats an `allow` from the gateway as the
 * final say on whether a DM may proceed — so the request and its response MUST
 * be authenticated. Without a signing key, authorizeDm posts an UNSIGNED body
 * and unconditionally trusts the reply, which means any entity that can reach
 * `baseUrl` could forge an `allow` and drive a roster DM (a trivial authority
 * bypass). The delivery gate calls this before honoring the authority path and
 * fail-closed rejects (`gateway_unsigned_authority`) when it returns false.
 */
export function gatewayHasSigningKey(gateway: BackendGatewayConfig): boolean {
  return !!gateway.signingKey?.trim();
}

export interface AuthorizeDmRequest {
  scopeId: string;
  slotLabel: string;
  participantOpenId: string;
  dmPlatformId: string;
  agentGroupId: string;
  channelType: string;
}

export interface AuthorizeDmDecision {
  decision: 'allow' | 'deny';
  /** Optional reason the gateway supplied (surfaced into dm_audit). */
  reason?: string;
  /**
   * Optional authoritative target override. When the gateway returns one, the
   * host uses it as the delivery destination instead of the local grant's
   * dm_platform_id — letting the gateway be the routing authority too. Must be
   * a `feishu:p2p:ou_*` form; the delivery gate re-validates its shape.
   */
  target?: { channelType?: string; dmPlatformId?: string };
}

/**
 * Allow `fetch` to be injected in tests (Node 18+ has a global fetch; we don't
 * want unit tests to make real network calls). Falls back to global fetch.
 */
type FetchLike = typeof fetch;

/**
 * Ask the backend gateway whether this roster DM may proceed. POSTs to
 * `<baseUrl>/authorizeDm` with the standard HMAC signing headers. fail-closed
 * on any error.
 */
export async function authorizeDm(
  gateway: BackendGatewayConfig,
  req: AuthorizeDmRequest,
  fetchImpl: FetchLike = fetch,
  now: number = Date.now(),
): Promise<AuthorizeDmDecision> {
  const baseUrl = gateway.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) return { decision: 'deny', reason: 'gateway_no_base_url' };

  const body = JSON.stringify({
    operation: 'roster.dm.authorize',
    scopeId: req.scopeId,
    slotLabel: req.slotLabel,
    participantOpenId: req.participantOpenId,
    dmPlatformId: req.dmPlatformId,
    agentGroupId: req.agentGroupId,
    channelType: req.channelType,
  });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(gateway.defaultHeaders ?? {}),
  };
  const key = gateway.signingKey?.trim();
  if (key) {
    const timestamp = Math.floor(now / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    headers[gateway.signingHeaders?.timestamp || TIMESTAMP_HEADER] = timestamp;
    headers[gateway.signingHeaders?.nonce || NONCE_HEADER] = nonce;
    headers[gateway.signingHeaders?.signature || SIGNATURE_HEADER] = computeGatewaySignature(
      key,
      timestamp,
      nonce,
      body,
    );
  }

  const controller = new AbortController();
  const timeoutMs = gateway.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/authorizeDm`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn('roster-dm: gateway authorizeDm non-2xx — fail-closed deny', { status: res.status });
      return { decision: 'deny', reason: `gateway_http_${res.status}` };
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      return { decision: 'deny', reason: 'gateway_bad_json' };
    }
    return interpretDecision(parsed);
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    log.warn('roster-dm: gateway authorizeDm unreachable — fail-closed deny', {
      reason: aborted ? 'timeout' : 'error',
      err,
    });
    return { decision: 'deny', reason: aborted ? 'gateway_timeout' : 'gateway_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Interpret the gateway body. ONLY an explicit allow (`decision === 'allow'` or
 * `allow === true`) authorizes the send; anything else (including an
 * unrecognized shape) is a deny — fail-closed.
 */
function interpretDecision(body: unknown): AuthorizeDmDecision {
  if (typeof body !== 'object' || body === null) return { decision: 'deny', reason: 'gateway_bad_shape' };
  const obj = body as Record<string, unknown>;
  const allowed = obj.decision === 'allow' || obj.allow === true;
  if (!allowed) {
    const reason = typeof obj.reason === 'string' ? obj.reason : 'gateway_denied';
    return { decision: 'deny', reason };
  }
  const out: AuthorizeDmDecision = { decision: 'allow' };
  if (typeof obj.reason === 'string') out.reason = obj.reason;
  const target = obj.target;
  if (typeof target === 'object' && target !== null) {
    const t = target as Record<string, unknown>;
    out.target = {
      channelType: typeof t.channelType === 'string' ? t.channelType : undefined,
      dmPlatformId: typeof t.dmPlatformId === 'string' ? t.dmPlatformId : undefined,
    };
  }
  return out;
}
