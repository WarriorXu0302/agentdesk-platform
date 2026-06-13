import { initObservability, shutdownObservability } from './observability/init.js';

/**
 * Agent platform host — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { PLATFORM_NAME } from './branding.js';
import { DATA_DIR } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { checkBaseImage, cleanupProxyRuntimeOnBoot } from './container-runner.js';
import { validateStartupConfig } from './config-validate.js';
import { checkGatewaySigningCoverage } from './gateway-signing-check.js';
import { startGatewaySigningProxy, stopGatewaySigningProxy } from './gateway-signing-proxy.js';
import { surfaceOrphanedIngress } from './ingress-recovery-check.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import {
  startActiveDeliveryPoll,
  startSweepDeliveryPoll,
  setDeliveryAdapter,
  stopDeliveryPolls,
  drainInflightDeliveries,
} from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { routeInbound } from './router.js';
import { log } from './log.js';
import { ensureMetricsServer, stopWebhookServer } from './webhook-server.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';
import { loadChannelExtensions } from './channels/extension-loader.js';

async function main(): Promise<void> {
  log.info(`${PLATFORM_NAME} starting`);

  // 0. Observability — must be first, before any async work
  initObservability();

  // 0b. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();
  // 2b. Config safety gate (ADR-0025) — fail fast on an internally inconsistent
  //     deployment (feature enabled but its required secrets missing) and on
  //     known-weak placeholder secrets in the trust chain. Conservative: only
  //     fires for features that are actually enabled, so a minimal CLI-only /
  //     claude-only deploy is unaffected. Runs before any connections open.
  validateStartupConfig();
  checkBaseImage();
  checkGatewaySigningCoverage();
  // Host signing credential proxy (ADR-0034). Default OFF. When enabled, signs
  // backend-gateway requests on behalf of containers so the signingKey never
  // enters a container. Needs the central DB ready (token store), so it starts
  // here. A bind failure is non-fatal but makes proxy-mode containers
  // fail-closed (they have no key to fall back to). Boot cleanup first: revoke
  // tokens orphaned by a prior crash/restart and clear stale redacted configs
  // (cleanupOrphans above has already reaped their containers).
  cleanupProxyRuntimeOnBoot();
  startGatewaySigningProxy();
  // Report inbound envelopes left unrecovered by a prior crash/route failure
  // (ADR-0022). Read-only — never auto-replays (that would bypass adapter-layer
  // dedup); remediation is the explicit replay CLI.
  surfaceOrphanedIngress();

  // 3. Channel adapters
  // 3a. Fork-free channel extensions (ADR-0031) — let operator-controlled
  //     adapters under EXTENSIONS_DIR self-register BEFORE initChannelAdapters
  //     so they get set up identically to the in-tree cli/feishu. fail-open:
  //     a bad extension is logged + skipped, never crashes startup. No
  //     EXTENSIONS_DIR ⇒ no-op (backward compatible).
  await loadChannelExtensions();
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
    // Roster-DM send-time membership re-check (ADR-0023 item 12). Delegates to
    // the channel adapter's optional isMember; absence → undefined (unknown).
    async isMember(channelType: string, platformId: string, userHandle: string): Promise<boolean | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter?.isMember) return undefined;
      return adapter.isMember(platformId, userHandle);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 7. Ensure /metrics is reachable even when no webhook adapter is loaded
  //    (e.g. Feishu long-connection mode, CLI-only setups).
  ensureMetricsServer();

  log.info(`${PLATFORM_NAME} running`);
}

/** Ordered graceful-shutdown steps. Wrapped in a hard deadline by `shutdown`. */
async function runShutdownSteps(): Promise<void> {
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  // Order matters: stop accepting first (close the listener), THEN stop the
  // poll loops, THEN drain. If we drained before closing the listener, a fresh
  // webhook could enqueue outbound work mid-drain and the wait would never
  // settle cleanly. Stopping ingress first bounds the in-flight set.
  try {
    await stopWebhookServer();
  } catch (err) {
    log.error('Webhook server stop threw', { err });
  }
  try {
    await stopGatewaySigningProxy();
  } catch (err) {
    log.error('Gateway signing proxy stop threw', { err });
  }
  stopDeliveryPolls();
  stopHostSweep();
  // Let any drain caught mid-flight persist its markDelivered row before we
  // exit, shrinking the ADR-0016 duplicate window (see drainInflightDeliveries).
  await drainInflightDeliveries();
  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    await shutdownObservability();
  }
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  // Hard deadline: no single step (a hung webhook connection, a stuck adapter
  // teardown) may block exit indefinitely. Keep this below the orchestrator's
  // terminationGracePeriod (k8s default 30s) so we exit cleanly before SIGKILL,
  // which would otherwise skip the delivery drain entirely.
  const deadlineMs = parseInt(process.env.SHUTDOWN_DEADLINE_MS || '20000', 10);
  const deadline = new Promise<void>((resolve) => {
    const t = setTimeout(
      () => {
        log.warn('Shutdown deadline hit — forcing exit', { deadlineMs });
        resolve();
      },
      Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 20000,
    );
    t.unref?.();
  });
  try {
    await Promise.race([runShutdownSteps(), deadline]);
  } catch (err) {
    log.error('Shutdown threw', { err });
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
