import type { AgentGroup, AgentGroupRole } from '../types.js';
import { getDb } from './connection.js';

/**
 * `organization_id` is OPTIONAL at the call site (defaults to NULL = legacy /
 * un-orged, ADR-0052) so existing callers stay unchanged; org-aware callers
 * (bootstrap, agent spawn, channel approval) pass it explicitly. The 6th column
 * is always written — never a silent NULL-org laundering path.
 */
export function createAgentGroup(
  group: Omit<AgentGroup, 'organization_id'> & { organization_id?: string | null },
): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id, role)
       VALUES (@id, @name, @folder, @agent_provider, @created_at, @organization_id, @role)`,
    )
    .run({ ...group, organization_id: group.organization_id ?? null, role: group.role ?? null });
}

/**
 * Stamp the topology role (ADR-0056). Idempotent ensure-style setter for the
 * bootstrap scripts — the operator's topology tool is the authority on roles,
 * so re-running it may overwrite a stale value.
 */
export function setAgentGroupRole(id: string, role: AgentGroupRole | null): void {
  getDb().prepare('UPDATE agent_groups SET role = ? WHERE id = ?').run(role, id);
}

export function getAgentGroup(id: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as AgentGroup | undefined;
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as AgentGroup | undefined;
}

export function getAllAgentGroups(): AgentGroup[] {
  return getDb().prepare('SELECT * FROM agent_groups ORDER BY name').all() as AgentGroup[];
}

export function updateAgentGroup(id: string, updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider'>>): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteAgentGroup(id: string): void {
  getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
}
