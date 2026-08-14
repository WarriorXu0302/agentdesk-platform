import { describe, expect, it } from 'bun:test';

import { buildClaudeRoleOptions } from './claude.js';

describe('Claude role options', () => {
  it('builds a model-specific tool-free Routing query surface', () => {
    expect(
      buildClaudeRoleOptions({
        toolMode: 'none',
        model: 'claude-haiku-routing',
        instructions: 'routing prompt',
        mcpServers: { ignored: { command: 'node', args: [], env: {} } },
      }),
    ).toEqual({
      model: 'claude-haiku-routing',
      systemPrompt: 'routing prompt',
      tools: [],
      allowedTools: [],
      mcpServers: {},
      settingSources: [],
      maxTurns: 1,
    });
  });

  it('preserves the existing Claude execution tool surface', () => {
    const options = buildClaudeRoleOptions({
      toolMode: 'full',
      model: 'claude-opus-execution',
      instructions: 'execution prompt',
      mcpServers: { custom: { command: 'node', args: [], env: {} } },
    });
    expect(options.model).toBe('claude-opus-execution');
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'execution prompt' });
    expect(options.allowedTools).toContain('Bash');
    expect(options.allowedTools).toContain('mcp__custom__*');
    expect(options.mcpServers).toHaveProperty('custom');
    expect(options.settingSources).toEqual(['project', 'user']);
  });
});
