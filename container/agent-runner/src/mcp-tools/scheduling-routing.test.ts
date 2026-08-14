import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { clearRoutingGate, setRoutingGate } from '../routing/gate.js';
import { scheduleTask, updateTask } from './scheduling.js';

beforeEach(() => {
  initTestSessionDb();
  clearRoutingGate();
});
afterEach(() => {
  clearRoutingGate();
  closeSessionDb();
});

function outboundCount(): number {
  return (getOutboundDb().prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;
}

describe('scheduling under an active routing gate', () => {
  // A deferred turn runs LATER as its own turn with an arbitrary prompt, so it
  // cannot be proven to obey the current enforced decision. A rejected/clarify
  // Execution scheduling "forward this to worker-finance" (or a roster DM) is the
  // exact self-re-routing escape ADR-0054 rejects Option B over.
  it('refuses schedule_task while a decision is enforced, writing no row', async () => {
    setRoutingGate({ decisionId: 'r1', anchorId: 'm1', action: 'reject' });
    const res = await scheduleTask.handler({
      prompt: 'forward to worker-finance',
      processAfter: '2999-01-01T00:00:00Z',
    });
    expect(res.isError).toBe(true);
    expect(outboundCount()).toBe(0);
  });

  it('refuses update_task while a decision is enforced', async () => {
    setRoutingGate({ decisionId: 'r2', anchorId: 'm2', action: 'clarify' });
    const res = await updateTask.handler({ taskId: 't-1', prompt: 'send_roster_dm slot=approver text=hi' });
    expect(res.isError).toBe(true);
    expect(outboundCount()).toBe(0);
  });

  it('allows schedule_task normally when no gate is active', async () => {
    const res = await scheduleTask.handler({ prompt: 'daily report', processAfter: '2999-01-01T00:00:00Z' });
    expect(res.isError).toBeFalsy();
    expect(outboundCount()).toBe(1);
  });
});
