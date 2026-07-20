import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildRunnerConfig } from './config.js';

// resolveIdleExitMs consults AGENTDESK_IDLE_EXIT_MS; isolate the tests from it.
let savedIdle: string | undefined;
beforeEach(() => {
  savedIdle = process.env.AGENTDESK_IDLE_EXIT_MS;
  delete process.env.AGENTDESK_IDLE_EXIT_MS;
});
afterEach(() => {
  if (savedIdle === undefined) delete process.env.AGENTDESK_IDLE_EXIT_MS;
  else process.env.AGENTDESK_IDLE_EXIT_MS = savedIdle;
});

describe('buildRunnerConfig (host→container container.json contract)', () => {
  it('parses a full container.json', () => {
    const cfg = buildRunnerConfig({
      provider: 'openai',
      assistantName: 'Frontdesk',
      groupName: 'Sales',
      agentGroupId: 'ag-1',
      memoryMode: 'gateway',
      a2aSessionMode: 'root-session',
      maxMessagesPerPrompt: 25,
      backendGateway: { baseUrl: 'https://erp.example', signingKey: 'k' },
      mcpServers: { custom: { command: 'node', args: ['x.js'], env: { A: '1' } } },
      idleExitMs: 60000,
    });
    expect(cfg.provider).toBe('openai');
    expect(cfg.agentGroupId).toBe('ag-1');
    expect(cfg.memoryMode).toBe('gateway');
    expect(cfg.a2aSessionMode).toBe('root-session');
    expect(cfg.maxMessagesPerPrompt).toBe(25);
    expect(cfg.backendGateway?.baseUrl).toBe('https://erp.example');
    expect(cfg.mcpServers.custom.command).toBe('node');
    expect(cfg.idleExitMs).toBe(60000);
  });

  it('applies defaults for an empty/missing config (corrupt or absent file)', () => {
    const cfg = buildRunnerConfig({});
    expect(cfg.provider).toBe('claude'); // default provider
    expect(cfg.assistantName).toBe('');
    expect(cfg.agentGroupId).toBe('');
    expect(cfg.memoryMode).toBeUndefined();
    expect(cfg.a2aSessionMode).toBeUndefined();
    expect(cfg.maxMessagesPerPrompt).toBe(10); // DEFAULT_MAX_MESSAGES
    expect(cfg.backendGateway).toBeUndefined();
    expect(cfg.mcpServers).toEqual({});
    expect(cfg.idleExitMs).toBe(0); // legacy "run until host-sweep kills me"
  });

  it('rejects invalid enum values rather than passing them through', () => {
    const cfg = buildRunnerConfig({ memoryMode: 'bogus', a2aSessionMode: 'nope' });
    expect(cfg.memoryMode).toBeUndefined();
    expect(cfg.a2aSessionMode).toBeUndefined();
  });

  it('AGENTDESK_IDLE_EXIT_MS env overrides the container.json value', () => {
    process.env.AGENTDESK_IDLE_EXIT_MS = '30000';
    expect(buildRunnerConfig({ idleExitMs: 5000 }).idleExitMs).toBe(30000);
  });

  it('parses a valid per-group confidenceThreshold and rejects out-of-range/garbage (roadmap 2.4)', () => {
    expect(buildRunnerConfig({ confidenceThreshold: 0.8 }).confidenceThreshold).toBe(0.8);
    expect(buildRunnerConfig({}).confidenceThreshold).toBeUndefined();
    // Out of (0,1) or non-numeric → undefined (falls back to the 0.70 default downstream).
    expect(buildRunnerConfig({ confidenceThreshold: 1 }).confidenceThreshold).toBeUndefined();
    expect(buildRunnerConfig({ confidenceThreshold: 0 }).confidenceThreshold).toBeUndefined();
    expect(buildRunnerConfig({ confidenceThreshold: 1.5 }).confidenceThreshold).toBeUndefined();
    expect(buildRunnerConfig({ confidenceThreshold: 'high' }).confidenceThreshold).toBeUndefined();
  });

  it('parses routing and execution roles with centralized policy defaults', () => {
    const cfg = buildRunnerConfig({
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
    });

    expect(cfg.llm?.routing).toEqual({
      enabled: true,
      provider: 'opencode-go',
      model: 'mimo-v2.5',
      transport: 'chat-completions',
      promptFile: 'prompts/frontdesk-routing.md',
      timeoutMs: 10_000,
      retryTimes: 1,
      context: { maxMessages: 4, maxChars: 12_000 },
      confidence: { threshold: 0.7, belowThresholdAction: 'clarify' },
      fallback: { action: 'clarify' },
    });
    expect(cfg.llm?.execution).toEqual({
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      transport: 'chat-completions',
    });
  });

  it('rejects an enabled routing config that cannot be enforced safely', () => {
    expect(() =>
      buildRunnerConfig({
        llm: { routing: { enabled: true, provider: 'opencode-go', model: '', promptFile: '../escape.md' } },
      }),
    ).toThrow(/routing/i);
  });

  it('fails closed on explicitly invalid routing transport and policy ranges', () => {
    const base = {
      enabled: true,
      provider: 'opencode-go',
      model: 'mimo-v2.5',
      promptFile: 'prompts/frontdesk-routing.md',
    };

    expect(() => buildRunnerConfig({ llm: { routing: { ...base, transport: 'bogus' } } })).toThrow(
      /routing\.transport/i,
    );
    expect(() => buildRunnerConfig({ llm: { routing: { ...base, retryTimes: 4 } } })).toThrow(/retryTimes/i);
    expect(() => buildRunnerConfig({ llm: { routing: { ...base, confidence: { threshold: 1.1 } } } })).toThrow(
      /confidence\.threshold/i,
    );
    expect(() => buildRunnerConfig({ llm: { routing: { ...base, fallback: { action: 'delegate' } } } })).toThrow(
      /fallback\.action/i,
    );
  });

  it('fails closed on an explicitly invalid execution transport', () => {
    expect(() =>
      buildRunnerConfig({
        llm: { execution: { provider: 'opencode-go', transport: 'bogus' } },
      }),
    ).toThrow(/execution\.transport/i);
  });

  it('keeps legacy single-provider behavior when llm routing is absent', () => {
    const cfg = buildRunnerConfig({ provider: 'claude' });
    expect(cfg.provider).toBe('claude');
    expect(cfg.llm).toBeUndefined();
  });
});
