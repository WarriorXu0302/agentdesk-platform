import { describe, expect, it } from 'vitest';

import { computeGatewaySignature } from './gateway-signing.js';
import {
  ALL_GATEWAY_PATHS,
  gatewaySigningProxyConfig,
  makeRateLimiter,
  processSigningProxyRequest,
  READ_PATHS,
  type ProxyDeps,
} from './gateway-signing-proxy.js';

interface Captured {
  deps: ProxyDeps;
  intents: Array<Record<string, unknown>>;
  finals: Array<{ id: string; o: Record<string, unknown> }>;
  fetches: Array<{ url: string; body: string; headers: Record<string, string> }>;
}

function makeDeps(over: Partial<ProxyDeps> = {}): Captured {
  const intents: Array<Record<string, unknown>> = [];
  const finals: Array<{ id: string; o: Record<string, unknown> }> = [];
  const fetches: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const deps: ProxyDeps = {
    verifyToken: (token, sourceIp) =>
      token === 'good'
        ? {
            ok: true,
            record: {
              jti: 'j1',
              sessionId: 's1',
              agentGroupId: 'ag1',
              allowedPaths: [...ALL_GATEWAY_PATHS],
              sourceIp,
              expiresAt: '2999-01-01T00:00:00.000Z',
            },
          }
        : { ok: false, reason: 'unknown' },
    resolveGateway: () => ({ baseUrl: 'https://erp.example', signingKey: 'secret-key' }),
    recordIntent: (i) => {
      intents.push(i as unknown as Record<string, unknown>);
    },
    finalize: (id, o) => {
      finals.push({ id, o: o as unknown as Record<string, unknown> });
    },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = String(v);
      }
      fetches.push({ url: String(url), body: String(init?.body), headers });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
    allowRate: () => true,
    now: () => 1_700_000_000_000,
    ...over,
  };
  return { deps, intents, finals, fetches };
}

const body = (group = 'ag1', requesterSource = 'session'): string =>
  JSON.stringify({
    agent: { agentGroupId: group },
    requesterSource,
    operation: 'op',
    requester: { userId: 'u1' },
    idempotencyKey: 'idem-1',
  });

describe('processSigningProxyRequest (ADR-0034 security core)', () => {
  it('signs the EXACT received bytes and forwards to the host-resolved backend', async () => {
    const cap = makeDeps();
    const raw = body();
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/execute', token: 'good', sourceIp: '172.17.0.2', rawBody: raw },
      cap.deps,
    );
    expect(r.httpStatus).toBe(200);
    expect(r.outcome).toBe('signed');
    expect(cap.fetches).toHaveLength(1);
    expect(cap.fetches[0].url).toBe('https://erp.example/execute');
    // byte-passthrough: the forwarded body is exactly what we received.
    expect(cap.fetches[0].body).toBe(raw);
    const h = cap.fetches[0].headers;
    const ts = h['x-agentdesk-timestamp'];
    const nonce = h['x-agentdesk-nonce'];
    expect(h['x-agentdesk-signature']).toBe(computeGatewaySignature('secret-key', ts, nonce, raw));
    // two-phase audit: intent then final ok.
    expect(cap.intents).toHaveLength(1);
    expect(cap.intents[0].signedAsGroup).toBe('ag1');
    expect(cap.intents[0].tokenJti).toBe('j1');
    expect(cap.finals).toHaveLength(1);
    expect(cap.finals[0].o.status).toBe('ok');
  });

  it('canonicalizes the signed+forwarded body, defeating a duplicate-key parser differential', async () => {
    const cap = makeDeps();
    // Two `agent` blocks: V8 last-wins => the proxy validates ag1 (passes the
    // identity check). A first-wins backend parsing the RAW bytes would see
    // ATTACKER — unless we re-serialize to a single canonical key, which we do.
    const raw = '{"agent":{"agentGroupId":"ATTACKER"},"agent":{"agentGroupId":"ag1"},"requesterSource":"session"}';
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/execute', token: 'good', sourceIp: 'x', rawBody: raw },
      cap.deps,
    );
    expect(r.httpStatus).toBe(200);
    const fwd = cap.fetches[0].body;
    // The forwarded body is canonical single-key — no duplicate agent survives.
    expect(fwd).not.toContain('ATTACKER');
    expect(JSON.parse(fwd).agent.agentGroupId).toBe('ag1');
    // The signature covers exactly the canonical bytes that were forwarded.
    const h = cap.fetches[0].headers;
    expect(h['x-agentdesk-signature']).toBe(
      computeGatewaySignature('secret-key', h['x-agentdesk-timestamp'], h['x-agentdesk-nonce'], fwd),
    );
  });

  it('refuses to sign when the body claims a different group (409, audited, never forwarded)', async () => {
    const cap = makeDeps();
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/execute', token: 'good', sourceIp: '1.1.1.1', rawBody: body('ATTACKER') },
      cap.deps,
    );
    expect(r.httpStatus).toBe(409);
    expect(r.outcome).toBe('identity_mismatch');
    expect(cap.fetches).toHaveLength(0);
    expect(cap.intents[0].identityMismatch).toBe(true);
    expect(cap.intents[0].signedAsGroup).toBeNull();
    expect(cap.finals[0].o.errorMsg).toBe('identity_mismatch');
  });

  it('treats a missing claimed group as a mismatch (fail-closed)', async () => {
    const cap = makeDeps();
    const raw = JSON.stringify({ requesterSource: 'session' });
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/describe', token: 'good', sourceIp: 'x', rawBody: raw },
      cap.deps,
    );
    expect(r.httpStatus).toBe(409);
    expect(cap.fetches).toHaveLength(0);
  });

  it('rejects a missing token (401)', async () => {
    const cap = makeDeps();
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/describe', token: undefined, sourceIp: 'x', rawBody: body() },
      cap.deps,
    );
    expect(r.httpStatus).toBe(401);
    expect(cap.fetches).toHaveLength(0);
    expect(cap.intents).toHaveLength(0); // unauthenticated probes don't write audit rows
  });

  it('rejects an unknown token (401)', async () => {
    const cap = makeDeps();
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/describe', token: 'bad', sourceIp: 'x', rawBody: body() },
      cap.deps,
    );
    expect(r.httpStatus).toBe(401);
  });

  it('maps source_ip_mismatch to 401 with its own outcome', async () => {
    const cap = makeDeps({ verifyToken: () => ({ ok: false, reason: 'source_ip_mismatch' }) });
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/describe', token: 'good', sourceIp: 'x', rawBody: body() },
      cap.deps,
    );
    expect(r.httpStatus).toBe(401);
    expect(r.outcome).toBe('source_ip_mismatch');
  });

  it('rejects an unknown path (403)', async () => {
    const cap = makeDeps();
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/evil', token: 'good', sourceIp: 'x', rawBody: body() },
      cap.deps,
    );
    expect(r.httpStatus).toBe(403);
    expect(cap.fetches).toHaveLength(0);
  });

  it('honors a read-only token: a write path is forbidden (403)', async () => {
    const cap = makeDeps({
      verifyToken: (_t, sourceIp) => ({
        ok: true,
        record: {
          jti: 'j',
          sessionId: 's',
          agentGroupId: 'ag1',
          allowedPaths: [...READ_PATHS],
          sourceIp,
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      }),
    });
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/execute', token: 'good', sourceIp: 'x', rawBody: body() },
      cap.deps,
    );
    expect(r.httpStatus).toBe(403);
    expect(cap.fetches).toHaveLength(0);
  });

  it('rate-limits per token (429, never forwarded)', async () => {
    const cap = makeDeps({ allowRate: () => false });
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/describe', token: 'good', sourceIp: 'x', rawBody: body() },
      cap.deps,
    );
    expect(r.httpStatus).toBe(429);
    expect(cap.fetches).toHaveLength(0);
  });

  it('fails closed (502) when the group has no host-side signing key', async () => {
    const cap = makeDeps({ resolveGateway: () => ({ baseUrl: 'https://erp.example' }) });
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/describe', token: 'good', sourceIp: 'x', rawBody: body() },
      cap.deps,
    );
    expect(r.httpStatus).toBe(502);
    expect(r.outcome).toBe('no_signing_key');
    expect(cap.fetches).toHaveLength(0);
    expect(cap.finals[0].o.errorMsg).toBe('no_signing_key');
  });

  it('rejects a non-JSON-object body (400)', async () => {
    const cap = makeDeps();
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/describe', token: 'good', sourceIp: 'x', rawBody: 'not json' },
      cap.deps,
    );
    expect(r.httpStatus).toBe(400);
  });

  it('rejects non-POST (405)', async () => {
    const cap = makeDeps();
    const r = await processSigningProxyRequest(
      { method: 'GET', pathname: '/describe', token: 'good', sourceIp: 'x', rawBody: '' },
      cap.deps,
    );
    expect(r.httpStatus).toBe(405);
  });

  it('coerces an invalid requesterSource and flags it in the audit (body still passes through)', async () => {
    const cap = makeDeps();
    const raw = JSON.stringify({ agent: { agentGroupId: 'ag1' }, requesterSource: 'forged-trusted' });
    await processSigningProxyRequest(
      { method: 'POST', pathname: '/describe', token: 'good', sourceIp: 'x', rawBody: raw },
      cap.deps,
    );
    expect(cap.intents[0].requesterSourceCoerced).toBe(true);
    expect(cap.intents[0].requesterSource).toBe('agent-asserted');
    // byte-passthrough — the forwarded body is unchanged, NOT rewritten.
    expect(cap.fetches[0].body).toBe(raw);
  });

  it('records backend_error and 502 when the upstream forward fails', async () => {
    const cap = makeDeps({
      fetchImpl: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof fetch,
    });
    const r = await processSigningProxyRequest(
      { method: 'POST', pathname: '/describe', token: 'good', sourceIp: 'x', rawBody: body() },
      cap.deps,
    );
    expect(r.httpStatus).toBe(502);
    expect(r.outcome).toBe('backend_error');
    // intent was still recorded before the forward; finalized as error.
    expect(cap.intents).toHaveLength(1);
    expect(cap.finals[0].o.status).toBe('error');
  });
});

describe('gatewaySigningProxyConfig', () => {
  it('defaults to disabled', () => {
    const prev = process.env.AGENTDESK_GATEWAY_SIGNING_PROXY;
    delete process.env.AGENTDESK_GATEWAY_SIGNING_PROXY;
    try {
      expect(gatewaySigningProxyConfig().enabled).toBe(false);
    } finally {
      if (prev !== undefined) process.env.AGENTDESK_GATEWAY_SIGNING_PROXY = prev;
    }
  });

  it('enables on the flag and reads a custom port', () => {
    const prevFlag = process.env.AGENTDESK_GATEWAY_SIGNING_PROXY;
    const prevPort = process.env.AGENTDESK_GATEWAY_SIGNING_PROXY_PORT;
    process.env.AGENTDESK_GATEWAY_SIGNING_PROXY = 'true';
    process.env.AGENTDESK_GATEWAY_SIGNING_PROXY_PORT = '9001';
    try {
      const cfg = gatewaySigningProxyConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.port).toBe(9001);
    } finally {
      if (prevFlag === undefined) delete process.env.AGENTDESK_GATEWAY_SIGNING_PROXY;
      else process.env.AGENTDESK_GATEWAY_SIGNING_PROXY = prevFlag;
      if (prevPort === undefined) delete process.env.AGENTDESK_GATEWAY_SIGNING_PROXY_PORT;
      else process.env.AGENTDESK_GATEWAY_SIGNING_PROXY_PORT = prevPort;
    }
  });
});

describe('makeRateLimiter', () => {
  it('allows up to limit per window then blocks, and resets the next window', () => {
    const rl = makeRateLimiter(2, 1000);
    expect(rl('j', 0)).toBe(true);
    expect(rl('j', 100)).toBe(true);
    expect(rl('j', 200)).toBe(false);
    expect(rl('j', 1001)).toBe(true); // new window
  });

  it('is per-jti', () => {
    const rl = makeRateLimiter(1, 1000);
    expect(rl('a', 0)).toBe(true);
    expect(rl('b', 0)).toBe(true);
    expect(rl('a', 0)).toBe(false);
  });
});
