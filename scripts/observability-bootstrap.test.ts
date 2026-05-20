import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, describe, expect, it } from 'vitest';

import { run as generateEnvLocalProposed } from './generate-env-local-proposed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const OBSERVABILITY_ROOT = path.join(REPO_ROOT, 'infra', 'observability');
const GRAFANA_DASHBOARDS_DIR = path.join(OBSERVABILITY_ROOT, 'grafana', 'dashboards');
const SIM_COMPOSE_PATH = path.join(OBSERVABILITY_ROOT, 'docker-compose.sim.yml');
const PROD_COMPOSE_PATH = path.join(OBSERVABILITY_ROOT, 'docker-compose.prod.yml');
const DATASOURCE_PATH = path.join(
  OBSERVABILITY_ROOT,
  'grafana',
  'provisioning',
  'datasources',
  'phoenix-postgres.yml',
);
const DASHBOARD_PROVIDER_PATH = path.join(
  OBSERVABILITY_ROOT,
  'grafana',
  'provisioning',
  'dashboards',
  'dashboards.yml',
);
const GRAFANA_SQL_PATH = path.join(OBSERVABILITY_ROOT, 'init', 'grafana_readonly.sql');
const RUNBOOK_PATH = path.join(OBSERVABILITY_ROOT, 'README.md');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const ADR_PATH = path.join(REPO_ROOT, 'docs', 'decisions', 'ADR-0009-observability-bootstrap-contract.md');
const ADR_INDEX_PATH = path.join(REPO_ROOT, 'docs', 'decisions', 'README.md');

const FORBIDDEN_RUNTIME_PATHS = [
  path.join(REPO_ROOT, 'src', 'index.ts'),
  path.join(REPO_ROOT, 'src', 'router.ts'),
  path.join(REPO_ROOT, 'src', 'delivery.ts'),
  path.join(REPO_ROOT, 'src', 'host-sweep.ts'),
  path.join(REPO_ROOT, 'src', 'container-runner.ts'),
];

const REQUIRED_PACKAGE_SCRIPTS: Record<string, string> = {
  'obs:up': 'docker compose -p muap-observability-prod -f infra/observability/docker-compose.prod.yml up -d',
  'obs:up:prod': 'docker compose -p muap-observability-prod -f infra/observability/docker-compose.prod.yml up -d',
  'obs:up:sim': 'docker compose -p muap-observability-sim -f infra/observability/docker-compose.sim.yml up -d',
  'obs:down': 'docker compose -p muap-observability-prod -f infra/observability/docker-compose.prod.yml down',
  'obs:down:sim': 'docker compose -p muap-observability-sim -f infra/observability/docker-compose.sim.yml down',
  'obs:logs': 'docker compose -p muap-observability-prod -f infra/observability/docker-compose.prod.yml logs -f',
  'obs:config': 'docker compose -p muap-observability-prod -f infra/observability/docker-compose.prod.yml config && docker compose -p muap-observability-sim -f infra/observability/docker-compose.sim.yml config',
  'obs:reset': 'docker compose -p muap-observability-prod -f infra/observability/docker-compose.prod.yml down -v',
};

const REQUIRED_ENV_LINES = [
  'PHOENIX_OTLP_ENDPOINT=http://localhost:4317',
  'PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006/v1/traces',
  'OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317',
  'OTEL_SERVICE_NAME=frontlane-host',
  'PHOENIX_PROJECT_NAME=muap-local',
  'GRAFANA_HOST_PORT=3001',
];

const FORBIDDEN_OBSERVABILITY_IMPORTS = [/@opentelemetry\//, /@arizeai\/openinference-/];
const FORBIDDEN_RUNTIME_MARKERS = [/@opentelemetry\//, /@arizeai\/openinference-/, /PHOENIX_/, /OTEL_/];

const tempDirs: string[] = [];

interface PackageJsonShape {
  scripts?: Record<string, string>;
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function listFilesRecursive(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];

  return fs.readdirSync(dirPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dirPath, entry.name);
    return entry.isDirectory() ? listFilesRecursive(entryPath) : [entryPath];
  });
}

function makeTempDir(): string {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'muap-observability-bootstrap-'));
  tempDirs.push(dirPath);
  return dirPath;
}

afterEach(() => {
  for (const dirPath of tempDirs.splice(0)) {
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true });
  }
});

describe('observability bootstrap artifacts', () => {
  it('creates the expected infra, docs, and dashboard artifact paths', () => {
    expect(fs.existsSync(SIM_COMPOSE_PATH)).toBe(true);
    expect(fs.existsSync(PROD_COMPOSE_PATH)).toBe(true);
    expect(fs.existsSync(DATASOURCE_PATH)).toBe(true);
    expect(fs.existsSync(DASHBOARD_PROVIDER_PATH)).toBe(true);
    expect(fs.existsSync(GRAFANA_SQL_PATH)).toBe(true);
    expect(fs.existsSync(RUNBOOK_PATH)).toBe(true);

    const dashboardFiles = listFilesRecursive(GRAFANA_DASHBOARDS_DIR).filter((filePath) => filePath.endsWith('.json'));
    expect(dashboardFiles.length).toBeGreaterThan(0);
  });

  it('pins sim and prod compose images and avoids latest tags', () => {
    const simCompose = readUtf8(SIM_COMPOSE_PATH);
    expect(simCompose).toMatch(/image:\s*arizephoenix\/phoenix:version-8\.0\.0/);
    expect(simCompose).not.toMatch(/:latest\b/);

    const prodCompose = readUtf8(PROD_COMPOSE_PATH);
    expect(prodCompose).toMatch(/image:\s*arizephoenix\/phoenix:version-8\.0\.0/);
    expect(prodCompose).toMatch(/image:\s*postgres:16/);
    expect(prodCompose).toMatch(/image:\s*grafana\/grafana:11\.0\.0/);
    expect(prodCompose).not.toMatch(/:latest\b/);
    expect(prodCompose).not.toMatch(/^\s{2}prometheus:\s*$/m);
  });

  it('adds the expected obs:* package scripts', () => {
    const packageJson = JSON.parse(readUtf8(PACKAGE_JSON_PATH)) as PackageJsonShape;
    const scripts = packageJson.scripts ?? {};

    for (const [scriptName, expectedCommand] of Object.entries(REQUIRED_PACKAGE_SCRIPTS)) {
      expect(scripts[scriptName]).toBe(expectedCommand);
    }
  });

  it('renders the observability env proposal keys through the Phase 0a generator flow', async () => {
    const outputPath = path.join(makeTempDir(), '.env.local.proposed');
    const result = await generateEnvLocalProposed(['--output', outputPath, '--quiet']);
    const rendered = readUtf8(result.outputPath);

    for (const expectedLine of REQUIRED_ENV_LINES) {
      expect(rendered).toContain(expectedLine);
    }
  });

  it('keeps ADR-0009 present and linked from the ADR index', () => {
    expect(fs.existsSync(ADR_PATH)).toBe(true);
    expect(readUtf8(ADR_INDEX_PATH)).toContain('ADR-0009-observability-bootstrap-contract.md');
  });

  it('keeps PR-O1 scope free of telemetry package imports and runtime observability wiring', () => {
    // Only files that can actually `import` count as PR-O1 import-scope.
    // Markdown / SQL / compose / example files reference forbidden package
    // names as prose (e.g. ADR-0009 documenting what is deferred to PR-O2/O3
    // and what the test itself forbids) — that is not an import.
    const IMPORT_CAPABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']);

    const prO1ImportCapableFiles = [
      path.join(REPO_ROOT, 'scripts', 'observability-bootstrap.test.ts'),
      path.join(REPO_ROOT, 'scripts', 'generate-env-local-proposed.ts'),
      path.join(REPO_ROOT, 'scripts', 'generate-env-local-proposed.test.ts'),
      PACKAGE_JSON_PATH,
      ...listFilesRecursive(OBSERVABILITY_ROOT),
    ]
      .filter((filePath) => fs.existsSync(filePath))
      .filter((filePath) => IMPORT_CAPABLE_EXTENSIONS.has(path.extname(filePath)));

    for (const filePath of prO1ImportCapableFiles) {
      const content = readUtf8(filePath);
      for (const matcher of FORBIDDEN_OBSERVABILITY_IMPORTS) {
        expect(content).not.toMatch(matcher);
      }
    }

    for (const filePath of FORBIDDEN_RUNTIME_PATHS) {
      const content = readUtf8(filePath);
      for (const matcher of FORBIDDEN_RUNTIME_MARKERS) {
        expect(content).not.toMatch(matcher);
      }
    }
  });
});
