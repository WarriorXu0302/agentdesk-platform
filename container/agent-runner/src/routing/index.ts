import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { RoutingLlmConfig, RoutingFallbackAction } from '../config.js';
import type { MessageInRow } from '../db/messages-in.js';
import type { DestinationEntry } from '../destinations.js';
import type { AgentProvider, ProviderEvent } from '../providers/types.js';

export type RoutingAction = 'delegate' | 'answer_self' | 'clarify' | 'reject';
export type RoutingFailureCode =
  | 'timeout'
  | 'transport_error'
  | 'http_error'
  | 'empty_output'
  | 'invalid_json'
  | 'schema_invalid'
  | 'unknown_target'
  | 'prompt_unavailable'
  | 'low_confidence';

export interface EnforcedRoutingDecision {
  id: string;
  action: RoutingAction;
  target?: string;
  targetAgentGroupId?: string;
  confidence: number;
  reason: string;
  source: 'routing_llm' | 'fallback';
  provider: string;
  model: string;
  promptHash: string;
  attempts: number;
  fallbackReason?: RoutingFailureCode;
}

export interface RoutingUsage {
  phase: 'routing';
  provider: string;
  model: string;
  attempt: number;
  decisionId: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  transport?: string;
}

const rawDecisionSchema = z.object({
  action: z.enum(['delegate', 'answer_self', 'clarify', 'reject']),
  target: z.string().trim().min(1).optional(),
  confidence: z.number().finite().min(0).max(1),
  reason: z.string().trim().min(1).max(500),
});

class RoutingAttemptError extends Error {
  constructor(
    readonly code: RoutingFailureCode,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
  }
}

function providerFailure(error: unknown, retryableOverride?: boolean): RoutingAttemptError {
  const message = error instanceof Error ? error.message : String(error || 'Routing provider transport failed');
  const statusMatch = message.match(/(?:http|status)[^0-9]*(\d{3})/i);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    const retryable =
      retryableOverride ?? (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500);
    return new RoutingAttemptError('http_error', message, retryable);
  }
  return new RoutingAttemptError('transport_error', message, retryableOverride ?? true);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function parseMessageContent(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { text: raw };
  }
}

function messageText(message: MessageInRow): string {
  const content = parseMessageContent(message.content);
  return typeof content.text === 'string' ? content.text : '';
}

function attachmentCount(messages: MessageInRow[]): number {
  let count = 0;
  for (const message of messages) {
    const content = parseMessageContent(message.content);
    if (Array.isArray(content.attachments)) count += content.attachments.length;
  }
  return count;
}

/** Build the entire tool-free user payload for the Routing model. */
export function buildRoutingContext(input: {
  messages: MessageInRow[];
  workers: DestinationEntry[];
  maxMessages: number;
  maxChars: number;
}): string {
  const chat = input.messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const anchor = chat.find((m) => m.trigger === 1) ?? chat.at(-1);
  let selected = chat.slice(-input.maxMessages);
  if (anchor && !selected.some((m) => m.id === anchor.id)) {
    const inputOrder = new Map(chat.map((message, index) => [message.id, index]));
    selected = [...selected.slice(1), anchor].sort((a, b) => (inputOrder.get(a.id) ?? 0) - (inputOrder.get(b.id) ?? 0));
  }

  const workerLines = input.workers
    .filter((worker) => worker.type === 'agent')
    .map((worker) => `    <worker name="${escapeXml(worker.name)}" display_name="${escapeXml(worker.displayName)}" />`);
  const timezone = escapeXml(process.env.TZ?.trim() || 'UTC');

  const suffix = ['  </messages>', '</routing_request>'];
  const marker = '<truncated />';
  const views = selected.map((msg) => {
    const sender = parseMessageContent(msg.content).sender;
    return {
      msg,
      sender: escapeXml(typeof sender === 'string' ? sender : 'Unknown'),
      originalText: escapeXml(messageText(msg)),
      visibleText: escapeXml(messageText(msg)),
      truncated: false,
      anchor: msg.id === anchor?.id,
    };
  });

  const render = (): string => {
    const prefix = [
      '<routing_request version="1">',
      `  <metadata timezone="${timezone}" input_kind="chat" message_count="${views.length}" attachment_count="${attachmentCount(views.map((view) => view.msg))}" />`,
      '  <workers>',
      ...workerLines,
      '  </workers>',
      '  <messages>',
    ];
    const lines = views.map(
      (view) => `    <message sender="${view.sender}">${view.visibleText}${view.truncated ? marker : ''}</message>`,
    );
    return [...prefix, ...lines, ...suffix].join('\n');
  };

  let rendered = render();
  // Remove the oldest accumulated rows first, but retain the newest
  // non-anchor row so it can be truncated rather than disappearing entirely.
  while (rendered.length > input.maxChars) {
    const nonAnchorIndexes = views.flatMap((view, index) => (!view.anchor ? [index] : []));
    if (nonAnchorIndexes.length <= 1) break;
    views.splice(nonAnchorIndexes[0]!, 1);
    rendered = render();
  }

  const truncate = (index: number): void => {
    const view = views[index]!;
    const excess = render().length - input.maxChars;
    if (excess <= 0 || view.visibleText.length === 0) return;
    const markerCost = view.truncated ? 0 : marker.length;
    const keep = Math.max(0, view.visibleText.length - excess - markerCost);
    view.visibleText = view.visibleText.slice(0, keep);
    view.truncated = true;
  };

  if (rendered.length > input.maxChars) {
    const oldestNonAnchor = views.findIndex((view) => !view.anchor);
    if (oldestNonAnchor >= 0) {
      truncate(oldestNonAnchor);
      rendered = render();
    }
  }

  if (rendered.length > input.maxChars) {
    const anchorIndex = views.findIndex((view) => view.anchor);
    if (anchorIndex >= 0) {
      truncate(anchorIndex);
      rendered = render();
    }
  }

  // If structural overhead plus the truncation marker still exceeds the hard
  // ceiling, drop the remaining non-anchor row and spend the budget on the
  // anchor. Config validation keeps maxChars >= 1000, so normal prompts retain
  // substantial anchor content and always return well-formed XML.
  if (rendered.length > input.maxChars) {
    const nonAnchorIndex = views.findIndex((view) => !view.anchor);
    if (nonAnchorIndex >= 0) {
      views.splice(nonAnchorIndex, 1);
      rendered = render();
      const anchorIndex = views.findIndex((view) => view.anchor);
      if (rendered.length > input.maxChars && anchorIndex >= 0) {
        truncate(anchorIndex);
        rendered = render();
      }
    }
  }

  if (rendered.length > input.maxChars) {
    throw new RoutingAttemptError('schema_invalid', 'Routing context structural metadata exceeds maxChars', false);
  }

  return rendered;
}

export function loadRoutingPrompt(agentRoot: string, relativePath: string): { text: string; hash: string } {
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/'));
  if (
    path.isAbsolute(relativePath) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    !normalized.startsWith('prompts/')
  ) {
    throw new RoutingAttemptError('prompt_unavailable', 'Routing prompt must stay inside prompts/', false);
  }
  const promptsRoot = fs.realpathSync(path.join(agentRoot, 'prompts'));
  const filePath = fs.realpathSync(path.join(agentRoot, normalized));
  if (filePath !== promptsRoot && !filePath.startsWith(`${promptsRoot}${path.sep}`)) {
    throw new RoutingAttemptError('prompt_unavailable', 'Routing prompt escaped prompts/', false);
  }
  const bytes = fs.readFileSync(filePath);
  if (bytes.length === 0 || bytes.length > 64 * 1024) {
    throw new RoutingAttemptError('prompt_unavailable', 'Routing prompt must be between 1 byte and 64 KiB', false);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RoutingAttemptError('prompt_unavailable', 'Routing prompt must be valid UTF-8', false);
  }
  if (!text.trim()) throw new RoutingAttemptError('prompt_unavailable', 'Routing prompt is empty', false);
  return { text, hash: createHash('sha256').update(bytes).digest('hex') };
}

function parseDecision(
  text: string,
  workers: DestinationEntry[],
): {
  action: RoutingAction;
  target?: string;
  targetAgentGroupId?: string;
  confidence: number;
  reason: string;
} {
  const cleaned = text
    .trim()
    .replace(/^<think>[\s\S]*?<\/think>\s*/i, '')
    .trim();
  if (!cleaned) throw new RoutingAttemptError('empty_output', 'Routing model returned no output');
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    throw new RoutingAttemptError('invalid_json', 'Routing model returned invalid JSON');
  }
  const parsed = rawDecisionSchema.safeParse(json);
  if (!parsed.success) throw new RoutingAttemptError('schema_invalid', 'Routing output failed schema validation');
  if (parsed.data.action !== 'delegate') {
    return {
      action: parsed.data.action,
      confidence: parsed.data.confidence,
      reason: parsed.data.reason,
    };
  }
  if (!parsed.data.target) throw new RoutingAttemptError('schema_invalid', 'delegate requires target');
  const worker = workers.find((candidate) => candidate.type === 'agent' && candidate.name === parsed.data.target);
  if (!worker?.agentGroupId) throw new RoutingAttemptError('unknown_target', 'delegate target is not a live worker');
  return {
    action: 'delegate',
    target: worker.name,
    targetAgentGroupId: worker.agentGroupId,
    confidence: parsed.data.confidence,
    reason: parsed.data.reason,
  };
}

async function queryOnce(input: {
  provider: AgentProvider;
  prompt: string;
  instructions: string;
  cwd: string;
  timeoutMs: number;
  attempt: number;
  config: RoutingLlmConfig;
  decisionId: string;
}): Promise<{ text: string; usages: RoutingUsage[] }> {
  const query = input.provider.query({
    prompt: input.prompt,
    cwd: input.cwd,
    systemContext: { instructions: input.instructions },
  });
  const usages: RoutingUsage[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const consume = async (): Promise<string> => {
    try {
      for await (const event of query.events) {
        if (event.type === 'usage') {
          usages.push({
            phase: 'routing',
            provider: input.config.provider,
            model: event.model || input.config.model,
            attempt: input.attempt,
            decisionId: input.decisionId,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            totalTokens: event.totalTokens,
            durationMs: event.durationMs,
            transport: event.transport,
          });
        }
        if (event.type === 'error') throw providerFailure(event.message, event.retryable);
        if (event.type === 'result') return event.text ?? '';
      }
    } catch (error) {
      if (error instanceof RoutingAttemptError) throw error;
      throw providerFailure(error);
    }
    return '';
  };
  try {
    return {
      text: await Promise.race([
        consume(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            query.abort();
            reject(new RoutingAttemptError('timeout', `Routing request timed out after ${input.timeoutMs}ms`));
          }, input.timeoutMs);
        }),
      ]),
      usages,
    };
  } finally {
    if (timer) clearTimeout(timer);
    query.end();
  }
}

function fallbackDecision(input: {
  id: string;
  action: RoutingFallbackAction;
  provider: string;
  model: string;
  promptHash: string;
  attempts: number;
  code: RoutingFailureCode;
  confidence?: number;
}): EnforcedRoutingDecision {
  return {
    id: input.id,
    action: input.action,
    confidence: input.confidence ?? 0,
    reason: input.code === 'low_confidence' ? 'low_confidence' : 'routing_unavailable',
    source: 'fallback',
    provider: input.provider,
    model: input.model,
    promptHash: input.promptHash,
    attempts: input.attempts,
    fallbackReason: input.code,
  };
}

export async function routeFrontdeskTurn(input: {
  provider: AgentProvider;
  config: RoutingLlmConfig;
  agentRoot: string;
  messages: MessageInRow[];
  getWorkers: () => DestinationEntry[];
}): Promise<{ decision: EnforcedRoutingDecision; usages: RoutingUsage[] }> {
  const decisionId = `route-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const maxAttempts = input.config.retryTimes + 1;
  const usages: RoutingUsage[] = [];
  let lastCode: RoutingFailureCode = 'transport_error';
  let lastPromptHash = '';
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      const loaded = loadRoutingPrompt(input.agentRoot, input.config.promptFile);
      lastPromptHash = loaded.hash;
      const workers = input.getWorkers();
      const prompt = buildRoutingContext({
        messages: input.messages,
        workers,
        maxMessages: input.config.context.maxMessages,
        maxChars: input.config.context.maxChars,
      });
      const result = await queryOnce({
        provider: input.provider,
        prompt,
        instructions: loaded.text,
        cwd: input.agentRoot,
        timeoutMs: input.config.timeoutMs,
        attempt,
        config: input.config,
        decisionId,
      });
      usages.push(...result.usages);
      const parsed = parseDecision(result.text, workers);
      if (parsed.action === 'delegate' && parsed.confidence < input.config.confidence.threshold) {
        return {
          decision: fallbackDecision({
            id: decisionId,
            action: input.config.confidence.belowThresholdAction,
            provider: input.config.provider,
            model: input.config.model,
            promptHash: loaded.hash,
            attempts: attempt,
            code: 'low_confidence',
            confidence: parsed.confidence,
          }),
          usages,
        };
      }
      return {
        decision: {
          id: decisionId,
          ...parsed,
          source: 'routing_llm',
          provider: input.config.provider,
          model: input.config.model,
          promptHash: loaded.hash,
          attempts: attempt,
        },
        usages,
      };
    } catch (error) {
      if (error instanceof RoutingAttemptError) {
        lastCode = error.code;
        if (!error.retryable) break;
      } else {
        lastCode = 'prompt_unavailable';
        break;
      }
    }
  }

  return {
    decision: fallbackDecision({
      id: decisionId,
      action: input.config.fallback.action,
      provider: input.config.provider,
      model: input.config.model,
      promptHash: lastPromptHash,
      attempts,
      code: lastCode,
    }),
    usages,
  };
}

export function isRoutingUsage(event: ProviderEvent): event is Extract<ProviderEvent, { type: 'usage' }> {
  return event.type === 'usage';
}
