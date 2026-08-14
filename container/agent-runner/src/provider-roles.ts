import type { RunnerConfig } from './config.js';

export interface ProviderRoleDescriptor {
  providerName: string;
  model?: string;
  toolMode: 'full' | 'none';
  envOverrides: Record<string, string>;
}

export interface ProviderRoles {
  execution: ProviderRoleDescriptor;
  routing?: ProviderRoleDescriptor;
}

function isOpenAiCompatible(providerName: string): boolean {
  return providerName === 'openai' || providerName === 'codex' || providerName === 'opencode-go';
}

function openAiOverrides(
  providerName: string,
  input: { model?: string; transport?: string; timeoutMs?: number; routing?: boolean },
): Record<string, string> {
  if (!isOpenAiCompatible(providerName)) return {};
  const out: Record<string, string> = {};
  if (input.model) out.OPENAI_MODEL = input.model;
  if (input.transport) out.OPENAI_FORCE_TRANSPORT = input.transport;
  if (input.timeoutMs !== undefined) out.OPENAI_TIMEOUT_MS = String(input.timeoutMs);
  // Routing orchestration owns retryTimes. One upstream transport request per
  // decision attempt prevents a hidden nested retry multiplier.
  if (input.routing) out.OPENAI_MAX_REQUEST_ATTEMPTS = '1';
  return out;
}

export function resolveProviderRoles(config: RunnerConfig, executionProviderOverride?: string): ProviderRoles {
  const executionConfig = config.llm?.execution;
  // Normalize provider names the same way the host does (it lowercases on its
  // side). Without this a mixed-case `provider: "OpenAI"` the host accepts flows
  // through verbatim to createProvider() and the container dies at boot with an
  // unknown-provider error.
  const configuredExecutionProvider = (executionConfig?.provider || config.provider)?.trim().toLowerCase();
  const normalizedOverride = executionProviderOverride?.trim().toLowerCase();
  const executionProvider = normalizedOverride || configuredExecutionProvider;
  const useConfiguredExecutionOptions = !normalizedOverride || normalizedOverride === configuredExecutionProvider;
  const executionModel = useConfiguredExecutionOptions ? executionConfig?.model : undefined;
  const executionTransport = useConfiguredExecutionOptions ? executionConfig?.transport : undefined;
  const roles: ProviderRoles = {
    execution: {
      providerName: executionProvider,
      model: executionModel,
      toolMode: 'full',
      envOverrides: openAiOverrides(executionProvider, {
        model: executionModel,
        transport: executionTransport,
      }),
    },
  };
  if (config.llm?.routing) {
    const routing = config.llm.routing;
    const routingProvider = routing.provider.trim().toLowerCase();
    roles.routing = {
      providerName: routingProvider,
      model: routing.model,
      toolMode: 'none',
      envOverrides: openAiOverrides(routingProvider, {
        model: routing.model,
        transport: routing.transport,
        timeoutMs: routing.timeoutMs,
        routing: true,
      }),
    };
  }
  return roles;
}
