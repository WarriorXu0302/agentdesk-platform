/**
 * Env passthrough for the built-in MCP tools server child process.
 *
 * The built-in gateway/tool MCP server runs as a SEPARATE process (its own
 * `bun run`, spawned by the provider). It does NOT inherit the agent-runner's
 * full process env — the launcher restricts it — so any env the tools need must
 * be forwarded explicitly here. This is a single source of truth so a forgotten
 * passthrough is caught by a unit test rather than discovered in production
 * (see ADR-0026/0027 for the OTel vars and ADR-0034 for the signing-proxy vars,
 * both of which were inert until forwarded through this exact boundary).
 */
export const MCP_CHILD_ENV_KEYS = [
  // OTel trace bridge (ADR-0026): without these the tool spans land in an
  // orphan trace instead of under the host session root.
  'OTEL_TRACEPARENT',
  'OTEL_TRACESTATE',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_SDK_DISABLED',
  'OTEL_SERVICE_NAME',
  // Content-capture opt-in (ADR-0027).
  'OTEL_CAPTURE_CONTENT',
  'NODE_ENV',
  'BRAND_NAMESPACE',
  // Signing credential proxy (ADR-0034). The gateway tools read these
  // (getSigningProxyTarget) to route gateway calls through the host signer.
  // Without this passthrough proxy mode never engages and, since the signingKey
  // is redacted from container.json in proxy mode, calls would fail open to
  // unsigned-direct. These two are the gate.
  'AGENTDESK_GATEWAY_PROXY_URL',
  'AGENTDESK_GATEWAY_PROXY_TOKEN',
] as const;

/** Build the env map forwarded to the built-in MCP tools child process. */
export function buildMcpChildEnv(processEnv: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of MCP_CHILD_ENV_KEYS) {
    const value = processEnv[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Assemble the MCP servers config the provider spawns: the built-in tools
 * server (with its env-allowlist passthrough applied — see buildMcpChildEnv)
 * plus any servers declared in container.json. Pure + exported so a unit test
 * pins that the built-in server's env actually carries the passthrough — the
 * exact wiring whose absence made ADR-0034's proxy vars (and earlier ADR-0026's
 * OTel vars) silently never reach the tools process.
 */
export function buildMcpServersConfig(
  processEnv: NodeJS.ProcessEnv,
  builtInServerName: string,
  builtInServerPath: string,
  extraServers: Record<string, McpServerEntry>,
): Record<string, McpServerEntry> {
  const servers: Record<string, McpServerEntry> = {
    [builtInServerName]: {
      command: 'bun',
      args: ['run', builtInServerPath],
      env: buildMcpChildEnv(processEnv),
    },
  };
  for (const [name, cfg] of Object.entries(extraServers)) servers[name] = cfg;
  return servers;
}
