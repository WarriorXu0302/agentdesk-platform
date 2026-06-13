import { describe, expect, it } from 'vitest';

import { scanForSecrets } from './scan-secrets.js';

describe('scanForSecrets (ADR-0029 pre-commit secret scan)', () => {
  it('passes silently on ordinary code with no secrets', () => {
    const text = [
      '+export function add(a: number, b: number): number {',
      '+  return a + b;',
      '+}',
    ].join('\n');
    expect(scanForSecrets(text)).toEqual([]);
  });

  it('flags a PEM private-key header', () => {
    const findings = scanForSecrets('+-----BEGIN PRIVATE KEY-----');
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('private-key');
  });

  it('flags RSA / OPENSSH private-key header variants', () => {
    expect(scanForSecrets('-----BEGIN RSA PRIVATE KEY-----')[0]?.rule).toBe('private-key');
    expect(scanForSecrets('-----BEGIN OPENSSH PRIVATE KEY-----')[0]?.rule).toBe('private-key');
  });

  it('flags an AWS access key id (AKIA + 16 chars)', () => {
    const findings = scanForSecrets('aws_access_key_id = AKIAIOSFODNN7EXAMPLE');
    expect(findings.some((f) => f.rule === 'aws-access-key-id')).toBe(true);
  });

  it('flags a temporary AWS key id (ASIA prefix)', () => {
    expect(
      scanForSecrets('+key=ASIAIOSFODNN7EXAMPLE').some((f) => f.rule === 'aws-access-key-id'),
    ).toBe(true);
  });

  it('does NOT flag a random uppercase token that is not an AWS key shape', () => {
    expect(scanForSecrets('const X = "AKIASHORT";')).toEqual([]);
  });

  it('flags a known-weak placeholder reused from src/security/known-weak-secrets.ts', () => {
    const findings = scanForSecrets('GATEWAY_SIGNING_KEY=changeme');
    expect(findings.some((f) => f.rule === 'known-weak-secret')).toBe(true);
  });

  it('flags a shipped .env.example placeholder value', () => {
    const findings = scanForSecrets('GATEWAY_SIGNING_KEY=replace-me-openssl-rand-hex-32');
    expect(findings.some((f) => f.rule === 'known-weak-secret')).toBe(true);
  });

  it('catches a weak value embedded in a quoted/colon-delimited line', () => {
    expect(scanForSecrets('  password: "secret"').some((f) => f.rule === 'known-weak-secret')).toBe(
      true,
    );
  });

  it('only inspects added (+) lines of a unified diff, not removed/context lines', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '-OLD_KEY=changeme', // removed line — must be ignored
      '+OLD_KEY=a-real-strong-value-9f3c',
    ].join('\n');
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('does not double-flag the same match repeated across lines', () => {
    const findings = scanForSecrets('+a=changeme\n+b=changeme');
    expect(findings.filter((f) => f.rule === 'known-weak-secret')).toHaveLength(1);
  });

  it('reports multiple distinct findings together', () => {
    const text = ['+-----BEGIN PRIVATE KEY-----', '+aws=AKIAIOSFODNN7EXAMPLE', '+pw=password'].join(
      '\n',
    );
    const rules = scanForSecrets(text).map((f) => f.rule).sort();
    expect(rules).toEqual(['aws-access-key-id', 'known-weak-secret', 'private-key']);
  });
});
