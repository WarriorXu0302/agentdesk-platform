# ADR-0015: Observability Coverage Gate

- **Status**: Accepted
- **Date**: 2026-05-31
- **Decider(s)**: User (approval), Sisyphus (orchestration), Prometheus (planning), Sisyphus-Junior (execution)
- **Tags**: `observability`, `tracing`, `ci`, `schema-governance`
- **Supersedes**: None
- **Superseded by**: None

---

## Context

ADR-0014 made `docs/observability-span-schema.md` v1.0 the binding contract for manual span names, namespaces, and OpenInference attribute expectations. A first migration wave then aligned the existing host span surface to that schema. At that point the runtime was aligned, but the alignment remained fragile: a future PR could still introduce an unregistered namespace, forget a `openinference.span.kind`, or remove a required Keep/Rename target without any CI signal.

Known constraints at decision time:

- ADR-0011 keeps direct OpenTelemetry and OpenInference imports inside `src/observability/**` and preserves the local helper boundary.
- ADR-0014 remains the normative schema authority; this ADR must not reopen or supersede it.
- Wave B must use source scanning only, without adding a new parser dependency.
- `pnpm test` is the repo’s main regression gate, so any observability drift check has to fit inside the existing Vitest suite.
- Runner-side tracing under `container/agent-runner/src/**` is still future scope for enforcement even though the schema already reserves runner-facing namespaces such as `agent.*`, `provider.*`, and `mcp.*`.

Without a gate, the schema becomes advisory in practice and drift prevention depends on human memory during review.

## Options Considered

- **Option A**: Rely on code review and the schema markdown alone. Lowest implementation cost, but the same manual discipline problem that created drift in the first place remains unresolved.
- **Option B**: Add a CI-grade source scanner and coverage report for current production manual spans. Slightly more process and maintenance overhead, but it creates an immediate failure when runtime code diverges from schema v1.0.
- **Option C**: Enforce both host and runner tracing now with one broad gate. Stronger long-term coverage, but it expands this change beyond the approved host-side scope and risks blocking current work on future runner instrumentation that is not yet landed.

## Decision

> **拍板**：选 Option B。

Install an observability coverage gate.

The accepted gate:

1. runs in Vitest via `scripts/observability-coverage.test.ts` and directly via `pnpm obs:coverage`;
2. shares one scanner/report library in `scripts/observability-coverage-lib.ts` so test results and the HTML report stay consistent;
3. enforces three current invariants for production spans:
   - forward namespace validity against schema §3;
   - backward presence/absence against schema §7 migration targets;
   - host-side `openinference.span.kind` coverage for `src/**/*.ts` manual spans;
4. treats new top-level namespaces as schema-governed changes that still require a schema amendment plus ADR approval before runtime code lands;
5. explicitly waives runner-side kind enforcement for now: inventory scanning may observe `container/agent-runner/src/**`, but this gate does not fail CI on missing runner span kinds until a later runner-tracing wave is approved.

## Consequences

- **Positive**: Schema/runtime drift now becomes a test failure instead of a review-time guess. The HTML report gives maintainers a readable snapshot of namespace usage, migration coverage, and per-span semantic attribute coverage.
- **Negative**: Future instrumentation changes incur extra process overhead because they must satisfy the gate and, when introducing new names, amend the schema first instead of “fixing docs later.”
- **Neutral / Trade-offs**: Runner namespaces remain visible in the inventory model but are not yet enforced for kind coverage. This is a deliberate scope boundary, not a gap caused by oversight; the waiver must be revisited when runner manual tracing work starts.

## Implementation Notes

- Landed files: `scripts/observability-coverage-lib.ts`, `scripts/observability-coverage.test.ts`, `scripts/generate-observability-coverage-report.ts`, `package.json`
- Parent decisions: `docs/decisions/ADR-0011-host-otel-instrumentation.md`, `docs/decisions/ADR-0014-observability-span-schema.md`
- Direct operator entrypoint: `pnpm obs:coverage`
- Ongoing acceptance points:
  - `pnpm obs:coverage` passes on current host runtime
  - `pnpm test` includes the coverage gate
  - intentional namespace breakage produces `Coverage gate FAILED:` with structured violation text
  - the human report remains scanner-backed rather than hand-maintained prose

## References

- `docs/decisions/ADR-0011-host-otel-instrumentation.md`
- `docs/decisions/ADR-0014-observability-span-schema.md`
- `docs/observability-span-schema.md`
- `scripts/observability-coverage.test.ts`
- `scripts/observability-coverage-lib.ts`
