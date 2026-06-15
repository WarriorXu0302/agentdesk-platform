/**
 * requestApproval delivery scoping (ADR-0019, roadmap 5.9).
 *
 * The fail-closed operator gate only fires when the delivered ask_question card
 * carries an `expectedUserId`. These tests pin that requestApproval threads the
 * chosen approver's normalized handle into the card content, so the gate scopes
 * to a KNOWN approver rather than relying on the delivery-target id-type.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChannelAdapter } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { requestApproval } from './primitive.js';

function now(): string {
  return new Date().toISOString();
}

interface Delivered {
  channelType: string;
  platformId: string;
  content: Record<string, unknown>;
}

/** Mount a channel-registry adapter (for ensureUserDm.openDM resolution). */
async function mountFeishuAdapter(): Promise<void> {
  const adapter: ChannelAdapter = {
    name: 'feishu',
    channelType: 'feishu',
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver() {
      return undefined;
    },
    async setTyping() {},
    // Feishu's real openDM mints `feishu:p2p:<handle>` (feishu.ts).
    async openDM(handle: string) {
      return `feishu:p2p:${handle}`;
    },
  };
  registerChannelAdapter('feishu', { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

/** Install a delivery adapter that records every deliver() call's content. */
function recordDeliveries(): Delivered[] {
  const delivered: Delivered[] = [];
  const adapter: ChannelDeliveryAdapter = {
    async deliver(channelType, platformId, _threadId, _kind, content) {
      delivered.push({ channelType, platformId, content: JSON.parse(content) as Record<string, unknown> });
      return 'msg-1';
    },
  };
  setDeliveryAdapter(adapter);
  return delivered;
}

beforeEach(() => {
  runMigrations(initTestDb());
});

afterEach(async () => {
  await teardownChannelAdapters();
  closeDb();
});

describe('requestApproval delivers a scoped approval card (ADR-0019)', () => {
  it('threads the chosen approver open_id as expectedUserId on the ask_question card', async () => {
    await mountFeishuAdapter();
    const delivered = recordDeliveries();

    createAgentGroup({ id: 'ag-1', name: 'AG-1', folder: 'ag-1', agent_provider: null, created_at: now() });
    createUser({ id: 'feishu:ou_approver', kind: 'feishu', display_name: null, created_at: now() });
    grantRole({
      user_id: 'feishu:ou_approver',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    const session: Session = {
      id: 's-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      owner_user_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: now(),
      archived_at: null,
      created_at: now(),
    };
    createSession(session);

    await requestApproval({
      session,
      agentName: 'frontdesk',
      action: 'sensitive_thing',
      payload: { foo: 'bar' },
      title: 'Approve sensitive thing?',
      question: 'The agent wants to do a sensitive thing. Allow?',
    });

    expect(delivered).toHaveLength(1);
    const card = delivered[0];
    expect(card.channelType).toBe('feishu');
    // Delivered to the approver's p2p DM, scoped to their open_id.
    expect(card.platformId).toBe('feishu:p2p:ou_approver');
    expect(card.content.type).toBe('ask_question');
    expect(card.content.expectedUserId).toBe('ou_approver');
  });
});
