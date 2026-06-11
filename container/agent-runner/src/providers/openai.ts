import { createHash } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { touchHeartbeat } from '../db/connection.js';
import { PLATFORM_PROTOCOL_NAMESPACE } from '../branding.js';
import { setContinuation } from '../db/session-state.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_TIMEOUT_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1_500;
const MAX_REPLAY_TRANSCRIPT_ITEMS = 128;
const MAX_REPLAY_TRANSCRIPT_CHARS = 120_000;
const PREVIOUS_RESPONSE_UNSUPPORTED_RE = /previous_response_id.*(?:responses websocket v2|only supported)/i;
const RESPONSES_TRANSPORT_FALLBACK_RE =
  /non-json response \((404|405|502|503|504)\)|unreadable sse response \((404|405|502|503|504)\)|request failed with status (404|405|502|503|504)|does not support the ['"]?\/v1\/responses['"]? api|\/v1\/responses[^a-z0-9]+(?:is\s+)?(?:not\s+supported|unsupported)|failed to deserialize the json body.*invalid ['"]?input['"]?|invalid ['"]?input['"]?:\s*value did not match any expected variant/i;
const INVALID_SESSION_RE =
  /response.*not found|unknown response|invalid response|previous_response_id.*(?:not found|does not exist|invalid)/i;

type JsonObject = Record<string, unknown>;

interface OpenAIFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

interface OpenAIResponseError {
  message?: string;
}

interface OpenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  // chat-completions API uses prompt_tokens / completion_tokens names instead;
  // we normalize at extraction time.
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface OpenAIResponse {
  id?: string;
  status?: string;
  error?: OpenAIResponseError | null;
  incomplete_details?: { reason?: string } | null;
  output?: OpenAIOutputItem[];
  output_text?: string;
  usage?: OpenAIUsage;
}

interface OpenAIOutputItem extends JsonObject {
  type?: string;
}

interface OpenAIFunctionCall extends OpenAIOutputItem {
  type: 'function_call';
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface OpenAIChatCompletionResponse {
  id?: string;
  error?: OpenAIResponseError | null;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
}

interface ToolBinding {
  client: Client;
  originalName: string;
}

interface ConnectedMcpServer {
  client: Client;
}

type ContinuationMode = 'responses' | 'stateless';
type OpenAITransport = 'responses' | 'chat-completions';

interface OpenAIContinuationState {
  v: 1 | 2;
  mode: ContinuationMode;
  transport: OpenAITransport;
  responseId?: string;
  transcript: JsonObject[];
}

function log(msg: string): void {
  console.error(`[openai-provider] ${msg}`);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = (raw || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_BASE_URL;
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

function sanitizeToolSegment(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_');
  return normalized || 'tool';
}

function qualifyToolName(serverName: string, toolName: string, used: Set<string>): string {
  const base = `mcp__${sanitizeToolSegment(serverName)}__${sanitizeToolSegment(toolName)}`;
  if (base.length <= 64 && !used.has(base)) {
    used.add(base);
    return base;
  }

  const hash = createHash('sha256').update(`${serverName}:${toolName}`).digest('hex').slice(0, 8);
  const maxPrefix = Math.max(1, 64 - hash.length - 1);
  let candidate = `${base.slice(0, maxPrefix)}_${hash}`;
  let suffix = 2;
  while (used.has(candidate)) {
    const suffixText = `_${suffix++}`;
    candidate = `${candidate.slice(0, Math.max(1, 64 - suffixText.length))}${suffixText}`;
  }
  used.add(candidate);
  return candidate;
}

function defaultInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

function toolInputSchema(tool: Tool): Record<string, unknown> {
  const raw =
    (tool as unknown as { inputSchema?: unknown; input_schema?: unknown }).inputSchema ??
    (tool as unknown as { inputSchema?: unknown; input_schema?: unknown }).input_schema;
  return isRecord(raw) ? raw : defaultInputSchema();
}

function formatToolResult(result: CallToolResult): string {
  const parts: string[] = [];
  const withStructured = result as CallToolResult & { structuredContent?: unknown };

  if (withStructured.structuredContent !== undefined) {
    parts.push(JSON.stringify(withStructured.structuredContent, null, 2));
  }

  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item)) {
        parts.push(String(item));
        continue;
      }
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
        continue;
      }
      if ('json' in item) {
        parts.push(JSON.stringify(item.json, null, 2));
        continue;
      }
      parts.push(JSON.stringify(item, null, 2));
    }
  }

  if (parts.length === 0) {
    return result.isError ? 'Tool returned an error with no details.' : 'Tool completed successfully with no output.';
  }

  const joined = parts
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
    .trim();
  return (
    joined ||
    (result.isError ? 'Tool returned an error with no details.' : 'Tool completed successfully with no output.')
  );
}

function collectFunctionCalls(output: OpenAIOutputItem[] | undefined): OpenAIFunctionCall[] {
  if (!Array.isArray(output)) return [];
  return output.filter((item): item is OpenAIFunctionCall => item.type === 'function_call');
}

function extractOutputText(response: OpenAIResponse): string | null {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
  }

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (!isRecord(item) || item.type !== 'message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }

  const text = parts.join('\n').trim();
  return text || null;
}

function transcriptSize(item: JsonObject): number {
  try {
    return JSON.stringify(item).length;
  } catch {
    return 0;
  }
}

function trimTranscript(items: JsonObject[]): JsonObject[] {
  const capped = items.slice(-MAX_REPLAY_TRANSCRIPT_ITEMS);
  if (capped.length === 0) return capped;

  const sizes = capped.map(transcriptSize);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let start = 0;
  while (total > MAX_REPLAY_TRANSCRIPT_CHARS && start < capped.length - 1) {
    total -= sizes[start] ?? 0;
    start += 1;
  }
  return capped.slice(start);
}

function appendTranscript(existing: JsonObject[], items: JsonObject[]): JsonObject[] {
  if (items.length === 0) return existing;
  return trimTranscript([...existing, ...items.map((item) => cloneJson(item))]);
}

function userMessageInput(text: string): JsonObject {
  return {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

function replayableOutputItems(output: OpenAIOutputItem[] | undefined): JsonObject[] {
  if (!Array.isArray(output)) return [];
  const replayable: JsonObject[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type !== 'message' && item.type !== 'function_call') continue;
    replayable.push(cloneJson(item));
  }
  return replayable;
}

// F2: tool_call_id entries don't survive a cross-session restore — once persisted
// and reloaded into a stateless replay, the upstream API has no record of the
// originating tool call and rejects the orphan output. Strip them before persist
// so the restored transcript only carries plain message turns.
function stripStaleToolCallTranscript(items: JsonObject[]): JsonObject[] {
  return items.filter((item) => {
    const type = (item as { type?: unknown }).type;
    return type !== 'function_call' && type !== 'function_call_output';
  });
}

function parseContinuationState(raw: string | undefined): OpenAIContinuationState {
  const legacyResponseId = readString(raw);
  if (!legacyResponseId) {
    return { v: 2, mode: 'responses', transport: 'responses', transcript: [] };
  }

  try {
    const parsed = JSON.parse(legacyResponseId) as unknown;
    if (!isRecord(parsed) || (parsed.v !== 1 && parsed.v !== 2)) {
      return { v: 2, mode: 'responses', transport: 'responses', responseId: legacyResponseId, transcript: [] };
    }

    const mode = parsed.mode === 'stateless' ? 'stateless' : 'responses';
    const transport = parsed.transport === 'chat-completions' ? 'chat-completions' : 'responses';
    const transcript = Array.isArray(parsed.transcript)
      ? trimTranscript(stripStaleToolCallTranscript(parsed.transcript.filter(isRecord).map((item) => cloneJson(item))))
      : [];
    const responseId = readString(parsed.responseId);
    return {
      v: parsed.v === 2 ? 2 : 1,
      mode: transport === 'chat-completions' ? 'stateless' : mode,
      transport,
      responseId,
      transcript,
    };
  } catch {
    return { v: 2, mode: 'responses', transport: 'responses', responseId: legacyResponseId, transcript: [] };
  }
}

function serializeContinuationState(state: OpenAIContinuationState): string {
  return JSON.stringify({
    v: 2,
    mode: state.mode,
    transport: state.transport,
    responseId: state.responseId,
    transcript: trimTranscript(stripStaleToolCallTranscript(state.transcript)),
  });
}

function persistAliasedContinuation(value: string): void {
  // `codex` is an alias of the OpenAI-compatible provider; persist both so
  // mid-turn recovery keeps working even if the configured provider name flips.
  setContinuation('openai', value);
  setContinuation('codex', value);
}

function isPreviousResponseIdUnsupported(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return PREVIOUS_RESPONSE_UNSUPPORTED_RE.test(message);
}

function shouldFallbackToChatCompletions(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RESPONSES_TRANSPORT_FALLBACK_RE.test(message);
}

function extractMessageTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const text = readString(item.text);
    if (text) parts.push(text);
  }
  return parts.join('\n').trim();
}

function transcriptToChatMessages(transcript: JsonObject[], instructions?: string): JsonObject[] {
  const messages: JsonObject[] = [];
  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  let pendingToolCalls: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }> = [];

  function flushPendingToolCalls(): void {
    if (pendingToolCalls.length === 0) return;
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: pendingToolCalls,
    });
    pendingToolCalls = [];
  }

  for (const item of transcript) {
    const type = readString(item.type);
    if (type === 'function_call') {
      const callId = readString(item.call_id);
      const name = readString(item.name);
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      if (callId && name) {
        pendingToolCalls.push({
          id: callId,
          type: 'function',
          function: {
            name,
            arguments: args,
          },
        });
      }
      continue;
    }

    flushPendingToolCalls();

    if (type === 'function_call_output') {
      const callId = readString(item.call_id);
      if (callId) {
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        });
      }
      continue;
    }

    if (type !== 'message') continue;
    const role = readString(item.role);
    if (!role) continue;
    const content = extractMessageTextContent(item.content);
    messages.push({
      role,
      content,
    });
  }

  flushPendingToolCalls();
  return messages;
}

function responseToolsToChatTools(tools: OpenAIFunctionTool[]): JsonObject[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function chatCompletionToResponse(response: OpenAIChatCompletionResponse): OpenAIResponse {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const output: OpenAIOutputItem[] = [];

  const contentText = extractMessageTextContent(message?.content);
  if (contentText) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: contentText }],
    });
  }

  for (const toolCall of message?.tool_calls ?? []) {
    if (!toolCall || toolCall.type !== 'function') continue;
    output.push({
      type: 'function_call',
      call_id: readString(toolCall.id),
      name: readString(toolCall.function?.name),
      arguments: typeof toolCall.function?.arguments === 'string' ? toolCall.function.arguments : undefined,
    });
  }

  return {
    id: readString(response.id),
    status: 'completed',
    error: response.error ?? null,
    output,
    output_text: contentText || undefined,
    usage: response.usage,
  };
}

function parseSseResponse(raw: string): OpenAIResponse | null {
  if (!raw.includes('event:') || !raw.includes('data:')) return null;

  let response: OpenAIResponse | null = null;
  const outputItems: OpenAIOutputItem[] = [];
  const textByItemId = new Map<string, string>();

  let currentEvent = '';
  let dataLines: string[] = [];

  function flushEvent(): void {
    if (!dataLines.length) {
      currentEvent = '';
      return;
    }

    const payloadText = dataLines.join('\n').trim();
    dataLines = [];
    if (!payloadText) {
      currentEvent = '';
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      currentEvent = '';
      return;
    }
    if (!isRecord(payload)) {
      currentEvent = '';
      return;
    }

    if ((currentEvent === 'response.created' || currentEvent === 'response.completed') && isRecord(payload.response)) {
      response = {
        ...(response ?? {}),
        ...(payload.response as OpenAIResponse),
      };
    } else if (currentEvent === 'response.output_item.done' && isRecord(payload.item)) {
      outputItems.push(payload.item as OpenAIOutputItem);
    } else if (currentEvent === 'response.output_text.done') {
      const itemId = readString(payload.item_id);
      const text = readString(payload.text);
      if (itemId && text) {
        textByItemId.set(itemId, text);
      }
    }

    currentEvent = '';
  }

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) {
      flushEvent();
      continue;
    }
    if (line.startsWith('event:')) {
      currentEvent = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }
  flushEvent();

  if (!response) return null;

  for (const item of outputItems) {
    const itemId = readString(item.id);
    const existingText = itemId ? textByItemId.get(itemId) : undefined;
    if (existingText && item.type === 'message') {
      const content = Array.isArray(item.content) ? [...item.content] : [];
      if (!content.some((part) => isRecord(part) && part.type === 'output_text')) {
        content.push({ type: 'output_text', text: existingText, annotations: [], logprobs: [] });
      }
      item.content = content;
    }
  }

  // Refresh narrowing — TS loses the inner closure's reassignment story so
  // it ends up typing `response` as `never` here. Pin it back to a fresh
  // `OpenAIResponse` binding before mutating.
  const final: OpenAIResponse = response;
  final.output = outputItems;
  final.output_text = extractOutputText(final) ?? undefined;
  return final;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
  touchHeartbeat();
  const interval = setInterval(() => touchHeartbeat(), HEARTBEAT_INTERVAL_MS);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
    touchHeartbeat();
  }
}

class OpenAIMcpBridge {
  private readonly mcpServers: Record<string, McpServerConfig>;
  private readonly env: Record<string, string | undefined>;
  private readonly connectedServers = new Map<string, ConnectedMcpServer>();
  private readonly toolBindings = new Map<string, ToolBinding>();
  private toolsPromise: Promise<OpenAIFunctionTool[]> | null = null;

  constructor(mcpServers: Record<string, McpServerConfig>, env: Record<string, string | undefined>) {
    this.mcpServers = mcpServers;
    this.env = env;
  }

  async listTools(): Promise<OpenAIFunctionTool[]> {
    if (!this.toolsPromise) {
      this.toolsPromise = this.loadTools();
    }
    return this.toolsPromise;
  }

  async callTool(qualifiedName: string, rawArguments: string | undefined): Promise<string> {
    const binding = this.toolBindings.get(qualifiedName);
    if (!binding) {
      return `Unknown MCP tool: ${qualifiedName}`;
    }

    let parsedArgs: Record<string, unknown> = {};
    const trimmed = rawArguments?.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        parsedArgs = isRecord(parsed) ? parsed : { value: parsed };
      } catch (err) {
        return `Invalid JSON arguments for ${qualifiedName}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    try {
      const result = await withHeartbeat(() =>
        binding.client.callTool({
          name: binding.originalName,
          arguments: parsedArgs,
        }),
      );
      // The SDK's CallToolResult type from runtime + the same type referenced
      // by formatToolResult diverge by a hair (`_meta` is widened to
      // Record<string, unknown>). Functionally identical — assert through.
      return formatToolResult(result as Parameters<typeof formatToolResult>[0]);
    } catch (err) {
      return `Tool ${qualifiedName} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async loadTools(): Promise<OpenAIFunctionTool[]> {
    const usedNames = new Set<string>();
    const tools: OpenAIFunctionTool[] = [];

    for (const [serverName, config] of Object.entries(this.mcpServers)) {
      const server = await this.getServer(serverName, config);
      let cursor: string | undefined;
      do {
        const listed = await server.client.listTools(cursor ? { cursor } : undefined);
        for (const tool of listed.tools ?? []) {
          const qualifiedName = qualifyToolName(serverName, tool.name, usedNames);
          this.toolBindings.set(qualifiedName, {
            client: server.client,
            originalName: tool.name,
          });
          tools.push({
            type: 'function',
            name: qualifiedName,
            description: tool.description
              ? `${tool.description}\n\nOriginal MCP tool: ${tool.name} on server ${serverName}.`
              : `MCP tool ${tool.name} on server ${serverName}.`,
            parameters: toolInputSchema(tool),
            strict: false,
          });
        }
        cursor = listed.nextCursor;
      } while (cursor);
    }

    log(`Loaded ${tools.length} MCP tools for OpenAI provider`);
    return tools;
  }

  private async getServer(serverName: string, config: McpServerConfig): Promise<ConnectedMcpServer> {
    const existing = this.connectedServers.get(serverName);
    if (existing) return existing;

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...(Object.fromEntries(Object.entries(this.env).filter(([, value]) => typeof value === 'string')) as Record<
          string,
          string
        >),
        ...(config.env ?? {}),
      },
    });

    const client = new Client(
      {
        name: `${PLATFORM_PROTOCOL_NAMESPACE}-openai-${sanitizeToolSegment(serverName)}`,
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    await client.connect(transport);

    const connected = { client };
    this.connectedServers.set(serverName, connected);
    return connected;
  }
}

export class OpenAIProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly reasoningEffort?: string;
  private readonly timeoutMs: number;
  private readonly forceTransport?: OpenAITransport;
  private readonly bridge: OpenAIMcpBridge;

  constructor(options: ProviderOptions = {}) {
    const env = options.env ?? {};
    this.baseUrl = normalizeBaseUrl(readString(env.OPENAI_BASE_URL));
    this.apiKey = readString(env.OPENAI_API_KEY) || '';
    this.model = readString(env.OPENAI_MODEL) || DEFAULT_MODEL;
    this.reasoningEffort = readString(env.OPENAI_REASONING_EFFORT);
    this.timeoutMs = Number.parseInt(readString(env.OPENAI_TIMEOUT_MS) || '', 10) || DEFAULT_TIMEOUT_MS;
    const force = readString(env.OPENAI_FORCE_TRANSPORT)?.toLowerCase();
    this.forceTransport = force === 'chat-completions' || force === 'responses' ? force : undefined;
    this.bridge = new OpenAIMcpBridge(options.mcpServers ?? {}, env);
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return INVALID_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    let pendingFollowUp: string | null = null;
    let stopRequested = false;
    let activeAbort: AbortController | null = null;
    let continuation = input.continuation;

    const events: AsyncIterable<ProviderEvent> = {
      [Symbol.asyncIterator]: async function* (
        this: OpenAIProvider,
      ): AsyncGenerator<ProviderEvent, void, unknown> {
        let currentPrompt = input.prompt;

        while (true) {
          if (stopRequested && !pendingFollowUp) return;

          const controller = new AbortController();
          activeAbort = controller;

          try {
            const turn = await this.runTurn({
              prompt: currentPrompt,
              continuation,
              instructions: input.systemContext?.instructions,
              signal: controller.signal,
            });

            continuation = turn.continuation;
            yield { type: 'init', continuation };
            for (const progress of turn.progressMessages) {
              yield { type: 'progress', message: progress };
            }
            for (const u of turn.usages) {
              yield {
                type: 'usage',
                model: u.model,
                inputTokens: u.inputTokens,
                outputTokens: u.outputTokens,
                totalTokens: u.totalTokens,
                durationMs: u.durationMs,
                transport: u.transport,
              };
            }
            yield { type: 'result', text: turn.text };
          } catch (err) {
            if (controller.signal.aborted) {
              if (pendingFollowUp) {
                currentPrompt = pendingFollowUp;
                pendingFollowUp = null;
                continue;
              }
              if (stopRequested) return;
            }
            throw err;
          } finally {
            if (activeAbort === controller) {
              activeAbort = null;
            }
          }

          if (pendingFollowUp) {
            currentPrompt = pendingFollowUp;
            pendingFollowUp = null;
            continue;
          }

          return;
        }
      }.bind(this),
    };

    return {
      push(message: string) {
        pendingFollowUp = message;
        activeAbort?.abort();
      },
      end() {
        // OpenAI responses are discrete turns; nothing to flush here.
      },
      events,
      abort() {
        stopRequested = true;
        activeAbort?.abort();
      },
    };
  }

  private async runTurn(params: {
    prompt: string;
    continuation?: string;
    instructions?: string;
    signal: AbortSignal;
  }): Promise<{
    continuation: string;
    text: string | null;
    progressMessages: string[];
    usages: Array<{
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      durationMs?: number;
      transport: OpenAITransport;
    }>;
  }> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is missing for provider=openai');
    }

    const tools = await this.bridge.listTools();
    const progressMessages: string[] = [];
    const usages: Array<{
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      durationMs?: number;
      transport: OpenAITransport;
    }> = [];
    const restored = parseContinuationState(params.continuation);
    let mode: ContinuationMode = this.forceTransport === 'chat-completions' ? 'stateless' : restored.mode;
    let transport: OpenAITransport = this.forceTransport ?? restored.transport;
    let previousResponseId =
      this.forceTransport === 'chat-completions' ? undefined : restored.mode === 'responses' ? restored.responseId : undefined;
    let transcript = trimTranscript(restored.transcript);
    transcript = appendTranscript(transcript, [userMessageInput(params.prompt)]);
    let nextInput: unknown =
      transport === 'chat-completions' || mode === 'stateless' ? transcript : transcript[transcript.length - 1];

    while (true) {
      if (params.signal.aborted) throw new Error('OpenAI request aborted');

      let response: OpenAIResponse;
      const callStartedAt = Date.now();
      try {
        if (transport === 'chat-completions') {
          response = await this.createChatCompletionResponse({
            transcript: Array.isArray(nextInput) ? nextInput.filter(isRecord) : transcript,
            instructions: params.instructions,
            tools,
            signal: params.signal,
          });
        } else {
          response = await this.createResponse({
            previousResponseId: mode === 'responses' ? previousResponseId : undefined,
            input: nextInput,
            instructions: params.instructions,
            tools,
            signal: params.signal,
          });
        }
      } catch (err) {
        if (
          transport === 'responses' &&
          mode === 'responses' &&
          previousResponseId &&
          isPreviousResponseIdUnsupported(err)
        ) {
          log('OpenAI-compatible backend rejected previous_response_id; switching to stateless replay mode');
          mode = 'stateless';
          previousResponseId = undefined;
          nextInput = transcript;
          continue;
        }
        if (transport === 'responses' && shouldFallbackToChatCompletions(err)) {
          log('OpenAI Responses API appears unstable on this backend; switching to chat completions fallback');
          transport = 'chat-completions';
          mode = 'stateless';
          previousResponseId = undefined;
          nextInput = transcript;
          continue;
        }
        throw err;
      }

      const responseId = readString(response.id);
      if (!responseId) {
        throw new Error('OpenAI response missing id');
      }
      const responseItems = replayableOutputItems(response.output);

      // Record LLM usage for observability before any branch that might
      // throw — this LLM call already happened so cost is real regardless
      // of whether we end up surfacing the result to the caller.
      if (response.usage) {
        const u = response.usage;
        usages.push({
          model: this.model,
          inputTokens: u.input_tokens ?? u.prompt_tokens,
          outputTokens: u.output_tokens ?? u.completion_tokens,
          totalTokens: u.total_tokens,
          durationMs: Date.now() - callStartedAt,
          transport,
        });
      }

      const functionCalls = collectFunctionCalls(response.output);
      if (functionCalls.length === 0) {
        transcript = appendTranscript(transcript, responseItems);
        const continuation = serializeContinuationState({
          v: 2,
          mode,
          transport,
          responseId: mode === 'responses' ? responseId : undefined,
          transcript,
        });
        persistAliasedContinuation(continuation);
        if (response.error?.message) {
          throw new Error(response.error.message);
        }
        if (response.status === 'incomplete') {
          throw new Error(
            `OpenAI response incomplete${response.incomplete_details?.reason ? `: ${response.incomplete_details.reason}` : ''}`,
          );
        }
        return {
          continuation,
          text: extractOutputText(response),
          progressMessages,
          usages,
        };
      }

      const toolOutputs: Array<{ type: 'function_call_output'; call_id: string; output: string }> = [];
      for (const call of functionCalls) {
        if (params.signal.aborted) throw new Error('OpenAI request aborted');

        const callId = readString(call.call_id);
        const name = readString(call.name);
        if (!callId || !name) {
          continue;
        }

        progressMessages.push(`Calling ${name}`);
        const output = await this.bridge.callTool(name, readString(call.arguments));
        toolOutputs.push({
          type: 'function_call_output',
          call_id: callId,
          output,
        });
      }

      transcript = appendTranscript(transcript, [...responseItems, ...toolOutputs]);
      const continuation = serializeContinuationState({
        v: 2,
        mode,
        transport,
        responseId: mode === 'responses' ? responseId : undefined,
        transcript,
      });
      persistAliasedContinuation(continuation);
      previousResponseId = responseId;
      nextInput = transport === 'responses' && mode === 'responses' ? toolOutputs : transcript;
    }
  }

  private async createResponse(params: {
    previousResponseId?: string;
    input: unknown;
    instructions?: string;
    tools: OpenAIFunctionTool[];
    signal: AbortSignal;
  }): Promise<OpenAIResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortFromCaller = () => controller.abort();
    params.signal.addEventListener('abort', abortFromCaller, { once: true });

    const body: Record<string, unknown> = {
      model: this.model,
      input: params.input,
      tools: params.tools,
      parallel_tool_calls: false,
      store: true,
      stream: false,
    };

    if (params.previousResponseId) {
      body.previous_response_id = params.previousResponseId;
    }
    if (params.instructions) {
      body.instructions = params.instructions;
    }
    if (this.reasoningEffort) {
      body.reasoning = { effort: this.reasoningEffort };
    }

    try {
      for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
        let response: Response;
        try {
          response = await withHeartbeat(() =>
            fetch(`${this.baseUrl}/responses`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.apiKey}`,
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            }),
          );
        } catch (err) {
          if (params.signal.aborted) throw err;
          if (controller.signal.aborted) {
            throw new Error(`OpenAI request timed out after ${this.timeoutMs}ms`);
          }
          if (attempt < MAX_REQUEST_ATTEMPTS) {
            log(
              `OpenAI request transport failed (attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}), retrying: ${err instanceof Error ? err.message : String(err)}`,
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
            continue;
          }
          throw err;
        }

        const raw = await withHeartbeat(() => response.text());
        let parsed: unknown;
        const contentType = response.headers.get('content-type') || '';
        try {
          if (contentType.includes('text/event-stream')) {
            parsed = parseSseResponse(raw);
            if (!parsed) {
              throw new Error(`OpenAI endpoint returned unreadable SSE response (${response.status})`);
            }
          } else {
            try {
              parsed = raw ? JSON.parse(raw) : {};
            } catch {
              parsed = parseSseResponse(raw);
              if (!parsed) {
                throw new Error(`OpenAI endpoint returned non-JSON response (${response.status})`);
              }
            }
          }
        } catch (err) {
          if (attempt < MAX_REQUEST_ATTEMPTS && isRetryableStatus(response.status)) {
            log(
              `OpenAI response parse failed (status ${response.status}, attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}), retrying: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
            continue;
          }
          throw err;
        }

        if (!response.ok) {
          const message =
            isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string'
              ? parsed.error.message
              : `OpenAI request failed with status ${response.status}`;
          if (attempt < MAX_REQUEST_ATTEMPTS && isRetryableStatus(response.status)) {
            log(
              `OpenAI request failed with status ${response.status} (attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}), retrying`,
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
            continue;
          }
          throw new Error(message);
        }

        if (!isRecord(parsed)) {
          throw new Error('OpenAI endpoint returned an invalid response payload');
        }

        return parsed as OpenAIResponse;
      }

      throw new Error('OpenAI request exhausted retries');
    } finally {
      clearTimeout(timeout);
      params.signal.removeEventListener('abort', abortFromCaller);
    }
  }

  private async createChatCompletionResponse(params: {
    transcript: JsonObject[];
    instructions?: string;
    tools: OpenAIFunctionTool[];
    signal: AbortSignal;
  }): Promise<OpenAIResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortFromCaller = () => controller.abort();
    params.signal.addEventListener('abort', abortFromCaller, { once: true });

    const body: Record<string, unknown> = {
      model: this.model,
      messages: transcriptToChatMessages(params.transcript, params.instructions),
      tools: responseToolsToChatTools(params.tools),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      stream: false,
    };

    try {
      for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
        let response: Response;
        try {
          response = await withHeartbeat(() =>
            fetch(`${this.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.apiKey}`,
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            }),
          );
        } catch (err) {
          if (params.signal.aborted) throw err;
          if (controller.signal.aborted) {
            throw new Error(`OpenAI chat completion request timed out after ${this.timeoutMs}ms`);
          }
          if (attempt < MAX_REQUEST_ATTEMPTS) {
            log(
              `OpenAI chat completion transport failed (attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}), retrying: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
            continue;
          }
          throw err;
        }

        const raw = await withHeartbeat(() => response.text());
        let parsed: unknown;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          if (attempt < MAX_REQUEST_ATTEMPTS && isRetryableStatus(response.status)) {
            log(
              `OpenAI chat completion parse failed (status ${response.status}, attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}), retrying`,
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
            continue;
          }
          throw new Error(`OpenAI chat completion endpoint returned non-JSON response (${response.status})`);
        }

        if (!response.ok) {
          const message =
            isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string'
              ? parsed.error.message
              : `OpenAI chat completion request failed with status ${response.status}`;
          if (attempt < MAX_REQUEST_ATTEMPTS && isRetryableStatus(response.status)) {
            log(
              `OpenAI chat completion failed with status ${response.status} (attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}), retrying`,
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
            continue;
          }
          throw new Error(message);
        }

        if (!isRecord(parsed)) {
          throw new Error('OpenAI chat completion endpoint returned an invalid response payload');
        }

        return chatCompletionToResponse(parsed as OpenAIChatCompletionResponse);
      }

      throw new Error('OpenAI chat completion request exhausted retries');
    } finally {
      clearTimeout(timeout);
      params.signal.removeEventListener('abort', abortFromCaller);
    }
  }
}

registerProvider('openai', (opts) => new OpenAIProvider(opts));
registerProvider('codex', (opts) => new OpenAIProvider(opts));
