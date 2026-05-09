import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { EnterpriseGatewayConfig } from '../config.js';
import {
  handleErpAuthorize,
  handleErpDescribe,
  handleErpExecute,
  handleErpMemoryGet,
  handleErpMemoryUpsert,
} from './erp-gateway.js';

const runtime = {
  assistantName: 'Frontdesk',
  groupName: 'FrontLane Desk',
  agentGroupId: 'ag-frontdesk',
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function configuredRuntime(enterpriseGateway?: EnterpriseGatewayConfig) {
  return { ...runtime, enterpriseGateway };
}

describe('erp gateway mcp tools', () => {
  it('returns a clear error when the gateway is not configured', async () => {
    const result = await handleErpDescribe(configuredRuntime(), {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ERP gateway is not configured');
  });

  it('calls /describe with agent and requester context', async () => {
    let request: RequestInit | undefined;
    let url = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      request = init;
      return new Response(JSON.stringify({ operations: ['sales.order.create'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await handleErpDescribe(
      configuredRuntime({ baseUrl: 'https://erp-gateway.example', timeoutMs: 1000 }),
      { userId: 'feishu:ou_123', channelType: 'feishu', platformId: 'oc_1', threadId: null },
    );

    expect(result.isError).toBeUndefined();
    expect(url).toBe('https://erp-gateway.example/describe');
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual({
      agent: {
        agentGroupId: 'ag-frontdesk',
        groupName: 'FrontLane Desk',
        assistantName: 'Frontdesk',
      },
      requester: {
        userId: 'feishu:ou_123',
        channelType: 'feishu',
        platformId: 'oc_1',
        threadId: null,
      },
    });
  });

  it('sends operation payload to /authorize', async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ allowed: true, obligations: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await handleErpAuthorize(configuredRuntime({ baseUrl: 'https://erp-gateway.example' }), {
      operation: 'finance.invoice.approve',
      userId: 'feishu:ou_123',
      input: { invoiceId: 'INV-001' },
      context: { source: 'chat' },
    });

    expect(result.isError).toBeUndefined();
    expect(body).toEqual({
      agent: {
        agentGroupId: 'ag-frontdesk',
        groupName: 'FrontLane Desk',
        assistantName: 'Frontdesk',
      },
      requester: {
        userId: 'feishu:ou_123',
      },
      operation: 'finance.invoice.approve',
      input: { invoiceId: 'INV-001' },
      context: { source: 'chat' },
    });
  });

  it('sends dry-run execution payload to /execute', async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, preview: { status: 'ready' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await handleErpExecute(
      configuredRuntime({ baseUrl: 'https://erp-gateway.example', defaultHeaders: { 'x-tenant': 'erp-a' } }),
      {
        operation: 'sales.order.create',
        userId: 'feishu:ou_123',
        input: { customerId: 'C-1' },
        dryRun: true,
        idempotencyKey: 'idem-123',
      },
    );

    expect(result.isError).toBeUndefined();
    expect(body).toEqual({
      agent: {
        agentGroupId: 'ag-frontdesk',
        groupName: 'FrontLane Desk',
        assistantName: 'Frontdesk',
      },
      requester: {
        userId: 'feishu:ou_123',
      },
      operation: 'sales.order.create',
      input: { customerId: 'C-1' },
      context: {},
      dryRun: true,
      idempotencyKey: 'idem-123',
    });
  });

  it('loads durable memory from /memory/get using requester userId by default', async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, value: { locale: 'zh-CN' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await handleErpMemoryGet(configuredRuntime({ baseUrl: 'https://erp-gateway.example' }), {
      namespace: 'user.preferences',
      userId: 'feishu:ou_123',
    });

    expect(result.isError).toBeUndefined();
    expect(body).toEqual({
      agent: {
        agentGroupId: 'ag-frontdesk',
        groupName: 'FrontLane Desk',
        assistantName: 'Frontdesk',
      },
      requester: {
        userId: 'feishu:ou_123',
      },
      namespace: 'user.preferences',
      subject: {
        type: 'user',
        id: 'feishu:ou_123',
      },
      query: {},
      context: {},
    });
  });

  it('writes durable memory to /memory/upsert', async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, stored: { preferredLanguage: 'zh-CN' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await handleErpMemoryUpsert(configuredRuntime({ baseUrl: 'https://erp-gateway.example' }), {
      namespace: 'user.profile',
      userId: 'feishu:ou_123',
      value: { preferredLanguage: 'zh-CN' },
      merge: true,
    });

    expect(result.isError).toBeUndefined();
    expect(body).toEqual({
      agent: {
        agentGroupId: 'ag-frontdesk',
        groupName: 'FrontLane Desk',
        assistantName: 'Frontdesk',
      },
      requester: {
        userId: 'feishu:ou_123',
      },
      namespace: 'user.profile',
      subject: {
        type: 'user',
        id: 'feishu:ou_123',
      },
      value: { preferredLanguage: 'zh-CN' },
      merge: true,
      context: {},
    });
  });
});
