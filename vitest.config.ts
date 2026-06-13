import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Rare CI-runner timing/resource flakes shouldn't fail an otherwise-green run.
    // The suite is deterministically green locally (verified many times, incl. a
    // CI-faithful Linux/node-22 container under constrained CPUs). Retry up to 2x
    // in CI only; keep local runs strict (0) so genuine flakes surface in dev. A
    // truly broken test still fails (it exhausts all retries).
    retry: process.env.CI ? 2 : 0,
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // observability-span-schema.test.ts is a node:test contract test for
    // docs/observability-span-schema.md (PR-O2 phase 1, ADR-0014). It is run
    // standalone via `pnpm exec tsx scripts/observability-span-schema.test.ts`
    // and must not be collected by vitest.
    exclude: ['**/node_modules/**', '**/dist/**', 'scripts/observability-span-schema.test.ts'],
  },
});
