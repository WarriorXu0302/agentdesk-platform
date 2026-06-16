/**
 * Tests for pickApprover + pickApprovalDelivery — the approver-selection
 * half of what used to live in src/access.ts. Moved here in PR #7 alongside
 * the approvals re-tier.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { ChannelAdapter, OutboundMessage } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createOrganization } from '../permissions/db/organizations.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { pickApprovalDelivery, pickApprover } from './primitive.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(async () => {
  await teardownChannelAdapters();
  closeDb();
});

async function mountMockAdapter(
  channelType: string,
  openDM?: (handle: string) => Promise<string>,
): Promise<{ delivered: OutboundMessage[]; openDMCalls: string[] }> {
  const delivered: OutboundMessage[] = [];
  const openDMCalls: string[] = [];
  const adapter: ChannelAdapter = {
    name: channelType,
    channelType,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver(_platformId, _threadId, message) {
      delivered.push(message);
      return undefined;
    },
    async setTyping() {},
  };
  if (openDM) {
    adapter.openDM = async (handle: string) => {
      openDMCalls.push(handle);
      return openDM(handle);
    };
  }
  registerChannelAdapter(channelType, { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  return { delivered, openDMCalls };
}

function seedAgentGroup(id: string): void {
  createAgentGroup({
    id,
    name: id.toUpperCase(),
    folder: id,
    agent_provider: null,
    created_at: now(),
  });
}

function seedUser(id: string, kind: string): void {
  createUser({ id, kind, display_name: null, created_at: now() });
}

describe('pickApprover', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
  });

  it('prefers scoped admins, then globals, then owners — deduplicated', () => {
    seedUser('u-owner', 'telegram');
    seedUser('u-ga', 'telegram');
    seedUser('u-sa', 'telegram');
    grantRole({ userId: 'u-owner', role: 'owner', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    grantRole({ userId: 'u-ga', role: 'admin', scope: { kind: 'global' }, grantedBy: null, grantedAt: now() });
    grantRole({
      userId: 'u-sa',
      role: 'admin',
      scope: { kind: 'group', agentGroupId: 'ag-1' },
      grantedBy: null,
      grantedAt: now(),
    });

    expect(pickApprover('ag-1')).toEqual(['u-sa', 'u-ga', 'u-owner']);
    expect(pickApprover('ag-2')).toEqual(['u-ga', 'u-owner']);
    expect(pickApprover(null)).toEqual(['u-ga', 'u-owner']);
  });

  it('returns empty list when nobody is privileged', () => {
    expect(pickApprover('ag-1')).toEqual([]);
  });

  it('includes an org-admin of the group’s org (ADR-0052 FIX-4b)', () => {
    createOrganization({ id: 'org-x', name: 'X', slug: 'x', created_at: now() });
    createAgentGroup({
      id: 'ag-org',
      name: 'AGO',
      folder: 'ago',
      agent_provider: null,
      created_at: now(),
      organization_id: 'org-x',
    });
    seedUser('u-oa', 'telegram');
    grantRole({
      userId: 'u-oa',
      role: 'org-admin',
      scope: { kind: 'org', organizationId: 'org-x' },
      grantedBy: null,
      grantedAt: now(),
    });
    // org-admin of org-x is an eligible approver for ag-org (in org-x)…
    expect(pickApprover('ag-org')).toContain('u-oa');
    // …but not for a group in no org / another org.
    expect(pickApprover('ag-1')).not.toContain('u-oa');
  });
});

describe('pickApprovalDelivery', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
  });

  it('returns the first reachable approver', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:111', 'telegram');
    seedUser('telegram:222', 'telegram');

    const result = await pickApprovalDelivery(['telegram:111', 'telegram:222'], 'telegram');
    expect(result?.userId).toBe('telegram:111');
    expect(result?.messagingGroup.platform_id).toBe('111');
  });

  it('prefers same-channel-kind approver on tie-break', async () => {
    await mountMockAdapter('telegram');
    await mountMockAdapter('discord', async (h) => `dm-${h}`);
    seedUser('telegram:111', 'telegram');
    seedUser('discord:222', 'discord');

    const result = await pickApprovalDelivery(['telegram:111', 'discord:222'], 'discord');
    expect(result?.userId).toBe('discord:222');
  });

  it('falls through to any reachable approver when none match origin', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:111', 'telegram');

    const result = await pickApprovalDelivery(['telegram:111'], 'discord');
    expect(result?.userId).toBe('telegram:111');
  });

  it('returns null when nobody is reachable', async () => {
    seedUser('telegram:111', 'telegram');
    expect(await pickApprovalDelivery(['telegram:111'], 'telegram')).toBeNull();
  });
});
