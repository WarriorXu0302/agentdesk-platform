/**
 * Minimal Prometheus metrics surface.
 *
 * Scoped to the four signals most useful for diagnosing enterprise-scale
 * concurrency problems:
 *
 *   - <namespace>_inbound_total{channel,outcome}
 *       webhook/long-connection ingress counter. `outcome` is one of
 *       `accepted` | `deduped` | `rejected`.
 *
 *   - <namespace>_session_count{agent_group,status}
 *       gauge of sessions per agent group, grouped by lifecycle status
 *       (active / archived / closed). Sampled by the host sweep.
 *
 *   - <namespace>_session_lifecycle_total{action}
 *       counter of session lifecycle transitions applied by the sweep.
 *       `action` is `archived` or `hard_deleted`.
 *
 *   - <namespace>_wake_rejected_total{reason}
 *       counter of wake requests the host refused to spawn (e.g. global
 *       concurrency cap hit). Host sweep retries the underlying session
 *       on its next tick, so this metric measures back-pressure, not
 *       permanent failure.
 *
 *   - <namespace>_route_seconds{phase}
 *       histogram of router-side phase latencies. `phase` is `route` (full
 *       routeInbound duration) or `wake` (wakeContainer duration).
 *
 *   - <namespace>_provider_errors_total{provider,code}
 *       container-provider error counter. Emitted via the delivery path when
 *       the container reports an error; left at zero when nothing registers.
 *
 *   - <namespace>_classifications_total{action}
 *       counter of frontdesk classify_intent calls by declared action.
 *
 *   - <namespace>_classification_bypass_total{reason,surface}
 *       counter of agent-destination deliveries (or clarifications) that
 *       had no matching prior classify_intent call. Persistent non-zero
 *       rate means frontdesk is skipping the REQUIRED tool and silently
 *       routing — fail-open observability for the classification
 *       protocol.
 *
 *   - <namespace>_classification_log_failures_total{reason}
 *       classification rows lost to DB write errors. Alert on non-zero.
 *
 * The /metrics endpoint is attached to the shared webhook server so it
 * lives at the same port as adapters' callbacks.
 */
import http from 'http';

import client from 'prom-client';

import { METRIC_PREFIX } from './branding.js';
import { log } from './log.js';

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const inboundTotal = new client.Counter({
  name: `${METRIC_PREFIX}_inbound_total`,
  help: 'Inbound message events by channel + outcome',
  labelNames: ['channel', 'outcome'] as const,
  registers: [registry],
});

export const sessionCount = new client.Gauge({
  name: `${METRIC_PREFIX}_session_count`,
  help: 'Session count per agent group and lifecycle status',
  labelNames: ['agent_group', 'status'] as const,
  registers: [registry],
});

export const sessionLifecycleTotal = new client.Counter({
  name: `${METRIC_PREFIX}_session_lifecycle_total`,
  help: 'Session lifecycle transitions applied by the sweep',
  labelNames: ['action'] as const,
  registers: [registry],
});

export const classificationsTotal = new client.Counter({
  name: `${METRIC_PREFIX}_classifications_total`,
  help: 'Frontdesk classification events by the agent-declared action',
  // `action`: delegate | clarify | reject | answer_self. Lets dashboards
  // show the routing mix at a glance and notice skew (e.g. a sudden
  // drop in `clarify` often means the frontdesk started over-trusting
  // a prompt change).
  labelNames: ['action'] as const,
  registers: [registry],
});

export const classificationBypassTotal = new client.Counter({
  name: `${METRIC_PREFIX}_classification_bypass_total`,
  help: 'Routing actions that lacked a matching prior classify_intent call',
  // `reason`:
  //   - `no_classification_id`   : send_message/ask_user_question
  //                                 did not pass classificationId
  //   - `classification_not_found`: id passed but not in the log
  //   - `action_mismatch`        : classification said e.g. clarify but
  //                                 the actual outbound was an a2a send
  // `surface`: agent_send | channel_send | ask_user_question
  labelNames: ['reason', 'surface'] as const,
  registers: [registry],
});

export const classificationLogFailuresTotal = new client.Counter({
  name: `${METRIC_PREFIX}_classification_log_failures_total`,
  help: 'Classification log writes that failed (DB error, etc.)',
  // Dashboard panel for this should alert on any non-zero rate — the
  // table is the regression corpus, silent drops here invalidate later
  // analysis.
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const wakeRejectedTotal = new client.Counter({
  name: `${METRIC_PREFIX}_wake_rejected_total`,
  help: 'Container wake requests rejected without spawning',
  // `reason` is currently only `capacity` (global cap reached) but kept as
  // a label so future rejection reasons (per-group cap, OneCLI unreachable
  // short-circuit, etc.) can slot in without renaming the metric.
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const containerExitsTotal = new client.Counter({
  name: `${METRIC_PREFIX}_container_exits_total`,
  help: 'Container exit events by outcome',
  // `outcome`:
  //   - `idle`   : container exit code 0, likely idle-exit (needs
  //                 correlation with poll-loop logs to be certain)
  //   - `crash`  : non-zero exit code
  //   - `killed` : host-side killContainer via absolute-ceiling or
  //                 claim-stuck
  labelNames: ['agent_group', 'outcome'] as const,
  registers: [registry],
});

export const routeSeconds = new client.Histogram({
  name: `${METRIC_PREFIX}_route_seconds`,
  help: 'Router-side latency by phase',
  labelNames: ['phase'] as const,
  // Cover webhook-response budgets (<1s) through stuck-container timeouts.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

export const providerErrorsTotal = new client.Counter({
  name: `${METRIC_PREFIX}_provider_errors_total`,
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
