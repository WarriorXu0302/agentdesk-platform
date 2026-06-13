import { describe, expect, it } from 'bun:test';

import { buildMcpChildEnv, buildMcpServersConfig, MCP_CHILD_ENV_KEYS } from './mcp-child-env.js';

describe('buildMcpChildEnv (ADR-0034 signing-proxy + ADR-0026/0027 trace passthrough)', () => {
  it('forwards the signing-proxy vars so proxy mode actually engages in the MCP child', () => {
    // Regression for the critical: the gateway tools run in a SEPARATE MCP child
    // that does not inherit the parent env. If these keys are not forwarded,
    // getSigningProxyTarget() sees nothing and proxy mode silently never runs.
    expect(MCP_CHILD_ENV_KEYS).toContain('AGENTDESK_GATEWAY_PROXY_URL');
    expect(MCP_CHILD_ENV_KEYS).toContain('AGENTDESK_GATEWAY_PROXY_TOKEN');

    const env = buildMcpChildEnv({
      AGENTDESK_GATEWAY_PROXY_URL: 'http://host.docker.internal:8799',
      AGENTDESK_GATEWAY_PROXY_TOKEN: 'jti.sekret',
      UNRELATED_SECRET: 'must-not-pass',
    } as NodeJS.ProcessEnv);

    expect(env.AGENTDESK_GATEWAY_PROXY_URL).toBe('http://host.docker.internal:8799');
    expect(env.AGENTDESK_GATEWAY_PROXY_TOKEN).toBe('jti.sekret');
    // Only allowlisted keys pass through.
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });

  it('still forwards the OTel trace-bridge vars', () => {
    const env = buildMcpChildEnv({ OTEL_TRACEPARENT: 'tp', BRAND_NAMESPACE: 'agentdesk' } as NodeJS.ProcessEnv);
    expect(env.OTEL_TRACEPARENT).toBe('tp');
    expect(env.BRAND_NAMESPACE).toBe('agentdesk');
  });

  it('omits unset keys (no empty-string injection)', () => {
    expect(Object.keys(buildMcpChildEnv({} as NodeJS.ProcessEnv))).toHaveLength(0);
  });
});

describe('buildMcpServersConfig', () => {
  const ENV = {
    AGENTDESK_GATEWAY_PROXY_URL: 'http://host.docker.internal:8799',
    AGENTDESK_GATEWAY_PROXY_TOKEN: 'jti.sekret',
    OTEL_TRACEPARENT: 'tp',
    UNRELATED: 'no',
  } as NodeJS.ProcessEnv;

  it("the built-in server's env carries the passthrough (== buildMcpChildEnv), not the raw parent env", () => {
    const servers = buildMcpServersConfig(ENV, 'agentdesk', '/app/src/mcp-tools/index.ts', {});
    const builtin = servers['agentdesk'];
    expect(builtin.command).toBe('bun');
    expect(builtin.args).toEqual(['run', '/app/src/mcp-tools/index.ts']);
    // The exact wiring whose absence made the ADR-0034 proxy vars never reach
    // the tools process: the built-in server env MUST equal the allowlist.
    expect(builtin.env).toEqual(buildMcpChildEnv(ENV));
    expect(builtin.env.AGENTDESK_GATEWAY_PROXY_URL).toBe('http://host.docker.internal:8799');
    expect(builtin.env.AGENTDESK_GATEWAY_PROXY_TOKEN).toBe('jti.sekret');
    expect(builtin.env.UNRELATED).toBeUndefined();
  });

  it('merges container.json servers alongside the built-in', () => {
    const servers = buildMcpServersConfig(ENV, 'agentdesk', '/p', {
      custom: { command: 'node', args: ['x.js'], env: { FOO: 'bar' } },
    });
    expect(Object.keys(servers).sort()).toEqual(['agentdesk', 'custom']);
    expect(servers['custom']).toEqual({ command: 'node', args: ['x.js'], env: { FOO: 'bar' } });
  });
});
