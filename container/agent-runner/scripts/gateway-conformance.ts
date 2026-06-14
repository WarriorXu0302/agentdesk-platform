/**
 * Backend gateway conformance runner.
 *
 * For operators bringing up (or upgrading) a backend that sits behind the
 * AgentDesk gateway contract. It POSTs a contract-compliant sample request to
 * each endpoint and validates each response against the SAME zod schemas the
 * runtime uses (src/mcp-tools/gateway-contract.ts is the single source of
 * truth — this script never re-defines the shapes).
 *
 * Note: `/memory/search` (ADR-0033), `/bulk_execute` (ADR-0036), and
 * `/task/status` (ADR-0037) are optional for a backend. A backend that hasn't
 * implemented one yet returns 404 and this runner reports that endpoint as FAIL
 * — that is the intended signal ("not implemented"), not a contract violation
 * of the other endpoints.
 *
 * Usage:
 *   cd container/agent-runner && bun scripts/gateway-conformance.ts <baseUrl>
 *
 * Environment (all optional):
 *   GATEWAY_SIGNING_KEY        HMAC-SHA256 key. When set, each request is
 *                              signed exactly as the runtime signs it
 *                              (<timestamp>.<nonce>.<body>) using the default
 *                              brand-namespaced headers.
 *   GATEWAY_HEADERS            Extra headers as JSON, e.g.
 *                              '{"x-tenant":"tenant-a"}'.
 *   GATEWAY_STRICT_RESPONSES   When 'true', a response-schema mismatch fails
 *                              the endpoint (exit non-zero). Otherwise a
 *                              mismatch is reported as a warning and the
 *                              endpoint still passes (matches runtime default).
 *   GATEWAY_TEST_USER_ID       Sample requester userId (default a placeholder).
 *
 * Exit code: 0 = every endpoint conformant; non-zero = at least one failure
 * (or, under strict mode, at least one schema mismatch).
 *
 * This is a self-test tool. It sends sample/dummy payloads and uses
 * requesterSource='agent-asserted' so a well-behaved backend will treat them
 * as untrusted reads — do NOT point it at a production backend that would
 * commit real writes on /execute. The /execute sample sets dryRun=true.
 */
import crypto from 'node:crypto';

import { SIGNING_NONCE_HEADER, SIGNING_SIGNATURE_HEADER, SIGNING_TIMESTAMP_HEADER } from '../src/branding.js';
import {
  CONTRACT_VERSION,
  RESPONSE_SCHEMAS,
  type GatewayPath,
} from '../src/mcp-tools/gateway-contract.js';

interface EndpointResult {
  path: GatewayPath;
  pass: boolean;
  httpStatus?: number;
  detail?: string;
  warning?: string;
}

function sanitizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function sampleRequester(): Record<string, unknown> {
  return {
    userId: process.env.GATEWAY_TEST_USER_ID || 'conformance:test-user',
    channelType: 'cli',
    platformId: 'conformance',
    threadId: null,
  };
}

function agentBlock(): Record<string, unknown> {
  return {
    agentGroupId: 'conformance-agent-group',
    groupName: 'Conformance Runner',
    assistantName: 'Conformance Runner',
  };
}

/** Build a contract-compliant sample body per path, including contractVersion. */
function sampleBody(path: GatewayPath): Record<string, unknown> {
  const base = {
    contractVersion: CONTRACT_VERSION,
    agent: agentBlock(),
    requester: sampleRequester(),
    requesterSource: 'agent-asserted' as const,
  };
  switch (path) {
    case '/describe':
      return { ...base };
    case '/authorize':
      return { ...base, operation: 'conformance.noop', input: {}, context: {} };
    case '/execute':
      return {
        ...base,
        operation: 'conformance.noop',
        input: {},
        context: {},
        dryRun: true,
        idempotencyKey: crypto.randomUUID(),
      };
    case '/bulk_execute':
      // Optional endpoint (ADR-0036). dryRun so the probe commits nothing; a
      // backend that hasn't implemented it returns 404 (the "not implemented"
      // signal, same as /memory/search).
      return {
        ...base,
        operations: [{ operation: 'conformance.noop', input: {}, idempotencyKey: null }],
        context: {},
        dryRun: true,
      };
    case '/task/status':
      // Optional endpoint (ADR-0037). Probes with a synthetic taskId — a backend
      // that implements async reports it as an unknown/failed task (200, schema
      // valid); one without async returns 404 (the "not implemented" signal).
      return { ...base, taskId: 'conformance-probe-task', context: {} };
    case '/memory/get':
      return {
        ...base,
        namespace: 'conformance.probe',
        subject: { type: 'user', id: process.env.GATEWAY_TEST_USER_ID || 'conformance:test-user' },
        query: {},
        context: {},
      };
    case '/memory/upsert':
      return {
        ...base,
        namespace: 'conformance.probe',
        subject: { type: 'user', id: process.env.GATEWAY_TEST_USER_ID || 'conformance:test-user' },
        value: { conformance: true },
        merge: true,
        context: {},
      };
    case '/memory/search':
      return {
        ...base,
        namespace: 'conformance.probe',
        query: 'conformance probe',
        subject: { type: 'user', id: process.env.GATEWAY_TEST_USER_ID || 'conformance:test-user' },
        limit: 10,
        context: {},
      };
    case '/memory/feedback':
      // Optional endpoint (ADR-0043). Probes with a synthetic recordId — a
      // backend that implements feedback acks it (200); one without returns 404
      // (the "not implemented" signal, same as /memory/search).
      return {
        ...base,
        namespace: 'conformance.probe',
        subject: { type: 'user', id: process.env.GATEWAY_TEST_USER_ID || 'conformance:test-user' },
        recordId: 'conformance-probe-record',
        issue: 'other',
        context: {},
      };
  }
}

function buildHeaders(bodyString: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
  };
  const extra = process.env.GATEWAY_HEADERS;
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') headers[k] = v;
      }
    } catch {
      console.error('warn: GATEWAY_HEADERS is not valid JSON; ignoring.');
    }
  }
  const key = process.env.GATEWAY_SIGNING_KEY?.trim();
  if (key) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const signature = crypto.createHmac('sha256', key).update(`${timestamp}.${nonce}.${bodyString}`).digest('hex');
    headers[SIGNING_TIMESTAMP_HEADER] = timestamp;
    headers[SIGNING_NONCE_HEADER] = nonce;
    headers[SIGNING_SIGNATURE_HEADER] = signature;
  }
  return headers;
}

async function probe(baseUrl: string, path: GatewayPath, strict: boolean): Promise<EndpointResult> {
  const body = sampleBody(path);
  const bodyString = JSON.stringify(body);
  let response: Response;
  try {
    response = await fetch(`${sanitizeBaseUrl(baseUrl)}${path}`, {
      method: 'POST',
      headers: buildHeaders(bodyString),
      body: bodyString,
    });
  } catch (error) {
    return { path, pass: false, detail: `request failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const text = await response.text();
  if (!response.ok) {
    return {
      path,
      pass: false,
      httpStatus: response.status,
      detail: `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    return { path, pass: false, httpStatus: response.status, detail: 'response body is not valid JSON' };
  }

  const result = RESPONSE_SCHEMAS[path].safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    if (strict) {
      return { path, pass: false, httpStatus: response.status, detail: `response schema mismatch: ${detail}` };
    }
    return {
      path,
      pass: true,
      httpStatus: response.status,
      warning: `response schema mismatch (allowed; set GATEWAY_STRICT_RESPONSES=true to fail): ${detail}`,
    };
  }

  const echoed = result.data.contractVersion;
  if (typeof echoed === 'number' && echoed !== CONTRACT_VERSION) {
    return {
      path,
      pass: true,
      httpStatus: response.status,
      warning: `backend echoed contractVersion ${echoed}, expected ${CONTRACT_VERSION}`,
    };
  }

  return { path, pass: true, httpStatus: response.status };
}

async function main(): Promise<void> {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error('usage: bun scripts/gateway-conformance.ts <baseUrl>');
    process.exit(2);
  }
  const strict = process.env.GATEWAY_STRICT_RESPONSES === 'true';
  const paths = Object.keys(RESPONSE_SCHEMAS) as GatewayPath[];

  console.error(`Gateway conformance check against ${baseUrl} (contractVersion=${CONTRACT_VERSION}, strict=${strict})`);
  console.error('');

  const results: EndpointResult[] = [];
  for (const path of paths) {
    results.push(await probe(baseUrl, path, strict));
  }

  let failures = 0;
  for (const r of results) {
    if (r.pass) {
      const tag = r.warning ? 'PASS (warn)' : 'PASS';
      console.error(`  ${tag.padEnd(11)} ${path(r)} [${r.httpStatus ?? '-'}]`);
      if (r.warning) console.error(`              warn: ${r.warning}`);
    } else {
      failures += 1;
      console.error(`  FAIL        ${path(r)} [${r.httpStatus ?? '-'}]`);
      console.error(`              ${r.detail ?? 'unknown failure'}`);
    }
  }

  console.error('');
  if (failures > 0) {
    console.error(`${failures}/${results.length} endpoint(s) not conformant.`);
    process.exit(1);
  }
  console.error(`All ${results.length} endpoints conformant.`);
  process.exit(0);
}

function path(r: EndpointResult): string {
  return r.path.padEnd(15);
}

main().catch((error) => {
  console.error(`conformance runner crashed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(2);
});
