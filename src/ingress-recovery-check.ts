/**
 * Startup surface for orphaned inbound ingress rows (ADR-0022).
 *
 * The inbound_ingress ledger (see src/db/inbound-ingress.ts) keeps a row for
 * every inbound envelope from the moment routeInbound starts until it either
 * completes (row deleted) or throws (row flipped to status='failed'). A host
 * crash mid-route leaves the row stuck at status='received' — an in-flight
 * orphan that no retry loop will pick up, because re-running routeInbound would
 * bypass adapter-layer dedup and risk double-delivery.
 *
 * This check runs once at startup and reports those leftovers so an operator
 * can act on them via scripts/replay-inbound.ts. It deliberately does NOT
 * replay anything (that's an explicit operator decision) and it does not mutate
 * any ledger row — read-only by contract, mirroring checkGatewaySigningCoverage.
 *
 * The 'failed' count is reflected into inbound_ingress_failed_total so a host
 * that restarts after the failing process exited still shows the backlog on the
 * dashboard (the per-failure increment in router.ts is lost across a restart).
 */
import { countIngressByStatus } from './db/inbound-ingress.js';
import { log } from './log.js';
import { inboundIngressFailedTotal } from './metrics.js';

export function surfaceOrphanedIngress(): { received: number; failed: number } {
  let counts: { received: number; failed: number };
  try {
    counts = countIngressByStatus();
  } catch (err) {
    // Never take down startup — degrade to "scan skipped", matching the
    // never-throw contract of the other startup checks.
    log.warn('Inbound ingress recovery scan skipped — could not read ledger', { err });
    return { received: 0, failed: 0 };
  }

  // Re-surface the persisted failed backlog on the metric. Use a synthetic
  // channel label: the per-channel breakdown lives on the rows themselves
  // (listed by the replay CLI); the startup metric just needs the dashboard to
  // show a non-zero standing backlog after a restart.
  if (counts.failed > 0) {
    inboundIngressFailedTotal.labels('__startup_backlog__').inc(counts.failed);
  }

  const total = counts.received + counts.failed;
  if (total > 0) {
    log.warn('Orphaned inbound ingress rows present — inbound messages may be unrecovered', {
      received: counts.received,
      failed: counts.failed,
      note: "status='received' rows are crash-orphaned in-flight envelopes; status='failed' rows threw during routing.",
      remediation: 'pnpm exec tsx scripts/replay-inbound.ts --list   (then --replay <id> / --replay-all)',
    });
  }

  return counts;
}
