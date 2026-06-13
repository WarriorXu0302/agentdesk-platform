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
});
