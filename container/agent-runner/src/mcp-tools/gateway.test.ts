import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { BackendGatewayConfig } from '../config.js';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import {
  clearRequestIdentity,
  setRequestIdentity,
  type RequestIdentity,
} from '../request-context.js';
import {
  computeGatewaySignature,
  handleGatewayAuthorize,
  handleGatewayDescribe,
  handleGatewayExecute,
  handleGatewayMemoryGet,
  handleGatewayMemoryUpsert,
} from './gateway.js';

const runtime = {
  assistantName: 'Frontdesk',
  groupName: 'AgentDesk Frontdesk',
  agentGroupId: 'ag-frontdesk',
};

const originalFetch = globalThis.fetch;

function sessionIdentity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    userId: 'feishu:ou_123',
    channelType: 'feishu',
    platformId: 'feishu:p2p:ou_123',
    threadId: null,
    source: 'session',
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
  initTestSessionDb();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearRequestIdentity();
  closeSessionDb();
});

function configuredRuntime(backendGateway?: BackendGatewayConfig) {
  return { ...runtime, backendGateway };
}

describe('erp gateway mcp tools', () => {
  it('returns a clear error when the gateway is not configured', async () => {
    const result = await handleGatewayDescribe(configuredRuntime(), {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ERP gateway is not configured');
  });

  it('uses the poll-loop-published identity and ignores agent-asserted values', async () => {
    setRequestIdentity(sessionIdentity());

    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ operations: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await handleGatewayDescribe(configuredRuntime({ baseUrl: 'https://erp-gateway.example' }), {
      userId: 'feishu:ou_attacker',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: 't-99',
    });

    expect(result.isError).toBeUndefined();
    expect(body).toEqual({
      agent: {
        agentGroupId: 'ag-frontdesk',
        groupName: 'AgentDesk Frontdesk',
        assistantName: 'Frontdesk',
      },
      requester: {
        userId: 'feishu:ou_123',
        channelType: 'feishu',
        platformId: 'feishu:p2p:ou_123',
        threadId: null,
      },
      requesterSource: 'session',
    });
  });

  it('propagates origin_user_id from an a2a-delegated worker session', async () => {
    // Worker session identity was resolved by poll-loop from the a2a
    // inbound row's origin_user_id (host-written, container can't forge).
    setRequestIdentity(
      sessionIdentity({
        userId: 'feishu:ou_employee',
        channelType: 'agent',
        platformId: 'ag-frontdesk',
      }),
    );

    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ allowed: true }), { status: 200 });
    }) as typeof fetch;

    const result = await handleGatewayAuthorize(
      { ...runtime, agentGroupId: 'ag-worker', backendGateway: { baseUrl: 'https://erp-gateway.example' } },
      { operation: 'finance.invoice.approve' },
    );

    expect(result.isError).toBeUndefined();
    expect(body?.requesterSource).toBe('session');
    expect((body?.requester as Record<string, unknown>)?.userId).toBe('feishu:ou_employee');
    expect((body?.requester as Record<string, unknown>)?.platformId).toBe('ag-frontdesk');
  });

  it('falls back to agent-asserted identity when no poll-loop identity is published', async () => {
    // clearRequestIdentity is already the default at test start.
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const result = await handleGatewayDescribe(
      configuredRuntime({ baseUrl: 'https://erp-gateway.example' }),
      { userId: 'feishu:ou_123', channelType: 'feishu' },
    );

    expect(result.isError).toBeUndefined();
    expect(body?.requesterSource).toBe('agent-asserted');
    expect((body?.requester as Record<string, unknown>)?.userId).toBe('feishu:ou_123');
  });

  it('tags the request agent-asserted when identity is published without a userId', async () => {
    // Scheduled task scenario: poll loop publishes identity but can't
    // resolve a user (no senderId, no origin_user_id). Source must not be
    // upgraded to 'session'.
    setRequestIdentity({
      userId: null,
      channelType: null,
      platformId: null,
      threadId: null,
      source: 'agent-asserted',
    });

    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await handleGatewayDescribe(
      configuredRuntime({ baseUrl: 'https://erp-gateway.example' }),
      { userId: 'feishu:ou_agent_claim' },
    );
    expect(body?.requesterSource).toBe('agent-asserted');
  });

  it('sends operation payload to /authorize with trusted identity', async () => {
    setRequestIdentity(sessionIdentity());

    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ allowed: true, obligations: [] }), { status: 200 });
    }) as typeof fetch;

    const result = await handleGatewayAuthorize(configuredRuntime({ baseUrl: 'https://erp-gateway.example' }), {
      operation: 'finance.invoice.approve',
      input: { invoiceId: 'INV-001' },
      context: { source: 'chat' },
    });

    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({
      requester: {
        userId: 'feishu:ou_123',
        channelType: 'feishu',
        platformId: 'feishu:p2p:ou_123',
        threadId: null,
      },
      requesterSource: 'session',
      operation: 'finance.invoice.approve',
      input: { invoiceId: 'INV-001' },
      context: { source: 'chat' },
    });
  });

  it('sends dry-run execution payload to /execute', async () => {
    setRequestIdentity(sessionIdentity());

    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await handleGatewayExecute(
      configuredRuntime({ baseUrl: 'https://erp-gateway.example', defaultHeaders: { 'x-tenant': 'erp-a' } }),
      {
        operation: 'sales.order.create',
        input: { customerId: 'C-1' },
        dryRun: true,
        idempotencyKey: 'idem-123',
      },
    );

    expect(body).toMatchObject({
      operation: 'sales.order.create',
      input: { customerId: 'C-1' },
      context: {},
      dryRun: true,
      idempotencyKey: 'idem-123',
      requesterSource: 'session',
    });
  });

  it('loads durable memory from /memory/get using the trusted userId as default subject', async () => {
    setRequestIdentity(sessionIdentity());

    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await handleGatewayMemoryGet(configuredRuntime({ baseUrl: 'https://erp-gateway.example' }), {
      namespace: 'user.preferences',
    });

    expect(body).toMatchObject({
      namespace: 'user.preferences',
      subject: { type: 'user', id: 'feishu:ou_123' },
      query: {},
      context: {},
      requesterSource: 'session',
    });
  });

  it('writes durable memory to /memory/upsert', async () => {
    setRequestIdentity(sessionIdentity());

    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await handleGatewayMemoryUpsert(configuredRuntime({ baseUrl: 'https://erp-gateway.example' }), {
      namespace: 'user.profile',
      value: { preferredLanguage: 'zh-CN' },
      merge: true,
    });

    expect(body).toMatchObject({
      namespace: 'user.profile',
      subject: { type: 'user', id: 'feishu:ou_123' },
      value: { preferredLanguage: 'zh-CN' },
      merge: true,
      context: {},
      requesterSource: 'session',
    });
  });

  it('signs outbound requests with HMAC-SHA256 when signingKey is configured', async () => {
    setRequestIdentity(sessionIdentity());

    const capturedHeaders: Record<string, string> = {};
    let capturedBody = '';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = String(init?.body);
      const rawHeaders = init?.headers ?? {};
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((value, key) => {
          capturedHeaders[key.toLowerCase()] = value;
        });
      } else {
        for (const [key, value] of Object.entries(rawHeaders as Record<string, string>)) {
          capturedHeaders[String(key).toLowerCase()] = String(value);
        }
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await handleGatewayDescribe(
      configuredRuntime({ baseUrl: 'https://erp-gateway.example', signingKey: 'secret-key' }),
      {},
    );

    const timestamp = capturedHeaders['x-agentdesk-timestamp'];
    const nonce = capturedHeaders['x-agentdesk-nonce'];
    const signature = capturedHeaders['x-agentdesk-signature'];
    expect(timestamp).toMatch(/^\d+$/);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);

    const expected = crypto
      .createHmac('sha256', 'secret-key')
      .update(`${timestamp}.${nonce}.${capturedBody}`)
      .digest('hex');
    expect(signature).toBe(expected);
    expect(computeGatewaySignature('secret-key', timestamp!, nonce!, capturedBody)).toBe(expected);
  });

  it('skips signing headers when no signingKey is configured', async () => {
    setRequestIdentity(sessionIdentity());

    const capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const rawHeaders = init?.headers ?? {};
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((value, key) => {
          capturedHeaders[key.toLowerCase()] = value;
        });
      } else {
        for (const [key, value] of Object.entries(rawHeaders as Record<string, string>)) {
          capturedHeaders[String(key).toLowerCase()] = String(value);
        }
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await handleGatewayDescribe(configuredRuntime({ baseUrl: 'https://erp-gateway.example' }), {});
    expect(capturedHeaders['x-agentdesk-signature']).toBeUndefined();
  });

  it('emits an gateway_audit system message with a path-scoped input_hash', async () => {
    setRequestIdentity(sessionIdentity());
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

    // Run two memory calls with DIFFERENT payloads on the same namespace.
    // Under the old single-field hasher they'd collapse to the same hash.
    await handleGatewayMemoryGet(configuredRuntime({ baseUrl: 'https://erp-gateway.example' }), {
      namespace: 'user.profile',
      query: { include: 'prefs' },
    });
    await handleGatewayMemoryGet(configuredRuntime({ baseUrl: 'https://erp-gateway.example' }), {
      namespace: 'user.profile',
      query: { include: 'escalations' },
    });
    // And an /execute call to make sure cross-path collisions don't happen
    // either.
    await handleGatewayExecute(configuredRuntime({ baseUrl: 'https://erp-gateway.example' }), {
      operation: 'sales.order.create',
      input: { customerId: 'C-1' },
    });

    const rows = getOutboundDb()
      .prepare("SELECT content FROM messages_out WHERE kind = 'system' ORDER BY seq ASC")
      .all() as Array<{ content: string }>;
    const auditPayloads = rows
      .map((r) => {
        try {
          return JSON.parse(r.content) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((p): p is Record<string, unknown> => !!p && p.action === 'gateway_audit');

    expect(auditPayloads.length).toBe(3);
    const hashes = auditPayloads.map((p) => p.inputHash as string);
    // All three hashes must differ — memory queries with different `query`
    // payloads must not collide, and /execute must not collide with the
    // memory calls either.
    expect(new Set(hashes).size).toBe(3);
    expect(auditPayloads[0]!.path).toBe('/memory/get');
    expect(auditPayloads[2]!.path).toBe('/execute');
  });

  it('honors signingHeaders overrides', async () => {
    setRequestIdentity(sessionIdentity());

    const capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const rawHeaders = init?.headers ?? {};
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((value, key) => {
          capturedHeaders[key.toLowerCase()] = value;
        });
      } else {
        for (const [key, value] of Object.entries(rawHeaders as Record<string, string>)) {
          capturedHeaders[String(key).toLowerCase()] = String(value);
        }
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await handleGatewayDescribe(
      configuredRuntime({
        baseUrl: 'https://erp-gateway.example',
        signingKey: 'secret-key',
        signingHeaders: {
          timestamp: 'X-Custom-Ts',
          nonce: 'X-Custom-Nonce',
          signature: 'X-Custom-Sig',
        },
      }),
      {},
    );

    expect(capturedHeaders['x-custom-sig']).toMatch(/^[0-9a-f]{64}$/);
    expect(capturedHeaders['x-agentdesk-signature']).toBeUndefined();
  });
});
