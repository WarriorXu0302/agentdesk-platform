import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type CoverageScope = 'host' | 'runner';
export type CoverageAction = 'Keep' | 'Rename' | 'DELETE';
export type AttributeState = 'present' | 'absent' | 'conditional' | 'n/a';

export interface NamespaceRow {
  namespace: string;
  domain: string;
  defaultKind: string;
  traceRole: string;
  status: string;
  exampleSpan: string;
  owningFiles: string;
}

export interface MigrationRow {
  currentName: string;
  newName: string | null;
  action: CoverageAction;
  notes: string;
  requiredTarget: string | null;
}

export interface AttrCoverage {
  openinferenceSpanKind: AttributeState;
  sessionId: AttributeState;
  userId: AttributeState;
  inputValue: AttributeState;
  inputMimeType: AttributeState;
  outputValue: AttributeState;
  outputMimeType: AttributeState;
  notes: string[];
}

export interface SpanOccurrence {
  name: string;
  namespace: string;
  scope: CoverageScope;
  filePath: string;
  relativePath: string;
  line: number;
  callSlice: string;
  attrCoverage: AttrCoverage;
}

export interface NamespaceCoverageRow extends NamespaceRow {
  actualSpanCount: number;
  exampleSpansFound: string[];
}

export interface MigrationCoverageRow extends MigrationRow {
  pass: boolean;
  runtimeStatus: 'PASS' | 'FAIL';
  sourceLocations: string[];
}

export interface DeprecatedAttributeOccurrence {
  key: 'msg.kind';
  filePath: string;
  relativePath: string;
  line: number;
}

export interface ObservabilityCoverageReport {
  repoRoot: string;
  schemaPath: string;
  namespaces: NamespaceRow[];
  migrations: MigrationRow[];
  moduleSlugs: string[];
  hostSpanOccurrences: SpanOccurrence[];
  runnerSpanOccurrences: SpanOccurrence[];
  allSpanOccurrences: SpanOccurrence[];
  namespaceCoverage: NamespaceCoverageRow[];
  migrationCoverage: MigrationCoverageRow[];
  deprecatedAttributeOccurrences: DeprecatedAttributeOccurrence[];
}

export interface CoverageViolation {
  name: string;
  filePath: string;
  relativePath: string;
  line: number;
}

export interface BackwardViolation {
  requiredTarget: string;
  action: CoverageAction;
  message: string;
  sourceLocations: string[];
}

export interface DeprecatedAttributeViolation {
  key: 'msg.kind';
  filePath: string;
  relativePath: string;
  line: number;
}

export interface ObservabilityCoverageValidation {
  forwardViolations: CoverageViolation[];
  backwardViolations: BackwardViolation[];
  kindViolations: CoverageViolation[];
  deprecatedAttributeViolations: DeprecatedAttributeViolation[];
}

export interface CollectCoverageOptions {
  repoRoot?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

const SCHEMA_PATH_SEGMENTS = ['docs', 'observability-span-schema.md'] as const;
const HOST_SOURCE_SEGMENTS = ['src'] as const;
const RUNNER_SOURCE_SEGMENTS = ['container', 'agent-runner', 'src'] as const;

const WITH_SPAN_PATTERN = /withSpan\(\s*['"]([^'"]+)['"]/g;
const NAMESPACE_ROW_PATTERN = /^\| `([a-z_]+)\.\*` \|/gm;
const DEPRECATED_ATTR_PATTERN = /['"]msg\.kind['"]/g;

const REQUIRED_KIND_MARKERS = [
  'openinference.span.kind',
  'chainAttrs(',
  'rootInputAttrs(',
  'outputAttrs(',
  '[SemanticConventions.OPENINFERENCE_SPAN_KIND]',
];

export function collectObservabilityCoverage(
  options: CollectCoverageOptions = {},
): ObservabilityCoverageReport {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const schemaPath = path.join(repoRoot, ...SCHEMA_PATH_SEGMENTS);
  const schema = readUtf8(schemaPath);

  const namespaces = parseNamespaceRows(schema);
  const migrations = parseMigrationRows(schema);
  const moduleSlugs = parseModuleSlugs(schema);

  const hostRoot = path.join(repoRoot, ...HOST_SOURCE_SEGMENTS);
  const runnerRoot = path.join(repoRoot, ...RUNNER_SOURCE_SEGMENTS);

  const hostFiles = collectSourceFiles(hostRoot);
  const runnerFiles = collectSourceFiles(runnerRoot);

  const hostSpanOccurrences = hostFiles.flatMap((filePath) => collectSpanOccurrences(repoRoot, filePath, 'host'));
  const runnerSpanOccurrences = runnerFiles.flatMap((filePath) => collectSpanOccurrences(repoRoot, filePath, 'runner'));
  const allSpanOccurrences = [...hostSpanOccurrences, ...runnerSpanOccurrences];
  const deprecatedAttributeOccurrences = [...hostFiles, ...runnerFiles].flatMap((filePath) =>
    collectDeprecatedAttributeOccurrences(repoRoot, filePath),
  );

  const namespaceCoverage = buildNamespaceCoverage(namespaces, allSpanOccurrences);
  const migrationCoverage = buildMigrationCoverage(migrations, allSpanOccurrences);

  return {
    repoRoot,
    schemaPath,
    namespaces,
    migrations,
    moduleSlugs,
    hostSpanOccurrences,
    runnerSpanOccurrences,
    allSpanOccurrences,
    namespaceCoverage,
    migrationCoverage,
    deprecatedAttributeOccurrences,
  };
}

export function validateObservabilityCoverage(
  report: ObservabilityCoverageReport,
): ObservabilityCoverageValidation {
  const namespaceRegistry = new Set(report.namespaces.map((row) => row.namespace));

  const forwardViolations = report.allSpanOccurrences
    .filter((occurrence) => !namespaceRegistry.has(occurrence.namespace))
    .map((occurrence) => ({
      name: occurrence.name,
      filePath: occurrence.filePath,
      relativePath: occurrence.relativePath,
      line: occurrence.line,
    }));

  const backwardViolations: BackwardViolation[] = [];
  for (const migration of report.migrations) {
    if (migration.action === 'DELETE') {
      const deletedOccurrences = report.allSpanOccurrences.filter((occurrence) => occurrence.name === migration.currentName);
      if (deletedOccurrences.length > 0) {
        backwardViolations.push({
          requiredTarget: migration.currentName,
          action: migration.action,
          message: `${migration.currentName} must be absent because schema §7 marks it DELETE`,
          sourceLocations: deletedOccurrences.map(formatOccurrenceLocation),
        });
      }
      continue;
    }

    if (!migration.requiredTarget) continue;
    const requiredOccurrences = report.allSpanOccurrences.filter(
      (occurrence) => occurrence.name === migration.requiredTarget,
    );
    if (requiredOccurrences.length === 0) {
      backwardViolations.push({
        requiredTarget: migration.requiredTarget,
        action: migration.action,
        message: `${migration.requiredTarget} is declared in schema §7 but missing in production code`,
        sourceLocations: [],
      });
    }
  }

  const kindViolations = report.hostSpanOccurrences
    .filter((occurrence) => occurrence.attrCoverage.openinferenceSpanKind !== 'present')
    .map((occurrence) => ({
      name: occurrence.name,
      filePath: occurrence.filePath,
      relativePath: occurrence.relativePath,
      line: occurrence.line,
    }));

  const deprecatedAttributeViolations = report.deprecatedAttributeOccurrences.map((occurrence) => ({
    key: occurrence.key,
    filePath: occurrence.filePath,
    relativePath: occurrence.relativePath,
    line: occurrence.line,
  }));

  return {
    forwardViolations,
    backwardViolations,
    kindViolations,
    deprecatedAttributeViolations,
  };
}

export function formatCoverageGateFailure(validation: ObservabilityCoverageValidation): string {
  const lines = ['Coverage gate FAILED:'];

  if (validation.forwardViolations.length > 0) {
    lines.push(
      `  Forward violations (${validation.forwardViolations.length}): ${validation.forwardViolations
        .map((violation) => `${violation.name} (${violation.relativePath}:${violation.line})`)
        .join(', ')}`,
    );
  }

  if (validation.backwardViolations.length > 0) {
    lines.push(
      `  Backward violations (${validation.backwardViolations.length}): ${validation.backwardViolations
        .map((violation) => {
          if (violation.sourceLocations.length > 0) {
            return `${violation.requiredTarget} (${violation.sourceLocations.join(', ')}) ${violation.message}`;
          }
          return `${violation.requiredTarget} (${violation.message})`;
        })
        .join(', ')}`,
    );
  }

  if (validation.kindViolations.length > 0) {
    lines.push(
      `  Kind violations (${validation.kindViolations.length}): ${validation.kindViolations
        .map((violation) => `${violation.name} (${violation.relativePath}:${violation.line}) missing openinference.span.kind`)
        .join(', ')}`,
    );
  }

  if (validation.deprecatedAttributeViolations.length > 0) {
    lines.push(
      `  Deprecated attr violations (${validation.deprecatedAttributeViolations.length}): ${validation.deprecatedAttributeViolations
        .map((violation) => `${violation.key} (${violation.relativePath}:${violation.line})`)
        .join(', ')}`,
    );
  }

  return lines.join('\n');
}

function buildNamespaceCoverage(
  namespaces: NamespaceRow[],
  occurrences: SpanOccurrence[],
): NamespaceCoverageRow[] {
  return namespaces.map((namespaceRow) => {
    const namespaceOccurrences = occurrences.filter((occurrence) => occurrence.namespace === namespaceRow.namespace);
    return {
      ...namespaceRow,
      actualSpanCount: namespaceOccurrences.length,
      exampleSpansFound: unique(namespaceOccurrences.map((occurrence) => occurrence.name)),
    };
  });
}

function buildMigrationCoverage(
  migrations: MigrationRow[],
  occurrences: SpanOccurrence[],
): MigrationCoverageRow[] {
  return migrations.map((migration) => {
    if (migration.action === 'DELETE') {
      const deletedOccurrences = occurrences.filter((occurrence) => occurrence.name === migration.currentName);
      return {
        ...migration,
        pass: deletedOccurrences.length === 0,
        runtimeStatus: deletedOccurrences.length === 0 ? 'PASS' : 'FAIL',
        sourceLocations: deletedOccurrences.map(formatOccurrenceLocation),
      };
    }

    if (!migration.requiredTarget) {
      return {
        ...migration,
        pass: false,
        runtimeStatus: 'FAIL',
        sourceLocations: [],
      };
    }

    const requiredOccurrences = occurrences.filter((occurrence) => occurrence.name === migration.requiredTarget);
    return {
      ...migration,
      pass: requiredOccurrences.length > 0,
      runtimeStatus: requiredOccurrences.length > 0 ? 'PASS' : 'FAIL',
      sourceLocations: requiredOccurrences.map(formatOccurrenceLocation),
    };
  });
}

function parseNamespaceRows(schema: string): NamespaceRow[] {
  const section = sectionBetween(schema, '## §3. Top-Level Namespace Catalog', '## §4. Standard Sub-Operations Within Common Namespaces');
  const rows = [...section.matchAll(NAMESPACE_ROW_PATTERN)].map((match) => {
    const line = readFullLine(section, match.index ?? 0);
    const cells = parseMarkdownTableCells(line);
    return {
      namespace: match[1],
      domain: cells[1] ?? '',
      defaultKind: unwrapCode(cells[2] ?? ''),
      traceRole: cells[3] ?? '',
      status: cells[4] ?? '',
      exampleSpan: unwrapCode(cells[5] ?? ''),
      owningFiles: cells[6] ?? '',
    } satisfies NamespaceRow;
  });

  if (rows.length !== 20) {
    throw new Error(`Expected exactly 20 namespace rows in schema §3; found ${rows.length}`);
  }

  return rows;
}

function parseMigrationRows(schema: string): MigrationRow[] {
  const section = sectionBetween(schema, '## §7. Migration Plan', '### 7.1 Example migration: rename channel spans');
  const rows = [...section.matchAll(/^\| `[^`]+` \|/gm)].map((match) => {
    const line = readFullLine(section, match.index ?? 0);
    const cells = parseMarkdownTableCells(line);
    const currentName = unwrapCode(cells[0] ?? '');
    const rawNewName = cells[1] ?? '';
    const action = normalizeAction(cells[2] ?? '');
    const newName = rawNewName.trim() === '—' ? null : unwrapCode(rawNewName);
    return {
      currentName,
      newName,
      action,
      notes: cells[3] ?? '',
      requiredTarget: action === 'DELETE' ? null : action === 'Rename' ? newName : newName ?? currentName,
    } satisfies MigrationRow;
  });

  if (rows.length !== 11) {
    throw new Error(`Expected exactly 11 migration rows in schema §7; found ${rows.length}`);
  }

  return rows;
}

function parseModuleSlugs(schema: string): string[] {
  const section = sectionBetween(schema, '### 4.13 `module.*`', '### 4.14 Registration rule for future additions');
  const slugs = [...section.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((match) => match[1]);
  if (slugs.length !== 13) {
    throw new Error(`Expected exactly 13 module slugs in schema §4.13; found ${slugs.length}`);
  }
  return slugs;
}

function normalizeAction(value: string): CoverageAction {
  const normalized = value.trim();
  if (normalized === 'Keep' || normalized === 'Rename' || normalized === 'DELETE') {
    return normalized;
  }
  throw new Error(`Unsupported schema §7 action: ${value}`);
}

function collectSourceFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  return listFilesRecursive(rootDir)
    .filter((filePath) => filePath.endsWith('.ts'))
    .filter((filePath) => !filePath.endsWith('.test.ts'))
    .sort();
}

function listFilesRecursive(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.sisyphus' || entry.name === 'reports') {
      continue;
    }
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(entryPath));
    } else {
      files.push(entryPath);
    }
  }

  return files;
}

function collectSpanOccurrences(repoRoot: string, filePath: string, scope: CoverageScope): SpanOccurrence[] {
  const content = readUtf8(filePath);
  const occurrences: SpanOccurrence[] = [];

  for (const match of content.matchAll(WITH_SPAN_PATTERN)) {
    const name = match[1];
    const startIndex = match.index ?? 0;
    const line = lineNumberOfIndex(content, startIndex);
    const relativePath = toRepoRelativePath(repoRoot, filePath);
    const callSlice = extractCallSlice(content, startIndex);

    occurrences.push({
      name,
      namespace: name.split('.')[0] ?? name,
      scope,
      filePath,
      relativePath,
      line,
      callSlice,
      attrCoverage: detectAttrCoverage(name, callSlice, content, startIndex),
    });
  }

  return occurrences;
}

function collectDeprecatedAttributeOccurrences(repoRoot: string, filePath: string): DeprecatedAttributeOccurrence[] {
  const content = readUtf8(filePath);
  const occurrences: DeprecatedAttributeOccurrence[] = [];

  for (const match of content.matchAll(DEPRECATED_ATTR_PATTERN)) {
    const line = lineNumberOfIndex(content, match.index ?? 0);
    occurrences.push({
      key: 'msg.kind',
      filePath,
      relativePath: toRepoRelativePath(repoRoot, filePath),
      line,
    });
  }

  return occurrences;
}

function detectAttrCoverage(name: string, callSlice: string, fullSource: string, callStartIndex: number): AttrCoverage {
  const notes: string[] = [];
  const hasChainAttrs = callSlice.includes('chainAttrs(');
  const hasRootInputAttrs = callSlice.includes('rootInputAttrs(');
  const hasOutputAttrs = callSlice.includes('outputAttrs(');
  const hasLiteralKind = callSlice.includes('openinference.span.kind');
  const hasSemanticConventionKind = callSlice.includes('[SemanticConventions.OPENINFERENCE_SPAN_KIND]');
  const attrsBinding = resolveNearbyAttrsBinding(callSlice, fullSource, callStartIndex);
  const bindingSlice = attrsBinding?.valueSlice ?? '';
  const hasBoundChainAttrs = bindingSlice.includes('chainAttrs(');
  const hasBoundRootInputAttrs = bindingSlice.includes('rootInputAttrs(');
  const hasBoundOutputAttrs = bindingSlice.includes('outputAttrs(');
  const hasBoundLiteralKind = bindingSlice.includes('openinference.span.kind');
  const hasBoundSemanticConventionKind = bindingSlice.includes('[SemanticConventions.OPENINFERENCE_SPAN_KIND]');

  let openinferenceSpanKind: AttributeState = 'absent';
  if (
    hasLiteralKind ||
    hasChainAttrs ||
    hasRootInputAttrs ||
    hasOutputAttrs ||
    hasSemanticConventionKind ||
    hasBoundChainAttrs ||
    hasBoundRootInputAttrs ||
    hasBoundOutputAttrs ||
    hasBoundLiteralKind ||
    hasBoundSemanticConventionKind
  ) {
    openinferenceSpanKind = 'present';
  }

  if (hasChainAttrs) notes.push('kind via chainAttrs()');
  if (hasRootInputAttrs) notes.push('rootInputAttrs() provides root input coverage');
  if (hasOutputAttrs) notes.push('outputAttrs() provides output coverage');
  if (hasLiteralKind) notes.push('literal openinference.span.kind key present');
  if (hasSemanticConventionKind) notes.push('SemanticConventions.OPENINFERENCE_SPAN_KIND key present');
  if (attrsBinding && (hasBoundChainAttrs || hasBoundRootInputAttrs || hasBoundOutputAttrs || hasBoundLiteralKind)) {
    notes.push(`attrs via nearby binding ${attrsBinding.name}`);
  }

  const preSessionSpan = name === 'router.route' || /^channel\.[a-z_]+\.receive$/.test(name);

  let sessionId = containsAttrKey(callSlice, 'session.id') || containsAttrKey(bindingSlice, 'session.id') ? 'present' : 'absent';
  let userId = containsAttrKey(callSlice, 'user.id') || containsAttrKey(bindingSlice, 'user.id') ? 'present' : 'absent';
  let inputValue = containsAttrKey(callSlice, 'input.value') || containsAttrKey(bindingSlice, 'input.value') ? 'present' : 'absent';
  let inputMimeType =
    containsAttrKey(callSlice, 'input.mime_type') || containsAttrKey(bindingSlice, 'input.mime_type') ? 'present' : 'absent';
  let outputValue = containsAttrKey(callSlice, 'output.value') || containsAttrKey(bindingSlice, 'output.value') ? 'present' : 'absent';
  let outputMimeType =
    containsAttrKey(callSlice, 'output.mime_type') || containsAttrKey(bindingSlice, 'output.mime_type') ? 'present' : 'absent';

  if (hasRootInputAttrs || hasBoundRootInputAttrs) {
    sessionId = 'present';
    userId = 'conditional';
    inputValue = 'present';
    inputMimeType = 'present';
  }

  if (hasOutputAttrs || hasBoundOutputAttrs) {
    outputValue = 'present';
    outputMimeType = 'present';
  }

  if (preSessionSpan) {
    if (sessionId === 'absent') sessionId = 'n/a';
    if (userId === 'absent') userId = 'n/a';
    if (inputValue === 'absent') inputValue = 'n/a';
    if (inputMimeType === 'absent') inputMimeType = 'n/a';
  }

  return {
    openinferenceSpanKind,
    sessionId,
    userId,
    inputValue,
    inputMimeType,
    outputValue,
    outputMimeType,
    notes,
  };
}

function resolveNearbyAttrsBinding(
  callSlice: string,
  fullSource: string,
  callStartIndex: number,
): { name: string; valueSlice: string } | null {
  const identifierMatch = callSlice.match(
    /withSpan\(\s*['"][^'"]+['"]\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|\))/,
  );
  if (!identifierMatch) return null;

  const name = identifierMatch[1];
  const lookbehindStart = Math.max(0, callStartIndex - 4000);
  const lookbehindSource = fullSource.slice(lookbehindStart, callStartIndex);
  const lookbehindLines = lookbehindSource.split('\n');
  const bindingLinePattern = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=\\s*(.*)$`);

  for (let index = lookbehindLines.length - 1; index >= Math.max(0, lookbehindLines.length - 30); index -= 1) {
    const line = lookbehindLines[index] ?? '';
    const bindingMatch = line.match(bindingLinePattern);
    if (!bindingMatch) continue;

    let valueSlice = bindingMatch[1] ?? '';
    if (valueSlice.includes(';')) {
      valueSlice = valueSlice.slice(0, valueSlice.indexOf(';'));
      return { name, valueSlice };
    }

    for (let continuationIndex = index + 1; continuationIndex < lookbehindLines.length; continuationIndex += 1) {
      const continuationLine = lookbehindLines[continuationIndex] ?? '';
      valueSlice += `\n${continuationLine}`;
      if (continuationLine.includes(';')) {
        valueSlice = valueSlice.slice(0, valueSlice.lastIndexOf(';'));
        return { name, valueSlice };
      }
    }

    return { name, valueSlice };
  }

  return null;
}

function containsAttrKey(source: string, key: string): boolean {
  return source.includes(`'${key}'`) || source.includes(`"${key}"`);
}

function extractCallSlice(source: string, withSpanIndex: number): string {
  const openParenIndex = source.indexOf('(', withSpanIndex);
  if (openParenIndex < 0) {
    return source.slice(withSpanIndex, indexAfterLineWindow(source, withSpanIndex, 20));
  }

  const closeParenIndex = findMatchingParenIndex(source, openParenIndex);
  const endIndex = closeParenIndex >= 0 ? closeParenIndex + 1 : indexAfterLineWindow(source, withSpanIndex, 20);
  return source.slice(withSpanIndex, endIndex);
}

function findMatchingParenIndex(source: string, openParenIndex: number): number {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplateString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = openParenIndex; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1] ?? '';
    const previous = source[index - 1] ?? '';

    if (inLineComment) {
      if (current === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inSingleQuote) {
      if (current === '\'' && previous !== '\\') inSingleQuote = false;
      continue;
    }

    if (inDoubleQuote) {
      if (current === '"' && previous !== '\\') inDoubleQuote = false;
      continue;
    }

    if (inTemplateString) {
      if (current === '`' && previous !== '\\') inTemplateString = false;
      continue;
    }

    if (current === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (current === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (current === '\'') {
      inSingleQuote = true;
      continue;
    }

    if (current === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (current === '`') {
      inTemplateString = true;
      continue;
    }

    if (current === '(') {
      depth += 1;
      continue;
    }

    if (current === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function indexAfterLineWindow(source: string, startIndex: number, lineWindow: number): number {
  let newlinesSeen = 0;
  for (let index = startIndex; index < source.length; index += 1) {
    if (source[index] === '\n') {
      newlinesSeen += 1;
      if (newlinesSeen >= lineWindow) {
        return index + 1;
      }
    }
  }
  return source.length;
}

function sectionBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) {
    throw new Error(`${start} must exist in schema document`);
  }

  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) {
    throw new Error(`${end} must appear after ${start} in schema document`);
  }

  return source.slice(startIndex, endIndex);
}

function parseMarkdownTableCells(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function readFullLine(source: string, index: number): string {
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const nextNewline = source.indexOf('\n', index);
  const lineEnd = nextNewline >= 0 ? nextNewline : source.length;
  return source.slice(lineStart, lineEnd);
}

function unwrapCode(value: string): string {
  return value.replace(/^`/, '').replace(/`$/, '').trim();
}

function lineNumberOfIndex(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === '\n') line += 1;
  }
  return line;
}

function formatOccurrenceLocation(occurrence: SpanOccurrence): string {
  return `${occurrence.relativePath}:${occurrence.line}`;
}

function toRepoRelativePath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

export function hasCoverageViolations(validation: ObservabilityCoverageValidation): boolean {
  return (
    validation.forwardViolations.length > 0 ||
    validation.backwardViolations.length > 0 ||
    validation.kindViolations.length > 0 ||
    validation.deprecatedAttributeViolations.length > 0
  );
}
