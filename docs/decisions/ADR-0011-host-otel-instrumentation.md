# ADR-0011: Host OpenTelemetry Instrumentation

## Status

Accepted

## Date

2026-05-29

## Tags

observability, phase0b, phoenix, opentelemetry, tracing, host-runtime

## Context

PR-O1 established the observability bootstrap contract for MUAP:

- Phoenix 8.0.0 + Postgres + Grafana under `infra/observability/`
- Phoenix UI at `http://localhost:6006`
- OTLP HTTP traces endpoint at `http://localhost:6006/v1/traces`
- Prometheus-compatible host metrics exposed by `src/metrics.ts` at `/metrics`
- Grafana provisioned against Phoenix and host metrics
- No runtime OpenTelemetry imports in PR-O1

PR-O2 introduces host-side tracing.

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

This repository is in the V1 -> MUAP migration window. The migration constitution v1.2 remains binding. Observability decisions must not weaken:

- user/session isolation
- the ERP Gateway boundary
- identity propagation
- the audit trust chain
- the PR-O1 Phoenix + Grafana stack

ADR-0007 makes Phoenix OSS + Grafana the sanctioned observability stack.

ADR-0009 defines PR-O1 as bootstrap-only and explicitly defers host instrumentation to PR-O2.

`src/metrics.ts` already provides Prometheus counters, gauges, and histograms. Those metrics are still required. PR-O2 must add traces without replacing or renaming existing metrics.

The current PR-O1 artifact guard in `scripts/observability-bootstrap.test.ts` rejects runtime imports of `@opentelemetry/*`. PR-O2 must relax this guard only for the new host instrumentation boundary.

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

- Matches PR-O1 Phoenix endpoint.
- Avoids gRPC dependency surface.
- Gives explicit span names for business-critical async flow.
- Keeps OTel imports contained.
- Supports PR-O3 runner propagation via `OTEL_TRACEPARENT`.
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
- Does not match PR-O1 Phoenix HTTP endpoint.
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

- Violates PR-O1 contract.
- Breaks existing `/metrics` expectations.
- Adds unnecessary migration scope.
- Risks Grafana dashboard churn.

## Decision

Use **OTLP HTTP host-side OpenTelemetry tracing** with a narrow local wrapper boundary.

PR-O2 will:

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
12. Relax the PR-O1 artifact guard only for the `src/observability/**` boundary and local wrapper imports.
13. Inject `OTEL_TRACEPARENT` into spawned container env for PR-O3 forward compatibility.
14. Use AlwaysOn sampling for local development.
15. Use `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` for production sampling.
16. Add no new prom-client metrics in PR-O2.

## Span Taxonomy

### P0 spans

These spans are required for PR-O2.

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

These spans are included in PR-O2 if they remain low-risk.

| Span | File | Boundary |
|---|---|---|
| `host.sweep` | `src/host-sweep.ts` | `sweep()` |
| `host.sweep.sessions` | `src/host-sweep.ts` | `sweepSession()` |
| `container.kill` | `src/container-runner.ts` | `killContainer()` |

### Deferred spans

These are out of scope for PR-O2.

- container runner child spans such as `mounts.build`, `args.build`, `workspace.prepare`
- host-sweep child spans beyond `host.sweep` and `host.sweep.sessions`
- bootstrap spans
- `delivery.llm_usage`
- runner-side spans

## Context Bridging

Router and delivery are separated by asynchronous polling.

OpenTelemetry active context may not survive this boundary naturally.

PR-O2 will add an in-memory bridge:

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

OpenTelemetry documentation recommends preloading instrumentation before application modules, for example with Node `--import`. PR-O2 accepts the `src/index.ts` first-import approach and requires verification that required host spans are visible in Phoenix.

## Exporter Configuration

Default local trace endpoint:

```text
http://localhost:6006/v1/traces
```

Environment variables:

```text
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:6006/v1/traces
OTEL_SERVICE_NAME=frontlane-host
PHOENIX_PROJECT_NAME=muap-local
OTEL_TRACES_SAMPLER=always_on
```

Rules:

1. If using `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, include `/v1/traces`.
2. If using base `OTEL_EXPORTER_OTLP_ENDPOINT`, do not double-append `/v1/traces`.
3. `OTEL_SERVICE_NAME` sets `service.name`.
4. Local development defaults to `frontlane-host`.
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

PR-O2 adds trace correlation only:

- when an active span exists, append `traceId` and `spanId`
- when no active span exists, preserve current output behavior
- do not migrate to a structured logging library
- do not add log aggregation infrastructure

## Container Propagation

When spawning a container, the host will inject:

```text
OTEL_TRACEPARENT
```

This is a forward-compatibility contract for PR-O3.

PR-O2 does not require the container runner to parse, consume, or emit child spans.

## Consequences

### Positive

- Phoenix shows host message traces with business-meaningful span names.
- PR-O1 Prometheus metrics remain stable.
- Operators can correlate logs with traces via `traceId` and `spanId`.
- Async router -> delivery flow has explicit best-effort trace continuity.
- OTel dependency usage is isolated.
- PR-O3 can add runner-side tracing without redefining host propagation.

### Negative

- Manual spans add maintenance overhead.
- The `Map<sessionId, SpanContext>` bridge can be lossy under same-session concurrency.
- `src/index.ts` first import may not capture all auto-instrumentation opportunities.
- Phoenix UI verification remains an integration concern requiring local stack startup.

### Neutral

- PR-O2 does not change host business logic.
- PR-O2 does not change existing metric names.
- PR-O2 does not change Feishu/CLI protocol semantics.
- PR-O2 does not change ERP Gateway contracts.
- PR-O2 does not add a tracing collector separate from Phoenix.

## Implementation Notes

New files:

```text
src/observability/init.ts
src/observability/tracer.ts
src/observability/with-span.ts
src/observability/context-bridge.ts
docs/decisions/ADR-0011-host-otel-instrumentation.md
.sisyphus/plans/pr-o2-host-instrumentation.md
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
scripts/observability-bootstrap.test.ts
infra/observability/grafana/dashboards/muap-observability-bootstrap.json
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

Required evidence:

```text
reports/machine/pr-o2-2026-05-27/
reports/human/pr-o2-host-instrumentation-2026-05-27.html
```

## References

- ADR-0007: Observability Phoenix + Grafana
- ADR-0009: Observability Bootstrap Contract
- `docs/migration-from-v1.md`
- `../openclaw/CLOSEOUT/migration-to-muap.md` v1.2
- OpenTelemetry JS documentation
- Phoenix OTLP HTTP endpoint from PR-O1
