import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({
  TEST_ROOT: '/tmp/nanoclaw-test-enterprise-topology',
}));

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
  return {
    ...actual,
    DATA_DIR: path.join(TEST_ROOT, 'data'),
    GROUPS_DIR: path.join(TEST_ROOT, 'groups'),
  };
});

import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { readContainerConfig } from '../src/container-config.js';
import { closeDb } from '../src/db/connection.js';
import { getMessagingGroupAgentByPair, getMessagingGroupByPlatform } from '../src/db/messaging-groups.js';
import {
  createDestination,
  deleteDestination,
  getDestinationByName,
} from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { run } from './init-enterprise-topology.js';

beforeEach(() => {
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('init-enterprise-topology', () => {
  it('reconciles existing shared-entry wiring on rerun', async () => {
    await run([
      '--channel',
      'feishu',
      '--platform-id',
      'oc_123',
      '--session-mode',
      'shared',
      '--engage-mode',
      'mention',
      '--sender-scope',
      'known',
      '--unknown-sender-policy',
      'public',
    ]);

    await run(['--channel', 'feishu', '--platform-id', 'oc_123', '--threaded', '--unknown-sender-policy', 'strict']);

    const frontdesk = getAgentGroupByFolder('frontlane-frontdesk');
    const messagingGroup = getMessagingGroupByPlatform('feishu', 'feishu:oc_123');
    expect(frontdesk).toBeDefined();
    expect(messagingGroup).toBeDefined();
    expect(messagingGroup?.unknown_sender_policy).toBe('strict');

    const wiring = getMessagingGroupAgentByPair(messagingGroup!.id, frontdesk!.id);
    expect(wiring).toBeDefined();
    expect(wiring?.engage_mode).toBe('mention-sticky');
    expect(wiring?.engage_pattern).toBeNull();
    expect(wiring?.sender_scope).toBe('all');
    expect(wiring?.ignored_message_policy).toBe('drop');
    expect(wiring?.session_mode).toBe('per-user-per-thread');
    expect(wiring?.priority).toBe(0);
  });

  it('ensures workers have a stable frontdesk return alias', async () => {
    await run([]);

    const frontdesk = getAgentGroupByFolder('frontlane-frontdesk');
    const worker = getAgentGroupByFolder('frontlane-access-worker');
    expect(frontdesk).toBeDefined();
    expect(worker).toBeDefined();

    deleteDestination(worker!.id, 'frontdesk');
    createDestination({
      agent_group_id: worker!.id,
      local_name: 'parent',
      target_type: 'agent',
      target_id: frontdesk!.id,
      created_at: new Date().toISOString(),
    });

    await run([]);

    expect(getDestinationByName(worker!.id, 'parent')?.target_id).toBe(frontdesk!.id);
    expect(getDestinationByName(worker!.id, 'frontdesk')?.target_id).toBe(frontdesk!.id);
  });

  it('writes root-session a2a policy into enterprise group configs', async () => {
    await run([]);

    expect(readContainerConfig('frontlane-frontdesk').a2aSessionMode).toBe('root-session');
    expect(readContainerConfig('frontlane-access-worker').a2aSessionMode).toBe('root-session');
  });
});
