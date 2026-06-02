import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // observability-span-schema.test.ts is a node:test contract test for
    // docs/observability-span-schema.md (PR-O2 phase 1, ADR-0014). It is run
    // standalone via `pnpm exec tsx scripts/observability-span-schema.test.ts`
    // and must not be collected by vitest.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'scripts/observability-span-schema.test.ts',
    ],
  },
});
