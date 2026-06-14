/**
 * Roster directed-message tools (ADR-0044, the agent-facing side of ADR-0023).
 *
 * These let the agent DM a person who has CONSENTED to receive directed messages
 * for this conversation — addressed by their roster SLOT (e.g. "approver"), never
 * by name or user id. The agent is a THIN emitter: it writes a `kind='roster'`
 * outbound row carrying only the slot; the HOST resolves slot → consent grant,
 * overrides all routing, and re-checks consent/revocation/rate-limits on every
 * delivery (ADR-0023 R1–R5). The container never sees or supplies the recipient's
 * identity, and the tool result is deliberately OPAQUE (never echoes the resolved
 * open_id / platform_id) so the agent can't harvest identities via return values.
 *
 * Slot discovery (which slots are live) is surfaced separately by the host into
 * the agent's context (ADR-0044 Stage 1). This tool is host-gated: if the
 * operator hasn't enabled roster DM (ALLOW_ROSTER_DM) the host rejects the send.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `roster-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const sendRosterDm: McpToolDefinition = {
  tool: {
    name: 'send_roster_dm',
    description:
      'Send a direct private message to a person who has CONSENTED to receive directed messages for this conversation, ' +
      'addressed by their roster SLOT label (e.g. "approver", "ops-lead") — never by name or id. ' +
      'Use only the slot labels shown in your roster-slots context; you cannot DM someone who has not opted in, and you ' +
      'cannot choose a person directly — you address a slot and the platform resolves it to the consented recipient. ' +
      'The platform enforces consent, revocation, and rate limits; the recipient’s identity is never revealed to you. ' +
      'Only works when the operator has enabled roster DM for this agent; otherwise the send is rejected.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slot: {
          type: 'string',
          description: 'The roster slot label of the consented recipient, exactly as shown in your roster-slots list.',
        },
        text: { type: 'string', description: 'The message to send to that person.' },
      },
      required: ['slot', 'text'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const slot = typeof args.slot === 'string' ? args.slot.trim() : '';
    const text = typeof args.text === 'string' ? args.text : '';
    if (!slot)
      return err('slot is required — the roster slot label of a consented recipient (see your roster-slots list)');
    if (!text.trim()) return err('text is required');

    // Emit a slot-addressed roster row. NO platform_id/channel_type: the host
    // looks up the grant by (host-derived scope, slot) and overrides routing
    // (ADR-0023 R3). Writing a concrete platform_id here would be rejected.
    writeMessageOut({
      id: generateId(),
      kind: 'roster',
      content: JSON.stringify({ slot, text }),
    });

    log(`send_roster_dm: slot="${slot}"`);
    // Opaque result (ADR-0044): never echo the resolved recipient id/handle.
    return ok(
      `Roster DM queued for slot "${slot}". The platform will deliver it only if that slot has a live consent grant ` +
        `(and roster DM is enabled); the recipient's identity is not shown to you. Still reply to the user normally.`,
    );
  },
};

registerTools([sendRosterDm]);
