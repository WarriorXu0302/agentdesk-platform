import type { AgentGroup } from '../types.js';
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
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
       VALUES (@id, @name, @folder, @agent_provider, @created_at, @organization_id)`,
    )
    .run({ ...group, organization_id: group.organization_id ?? null });
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
