import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from './generate-env-local-proposed.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muap-env-proposal-'));
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
});

describe('generate-env-local-proposed', () => {
  it('renders the canonical Phase 0a env template into the requested output path', async () => {
    const output = path.join(tmpDir, '.env.local.proposed');

    const result = await run(['--output', output, '--quiet']);

    expect(fs.existsSync(output)).toBe(true);
    const rendered = fs.readFileSync(output, 'utf-8');

    expect(rendered).toMatch(/RUNTIME_MODE=simulation/);
    expect(rendered).toMatch(/ERP_GATEWAY_BASE_URL=/);
    expect(rendered).toMatch(/<MQTT_BROKER_HOST>/);
    expect(rendered).toMatch(/# Observability \(Phase 0b \/ PR-O1\)/);
    expect(rendered).toMatch(/PHOENIX_OTLP_ENDPOINT=http:\/\/localhost:4317/);
    expect(rendered).toMatch(/PHOENIX_COLLECTOR_ENDPOINT=http:\/\/localhost:6006\/v1\/traces/);
    expect(rendered).toMatch(/OTEL_SERVICE_NAME=frontlane-host/);
    expect(rendered).toMatch(/GRAFANA_HOST_PORT=3001/);
    expect(rendered).toMatch(/read-only upstream reference/i);
    expect(rendered).toMatch(/redaction/i);
    expect(result.templateSource === 'canonical' || result.templateSource === 'embedded').toBe(true);
    expect(result.outputPath).toBe(output);
  });

  it('falls back to embedded template when canonical source is missing', async () => {
    const missingTemplate = path.join(tmpDir, 'definitely-not-here.example');
    const output = path.join(tmpDir, '.env.local.proposed');

    const fakeTemplate = path.join(tmpDir, 'fake-template.example');
    fs.writeFileSync(fakeTemplate, '# explicit override\nFOO=bar\n', 'utf-8');

    const explicitResult = await run(['--template', fakeTemplate, '--output', output, '--quiet']);
    expect(explicitResult.templateSource).toBe('explicit');
    expect(fs.readFileSync(output, 'utf-8')).toContain('FOO=bar');

    await expect(run(['--template', missingTemplate, '--output', output, '--quiet'])).rejects.toThrow();
  });

  it('always overwrites a previous proposal artifact', async () => {
    const output = path.join(tmpDir, '.env.local.proposed');
    fs.writeFileSync(output, 'STALE=true\n', 'utf-8');

    await run(['--output', output, '--quiet']);

    const rendered = fs.readFileSync(output, 'utf-8');
    expect(rendered).not.toMatch(/STALE=true/);
    expect(rendered).toMatch(/RUNTIME_MODE=/);
  });

  it('extracts only uncommented variable keys for diffing', async () => {
    const output = path.join(tmpDir, '.env.local.proposed');
    const result = await run(['--output', output, '--quiet']);

    expect(result.diff.proposalKeys).toContain('RUNTIME_MODE');
    expect(result.diff.proposalKeys).toContain('ERP_GATEWAY_BASE_URL');
    expect(result.diff.proposalKeys).toContain('PHOENIX_OTLP_ENDPOINT');
    expect(result.diff.proposalKeys).toContain('PHOENIX_COLLECTOR_ENDPOINT');
    expect(result.diff.proposalKeys).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(result.diff.proposalKeys).toContain('OTEL_SERVICE_NAME');
    expect(result.diff.proposalKeys).toContain('PHOENIX_PROJECT_NAME');
    expect(result.diff.proposalKeys).toContain('GRAFANA_HOST_PORT');
    expect(result.diff.proposalKeys).not.toContain('ERP_GATEWAY_SIGNING_KEY');
    expect(result.diff.proposalKeys).not.toContain('MQTT_BROKER_HOST');
  });
});
