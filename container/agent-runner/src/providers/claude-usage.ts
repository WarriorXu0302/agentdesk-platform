/**
 * Build a usage ProviderEvent from a Claude Agent SDK `result` message
 * (ADR-0026 follow-up).
 *
 * The Claude provider previously emitted no `usage` event, so a Claude turn
 * produced an `agent.turn` (AGENT) span with NO child `provider.request` (LLM)
 * span — the documented observability gap for the default provider. The Agent
 * SDK aggregates a whole turn's LLM usage onto its terminal `result` message
 * (`usage` totals + per-model `modelUsage` + `duration_api_ms`), so we emit ONE
 * usage event per result. The poll loop turns each usage event into a
 * `provider.request` LLM span (one-span-per-usage-event, ADR-0026), so this
 * gives the Claude turn an LLM span carrying the turn's aggregate
 * tokens/latency. It is an AGGREGATE (the SDK may make several API calls within
 * a turn), not one span per API call — that is the finest granularity the SDK
 * exposes here, and it closes the "no LLM span at all" gap.
 *
 * Pure + isolated from the SDK import so it is unit-testable without spawning a
 * real query. Returns null when the SDK exposed no usage (older SDK / nothing
 * to report) — the poll loop simply skips a null/absent event.
 *
 * Metadata-only by design: Claude turn content (prompt/result) is already
 * captured on the `agent.turn` span by the poll loop (ADR-0027), so this LLM
 * span intentionally carries no `inputMessages`/`outputText`.
 */
import type { ProviderEvent } from './types.js';

type UsageEvent = Extract<ProviderEvent, { type: 'usage' }>;

/** The subset of an SDK result message this reads. Kept structural so it does
 *  not couple to the SDK's exact type and tolerates field drift. */
export interface ClaudeResultLike {
  usage?: unknown;
  modelUsage?: unknown;
  duration_ms?: unknown;
  duration_api_ms?: unknown;
}

function nonNegInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function claudeUsageEvent(message: ClaudeResultLike): UsageEvent | null {
  const usage = message.usage;
  const modelUsage = message.modelUsage;
  const hasUsage = !!usage && typeof usage === 'object';
  const hasModelUsage = !!modelUsage && typeof modelUsage === 'object';
  if (!hasUsage && !hasModelUsage) return null;

  const modelKeys = hasModelUsage ? Object.keys(modelUsage as Record<string, unknown>) : [];
  const model = modelKeys.length > 0 ? modelKeys.join('+') : 'claude';

  const u = (hasUsage ? usage : {}) as Record<string, unknown>;
  // Prompt tokens include the cache read/creation halves — they were all part
  // of the input the model processed.
  const inputTokens =
    nonNegInt(u.input_tokens) + nonNegInt(u.cache_read_input_tokens) + nonNegInt(u.cache_creation_input_tokens);
  const outputTokens = nonNegInt(u.output_tokens);
  const durationMs = nonNegInt(message.duration_api_ms) || nonNegInt(message.duration_ms);

  const event: UsageEvent = {
    type: 'usage',
    model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    transport: 'claude-agent-sdk',
  };
  if (durationMs > 0) event.durationMs = durationMs;
  return event;
}
