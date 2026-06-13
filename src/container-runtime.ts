/**
 * Container runtime abstraction for the platform.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFile, execSync } from 'child_process';
import os from 'os';
import { promisify } from 'util';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

/**
 * Hard ceiling on a single `docker stop`. `-t 1` lets the agent SIGTERM-exit in
 * ~1s; this bounds the pathological case where dockerd itself is stopping/hung
 * (common during a host reboot, exactly when our SIGTERM arrives) so a stop call
 * can never wedge forever.
 */
const STOP_TIMEOUT_MS = 5000;

/**
 * The container runtime binary name. Respects the same `CONTAINER_RUNTIME`
 * env var as `container/build.sh` so build and wake target one runtime.
 */
export const CONTAINER_RUNTIME_BIN = process.env.CONTAINER_RUNTIME || 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name (synchronous). Bounded so a hung daemon can't wedge
 *  the caller forever. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe', timeout: STOP_TIMEOUT_MS });
}

/**
 * Async, bounded container stop — does NOT block the event loop, so many can run
 * concurrently and a wrapping shutdown deadline timer can still fire. Use this
 * (not the sync stopContainer in a loop) when stopping a batch of containers,
 * e.g. graceful shutdown. Rejects on timeout/error; callers Promise.allSettle.
 */
export async function stopContainerAsync(name: string): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  await execFileAsync(CONTAINER_RUNTIME_BIN, ['stop', '-t', '1', name], { timeout: STOP_TIMEOUT_MS });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart the host                                          ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned agent containers from THIS install's previous runs.
 *
 * Scoped by label `<namespace>-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
