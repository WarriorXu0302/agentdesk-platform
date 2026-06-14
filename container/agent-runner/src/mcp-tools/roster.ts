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
 *
 * invite_to_roster (ADR-0044 Stage 3) is the third, most sensitive surface: it
 * asks the host to invite a specific person to OPT IN to a slot. Like send, the
 * tool is a thin emitter — it writes a `kind='system'` intent row and the HOST
 * decides everything: it re-derives scope/agent-group, requires the target be a
 * current member of the wired group (fail-closed), suppresses re-invites, rate-
 * limits, and STAMPS the directed consent card itself. The container never
 * builds the card or chooses scope/expectedUserId.
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

export const inviteToRoster: McpToolDefinition = {
  tool: {
    name: 'invite_to_roster',
    description:
      'Invite a specific person to OPT IN to receiving your directed messages for this conversation, registered under ' +
      'a roster slot label (e.g. "approver"). Use this to bring a NEW person into your roster when no slot for them ' +
      'exists yet — afterwards you address them only by their slot via send_roster_dm. The platform posts a consent ' +
      'card to the group; a slot becomes usable ONLY if that exact person clicks opt-in. ' +
      'The platform decides everything that matters: it confirms the person is a current member of this group, refuses ' +
      'to re-invite someone who already responded, rate-limits invites, and controls the card — you cannot invite ' +
      'someone outside this group, and their identity is never revealed to you. ' +
      'Only works when the operator has enabled roster DM for this agent; otherwise the invite is rejected.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        member: {
          type: 'string',
          description: 'The Feishu member open_id (ou_…) of the person to invite. Must be a member of this group.',
        },
        slot_label: {
          type: 'string',
          description: 'The roster slot label to register them under (e.g. "approver", "ops-lead").',
        },
      },
      required: ['member', 'slot_label'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const member = typeof args.member === 'string' ? args.member.trim() : '';
    const slotLabel = typeof args.slot_label === 'string' ? args.slot_label.trim() : '';
    if (!member) return err('member is required — the open_id (ou_…) of the person to invite');
    if (!slotLabel) return err('slot_label is required — the roster slot to register them under');

    // Thin intent row. NO routing fields: the host derives scope/agent-group from
    // the session, validates membership, and BUILDS + addresses the directed
    // consent card itself (ADR-0044 Stage 3). The container never authors the
    // card, the scope, or the expectedUserId stamped on it.
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'roster.invite', member, slotLabel }),
    });

    log(`invite_to_roster: slot="${slotLabel}"`);
    // Opaque result (ADR-0044): never confirm whether the person exists, is a
    // member, or has already been invited — those are host decisions the agent
    // must not be able to probe via the tool result.
    return ok(
      `Invite queued for slot "${slotLabel}". The platform will post a consent card; a slot becomes usable only if ` +
        `that person opts in. Their identity is not shown to you, and the platform may decline the invite. ` +
        `Still reply to the user normally.`,
    );
  },
};

registerTools([sendRosterDm, inviteToRoster]);
