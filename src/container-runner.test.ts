import { describe, expect, it } from 'vitest';

import { buildRunnerTracingEnvArgs, checkBaseImage, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('checkBaseImage', () => {
  it('inspects the wake-path image (namespace + agent-v2 + install slug) and passes when present', () => {
    const inspected: string[] = [];
    const result = checkBaseImage((image) => {
      inspected.push(image);
      return true;
    });
    expect(result).toBe(true);
    expect(inspected).toHaveLength(1);
    // Same constant the wake path resolves (config CONTAINER_IMAGE), not a
    // second hand-rolled construction — assert the derived shape only, since
    // namespace and slug vary per environment.
    expect(inspected[0]).toMatch(/^[a-z0-9-]+-agent-v2-[0-9a-f]{8}:latest$/);
  });

  it('returns false without throwing when the image is missing (non-fatal precheck)', () => {
    expect(checkBaseImage(() => false)).toBe(false);
  });
});

describe('buildRunnerTracingEnvArgs (ADR-0026 endpoint injection)', () => {
  const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

  function envArgsToMap(args: string[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-e') {
        const [key, ...rest] = args[i + 1].split('=');
        map[key] = rest.join('=');
      }
    }
    return map;
  }

  it('injects traceparent + rewrites localhost endpoint to host.docker.internal', () => {
    const args = buildRunnerTracingEnvArgs(
      { traceparent: TRACEPARENT },
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:6006/v1/traces' },
    );
    const env = envArgsToMap(args);
    expect(env.OTEL_TRACEPARENT).toBe(TRACEPARENT);
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('http://host.docker.internal:6006/v1/traces');
  });

  it('defaults the endpoint and rewrites it when host env is unset', () => {
    const args = buildRunnerTracingEnvArgs({ traceparent: TRACEPARENT }, {});
    const env = envArgsToMap(args);
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('http://host.docker.internal:6006/v1/traces');
  });

  it('rewrites 127.0.0.1 too and preserves non-loopback hosts', () => {
    expect(
      envArgsToMap(
        buildRunnerTracingEnvArgs(
          { traceparent: TRACEPARENT },
          { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:6006/v1/traces' },
        ),
      ).OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    ).toBe('http://host.docker.internal:6006/v1/traces');

    expect(
      envArgsToMap(
        buildRunnerTracingEnvArgs(
          { traceparent: TRACEPARENT },
          { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://phoenix.internal:6006/v1/traces' },
        ),
      ).OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    ).toBe('http://phoenix.internal:6006/v1/traces');
  });

  it('injects nothing trace-related when the host has no active trace (no-op runner)', () => {
    expect(buildRunnerTracingEnvArgs({}, {})).toEqual([]);
  });

  it('forwards OTEL_SDK_DISABLED verbatim even without a traceparent', () => {
    expect(buildRunnerTracingEnvArgs({}, { OTEL_SDK_DISABLED: 'true' })).toEqual(['-e', 'OTEL_SDK_DISABLED=true']);
  });

  it('passes tracestate through when present', () => {
    const env = envArgsToMap(buildRunnerTracingEnvArgs({ traceparent: TRACEPARENT, tracestate: 'foo=bar' }, {}));
    expect(env.OTEL_TRACESTATE).toBe('foo=bar');
  });

  it('forwards OTEL_CAPTURE_CONTENT into the container when the host opted in (ADR-0027)', () => {
    const env = envArgsToMap(buildRunnerTracingEnvArgs({ traceparent: TRACEPARENT }, { OTEL_CAPTURE_CONTENT: 'true' }));
    expect(env.OTEL_CAPTURE_CONTENT).toBe('true');
  });

  it('does NOT inject OTEL_CAPTURE_CONTENT when the host left it unset (default-off)', () => {
    const env = envArgsToMap(buildRunnerTracingEnvArgs({ traceparent: TRACEPARENT }, {}));
    expect(env.OTEL_CAPTURE_CONTENT).toBeUndefined();
  });
});
