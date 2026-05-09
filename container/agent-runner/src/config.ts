/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All FrontLane-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface EnterpriseGatewayConfig {
  baseUrl: string;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
}

export type MemoryMode = 'workspace' | 'erp';
export type A2aSessionMode = 'agent-shared' | 'root-session';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  memoryMode?: MemoryMode;
  a2aSessionMode?: A2aSessionMode;
  maxMessagesPerPrompt: number;
  enterpriseGateway?: EnterpriseGatewayConfig;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

const DEFAULT_MAX_MESSAGES = 10;

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
    memoryMode: raw.memoryMode === 'workspace' || raw.memoryMode === 'erp' ? raw.memoryMode : undefined,
    a2aSessionMode:
      raw.a2aSessionMode === 'agent-shared' || raw.a2aSessionMode === 'root-session' ? raw.a2aSessionMode : undefined,
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    enterpriseGateway: raw.enterpriseGateway as EnterpriseGatewayConfig | undefined,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
