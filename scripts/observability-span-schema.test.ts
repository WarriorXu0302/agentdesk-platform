import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const schemaPath = join(root, 'docs', 'observability-span-schema.md');
const evidenceDir = join(root, '.sisyphus', 'evidence');
const evidencePath = join(evidenceDir, 'task-1-doc-contract-green.txt');

function sectionBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `${start} must exist`);

  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `${end} must appear after ${start}`);

  return source.slice(startIndex, endIndex);
}

test('observability span schema contract', () => {
  const doc = readFileSync(schemaPath, 'utf8');

  const requiredSections = [
    '## §0. Status Block',
    '## §1. Design Goals',
    '## §2. Naming Grammar',
    '## §3. Top-Level Namespace Catalog',
    '## §4. Standard Sub-Operations Within Common Namespaces',
    '## §5. Required Attributes Per Span',
    '## §5b. Trace Topology Rules',
    '## §6. Forbidden Patterns',
    '## §7. Migration Plan',
    '## §8. Decision Log',
    '## §9. Operational Discipline',
    '## §10. Future Extensions',
    '## §11. References',
  ];

  let previousIndex = -1;
  for (const section of requiredSections) {
    const index = doc.indexOf(section);
    assert.ok(index > previousIndex, `${section} must exist in order`);
    previousIndex = index;
  }

  const statusSection = sectionBetween(doc, '## §0. Status Block', '## §1. Design Goals');
  assert.match(statusSection, /v1\.0/i, '§0 must declare v1.0');
  assert.match(statusSection, /binding/i, '§0 must declare binding authority');

  const grammarSection = sectionBetween(doc, '## §2. Naming Grammar', '## §3. Top-Level Namespace Catalog');
  assert.match(grammarSection, /snake_case/i, '§2 must require snake_case');

  const namespaceSection = sectionBetween(doc, '## §3. Top-Level Namespace Catalog', '## §4. Standard Sub-Operations Within Common Namespaces');
  const namespaceRows = [...namespaceSection.matchAll(/^\| `([a-z_]+\.\*)` \|/gm)];
  assert.equal(namespaceRows.length, 20, `§3 must contain exactly 20 namespace rows; got ${namespaceRows.length}`);

  const migrationSection = sectionBetween(doc, '## §7. Migration Plan', '## §8. Decision Log');
  const migrationRows = [...migrationSection.matchAll(/^\| `[^`]+` \|/gm)];
  assert.equal(migrationRows.length, 11, `§7 must contain exactly 11 migration rows; got ${migrationRows.length}`);

  const decisionSection = sectionBetween(doc, '## §8. Decision Log', '## §9. Operational Discipline');
  assert.equal((decisionSection.match(/LOCKED/g) ?? []).length, 5, '§8 must contain exactly 5 LOCKED markers');
  assert.equal((decisionSection.match(/OPEN DECISION/g) ?? []).length, 0, '§8 must contain 0 OPEN DECISION markers');

  const topologySection = sectionBetween(doc, '## §5b. Trace Topology Rules', '## §6. Forbidden Patterns');
  for (const phrase of [
    'router.deliver_to_agent',
    'session-trace root',
    'pre-session span',
    'channel.*.receive',
    'router.route',
    'suppressed context',
  ]) {
    assert.ok(topologySection.includes(phrase), `§5b must include ${phrase}`);
  }

  const forbiddenSection = sectionBetween(doc, '## §6. Forbidden Patterns', '## §7. Migration Plan');
  for (const phrase of ['msg.kind', 'message.kind', 'fire-and-forget', 'redacted']) {
    assert.ok(forbiddenSection.includes(phrase), `§6 must include ${phrase}`);
  }

  const futureSection = sectionBetween(doc, '## §10. Future Extensions', '## §11. References');
  for (const phrase of [
    'Tree 1',
    'channel.feishu.receive',
    'router.route',
    'router.deliver_to_agent',
    'delivery.channel.send',
    'Tree 2',
    'agent.run',
    'agent.turn',
    'provider.request',
    'mcp.core.send_message',
    'Tree 3',
    'mcp.erp.execute',
    'erp.call',
    'module.erp_audit.emit',
    'db.audit.write',
    'Tree 4',
    'module.a2a.route',
    'db.session.write',
  ]) {
    assert.ok(futureSection.includes(phrase), `§10 must include ${phrase}`);
  }

  const referencesSection = doc.slice(doc.indexOf('## §11. References'));
  assert.ok(referencesSection.includes('ADR-0014'), '§11 must reference ADR-0014');

  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(evidencePath, 'observability span schema contract passed\n', 'utf8');
});
