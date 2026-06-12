/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Normal messages: pass through unchanged
 */
import { getDb, hasTable } from './db/connection.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

export type GateResult = { action: 'pass' } | { action: 'filter' } | { action: 'deny'; command: string };

// Escape hatch for single-machine / dev setups that run without the
// permissions module (no user_roles table). When unset, a missing table
// fails closed — admin commands are denied. Cached so the .env read and the
// one-time warning happen at most once per process.
let allowAdminWithoutRoles: boolean | undefined;
function adminWithoutRolesAllowed(): boolean {
  if (allowAdminWithoutRoles === undefined) {
    allowAdminWithoutRoles = readEnvFile(['ALLOW_ADMIN_WITHOUT_ROLES']).ALLOW_ADMIN_WITHOUT_ROLES === 'true';
    if (allowAdminWithoutRoles) {
      log.warn(
        'ALLOW_ADMIN_WITHOUT_ROLES=true: admin commands (/clear, /compact, ...) are open to every sender because no permissions module is installed. Do not use this in a shared deployment.',
      );
    }
  }
  return allowAdminWithoutRoles;
}

const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files']);

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands.
 */
export function gateCommand(content: string, userId: string | null, agentGroupId: string): GateResult {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

function isAdmin(userId: string | null, agentGroupId: string): boolean {
  if (!userId) return false;
  // Fail closed when the permissions module isn't installed: with no roles
  // table we cannot prove the sender is an admin, so deny by default. The
  // ALLOW_ADMIN_WITHOUT_ROLES escape hatch restores allow-all for dev.
  if (!hasTable(getDb(), 'user_roles')) return adminWithoutRolesAllowed();
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}
