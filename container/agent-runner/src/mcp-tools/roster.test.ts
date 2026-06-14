import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getOutboundDb } from '../db/connection.js';
import { sendRosterDm } from './roster.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function lastOutbound(): { kind: string; platform_id: string | null; channel_type: string | null; content: string } {
  return getOutboundDb()
    .prepare('SELECT kind, platform_id, channel_type, content FROM messages_out ORDER BY seq DESC LIMIT 1')
    .get() as { kind: string; platform_id: string | null; channel_type: string | null; content: string };
}

describe('send_roster_dm tool (ADR-0044)', () => {
  it("emits a kind='roster' row addressing a SLOT, with no concrete routing", async () => {
    const result = await sendRosterDm.handler({ slot: 'approver', text: 'please action ORD-5512' });
    expect(result.isError).toBeUndefined();

    const row = lastOutbound();
    expect(row.kind).toBe('roster');
    // Host resolves slot -> grant and overrides routing (R3): the agent writes
    // no concrete destination.
    expect(row.platform_id).toBeNull();
    expect(row.channel_type).toBeNull();
    const payload = JSON.parse(row.content) as { slot?: string; text?: string };
    expect(payload.slot).toBe('approver');
    expect(payload.text).toBe('please action ORD-5512');
  });

  it('returns an OPAQUE result — never echoes a recipient id/handle', async () => {
    const result = await sendRosterDm.handler({ slot: 'ops-lead', text: 'hi' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('ops-lead'); // the slot is fine to echo
    expect(text).not.toMatch(/ou_/); // never a Feishu open_id
    expect(text).not.toMatch(/feishu:p2p:/); // never a resolved p2p platform id
  });

  it('requires a slot', async () => {
    const result = await sendRosterDm.handler({ text: 'hi' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/slot is required/);
  });

  it('requires non-empty text', async () => {
    const result = await sendRosterDm.handler({ slot: 'approver', text: '   ' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/text is required/);
  });
});
