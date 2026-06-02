# ADR-0014: Observability Span Naming Schema v1.0

- **Status**: Accepted
- **Date**: 2026-05-31
- **Decider(s)**: User (approval), Sisyphus (orchestration), Prometheus (planning), Oracle (review)
- **Tags**: `observability`, `phase0b`, `tracing`, `naming`, `phoenix`, `openinference`
- **Supersedes**: None
- **Superseded by**: None

---

## Context

PR-O2 shipped 11 ad-hoc spans with inconsistent attribute keys, no documented hierarchy, and no OpenInference attribute discipline. Phoenix UI grouping fragmented because the system had business-meaningful spans, but no binding registry for how they should be named or what semantic keys they must carry.

Known constraints at decision time:

- ADR-0007 locks Phoenix OSS + Grafana as the sanctioned observability stack.
- ADR-0011 defines the host OpenTelemetry baseline and current session-root behavior.
- `docs/observability-instrumentation-methodology.md` v1.0 explains how MUAP should instrument Phoenix/OpenInference traces, but it is methodology, not a naming registry.
- Future Phase 0.5 / 1 / 2A / 2B / 3 work will add roughly 85% more span namespaces across mock, agent, provider, MCP, ERP, hardware, GUI, and Python skill surfaces.

Without binding governance before code expands, Phoenix Sessions grouping, query ergonomics, and OpenInference compatibility would drift further with each new feature.

## Options Considered

- **Option A**: Ad-hoc per-feature naming. Lowest immediate work, but guarantees fragmentation, duplicate concepts, and expensive future renames.
- **Option B**: Vercel-AI-style flat names such as `ai.generateText`. Short and familiar, but a poor fit for MUAP business spans across routing, delivery, ERP, DB, and module boundaries.
- **Option C**: Hierarchical `<subsystem>.<entity>.<action>` with snake_case + 2-3 segment depth + OpenInference attribute matrix. Slightly more governance work up front, but preserves low-cardinality naming, extensibility, and Phoenix-compatible semantics.

## Decision

> **拍板**：选 Option C。

Adopt schema v1.0 as defined in `docs/observability-span-schema.md`.

The accepted schema establishes:

- hierarchical 2-3 segment naming
- snake_case-only segments
- a 20-namespace top-level registry
- a binding attribute matrix keyed to OpenInference span kinds
- a migration table for the 11 currently shipped span names
- a locked governance model for future namespace expansion

## Consequences

- **Positive**: MUAP manual spans now have one binding source of truth for names, namespace ownership, attribute requirements, and migration intent. Phoenix grouping and cross-team reviews become much more consistent.
- **Negative**: Future instrumentation work must amend the schema before introducing new unregistered names, which adds process overhead and review discipline.
- **Neutral / Trade-offs**: The schema governs MUAP manual spans only. Third-party auto-instrumentation may still emit child spans with their own names, but those spans do not control the MUAP registry.

## Implementation Notes

- Affected files: `docs/observability-span-schema.md`, `docs/decisions/README.md`, `docs/observability-instrumentation-methodology.md`, `scripts/observability-span-schema.test.ts`
- Parent observability baseline: `docs/decisions/ADR-0011-host-otel-instrumentation.md`
- This ADR records governance and documentation acceptance only; it does not rename runtime spans in `src/**`
- The contract test in `scripts/observability-span-schema.test.ts` is the enforcement gate for future schema drift

## References

- `docs/decisions/ADR-0011-host-otel-instrumentation.md`
- `docs/observability-instrumentation-methodology.md`
- `docs/observability-span-schema.md`
