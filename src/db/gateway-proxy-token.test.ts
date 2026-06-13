import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './index.js';
import {
  mintProxyToken,
  purgeStaleProxyTokens,
  revokeAllProxyTokens,
  revokeProxyTokensForSession,
  verifyProxyToken,
} from './gateway-proxy-token.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('gateway_proxy_token (ADR-0034)', () => {
  it('mints a token that verifies and carries the bound group + paths', () => {
    const { token, jti } = mintProxyToken({
      sessionId: 's1',
      agentGroupId: 'ag1',
      allowedPaths: ['/describe', '/execute'],
      ttlMs: 60_000,
    });
    const v = verifyProxyToken(token, '172.17.0.2');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.record.agentGroupId).toBe('ag1');
      expect(v.record.sessionId).toBe('s1');
      expect(v.record.allowedPaths).toEqual(['/describe', '/execute']);
      expect(v.record.jti).toBe(jti);
    }
  });

  it('never persists the raw token (only its hash)', () => {
    const { token } = mintProxyToken({ sessionId: 's1', agentGroupId: 'ag1', allowedPaths: [], ttlMs: 60_000 });
    // A forged token sharing the jti prefix but a different secret must NOT verify.
    const jtiPrefix = token.split('.')[0];
    const forged = `${jtiPrefix}.totally-different-secret`;
    expect(verifyProxyToken(forged, '1.2.3.4')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects an unknown token', () => {
    expect(verifyProxyToken('nope.nope', '1.2.3.4')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects an expired token', () => {
    const past = new Date(Date.now() - 10_000);
    const { token } = mintProxyToken({ sessionId: 's1', agentGroupId: 'ag1', allowedPaths: [], ttlMs: 1, now: past });
    expect(verifyProxyToken(token, '1.2.3.4')).toEqual({ ok: false, reason: 'expired' });
  });

  it('pins source IP trust-on-first-use and rejects a different IP afterwards', () => {
    const { token } = mintProxyToken({ sessionId: 's1', agentGroupId: 'ag1', allowedPaths: [], ttlMs: 60_000 });
    expect(verifyProxyToken(token, '172.17.0.2').ok).toBe(true); // pins .2
    expect(verifyProxyToken(token, '172.17.0.9')).toEqual({ ok: false, reason: 'source_ip_mismatch' });
    expect(verifyProxyToken(token, '172.17.0.2').ok).toBe(true); // same IP still ok
  });

  it('keeps one live token per session: re-mint revokes the prior token', () => {
    const a = mintProxyToken({ sessionId: 's1', agentGroupId: 'ag1', allowedPaths: [], ttlMs: 60_000 });
    const b = mintProxyToken({ sessionId: 's1', agentGroupId: 'ag1', allowedPaths: [], ttlMs: 60_000 });
    expect(verifyProxyToken(a.token, '1.2.3.4')).toEqual({ ok: false, reason: 'revoked' });
    expect(verifyProxyToken(b.token, '1.2.3.4').ok).toBe(true);
  });

  it('revokes all live tokens for a session', () => {
    const { token } = mintProxyToken({ sessionId: 's1', agentGroupId: 'ag1', allowedPaths: [], ttlMs: 60_000 });
    expect(revokeProxyTokensForSession('s1')).toBe(1);
    expect(verifyProxyToken(token, '1.2.3.4')).toEqual({ ok: false, reason: 'revoked' });
    // idempotent — nothing live left
    expect(revokeProxyTokensForSession('s1')).toBe(0);
  });

  it('revokeAllProxyTokens revokes every live token across sessions (boot cleanup)', () => {
    const a = mintProxyToken({ sessionId: 's1', agentGroupId: 'ag1', allowedPaths: [], ttlMs: 60_000 });
    const b = mintProxyToken({ sessionId: 's2', agentGroupId: 'ag2', allowedPaths: [], ttlMs: 60_000 });
    expect(revokeAllProxyTokens()).toBe(2);
    expect(verifyProxyToken(a.token, '1.2.3.4')).toEqual({ ok: false, reason: 'revoked' });
    expect(verifyProxyToken(b.token, '1.2.3.4')).toEqual({ ok: false, reason: 'revoked' });
    // idempotent — nothing live left
    expect(revokeAllProxyTokens()).toBe(0);
  });

  it('purges stale (long-expired) token rows', () => {
    const past = new Date(Date.now() - 10 * 60_000);
    mintProxyToken({ sessionId: 's1', agentGroupId: 'ag1', allowedPaths: [], ttlMs: 1000, now: past });
    expect(purgeStaleProxyTokens(60_000)).toBe(1);
  });
});
