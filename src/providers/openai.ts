/**
 * OpenAI-compatible provider container config.
 *
 * This provider currently forwards its API credentials directly into the
 * container environment so the container-side runner can call an
 * OpenAI-compatible Responses API endpoint. This is less strict than the
 * Claude + OneCLI flow, but keeps local enterprise deployments simple while
 * we are still bootstrapping the reusable provider baseline.
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig, type ProviderContainerContribution } from './provider-container-registry.js';

const OPENAI_ENV_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_REASONING_EFFORT',
  'OPENAI_TIMEOUT_MS',
  // Summary-based context compaction (ADR-0024). Optional; the container
  // falls back to OPENAI_MODEL / archiving-off when unset.
  'OPENAI_COMPACT_MODEL',
  'OPENAI_COMPACT_ARCHIVE',
] as const;

function buildOpenAIContribution(): ProviderContainerContribution {
  const dotenv = readEnvFile([...OPENAI_ENV_KEYS]);
  const env: Record<string, string> = {};
  for (const key of OPENAI_ENV_KEYS) {
    const value = dotenv[key] || process.env[key];
    if (value) env[key] = value;
  }
  return { env };
}

registerProviderContainerConfig('openai', buildOpenAIContribution);
registerProviderContainerConfig('codex', buildOpenAIContribution);
// 'sdk-openai' removed with its container provider — see ADR-0024.
