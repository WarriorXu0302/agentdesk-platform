# PR-O2 Phase 2 — Wave A · A.15 Verification Checklist

**Captured**: 2026-05-31T06:11:15Z (UTC)
**Branch**: dxy-dev
**HEAD at capture**: 75b44a45166c72f41bd7192d8c427e9795b39b1b
**Test trigger**: `pnpm chat "hello PR-O2 phase 2 verify"`
**Schema authority**: `docs/observability-span-schema.md` v1.0

## Wave A pre-run baselines

- **typecheck**: PASS — `reports/machine/pr-o2-phase2-2026-05-31/pre-typecheck.txt`
- **test**: 354 passed (38 files); 1 known pre-existing vitest collection issue with `scripts/observability-span-schema.test.ts` (node:test format) — fixed in this Wave by `vitest.config.ts` exclude — `pre-test.txt`

## Wave A post-run results

- **typecheck**: PASS — `a14-typecheck.txt`, `a15-typecheck.txt`
- **test**: 361 passed (39 files) — `a15-test.txt`
  - +7 tests from `src/observability/openinference.test.ts` (helper unit tests)
  - +1 test file from same
- **phoenix container**: up — `a15-obs-up.txt`
- **host**: started, ran `pnpm chat`, then stopped — `a15-host-pid.txt`, `a15-chat.txt`
- **chat exit**: 0; received reply — `a15-chat.txt`

## A.15 Phoenix schema-compliance checklist

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | `channel.cli.receive` exists with CHAIN kind | **PASS** | `a15-span-attributes.txt` row 3 — `{"channel": {"type": "cli"}, "openinference": {"span": {"kind": "CHAIN"}}}` |
| 2 | `router.container.wake` does NOT exist | **PASS** | `a15-span-counts.txt` — no row for `router.container.wake`; only `container.wake` (the underlying span) is present |
| 3 | `delivery.session.drain` only appears when undelivered ≥ 1 | **PASS** | `a15-span-counts.txt` shows 5 occurrences over the chat lifecycle; `a15-delivery-session-drain-all.txt` enumerates each with `message.count` ≥ 1 |
| 4 | `router.deliver_to_agent` is session-trace root with `input.value`, `session.id`, `user.id`, `input.mime_type` | **PASS** | `a15-span-attributes.txt` row 5 — `{"user": {"id": "cli:local"}, ..., "input": {"value": "...", "mime_type": "text/plain"}, "session": {"id": "sess-..."}, "openinference": {"span": {"kind": "CHAIN"}}}` |
| 5 | `delivery.channel.send` has `output.value` and `output.mime_type` | **PASS** | `a15-span-attributes.txt` row 10 — `{"output": {"value": "...", "mime_type": "text/plain"}, ...}` |
| 6 | Pre-session spans (`channel.*.receive`, `router.route`) are separate roots | **PASS** | `a15-trace-id-map.txt` — `channel.cli.receive` is `trace_rowid=11`; `router.deliver_to_agent` and below are in `trace_rowid=12`; the two are detached as required by schema §5b.2 |
| 7 | Phoenix Sessions view groups by `session.id` and renders Human/AI cards | **PASS** | `a15-phoenix-sessions.png` + `a15-phoenix-session-detail.png` + `a15-phoenix-session-detail-snapshot.md` — Sessions list shows session `sess-1779868835294-d9ed3l`; detail view renders Human/AI cards from `input.value` / `output.value` |
| 8 | `provider=''` empty attr is gone from `container.spawn` | **PASS** | `a15-span-attributes.txt` row 6 — `{"provider": "sdk-openai", ...}` (real provider, no empty string) |
| 9 | `msg.kind` attr key is gone; `message.kind` is used | **PASS** | `a15-span-attributes.txt` rows 8 and 11 — both `delivery.message.deliver` spans show `{"message": {"kind": "chat"}}` and `{"message": {"kind": "llm-usage"}}`; no `msg.kind` key remains |

**Total**: 9 PASS / 0 FAIL.

## Notes / caveats

- `channel.feishu.receive` rename (A.5) is not exercised in this CLI-only verification run; helper test and source-grep evidence (`a5-feishu-source.txt`) cover it. A live Feishu chat is reserved for Wave B coverage gate verification or downstream integration testing.
- The `a15-port-conflict-*.txt` files document a transient port-3000 conflict the executor encountered during host startup; the host was restarted on a clean port — see `a15-host-pid.txt` for the successful run. This is environmental, not a Wave A regression.
- Phoenix backing DB query was run via `docker exec muap-observability-prod-phoenix-1 psql ...` per the existing pattern from `reports/machine/pr-o2-2026-05-29/post-cleanup-trace-spans.txt`.

## Sign-off

- All A.1 → A.15 tasks landed and verified per `.sisyphus/plans/observability-pr-o2-phase2.md`.
- Schema v1.0 (`docs/observability-span-schema.md`) is fully honored at runtime.
- ADR-0011 import boundary preserved (no `@opentelemetry/*` or `@arizeai/*` imports outside `src/observability/**`).
- Ready to proceed to Wave B (coverage gate) under a fresh dispatch.
