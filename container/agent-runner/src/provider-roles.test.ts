import { describe, expect, it } from 'bun:test';

import { buildRunnerConfig } from './config.js';
import { resolveProviderRoles } from './provider-roles.js';

describe('provider role resolution', () => {
  it('keeps exactly one legacy execution role when routing is absent', () => {
    const roles = resolveProviderRoles(buildRunnerConfig({ provider: 'claude' }));
    expect(roles.execution).toEqual({ providerName: 'claude', envOverrides: {}, toolMode: 'full' });
    expect(roles.routing).toBeUndefined();
  });

  it('resolves independent models and transport for routing and execution', () => {
    const roles = resolveProviderRoles(
      buildRunnerConfig({
        provider: 'openai',
        llm: {
          routing: {
            enabled: true,
            provider: 'opencode-go',
            model: 'mimo-v2.5',
            transport: 'chat-completions',
            promptFile: 'prompts/frontdesk-routing.md',
          },
          execution: {
            provider: 'opencode-go',
            model: 'deepseek-v4-flash',
            transport: 'chat-completions',
          },
        },
      }),
    );
    expect(roles.execution).toEqual({
      providerName: 'opencode-go',
      model: 'deepseek-v4-flash',
      toolMode: 'full',
      envOverrides: {
        OPENAI_MODEL: 'deepseek-v4-flash',
        OPENAI_FORCE_TRANSPORT: 'chat-completions',
      },
    });
    expect(roles.routing).toEqual({
      providerName: 'opencode-go',
      model: 'mimo-v2.5',
      toolMode: 'none',
      envOverrides: {
        OPENAI_MODEL: 'mimo-v2.5',
        OPENAI_FORCE_TRANSPORT: 'chat-completions',
        OPENAI_TIMEOUT_MS: '10000',
        OPENAI_MAX_REQUEST_ATTEMPTS: '1',
      },
    });
  });

  it('supports Claude independently in both routing and execution roles', () => {
    const roles = resolveProviderRoles(
      buildRunnerConfig({
        provider: 'claude',
        llm: {
          routing: {
            enabled: true,
            provider: 'claude',
            model: 'claude-haiku-routing',
            promptFile: 'prompts/frontdesk-routing.md',
          },
          execution: { provider: 'claude', model: 'claude-opus-execution' },
        },
      }),
    );
    expect(roles.routing).toMatchObject({
      providerName: 'claude',
      model: 'claude-haiku-routing',
      toolMode: 'none',
      envOverrides: {},
    });
    expect(roles.execution).toMatchObject({
      providerName: 'claude',
      model: 'claude-opus-execution',
      toolMode: 'full',
      envOverrides: {},
    });
  });

  it('honors a host-resolved Execution provider override and drops incompatible model settings', () => {
    const roles = resolveProviderRoles(
      buildRunnerConfig({
        provider: 'openai',
        llm: {
          routing: {
            enabled: true,
            provider: 'opencode-go',
            model: 'mimo-v2.5',
            promptFile: 'prompts/frontdesk-routing.md',
          },
          execution: {
            provider: 'opencode-go',
            model: 'deepseek-v4-flash',
            transport: 'chat-completions',
          },
        },
      }),
      'claude',
    );

    expect(roles.execution).toEqual({
      providerName: 'claude',
      model: undefined,
      toolMode: 'full',
      envOverrides: {},
    });
    expect(roles.routing?.providerName).toBe('opencode-go');
  });
});
