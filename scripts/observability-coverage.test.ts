import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectObservabilityCoverage,
  formatCoverageGateFailure,
  validateObservabilityCoverage,
} from './observability-coverage-lib.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'docs', 'observability-span-schema.md');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dirPath of tempDirs.splice(0)) {
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true });
  }
});

function makeTempRepo(): string {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-observability-coverage-'));
  tempDirs.push(dirPath);
  fs.mkdirSync(path.join(dirPath, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dirPath, 'docs', 'observability-span-schema.md'), fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return dirPath;
}

function writeRepoFile(repoRoot: string, relativePath: string, content: string): void {
  const filePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function buildBaselineSource(extraCalls = '', deliveryAttrs = "chainAttrs({ 'msg.id': 'm-1', 'message.kind': 'chat' })"): string {
  return `
import { withSpan } from './with-span.js';
import { chainAttrs, outputAttrs, rootInputAttrs } from './openinference.js';

export async function runCoverageFixture(): Promise<void> {
  await withSpan(
    'router.route',
    chainAttrs({ 'channel.type': 'cli' }),
    async () => {},
  );

  await withSpan(
    'router.deliver_to_agent',
    rootInputAttrs({ sessionId: 'sess-1', userId: 'user-1', inputValue: 'hello' }),
    async () => {},
  );

  await withSpan(
    'delivery.session.drain',
    chainAttrs({ 'session.id': 'sess-1', 'message.count': 1 }),
    async () => {},
  );

  await withSpan(
    'delivery.message.deliver',
    ${deliveryAttrs},
    async () => {},
  );

  await withSpan(
    'delivery.channel.send',
    chainAttrs({ 'channel.type': 'cli', ...outputAttrs('hello world') }),
    async () => {},
  );

  await withSpan(
    'container.wake',
    chainAttrs({ 'session.id': 'sess-1', 'agent.group.id': 'agent-1' }),
    async () => {},
  );

  await withSpan(
    'container.spawn',
    chainAttrs({ 'session.id': 'sess-1', 'agent.group.id': 'agent-1', provider: 'mock' }),
    async () => {},
  );

  await withSpan(
    'container.kill',
    chainAttrs({ 'session.id': 'sess-1', reason: 'fixture' }),
    async () => {},
  );

  await withSpan(
    'channel.cli.receive',
    chainAttrs({ 'channel.type': 'cli' }),
    async () => {},
  );

  await withSpan(
    'channel.feishu.receive',
    chainAttrs({ 'channel.type': 'feishu', 'message.kind': 'chat' }),
    async () => {},
  );

${extraCalls}
}
`;
}

function makeFixtureRepo(opts: {
  baselineSource?: string;
  extraFiles?: Record<string, string>;
} = {}): string {
  const repoRoot = makeTempRepo();
  writeRepoFile(repoRoot, 'src/fixture.ts', opts.baselineSource ?? buildBaselineSource());

  for (const [relativePath, content] of Object.entries(opts.extraFiles ?? {})) {
    writeRepoFile(repoRoot, relativePath, content);
  }

  return repoRoot;
}

describe('observability coverage gate', () => {
  it('wires the shared scanner/report library', () => {
    expect(collectObservabilityCoverage).toBeTypeOf('function');
    expect(validateObservabilityCoverage).toBeTypeOf('function');
    expect(formatCoverageGateFailure).toBeTypeOf('function');
  });

  it('passes a compliant multiline fixture using chain/root/output helper patterns', () => {
    const repoRoot = makeFixtureRepo();
    const report = collectObservabilityCoverage({ repoRoot });
    const validation = validateObservabilityCoverage(report);

    expect(report.namespaces).toHaveLength(20);
    expect(report.migrations).toHaveLength(11);
    expect(report.moduleSlugs).toHaveLength(13);
    expect(validation.forwardViolations).toHaveLength(0);
    expect(validation.backwardViolations).toHaveLength(0);
    expect(validation.kindViolations).toHaveLength(0);
    expect(validation.deprecatedAttributeViolations).toHaveLength(0);
  });

  it('passes when the attrs argument is a nearby identifier bound through chainAttrs', () => {
    const repoRoot = makeFixtureRepo({
      baselineSource: `
import { withSpan } from './with-span.js';
import { chainAttrs, agentAttrs } from './openinference.js';

export async function runCoverageFixture(): Promise<void> {
  const spanAttrs = chainAttrs({ 'session.id': 'sess-1', 'message.count': 1 });

  await withSpan(
    'delivery.session.drain',
    spanAttrs,
    async () => {},
  );

  await withSpan(
    'router.route',
    chainAttrs({ 'channel.type': 'cli' }),
    async () => {},
  );

  await withSpan(
    'router.deliver_to_agent',
    agentAttrs({ 'session.id': 'sess-1', 'user.id': 'user-1', 'input.value': 'hello', 'input.mime_type': 'text/plain' }),
    async () => {},
  );

  await withSpan(
    'delivery.message.deliver',
    chainAttrs({ 'msg.id': 'm-1', 'message.kind': 'chat' }),
    async () => {},
  );

  await withSpan(
    'delivery.channel.send',
    chainAttrs({ 'channel.type': 'cli', 'output.value': 'hello', 'output.mime_type': 'text/plain' }),
    async () => {},
  );

  await withSpan(
    'container.wake',
    chainAttrs({ 'session.id': 'sess-1', 'agent.group.id': 'agent-1' }),
    async () => {},
  );

  await withSpan(
    'container.spawn',
    chainAttrs({ 'session.id': 'sess-1', 'agent.group.id': 'agent-1', provider: 'mock' }),
    async () => {},
  );

  await withSpan(
    'container.kill',
    chainAttrs({ 'session.id': 'sess-1', reason: 'fixture' }),
    async () => {},
  );

  await withSpan(
    'channel.cli.receive',
    chainAttrs({ 'channel.type': 'cli' }),
    async () => {},
  );

  await withSpan(
    'channel.feishu.receive',
    chainAttrs({ 'channel.type': 'feishu', 'message.kind': 'chat' }),
    async () => {},
  );
}
`,
    });

    const validation = validateObservabilityCoverage(collectObservabilityCoverage({ repoRoot }));

    expect(validation.kindViolations).toHaveLength(0);
  });

  it('fails forward validation for an unknown namespace', () => {
    const repoRoot = makeFixtureRepo({
      baselineSource: buildBaselineSource(`
  await withSpan(
    'foo.bar',
    chainAttrs({ 'channel.type': 'cli' }),
    async () => {},
  );
`),
    });

    const validation = validateObservabilityCoverage(collectObservabilityCoverage({ repoRoot }));

    expect(validation.forwardViolations.map((violation) => violation.name)).toContain('foo.bar');
    expect(formatCoverageGateFailure(validation)).toContain('Forward violations (1): foo.bar');
  });

  it('fails kind validation when a host span omits openinference.span.kind', () => {
    const repoRoot = makeFixtureRepo({
      baselineSource: buildBaselineSource('', "{ 'msg.id': 'm-1', 'message.kind': 'chat' }"),
    });

    const validation = validateObservabilityCoverage(collectObservabilityCoverage({ repoRoot }));

    expect(validation.kindViolations.map((violation) => violation.name)).toContain('delivery.message.deliver');
    expect(formatCoverageGateFailure(validation)).toContain('Kind violations (1): delivery.message.deliver');
  });

  it('fails backward validation when a keep/rename target is missing', () => {
    const repoRoot = makeFixtureRepo({
      baselineSource: buildBaselineSource().replace(
        /\s*await withSpan\(\s*'channel\.feishu\.receive'[\s\S]*?async \(\) => \{\},\s*\);\n/m,
        '\n',
      ),
    });

    const validation = validateObservabilityCoverage(collectObservabilityCoverage({ repoRoot }));

    expect(validation.backwardViolations.map((violation) => violation.requiredTarget)).toContain('channel.feishu.receive');
    expect(formatCoverageGateFailure(validation)).toContain('channel.feishu.receive');
  });

  it('fails backward validation when a deleted span still exists', () => {
    const repoRoot = makeFixtureRepo({
      baselineSource: buildBaselineSource(`
  await withSpan(
    'router.container.wake',
    chainAttrs({ 'session.id': 'sess-1' }),
    async () => {},
  );
`),
    });

    const validation = validateObservabilityCoverage(collectObservabilityCoverage({ repoRoot }));

    expect(validation.backwardViolations.map((violation) => violation.requiredTarget)).toContain('router.container.wake');
    expect(formatCoverageGateFailure(validation)).toContain('must be absent');
  });

  it('ignores excluded test files even when they contain invalid spans', () => {
    const repoRoot = makeFixtureRepo({
      extraFiles: {
        'src/example.test.ts': `
import { withSpan } from './with-span.js';

export async function ignoredFixture(): Promise<void> {
  await withSpan('foo.bar', {}, async () => {});
}
`,
      },
    });

    const validation = validateObservabilityCoverage(collectObservabilityCoverage({ repoRoot }));

    expect(validation.forwardViolations).toHaveLength(0);
    expect(validation.kindViolations).toHaveLength(0);
  });

  it('ignores runner files without withSpan calls', () => {
    const repoRoot = makeFixtureRepo({
      extraFiles: {
        'container/agent-runner/src/no-spans.ts': 'export const runnerPlaceholder = true;\n',
      },
    });

    const report = collectObservabilityCoverage({ repoRoot });
    const validation = validateObservabilityCoverage(report);

    expect(report.runnerSpanOccurrences).toHaveLength(0);
    expect(validation.forwardViolations).toHaveLength(0);
  });

  it('fails when deprecated msg.kind is still present in production source', () => {
    const repoRoot = makeFixtureRepo({
      baselineSource: buildBaselineSource('', "chainAttrs({ 'msg.id': 'm-1', 'msg.kind': 'chat' })"),
    });

    const validation = validateObservabilityCoverage(collectObservabilityCoverage({ repoRoot }));

    expect(validation.deprecatedAttributeViolations.map((violation) => violation.key)).toContain('msg.kind');
    expect(formatCoverageGateFailure(validation)).toContain('Deprecated attr violations (1): msg.kind');
  });

  it('passes the real repository coverage scan', () => {
    const report = collectObservabilityCoverage({ repoRoot: REPO_ROOT });
    const validation = validateObservabilityCoverage(report);

    expect(report.namespaces).toHaveLength(20);
    expect(report.migrations).toHaveLength(11);
    expect(report.moduleSlugs).toHaveLength(13);
    expect(report.hostSpanOccurrences.length).toBeGreaterThanOrEqual(10);
    expect(report.runnerSpanOccurrences).toHaveLength(0);
    expect(validation.forwardViolations).toHaveLength(0);
    expect(validation.backwardViolations).toHaveLength(0);
    expect(validation.kindViolations).toHaveLength(0);
    expect(validation.deprecatedAttributeViolations).toHaveLength(0);
  });
});
