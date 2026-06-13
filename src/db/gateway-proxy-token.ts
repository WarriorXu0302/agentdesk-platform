/**
 * Per-session signing-proxy token store (ADR-0034).
 *
 * The host mints one token per container spawn. The container receives only the
 * opaque token (in env) — never the backend signing key. When the container
 * calls the host signing proxy, the proxy looks the token up here, and the
 * token's stored `agent_group_id` (bound at mint time to the central-DB
 * session→group mapping) is the AUTHORITATIVE group the proxy signs as. A
 * container that forges a different `agent.agentGroupId` in its request body is
 * caught by the proxy's identity cross-check, not by anything stored here.
 *
 * Security properties:
 *   - Unforgeable: the token is 256 bits of CSPRNG entropy; lookup is by
 *     sha256(token), and the raw token is never persisted (only its hash).
 *   - Revocable: the host tombstones a session's tokens on container exit, so a
 *     leaked token dies with the container even before its TTL.
 *   - One live token per session: minting revokes any prior live token for the
 *     same session, so a re-spawn never leaves an accumulating valid set.
 *   - Source-IP pinned (trust-on-first-use): the first successful use records
 *     the caller's source IP; later uses must match. Defence-in-depth against a
 *     token replayed from a different container (which already requires
 *     docker-socket-level access to obtain — a documented residual risk).
 *
 * All reads/writes happen on the host event loop (the proxy listener runs in
 * the host process), so they serialize with every other central-DB write — no
 * cross-process contention, consistent with the single-writer invariant.
 */
import crypto from 'node:crypto';

import { getDb } from './connection.js';

export interface MintProxyTokenArgs {
  sessionId: string;
  agentGroupId: string;
  /** Gateway paths this token may use (read/write split lives here). */
  allowedPaths: string[];
  /** Lifetime in ms; a backstop for a leaked token if revoke-on-exit is missed. */
  ttlMs: number;
  now?: Date;
}

export interface MintedProxyToken {
  jti: string;
  /** The raw secret handed to the container. Never stored; only its hash is. */
  token: string;
  expiresAt: string;
}

export interface ProxyTokenRecord {
  jti: string;
  sessionId: string;
  agentGroupId: string;
  allowedPaths: string[];
  sourceIp: string | null;
  expiresAt: string;
}

export type VerifyProxyTokenResult =
  | { ok: true; record: ProxyTokenRecord }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'source_ip_mismatch' };

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

interface TokenRow {
  jti: string;
  session_id: string;
  agent_group_id: string;
  allowed_paths: string;
  source_ip: string | null;
  expires_at: string;
  revoked_at: string | null;
}

/**
 * Mint a per-session signing-proxy token. Revokes any prior live token for the
 * same session first (one live token per session). Returns the raw token; the
 * caller injects it into the container env. The raw token is not persisted.
 */
export function mintProxyToken(args: MintProxyTokenArgs): MintedProxyToken {
  const now = args.now ?? new Date();
  const jti = crypto.randomBytes(16).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  // jti is a routing/logging prefix only — verification is by full-token hash.
  const token = `${jti}.${secret}`;
  const expiresAt = new Date(now.getTime() + args.ttlMs).toISOString();
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE gateway_proxy_token SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL`).run(
      now.toISOString(),
      args.sessionId,
    );
    db.prepare(
      `INSERT INTO gateway_proxy_token
         (jti, token_sha256, session_id, agent_group_id, allowed_paths, source_ip, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    ).run(
      jti,
      sha256(token),
      args.sessionId,
      args.agentGroupId,
      JSON.stringify(args.allowedPaths),
      now.toISOString(),
      expiresAt,
    );
  });
  tx();
  return { jti, token, expiresAt };
}

/**
 * Verify a raw token presented to the proxy. Checks existence, revocation,
 * expiry, then enforces the trust-on-first-use source-IP pin. On the first
 * successful use the caller's `sourceIp` is recorded; subsequent uses must
 * match it.
 */
export function verifyProxyToken(rawToken: string, sourceIp: string, now: Date = new Date()): VerifyProxyTokenResult {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT jti, session_id, agent_group_id, allowed_paths, source_ip, expires_at, revoked_at
         FROM gateway_proxy_token WHERE token_sha256 = ?`,
    )
    .get(sha256(rawToken)) as TokenRow | undefined;
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: 'expired' };

  let pinnedIp = row.source_ip;
  if (pinnedIp == null) {
    // First use: pin. The guard `source_ip IS NULL` makes concurrent first
    // requests from the same container idempotent (same IP either way).
    db.prepare(`UPDATE gateway_proxy_token SET source_ip = ? WHERE jti = ? AND source_ip IS NULL`).run(
      sourceIp,
      row.jti,
    );
    pinnedIp = sourceIp;
  } else if (pinnedIp !== sourceIp) {
    return { ok: false, reason: 'source_ip_mismatch' };
  }

  let allowedPaths: string[] = [];
  try {
    const parsed = JSON.parse(row.allowed_paths);
    if (Array.isArray(parsed)) allowedPaths = parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    allowedPaths = [];
  }

  return {
    ok: true,
    record: {
      jti: row.jti,
      sessionId: row.session_id,
      agentGroupId: row.agent_group_id,
      allowedPaths,
      sourceIp: pinnedIp,
      expiresAt: row.expires_at,
    },
  };
}

/**
 * Revoke (tombstone) every live token for a session. Called when the session's
 * container exits or is killed — a leaked token cannot outlive its container.
 * Returns the number of tokens revoked.
 */
export function revokeProxyTokensForSession(sessionId: string, now: Date = new Date()): number {
  return getDb()
    .prepare(`UPDATE gateway_proxy_token SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL`)
    .run(now.toISOString(), sessionId).changes;
}

/**
 * Revoke EVERY live token. Called once at host startup: by then any prior
 * containers have been reaped (cleanupOrphans), so no container can legitimately
 * still hold a token — a token surviving a host restart with revoked_at=NULL is
 * orphaned and must not outlive its (now-dead) container up to its TTL. Returns
 * the number revoked.
 */
export function revokeAllProxyTokens(now: Date = new Date()): number {
  return getDb()
    .prepare(`UPDATE gateway_proxy_token SET revoked_at = ? WHERE revoked_at IS NULL`)
    .run(now.toISOString()).changes;
}

/**
 * Housekeeping: delete token rows whose expiry is older than `olderThanMs` ago.
 * Keeps the table bounded; safe to skip (lookups already reject expired tokens).
 */
export function purgeStaleProxyTokens(olderThanMs: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  return getDb().prepare(`DELETE FROM gateway_proxy_token WHERE expires_at < ?`).run(cutoff).changes;
}
