/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getInboundDb } from './db/connection.js';
import type { MemoryMode } from './config.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
  return rows.map(rowToEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const row = getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db.prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?").get(platformId) as
          | DestRow
          | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestRow | undefined);
  return row ? rowToEntry(row) : undefined;
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string, memoryMode?: MemoryMode): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(
      [
        '# You are ' + assistantName,
        '',
        `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`,
      ].join('\n'),
    );
  }

  if (memoryMode === 'gateway') {
    sections.push(
      [
        '## Memory policy',
        '',
        'Do not store durable user, employee, permission, customer, or business memory in `/workspace/agent/CLAUDE.local.md` or other workspace files.',
        'Treat workspace files as temporary scratch space only.',
        'For long-lived memory, user preferences, identity mapping, approval context, and business facts, use the backend memory tools (`gateway_memory_get`, `gateway_memory_upsert`).',
        'If the backend memory store is unavailable, say so explicitly and do not fall back to shared workspace memory.',
      ].join('\n'),
    );
  }

  sections.push(buildDestinationsSection());

  const rosterSlots = getLiveRosterSlots();
  if (rosterSlots.length > 0) {
    sections.push(buildRosterSlotsSection(rosterSlots));
  }

  return sections.join('\n\n');
}

function buildDestinationsSection(): string {
  const all = getAllDestinations();

  if (all.length === 0) {
    return [
      '## Sending messages',
      '',
      'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
    ].join('\n');
  }

  const lines = ['## Sending messages', ''];
  if (all.length === 1) {
    const d = all[0];
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    lines.push(`Your destination is \`${d.name}\`${label}.`);
  } else {
    lines.push('You can send messages to the following destinations:', '');
    for (const d of all) {
      const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
      lines.push(`- \`${d.name}\`${label}`);
    }
  }
  lines.push('');
  lines.push('**Every response must be wrapped** in a `<message to="name">...</message>` block.');
  lines.push('You can include multiple `<message>` blocks in one response to send to multiple destinations.');
  lines.push('Text outside of `<message>` blocks is scratchpad — logged but not sent anywhere.');
  lines.push('Use `<internal>...</internal>` to make scratchpad intent explicit.');
  lines.push('');
  lines.push(
    '**Default routing**: when replying to an incoming message, address the same destination the message came `from` — every inbound `<message>` tag carries a `from="name"` attribute that names the origin destination. Only address a different destination when the request itself asks you to (e.g., "tell Laura that…").',
  );
  lines.push('');
  lines.push(
    'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool with the `to` parameter set to a destination name.',
  );
  return lines.join('\n');
}

/**
 * A roster-DM slot the agent may DM (ADR-0044 Stage 1). IDENTITY-FREE: the host
 * projection deliberately carries no open_id / platform_id, so this type can
 * only ever name a slot LABEL plus two liveness hints — there is no field
 * through which the recipient's identity could reach the agent.
 */
export interface RosterSlotEntry {
  slotLabel: string;
  /** Sends left before the grant auto-revokes; null when uncapped. */
  sendsRemaining: number | null;
  /** ISO-8601 UTC absolute expiry, or null when the grant never expires. */
  expiresAt: string | null;
}

/**
 * Read the host-written roster_slots projection (ADR-0044 Stage 1). The host
 * DELETE+INSERTs this on every wake when roster DM is enabled for the group;
 * when it isn't (or on an older inbound.db that predates the table) the table is
 * absent and we return [] so no roster section is added. The cached singleton is
 * fine — like destinations, the host writes this once at spawn.
 */
export function getLiveRosterSlots(): RosterSlotEntry[] {
  try {
    const rows = getInboundDb()
      .prepare('SELECT slot_label, sends_remaining, expires_at FROM roster_slots ORDER BY slot_label')
      .all() as Array<{ slot_label: string; sends_remaining: number | null; expires_at: string | null }>;
    return rows.map((r) => ({
      slotLabel: r.slot_label,
      sendsRemaining: r.sends_remaining,
      expiresAt: r.expires_at,
    }));
  } catch {
    // Table absent (roster DM off, or pre-migration inbound.db) — no slots.
    return [];
  }
}

function buildRosterSlotsSection(slots: RosterSlotEntry[]): string {
  const lines = [
    '## Roster slots you can DM',
    '',
    'These people have CONSENTED to receive a direct private message from you for this conversation. ' +
      'Address them by their roster **slot label** with the `send_roster_dm` MCP tool — you cannot pick a person ' +
      'directly, and you are never shown who is behind a slot. The platform resolves the slot to the consented ' +
      'recipient, enforces consent/revocation/rate limits, and may reject a send if consent was withdrawn.',
    '',
  ];
  for (const slot of slots) {
    const hints: string[] = [];
    if (slot.sendsRemaining !== null) hints.push(`${slot.sendsRemaining} send(s) left`);
    if (slot.expiresAt) hints.push(`expires ${slot.expiresAt}`);
    const suffix = hints.length > 0 ? ` (${hints.join(', ')})` : '';
    lines.push(`- \`${slot.slotLabel}\`${suffix}`);
  }
  return lines.join('\n');
}
