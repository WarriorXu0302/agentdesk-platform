/**
 * Roster directed-message host glue (ADR-0023).
 *
 * The pieces here all run on the host (trusted side of the container mount):
 *
 *   - ALLOW_ROSTER_DM opt-in flag (per agent group; default OFF).
 *   - root-session enforcement: a group that opts in MUST run a2aSessionMode
 *     'root-session'; 'agent-shared' is rejected at enable time (R4).
 *   - hostScopeForSession: derives the per-scope, unguessable scope_id from
 *     host-owned session fields ONLY — never a container-supplied value (R4).
 *   - looksLikeRawPlatformId: detects a container trying to smuggle a raw
 *     `feishu:p2p:ou_*` (or bare ou_/oc_) destination past the slot indirection
 *     (R3).
 *   - parseConsentTarget: atomically derives participant_open_id + dm_platform_id
 *     from ONE inbound event and asserts they round-trip to the same open_id;
 *     rejects union_id / user_id / chat_id (R2).
 *   - revokeScope: the host-side API the finish hook (and admins) call to tear
 *     down a scope's grants.
 *
 * No business logic, no backend calls — this is platform-core security glue.
 */
import { readContainerConfig } from './container-config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { revokeScope as revokeScopeGrants } from './db/dm-grants.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import type { Session } from './types.js';
import type { DmConsentSource } from './db/dm-grants.js';

/**
 * Per-agent-group opt-in. Resolution order mirrors the rest of the host's
 * config convention: container.json `env.ALLOW_ROSTER_DM` → process env →
 * `.env`. Default OFF — the gate is closed unless a deployment explicitly
 * turns it on for a specific group.
 *
 * Accepts only the exact string 'true' (case-insensitive) as enabled, so a
 * stray non-empty value can't accidentally widen the surface.
 */
export function rosterDmEnabledForGroup(agentGroupId: string): boolean {
  const group = getAgentGroup(agentGroupId);
  if (!group) return false;
  const cfg = readContainerConfig(group.folder);
  const fromContainer = cfg.env?.ALLOW_ROSTER_DM;
  if (fromContainer !== undefined) return fromContainer.trim().toLowerCase() === 'true';
  const fromProc = process.env.ALLOW_ROSTER_DM;
  if (fromProc !== undefined) return fromProc.trim().toLowerCase() === 'true';
  const dotenv = readEnvFile(['ALLOW_ROSTER_DM']);
  return (dotenv.ALLOW_ROSTER_DM ?? '').trim().toLowerCase() === 'true';
}

/**
 * Enforce the root-session requirement for a roster-DM-enabled group. Throws
 * when the group opts in but runs 'agent-shared' a2a sessions — agent-shared
 * pools many root conversations into one session, which would let an
 * unguessable per-scope key collapse into a shared one and defeat R4. Call this
 * at enable time (bootstrap / admin) so a misconfigured group fails loudly
 * rather than silently sharing a release key.
 */
export function assertRootSessionForRosterDm(agentGroupId: string): void {
  if (!rosterDmEnabledForGroup(agentGroupId)) return;
  if (!isRootSessionModeForRosterDm(agentGroupId)) {
    const group = getAgentGroup(agentGroupId);
    const mode = group ? (readContainerConfig(group.folder).a2aSessionMode ?? 'agent-shared') : 'unknown';
    throw new Error(
      `roster-dm: agent group ${agentGroupId} has ALLOW_ROSTER_DM enabled but a2aSessionMode='${mode}'. ` +
        `Roster DM requires a2aSessionMode='root-session' so the per-scope release key cannot be shared across conversations (ADR-0023, R4).`,
    );
  }
}

/**
 * Runtime predicate form of {@link assertRootSessionForRosterDm}. The delivery
 * gate calls this so a misconfigured group (ALLOW_ROSTER_DM on but
 * a2aSessionMode!='root-session') is rejected fail-closed at send time —
 * enforcement must live on the binding path, not only in an enable-time assert
 * that nothing calls at runtime (ADR-0023, R4 review finding). Returns false
 * when the group is missing or not in root-session mode.
 */
export function isRootSessionModeForRosterDm(agentGroupId: string): boolean {
  const group = getAgentGroup(agentGroupId);
  if (!group) return false;
  return (readContainerConfig(group.folder).a2aSessionMode ?? 'agent-shared') === 'root-session';
}

/**
 * Derive the unguessable per-scope scope_id for a session, from host-owned
 * fields ONLY. The scope is the session's stable root conversation lane
 * (root_session_id, or the session id itself for a root/frontdesk session).
 * Session ids are random uuids, so the scope_id is unguessable and binds the
 * grant to exactly one conversation lane (R4).
 *
 * This NEVER reads a container-supplied value — the delivery gate calls it with
 * the host-resolved Session row, not anything from messages_out.
 */
export function hostScopeForSession(session: Session): string {
  return session.root_session_id ?? session.id;
}

/**
 * Does this string look like a raw channel platform id (the thing a container
 * would write to bypass the slot indirection)? The roster path requires the
 * container to address a SLOT, never a concrete destination; if it writes one
 * anyway we reject and overwrite from the grant (R3).
 *
 * Catches the `feishu:p2p:...` prefixed form and the bare `ou_`/`oc_`/`chat:`
 * forms resolveReceiveTarget would otherwise honor.
 */
export function looksLikeRawPlatformId(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (v === '') return false;
  const lower = v.toLowerCase();
  return (
    lower.startsWith('feishu:') ||
    lower.startsWith('ou_') ||
    lower.startsWith('oc_') ||
    lower.startsWith('p2p:') ||
    lower.startsWith('chat:') ||
    lower.startsWith('open_id:') ||
    lower.startsWith('user:') ||
    lower.startsWith('dm:') ||
    lower.startsWith('group:')
  );
}

export interface ConsentTarget {
  participantOpenId: string;
  dmPlatformId: string;
  channelType: 'feishu';
}

/**
 * Atomically derive (participant_open_id, dm_platform_id) from a single Feishu
 * inbound identity and assert they round-trip to the same open_id (R2).
 *
 * HARD constraints:
 *   - openId MUST be a Feishu open_id (`ou_` prefix). union_id / user_id /
 *     chat_id (`oc_`) are rejected — the platform id must be a p2p open_id so
 *     the target is provably a person, not a group, and not a cross-namespaced
 *     identifier the host can't pin to a member.
 *   - the derived dm_platform_id MUST be exactly `feishu:p2p:<openId>` and MUST
 *     resolve back to the same openId.
 *
 * Returns null on any violation — the consent hook then records no grant.
 */
export function parseConsentTarget(openId: string | null | undefined): ConsentTarget | null {
  const id = openId?.trim();
  if (!id) return null;
  // Reject group chat ids and non-open_id namespaces outright.
  if (!id.startsWith('ou_')) return null;
  const dmPlatformId = `feishu:p2p:${id}`;
  // Round-trip assertion: stripping the prefix must yield the same open_id.
  const prefix = 'feishu:p2p:';
  if (!dmPlatformId.startsWith(prefix)) return null;
  const roundTripped = dmPlatformId.slice(prefix.length);
  if (roundTripped !== id) return null;
  return { participantOpenId: id, dmPlatformId, channelType: 'feishu' };
}

/** consent_source values that the host-side consent hook is allowed to mint. */
export const HOST_CONSENT_SOURCES: readonly DmConsentSource[] = ['p2p-ingress', 'directed-card'];

/**
 * Host-side API: revoke every grant in a scope and report how many were newly
 * revoked. Called by the scope-finish hook and by admin "end scope" commands.
 * Cleanup of in-flight roster rows is the delivery gate's job — a revoked grant
 * fails the live re-check before the adapter call, so any not-yet-delivered
 * roster row is rejected on its next drain tick (R5).
 */
export function revokeScope(scopeId: string): number {
  const n = revokeScopeGrants(scopeId);
  if (n > 0) log.info('roster-dm: scope revoked', { scopeId, revoked: n });
  return n;
}
