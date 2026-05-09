/**
 * Minimal Prometheus metrics surface.
 *
 * Scoped to the four signals most useful for diagnosing enterprise-scale
 * concurrency problems:
 *
 *   - nanoclaw_inbound_total{channel,outcome}
 *       webhook/long-connection ingress counter. `outcome` is one of
 *       `accepted` | `deduped` | `rejected`.
 *
 *   - nanoclaw_session_count{agent_group}
 *       gauge of active sessions per agent group. Sampled by the host sweep.
 *
 *   - nanoclaw_route_seconds{phase}
 *       histogram of router-side phase latencies. `phase` is `route` (full
 *       routeInbound duration) or `wake` (wakeContainer duration).
 *
 *   - nanoclaw_provider_errors_total{provider,code}
 *       container-provider error counter. Emitted via the delivery path when
 *       the container reports an error; left at zero when nothing registers.
 *
 * The /metrics endpoint is attached to the shared webhook server so it
 * lives at the same port as adapters' callbacks.
 */
import http from 'http';

import client from 'prom-client';

import { log } from './log.js';

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const inboundTotal = new client.Counter({
  name: 'nanoclaw_inbound_total',
  help: 'Inbound message events by channel + outcome',
  labelNames: ['channel', 'outcome'] as const,
  registers: [registry],
});

export const sessionCount = new client.Gauge({
  name: 'nanoclaw_session_count',
  help: 'Active session count per agent group',
  labelNames: ['agent_group'] as const,
  registers: [registry],
});

export const routeSeconds = new client.Histogram({
  name: 'nanoclaw_route_seconds',
  help: 'Router-side latency by phase',
  labelNames: ['phase'] as const,
  // Cover webhook-response budgets (<1s) through stuck-container timeouts.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

export const providerErrorsTotal = new client.Counter({
  name: 'nanoclaw_provider_errors_total',
  help: 'Container-provider errors by provider + code',
  labelNames: ['provider', 'code'] as const,
  registers: [registry],
});

export function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export function metricsContentType(): string {
  return registry.contentType;
}

/** Returns a function that records elapsed seconds when called. */
export function startTimer(phase: string): () => void {
  const end = routeSeconds.startTimer({ phase });
  return () => {
    end();
  };
}

/**
 * Attach GET /metrics to the shared webhook server. Separate module so the
 * webhook server doesn't depend on prom-client directly.
 */
export async function handleMetricsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }
  try {
    const body = await renderMetrics();
    res.writeHead(200, { 'Content-Type': metricsContentType() });
    res.end(body);
  } catch (err) {
    log.error('Metrics render failed', { err });
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  }
}
