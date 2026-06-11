/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All platform-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

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

export interface RunnerConfig {
  provider: string;
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
}

const DEFAULT_MAX_MESSAGES = 10;

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

  _config = {
    provider: (raw.provider as string) || 'claude',
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
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
