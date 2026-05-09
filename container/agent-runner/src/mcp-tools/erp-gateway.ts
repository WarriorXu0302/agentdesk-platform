/**
 * ERP gateway MCP tools.
 *
 * These provide a stable tool surface for enterprise agents while allowing
 * different ERP backends to sit behind a shared HTTP contract.
 */
import { getConfig, type EnterpriseGatewayConfig, type RunnerConfig } from '../config.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;

interface RequesterContext {
  userId?: string;
  channelType?: string;
  platformId?: string;
  threadId?: string | null;
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

function readRequester(args: Record<string, unknown>): RequesterContext {
  return {
    userId: getString(args, 'userId'),
    channelType: getString(args, 'channelType'),
    platformId: getString(args, 'platformId'),
    threadId: getNullableString(args, 'threadId'),
  };
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

async function callGateway(
  runtime: ToolRuntimeConfig,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const gateway = runtime.enterpriseGateway;
  if (!gateway?.baseUrl) {
    return { ok: false, message: 'ERP gateway is not configured for this agent group.' };
  }

  const controller = new AbortController();
  const timeoutMs = gateway.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${sanitizeBaseUrl(gateway.baseUrl)}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
        ...normalizeHeaders(gateway.defaultHeaders),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        message: `ERP gateway ${pathname} failed with ${response.status} ${response.statusText}: ${truncate(text)}`,
      };
    }
    return { ok: true, text: normalizeResponseText(text) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, message: `ERP gateway ${pathname} timed out after ${timeoutMs}ms.` };
    }
    return {
      ok: false,
      message: `ERP gateway ${pathname} request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
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

export async function handleErpDescribe(
  runtime: ToolRuntimeConfig,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const requester = readRequester(args);
  const result = await callGateway(runtime, '/describe', {
    agent: {
      agentGroupId: runtime.agentGroupId || null,
      groupName: runtime.groupName || null,
      assistantName: runtime.assistantName || null,
    },
    requester,
  });
  if (!result.ok) return err(result.message);
  log(`erp_describe: ${requester.userId ?? 'anonymous'}`);
  return ok(result.text);
}

export async function handleErpAuthorize(
  runtime: ToolRuntimeConfig,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const operation = getString(args, 'operation');
  if (!operation) return err('operation is required');

  const requester = readRequester(args);
  const result = await callGateway(runtime, '/authorize', {
    agent: {
      agentGroupId: runtime.agentGroupId || null,
      groupName: runtime.groupName || null,
      assistantName: runtime.assistantName || null,
    },
    requester,
    operation,
    input: getRecord(args, 'input') ?? {},
    context: getRecord(args, 'context') ?? {},
  });
  if (!result.ok) return err(result.message);
  log(`erp_authorize: ${operation} for ${requester.userId ?? 'anonymous'}`);
  return ok(result.text);
}

export async function handleErpExecute(
  runtime: ToolRuntimeConfig,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const operation = getString(args, 'operation');
  if (!operation) return err('operation is required');

  const requester = readRequester(args);
  const result = await callGateway(runtime, '/execute', {
    agent: {
      agentGroupId: runtime.agentGroupId || null,
      groupName: runtime.groupName || null,
      assistantName: runtime.assistantName || null,
    },
    requester,
    operation,
    input: getRecord(args, 'input') ?? {},
    context: getRecord(args, 'context') ?? {},
    dryRun: getBoolean(args, 'dryRun') ?? false,
    idempotencyKey: getString(args, 'idempotencyKey') ?? null,
  });
  if (!result.ok) return err(result.message);
  log(`erp_execute: ${operation} for ${requester.userId ?? 'anonymous'}`);
  return ok(result.text);
}

export async function handleErpMemoryGet(
  runtime: ToolRuntimeConfig,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const namespace = getString(args, 'namespace');
  if (!namespace) return err('namespace is required');

  const requester = readRequester(args);
  const subject = resolveMemorySubject(args, requester);
  if (!subject.ok) return err(subject.message);

  const result = await callGateway(runtime, '/memory/get', {
    agent: {
      agentGroupId: runtime.agentGroupId || null,
      groupName: runtime.groupName || null,
      assistantName: runtime.assistantName || null,
    },
    requester,
    namespace,
    subject: subject.subject,
    query: getRecord(args, 'query') ?? {},
    context: getRecord(args, 'context') ?? {},
  });
  if (!result.ok) return err(result.message);
  log(`erp_memory_get: ${namespace} for ${subject.subject.type}:${subject.subject.id}`);
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

  const requester = readRequester(args);
  const subject = resolveMemorySubject(args, requester);
  if (!subject.ok) return err(subject.message);

  const result = await callGateway(runtime, '/memory/upsert', {
    agent: {
      agentGroupId: runtime.agentGroupId || null,
      groupName: runtime.groupName || null,
      assistantName: runtime.assistantName || null,
    },
    requester,
    namespace,
    subject: subject.subject,
    value,
    merge: getBoolean(args, 'merge') ?? true,
    context: getRecord(args, 'context') ?? {},
  });
  if (!result.ok) return err(result.message);
  log(`erp_memory_upsert: ${namespace} for ${subject.subject.type}:${subject.subject.id}`);
  return ok(result.text);
}

export const erpDescribe: McpToolDefinition = {
  tool: {
    name: 'erp_describe',
    description: 'Describe the configured ERP gateway capabilities and supported operations.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'Optional namespaced user id on whose behalf the lookup runs.' },
        channelType: { type: 'string', description: 'Optional source channel type.' },
        platformId: { type: 'string', description: 'Optional source platform/chat id.' },
        threadId: { type: 'string', description: 'Optional source thread id.' },
      },
    },
  },
  async handler(args) {
    return handleErpDescribe(toolRuntimeConfigFromRunner(getConfig()), args);
  },
};

export const erpAuthorize: McpToolDefinition = {
  tool: {
    name: 'erp_authorize',
    description: 'Ask the configured ERP gateway whether a user may perform a named business operation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operation: { type: 'string', description: 'Stable business operation name, e.g. "sales.order.create".' },
        userId: { type: 'string', description: 'Namespaced user id on whose behalf the action would run.' },
        channelType: { type: 'string', description: 'Optional source channel type.' },
        platformId: { type: 'string', description: 'Optional source platform/chat id.' },
        threadId: { type: 'string', description: 'Optional source thread id.' },
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
    description: 'Execute a named ERP/business operation through the configured gateway.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operation: { type: 'string', description: 'Stable business operation name, e.g. "finance.invoice.approve".' },
        userId: { type: 'string', description: 'Namespaced user id on whose behalf the action runs.' },
        channelType: { type: 'string', description: 'Optional source channel type.' },
        platformId: { type: 'string', description: 'Optional source platform/chat id.' },
        threadId: { type: 'string', description: 'Optional source thread id.' },
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
      'Load durable backend memory for a user or other ERP subject. Use this instead of shared workspace memory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Stable memory namespace, e.g. "user.profile", "user.preferences".' },
        subjectType: { type: 'string', description: 'Memory subject type. Default: "user".' },
        subjectId: {
          type: 'string',
          description: 'Subject identifier. Defaults to requester.userId when subjectType="user".',
        },
        userId: { type: 'string', description: 'Namespaced requester user id on whose behalf the lookup runs.' },
        channelType: { type: 'string', description: 'Optional source channel type.' },
        platformId: { type: 'string', description: 'Optional source platform/chat id.' },
        threadId: { type: 'string', description: 'Optional source thread id.' },
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
      'Persist durable backend memory for a user or other ERP subject. Use this instead of shared workspace memory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Stable memory namespace, e.g. "user.profile", "user.preferences".' },
        subjectType: { type: 'string', description: 'Memory subject type. Default: "user".' },
        subjectId: {
          type: 'string',
          description: 'Subject identifier. Defaults to requester.userId when subjectType="user".',
        },
        userId: { type: 'string', description: 'Namespaced requester user id on whose behalf the write runs.' },
        channelType: { type: 'string', description: 'Optional source channel type.' },
        platformId: { type: 'string', description: 'Optional source platform/chat id.' },
        threadId: { type: 'string', description: 'Optional source thread id.' },
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
