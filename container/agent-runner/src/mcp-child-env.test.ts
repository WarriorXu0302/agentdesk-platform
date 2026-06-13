import { describe, expect, it } from 'bun:test';

import { buildMcpChildEnv, MCP_CHILD_ENV_KEYS } from './mcp-child-env.js';

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
