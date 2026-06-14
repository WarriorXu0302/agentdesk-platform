/**
 * Host-side gateway signing credential proxy (ADR-0034). Default OFF.
 *
 * Problem it solves: today the backend-gateway HMAC `signingKey` is mounted into
 * the container via container.json, so a prompt-injected / file-reading agent
 * can exfiltrate the group's long-lived signing key and forge backend requests
 * forever. ADR-0032 (egress lockdown) only mitigates this at the network layer.
 *
 * This proxy removes the key from the container entirely. When enabled, at spawn
 * the host:
 *   - mints a per-session, opaque, scoped, revocable token (gateway-proxy-token),
 *   - mounts a REDACTED container.json (signingKey stripped) into the container,
 *   - injects the proxy URL + token + NO_PROXY into the container env.
 * The container posts UNSIGNED gateway requests to this proxy; the proxy verifies
 * the token, confirms the request body's claimed agent group matches the token's
 * AUTHORITATIVE group (central-DB session→group binding), signs the EXACT bytes
 * with the real key, and forwards to the backend.
 *
 * Structural fail-closed: the container has no key, so if this proxy is
 * unreachable the container literally cannot sign a direct request — there is no
 * fallback path to weaken.
 *
 * This service is read-only with respect to the identity trust chain and message
 * flow: it never mutates grants, sessions, inbound/outbound DBs, or the message
 * itself. It only signs-and-forwards a request the container already chose to
 * make, and writes its own authoritative audit rows.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';

import { readContainerConfig, type BackendGatewayConfig } from './container-config.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  finalizeGatewayProxyAudit,
  recordGatewayProxyIntent,
  reconcileOrphanedProxyAudit,
  type GatewayProxyOutcome,
} from './db/gateway-audit.js';
import {
  mintProxyToken,
  verifyProxyToken,
  type ProxyTokenRecord,
  type VerifyProxyTokenResult,
} from './db/gateway-proxy-token.js';
import { readEnvFile } from './env.js';
import { applyGatewaySigningHeaders } from './gateway-signing.js';
import { log } from './log.js';
import { gatewaySigningProxyTotal } from './metrics.js';

/** Header the container uses to present its per-session proxy token. */
export const PROXY_TOKEN_HEADER = 'x-agentdesk-proxy-token';

/** The docker host alias the container reaches the host on. */
const HOST_ALIAS = 'host.docker.internal';

/**
 * Gateway paths the proxy will sign, split read vs write so a token can be
 * minted with a narrower scope later. Mirrors the container-side GatewayPath
 * enum (separate build, kept in sync).
 */
// /task/status (ADR-0037) only reads task state, so it is read-scoped.
export const READ_PATHS = ['/describe', '/authorize', '/task/status', '/memory/get', '/memory/search'] as const;
// /bulk_execute (ADR-0036) mutates, so it is write-scoped — same trust tier as
// /execute. Proxy-mode containers get a write token covering it.
export const WRITE_PATHS = ['/execute', '/bulk_execute', '/memory/upsert'] as const;
export const ALL_GATEWAY_PATHS: readonly string[] = [...READ_PATHS, ...WRITE_PATHS];

const REQUESTER_SOURCES = new Set(['session', 'agent-asserted']);
const FORWARD_TIMEOUT_FALLBACK_MS = 15_000;

export interface SigningProxyConfig {
  enabled: boolean;
  port: number;
  bind: string;
  ttlMs: number;
  rateLimit: number;
  rateWindowMs: number;
  maxBodyBytes: number;
}

function envValue(key: string): string | undefined {
  const fromProc = process.env[key];
  if (fromProc !== undefined && fromProc !== '') return fromProc;
  const dotenv = readEnvFile([key]);
  return dotenv[key];
}

function envInt(key: string, fallback: number, min: number): number {
  const raw = envValue(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** Resolve the proxy config. Default OFF; reads process env → `.env`. */
export function gatewaySigningProxyConfig(): SigningProxyConfig {
  const flag = (envValue('AGENTDESK_GATEWAY_SIGNING_PROXY') ?? '').trim().toLowerCase();
  return {
    enabled: flag === 'true',
    port: envInt('AGENTDESK_GATEWAY_SIGNING_PROXY_PORT', 8799, 1),
    bind: (envValue('AGENTDESK_GATEWAY_SIGNING_PROXY_BIND') ?? '0.0.0.0').trim() || '0.0.0.0',
    // TTL is only a backstop for a leaked token if revoke-on-exit is missed
    // (host crash). The real bound is revocation at container exit. Default 1h
    // comfortably covers the 30-min container ceiling.
    ttlMs: envInt('AGENTDESK_GATEWAY_SIGNING_PROXY_TTL_MS', 3_600_000, 1000),
    rateLimit: envInt('AGENTDESK_GATEWAY_SIGNING_PROXY_RATE', 600, 1),
    rateWindowMs: envInt('AGENTDESK_GATEWAY_SIGNING_PROXY_RATE_WINDOW_MS', 60_000, 1000),
    maxBodyBytes: envInt('AGENTDESK_GATEWAY_SIGNING_PROXY_MAX_BODY_BYTES', 1_048_576, 1024),
  };
}

export function gatewaySigningProxyEnabled(): boolean {
  return gatewaySigningProxyConfig().enabled;
}

/** The URL a container uses to reach this proxy. */
export function signingProxyContainerUrl(port: number): string {
  return `http://${HOST_ALIAS}:${port}`;
}

/**
 * Mint a per-session token for the proxy and return what the spawn path needs:
 * the raw token (env), the container-facing URL, and the host alias to add to
 * NO_PROXY. Returns null when the proxy is disabled.
 */
export function mintSessionProxyToken(
  sessionId: string,
  agentGroupId: string,
): { token: string; url: string; noProxyHost: string } | null {
  const cfg = gatewaySigningProxyConfig();
  if (!cfg.enabled) return null;
  // Mint full-scope (all paths) for now. The READ_PATHS/WRITE_PATHS split is
  // enforced end-to-end (the proxy rejects any path outside the token's
  // allowedPaths) but the platform has no per-group read-only role model yet to
  // drive a narrower scope — so this is forward-compat scaffolding, not a live
  // per-group policy. Narrow here once such a role model exists.
  const { token } = mintProxyToken({
    sessionId,
    agentGroupId,
    allowedPaths: [...ALL_GATEWAY_PATHS],
    ttlMs: cfg.ttlMs,
  });
  return { token, url: signingProxyContainerUrl(cfg.port), noProxyHost: HOST_ALIAS };
}

// ---------------------------------------------------------------------------
// Core request handling — socket-free so the security decisions are unit
// testable without binding a port.
// ---------------------------------------------------------------------------

export interface ProxyRequestInput {
  method: string;
  pathname: string;
  token: string | undefined;
  sourceIp: string;
  rawBody: string;
}

export interface ProxyRequestResult {
  httpStatus: number;
  body: string;
  /** Metric/outcome label; never includes secrets. */
  outcome: string;
}

export interface ProxyDeps {
  verifyToken: (rawToken: string, sourceIp: string, now?: Date) => VerifyProxyTokenResult;
  resolveGateway: (agentGroupId: string) => BackendGatewayConfig | undefined;
  recordIntent: typeof recordGatewayProxyIntent;
  finalize: typeof finalizeGatewayProxyAudit;
  fetchImpl: typeof fetch;
  /** Returns true if the request is within the per-token rate window. */
  allowRate: (jti: string, now: number) => boolean;
  now: () => number;
}

function jsonError(httpStatus: number, code: string, message: string, outcome: string): ProxyRequestResult {
  return { httpStatus, outcome, body: JSON.stringify({ error: { code, message } }) };
}

/** Run an audit write, swallowing + counting + logging any failure (best-effort). */
function auditSafe(stage: 'intent' | 'final', fn: () => void): void {
  try {
    fn();
  } catch (err) {
    gatewaySigningProxyTotal.labels('audit_write_failed').inc();
    log.error('Gateway signing proxy audit write failed', {
      stage,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function sanitizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Production gateway resolver: authoritative host-side config for a group. */
export function resolveGatewayForGroup(agentGroupId: string): BackendGatewayConfig | undefined {
  const group = getAgentGroup(agentGroupId);
  if (!group) return undefined;
  return readContainerConfig(group.folder).backendGateway;
}

/**
 * The security-bearing core. Verifies the token, enforces the
 * token→group↔body-group identity match, signs the EXACT received bytes with
 * the group's real key, forwards, and writes a two-phase authoritative audit.
 */
export async function processSigningProxyRequest(
  input: ProxyRequestInput,
  deps: ProxyDeps,
): Promise<ProxyRequestResult> {
  // Audit writes are best-effort: a central-DB hiccup must NOT block the actual
  // signing/forwarding (observability is read-only w.r.t. message flow). A
  // failure is counted (audit_write_failed) + logged loud so a finalize failure
  // after a successful backend call — which would otherwise silently leave the
  // row mislabeled 'pending' — is visible. (ADR-0034)
  const recordIntent = (intent: Parameters<typeof deps.recordIntent>[0]): void =>
    auditSafe('intent', () => deps.recordIntent(intent));
  const finalize = (id: string, outcome: Parameters<typeof deps.finalize>[1]): void =>
    auditSafe('final', () => deps.finalize(id, outcome));

  if (input.method !== 'POST') {
    gatewaySigningProxyTotal.labels('bad_request').inc();
    return jsonError(405, 'METHOD_NOT_ALLOWED', 'only POST is supported', 'bad_request');
  }

  // 1. Authenticate the token (existence / revocation / expiry / source-IP pin).
  if (!input.token) {
    gatewaySigningProxyTotal.labels('unauthorized').inc();
    return jsonError(401, 'UNAUTHORIZED', 'missing proxy token', 'unauthorized');
  }
  const verified = deps.verifyToken(input.token, input.sourceIp, new Date(deps.now()));
  if (!verified.ok) {
    const outcome = verified.reason === 'source_ip_mismatch' ? 'source_ip_mismatch' : 'unauthorized';
    gatewaySigningProxyTotal.labels(outcome).inc();
    return jsonError(401, 'UNAUTHORIZED', `token ${verified.reason}`, outcome);
  }
  const record: ProxyTokenRecord = verified.record;

  // 2. Rate limit per token (defends the single-threaded listener).
  if (!deps.allowRate(record.jti, deps.now())) {
    gatewaySigningProxyTotal.labels('rate_limited').inc();
    return jsonError(429, 'RATE_LIMITED', 'per-token rate window exceeded', 'rate_limited');
  }

  // 3. Path allowlist (and read/write split carried on the token).
  if (!ALL_GATEWAY_PATHS.includes(input.pathname) || !record.allowedPaths.includes(input.pathname)) {
    gatewaySigningProxyTotal.labels('forbidden_path').inc();
    return jsonError(403, 'FORBIDDEN_PATH', `path ${input.pathname} not permitted`, 'forbidden_path');
  }

  // 4. Parse the body, then re-serialize it to a CANONICAL form that is what we
  //    both sign and forward. We deliberately do NOT pass the raw bytes through:
  //    a hand-crafted body with duplicate keys (e.g. two `agent` blocks) parses
  //    last-wins under V8 here but could parse first-wins on a heterogeneous
  //    backend, letting the signed bytes "mean" a different group than the one
  //    we identity-checked (a parser differential). Signing+forwarding
  //    JSON.stringify(parsed) collapses duplicates to a single unambiguous key,
  //    so the backend recomputes the HMAC over exactly the bytes we validated.
  //    For a legitimate machine-generated body (already canonical) this is a
  //    no-op — byte-identical to the raw input.
  let parsed: Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(input.rawBody);
    if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error('not an object');
    parsed = p as Record<string, unknown>;
  } catch {
    gatewaySigningProxyTotal.labels('bad_request').inc();
    return jsonError(400, 'BAD_REQUEST', 'body is not a JSON object', 'bad_request');
  }
  const canonicalBody = JSON.stringify(parsed);

  const agentBlock = (parsed.agent as { agentGroupId?: unknown } | undefined) ?? undefined;
  const claimedGroup = typeof agentBlock?.agentGroupId === 'string' ? agentBlock.agentGroupId : null;
  const rawRequesterSource = typeof parsed.requesterSource === 'string' ? parsed.requesterSource : '';
  const requesterSourceCoerced = !REQUESTER_SOURCES.has(rawRequesterSource);
  const requesterSource = requesterSourceCoerced ? 'agent-asserted' : rawRequesterSource;
  const requester = (parsed.requester as { userId?: unknown } | undefined) ?? undefined;
  const userId = typeof requester?.userId === 'string' ? requester.userId : null;
  const operation = typeof parsed.operation === 'string' ? parsed.operation : null;
  const idempotencyKey = typeof parsed.idempotencyKey === 'string' ? parsed.idempotencyKey : null;
  const proxyRequestId = crypto.randomUUID();
  const inputHash = sha256(canonicalBody);

  // 5. Identity cross-check: the body's claimed group MUST equal the token's
  //    authoritative group. A mismatch is an impersonation signal — audit it
  //    and refuse to sign (never sign for a group the caller isn't bound to).
  if (claimedGroup !== record.agentGroupId) {
    recordIntent({
      proxyRequestId,
      sessionId: record.sessionId,
      agentGroupId: record.agentGroupId,
      signedAsGroup: null,
      tokenJti: record.jti,
      path: input.pathname,
      operation,
      userId,
      requesterSource,
      requesterSourceCoerced,
      identityMismatch: true,
      idempotencyKey,
      inputHash,
      errorMsg: `claimed group ${claimedGroup ?? '<none>'} != token group ${record.agentGroupId}`,
    });
    finalize(proxyRequestId, { status: 'error', httpStatus: 409, errorMsg: 'identity_mismatch' });
    gatewaySigningProxyTotal.labels('identity_mismatch').inc();
    return jsonError(409, 'IDENTITY_MISMATCH', 'request agent group does not match session', 'identity_mismatch');
  }

  // 6. Resolve the authoritative signing material host-side. The container
  //    never supplied baseUrl/key — we ignore anything it sent and use the
  //    host's config for the token's group. No key ⇒ fail-closed.
  const gateway = deps.resolveGateway(record.agentGroupId);
  const key = gateway?.signingKey?.trim();
  if (!gateway?.baseUrl || !key) {
    recordIntent({
      proxyRequestId,
      sessionId: record.sessionId,
      agentGroupId: record.agentGroupId,
      signedAsGroup: record.agentGroupId,
      tokenJti: record.jti,
      path: input.pathname,
      operation,
      userId,
      requesterSource,
      requesterSourceCoerced,
      idempotencyKey,
      inputHash,
      errorMsg: 'no host-side signing key for group',
    });
    finalize(proxyRequestId, { status: 'error', httpStatus: 502, errorMsg: 'no_signing_key' });
    gatewaySigningProxyTotal.labels('no_signing_key').inc();
    return jsonError(502, 'NO_SIGNING_KEY', 'gateway not signable for this group', 'no_signing_key');
  }

  // 7. Build a clean header set (we do NOT forward arbitrary container headers)
  //    and sign the EXACT raw bytes.
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
  };
  for (const [k, v] of Object.entries(gateway.defaultHeaders ?? {})) {
    if (typeof v === 'string') headers[k] = v;
  }
  applyGatewaySigningHeaders(headers, key, canonicalBody, {
    names: gateway.signingHeaders,
    now: deps.now(),
  });

  // 8. Two-phase audit: intent BEFORE forwarding (survives a crash window).
  //    This one is FAIL-CLOSED, not best-effort: the audit trail for a privileged
  //    signed backend call is load-bearing (CLAUDE.md), so we never sign+forward
  //    without a durable intent row. If the intent write fails, refuse (503) and
  //    do NOT forward. (finalize below stays best-effort — by then the call has
  //    already happened, so a finalize failure must not retroactively block it.)
  const startedAt = deps.now();
  try {
    deps.recordIntent({
      proxyRequestId,
      sessionId: record.sessionId,
      agentGroupId: record.agentGroupId,
      signedAsGroup: record.agentGroupId,
      tokenJti: record.jti,
      path: input.pathname,
      operation,
      userId,
      requesterSource,
      requesterSourceCoerced,
      idempotencyKey,
      inputHash,
    });
  } catch (err) {
    gatewaySigningProxyTotal.labels('audit_write_failed').inc();
    log.error('Gateway signing proxy: intent audit write failed — refusing to sign (fail-closed)', {
      proxyRequestId,
      err: err instanceof Error ? err.message : String(err),
    });
    return jsonError(503, 'AUDIT_UNAVAILABLE', 'audit write failed; refusing to sign', 'audit_write_failed');
  }

  const target = `${sanitizeBaseUrl(gateway.baseUrl)}${input.pathname}`;
  const controller = new AbortController();
  const timeoutMs = gateway.timeoutMs ?? FORWARD_TIMEOUT_FALLBACK_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await deps.fetchImpl(target, {
      method: 'POST',
      headers,
      body: canonicalBody,
      signal: controller.signal,
    });
    const text = await upstream.text();
    const outcomeStatus: GatewayProxyOutcome['status'] = upstream.ok ? 'ok' : 'error';
    finalize(proxyRequestId, {
      status: outcomeStatus,
      httpStatus: upstream.status,
      durationMs: deps.now() - startedAt,
      errorMsg: upstream.ok ? null : `backend ${upstream.status}`,
    });
    gatewaySigningProxyTotal.labels(upstream.ok ? 'signed' : 'backend_error').inc();
    return { httpStatus: upstream.status, body: text, outcome: upstream.ok ? 'signed' : 'backend_error' };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    finalize(proxyRequestId, {
      status: 'error',
      httpStatus: 502,
      durationMs: deps.now() - startedAt,
      errorMsg: aborted ? 'backend_timeout' : 'backend_unreachable',
    });
    gatewaySigningProxyTotal.labels('backend_error').inc();
    return jsonError(
      502,
      'BACKEND_UNAVAILABLE',
      aborted ? 'backend timed out' : 'backend unreachable',
      'backend_error',
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Per-token fixed-window rate limiter (in-memory).
// ---------------------------------------------------------------------------

interface RateState {
  windowStart: number;
  count: number;
}

export function makeRateLimiter(limit: number, windowMs: number): (jti: string, now: number) => boolean {
  const buckets = new Map<string, RateState>();
  return (jti: string, now: number): boolean => {
    const b = buckets.get(jti);
    if (!b || now - b.windowStart >= windowMs) {
      buckets.set(jti, { windowStart: now, count: 1 });
      // Opportunistic GC: drop windows that have fully elapsed for other jtis.
      if (buckets.size > 4096) {
        for (const [k, v] of buckets) if (now - v.windowStart >= windowMs) buckets.delete(k);
      }
      return true;
    }
    if (b.count >= limit) return false;
    b.count += 1;
    return true;
  };
}

// ---------------------------------------------------------------------------
// HTTP server wrapper.
// ---------------------------------------------------------------------------

let server: http.Server | null = null;

function normalizeIp(raw: string | undefined): string {
  if (!raw) return 'unknown';
  // Strip IPv4-mapped IPv6 prefix so the pin compares cleanly.
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<{ ok: true; body: string } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: { ok: true; body: string } | { ok: false }): void => {
      if (done) return;
      done = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish({ ok: false });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false }));
  });
}

/**
 * Start the signing proxy listener if enabled. Idempotent. Non-fatal: a bind
 * failure logs loudly but does not crash the host (channels / metrics stay up),
 * though every signing call from a proxy-mode container will then fail-closed —
 * which is the safe direction.
 */
export function startGatewaySigningProxy(): void {
  const cfg = gatewaySigningProxyConfig();
  if (!cfg.enabled) {
    log.debug('Gateway signing proxy disabled (AGENTDESK_GATEWAY_SIGNING_PROXY!=true)');
    return;
  }
  if (server) return;

  // One-shot startup reconciliation: any audit row still at 'intent' is orphaned
  // (the proxy is single-process, so no live request owns it) — finalize it so
  // the pending set stays bounded. Best-effort.
  try {
    const reconciled = reconcileOrphanedProxyAudit();
    if (reconciled > 0) log.warn('Reconciled orphaned signing-proxy audit intent rows', { count: reconciled });
  } catch (err) {
    log.warn('Failed to reconcile orphaned signing-proxy audit rows', { err });
  }

  // The source-IP pin (a defence-in-depth gate) only distinguishes containers
  // on a Linux bridge where each has a distinct address. On Docker Desktop /
  // any NAT path, all containers SNAT to one gateway IP, so the pin cannot tell
  // them apart — the per-session token + TTL + rate-limit remain the primary
  // gates. Surface this so operators don't over-trust the pin.
  if (os.platform() !== 'linux') {
    log.warn(
      'Signing proxy: source-IP pin is shared across containers on this platform (NAT bridge). Rely on docker-socket isolation + short TTL, not the IP pin.',
      { platform: os.platform() },
    );
  }

  const allowRate = makeRateLimiter(cfg.rateLimit, cfg.rateWindowMs);
  const deps: ProxyDeps = {
    verifyToken: verifyProxyToken,
    resolveGateway: resolveGatewayForGroup,
    recordIntent: recordGatewayProxyIntent,
    finalize: finalizeGatewayProxyAudit,
    fetchImpl: fetch,
    allowRate,
    now: () => Date.now(),
  };

  server = http.createServer((req, res) => {
    void (async () => {
      const sourceIp = normalizeIp(req.socket.remoteAddress ?? undefined);
      let pathname = '/';
      try {
        pathname = new URL(req.url ?? '/', 'http://internal').pathname;
      } catch {
        /* keep default */
      }
      const bodyRead = await readBody(req, cfg.maxBodyBytes);
      if (!bodyRead.ok) {
        gatewaySigningProxyTotal.labels('bad_request').inc();
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'BODY_TOO_LARGE', message: 'request body too large' } }));
        return;
      }
      const tokenHeader = req.headers[PROXY_TOKEN_HEADER];
      const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
      let result: ProxyRequestResult;
      try {
        result = await processSigningProxyRequest(
          { method: req.method ?? 'GET', pathname, token, sourceIp, rawBody: bodyRead.body },
          deps,
        );
      } catch (err) {
        log.error('Gateway signing proxy handler threw', { err });
        result = {
          httpStatus: 500,
          body: JSON.stringify({ error: { code: 'PROXY_ERROR', message: 'internal' } }),
          outcome: 'bad_request',
        };
      }
      res.writeHead(result.httpStatus, { 'content-type': 'application/json' });
      res.end(result.body);
    })();
  });

  server.on('error', (err) => {
    log.error('Gateway signing proxy listener error — proxy-mode containers will fail-closed', {
      err,
      port: cfg.port,
      bind: cfg.bind,
    });
  });

  server.listen(cfg.port, cfg.bind, () => {
    log.info('Gateway signing proxy listening (signingKey withheld from containers; ADR-0034)', {
      bind: cfg.bind,
      port: cfg.port,
      ttlMs: cfg.ttlMs,
    });
  });
}

/** Stop the signing proxy listener. Safe to call when not started. */
export function stopGatewaySigningProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const s = server;
    server = null;
    s.close(() => resolve());
  });
}
