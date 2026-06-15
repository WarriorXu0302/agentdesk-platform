/**
 * Eval-harness CI gate (ADR-0047). Loads every cases/*.json declarative case and
 * runs it through the in-process poll-loop, asserting the outbound trajectory.
 * A classification/routing regression (e.g. a delegation that stops producing
 * the a2a row, or a reply that stops routing to source) fails here BEFORE prod.
 *
 * Add a regression: drop a new JSON file in cases/ — no TS boilerplate.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runEvalCase, type EvalCase } from './harness.js';

const casesDir = join(import.meta.dir, 'cases');
const files = readdirSync(casesDir).filter((f) => f.endsWith('.json'));

describe('agent eval harness (ADR-0047)', () => {
  it('discovers at least one case', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const evalCase = JSON.parse(readFileSync(join(casesDir, file), 'utf8')) as EvalCase;
    it(`eval: ${evalCase.name}`, async () => {
      const result = await runEvalCase(evalCase);
      if (!result.pass) {
        throw new Error(`eval case failed [${file}]:\n  - ${result.failures.join('\n  - ')}`);
      }
      expect(result.pass).toBe(true);
    });
  }
});
