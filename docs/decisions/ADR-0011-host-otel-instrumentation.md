# ADR-0011: Host OpenTelemetry Instrumentation

## Status

Accepted

## Date

2026-05-29

## Tags

observability, phoenix, opentelemetry, tracing, host-runtime

## Context

The observability bootstrap contract for this platform established:

- Phoenix 8.0.0 + Postgres + Grafana under `infra/observability/`
- Phoenix UI at `http://localhost:6006`
- OTLP HTTP traces endpoint at `http://localhost:6006/v1/traces`
- Prometheus-compatible host metrics exposed by `src/metrics.ts` at `/metrics`
- Grafana provisioned against Phoenix and host metrics
- No runtime OpenTelemetry imports at the bootstrap stage

This ADR introduces host-side tracing.

The required operator outcome is:

```text
feishu.event.received
  -> router.route
  -> router.deliver_to_agent
  -> router.container.wake
  -> container.spawn
  -> delivery.message.deliver
  -> delivery.channel.send
```

When a Feishu user sends `hello`, Phoenix must show one trace containing the host-side message path.

Observability decisions must not weaken:

- user/session isolation
- the gateway boundary
- identity propagation
- the audit trust chain
- the Phoenix + Grafana stack

ADR-0007 makes Phoenix OSS + Grafana the sanctioned observability stack.

The observability bootstrap is defined as bootstrap-only and explicitly defers host instrumentation to this ADR.

`src/metrics.ts` already provides Prometheus counters, gauges, and histograms. Those metrics are still required. Host instrumentation must add traces without replacing or renaming existing metrics.

The bootstrap artifact guard rejects runtime imports of `@opentelemetry/*`. Host instrumentation must relax this guard only for the new host instrumentation boundary.

## Options Considered

### Option A -- OTLP HTTP to Phoenix, host manual spans, local helper boundary

Use OpenTelemetry JS with OTLP HTTP export to Phoenix.

Add a narrow `src/observability/` boundary:

- `src/observability/init.ts`
- `src/observability/tracer.ts`
- `src/observability/with-span.ts`
- `src/observability/context-bridge.ts`

Runtime files import local helpers only.

Use manual spans for message-path boundaries and auto-instrumentation for HTTP/Express where effective.

Keep Prometheus metrics unchanged.

Pros:

- Matches the Phoenix endpoint.
- Avoids gRPC dependency surface.
- Gives explicit span names for business-critical async flow.
- Keeps OTel imports contained.
- Supports future runner propagation via `OTEL_TRACEPARENT`.
- Preserves existing metrics and logger.

Cons:

- Manual spans require disciplined placement and tests.
- Async route -> delivery continuity needs explicit context bridging.
- `src/index.ts` first import is less robust than Node `--import` for auto-instrumentation preload.

### Option B -- OTLP gRPC exporter

Use OTLP gRPC exporter and port `4317`.

Pros:

- Common OTLP deployment shape.
- Compatible with many collectors.

Cons:

- Adds more dependency/protocol complexity.
- Does not match the Phoenix HTTP endpoint.
- Increases local setup ambiguity.
- Not needed for this host.

### Option C -- Auto-instrumentation only

Use OpenTelemetry auto-instrumentations and avoid manual spans.

Pros:

- Less code.
- Good for HTTP and library-level traces.

Cons:

- Does not expose domain span names such as `router.deliver_to_agent`.
- Does not reliably join polling-based delivery to router context.
- Does not meet the required Phoenix trace shape.
- Cannot model Feishu/CLI/router/container business boundaries.

### Option D -- Replace Prometheus metrics with OTel metrics

Move host metrics into OpenTelemetry metrics.

Pros:

- One telemetry API.

Cons:

- Violates the observability bootstrap contract.
- Breaks existing `/metrics` expectations.
- Adds unnecessary migration scope.
- Risks Grafana dashboard churn.

## Decision

Use **OTLP HTTP host-side OpenTelemetry tracing** with a narrow local wrapper boundary.

Host instrumentation will:

1. Use OTLP HTTP, not OTLP gRPC.
2. Export traces to `http://localhost:6006/v1/traces`.
3. Add SDK bootstrap in `src/observability/init.ts`.
4. Import `src/observability/init.ts` from the first line of `src/index.ts`.
5. Use HTTP/Express auto-instrumentation where effective.
6. Use manual spans for Feishu, CLI, router, container, delivery, and host-sweep boundaries.
7. Put span helper logic in `src/observability/with-span.ts`.
8. Put tracer access in `src/observability/tracer.ts`.
9. Put async session context bridging in `src/observability/context-bridge.ts`.
10. Preserve `src/log.ts` but append active `traceId` and `spanId`.
11. Preserve `src/metrics.ts` and `/metrics`.
12. Relax the bootstrap artifact guard only for the `src/observability/**` boundary and local wrapper imports.
13. Inject `OTEL_TRACEPARENT` into spawned container env for future runner-side forward compatibility.
14. Use AlwaysOn sampling for local development.
15. Use `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` for production sampling.
16. Add no new prom-client metrics in this change.

## Span Taxonomy

### P0 spans

These spans are required for host instrumentation.

| Span | File | Boundary |
|---|---|---|
| `feishu.event.received` | `src/channels/feishu.ts` | Feishu message receive handler |
| `cli.event.received` | `src/channels/cli.ts` | CLI line receive handler |
| `router.route` | `src/router.ts` | `routeInbound()` |
| `router.deliver_to_agent` | `src/router.ts` | `deliverToAgent()` |
| `router.container.wake` | `src/router.ts` | call to `wakeContainer()` |
| `container.wake` | `src/container-runner.ts` | `wakeContainer()` |
| `container.spawn` | `src/container-runner.ts` | `spawnContainer()` |
| `delivery.poll.active` | `src/delivery.ts` | active delivery poll tick |
| `delivery.session.drain` | `src/delivery.ts` | `drainSession()` |
| `delivery.message.deliver` | `src/delivery.ts` | `deliverMessage()` |
| `delivery.channel.send` | `src/delivery.ts` | `deliveryAdapter.deliver()` |

### P1 spans

These spans are included in host instrumentation if they remain low-risk.

| Span | File | Boundary |
|---|---|---|
| `host.sweep` | `src/host-sweep.ts` | `sweep()` |
| `host.sweep.sessions` | `src/host-sweep.ts` | `sweepSession()` |
| `container.kill` | `src/container-runner.ts` | `killContainer()` |

### Deferred spans

These are out of scope for host instrumentation.

- container runner child spans such as `mounts.build`, `args.build`, `workspace.prepare`
- host-sweep child spans beyond `host.sweep` and `host.sweep.sessions`
- bootstrap spans
- `delivery.llm_usage`
- runner-side spans

## Context Bridging

Router and delivery are separated by asynchronous polling.

OpenTelemetry active context may not survive this boundary naturally.

Host instrumentation will add an in-memory bridge:

```text
Map<sessionId, SpanContext>
```

Rules:

1. Router stores the current span context after resolving the target session.
2. Delivery consumes the context once when draining that session.
3. Delivery clears the bridge entry after success, empty queue, failure, or explicit cleanup.
4. A later store for the same `sessionId` overwrites the previous entry.
5. Overwrite semantics are accepted as lossy for same-session concurrent inbound messages.
6. The bridge is best-effort tracing correlation, not business state.

The bridge must never affect routing, delivery, authorization, session isolation, or message persistence.

## Import Boundary

Direct runtime imports from `@opentelemetry/*` are allowed only in:

```text
src/observability/**
```

Other runtime files must import local wrappers only.

Allowed examples:

```ts
import { withSpan } from './observability/with-span.js';
import { storeSessionSpanContext } from './observability/context-bridge.js';
```

Forbidden examples outside `src/observability/**`:

```ts
import { trace } from '@opentelemetry/api';
import { context } from '@opentelemetry/api';
```

`src/index.ts` must import the SDK bootstrap as its first import:

```ts
import './observability/init.js';
```

This is a project decision.

OpenTelemetry documentation recommends preloading instrumentation before application modules, for example with Node `--import`. This ADR accepts the `src/index.ts` first-import approach and requires verification that required host spans are visible in Phoenix.

## Exporter Configuration

Default local trace endpoint:

```text
http://localhost:6006/v1/traces
```

Environment variables:

```text
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:6006/v1/traces
OTEL_SERVICE_NAME=agentdesk-host
PHOENIX_PROJECT_NAME=agentdesk-local
OTEL_TRACES_SAMPLER=always_on
```

Rules:

1. If using `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, include `/v1/traces`.
2. If using base `OTEL_EXPORTER_OTLP_ENDPOINT`, do not double-append `/v1/traces`.
3. `OTEL_SERVICE_NAME` sets `service.name`.
4. Local development defaults to `<namespace>-host` (default `agentdesk-host`, derived from the configured brand namespace).
5. Production sampling is controlled by OpenTelemetry env vars.

## Failure Policy

Tracing is fail-open.

If Phoenix is unavailable:

- host startup must still succeed
- message routing must still work
- delivery must still work
- `/metrics` must still work
- shutdown must not hang
- errors may be logged, but must not crash the host

`NodeSDK.shutdown()` should be called during graceful shutdown to flush spans.

## Logging Correlation

`src/log.ts` remains the logger.

Host instrumentation adds trace correlation only:

- when an active span exists, append `traceId` and `spanId`
- when no active span exists, preserve current output behavior
- do not migrate to a structured logging library
- do not add log aggregation infrastructure

## Container Propagation

When spawning a container, the host will inject:

```text
OTEL_TRACEPARENT
```

This is a forward-compatibility contract for runner-side tracing.

This change does not require the container runner to parse, consume, or emit child spans.

## Consequences

### Positive

- Phoenix shows host message traces with business-meaningful span names.
- Bootstrap Prometheus metrics remain stable.
- Operators can correlate logs with traces via `traceId` and `spanId`.
- Async router -> delivery flow has explicit best-effort trace continuity.
- OTel dependency usage is isolated.
- A later runner-tracing change can add runner-side tracing without redefining host propagation.

### Negative

- Manual spans add maintenance overhead.
- The `Map<sessionId, SpanContext>` bridge can be lossy under same-session concurrency.
- `src/index.ts` first import may not capture all auto-instrumentation opportunities.
- Phoenix UI verification remains an integration concern requiring local stack startup.

### Neutral

- This change does not change host business logic.
- This change does not change existing metric names.
- This change does not change Feishu/CLI protocol semantics.
- This change does not change gateway contracts.
- This change does not add a tracing collector separate from Phoenix.

## Implementation Notes

New files:

```text
src/observability/init.ts
src/observability/tracer.ts
src/observability/with-span.ts
src/observability/context-bridge.ts
docs/decisions/ADR-0011-host-otel-instrumentation.md
```

Modified files:

```text
src/index.ts
src/router.ts
src/channels/feishu.ts
src/channels/cli.ts
src/container-runner.ts
src/delivery.ts
src/host-sweep.ts
src/log.ts
package.json
infra/observability/grafana/dashboards/observability-bootstrap.json
docs/decisions/README.md
infra/observability/README.md
```

Verification commands:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm obs:up
pnpm dev
```

Required evidence: one Phoenix trace containing the full host-side message path (Feishu/CLI receive -> router -> container wake -> delivery -> channel send), confirmed via the Phoenix UI after `pnpm obs:up` + `pnpm dev`.

## References

- ADR-0007: Observability Phoenix + Grafana
- ADR-0014: Observability Span Naming Schema
- ADR-0015: Observability Coverage Gate
- `docs/observability-instrumentation-methodology.md`
- OpenTelemetry JS documentation
- Phoenix OTLP HTTP endpoint
