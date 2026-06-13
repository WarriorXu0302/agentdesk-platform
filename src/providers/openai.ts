/**
 * OpenAI-compatible provider container config.
 *
 * By default this provider forwards its API credentials directly into the
 * container environment so the container-side runner can call an
 * OpenAI-compatible Responses API endpoint — simple, but the key is readable
 * by an injected agent. With `AGENTDESK_OPENAI_VIA_ONECLI=true` (ADR-0035) the
 * key is instead withheld from the container and the host routes the provider's
 * requests through the OneCLI vault (which already does credential injection
 * for the Claude provider), so the key never enters the container.
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

/**
 * Route the OpenAI/codex provider's traffic through the OneCLI vault instead of
 * handing it the API key directly (ADR-0035). Default OFF. Resolution: process
 * env → `.env`, read lazily so tests can drive it.
 */
export function openaiViaOneCliEnabled(): boolean {
  const fromProc = process.env.AGENTDESK_OPENAI_VIA_ONECLI;
  if (fromProc !== undefined) return fromProc.trim().toLowerCase() === 'true';
  const dotenv = readEnvFile(['AGENTDESK_OPENAI_VIA_ONECLI']);
  return (dotenv.AGENTDESK_OPENAI_VIA_ONECLI ?? '').trim().toLowerCase() === 'true';
}

export function buildOpenAIContribution(): ProviderContainerContribution {
  const viaVault = openaiViaOneCliEnabled();
  const dotenv = readEnvFile([...OPENAI_ENV_KEYS]);
  const env: Record<string, string> = {};
  for (const key of OPENAI_ENV_KEYS) {
    // Vault mode: the API key must NOT enter the container — the OneCLI vault
    // injects the Authorization header on the wire (ADR-0035). Everything else
    // (base url, model, timeouts) still rides along.
    if (viaVault && key === 'OPENAI_API_KEY') continue;
    const value = dotenv[key] || process.env[key];
    if (value) env[key] = value;
  }
  // Tell the container-side provider it is in vault mode: require no key and
  // send no Authorization header of its own (the vault adds it).
  if (viaVault) env.OPENAI_CREDENTIAL_VIA_PROXY = 'true';
  return { env };
}

registerProviderContainerConfig('openai', buildOpenAIContribution);
registerProviderContainerConfig('codex', buildOpenAIContribution);
// 'sdk-openai' removed with its container provider — see ADR-0024.
