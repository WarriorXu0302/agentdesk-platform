/**
 * Host-anchored actor resolution for recording / audit surfaces.
 *
 * Several delivery-action handlers (classify_intent, escalate, routing_feedback,
 * gateway_audit) persist an "actor" userId into audit-level tables. That actor
 * must stay host-anchored — never an agent-spoofable field — or a prompt-injected
 * container could stamp an arbitrary victim into the audit corpus (ADR-0017
 * identity trust chain; ADR-0046).
 *
 *  - A session with a host-established owner (per-user / per-user-per-thread, or a
 *    root-pinned session) IS the authoritative actor; a container-claimed userId
 *    that disagrees is ignored + warned.
 *  - With NO owner (shared / per-thread / agent-shared group sessions —
 *    owner_user_id is NULL) a container-claimed userId is accepted ONLY if that
 *    user genuinely appeared in this session, cross-validated against the
 *    HOST-written inbound.db (the same check the a2a hop uses). A fabricated id
 *    that never entered the session is dropped to null + counted, so a
 *    prompt-injected frontdesk/worker cannot stamp an arbitrary actor.
 *
 * Recording-only: the result is written to audit/classification tables that are
 * never read into an authorization, routing, delivery-target, or priority
 * decision — so this guards audit GROUND TRUTH, not control flow.
 */
import type Database from 'better-sqlite3';

import { log } from './log.js';
import { recordingActorRejectedTotal } from './metrics.js';
import { collectLegitimateOrigins } from './modules/agent-to-agent/origin-user.js';
import type { Session } from './types.js';

export function resolveTrustedActor(
  action: string,
  session: Session,
  claimedUserId: string | null,
  inDb: Database.Database,
): string | null {
  if (session.owner_user_id) {
    if (claimedUserId && claimedUserId !== session.owner_user_id) {
      log.warn(`${action} userId mismatch — trusting session owner`, {
        sessionId: session.id,
        claimed: claimedUserId,
        session: session.owner_user_id,
      });
    }
    return session.owner_user_id;
  }
  // No host-established owner: a claimed id is only trustworthy if the host saw
  // that user pass through this session. Anything else is unverifiable → null.
  if (!claimedUserId) return null;
  let legitimate: Set<string>;
  try {
    legitimate = collectLegitimateOrigins(inDb);
  } catch (err) {
    log.warn(`${action}: legitimate-origin lookup failed — dropping unverifiable actor`, {
      sessionId: session.id,
      err,
    });
    return null;
  }
  if (legitimate.has(claimedUserId)) return claimedUserId;
  recordingActorRejectedTotal.labels(action).inc();
  log.warn(`${action}: rejecting container-claimed userId not in session identity set`, {
    sessionId: session.id,
    claimed: claimedUserId,
  });
  return null;
}
