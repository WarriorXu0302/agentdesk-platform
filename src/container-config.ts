/**
 * Per-group container config, stored as a plain JSON file at
 * `groups/<folder>/container.json`. Mounted read-only inside the container
 * at `/workspace/agent/container.json` — the runner reads it at startup but
 * cannot modify it. Config changes go through the self-mod approval flow.
 *
 * All fields are optional — a missing file or a partial file both resolve
 * to sensible defaults. Writes are atomic-enough (write-then-rename is not
 * worth the ceremony here since there's only one writer in practice: the
 * host, from the delivery thread that processes approved system actions).
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  // Optional always-in-context guidance. When set, the host writes the
  // content to `.claude-fragments/mcp-<name>.md` at spawn and imports it
  // into the composed CLAUDE.md.
  instructions?: string;
}

export interface BackendGatewayConfig {
  /** Base URL for the ERP gateway, without a trailing slash. */
  baseUrl: string;
  /** Request timeout for built-in ERP gateway MCP tools. Default: 15000 ms. */
  timeoutMs?: number;
  /** Static headers to send on every ERP gateway request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Optional HMAC signing key. When set, every gateway request is signed:
   * `x-<namespace>-timestamp`, `x-<namespace>-nonce`, and
   * `x-<namespace>-signature = HMAC-SHA256(key, timestamp + "." + nonce + "." + body)`.
   * Gateways that validate signatures can then reject requests that didn't
   * come from a host-provisioned container. Pair with a short clock-skew
   * window (e.g. ±5 minutes) and a replay cache on the gateway side.
   */
  signingKey?: string;
  /**
   * Overrides for the three signing header names. Leave unset to use the
   * defaults above — only set this if the gateway you're fronting has
   * mandatory header naming rules.
   */
  signingHeaders?: {
    timestamp?: string;
    nonce?: string;
    signature?: string;
  };
}

export type MemoryMode = 'workspace' | 'gateway';
export type A2aSessionMode = 'agent-shared' | 'root-session';

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/**
 * Per-agent-group container resource limits. All fields are optional and
 * map directly onto Docker run flags. When a field is unset the Docker
 * default applies (unlimited). Strongly recommended in multi-tenant
 * deployments — a single runaway agent can otherwise exhaust host memory or
 * fork-bomb the kernel.
 */
export interface ContainerResourceLimits {
  /** Memory limit in MiB → `--memory=<N>m`. */
  memoryMb?: number;
  /** CPU share, can be fractional → `--cpus=<N>`. */
  cpus?: number;
  /** Max processes inside the container → `--pids-limit=<N>`. */
  pidsLimit?: number;
}

export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  backendGateway?: BackendGatewayConfig;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  /** Which skills to enable — array of skill names or "all" (default). */
  skills: string[] | 'all';
  /** Agent provider name (e.g. "claude", "opencode"). Default: "claude". */
  provider?: string;
  /** Agent group display name (used in transcript archiving). */
  groupName?: string;
  /** Assistant display name (used in system prompt / responses). */
  assistantName?: string;
  /**
   * Long-lived memory policy for this agent group.
   * - `workspace`: agent may persist durable notes in its shared workspace
   * - `erp`: durable user/business memory must go through the ERP gateway
   */
  memoryMode?: MemoryMode;
  /**
   * Agent-to-agent worker session policy.
   * - `agent-shared`: one shared a2a session per target agent group
   * - `root-session`: one a2a session per target agent group and root session
   */
  a2aSessionMode?: A2aSessionMode;
  /** Agent group ID — set by the host, read by the runner. */
  agentGroupId?: string;
  /** Max messages per prompt. Falls back to code default if unset. */
  maxMessagesPerPrompt?: number;
  /**
   * Optional per-container resource caps. Unset fields default to Docker's
   * unlimited. Strongly recommended in multi-user deployments.
   */
  resources?: ContainerResourceLimits;
  /**
   * Optional env vars forwarded into the container at spawn time. Use this
   * to point a skill's bridge.py at a non-default backend (e.g.
   * `CAMERA_BASE_URL=http://172.18.198.229:8001`) without rebuilding the
   * image or hard-coding hostnames in skill code. Keys/values passed
   * verbatim via `docker run -e KEY=VALUE`. Provider/system env (TZ,
   * OneCLI HTTPS_PROXY, etc.) is layered separately and is not overridden
   * by this map.
   */
  env?: Record<string, string>;
  /**
   * Progressive skill disclosure (perf). Replaces each skill's full
   * `instructions.md` content in the composed system prompt to keep the
   * prompt small and prefix-cache friendly.
   *
   *   false (default)  — current behavior: every skill's instructions.md
   *                      is inlined into the system prompt.
   *   true             — emit a compact `Available Skills` index
   *                      (name + description from SKILL.md frontmatter) +
   *                      anti-overthink preamble telling the agent to
   *                      skip `load_skill` for simple greetings. Use
   *                      `load_skill(name)` MCP tool to fetch a skill on
   *                      demand.
   *   "lean"           — omit the skill index entirely. For dispatcher
   *                      agents that route to worker agents and never
   *                      need to execute skills themselves
   *                      (`<namespace>-frontdesk` dispatcher pattern). The
   *                      `load_skill` tool stays registered but the
   *                      agent has no list to choose from.
   *
   * Worker agent groups that already specify a narrow `skills` array
   * usually leave this off — their prompt is already small.
   */
  progressiveDisclosure?: boolean | 'lean';
}

function emptyConfig(): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
  };
}

function normalizeMemoryMode(value: unknown): MemoryMode | undefined {
  return value === 'workspace' || value === 'gateway' ? value : undefined;
}

function normalizeA2aSessionMode(value: unknown): A2aSessionMode | undefined {
  return value === 'agent-shared' || value === 'root-session' ? value : undefined;
}

function normalizeResources(value: unknown): ContainerResourceLimits | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<ContainerResourceLimits>;
  const out: ContainerResourceLimits = {};
  if (typeof raw.memoryMb === 'number' && Number.isFinite(raw.memoryMb) && raw.memoryMb > 0) {
    out.memoryMb = Math.floor(raw.memoryMb);
  }
  if (typeof raw.cpus === 'number' && Number.isFinite(raw.cpus) && raw.cpus > 0) {
    out.cpus = raw.cpus;
  }
  if (typeof raw.pidsLimit === 'number' && Number.isFinite(raw.pidsLimit) && raw.pidsLimit > 0) {
    out.pidsLimit = Math.floor(raw.pidsLimit);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function configPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json');
}

/**
 * Read the container config for a group, returning sensible defaults for
 * any missing fields (or an entirely empty config if the file is absent).
 * Never throws for missing / malformed files — corruption logs a warning
 * via console.error and falls back to empty.
 */
export function readContainerConfig(folder: string): ContainerConfig {
  const p = configPath(folder);
  if (!fs.existsSync(p)) return emptyConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ContainerConfig>;
    return {
      mcpServers: raw.mcpServers ?? {},
      backendGateway: raw.backendGateway,
      packages: {
        apt: raw.packages?.apt ?? [],
        npm: raw.packages?.npm ?? [],
      },
      imageTag: raw.imageTag,
      additionalMounts: raw.additionalMounts ?? [],
      skills: raw.skills ?? 'all',
      provider: raw.provider,
      groupName: raw.groupName,
      assistantName: raw.assistantName,
      memoryMode: normalizeMemoryMode(raw.memoryMode),
      a2aSessionMode: normalizeA2aSessionMode(raw.a2aSessionMode),
      agentGroupId: raw.agentGroupId,
      maxMessagesPerPrompt: raw.maxMessagesPerPrompt,
      resources: normalizeResources(raw.resources),
      env: raw.env,
      progressiveDisclosure:
        raw.progressiveDisclosure === 'lean'
          ? 'lean'
          : raw.progressiveDisclosure === true,
    };
  } catch (err) {
    console.error(`[container-config] failed to parse ${p}: ${String(err)}`);
    return emptyConfig();
  }
}

/**
 * Write the container config for a group, creating the groups/<folder>/
 * directory if necessary. Pretty-printed JSON so diffs in the activation
 * flow are reviewable.
 */
export function writeContainerConfig(folder: string, config: ContainerConfig): void {
  const p = configPath(folder);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Apply a mutator function to a group's container config and persist the
 * result. Convenient for append-style changes like `install_packages` and
 * `add_mcp_server` handlers.
 */
export function updateContainerConfig(folder: string, mutate: (config: ContainerConfig) => void): ContainerConfig {
  const config = readContainerConfig(folder);
  mutate(config);
  writeContainerConfig(folder, config);
  return config;
}

/**
 * Initialize an empty container.json for a group if one doesn't already
 * exist. Idempotent — used from `group-init.ts`.
 */
export function initContainerConfig(folder: string): boolean {
  const p = configPath(folder);
  if (fs.existsSync(p)) return false;
  writeContainerConfig(folder, emptyConfig());
  return true;
}
