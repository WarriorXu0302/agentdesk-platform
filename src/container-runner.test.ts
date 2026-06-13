import { describe, expect, it } from 'vitest';

import {
  appendImageAndCommand,
  buildRunnerTracingEnvArgs,
  buildSecurityArgs,
  checkBaseImage,
  resolveProviderName,
} from './container-runner.js';

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

describe('buildSecurityArgs (ADR-0029 least-privilege)', () => {
  it('always emits --security-opt=no-new-privileges:true', () => {
    expect(buildSecurityArgs({})).toContain('--security-opt=no-new-privileges:true');
  });

  it('does NOT drop any capabilities by default (zero-risk for browsing/network)', () => {
    const args = buildSecurityArgs({});
    expect(args.some((a) => a.startsWith('--cap-drop'))).toBe(false);
    // The only flag should be no-new-privileges.
    expect(args).toEqual(['--security-opt=no-new-privileges:true']);
  });

  it('emits one --cap-drop per capability when AGENT_DROP_CAPS is set', () => {
    const args = buildSecurityArgs({ AGENT_DROP_CAPS: 'NET_RAW,NET_ADMIN' });
    expect(args).toContain('--cap-drop=NET_RAW');
    expect(args).toContain('--cap-drop=NET_ADMIN');
    // no-new-privileges is still present alongside the opt-in drops.
    expect(args).toContain('--security-opt=no-new-privileges:true');
  });

  it('tolerates spaces, extra commas, and surrounding whitespace in AGENT_DROP_CAPS', () => {
    const args = buildSecurityArgs({ AGENT_DROP_CAPS: ' NET_RAW ,, NET_ADMIN  CHOWN ' });
    const drops = args.filter((a) => a.startsWith('--cap-drop'));
    expect(drops).toEqual(['--cap-drop=NET_RAW', '--cap-drop=NET_ADMIN', '--cap-drop=CHOWN']);
  });

  it('treats an empty AGENT_DROP_CAPS as no drops', () => {
    expect(buildSecurityArgs({ AGENT_DROP_CAPS: '' })).toEqual(['--security-opt=no-new-privileges:true']);
    expect(buildSecurityArgs({ AGENT_DROP_CAPS: '   ' })).toEqual(['--security-opt=no-new-privileges:true']);
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

  // Regression for the cross-batch integration bug: the OTEL `-e` vars were
  // being pushed AFTER the image tag, where docker hands them to the entrypoint
  // as positional args instead of setting them as container env. The unit tests
  // above prove buildRunnerTracingEnvArgs emits the right `-e` flags, but they
  // never proved those flags land in the docker-flag region. These do.
  describe('argv ordering — OTEL env must precede the image tag', () => {
    const IMAGE = 'agentdesk-agent-v2-deadbeef:latest';

    // Build a realistic docker-flag prefix the way buildContainerArgs does:
    // base flags, the brand env, then the tracing env, then seal with the image
    // + command tail via the same helper buildContainerArgs uses.
    function buildArgs(envArgs: string[]): { args: string[]; imageIndex: number } {
      const args = [
        'run',
        '--rm',
        '--name',
        'agentdesk-v2-grp-123',
        '-e',
        'TZ=UTC',
        '-e',
        'BRAND_NAMESPACE=agentdesk',
        ...envArgs,
      ];
      appendImageAndCommand(args, IMAGE);
      return { args, imageIndex: args.indexOf(IMAGE) };
    }

    function otelEnvIndices(args: string[]): number[] {
      const indices: number[] = [];
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '-e' && args[i + 1]?.startsWith('OTEL_')) {
          // The flag itself (`-e`) is what docker must parse; assert on its index.
          indices.push(i);
        }
      }
      return indices;
    }

    it('places every OTEL `-e` flag before the image tag when a trace is active', () => {
      const envArgs = buildRunnerTracingEnvArgs(
        { traceparent: TRACEPARENT },
        { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:6006/v1/traces', OTEL_CAPTURE_CONTENT: 'true' },
      );
      const { args, imageIndex } = buildArgs(envArgs);

      expect(imageIndex).toBeGreaterThan(-1);
      const otelIndices = otelEnvIndices(args);
      // Sanity: traceparent + endpoint + capture-content => 3 OTEL `-e` flags.
      expect(otelIndices).toHaveLength(3);
      for (const idx of otelIndices) {
        expect(idx).toBeLessThan(imageIndex);
      }
    });

    it('emits all three OTEL env classes (traceparent, endpoint, capture-content) as `-e` pairs', () => {
      const envArgs = buildRunnerTracingEnvArgs(
        { traceparent: TRACEPARENT },
        { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:6006/v1/traces', OTEL_CAPTURE_CONTENT: 'true' },
      );
      const keys = envArgsToMap(envArgs);
      expect(keys.OTEL_TRACEPARENT).toBe(TRACEPARENT);
      expect(keys.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('http://host.docker.internal:6006/v1/traces');
      expect(keys.OTEL_CAPTURE_CONTENT).toBe('true');
    });

    it('still seals the image + command tail when no trace is active (no OTEL flags leak past the image)', () => {
      const { args, imageIndex } = buildArgs(buildRunnerTracingEnvArgs({}, {}));
      expect(otelEnvIndices(args)).toHaveLength(0);
      // Tail invariant: image is followed by the bash `-c` command, nothing else
      // sneaks between flags and image.
      expect(args[imageIndex - 2]).toBe('--entrypoint');
      expect(args[imageIndex - 1]).toBe('bash');
      expect(args.slice(imageIndex + 1)).toEqual(['-c', 'exec bun run /app/src/index.ts']);
    });
  });
});
