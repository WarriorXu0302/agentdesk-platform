/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All platform-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';
import path from 'path';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface BackendGatewayConfig {
  baseUrl: string;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
  signingKey?: string;
  signingHeaders?: {
    timestamp?: string;
    nonce?: string;
    signature?: string;
  };
}

export type MemoryMode = 'workspace' | 'gateway';
export type A2aSessionMode = 'agent-shared' | 'root-session';
export type LlmTransport = 'responses' | 'chat-completions';
export type RoutingFallbackAction = 'clarify' | 'reject';

export interface RoutingLlmConfig {
  enabled: true;
  provider: string;
  model: string;
  transport: LlmTransport;
  promptFile: string;
  timeoutMs: number;
  retryTimes: number;
  context: { maxMessages: number; maxChars: number };
  confidence: { threshold: number; belowThresholdAction: RoutingFallbackAction };
  fallback: { action: RoutingFallbackAction };
}

export interface ExecutionLlmConfig {
  provider: string;
  model?: string;
  transport?: LlmTransport;
}

export interface DualLlmConfig {
  routing?: RoutingLlmConfig;
  execution?: ExecutionLlmConfig;
}

export interface RunnerConfig {
  provider: string;
  llm?: DualLlmConfig;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  memoryMode?: MemoryMode;
  a2aSessionMode?: A2aSessionMode;
  maxMessagesPerPrompt: number;
  backendGateway?: BackendGatewayConfig;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  /**
   * Idle exit window in milliseconds. When > 0, the poll loop exits cleanly
   * after this many ms without a trigger-eligible pending message — freeing
   * the container's memory for other sessions. When 0 (default) the
   * container stays alive until the host-sweep absolute ceiling kills it
   * (30 min), which preserves the pre-change behavior.
   */
  idleExitMs: number;
  /**
   * Per-group classify_intent clarify threshold (roadmap 2.4). Below this
   * confidence, classify_intent's advisory tells the frontdesk to clarify
   * before delegating. Optional; unset = the platform default (0.70). Lets a
   * stricter group (finance) demand higher confidence and a looser one
   * (general support) accept lower — without baking any business rule into the
   * core. Must be in (0, 1); out-of-range values fall back to the default.
   */
  confidenceThreshold?: number;
}

const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_ROUTING_TIMEOUT_MS = 10_000;
const DEFAULT_ROUTING_RETRY_TIMES = 1;
const DEFAULT_ROUTING_MAX_MESSAGES = 4;
const DEFAULT_ROUTING_MAX_CHARS = 12_000;
const DEFAULT_ROUTING_CONFIDENCE = 0.7;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function fallbackAction(
  value: unknown,
  field: string,
  fallback: RoutingFallbackAction = 'clarify',
): RoutingFallbackAction {
  if (value === undefined) return fallback;
  if (value !== 'clarify' && value !== 'reject') {
    throw new Error(`${field} must be clarify or reject`);
  }
  return value;
}

function safeRoutingPromptFile(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('llm.routing.promptFile is required');
  const trimmed = value.trim();
  if (path.isAbsolute(trimmed)) throw new Error('llm.routing.promptFile must be relative');
  const normalized = path.posix.normalize(trimmed.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../') || !normalized.startsWith('prompts/')) {
    throw new Error('llm.routing.promptFile must stay inside prompts/');
  }
  return normalized;
}

function buildDualLlmConfig(value: unknown): DualLlmConfig | undefined {
  if (!isRecord(value)) return undefined;
  const out: DualLlmConfig = {};

  if (isRecord(value.execution)) {
    const provider = typeof value.execution.provider === 'string' ? value.execution.provider.trim() : '';
    if (provider) {
      const model = typeof value.execution.model === 'string' ? value.execution.model.trim() : '';
      const transport = value.execution.transport;
      if (transport !== undefined && transport !== 'responses' && transport !== 'chat-completions') {
        throw new Error('llm.execution.transport must be responses or chat-completions');
      }
      out.execution = {
        provider,
        ...(model ? { model } : {}),
        ...(transport === 'responses' || transport === 'chat-completions' ? { transport } : {}),
      };
    }
  }

  if (isRecord(value.routing) && value.routing.enabled === true) {
    const provider = typeof value.routing.provider === 'string' ? value.routing.provider.trim() : '';
    const model = typeof value.routing.model === 'string' ? value.routing.model.trim() : '';
    if (!provider) throw new Error('llm.routing.provider is required when routing is enabled');
    if (!model) throw new Error('llm.routing.model is required when routing is enabled');
    const context = isRecord(value.routing.context) ? value.routing.context : {};
    const confidence = isRecord(value.routing.confidence) ? value.routing.confidence : {};
    const fallback = isRecord(value.routing.fallback) ? value.routing.fallback : {};
    const threshold = confidence.threshold ?? DEFAULT_ROUTING_CONFIDENCE;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new Error('llm.routing.confidence.threshold must be a finite number in [0, 1]');
    }
    const transport = value.routing.transport;
    if (transport !== undefined && transport !== 'responses' && transport !== 'chat-completions') {
      throw new Error('llm.routing.transport must be responses or chat-completions');
    }
    out.routing = {
      enabled: true,
      provider,
      model,
      transport: transport === 'responses' || transport === 'chat-completions' ? transport : 'chat-completions',
      promptFile: safeRoutingPromptFile(value.routing.promptFile),
      timeoutMs: boundedInteger(
        value.routing.timeoutMs,
        DEFAULT_ROUTING_TIMEOUT_MS,
        1000,
        120_000,
        'llm.routing.timeoutMs',
      ),
      retryTimes: boundedInteger(value.routing.retryTimes, DEFAULT_ROUTING_RETRY_TIMES, 0, 3, 'llm.routing.retryTimes'),
      context: {
        maxMessages: boundedInteger(
          context.maxMessages,
          DEFAULT_ROUTING_MAX_MESSAGES,
          1,
          10,
          'llm.routing.context.maxMessages',
        ),
        maxChars: boundedInteger(
          context.maxChars,
          DEFAULT_ROUTING_MAX_CHARS,
          1000,
          50_000,
          'llm.routing.context.maxChars',
        ),
      },
      confidence: {
        threshold,
        belowThresholdAction: fallbackAction(
          confidence.belowThresholdAction,
          'llm.routing.confidence.belowThresholdAction',
        ),
      },
      fallback: { action: fallbackAction(fallback.action, 'llm.routing.fallback.action') },
    };
  }

  return out.routing || out.execution ? out : undefined;
}

function resolveIdleExitMs(configValue: unknown): number {
  const envRaw = process.env.AGENTDESK_IDLE_EXIT_MS?.trim();
  if (envRaw) {
    const env = Number(envRaw);
    if (Number.isFinite(env) && env >= 0) return Math.floor(env);
  }
  if (typeof configValue === 'number' && Number.isFinite(configValue) && configValue >= 0) {
    return Math.floor(configValue);
  }
  return 0;
}

let _config: RunnerConfig | null = null;

/**
 * Build a RunnerConfig from the raw parsed container.json object, applying
 * defaults for every missing/invalid field. Pure + exported so the host→
 * container config contract (the RO-mounted container.json the runner reads)
 * is unit-testable without touching the filesystem or the loadConfig cache.
 */
export function buildRunnerConfig(raw: Record<string, unknown>): RunnerConfig {
  return {
    provider: (raw.provider as string) || 'claude',
    llm: buildDualLlmConfig(raw.llm),
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    memoryMode: raw.memoryMode === 'workspace' || raw.memoryMode === 'gateway' ? raw.memoryMode : undefined,
    a2aSessionMode:
      raw.a2aSessionMode === 'agent-shared' || raw.a2aSessionMode === 'root-session' ? raw.a2aSessionMode : undefined,
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    backendGateway: raw.backendGateway as BackendGatewayConfig | undefined,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    // idleExitMs: container.json may set it per group; AGENTDESK_IDLE_EXIT_MS
    // is the override hatch (takes precedence so operators can flip it on
    // without a config edit + rebuild). 0 keeps the legacy "run until
    // host-sweep kills me" behavior.
    idleExitMs: resolveIdleExitMs(raw.idleExitMs),
    confidenceThreshold:
      typeof raw.confidenceThreshold === 'number' &&
      Number.isFinite(raw.confidenceThreshold) &&
      raw.confidenceThreshold > 0 &&
      raw.confidenceThreshold < 1
        ? raw.confidenceThreshold
        : undefined,
  };
}

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = buildRunnerConfig(raw);
  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
