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
] as const;

function buildOpenAIContribution(): ProviderContainerContribution {
  const dotenv = readEnvFile([...OPENAI_ENV_KEYS]);
  const env: Record<string, string> = {};
  for (const key of OPENAI_ENV_KEYS) {
    const value = dotenv[key];
    if (value) env[key] = value;
  }
  return { env };
}

registerProviderContainerConfig('openai', buildOpenAIContribution);
registerProviderContainerConfig('codex', buildOpenAIContribution);
