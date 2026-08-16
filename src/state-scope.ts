/**
 * State scope resolution (ADR-0055).
 *
 * An agent's WRITABLE persistent state (workspace + Claude state dir) is
 * mounted per *scope*, not per agent_group. The scope follows the session's
 * owner axis:
 *
 *   - owner_user_id set   → per-user scope under DATA_DIR/v2-scopes/
 *     (per-user / per-user-per-thread wirings, and root-session a2a lanes,
 *     which inherit the origin user's owner — so per-user isolation
 *     propagates through delegation)
 *   - owner_user_id NULL  → legacy group scope: groups/<folder> +
 *     data/v2-sessions/<agId>/.claude-shared — byte-for-byte the historical
 *     layout, so ownerless modes (shared / per-thread / agent-shared) are
 *     untouched and existing deployments need no migration.
 *
 * Container paths never change (`/workspace/agent`, `/home/node/.claude`);
 * only which HOST directory backs them. Config and composer artifacts
 * (container.json, CLAUDE.md, .claude-fragments, prompts/) keep coming from
 * the group dir as read-only nested mounts that shadow the scope mount —
 * the group dir is the TEMPLATE layer, the scope is the INSTANCE layer.
 *
 * User scopes deliberately live OUTSIDE groups/<folder>: with mixed wirings
 * (one messaging group `shared`, another `per-user` on the same agent), the
 * ownerless session mounts the whole group dir RW — nesting scopes inside it
 * would expose every user's private state to that session.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { initClaudeStateDir, seedClaudeLocalMd } from './group-init.js';
import { log } from './log.js';
import type { AgentGroup, Session } from './types.js';

export interface StateScope {
  kind: 'group' | 'user';
  /** Backs the RW `/workspace/agent` mount (CLAUDE.local.md, conversations/, working files). */
  workspaceDir: string;
  /** Backs the RW `/home/node/.claude` mount (settings, skills symlinks, Claude state). */
  claudeDir: string;
}

/**
 * Deterministic, filesystem-safe, collision-proof directory key for a user id
 * (same slug+fingerprint construction as ADR-0053's perGroupAgentFolder: the
 * slug keeps it readable, the sha1 fingerprint keeps two ids that slugify
 * identically — `a.b` vs `a_b` — from silently sharing one scope).
 */
export function userScopeKey(userId: string): string {
  const slug =
    userId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'user';
  const fingerprint = createHash('sha1').update(userId).digest('hex').slice(0, 8);
  return `u-${slug}-${fingerprint}`;
}

/** Host directory that holds every user scope of one agent group. */
export function scopesBaseDir(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-scopes', agentGroupId);
}

/**
 * Resolve which host directories back the session's writable state mounts.
 * Pure path computation — no filesystem side effects (see ensureStateScope).
 */
export function resolveStateScope(agentGroup: AgentGroup, session: Session): StateScope {
  const ownerUserId = session.owner_user_id ?? null;
  if (!ownerUserId) {
    return {
      kind: 'group',
      workspaceDir: path.resolve(GROUPS_DIR, agentGroup.folder),
      claudeDir: path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared'),
    };
  }
  const base = path.join(scopesBaseDir(agentGroup.id), userScopeKey(ownerUserId));
  return {
    kind: 'user',
    workspaceDir: path.join(base, 'workspace'),
    claudeDir: path.join(base, 'claude'),
  };
}

/**
 * Materialize a user scope on disk before the container bind-mounts it
 * (a missing bind source would be created root-owned by the docker daemon).
 * Idempotent — every step is gated on the target not existing. Group scopes
 * are initialized by initGroupFilesystem and are not touched here.
 *
 * The workspace gets the same seed initGroupFilesystem gives a group dir
 * (empty CLAUDE.local.md, conversations/) plus the `.claude-shared.md`
 * symlink the composed CLAUDE.md's relative `@./.claude-shared.md` import
 * resolves through (the composer writes that link into the GROUP dir, which
 * a user scope shadows at `/workspace/agent`).
 */
export function ensureStateScope(scope: StateScope, opts: { disableAutoMemory: boolean }): void {
  if (scope.kind !== 'user') return;
  const initialized: string[] = [];

  if (!fs.existsSync(scope.workspaceDir)) {
    fs.mkdirSync(scope.workspaceDir, { recursive: true });
    initialized.push('workspace');
  }
  if (seedClaudeLocalMd(scope.workspaceDir)) initialized.push('CLAUDE.local.md');

  const conversationsDir = path.join(scope.workspaceDir, 'conversations');
  if (!fs.existsSync(conversationsDir)) {
    fs.mkdirSync(conversationsDir, { recursive: true });
    initialized.push('conversations/');
  }

  // The link target is a CONTAINER path, dangling on the host — existsSync
  // FOLLOWS the link and always answers "absent", which would retry
  // symlinkSync into EEXIST on every spawn. lstat sees the entry itself
  // (same dance as claude-md-compose.ts's syncSymlink).
  const sharedLink = path.join(scope.workspaceDir, '.claude-shared.md');
  let linkPresent = true;
  try {
    fs.lstatSync(sharedLink);
  } catch {
    linkPresent = false;
  }
  if (!linkPresent) {
    try {
      fs.symlinkSync('/app/CLAUDE.md', sharedLink);
      initialized.push('.claude-shared.md');
    } catch (err) {
      log.warn('State scope: .claude-shared.md symlink failed', { dir: scope.workspaceDir, err });
    }
  }

  initialized.push(...initClaudeStateDir(scope.claudeDir, opts.disableAutoMemory));

  if (initialized.length > 0) {
    log.info('Initialized user state scope (ADR-0055)', { dir: scope.workspaceDir, steps: initialized });
  }
}
