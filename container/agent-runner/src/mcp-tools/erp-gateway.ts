/**
 * ERP gateway MCP tools.
 *
 * These provide a stable tool surface for enterprise agents while allowing
 * different ERP backends to sit behind a shared HTTP contract.
 *
 * Identity trust boundary
 * -----------------------
 * The requester identity (userId / channelType / platformId / threadId)
 * attached to each gateway call MUST NOT come from the agent's own tool
 * arguments — a prompt-injected agent can otherwise forge any identity it
 * likes. Instead, `resolveTrustedRequester()` reads the most recent chat
 * message from inbound.db (host-written, container-read) and uses that as
 * the ground truth. When that read succeeds, we send `requesterSource:
 * 'session'`. Only when no usable inbound row exists (scheduled tasks,
 * agent-to-agent sessions without an originating user) do we fall back to
 * agent-asserted values, tagged `requesterSource: 'agent-asserted'` so the
 * backend can apply a stricter policy to unauthenticated requests.
 */
import crypto from 'node:crypto';

import { writeMessageOut } from '../db/messages-out.js';
import { getConfig, type EnterpriseGatewayConfig, type RunnerConfig } from '../config.js';
import { getRequestIdentity } from '../request-context.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TIMESTAMP_HEADER = 'x-frontlane-timestamp';
const DEFAULT_NONCE_HEADER = 'x-frontlane-nonce';
const DEFAULT_SIGNATURE_HEADER = 'x-frontlane-signature';

type RequesterSource = 'session' | 'agent-asserted';

interface RequesterContext {
  userId?: string;
  channelType?: string;
  platformId?: string;
  threadId?: string | null;
}

interface ResolvedRequester {
  context: RequesterContext;
  source: RequesterSource;
}

interface MemorySubject {
  type: string;
  id: string;
}

interface ToolRuntimeConfig {
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  enterpriseGateway?: EnterpriseGatewayConfig;
}

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string): CallToolResult {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function toolRuntimeConfigFromRunner(config: RunnerConfig): ToolRuntimeConfig {
  return {
    assistantName: config.assistantName,
    groupName: config.groupName,
    agentGroupId: config.agentGroupId,
    enterpriseGateway: config.enterpriseGateway,
  };
}

function getString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function getNullableString(args: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in args)) return undefined;
  const value = args[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function getRecord(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readAgentAssertedRequester(args: Record<string, unknown>): RequesterContext {
  return {
    userId: getString(args, 'userId'),
    channelType: getString(args, 'channelType'),
    platformId: getString(args, 'platformId'),
    threadId: getNullableString(args, 'threadId'),
  };
}

/**
 * Resolve the requester identity to attach to a gateway call.
 *
 * Preferred path: the poll loop publishes a `RequestIdentity` at batch
 * start (see src/poll-loop.ts + src/request-context.ts) derived from the
 * first trigger=1 chat message in the batch. That's the authoritative
 * answer — it's fixed for the duration of the agent turn, unaffected by
 * later messages landing in group/shared sessions, and picks up
 * host-written `origin_user_id` on a2a hops.
 *
 * Fallback: when no identity is published (callers outside the poll loop —
 * in practice scheduled tasks or unit tests), we fall back to whatever
 * the agent asserted via tool arguments, tagged `agent-asserted` so the
 * backend can apply a stricter policy.
 */
function resolveRequester(args: Record<string, unknown>): ResolvedRequester {
  const asserted = readAgentAssertedRequester(args);
  const identity = getRequestIdentity();
  if (!identity) {
    return { context: asserted, source: 'agent-asserted' };
  }

  const trusted: RequesterContext = {};
  if (identity.userId) trusted.userId = identity.userId;
  if (identity.channelType) trusted.channelType = identity.channelType;
  if (identity.platformId) trusted.platformId = identity.platformId;
  // Preserve explicit null vs undefined so the backend can tell "no thread"
  // apart from "unknown".
  trusted.threadId = identity.threadId;

  if (!trusted.userId) {
    return { context: asserted, source: identity.source };
  }

  if (asserted.userId && asserted.userId !== trusted.userId) {
    log(`warn: agent userId "${asserted.userId}" overridden by session userId "${trusted.userId}"`);
  }
  return { context: trusted, source: identity.source };
}

function resolveMemorySubject(
  args: Record<string, unknown>,
  requester: RequesterContext,
): { ok: true; subject: MemorySubject } | { ok: false; message: string } {
  const subjectType = getString(args, 'subjectType') || 'user';
  const subjectId = getString(args, 'subjectId') || (subjectType === 'user' ? requester.userId : undefined);
  if (!subjectId) {
    return {
      ok: false,
      message: `subjectId is required for subjectType=${subjectType}`,
    };
  }
  return {
    ok: true,
    subject: {
      type: subjectType,
      id: subjectId,
    },
  };
}

function sanitizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function normalizeHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (!key || typeof value !== 'string') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Compute the HMAC-SHA256 signature for a gateway request.
 *
 * Canonical form: `<timestamp>.<nonce>.<body>` — keeping the three parts
 * separated by a byte that cannot appear in a base-10 integer or a hex
 * nonce eliminates any ambiguity between timestamp and body.
 */
export function computeGatewaySignature(key: string, timestamp: string, nonce: string, body: string): string {
  return crypto.createHmac('sha256', key).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

function applySigningHeaders(
  headers: Record<string, string>,
  gateway: EnterpriseGatewayConfig,
  body: string,
  now: number = Date.now(),
): void {
  const key = gateway.signingKey?.trim();
  if (!key) return;
  const timestamp = Math.floor(now / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = computeGatewaySignature(key, timestamp, nonce, body);
  const timestampHeader = gateway.signingHeaders?.timestamp || DEFAULT_TIMESTAMP_HEADER;
  const nonceHeader = gateway.signingHeaders?.nonce || DEFAULT_NONCE_HEADER;
  const signatureHeader = gateway.signingHeaders?.signature || DEFAULT_SIGNATURE_HEADER;
  headers[timestampHeader] = timestamp;
  headers[nonceHeader] = nonce;
  headers[signatureHeader] = signature;
}

function hashBody(path: string, body: Record<string, unknown>): string {
  try {
    // Different gateway paths carry their business payload in different
    // fields. Hashing `body.input` for everything collapses every /memory
    // call to the same digest (they don't use `input`) which wipes out the
    // audit row's forensic value. Pick the field per path so identical
    // operations on the same subject produce the same hash, and distinct
    // operations don't collide.
    let payload: unknown;
    switch (path) {
      case '/describe':
        payload = null;
        break;
      case '/authorize':
      case '/execute':
        payload = body.input ?? null;
        break;
      case '/memory/get':
        payload = { subject: body.subject ?? null, namespace: body.namespace ?? null, query: body.query ?? null };
        break;
      case '/memory/upsert':
        payload = {
          subject: body.subject ?? null,
          namespace: body.namespace ?? null,
          value: body.value ?? null,
          merge: body.merge ?? null,
        };
        break;
      default:
        payload = body.input ?? null;
    }
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  } catch {
    return '';
  }
}

function emitAuditMessage(params: {
  path: string;
  body: Record<string, unknown>;
  status: 'ok' | 'error';
  httpStatus?: number;
  durationMs: number;
  errorMsg?: string;
}): void {
  try {
    const body = params.body;
    const requester = (body.requester as { userId?: string } | undefined) ?? undefined;
    const content = {
      action: 'erp_audit',
      path: params.path,
      operation: typeof body.operation === 'string' ? body.operation : null,
      userId: requester?.userId ?? null,
      requesterSource: typeof body.requesterSource === 'string' ? body.requesterSource : 'agent-asserted',
      status: params.status,
      httpStatus: params.httpStatus ?? null,
      durationMs: params.durationMs,
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null,
      inputHash: hashBody(params.path, body),
      errorMsg: params.errorMsg ?? null,
    };
    writeMessageOut({
      id: `erp-audit-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      kind: 'system',
      content: JSON.stringify(content),
    });
  } catch (err) {
    console.error(`[mcp-tools] warn: erp_audit emit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function callGateway(
  runtime: ToolRuntimeConfig,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const gateway = runtime.enterpriseGateway;
  const startedAt = Date.now();
  if (!gateway?.baseUrl) {
    const msg = 'ERP gateway is not configured for this agent group.';
    emitAuditMessage({
      path: pathname,
      body,
      status: 'error',
      durationMs: Date.now() - startedAt,
      errorMsg: msg,
    });
    return { ok: false, message: msg };
  }

  const controller = new AbortController();
  const timeoutMs = gateway.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const bodyString = JSON.stringify(body);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      ...normalizeHeaders(gateway.defaultHeaders),
    };
    applySigningHeaders(headers, gateway, bodyString);
    const response = await fetch(`${sanitizeBaseUrl(gateway.baseUrl)}${pathname}`, {
      method: 'POST',
      headers,
      body: bodyString,
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      const msg = `ERP gateway ${pathname} failed with ${response.status} ${response.statusText}: ${truncate(text)}`;
      emitAuditMessage({
        path: pathname,
        body,
        status: 'error',
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        errorMsg: msg,
      });
      return { ok: false, message: msg };
    }
    emitAuditMessage({
      path: pathname,
      body,
      status: 'ok',
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
    });
    return { ok: true, text: normalizeResponseText(text) };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    const msg = aborted
      ? `ERP gateway ${pathname} timed out after ${timeoutMs}ms.`
      : `ERP gateway ${pathname} request failed: ${error instanceof Error ? error.message : String(error)}`;
    emitAuditMessage({
      path: pathname,
      body,
      status: 'error',
      durationMs: Date.now() - startedAt,
      errorMsg: msg,
    });
    return { ok: false, message: msg };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeResponseText(text: string): string {
  if (text.length === 0) return '{}';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function truncate(text: string): string {
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

function agentBlock(runtime: ToolRuntimeConfig): Record<string, unknown> {
  return {
    agentGroupId: runtime.agentGroupId || null,
    groupName: runtime.groupName || null,
    assistantName: runtime.assistantName || null,
  };
}

export async function handleErpDescribe(
  runtime: ToolRuntimeConfig,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const { context: requester, source: requesterSource } = resolveRequester(args);
  const result = await callGateway(runtime, '/describe', {
    agent: agentBlock(runtime),
    requester,
    requesterSource,
  });
  if (!result.ok) return err(result.message);
  log(`erp_describe: ${requester.userId ?? 'anonymous'} (${requesterSource})`);
  return ok(result.text);
}

export async function handleErpAuthorize(
  runtime: ToolRuntimeConfig,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const operation = getString(args, 'operation');
  if (!operation) return err('operation is required');

  const { context: requester, source: requesterSource } = resolveRequester(args);
  const result = await callGateway(runtime, '/authorize', {
    agent: agentBlock(runtime),
    requester,
    requesterSource,
    operation,
    input: getRecord(args, 'input') ?? {},
    context: getRecord(args, 'context') ?? {},
  });
  if (!result.ok) return err(result.message);
  log(`erp_authorize: ${operation} for ${requester.userId ?? 'anonymous'} (${requesterSource})`);
  return ok(result.text);
}

export async function handleErpExecute(
  runtime: ToolRuntimeConfig,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const operation = getString(args, 'operation');
  if (!operation) return err('operation is required');

  const { context: requester, source: requesterSource } = resolveRequester(args);
  const result = await callGateway(runtime, '/execute', {
    agent: agentBlock(runtime),
    requester,
    requesterSource,
    operation,
    input: getRecord(args, 'input') ?? {},
    context: getRecord(args, 'context') ?? {},
    dryRun: getBoolean(args, 'dryRun') ?? false,
    idempotencyKey: getString(args, 'idempotencyKey') ?? null,
  });
  if (!result.ok) return err(result.message);
  log(`erp_execute: ${operation} for ${requester.userId ?? 'anonymous'} (${requesterSource})`);
  return ok(result.text);
}

export async function handleErpMemoryGet(
  runtime: ToolRuntimeConfig,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const namespace = getString(args, 'namespace');
  if (!namespace) return err('namespace is required');

  const { context: requester, source: requesterSource } = resolveRequester(args);
  const subject = resolveMemorySubject(args, requester);
  if (!subject.ok) return err(subject.message);

  const result = await callGateway(runtime, '/memory/get', {
    agent: agentBlock(runtime),
    requester,
    requesterSource,
    namespace,
    subject: subject.subject,
    query: getRecord(args, 'query') ?? {},
    context: getRecord(args, 'context') ?? {},
  });
  if (!result.ok) return err(result.message);
  log(`erp_memory_get: ${namespace} for ${subject.subject.type}:${subject.subject.id} (${requesterSource})`);
  return ok(result.text);
}

export async function handleErpMemoryUpsert(
  runtime: ToolRuntimeConfig,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const namespace = getString(args, 'namespace');
  if (!namespace) return err('namespace is required');

  const value = getRecord(args, 'value');
  if (!value) return err('value is required');

  const { context: requester, source: requesterSource } = resolveRequester(args);
  const subject = resolveMemorySubject(args, requester);
  if (!subject.ok) return err(subject.message);

  const result = await callGateway(runtime, '/memory/upsert', {
    agent: agentBlock(runtime),
    requester,
    requesterSource,
    namespace,
    subject: subject.subject,
    value,
    merge: getBoolean(args, 'merge') ?? true,
    context: getRecord(args, 'context') ?? {},
  });
  if (!result.ok) return err(result.message);
  log(`erp_memory_upsert: ${namespace} for ${subject.subject.type}:${subject.subject.id} (${requesterSource})`);
  return ok(result.text);
}

export const erpDescribe: McpToolDefinition = {
  tool: {
    name: 'erp_describe',
    description:
      'Describe the configured ERP gateway capabilities and supported operations. ' +
      'Requester identity is derived from the active session by the runtime — any userId/channelType/platformId/threadId you pass is ignored in favor of the host-supplied values.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async handler(args) {
    return handleErpDescribe(toolRuntimeConfigFromRunner(getConfig()), args);
  },
};

export const erpAuthorize: McpToolDefinition = {
  tool: {
    name: 'erp_authorize',
    description:
      'Ask the configured ERP gateway whether the current user may perform a named business operation. ' +
      'Requester identity is derived from the active session by the runtime — userId/channelType/platformId/threadId passed here are ignored.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operation: { type: 'string', description: 'Stable business operation name, e.g. "sales.order.create".' },
        input: { type: 'object', description: 'Operation payload to authorize.' },
        context: { type: 'object', description: 'Optional extra authorization context.' },
      },
      required: ['operation'],
    },
  },
  async handler(args) {
    return handleErpAuthorize(toolRuntimeConfigFromRunner(getConfig()), args);
  },
};

export const erpExecute: McpToolDefinition = {
  tool: {
    name: 'erp_execute',
    description:
      'Execute a named ERP/business operation through the configured gateway. ' +
      'Requester identity is derived from the active session by the runtime — userId/channelType/platformId/threadId passed here are ignored.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operation: { type: 'string', description: 'Stable business operation name, e.g. "finance.invoice.approve".' },
        input: { type: 'object', description: 'Operation payload.' },
        context: { type: 'object', description: 'Optional backend context.' },
        dryRun: { type: 'boolean', description: 'Validate or preview without committing state.' },
        idempotencyKey: { type: 'string', description: 'Optional idempotency key for write operations.' },
      },
      required: ['operation'],
    },
  },
  async handler(args) {
    return handleErpExecute(toolRuntimeConfigFromRunner(getConfig()), args);
  },
};

export const erpMemoryGet: McpToolDefinition = {
  tool: {
    name: 'erp_memory_get',
    description:
      'Load durable backend memory for a user or other ERP subject. Use this instead of shared workspace memory. ' +
      'Requester identity is derived from the active session by the runtime — userId/channelType/platformId/threadId passed here are ignored.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Stable memory namespace, e.g. "user.profile", "user.preferences".' },
        subjectType: { type: 'string', description: 'Memory subject type. Default: "user".' },
        subjectId: {
          type: 'string',
          description: 'Subject identifier. Defaults to the session requester user id when subjectType="user".',
        },
        query: { type: 'object', description: 'Optional query/filter payload for the backend.' },
        context: { type: 'object', description: 'Optional extra backend context.' },
      },
      required: ['namespace'],
    },
  },
  async handler(args) {
    return handleErpMemoryGet(toolRuntimeConfigFromRunner(getConfig()), args);
  },
};

export const erpMemoryUpsert: McpToolDefinition = {
  tool: {
    name: 'erp_memory_upsert',
    description:
      'Persist durable backend memory for a user or other ERP subject. Use this instead of shared workspace memory. ' +
      'Requester identity is derived from the active session by the runtime — userId/channelType/platformId/threadId passed here are ignored.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Stable memory namespace, e.g. "user.profile", "user.preferences".' },
        subjectType: { type: 'string', description: 'Memory subject type. Default: "user".' },
        subjectId: {
          type: 'string',
          description: 'Subject identifier. Defaults to the session requester user id when subjectType="user".',
        },
        value: { type: 'object', description: 'Structured memory payload to store.' },
        merge: {
          type: 'boolean',
          description: 'Whether the backend should merge into an existing record. Default: true.',
        },
        context: { type: 'object', description: 'Optional extra backend context.' },
      },
      required: ['namespace', 'value'],
    },
  },
  async handler(args) {
    return handleErpMemoryUpsert(toolRuntimeConfigFromRunner(getConfig()), args);
  },
};

registerTools([erpDescribe, erpAuthorize, erpExecute, erpMemoryGet, erpMemoryUpsert]);
