import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Alert/dashboard ↔ metrics.ts drift guard.
 *
 * infra/observability/prometheus/alerts.yml and the Grafana dashboards
 * reference metric names + labels by string. When a metric gets renamed (or a
 * label dropped) in src/metrics.ts, those alerts and panels silently match
 * nothing — no syntax error, no test failure, just dead alerting. `promtool
 * check rules` only validates PromQL syntax, not whether the metric exists.
 * This test pins src/metrics.ts as the single source of truth and asserts that
 * every `<prefix>_*` metric referenced by the alert rules and dashboards is a
 * real exported metric (allowing the histogram `_bucket`/`_sum`/`_count`
 * derivations Prometheus generates).
 *
 * Same drift class, same guard shape as scripts/runbook-consistency.test.ts.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const METRICS_PATH = path.join(REPO_ROOT, 'src', 'metrics.ts');
const ALERTS_PATH = path.join(REPO_ROOT, 'infra', 'observability', 'prometheus', 'alerts.yml');
const DASHBOARDS_DIR = path.join(REPO_ROOT, 'infra', 'observability', 'grafana', 'dashboards');

// alerts.yml / dashboards hardcode the default brand prefix (agentdesk_); the
// rebrand caveat is documented in ADR-0021. Keep this in sync with the
// METRIC_PREFIX default in src/branding.ts.
const PREFIX = 'agentdesk';

/** Base metric names exported from src/metrics.ts, plus histogram derivations. */
function declaredMetrics(): { base: Set<string>; histogram: Set<string> } {
  const src = fs.readFileSync(METRICS_PATH, 'utf-8');
  const base = new Set<string>();
  const histogram = new Set<string>();
  // Matches: name: `${METRIC_PREFIX}_inbound_total`  (Counter/Gauge/Histogram)
  const nameRe = /name:\s*`\$\{METRIC_PREFIX\}_([a-z0-9_]+)`/g;
  // Track whether the enclosing `new client.X(` was a Histogram so we can allow
  // its _bucket/_sum/_count derivations.
  for (const m of src.matchAll(nameRe)) {
    const full = `${PREFIX}_${m[1]}`;
    base.add(full);
    // Look back a little for the constructor kind.
    const before = src.slice(Math.max(0, m.index! - 200), m.index!);
    if (/new client\.Histogram\(\s*\{?\s*$/.test(before) || /client\.Histogram\(/.test(before)) {
      histogram.add(full);
    }
  }
  return { base, histogram };
}

/** Extract `agentdesk_*` metric references from a PromQL/JSON text blob. */
function referencedMetrics(text: string): Set<string> {
  const refs = new Set<string>();
  const re = new RegExp(`${PREFIX}_[a-z0-9_]+`, 'g');
  for (const m of text.matchAll(re)) refs.add(m[0]);
  return refs;
}

/** Is `ref` a declared metric, or a histogram derivation of one? */
function isKnown(ref: string, declared: { base: Set<string>; histogram: Set<string> }): boolean {
  if (declared.base.has(ref)) return true;
  for (const suffix of ['_bucket', '_sum', '_count'] as const) {
    if (ref.endsWith(suffix)) {
      const stem = ref.slice(0, -suffix.length);
      if (declared.histogram.has(stem)) return true;
      // prom-client also exposes _sum/_count without the histogram being one we
      // track only as Histogram; keep _bucket strict (histogram-only).
      if (suffix !== '_bucket' && declared.base.has(stem)) return true;
    }
  }
  return false;
}

describe('alerts/dashboards ↔ metrics.ts drift guard', () => {
  const declared = declaredMetrics();

  it('parses a non-trivial set of metrics from src/metrics.ts', () => {
    expect(declared.base.size).toBeGreaterThan(10);
    expect(declared.base.has(`${PREFIX}_inbound_total`)).toBe(true);
    expect(declared.histogram.has(`${PREFIX}_route_seconds`)).toBe(true);
  });

  it('every metric referenced in alerts.yml exists in metrics.ts', () => {
    const refs = referencedMetrics(fs.readFileSync(ALERTS_PATH, 'utf-8'));
    expect(refs.size).toBeGreaterThan(0);
    const unknown = [...refs].filter((r) => !isKnown(r, declared));
    expect(unknown).toEqual([]);
  });

  it('every metric referenced in Grafana dashboards exists in metrics.ts', () => {
    const files = fs.readdirSync(DASHBOARDS_DIR).filter((f) => f.endsWith('.json'));
    const refs = new Set<string>();
    for (const f of files) {
      for (const r of referencedMetrics(fs.readFileSync(path.join(DASHBOARDS_DIR, f), 'utf-8'))) refs.add(r);
    }
    const unknown = [...refs].filter((r) => !isKnown(r, declared));
    expect(unknown).toEqual([]);
  });

  it('rejects a fabricated metric name (negative self-check)', () => {
    expect(isKnown(`${PREFIX}_inbound_total`, declared)).toBe(true);
    expect(isKnown(`${PREFIX}_route_seconds_bucket`, declared)).toBe(true);
    expect(isKnown(`${PREFIX}_does_not_exist_total`, declared)).toBe(false);
  });
});
