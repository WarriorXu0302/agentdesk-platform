import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { clearRoutingGate, setRoutingGate } from '../routing/gate.js';
import { sendCard } from './interactive.js';

beforeEach(() => initTestSessionDb());
afterEach(() => {
  clearRoutingGate();
  closeSessionDb();
});

function setSessionRouting(channelType: string, platformId: string): void {
  const db = getInboundDb();
  db.exec(
    `CREATE TABLE IF NOT EXISTS session_routing (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       channel_type TEXT,
       platform_id TEXT,
       thread_id TEXT
     )`,
  );
  db.prepare(
    `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, ?, ?, NULL)`,
  ).run(channelType, platformId);
}

describe('interactive tools — enforced routing gate', () => {
  it('stamps the controller decision id on a card sent to the origin', async () => {
    setSessionRouting('cli', 'local');
    setRoutingGate({
      decisionId: 'route-card',
      anchorId: 'm1',
      action: 'clarify',
      originChannelType: 'cli',
      originPlatformId: 'local',
    });

    const result = await sendCard.handler({ card: { title: 'Need details' } });

    expect(result.isError).toBeUndefined();
    const row = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind='chat-sdk'").get() as {
      content: string;
    };
    expect(JSON.parse(row.content)._classificationId).toBe('route-card');
  });

  it('rejects a card when fixed session routing does not match the origin gate', async () => {
    setSessionRouting('feishu', 'feishu:group:other');
    setRoutingGate({
      decisionId: 'route-card-origin',
      anchorId: 'm1',
      action: 'reject',
      originChannelType: 'cli',
      originPlatformId: 'local',
    });

    const result = await sendCard.handler({ card: { title: 'Wrong destination' } });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/non_origin_destination/);
    expect((getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number }).n).toBe(0);
  });
});
