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

describe('operability gate never touches the gateway / business-authz path (ADR-0051, invariant 2)', () => {
  it('no gateway/business-authz file consults canOperate or imports the operability module', () => {
    const offenders: string[] = [];
    for (const rel of GATEWAY_AUTHZ_FILES) {
      const full = path.join(REPO, rel);
      if (!fs.existsSync(full)) continue; // tolerate refactors that rename/remove a file
      const text = fs.readFileSync(full, 'utf8');
      if (/\bcanOperate\b/.test(text)) offenders.push(`${rel}: references canOperate`);
      if (/from\s+['"][^'"]*operability(\.js)?['"]/.test(text)) offenders.push(`${rel}: imports operability`);
    }
    expect(
      offenders,
      `business authorization must stay at the gateway — operability must not leak into it: ${offenders.join('; ')}`,
    ).toHaveLength(0);
  });

  it('the operability gate does not import any gateway/business module', () => {
    const text = fs.readFileSync(path.join(REPO, 'src/modules/permissions/operability.ts'), 'utf8');
    const bad = [/gateway-signing/, /gateway-audit/, /gateway-proxy-token/, /roster-gateway/];
    const hits = bad.filter((re) => re.test(text)).map((re) => re.source);
    expect(hits, `operability.ts must not import gateway/business modules: ${hits.join(', ')}`).toHaveLength(0);
  });
});
