import { describe, expect, it } from 'vitest';

import {
  appendImageAndCommand,
  buildNetworkArgs,
  buildRunnerTracingEnvArgs,
  buildSecurityArgs,
  checkBaseImage,
  findInjectedEnvValue,
  isValidContainerNetwork,
  mergeNoProxyArgs,
  redactContainerConfigForContainer,
  redactedConfigPathFor,
  resolveContainerNetwork,
  resolveProviderName,
  routeOpenAiThroughVault,
} from './container-runner.js';

describe('routeOpenAiThroughVault (ADR-0035)', () => {
  it('routes openai/codex through the vault only when the flag is on', () => {
    expect(routeOpenAiThroughVault('openai', true)).toBe(true);
    expect(routeOpenAiThroughVault('codex', true)).toBe(true);
    expect(routeOpenAiThroughVault('openai', false)).toBe(false);
    expect(routeOpenAiThroughVault('codex', false)).toBe(false);
  });

  it('never routes mock or claude (offline / already-vaulted)', () => {
    expect(routeOpenAiThroughVault('mock', true)).toBe(false);
    expect(routeOpenAiThroughVault('claude', true)).toBe(false);
  });
});

describe('findInjectedEnvValue (ADR-0035 vault CA detection)', () => {
  it('returns the value OneCLI injected for a key', () => {
    const args = ['run', '-e', 'SSL_CERT_FILE=/tmp/onecli-combined-ca.pem', '-v', 'x:y'];
    expect(findInjectedEnvValue(args, 'SSL_CERT_FILE')).toBe('/tmp/onecli-combined-ca.pem');
  });

  it('returns undefined when the key was not injected (no combined CA mounted)', () => {
    expect(findInjectedEnvValue(['run', '-e', 'TZ=UTC'], 'SSL_CERT_FILE')).toBeUndefined();
  });

  it('returns the LAST value when a key appears more than once', () => {
    const args = ['-e', 'SSL_CERT_FILE=/a', '-e', 'SSL_CERT_FILE=/b'];
    expect(findInjectedEnvValue(args, 'SSL_CERT_FILE')).toBe('/b');
  });
});
import type { ContainerConfig } from './container-config.js';

describe('redactContainerConfigForContainer (ADR-0034 key isolation)', () => {
  function configWithGateway(): ContainerConfig {
    return {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      agentGroupId: 'ag1',
      groupName: 'G',
      backendGateway: {
        baseUrl: 'https://erp.example',
        signingKey: 'TOP-SECRET-KEY',
        defaultHeaders: { 'x-tenant': 't1' },
      },
    };
  }

  it('strips the signingKey AND blanks baseUrl (structural fail-closed)', () => {
    const redacted = redactContainerConfigForContainer(configWithGateway());
    expect(redacted.backendGateway?.signingKey).toBeUndefined();
    // baseUrl blanked so a stray direct call has no target -> GATEWAY_NOT_CONFIGURED.
    expect(redacted.backendGateway?.baseUrl).toBe('');
    // Non-secret fields preserved so the runner still has its config.
    expect(redacted.backendGateway?.defaultHeaders).toEqual({ 'x-tenant': 't1' });
    expect(redacted.agentGroupId).toBe('ag1');
  });

  it('serialized redacted config contains no trace of the key', () => {
    const json = JSON.stringify(redactContainerConfigForContainer(configWithGateway()));
    expect(json).not.toContain('TOP-SECRET-KEY');
    expect(json).not.toContain('signingKey');
  });

  it('does not mutate the input config', () => {
    const original = configWithGateway();
    redactContainerConfigForContainer(original);
    expect(original.backendGateway?.signingKey).toBe('TOP-SECRET-KEY');
    expect(original.backendGateway?.baseUrl).toBe('https://erp.example');
  });

  it('is a no-op shape when no backendGateway is configured', () => {
    const redacted = redactContainerConfigForContainer({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });
    expect(redacted.backendGateway).toBeUndefined();
  });
});

describe('redactedConfigPathFor (ADR-0034 host-only redacted config)', () => {
  it('is deterministic and lives under the host-only v2-proxy-runtime dir (never a RW-mounted group dir)', () => {
    const p1 = redactedConfigPathFor('sess-abc');
    const p2 = redactedConfigPathFor('sess-abc');
    expect(p1).toBe(p2);
    expect(p1).toContain('/v2-proxy-runtime/');
    expect(p1).not.toContain('/groups/');
    expect(redactedConfigPathFor('sess-xyz')).not.toBe(p1);
  });
});

/** Read the value of the LAST `-e KEY=...` entry (case-sensitive key). */
function lastEnvArg(args: string[], key: string): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e' && args[i + 1].startsWith(`${key}=`)) found = args[i + 1].slice(key.length + 1);
  }
  return found;
}

describe('mergeNoProxyArgs (ADR-0034 NO_PROXY merge)', () => {
  it('appends host.docker.internal (both cases) when no prior NO_PROXY exists', () => {
    const args: string[] = [];
    mergeNoProxyArgs(args, ['host.docker.internal']);
    expect(lastEnvArg(args, 'NO_PROXY')).toBe('host.docker.internal');
    expect(lastEnvArg(args, 'no_proxy')).toBe('host.docker.internal');
  });

  it('unions with an existing OneCLI-injected NO_PROXY (last -e wins in docker)', () => {
    const args = ['-e', 'NO_PROXY=vault.internal,localhost'];
    mergeNoProxyArgs(args, ['host.docker.internal']);
    const merged = lastEnvArg(args, 'NO_PROXY')!.split(',');
    expect(new Set(merged)).toEqual(new Set(['vault.internal', 'localhost', 'host.docker.internal']));
  });

  it('also picks up a lowercase no_proxy and dedups', () => {
    const args = ['-e', 'no_proxy=host.docker.internal,vault'];
    mergeNoProxyArgs(args, ['host.docker.internal']);
    expect(new Set(lastEnvArg(args, 'NO_PROXY')!.split(','))).toEqual(new Set(['host.docker.internal', 'vault']));
  });
});

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

describe('isValidContainerNetwork (ADR-0032 injection-safety gate)', () => {
  it('accepts built-in modes none/host/bridge', () => {
    expect(isValidContainerNetwork('none')).toBe(true);
    expect(isValidContainerNetwork('host')).toBe(true);
    expect(isValidContainerNetwork('bridge')).toBe(true);
  });

  it('accepts well-formed user-defined network names', () => {
    expect(isValidContainerNetwork('egress-proxy')).toBe(true);
    expect(isValidContainerNetwork('agentdesk_egress.v2')).toBe(true);
    expect(isValidContainerNetwork('net0')).toBe(true);
  });

  it('rejects empty, leading-dash, and argv/shell-hostile values', () => {
    expect(isValidContainerNetwork('')).toBe(false);
    // Leading '-' would be parsed by docker as a flag.
    expect(isValidContainerNetwork('-rm')).toBe(false);
    expect(isValidContainerNetwork('--privileged')).toBe(false);
    // Spaces / argv injection attempts.
    expect(isValidContainerNetwork('host --privileged')).toBe(false);
    expect(isValidContainerNetwork('net;rm -rf /')).toBe(false);
    expect(isValidContainerNetwork('$(whoami)')).toBe(false);
    // container:<id> indirection is deliberately not accepted.
    expect(isValidContainerNetwork('container:abc123')).toBe(false);
  });
});

describe('resolveContainerNetwork (ADR-0032 precedence + default-permissive)', () => {
  it('returns undefined when nothing is configured (docker default bridge, historical behavior)', () => {
    expect(resolveContainerNetwork({}, {})).toBeUndefined();
    expect(resolveContainerNetwork({ network: undefined }, {})).toBeUndefined();
  });

  it('uses the per-group config.network when set', () => {
    expect(resolveContainerNetwork({ network: 'egress-proxy' }, {})).toBe('egress-proxy');
  });

  it('uses the global AGENT_CONTAINER_NETWORK when no per-group value is set', () => {
    expect(resolveContainerNetwork({}, { AGENT_CONTAINER_NETWORK: 'egress-proxy' })).toBe('egress-proxy');
  });

  it('prefers per-group config.network over the global env var', () => {
    expect(resolveContainerNetwork({ network: 'group-net' }, { AGENT_CONTAINER_NETWORK: 'global-net' })).toBe(
      'group-net',
    );
  });

  it('falls back to default (undefined) for an invalid configured value — never forwards it', () => {
    expect(resolveContainerNetwork({ network: 'host --privileged' }, {})).toBeUndefined();
    expect(resolveContainerNetwork({}, { AGENT_CONTAINER_NETWORK: '$(whoami)' })).toBeUndefined();
  });

  it('accepts the built-in none mode (pure-DB workers)', () => {
    expect(resolveContainerNetwork({ network: 'none' }, {})).toBe('none');
  });
});

describe('buildNetworkArgs (ADR-0032 egress lockdown)', () => {
  it('emits no --network flag by default (backward compatible)', () => {
    expect(buildNetworkArgs({}, {})).toEqual([]);
  });

  it('emits --network <value> for a valid per-group config', () => {
    expect(buildNetworkArgs({ network: 'egress-proxy' }, {})).toEqual(['--network', 'egress-proxy']);
  });

  it('emits --network none for a pure-DB worker', () => {
    expect(buildNetworkArgs({ network: 'none' }, {})).toEqual(['--network', 'none']);
  });

  it('emits --network from the global env var when no per-group value is set', () => {
    expect(buildNetworkArgs({}, { AGENT_CONTAINER_NETWORK: 'egress-proxy' })).toEqual(['--network', 'egress-proxy']);
  });

  it('does NOT push --network for an invalid value (falls back to default, no injection)', () => {
    expect(buildNetworkArgs({ network: '; rm -rf /' }, {})).toEqual([]);
    expect(buildNetworkArgs({}, { AGENT_CONTAINER_NETWORK: '--privileged' })).toEqual([]);
  });

  // Ordering invariant: --network is a docker flag and must precede the image
  // tag, exactly like the security/OTEL flags. A --network after the image
  // would be handed to the entrypoint instead of parsed by docker.
  describe('argv ordering — --network must precede the image tag', () => {
    const IMAGE = 'agentdesk-agent-v2-deadbeef:latest';

    function buildArgs(netArgs: string[]): { args: string[]; imageIndex: number } {
      const args = [
        'run',
        '--rm',
        '--name',
        'agentdesk-v2-grp-123',
        '--security-opt=no-new-privileges:true',
        ...netArgs,
      ];
      appendImageAndCommand(args, IMAGE);
      return { args, imageIndex: args.indexOf(IMAGE) };
    }

    it('places the --network flag before the image tag', () => {
      const { args, imageIndex } = buildArgs(buildNetworkArgs({ network: 'egress-proxy' }, {}));
      const netIndex = args.indexOf('--network');
      expect(netIndex).toBeGreaterThan(-1);
      expect(imageIndex).toBeGreaterThan(-1);
      expect(netIndex).toBeLessThan(imageIndex);
      // The value sits immediately after the flag, still before the image.
      expect(args[netIndex + 1]).toBe('egress-proxy');
      expect(netIndex + 1).toBeLessThan(imageIndex);
    });

    it('leaves the image tail intact when no network is configured', () => {
      const { args, imageIndex } = buildArgs(buildNetworkArgs({}, {}));
      expect(args.indexOf('--network')).toBe(-1);
      expect(args.slice(imageIndex + 1)).toEqual(['-c', 'exec bun run /app/src/index.ts']);
    });
  });
});
