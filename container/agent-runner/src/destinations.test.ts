import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { buildSystemPromptAddendum, getLiveRosterSlots } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, displayName, channelType, platformId);
}

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Default routing');
    expect(prompt).toContain('from="name"');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`whatsapp-mg-17780`');
  });

  it('requires explicit wrapping even for a single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Every response must be wrapped');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('`casa`');
  });

  it('handles the no-destination case without crashing', () => {
    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('no configured destinations');
    expect(prompt).not.toContain('Default routing');
  });

  it('includes default-routing and wrapping instructions for single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Every response must be wrapped');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('Default routing');
    expect(prompt).toContain('`casa`');
  });

  it('includes backend memory restrictions when memoryMode=gateway', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa', 'gateway');

    expect(prompt).toContain('Memory policy');
    expect(prompt).toContain('Do not store durable user');
    expect(prompt).toContain('gateway_memory_get');
    expect(prompt).toContain('gateway_memory_upsert');
  });
});

describe('buildSystemPromptAddendum — roster slots (ADR-0044 Stage 1 discovery)', () => {
  function seedSlot(slotLabel: string, sendsRemaining: number | null, expiresAt: string | null): void {
    getInboundDb()
      .prepare('INSERT INTO roster_slots (slot_label, sends_remaining, expires_at) VALUES (?, ?, ?)')
      .run(slotLabel, sendsRemaining, expiresAt);
  }

  it('lists projected slot labels and never any identity field', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedSlot('approver', 2, '2026-07-01T00:00:00.000Z');
    seedSlot('ops-lead', null, null);

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Roster slots you can DM');
    expect(prompt).toContain('`approver`');
    expect(prompt).toContain('`ops-lead`');
    expect(prompt).toContain('2 send(s) left');
    expect(prompt).toContain('expires 2026-07-01T00:00:00.000Z');
    // The agent must NEVER see anything that identifies the person behind a slot.
    expect(prompt).not.toContain('ou_');
    expect(prompt).not.toContain('feishu:p2p');
    expect(prompt).not.toContain('open_id');
  });

  it('omits the roster section entirely when there are no live slots', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).not.toContain('Roster slots you can DM');
  });

  it('getLiveRosterSlots projects only labels + liveness hints (no identity columns)', () => {
    seedSlot('approver', 1, null);
    const slots = getLiveRosterSlots();
    expect(slots).toEqual([{ slotLabel: 'approver', sendsRemaining: 1, expiresAt: null }]);
    // Identity-free by construction: the row carries exactly three keys.
    expect(Object.keys(slots[0]).sort()).toEqual(['expiresAt', 'sendsRemaining', 'slotLabel']);
  });
});
