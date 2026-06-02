import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectObservabilityCoverage,
  hasCoverageViolations,
  validateObservabilityCoverage,
  type AttributeState,
  type MigrationCoverageRow,
  type NamespaceCoverageRow,
  type SpanOccurrence,
} from './observability-coverage-lib.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(REPO_ROOT, 'reports', 'human', 'observability-coverage-2026-05-31.html');

export interface GenerateCoverageReportResult {
  outputPath: string;
}

export function run(): GenerateCoverageReportResult {
  const report = collectObservabilityCoverage({ repoRoot: REPO_ROOT });
  const validation = validateObservabilityCoverage(report);

  const html = renderHtml({
    generatedAt: new Date().toISOString(),
    namespaceRows: report.namespaceCoverage,
    migrationRows: report.migrationCoverage,
    spanRows: report.allSpanOccurrences,
    violationCount: countViolations(validation),
    isPassing: !hasCoverageViolations(validation),
  });

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');

  return { outputPath: OUTPUT_PATH };
}

function renderHtml(input: {
  generatedAt: string;
  namespaceRows: NamespaceCoverageRow[];
  migrationRows: MigrationCoverageRow[];
  spanRows: SpanOccurrence[];
  violationCount: number;
  isPassing: boolean;
}): string {
  const title = 'Observability Coverage Report — 2026-05-31';
  const statusBadge = input.isPassing
    ? '<span class="badge badge-pass">PASS</span>'
    : `<span class="badge badge-fail">FAIL · ${input.violationCount}</span>`;

  const namespaceTableRows = input.namespaceRows
    .map((row) => {
      const countClass = row.status.includes('Active') && row.actualSpanCount === 0 ? 'badge-warn' : 'badge-muted';
      const examples = row.exampleSpansFound.length > 0 ? row.exampleSpansFound.map(code).join(', ') : '<span class="muted">None found</span>';
      return `
        <tr>
          <td>${code(row.namespace + '.*')}</td>
          <td>${escapeHtml(row.status)}</td>
          <td>${code(row.defaultKind)}</td>
          <td><span class="badge ${countClass}">${row.actualSpanCount}</span></td>
          <td>${examples}</td>
        </tr>`;
    })
    .join('');

  const migrationTableRows = input.migrationRows
    .map((row) => {
      const sourceLocations = row.sourceLocations.length > 0 ? row.sourceLocations.map(code).join(', ') : '<span class="muted">Absent</span>';
      return `
        <tr>
          <td>${code(row.currentName)}</td>
          <td>${row.newName ? code(row.newName) : '<span class="muted">—</span>'}</td>
          <td>${actionBadge(row.action)}</td>
          <td>${row.pass ? '<span class="badge badge-pass">PASS</span>' : '<span class="badge badge-fail">FAIL</span>'}</td>
          <td>${sourceLocations}</td>
        </tr>`;
    })
    .join('');

  const spanTableRows = input.spanRows
    .map((row) => {
      const location = `${row.relativePath}:${row.line}`;
      const notes = row.attrCoverage.notes.length > 0 ? row.attrCoverage.notes.map(escapeHtml).join('; ') : '—';
      return `
        <tr>
          <td>${code(row.name)}</td>
          <td>${code(location)}</td>
          <td>${stateBadge(row.attrCoverage.openinferenceSpanKind)}</td>
          <td>${stateBadge(row.attrCoverage.sessionId)}</td>
          <td>${stateBadge(row.attrCoverage.userId)}</td>
          <td>${stateBadge(row.attrCoverage.inputValue)}</td>
          <td>${stateBadge(row.attrCoverage.inputMimeType)}</td>
          <td>${stateBadge(row.attrCoverage.outputValue)}</td>
          <td>${stateBadge(row.attrCoverage.outputMimeType)}</td>
          <td>${notes}</td>
        </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #ffffff;
      --surface: #f8fafc;
      --text: #111827;
      --muted: #4b5563;
      --border: #d1d5db;
      --table-head: #f3f4f6;
      --pass-bg: #dcfce7;
      --pass-text: #166534;
      --fail-bg: #fee2e2;
      --fail-text: #991b1b;
      --warn-bg: #fef3c7;
      --warn-text: #92400e;
      --na-bg: #e5e7eb;
      --na-text: #374151;
      --code-bg: #f3f4f6;
      --link: #1d4ed8;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem 1rem 4rem;
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
    }
    a { color: var(--link); }
    a:focus-visible, summary:focus-visible {
      outline: 3px solid #2563eb;
      outline-offset: 2px;
    }
    .page {
      max-width: 920px;
      margin: 0 auto;
    }
    header {
      border-bottom: 2px solid var(--border);
      padding-bottom: 1rem;
      margin-bottom: 1.5rem;
    }
    h1 {
      margin: 0 0 0.5rem;
      font-size: 2.2rem;
      line-height: 1.15;
    }
    h2 {
      margin: 0 0 0.75rem;
      font-size: 1.6rem;
      line-height: 1.2;
    }
    p, li { color: var(--text); }
    .lede { color: var(--muted); max-width: 72ch; }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      align-items: center;
      margin-top: 0.75rem;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 0.75rem;
      margin: 1rem 0 1.5rem;
    }
    .summary-card {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.85rem 1rem;
      background: var(--surface);
    }
    .summary-card strong { display: block; margin-bottom: 0.25rem; }
    nav {
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: 10px;
      padding: 0.9rem 1rem;
      margin-bottom: 1.5rem;
    }
    nav ul {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem 1.25rem;
      list-style: none;
      padding: 0;
      margin: 0.5rem 0 0;
    }
    main > section {
      margin-bottom: 2rem;
      padding-bottom: 0.25rem;
    }
    .scope-note {
      border-left: 4px solid #2563eb;
      background: #eff6ff;
      padding: 0.85rem 1rem;
      margin: 1rem 0 1.5rem;
      border-radius: 6px;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: var(--code-bg);
      padding: 0.14rem 0.35rem;
      border-radius: 4px;
      font-size: 0.92em;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0 0;
      font-size: 0.95rem;
    }
    caption {
      caption-side: top;
      text-align: left;
      font-weight: 700;
      margin-bottom: 0.5rem;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 0.65rem 0.7rem;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: var(--table-head);
      font-weight: 700;
    }
    tbody tr:nth-child(even) { background: #fafafa; }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    .table-wrap table { margin: 0; border: 0; }
    .table-wrap th:first-child, .table-wrap td:first-child { border-left: 0; }
    .table-wrap th:last-child, .table-wrap td:last-child { border-right: 0; }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 0.18rem 0.58rem;
      font-size: 0.82rem;
      font-weight: 700;
      white-space: nowrap;
    }
    .badge-pass { background: var(--pass-bg); color: var(--pass-text); }
    .badge-fail { background: var(--fail-bg); color: var(--fail-text); }
    .badge-warn { background: var(--warn-bg); color: var(--warn-text); }
    .badge-na, .badge-muted { background: var(--na-bg); color: var(--na-text); }
    .muted { color: var(--muted); }
    .footnote {
      color: var(--muted);
      font-size: 0.92rem;
      margin-top: 0.75rem;
    }
    @media print {
      body { padding: 0; }
      .page { max-width: 100%; }
      nav { break-inside: avoid; }
      .table-wrap { overflow: visible; }
      @page { margin: 1.6cm; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <h1>${escapeHtml(title)}</h1>
      <p class="lede">
        CI-grade coverage view for schema v1.0 manual spans. This report is generated directly from
        <code>scripts/observability-coverage-lib.ts</code> so the human report and the gate share the same source scan.
      </p>
      <div class="meta">
        ${statusBadge}
        <span><strong>Generated:</strong> ${escapeHtml(input.generatedAt)}</span>
        <span><strong>Schema:</strong> <code>docs/observability-span-schema.md</code></span>
      </div>
      <div class="summary-grid" aria-label="Coverage summary metrics">
        <div class="summary-card"><strong>Namespaces</strong>${input.namespaceRows.length}</div>
        <div class="summary-card"><strong>Migration rows</strong>${input.migrationRows.length}</div>
        <div class="summary-card"><strong>Production spans found</strong>${input.spanRows.length}</div>
        <div class="summary-card"><strong>Host kind enforcement scope</strong><code>src/**/*.ts</code></div>
      </div>
    </header>

    <nav aria-label="Report sections">
      <strong>Contents</strong>
      <ul>
        <li><a href="#namespace-coverage">Namespace coverage matrix</a></li>
        <li><a href="#migration-table">Migration table</a></li>
        <li><a href="#attribute-coverage">Attribute coverage matrix</a></li>
      </ul>
    </nav>

    <div class="scope-note">
      <strong>Scope note:</strong> the gate scans both <code>src/**/*.ts</code> and <code>container/agent-runner/src/**/*.ts</code>
      for inventory, but Wave B enforces <code>openinference.span.kind</code> only for host sources under <code>src/**/*.ts</code>.
      Runner tracing remains a future wave and is documented as a deliberate waiver in ADR-0015.
    </div>

    <main>
      <section id="namespace-coverage" aria-labelledby="namespace-coverage-heading">
        <h2 id="namespace-coverage-heading">Namespace coverage matrix</h2>
        <p class="lede">
          All 20 top-level namespaces from schema §3, with their current runtime coverage. Active namespaces with zero live spans are highlighted for review.
        </p>
        <div class="table-wrap">
          <table>
            <caption>Namespace coverage matrix</caption>
            <thead>
              <tr>
                <th scope="col">Namespace</th>
                <th scope="col">Status</th>
                <th scope="col">Default OpenInference kind</th>
                <th scope="col">Actual span count</th>
                <th scope="col">Example spans found</th>
              </tr>
            </thead>
            <tbody>
              ${namespaceTableRows}
            </tbody>
          </table>
        </div>
        <p class="footnote">Rows come from schema §3. Counts come from the shared production-source scan.</p>
      </section>

      <section id="migration-table" aria-labelledby="migration-table-heading">
        <h2 id="migration-table-heading">Migration table</h2>
        <p class="lede">
          Schema §7 migration registry mapped against current runtime literals. <code>Keep</code> and <code>Rename</code> rows must exist; <code>DELETE</code> rows must stay absent.
        </p>
        <div class="table-wrap">
          <table>
            <caption>Migration table</caption>
            <thead>
              <tr>
                <th scope="col">Current name</th>
                <th scope="col">New name</th>
                <th scope="col">Action</th>
                <th scope="col">Runtime status badge</th>
                <th scope="col">Source location if present</th>
              </tr>
            </thead>
            <tbody>
              ${migrationTableRows}
            </tbody>
          </table>
        </div>
      </section>

      <section id="attribute-coverage" aria-labelledby="attribute-coverage-heading">
        <h2 id="attribute-coverage-heading">Attribute coverage matrix</h2>
        <p class="lede">
          Per-span attribute coverage for the current production inventory. This view makes the root span <code>router.deliver_to_agent</code> and the outbound span <code>delivery.channel.send</code> easy to audit.
        </p>
        <div class="table-wrap">
          <table>
            <caption>Attribute coverage matrix per span</caption>
            <thead>
              <tr>
                <th scope="col">Span name</th>
                <th scope="col">File:line</th>
                <th scope="col">openinference.span.kind</th>
                <th scope="col">session.id</th>
                <th scope="col">user.id</th>
                <th scope="col">input.value</th>
                <th scope="col">input.mime_type</th>
                <th scope="col">output.value</th>
                <th scope="col">output.mime_type</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              ${spanTableRows}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
</body>
</html>`;
}

function actionBadge(action: MigrationCoverageRow['action']): string {
  if (action === 'Keep') return '<span class="badge badge-pass">Keep</span>';
  if (action === 'Rename') return '<span class="badge badge-warn">Rename</span>';
  return '<span class="badge badge-fail">DELETE</span>';
}

function stateBadge(state: AttributeState): string {
  if (state === 'present') return '<span class="badge badge-pass">present</span>';
  if (state === 'conditional') return '<span class="badge badge-warn">conditional</span>';
  if (state === 'n/a') return '<span class="badge badge-na">n/a</span>';
  return '<span class="badge badge-fail">absent</span>';
}

function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function countViolations(validation: ReturnType<typeof validateObservabilityCoverage>): number {
  return (
    validation.forwardViolations.length +
    validation.backwardViolations.length +
    validation.kindViolations.length +
    validation.deprecatedAttributeViolations.length
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(`observability coverage report written: ${result.outputPath}`);
}
