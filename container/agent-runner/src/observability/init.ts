/**
 * Runner-side OpenTelemetry bootstrap (ADR-0026).
 *
 * Pure side-car tracing. This module is imported as the FIRST import of every
 * runner process entrypoint (`src/index.ts` for the poll loop, and
 * `src/mcp-tools/index.ts` for the MCP tool server, which the SDK spawns as a
 * separate `bun run` process). It must never throw, never block, and never
 * touch the message flow / identity chain / SQLite stores.
 *
 * Activation contract (fail-open, opt-in only when the host opted in):
 *   - If `OTEL_SDK_DISABLED === 'true'`            -> do nothing, return false.
 *   - If `OTEL_TRACEPARENT` is absent              -> do nothing, return false.
 *     (The host only injects OTEL_TRACEPARENT when host tracing is live, so
 *      "no traceparent" means "host has tracing off" -> stay a pure no-op.
 *      OTel API calls then return non-recording noop spans, so the
 *      instrumentation in tracer.ts costs nothing.)
 *   - Otherwise start a NodeSDK with an OTLP/proto exporter pointed at the
 *     host endpoint and continue the host's trace via OTEL_TRACEPARENT.
 *
 * No auto-instrumentations-node: it bloats the image and we only want the
 * three manual span classes (agent.turn / provider.request / mcp.*).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';

import { PLATFORM_PROTOCOL_NAMESPACE } from '../branding.js';

// The host rewrites localhost -> host.docker.internal before injecting the
// endpoint env, but keep a sane container-reachable default for the case where
// only OTEL_TRACEPARENT was injected (older host) — the container cannot reach
// the host's loopback, only host.docker.internal.
const DEFAULT_TRACES_ENDPOINT = 'http://host.docker.internal:6006/v1/traces';
const DEFAULT_SERVICE_NAME = `${PLATFORM_PROTOCOL_NAMESPACE}-runner`;
const DEFAULT_SERVICE_VERSION = '2.0.0';

let _sdk: NodeSDK | null = null;
let _started = false;

function log(msg: string): void {
  console.error(`[runner-otel] ${msg}`);
}

/**
 * Returns true when the host opted this runner process into tracing.
 * Exported so unit tests can assert the gating logic without starting an SDK.
 */
export function shouldInitObservability(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OTEL_SDK_DISABLED === 'true') return false;
  // No host trace context => host tracing is off => stay a pure no-op.
  if (!env.OTEL_TRACEPARENT) return false;
  return true;
}

/**
 * Idempotent. Returns true if the SDK was started (or already running), false
 * if tracing is intentionally inactive or bootstrap failed. NEVER throws.
 */
export function initRunnerObservability(env: NodeJS.ProcessEnv = process.env): boolean {
  if (_started) return _sdk !== null;
  _started = true;

  if (!shouldInitObservability(env)) {
    return false;
  }

  try {
    const traceExporter = new OTLPTraceExporter({
      url: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || DEFAULT_TRACES_ENDPOINT,
    });

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: DEFAULT_SERVICE_VERSION,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env.NODE_ENV || 'production',
    });

    _sdk = new NodeSDK({ traceExporter, resource });
    _sdk.start();
    log(`tracing active -> ${env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || DEFAULT_TRACES_ENDPOINT}`);

    // Flush on clean exit. Fire-and-forget by design: never block container
    // teardown, never reject. Unreachable endpoint is the exporter's problem,
    // handled async internally.
    process.once('beforeExit', () => {
      void _sdk?.shutdown().catch(() => {});
    });

    return true;
  } catch (err) {
    // Fail-open: a tracing bootstrap failure must not stop the runner.
    log(`bootstrap failed, continuing without tracing: ${err instanceof Error ? err.message : String(err)}`);
    _sdk = null;
    return false;
  }
}

// Auto-init on import so entrypoints just need `import './observability/init.js'`
// as their first line. The gating inside keeps it a no-op when host tracing is off.
initRunnerObservability();
