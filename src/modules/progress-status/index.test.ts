import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import {
  clearProgressStatus,
  markProgressStatusCompleted,
  markProgressStatusFailed,
  maybeStartProgressStatus,
} from './index.js';

function makeAdapter(deliver = vi.fn<ChannelDeliveryAdapter['deliver']>()) {
  return {
    deliver,
  } satisfies ChannelDeliveryAdapter;
}

beforeEach(() => {
  delete process.env.AGENTDESK_PROGRESS_STATUS_CHANNELS;
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  delete process.env.AGENTDESK_PROGRESS_STATUS_CHANNELS;
  try {
    clearProgressStatus('sess-1');
    clearProgressStatus('sess-2');
    clearProgressStatus('sess-3');
  } catch {
    // DB already closed
  }
  closeDb();
});

describe('progress-status reaction', () => {
  it('adds and removes a Feishu progress reaction', async () => {
    const deliver = vi
      .fn<ChannelDeliveryAdapter['deliver']>()
      .mockResolvedValueOnce('reaction-id')
      .mockResolvedValueOnce('reaction-id');
    const adapter = makeAdapter(deliver);

    await maybeStartProgressStatus('sess-1', 'feishu', 'feishu:p2p:ou_x', null, 'om_source', adapter);
    await markProgressStatusCompleted('sess-1', adapter);

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenNthCalledWith(
      1,
      'feishu',
      'feishu:p2p:ou_x',
      null,
      'chat',
      JSON.stringify({
        operation: 'reaction',
        action: 'add',
        messageId: 'om_source',
        emoji: 'THINKING',
      }),
    );
    expect(deliver).toHaveBeenNthCalledWith(
      2,
      'feishu',
      'feishu:p2p:ou_x',
      null,
      'chat',
      JSON.stringify({
        operation: 'reaction',
        action: 'remove',
        messageId: 'om_source',
        reactionId: 'reaction-id',
        emoji: 'THINKING',
      }),
    );
  });

  it('removes the Feishu progress reaction on wake failure', async () => {
    const deliver = vi
      .fn<ChannelDeliveryAdapter['deliver']>()
      .mockResolvedValueOnce('reaction-id')
      .mockResolvedValueOnce('reaction-id');
    const adapter = makeAdapter(deliver);

    await maybeStartProgressStatus('sess-2', 'feishu', 'feishu:p2p:ou_x', null, 'om_source', adapter);
    await markProgressStatusFailed('sess-2', adapter);

    expect(deliver).toHaveBeenNthCalledWith(
      2,
      'feishu',
      'feishu:p2p:ou_x',
      null,
      'chat',
      JSON.stringify({
        operation: 'reaction',
        action: 'remove',
        messageId: 'om_source',
        reactionId: 'reaction-id',
        emoji: 'THINKING',
      }),
    );
  });

  it('is disabled for channels outside the allowlist', async () => {
    const deliver = vi.fn<ChannelDeliveryAdapter['deliver']>().mockResolvedValue('reaction-id');
    const adapter = makeAdapter(deliver);

    await maybeStartProgressStatus('sess-3', 'telegram', 'telegram:123', null, 'msg-1', adapter);

    expect(deliver).not.toHaveBeenCalled();
  });
});
