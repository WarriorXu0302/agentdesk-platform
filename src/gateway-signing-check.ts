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
import { log } from './log.js';
import { gatewayUnsignedGroups } from './metrics.js';

/**
 * Scan every agent group with a configured backend gateway and report how
 * many have a baseUrl but no signingKey. Always sets the gauge (0 when all
 * gateways are signed, so dashboards can tell "all signed" apart from "metric
 * never emitted"); warns with the offending folders when the count is
 * non-zero. Returns the unsigned folder list for callers/tests.
 */
export function checkGatewaySigningCoverage(): string[] {
  const unsigned: string[] = [];

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
      if (!gateway.signingKey?.trim()) unsigned.push(entry.name);
    } catch (err) {
      // A malformed container.json must not abort the scan or startup.
      log.warn('Gateway signing coverage — skipped unreadable group config', {
        folder: entry.name,
        err,
      });
    }
  }

  gatewayUnsignedGroups.set(unsigned.length);

  if (unsigned.length > 0) {
    log.warn('Backend gateway requests are UNSIGNED for some agent groups', {
      count: unsigned.length,
      folders: unsigned,
      remediation: 'pnpm exec tsx scripts/configure-enterprise-gateway.ts --folders <folder> --signing-key <key>',
    });
  }

  return unsigned;
}
