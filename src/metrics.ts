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
 *   - <namespace>_delivery_failures_total{reason}
 *       failed outbound delivery attempts (per attempt). `reason` is
 *       `timeout` or `error`.
 *
 *   - <namespace>_delivery_retries_total
 *       delivery retries scheduled with persisted backoff (ADR-0016).
 *
 *   - <namespace>_delivery_permanent_failures_total
 *       messages whose automatic retries are exhausted — DLQ candidates.
 *
 *   - <namespace>_inbound_ingress_failed_total{channel}
 *       inbound envelopes that threw in routeInbound AFTER being persisted to
 *       the ingress recovery ledger (ADR-0022). The row is kept at
 *       status='failed' for operator inspection/replay via
 *       scripts/replay-inbound.ts. Alert on any non-zero rate — these are
 *       messages that would otherwise have vanished silently.
 *
 * The /metrics endpoint is attached to the shared webhook server so it
 * lives at the same port as adapters' callbacks.
 */
import crypto from 'crypto';
import http from 'http';

import client from 'prom-client';

import { METRIC_PREFIX } from './branding.js';
import { readEnvFile } from './env.js';
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

export const agentBaseImagePresent = new client.Gauge({
  name: `${METRIC_PREFIX}_agent_base_image_present`,
  help: 'Base agent image present locally at last boot precheck (1 = present, 0 = missing — agents cannot spawn until built)',
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

export const deliveryFailuresTotal = new client.Counter({
  name: `${METRIC_PREFIX}_delivery_failures_total`,
  help: 'Failed outbound delivery attempts by reason',
  // `reason`:
  //   - `timeout` : adapter call exceeded DELIVERY_TIMEOUT_MS. Note the
  //                 underlying send may still have landed — see ADR-0016's
  //                 at-least-once duplicate window.
  //   - `error`   : adapter threw, destination permission check failed,
  //                 or a2a routing failed.
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const deliveryRetriesTotal = new client.Counter({
  name: `${METRIC_PREFIX}_delivery_retries_total`,
  help: 'Outbound delivery retries scheduled with persisted backoff',
  registers: [registry],
});

export const deliveryPermanentFailuresTotal = new client.Counter({
  name: `${METRIC_PREFIX}_delivery_permanent_failures_total`,
  help: 'Outbound messages whose automatic delivery retries are exhausted',
  // Alert on non-zero rate: these rows sit in the session's delivered table
  // with status='failed' until an operator inspects/requeues them via
  // scripts/dlq.ts.
  registers: [registry],
});

export const dataDirFreeRatio = new client.Gauge({
  name: `${METRIC_PREFIX}_data_dir_free_ratio`,
  help: 'Free space ratio (0..1) of the filesystem holding DATA_DIR, sampled by the host sweep',
  // Single-host killer: the central DB stays small but long-lived session DBs +
  // inbox attachment dirs grow unbounded (whole-session archival is opt-in/OFF
  // by default), and SQLITE_FULL across the three DBs stalls everything with no
  // prior signal. This gauge is the early-warning safety net — alert well before
  // the volume fills. Deployment-agnostic (ratio, not absolute bytes).
  registers: [registry],
});

export const unhandledRejectionsTotal = new client.Counter({
  name: `${METRIC_PREFIX}_unhandled_rejections_total`,
  help: 'Unhandled promise rejections caught by the process-level handler',
  // The host logs but does not crash on an unhandled rejection (unlike
  // uncaughtException, which exits). A non-zero rate means a promise error is
  // escaping its call site, leaving the host in a possibly half-completed
  // state — alert and investigate the offending async path.
  registers: [registry],
});

export const inboundProcessingPermanentFailuresTotal = new client.Counter({
  name: `${METRIC_PREFIX}_inbound_processing_permanent_failures_total`,
  help: 'Inbound messages whose container-processing retries are exhausted (host-sweep marked status=failed)',
  // The INBOUND mirror of delivery_permanent_failures_total: a message the
  // container repeatedly crashed/was-killed on (MAX_TRIES sweep resets) is
  // parked at messages_in.status='failed' and never re-polled — the user's
  // request is dropped. Alert on ANY non-zero rate; recover via
  // scripts/requeue-inbound.ts. `agent_group` labels which group's worker is
  // failing so a single broken group is distinguishable from a host-wide issue.
  labelNames: ['agent_group'] as const,
  registers: [registry],
});

export const runawaySessionStopsTotal = new client.Counter({
  name: `${METRIC_PREFIX}_runaway_session_stops_total`,
  help: 'Sessions stopped by host-sweep for blowing past the per-minute token budget (roadmap 7.1)',
  // The heartbeat/claim stuck-checks catch SILENT containers, but an
  // actively-looping agent (prompt-injected or buggy) keeps the heartbeat fresh
  // while burning tokens — invisible to those checks. When an operator sets
  // AGENTDESK_SESSION_TOKEN_BUDGET_PER_MIN>0, a session whose recent LLM spend
  // exceeds it is killed. Default-OFF, so a non-zero value means either a real
  // runaway or a budget set too low for legitimate heavy sessions.
  labelNames: ['agent_group'] as const,
  registers: [registry],
});

export const approvalEventsTotal = new client.Counter({
  name: `${METRIC_PREFIX}_approval_events_total`,
  help: 'Approval decisions resolved (roadmap 5.2), by action + result',
  // `action`: the approval kind (onecli_credential, install_packages, …).
  // `result`: approved | rejected. Pairs with the enterprise_audit
  // `approval_resolved` rows for a queryable + alertable view of who approved
  // what — the audit row is the durable compliance record, this is the metric.
  labelNames: ['action', 'result'] as const,
  registers: [registry],
});

export const escalationTotal = new client.Counter({
  name: `${METRIC_PREFIX}_escalation_total`,
  help: 'Explicit AI→human escalations (ADR-0038, roadmap 2.3) — makes handoff rate / SLA visible vs. plain a2a delegation',
  // `reason`: bucketed escalation reason (free text is bucketed at the host
  //   boundary to bound cardinality; agent reason text lives in the audit row).
  // `urgency`: closed enum low|medium|high|critical|unknown (coerced host-side).
  // `outcome`: recorded (core records the intent; the operator gateway owns the
  //   actual routing/SLA and may report richer outcomes out-of-band).
  // Pairs with the enterprise_audit `agent_escalation` rows. Advisory only —
  // urgency NEVER drives core routing/priority (that is the gateway's job).
  labelNames: ['reason', 'urgency', 'outcome'] as const,
  registers: [registry],
});

export const routingFeedbackTotal = new client.Counter({
  name: `${METRIC_PREFIX}_routing_feedback_total`,
  help: 'Worker routing feedback (ADR-0040, roadmap 2.1 misroute + 2.5 nack) — makes misroute/nack rate visible; the misroute confusion matrix is built from classification_log SQL, not this metric',
  // `kind`: closed enum misroute|nack|unknown (coerced host-side).
  // `reported_by`: the worker agent_group_id that raised the feedback — bounded
  //   to the operator's configured agent-group set (like a2a metrics use a group
  //   id, not a free string).
  // Deliberately NO `suggested`/reason label: the worker's suggested-target is
  // free text and even bucketed can blow up cardinality; its full value lives in
  // classification_log.recommended_worker for dashboard queries (ADR-0040).
  // Advisory only — feedback NEVER drives core routing (real reroute is the
  // operator gateway's job; active reroute was rejected in ADR-0040).
  labelNames: ['kind', 'reported_by'] as const,
  registers: [registry],
});

export const messagesRoutedTotal = new client.Counter({
  name: `${METRIC_PREFIX}_messages_routed_total`,
  help: 'Per-agent message routing outcomes in the messaging-group fan-out (roadmap 2.6) — makes the engaged-vs-accumulated backlog visible per worker',
  // `agent_group_id`: the wired worker that made the decision — bounded to the
  //   operator's configured roster (same cardinality basis as
  //   routing_feedback_total{reported_by}).
  // `outcome`: closed enum engaged|accumulated|dropped. `accumulated` = the
  //   message was stored as silent context (ignored_message_policy='accumulate')
  //   WITHOUT waking the container, so a rising accumulated rate for a worker is
  //   a growing silent backlog the operator otherwise couldn't see. `dropped` =
  //   engage didn't fire and the policy is 'drop'.
  labelNames: ['agent_group_id', 'outcome'] as const,
  registers: [registry],
});

export const providerErrorsTotal = new client.Counter({
  name: `${METRIC_PREFIX}_provider_errors_total`,
  help: 'Container-provider errors by provider + code',
  labelNames: ['provider', 'code'] as const,
  registers: [registry],
});

export const a2aOriginRejectedTotal = new client.Counter({
  name: `${METRIC_PREFIX}_a2a_origin_rejected_total`,
  help: 'A2a messages whose container-claimed origin_user_id failed host-side cross-validation',
  // Alert on non-zero rate: either a prompt-injected agent attempted
  // impersonation, or a legitimate emit path is stamping identities the
  // host cannot verify (both need investigation). See ADR-0017.
  labelNames: ['source_agent_group'] as const,
  registers: [registry],
});

export const engagePatternInvalidTotal = new client.Counter({
  name: `${METRIC_PREFIX}_engage_pattern_invalid_total`,
  help: 'Inbound messages skipped because an agent engage_pattern failed to compile',
  // Non-zero means an agent wiring has a broken regex and is now silent
  // (fail-closed) — fix the pattern to restore the agent.
  labelNames: ['agent_group'] as const,
  registers: [registry],
});

export const policyCheckFailedTotal = new client.Counter({
  name: `${METRIC_PREFIX}_policy_check_failed_total`,
  help: 'Fail-closed policy decisions (ADR-0019), so operators can see whether a guard fires constantly (misconfig) or never (dead policy)',
  // `policy`: which fail-closed guard rejected —
  //   - `command_gate`              : an admin slash-command was denied
  //   - `engage_pattern`            : an agent engage_pattern regex failed to compile
  //   - `approval_operator_identity`: a card action came from an unverified/mismatched operator
  // `reason`: a short machine code for why (e.g. admin_denied, invalid_regex, mismatch, absent).
  labelNames: ['policy', 'reason'] as const,
  registers: [registry],
});

export const inboundIngressFailedTotal = new client.Counter({
  name: `${METRIC_PREFIX}_inbound_ingress_failed_total`,
  help: 'Inbound envelopes that threw in routeInbound after being persisted to the ingress recovery ledger (ADR-0022)',
  // Non-zero means a message was persisted but failed to route (session
  // inbound.db busy, attachment IO, transient central-DB error, etc.). The
  // row is parked at status='failed' for inspection/replay via
  // scripts/replay-inbound.ts — alert on any non-zero rate.
  labelNames: ['channel'] as const,
  registers: [registry],
});

export const gatewayUnsignedGroups = new client.Gauge({
  name: `${METRIC_PREFIX}_gateway_unsigned_groups`,
  help: 'Agent groups with a backend gateway configured but no HMAC signing key',
  registers: [registry],
});

export const webhookRejectedTotal = new client.Counter({
  name: `${METRIC_PREFIX}_webhook_rejected_total`,
  help: 'Ingress requests rejected by the shared webhook server before handler dispatch',
  // `reason`:
  //   - `body_too_large`  : request body exceeded WEBHOOK_MAX_BODY_BYTES (413).
  //   - `unauthorized`    : /metrics scrape missing/mismatched bearer token (401).
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const rosterDmRejectedTotal = new client.Counter({
  name: `${METRIC_PREFIX}_roster_dm_rejected_total`,
  help: 'Roster directed-message sends rejected by the host outbound authorization gate (ADR-0023)',
  // `reason`: no_grant | bad_consent_source | scope_mismatch | revoked |
  //   expired | max_sends | rate_limited | raw_platform_id | not_p2p_open_id |
  //   target_mismatch | flag_disabled | agent_shared_mode | scheduled_or_recurring |
  //   missing_slot | no_adapter | channel_branch_p2p_bypass |
  //   gateway_denied | gateway_target_invalid (item 13) |
  //   not_in_scope (item 12 membership re-check) |
  //   deploy_daily_cap (item 14 blast-radius cap). Any sustained non-zero rate
  //   means an agent is attempting roster DMs it isn't entitled to — investigate.
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const rosterInviteRejectedTotal = new client.Counter({
  name: `${METRIC_PREFIX}_roster_invite_rejected_total`,
  help: 'Roster opt-in INVITES rejected by the host invite gate (ADR-0044 Stage 3). Invite is a new-contact vector, so its bar is stricter than send.',
  // `reason`: flag_disabled | agent_shared_mode | ambiguous_origin |
  //   bad_member (non-ou_ target) | bad_slot (empty slot label) |
  //   already_invited (one-shot per (scope,member)
  //   suppression — a grant already exists, live OR revoked/opted-out) |
  //   not_member (isMember !== true; undefined/unknown ALSO rejects — the bar is
  //   absolute for a new-contact vector, unlike the send path) | rate_limited
  //   (scope 60s/3 or deploy daily cap) | no_adapter. Any sustained non-zero rate
  //   means an agent is trying to mint contact channels it isn't entitled to.
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const gatewaySigningProxyTotal = new client.Counter({
  name: `${METRIC_PREFIX}_gateway_signing_proxy_total`,
  help: 'Host signing-proxy requests by outcome (ADR-0034). signingKey never enters the container in this mode.',
  // `outcome`:
  //   - signed             : token + identity verified, signed and forwarded.
  //   - unauthorized        : missing / unknown / expired / revoked token (401).
  //   - source_ip_mismatch  : token presented from an IP other than its pin (401).
  //   - identity_mismatch   : token valid but request body claimed a different
  //                           agent group than the token is bound to (409) — an
  //                           impersonation signal; alert on any non-zero rate.
  //   - forbidden_path      : path not in the token's allowedPaths / unknown (403).
  //   - rate_limited        : per-token rate window exceeded (429).
  //   - bad_request         : malformed body / non-POST / oversized (4xx).
  //   - no_signing_key      : group has no signing key host-side — fail-closed (502).
  //   - backend_error       : upstream backend unreachable / errored after signing.
  labelNames: ['outcome'] as const,
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
 * Optional bearer token guarding /metrics. Resolves process env → `.env` →
 * unset, matching the rest of the host's config-reading convention. When
 * unset, /metrics stays public (backward compatible) — production should set
 * METRICS_AUTH_TOKEN or isolate the endpoint behind a reverse proxy. Read once
 * per request (cheap; the endpoint is scrape-rate, not message-rate) so an
 * operator rotating the token doesn't need a host restart for `.env` changes.
 */
function resolveMetricsAuthToken(): string | undefined {
  const fromEnv = process.env.METRICS_AUTH_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const dotenv = readEnvFile(['METRICS_AUTH_TOKEN']);
  const fromFile = dotenv.METRICS_AUTH_TOKEN;
  return fromFile && fromFile.trim() ? fromFile.trim() : undefined;
}

/**
 * Constant-time bearer check. The scheme ("Bearer") is matched
 * case-insensitively per RFC 6750; the token is compared with
 * `timingSafeEqual` (matching the Feishu signature convention in
 * src/channels/feishu.ts) so it leaks no timing side-channel.
 */
function bearerMatches(authHeader: string | undefined, token: string): boolean {
  if (!authHeader) return false;
  const match = /^Bearer[ ]+(.+)$/i.exec(authHeader.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

/**
 * Attach GET /metrics to the shared webhook server. Separate module so the
 * webhook server doesn't depend on prom-client directly.
 */
export async function handleMetricsRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }
  const token = resolveMetricsAuthToken();
  if (token && !bearerMatches(req.headers.authorization, token)) {
    webhookRejectedTotal.labels('unauthorized').inc();
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unauthorized');
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
