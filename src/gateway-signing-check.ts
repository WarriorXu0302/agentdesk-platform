/**
 * Startup observability for HMAC signing coverage.
 *
 * HMAC request signing is opt-in (ADR-0018): a freshly provisioned gateway
 * config has a `baseUrl` but no `signingKey`, so requests go out unsigned and
 * anything that can reach the gateway baseUrl can forge a host-provisioned
 * container. The cryptographic path is sound; the gap is purely
 * configuration. This scan surfaces that gap at startup instead of leaving it
 * silent until an audit finds it.
 *
 * Read-only by contract: it inspects each group's container.json and reports
 * a gauge + a warning. It never mutates config or the identity trust chain —
 * remediation is an explicit operator action via
 * `scripts/configure-enterprise-gateway.ts --signing-key`.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readContainerConfig } from './container-config.js';
import { gatewaySigningProxyEnabled } from './gateway-signing-proxy.js';
import { log } from './log.js';
import { gatewayUnsignedGroups } from './metrics.js';
import { isKnownWeakSecret } from './security/known-weak-secrets.js';

/**
 * Result of the gateway signing coverage scan.
 *
 * - `unsigned`    — groups with a gateway baseUrl but no signing key at all
 *                   (requests go out UNSIGNED).
 * - `weakSigned`  — groups whose configured signingKey is a known
 *                   placeholder/lazy value (ADR-0025). The request is "signed",
 *                   but with a key anyone reading `.env.example` knows, so it is
 *                   effectively forgeable — strictly worse than visibly
 *                   unsigned because it looks protected.
 *
 * Both count against signing coverage; they are reported separately so an
 * operator can tell "never configured" apart from "configured with a
 * placeholder".
 */
export interface GatewaySigningCoverage {
  unsigned: string[];
  weakSigned: string[];
}

/**
 * Scan every agent group with a configured backend gateway and report which
 * have a baseUrl but no signingKey (unsigned) and which carry a known-weak /
 * placeholder signingKey (weak-signed, ADR-0025 — runtime uses the per-group
 * container.json key, ADR-0018/0023, so a placeholder written there is the real
 * exposure, not just env). Always sets the gauge to the total number of groups
 * whose gateway is not safely signed (0 when all are properly signed, so
 * dashboards can tell "all good" apart from "metric never emitted"); warns with
 * the offending folders when either bucket is non-empty. Returns both lists for
 * callers/tests.
 */
export function checkGatewaySigningCoverage(): GatewaySigningCoverage {
  const unsigned: string[] = [];
  const weakSigned: string[] = [];
  let signed = 0; // groups with a baseUrl + a real (non-weak) signingKey

  // Never throw — this runs in the startup sequence alongside checkBaseImage(),
  // which is deliberately never-throw. A readdir failure (EACCES/EIO) must not
  // take down the host; degrade to "scan skipped" and continue.
  let entries: fs.Dirent[] = [];
  try {
    if (fs.existsSync(GROUPS_DIR)) {
      entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
    }
  } catch (err) {
    log.warn('Gateway signing coverage scan skipped — could not read groups dir', {
      dir: GROUPS_DIR,
      err,
    });
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'global') continue;
    const configFile = path.join(GROUPS_DIR, entry.name, 'container.json');
    if (!fs.existsSync(configFile)) continue;

    try {
      const gateway = readContainerConfig(entry.name).backendGateway;
      if (!gateway?.baseUrl) continue;
      const key = gateway.signingKey?.trim();
      if (!key) {
        unsigned.push(entry.name);
      } else if (isKnownWeakSecret(key)) {
        weakSigned.push(entry.name);
      } else {
        signed++;
      }
    } catch (err) {
      // A malformed container.json must not abort the scan or startup.
      log.warn('Gateway signing coverage — skipped unreadable group config', {
        folder: entry.name,
        err,
      });
    }
  }

  // Both buckets are gaps in signing coverage — count them together so the
  // existing gauge reflects total exposure, not just the never-configured case.
  gatewayUnsignedGroups.set(unsigned.length + weakSigned.length);

  if (unsigned.length > 0) {
    log.warn('Backend gateway requests are UNSIGNED for some agent groups', {
      count: unsigned.length,
      folders: unsigned,
      remediation: 'pnpm exec tsx scripts/configure-enterprise-gateway.ts --folders <folder> --signing-key <key>',
    });
  }

  if (weakSigned.length > 0) {
    log.warn('Backend gateway signing key is a known placeholder/weak value for some agent groups', {
      count: weakSigned.length,
      folders: weakSigned,
      remediation:
        'pnpm exec tsx scripts/configure-enterprise-gateway.ts --folders <folder> --signing-key "$(openssl rand -hex 32)"',
    });
  }

  // Heads-up: the signing proxy (ADR-0034) only withholds a key the host
  // actually has. If it's enabled but NO group has a real signingKey, the proxy
  // is a no-op — agents still get their credentials directly — so an operator
  // who flipped the flag believing the key is protected is mistaken.
  if (gatewaySigningProxyEnabled() && signed === 0) {
    log.warn(
      'AGENTDESK_GATEWAY_SIGNING_PROXY is enabled but no agent group has a real backend signingKey — ' +
        'the proxy has nothing to withhold and provides no isolation. Provision a key via ' +
        'scripts/configure-enterprise-gateway.ts, or the flag is a no-op.',
      { signedGroups: signed, unsigned: unsigned.length, weakSigned: weakSigned.length },
    );
  }

  return { unsigned, weakSigned };
}
