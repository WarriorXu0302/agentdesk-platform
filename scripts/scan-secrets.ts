/**
 * Staged-diff secret scanner (ADR-0029).
 *
 * Used by the committed git hook at `git-hooks/pre-commit` to block commits
 * that would introduce a private key, an AWS access-key id, or one of the
 * platform's own known-weak / placeholder secrets. The intent is to move the
 * "forgot to scrub a credential" failure left — from a startup error or a leak
 * — to the moment of `git commit`, where it's cheapest to fix.
 *
 * Design:
 *   - The scanning logic is a pure function (`scanForSecrets`) over a string,
 *     so it is unit-testable without a real git repo or staged changes
 *     (see scripts/scan-secrets.test.ts).
 *   - The placeholder/weak-secret half deliberately REUSES the host's
 *     deny-list (`src/security/known-weak-secrets.ts`, ADR-0025) so the hook
 *     and the runtime config validator agree on what "weak" means and there's
 *     a single source of truth to maintain.
 *   - When run as a CLI (the hook's path), it reads the staged diff via
 *     `git diff --cached` and exits non-zero on any finding.
 */

import { execFileSync } from 'node:child_process';

import { KNOWN_WEAK_SECRET_PLACEHOLDERS } from '../src/security/known-weak-secrets.js';

export interface SecretFinding {
  /** Stable id for the rule that fired, useful in messages and tests. */
  rule: 'private-key' | 'aws-access-key-id' | 'known-weak-secret';
  /** Human-readable explanation of what matched. */
  detail: string;
  /** The matched substring (truncated/labelled — never the full key body). */
  match: string;
}

/**
 * PEM-style private-key header. Matches RSA/EC/OPENSSH/PGP/generic variants:
 *   -----BEGIN RSA PRIVATE KEY-----
 *   -----BEGIN PRIVATE KEY-----
 *   -----BEGIN OPENSSH PRIVATE KEY-----
 */
const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

/** AWS access key id: literal AKIA/ASIA prefix + 16 uppercase alphanumerics. */
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/;

/**
 * Pull bare token-ish candidates out of a line so the known-weak deny-list can
 * be checked against assignment right-hand sides (`KEY=changeme`,
 * `key: "changeme"`, `key = changeme`) as well as standalone tokens. We split
 * on common separators and quoting so a value embedded in a config line is
 * still seen as its own candidate.
 */
function candidateTokens(line: string): string[] {
  return line
    .split(/[\s=:,"'`(){}[\]<>]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Scan a blob of text (typically the added lines of a staged diff) for
 * secrets. Pure — no IO. Returns one finding per distinct match so the caller
 * can print them all.
 */
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  const lines = text.split('\n');
  for (const rawLine of lines) {
    // When fed a unified diff we only care about ADDED content:
    //   - `+foo` (but not the `+++ b/path` file header) → strip the `+`, scan.
    //   - `-foo` (but not the `--- a/path` header) → a REMOVED line; skip it,
    //     since deleting a secret is the fix, not a violation.
    //   - `@@ ...`, `diff --git ...` and other metadata → scanned as-is; with
    //     `-U0` there are no context lines, and metadata never holds secrets.
    //   - Plain text with no diff marker (the unit tests' inputs) → scan as-is.
    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      continue;
    }
    const line = rawLine.startsWith('+') && !rawLine.startsWith('+++') ? rawLine.slice(1) : rawLine;

    const pk = PRIVATE_KEY_RE.exec(line);
    if (pk) {
      const key = `private-key:${pk[0]}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({
          rule: 'private-key',
          detail: 'PEM private-key header detected — do not commit private keys',
          match: pk[0],
        });
      }
    }

    const aws = AWS_ACCESS_KEY_RE.exec(line);
    if (aws) {
      const key = `aws:${aws[0]}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({
          rule: 'aws-access-key-id',
          detail: 'AWS access key id detected',
          match: aws[0],
        });
      }
    }

    for (const token of candidateTokens(line)) {
      const normalized = token.trim().toLowerCase();
      if (KNOWN_WEAK_SECRET_PLACEHOLDERS.has(normalized)) {
        const key = `weak:${normalized}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({
            rule: 'known-weak-secret',
            detail: `known-weak/placeholder secret "${token}" (see src/security/known-weak-secrets.ts)`,
            match: token,
          });
        }
      }
    }
  }

  return findings;
}

/** Read the staged diff (added lines only) for the secret scan. */
function readStagedDiff(): string {
  // -U0 keeps context lines out so we only inspect changed hunks; the leading
  // `+` is handled by scanForSecrets. Binary files are summarised, not dumped.
  return execFileSync('git', ['diff', '--cached', '--no-color', '-U0'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * CLI entrypoint used by the pre-commit hook. Scans the staged diff and exits
 * non-zero (blocking the commit) if anything matched.
 */
function main(): void {
  let diff: string;
  try {
    diff = readStagedDiff();
  } catch (err) {
    // If git isn't available or this isn't a repo, fail open rather than
    // wedging the developer — the hook is a safety net, not a gate of record.
    process.stderr.write(`scan-secrets: could not read staged diff, skipping (${String(err)})\n`);
    return;
  }

  const findings = scanForSecrets(diff);
  if (findings.length === 0) return;

  process.stderr.write('\n✖ pre-commit secret scan blocked this commit:\n\n');
  for (const f of findings) {
    process.stderr.write(`  [${f.rule}] ${f.detail}\n`);
    process.stderr.write(`     match: ${f.match}\n`);
  }
  process.stderr.write(
    '\nRemove the secret from the staged change (and rotate it if it was ever real).\n' +
      'To bypass in a genuine false-positive, commit with --no-verify (use sparingly).\n\n',
  );
  process.exit(1);
}

// Only run the CLI when invoked directly (tsx scripts/scan-secrets.ts), not
// when imported by the test.
const invokedDirectly =
  typeof process.argv[1] === 'string' && /scan-secrets\.(ts|js|mjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  main();
}
