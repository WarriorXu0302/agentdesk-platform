/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { PLATFORM_PROTOCOL_NAMESPACE } from './branding.js';
import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  MAX_CONCURRENT_CONTAINERS,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { readContainerConfig, writeContainerConfig } from './container-config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { revokeAllProxyTokens, revokeProxyTokensForSession } from './db/gateway-proxy-token.js';
import { gatewaySigningProxyEnabled, mintSessionProxyToken } from './gateway-signing-proxy.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { containerExitsTotal, wakeRejectedTotal } from './metrics.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import { chainAttrs } from './observability/openinference.js';
import { getActiveSpan } from './observability/tracer.js';
import { withSpan } from './observability/with-span.js';
import { injectTraceContext } from './observability/trace-context.js';
import { failSessionRootSpan } from './observability/context-bridge.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string; agentGroupId: string }>();

/**
 * Session ids whose container we just asked to stop via killContainer.
 * Cleared by the close handler — used only to label exit metrics as
 * `killed` instead of `idle`/`crash`, since spawn/close can't tell us the
 * reason on its own.
 */
const recentlyKilled = new Set<string>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

/**
 * Build the `-e KEY=VALUE` docker args that bridge host tracing into the
 * runner (ADR-0026). Pure + exported for unit testing.
 *
 * Contract:
 *   - When the host has NO active trace (carrier.traceparent absent), inject
 *     nothing trace-related — the runner stays a pure no-op. This preserves
 *     "runner behaves exactly as before when host tracing is off".
 *   - When a traceparent exists, also inject the OTLP traces endpoint so the
 *     runner knows where to export. The container can't reach the host's
 *     loopback, so localhost/127.0.0.1 is rewritten to the docker host gateway
 *     alias (`host.docker.internal`, made resolvable by hostGatewayArgs()).
 *   - OTEL_SDK_DISABLED is forwarded verbatim whenever set, so an operator can
 *     hard-off runner tracing independently of the host.
 *   - OTEL_CAPTURE_CONTENT (ADR-0027) is forwarded verbatim whenever set, so an
 *     operator who opted into FULL-PLAINTEXT span content on the host (chat
 *     bodies, LLM messages, tool args/results) gets the same opt-in inside the
 *     container and the MCP server. Default-off: unset on the host => the
 *     runner stays metadata-only, exactly as before this ADR.
 */
export function buildRunnerTracingEnvArgs(carrier: Record<string, string>, env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  if (carrier.traceparent) {
    args.push('-e', `OTEL_TRACEPARENT=${carrier.traceparent}`);
    if (carrier.tracestate) {
      args.push('-e', `OTEL_TRACESTATE=${carrier.tracestate}`);
    }
    const hostEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'http://localhost:6006/v1/traces';
    const containerEndpoint = hostEndpoint.replace(/\/\/(localhost|127\.0\.0\.1)(:|\/|$)/, '//host.docker.internal$2');
    args.push('-e', `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${containerEndpoint}`);
  }
  if (env.OTEL_SDK_DISABLED) {
    args.push('-e', `OTEL_SDK_DISABLED=${env.OTEL_SDK_DISABLED}`);
  }
  if (env.OTEL_CAPTURE_CONTENT) {
    args.push('-e', `OTEL_CAPTURE_CONTENT=${env.OTEL_CAPTURE_CONTENT}`);
  }
  return args;
}

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

function defaultInspectImage(image: string): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} image inspect ${image}`, { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Startup precheck: verify the base agent image exists locally.
 *
 * Non-fatal by design — a missing image must not crash the host (channels
 * and /metrics stay up), but every wake would fail with "No such image",
 * so log a loud, actionable error at boot instead of letting the operator
 * discover it on the first inbound message. Checks the same CONTAINER_IMAGE
 * the wake path uses (per-group `imageTag` overrides are built FROM it).
 *
 * `inspectImage` is injectable so tests don't need a container runtime.
 */
export function checkBaseImage(inspectImage: (image: string) => boolean = defaultInspectImage): boolean {
  if (inspectImage(CONTAINER_IMAGE)) {
    log.debug('Base agent image present', { image: CONTAINER_IMAGE });
    return true;
  }
  log.error('Base agent image not found — agents cannot spawn until it is built. Run: pnpm container:build', {
    image: CONTAINER_IMAGE,
    runtime: CONTAINER_RUNTIME_BIN,
  });
  return false;
}

/**
 * Decide whether a new wake should be admitted. Pure function so tests
 * don't have to mock the whole spawn pipeline. The cap is `>=` against
 * (active + in-flight), because an in-flight wake is about to become an
 * active container and we don't want a concurrent caller to slip past.
 */
export function shouldAdmitWake(args: { activeCount: number; inflightCount: number; cap: number }): boolean {
  return args.activeCount + args.inflightCount < args.cap;
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (OneCLI gateway unreachable, global concurrency
 * cap hit, etc.). Callers don't need to wrap — the inbound row stays
 * pending and host-sweep retries on its next tick. Callers that care
 * (e.g. the router's typing indicator) can branch on the boolean.
 *
 * Global concurrency cap: if `activeContainers.size + in-flight wakes`
 * already >= MAX_CONCURRENT_CONTAINERS, we reject without trying to
 * spawn. Avoids fork-bombing the host under an inbound burst. The next
 * sweep tick picks up the session once earlier containers have exited.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  return withSpan(
    'container.wake',
    chainAttrs({ 'session.id': session.id, 'agent.group.id': session.agent_group_id }),
    async () => {
      if (activeContainers.has(session.id)) {
        log.debug('Container already running', { sessionId: session.id });
        return true;
      }
      const existing = wakePromises.get(session.id);
      if (existing) {
        log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
        return existing;
      }
      const admit = shouldAdmitWake({
        activeCount: activeContainers.size,
        inflightCount: wakePromises.size,
        cap: MAX_CONCURRENT_CONTAINERS,
      });
      if (!admit) {
        wakeRejectedTotal.labels('capacity').inc();
        log.warn('Wake rejected — concurrent container cap reached', {
          sessionId: session.id,
          agentGroupId: session.agent_group_id,
          active: activeContainers.size,
          inFlight: activeContainers.size + wakePromises.size,
          cap: MAX_CONCURRENT_CONTAINERS,
        });
        return false;
      }
      const promise = spawnContainer(session)
        .then(() => true)
        .catch((err) => {
          log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
          return false;
        })
        .finally(() => {
          wakePromises.delete(session.id);
        });
      wakePromises.set(session.id, promise);
      return promise;
    },
  );
}

async function spawnContainer(session: Session): Promise<void> {
  return withSpan(
    'container.spawn',
    chainAttrs({ 'session.id': session.id, 'agent.group.id': session.agent_group_id }),
    async () => {
      const agentGroup = getAgentGroup(session.agent_group_id);
      if (!agentGroup) {
        log.error('Agent group not found', { agentGroupId: session.agent_group_id });
        return;
      }

      // Refresh the destination map and default reply routing so any admin
      // changes take effect on wake. Destinations come from the agent-to-agent
      // module — skip when the module isn't installed (table absent).
      if (hasTable(getDb(), 'agent_destinations')) {
        const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
        writeDestinations(agentGroup.id, session.id);
      }
      writeSessionRouting(agentGroup.id, session.id);

      // Read container config once — threaded through provider resolution,
      // buildMounts, and buildContainerArgs so we don't re-read the file.
      const containerConfig = readContainerConfig(agentGroup.folder);

      // Ensure container.json has the agent group identity fields the runner needs.
      // Written at spawn time so the runner can read them from the RO mount.
      ensureRuntimeFields(containerConfig, agentGroup);

      // Resolve the effective provider + any host-side contribution it declares
      // (extra mounts, env passthrough). Computed once and threaded through both
      // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
      const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);
      getActiveSpan()?.setAttribute('provider', provider);

      // Signing credential proxy (ADR-0034). When enabled + the group has a
      // signingKey, mint a per-session token and redact the key from the
      // container's container.json. Undefined (and a no-op) otherwise.
      const signingProxy = resolveSpawnSigningProxy(session, agentGroup, containerConfig);

      const mounts = buildMounts(agentGroup, session, containerConfig, contribution, signingProxy);
      const containerName = `${PLATFORM_PROTOCOL_NAMESPACE}-v2-${agentGroup.folder}-${Date.now()}`;
      // OneCLI agent identifier is always the agent group id — stable across
      // sessions and reversible via getAgentGroup() for approval routing.
      const agentIdentifier = agentGroup.id;
      // buildContainerArgs injects the OTEL tracing env vars in-line (before
      // the image tag) — see the trace-context block there. They must precede
      // the image name or docker drops them, so they are NOT appended here.
      const args = await buildContainerArgs(
        mounts,
        containerName,
        agentGroup,
        containerConfig,
        provider,
        contribution,
        agentIdentifier,
        signingProxy,
      );

      log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

      // Clear any orphan heartbeat from a previous container instance — the
      // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
      // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
      // immediate kill before the new container touches the file itself.
      fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

      const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      activeContainers.set(session.id, { process: container, containerName, agentGroupId: agentGroup.id });
      markContainerRunning(session.id);

      // Log stderr
      container.stderr?.on('data', (data) => {
        for (const line of data.toString().trim().split('\n')) {
          if (line) log.debug(line, { container: agentGroup.folder });
        }
      });

      // stdout is unused in v2 (all IO is via session DB)
      container.stdout?.on('data', () => {});

      // No host-side idle timeout. Stale/stuck detection is driven by the host
      // sweep reading heartbeat mtime + processing_ack claim age + container_state
      // (see src/host-sweep.ts). This avoids killing long-running legitimate work
      // on a wall-clock timer.

      container.on('close', (code) => {
        const outcome = recentlyKilled.has(session.id) ? 'killed' : code === 0 ? 'idle' : 'crash';
        recentlyKilled.delete(session.id);
        activeContainers.delete(session.id);
        markContainerStopped(session.id);
        stopTypingRefresh(session.id);
        cleanupSigningProxyForSession(session.id, signingProxy);
        containerExitsTotal.labels(agentGroup.id, outcome).inc();
        if (outcome === 'crash' || outcome === 'killed') {
          failSessionRootSpan(session.id, `container ${outcome} (code=${code})`);
        }
        log.info('Container exited', { sessionId: session.id, code, containerName, outcome });
      });

      container.on('error', (err) => {
        recentlyKilled.delete(session.id);
        activeContainers.delete(session.id);
        markContainerStopped(session.id);
        stopTypingRefresh(session.id);
        cleanupSigningProxyForSession(session.id, signingProxy);
        containerExitsTotal.labels(agentGroup.id, 'crash').inc();
        failSessionRootSpan(session.id, `container spawn error: ${err.message}`);
        log.error('Container spawn error', { sessionId: session.id, err });
      });
    },
  );
}

/** Kill a container for a session. */
export async function killContainer(sessionId: string, reason: string): Promise<void> {
  await withSpan('container.kill', chainAttrs({ 'session.id': sessionId, reason }), async () => {
    const entry = activeContainers.get(sessionId);
    if (!entry) return;

    log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
    recentlyKilled.add(sessionId);
    try {
      stopContainer(entry.containerName);
    } catch {
      entry.process.kill('SIGKILL');
    }
  });
}

/**
 * Resolve the provider name for a session using the precedence documented in
 * the provider-install skills:
 *
 *   sessions.agent_provider
 *     → agent_groups.agent_provider
 *     → container.json `provider`
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  agentGroupProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || agentGroupProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, agentGroup.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
  signingProxy?: SpawnSigningProxy,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(claudeDir, containerConfig);

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. See `claude-md-compose.ts`.
  composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent can
  // read its config but cannot modify it. In signing-proxy mode (ADR-0034) we
  // mount a REDACTED copy (signingKey stripped) at the same container path; the
  // nested mount shadows the real groupDir/container.json — which is the only
  // in-container path to it — so the key is never visible inside the container.
  const containerJsonPath = signingProxy?.redactedConfigPath ?? path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set
  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  let desired: string[];
  if (containerConfig.skills === 'all') {
    // Recompute from shared dir — newly-added upstream skills appear automatically
    desired = fs.existsSync(sharedSkillsDir)
      ? fs.readdirSync(sharedSkillsDir).filter((e) => {
          try {
            return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
  } else {
    desired = containerConfig.skills;
  }

  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

/**
 * Ensure container.json has the runtime identity fields the runner needs.
 * Written at spawn time so they're always current even if the DB values
 * change (e.g. group rename). Only writes if values differ to avoid
 * unnecessary file churn.
 */
function ensureRuntimeFields(
  containerConfig: import('./container-config.js').ContainerConfig,
  agentGroup: AgentGroup,
): void {
  let dirty = false;
  if (containerConfig.agentGroupId !== agentGroup.id) {
    containerConfig.agentGroupId = agentGroup.id;
    dirty = true;
  }
  if (containerConfig.groupName !== agentGroup.name) {
    containerConfig.groupName = agentGroup.name;
    dirty = true;
  }
  if (containerConfig.assistantName !== agentGroup.name) {
    containerConfig.assistantName = agentGroup.name;
    dirty = true;
  }
  if (dirty) {
    writeContainerConfig(agentGroup.folder, containerConfig);
  }
}

/**
 * Per-spawn signing-proxy context (ADR-0034). Present only when the proxy is
 * enabled AND the group actually has a signingKey to protect. Carries the
 * minted token, the container-facing proxy URL, the host alias to add to
 * NO_PROXY, and the host path of the REDACTED container.json (signingKey
 * stripped) that gets mounted in place of the real one.
 */
interface SpawnSigningProxy {
  token: string;
  url: string;
  noProxyHost: string;
  redactedConfigPath: string;
}

/**
 * Tear down a session's signing-proxy state when its container exits: tombstone
 * its tokens (so a leaked token dies with the container, not at TTL) and remove
 * the redacted config file. Always safe to call — revoke is a no-op when there
 * are no live tokens, and is cheap. Never throws into the exit handler.
 */
function cleanupSigningProxyForSession(sessionId: string, signingProxy?: SpawnSigningProxy): void {
  try {
    revokeProxyTokensForSession(sessionId);
  } catch (err) {
    log.warn('Failed to revoke signing-proxy tokens on container exit', { sessionId, err });
  }
  if (signingProxy) {
    try {
      fs.rmSync(signingProxy.redactedConfigPath, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Host-only directory holding per-session redacted container.json files. */
function proxyRuntimeDir(): string {
  return path.join(DATA_DIR, 'v2-proxy-runtime');
}

/** Host-only path for a session's redacted container.json (not mounted RW). */
export function redactedConfigPathFor(sessionId: string): string {
  const fname = `${crypto.createHash('sha1').update(sessionId).digest('hex')}.container.json`;
  return path.join(proxyRuntimeDir(), fname);
}

/**
 * Boot-time signing-proxy cleanup (ADR-0034). The host has just (re)started and
 * cleanupOrphans() has reaped any prior containers, so no container can
 * legitimately hold a proxy token or own a redacted config. Revoke every live
 * token (a leaked token must not outlive its container across a restart up to
 * its TTL) and clear the stale redacted-config directory. No-op when the proxy
 * is disabled, so default-OFF stays byte-for-byte unchanged.
 */
export function cleanupProxyRuntimeOnBoot(): void {
  if (!gatewaySigningProxyEnabled()) return;
  try {
    const revoked = revokeAllProxyTokens();
    if (revoked > 0) log.warn('Revoked orphaned signing-proxy tokens at startup', { count: revoked });
  } catch (err) {
    log.warn('Failed to revoke signing-proxy tokens at startup', { err });
  }
  try {
    fs.rmSync(proxyRuntimeDir(), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Produce the container-facing (redacted) view of a group's container config
 * for proxy mode. Strips the signing key (the whole point) AND blanks the
 * backend baseUrl. Pure + exported for testing.
 *
 * Blanking baseUrl makes fail-closed STRUCTURAL rather than code-discipline: if
 * the container ever reaches the DIRECT branch (proxy env missing), it has no
 * key to sign with AND no target to hit, so callGateway's
 * `!proxy && !gateway?.baseUrl` guard fires GATEWAY_NOT_CONFIGURED instead of
 * sending an UNSIGNED request to the real backend. The host proxy resolves the
 * real baseUrl host-side, so the container never needs it in proxy mode.
 */
export function redactContainerConfigForContainer(
  containerConfig: import('./container-config.js').ContainerConfig,
): import('./container-config.js').ContainerConfig {
  const clone = JSON.parse(JSON.stringify(containerConfig)) as import('./container-config.js').ContainerConfig;
  if (clone.backendGateway) {
    delete clone.backendGateway.signingKey;
    clone.backendGateway.baseUrl = '';
  }
  return clone;
}

/**
 * Write the redacted container.json to a host-only path. This is what gets
 * mounted into the container in proxy mode — the real container.json (with the
 * key + baseUrl, which the host proxy reads to sign) stays only on the host.
 * Returns the redacted path.
 */
function writeRedactedContainerConfig(
  sessionId: string,
  containerConfig: import('./container-config.js').ContainerConfig,
): string {
  const out = redactedConfigPathFor(sessionId);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(redactContainerConfigForContainer(containerConfig), null, 2) + '\n');
  return out;
}

/**
 * Resolve the signing-proxy context for a spawn, or undefined to leave behavior
 * unchanged. Engages only when the proxy is enabled AND the group has a
 * signingKey worth protecting — a group with no key has nothing to withhold, so
 * we skip the redaction + token machinery entirely (zero behavior change).
 */
function resolveSpawnSigningProxy(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): SpawnSigningProxy | undefined {
  if (!containerConfig.backendGateway?.signingKey?.trim()) return undefined;
  const minted = mintSessionProxyToken(session.id, agentGroup.id);
  if (!minted) return undefined; // proxy disabled
  const redactedConfigPath = writeRedactedContainerConfig(session.id, containerConfig);
  return {
    token: minted.token,
    url: minted.url,
    noProxyHost: minted.noProxyHost,
    redactedConfigPath,
  };
}

/**
 * Merge `additions` into any existing NO_PROXY / no_proxy `-e` entries already
 * pushed onto the docker args (e.g. by the OneCLI gateway or a provider), then
 * append overriding `-e NO_PROXY` / `-e no_proxy` so the merged set wins
 * (docker uses the last `-e` for a given key). Pure + exported for testing.
 *
 * Why this matters (ADR-0034): the OneCLI gateway injects HTTP(S)_PROXY so the
 * container's outbound API calls route through the credential vault. Bun's
 * fetch honors those proxy env vars — so without host.docker.internal in
 * NO_PROXY, the container's call to THIS proxy would be tunneled through the
 * vault and never arrive. NO_PROXY is therefore a hard precondition, not a
 * nicety.
 */
export function mergeNoProxyArgs(args: string[], additions: string[]): string[] {
  const values = new Set<string>();
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '-e') continue;
    const m = /^(?:NO_PROXY|no_proxy)=(.*)$/.exec(args[i + 1]);
    if (!m) continue;
    for (const v of m[1].split(',')) {
      const t = v.trim();
      if (t) values.add(t);
    }
  }
  for (const a of additions) {
    const t = a.trim();
    if (t) values.add(t);
  }
  const merged = [...values].join(',');
  args.push('-e', `NO_PROXY=${merged}`, '-e', `no_proxy=${merged}`);
  return args;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
  signingProxy?: SpawnSigningProxy,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Resource limits (multi-tenant safety net). Fields are opt-in in
  // container.json; when missing, Docker defaults to unlimited.
  const resources = containerConfig.resources;
  if (resources?.memoryMb != null) {
    args.push(`--memory=${resources.memoryMb}m`);
    // Equal swap cap prevents the kernel from trading memory pressure for
    // OOM silence; without it a runaway agent can consume host swap.
    args.push(`--memory-swap=${resources.memoryMb}m`);
  }
  if (resources?.cpus != null) {
    args.push(`--cpus=${resources.cpus}`);
  }
  if (resources?.pidsLimit != null) {
    args.push(`--pids-limit=${resources.pidsLimit}`);
  }

  // Environment — only vars read by code we don't own.
  // Everything else platform-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);
  // Brand namespace — lets the runner derive the same MCP server name and
  // signing-header prefix the host uses. Defaults to `agentdesk` in the
  // runner if unset.
  args.push('-e', `BRAND_NAMESPACE=${PLATFORM_PROTOCOL_NAMESPACE}`);

  // Tracing context (ADR-0026/0027) — inject OTEL_TRACEPARENT (+ endpoint,
  // tracestate, capture-content) so the runner continues the host trace.
  // MUST be pushed here, with the other `-e` vars and BEFORE the image tag:
  // docker treats every token after the image name as arguments to the
  // entrypoint, so a `-e` appended past `imageTag` is silently dropped from
  // the container env and handed to bash as positional junk instead. The
  // carrier is populated from the currently-active host span; when there is
  // no active trace, injectTraceContext + buildRunnerTracingEnvArgs both
  // no-op and nothing trace-related is added.
  const traceCarrier: Record<string, string> = {};
  injectTraceContext(traceCarrier);
  args.push(...buildRunnerTracingEnvArgs(traceCarrier, process.env));

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection. Providers
  // that receive their own direct credentials (openai/codex)
  // or are fully offline (mock) don't need the gateway to spawn.
  if (provider === 'openai' || provider === 'codex' || provider === 'mock') {
    log.info('Skipping OneCLI gateway for direct-credential provider', {
      containerName,
      provider,
    });
  } else {
    // Treated as a transient hard failure: if we can't wire the gateway, we
    // don't spawn. The caller (router or host-sweep) catches the throw,
    // leaves the inbound message pending, and the next sweep tick retries.
    if (agentIdentifier) {
      await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    }
    const onecliApplied = await onecli.applyContainerConfig(args, {
      addHostMapping: false,
      agent: agentIdentifier,
    });
    if (!onecliApplied) {
      throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
    }
    log.info('OneCLI gateway applied', { containerName });
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Least-privilege hardening (ADR-0029). Kept next to the --user mapping
  // because it's the same "the agent runs deprivileged" concern. Pure helper
  // so the flag shape is unit-testable without spinning the full builder.
  args.push(...buildSecurityArgs(process.env));

  // Egress lockdown (ADR-0032). Opt-in `--network` — per-group container.json
  // `network` wins over the global `AGENT_CONTAINER_NETWORK`; unset means no
  // flag at all (docker default bridge = unrestricted egress, the historical
  // behavior). The value is allowlist-validated inside the helper; an invalid
  // value is dropped with a warning, never forwarded into the argv. MUST sit
  // here in the docker-flag region (before the image tag), same as the
  // security/OTEL flags — a `--network` after the image would be handed to the
  // entrypoint instead of parsed by docker.
  args.push(...buildNetworkArgs(containerConfig, process.env));

  // Signing credential proxy (ADR-0034). Inject the proxy URL + per-session
  // token, and merge host.docker.internal into NO_PROXY so the container's call
  // to the proxy bypasses the OneCLI vault HTTP(S)_PROXY. MUST be after the
  // OneCLI/provider env pushes (so the merge sees their NO_PROXY) and, like all
  // `-e` vars, BEFORE the image tag. When proxy mode is off, signingProxy is
  // undefined and nothing is added — byte-for-byte the prior behavior.
  if (signingProxy) {
    args.push('-e', `AGENTDESK_GATEWAY_PROXY_URL=${signingProxy.url}`);
    args.push('-e', `AGENTDESK_GATEWAY_PROXY_TOKEN=${signingProxy.token}`);
    mergeNoProxyArgs(args, [signingProxy.noProxyHost]);
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint + image + command. Done via a pure helper so the
  // load-bearing ordering invariant (all `-e` env vars precede the image tag)
  // is unit-testable without spinning the full builder. Everything pushed to
  // `args` above — including the OTEL tracing env — is the docker-flag region;
  // the image tag and everything after it are entrypoint arguments.
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  appendImageAndCommand(args, imageTag);

  return args;
}

/**
 * Whitelist for `--network` values (ADR-0032 egress lockdown). Two accepted
 * shapes:
 *
 *   1. The built-in network modes `none` / `host` / `bridge` (literal).
 *   2. A user-defined Docker network NAME matching docker's own naming rule:
 *      `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` — same pattern we already use to gate
 *      container names in container-runtime.ts. This excludes spaces, `=`,
 *      leading `-` (which docker would parse as a flag), and any shell/argv
 *      metacharacter, so a validated value can never inject extra arguments
 *      into the docker invocation.
 *
 * Anything else (empty, `container:<id>` indirection, `--`-prefixed, or with
 * hostile characters) is rejected. We deliberately do NOT accept the
 * `container:<name|id>` form: it is rarely needed for agent containers and
 * the `:` would otherwise widen the accepted character set.
 */
const CONTAINER_NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function isValidContainerNetwork(value: string): boolean {
  return CONTAINER_NETWORK_NAME.test(value);
}

/**
 * Resolve the effective `--network` value for a container, or `undefined` to
 * leave docker on its default (`bridge`) — i.e. unrestricted egress, the
 * pre-ADR-0032 behavior. Pure + exported so the precedence and the
 * injection-safety gate are unit-testable without a container runtime.
 *
 * Precedence (most specific wins):
 *   1. per-group `container.json` `network`
 *   2. global `AGENT_CONTAINER_NETWORK` env var
 *   3. unset → `undefined` (no flag, docker default bridge)
 *
 * Hard rule (CLAUDE.md / ADR-0032): default is NO restriction. We only ever
 * emit `--network` when an operator opted in. A configured-but-invalid value
 * is treated as "operator typo": we WARN and fall back to the default network
 * rather than (a) forwarding an unvalidated string into the docker argv or
 * (b) failing the spawn. Falling back to the permissive default keeps the
 * backward-compat / "never cut off the agent by accident" promise.
 */
export function resolveContainerNetwork(config: { network?: string }, env: NodeJS.ProcessEnv): string | undefined {
  const raw = (config.network ?? env.AGENT_CONTAINER_NETWORK ?? '').trim();
  if (!raw) return undefined;
  if (!isValidContainerNetwork(raw)) {
    log.warn('Ignoring invalid container network value — falling back to default (bridge)', {
      value: raw,
      source: config.network ? 'container.json' : 'AGENT_CONTAINER_NETWORK',
    });
    return undefined;
  }
  return raw;
}

/**
 * Build the `--network <value>` docker args for the agent container, or `[]`
 * when no valid network is configured. Pure + exported so the ordering
 * invariant (must precede the image tag) is unit-testable. See
 * `resolveContainerNetwork` for precedence + validation.
 */
export function buildNetworkArgs(config: { network?: string }, env: NodeJS.ProcessEnv): string[] {
  const network = resolveContainerNetwork(config, env);
  return network ? ['--network', network] : [];
}

/**
 * Build the least-privilege docker security flags for the agent container
 * (ADR-0029). Pure + exported so the conservative defaults are unit-testable.
 *
 * Two layers, deliberately asymmetric in default:
 *
 *  1. `--security-opt=no-new-privileges:true` — ALWAYS on. This only blocks
 *     `execve` from gaining privileges via setuid/setgid binaries or file
 *     capabilities. The agent already runs deprivileged (Dockerfile `USER
 *     node`, runtime `--user hostUid:hostGid`), so it has no privileges to
 *     escalate to in the first place; chromium in a non-root container does
 *     not use its setuid sandbox helper (it falls back to the userns/seccomp
 *     sandbox), and agent-browser/Playwright, bun, git, curl and outbound
 *     HTTP all run as the unprivileged user — none of them rely on a setuid
 *     transition. So this flag costs us nothing and shrinks the escalation
 *     surface. See the browsing-path review in ADR-0029.
 *
 *  2. `--cap-drop` — OPT-IN ONLY, default off. Dropping Linux capabilities is
 *     higher risk: a wrong drop could silently break the browser or network
 *     in ways that only surface at runtime, and this batch's hard rule is
 *     "never break the running chromium browsing path". So we leave the
 *     kernel/Docker default capability set untouched unless an operator
 *     explicitly sets `AGENT_DROP_CAPS`. The value is a comma/space-separated
 *     list of capabilities to drop (e.g. `NET_RAW,NET_ADMIN`), each emitted as
 *     its own `--cap-drop=<CAP>`. Operators who have validated their workload
 *     can tighten this; the platform ships zero-risk.
 */
export function buildSecurityArgs(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = ['--security-opt=no-new-privileges:true'];

  const dropCaps = (env.AGENT_DROP_CAPS ?? '')
    .split(/[,\s]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  for (const cap of dropCaps) {
    args.push(`--cap-drop=${cap}`);
  }

  return args;
}

/**
 * Append the entrypoint override, image tag, and launch command to an
 * already-assembled docker-flag list. Pure + exported for unit testing.
 *
 * Docker arg grammar: `docker run [flags] IMAGE [cmd...]`. Every token after
 * IMAGE is passed to the container's entrypoint, NOT parsed as a docker flag.
 * So any `-e KEY=VALUE` must live in `flagArgs` (before this call). This helper
 * exists to lock that boundary: callers build all `-e`/`-v`/`--*` flags first,
 * then call this exactly once to seal the image + command tail.
 */
export function appendImageAndCommand(flagArgs: string[], imageTag: string): string[] {
  // Run the v2 entry point directly via Bun (no tsc, no stdin).
  flagArgs.push('--entrypoint', 'bash');
  flagArgs.push(imageTag);
  flagArgs.push('-c', 'exec bun run /app/src/index.ts');
  return flagArgs;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const containerConfig = readContainerConfig(agentGroup.folder);
  const aptPackages = containerConfig.packages.apt;
  const npmPackages = containerConfig.packages.npm;

  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 300_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in groups/<folder>/container.json
  containerConfig.imageTag = imageTag;
  writeContainerConfig(agentGroup.folder, containerConfig);

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
