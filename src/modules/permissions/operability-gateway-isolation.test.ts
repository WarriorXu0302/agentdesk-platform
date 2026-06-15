import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Invariant-2 guard (ADR-0051): the backend gateway is the ONLY path for
 * business authorization. Operability roles (operator/viewer) and the
 * `canOperate` gate are a HOST operability/governance concept — they must NEVER
 * become an input to a gateway / business-authz code path.
 *
 * The structural promise: no gateway/proxy/signing/audit file imports the
 * operability module or references `canOperate`. If a future change wires the
 * operability gate into a gateway request decision, this test fails — exactly
 * the moment to stop and reconsider, because it would open a parallel authz
 * path the invariant forbids.
 *
 * Symmetric promise: the operability gate itself must not reach into any
 * gateway/business module (it only reads `user_roles` + `users`).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

// Files that constitute the gateway / business-authz code path.
const GATEWAY_AUTHZ_FILES = [
  'src/gateway-signing.ts',
  'src/gateway-signing-proxy.ts',
  'src/gateway-signing-check.ts',
  'src/roster-gateway.ts',
  'src/db/gateway-audit.ts',
  'src/db/gateway-proxy-token.ts',
  'src/modules/gateway-audit/index.ts',
];

describe('operability + org isolation never touch the gateway / business-authz path (ADR-0051/0052, invariant 2)', () => {
  it('no gateway/business-authz file consults the operability/org gates or imports their modules', () => {
    // The host operability gate (ADR-0051) AND the org-isolation gate (ADR-0052)
    // are HOST access concerns; neither may become a gateway business-authz input.
    const forbiddenRefs = [
      /\bcanOperate\b/,
      /\borgOfAgentGroup\b/,
      /\bisMemberOfOrg\b/,
      /\bisOrgAdmin\b/,
      /\bhasOrgOperabilityRole\b/,
      /\borganization_id\b/, // forensic tables get NO org column; proxy never stamps org (fix-6)
    ];
    const forbiddenImports = [/from\s+['"][^'"]*operability(\.js)?['"]/, /from\s+['"][^'"]*\/organizations(\.js)?['"]/];
    const offenders: string[] = [];
    for (const rel of GATEWAY_AUTHZ_FILES) {
      const full = path.join(REPO, rel);
      if (!fs.existsSync(full)) continue; // tolerate refactors that rename/remove a file
      const text = fs.readFileSync(full, 'utf8');
      for (const re of forbiddenRefs) if (re.test(text)) offenders.push(`${rel}: references ${re.source}`);
      for (const re of forbiddenImports) if (re.test(text)) offenders.push(`${rel}: imports ${re.source}`);
    }
    expect(
      offenders,
      `business authorization must stay at the gateway — operability/org must not leak into it: ${offenders.join('; ')}`,
    ).toHaveLength(0);
  });

  it('the operability + org gate modules do not import any gateway/business module', () => {
    const bad = [/gateway-signing/, /gateway-audit/, /gateway-proxy-token/, /roster-gateway/];
    for (const rel of ['src/modules/permissions/operability.ts', 'src/modules/permissions/db/organizations.ts']) {
      const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
      const hits = bad.filter((re) => re.test(text)).map((re) => re.source);
      expect(hits, `${rel} must not import gateway/business modules: ${hits.join(', ')}`).toHaveLength(0);
    }
  });
});
