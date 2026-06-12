/**
 * Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

// OTel bootstrap MUST be the first import so the SDK is initialized before any
// provider / MCP module starts emitting spans (ADR-0026). No-op when host
// tracing is off (no OTEL_TRACEPARENT). Side-effect import only.
import './observability/init.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { MCP_SERVER_NAME } from './branding.js';
import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity, memory
  // policy, and the live destinations map. Everything else (capabilities,
  // per-module instructions, per-channel formatting) is loaded by Claude
  // Code from /workspace/agent/CLAUDE.md — the composed entry imports the
  // shared base (/app/CLAUDE.md) and each enabled module's fragment.
  // Per-group memory lives in /workspace/agent/CLAUDE.local.md
  // (auto-loaded) when the selected provider supports it.
  const instructions = buildSystemPromptAddendum(config.assistantName || undefined, config.memoryMode);

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // OTel context for the built-in MCP server. It runs as a SEPARATE `bun run`
  // process (StdioServerTransport), so the in-process OTel active context does
  // NOT reach it — the trace bridge must travel through these env vars, which
  // the MCP server's own `observability/init.js` reads to join the same trace.
  // Without this passthrough the tool spans would land in their own orphan
  // trace instead of under the host session root.
  const mcpOtelEnv: Record<string, string> = {};
  for (const key of [
    'OTEL_TRACEPARENT',
    'OTEL_TRACESTATE',
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    'OTEL_SDK_DISABLED',
    'OTEL_SERVICE_NAME',
    'NODE_ENV',
    'BRAND_NAMESPACE',
  ]) {
    const value = process.env[key];
    if (value !== undefined) mcpOtelEnv[key] = value;
  }

  // Build MCP servers config: built-in tools server + any from container.json
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    [MCP_SERVER_NAME]: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: mcpOtelEnv,
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${serverConfig.command})`);
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
    idleExitMs: config.idleExitMs,
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
