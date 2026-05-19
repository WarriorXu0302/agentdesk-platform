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

  it('writes conservative default resources for frontdesk and workers', async () => {
    await run([]);

    const frontdeskResources = readContainerConfig('frontlane-frontdesk').resources;
    expect(frontdeskResources).toEqual({ memoryMb: 768, cpus: 1, pidsLimit: 384 });

    const workerResources = readContainerConfig('frontlane-access-worker').resources;
    expect(workerResources).toEqual({ memoryMb: 1024, cpus: 1, pidsLimit: 512 });
  });

  it('does not clobber hand-tuned resource caps on rerun', async () => {
    // First init sets the defaults.
    await run([]);

    // Operator hand-edits container.json — raises worker memory, lowers cpus.
    const { writeContainerConfig } = await import('../src/container-config.js');
    const cfg = readContainerConfig('frontlane-access-worker');
    cfg.resources = { memoryMb: 4096, cpus: 0.5, pidsLimit: 1024 };
    writeContainerConfig('frontlane-access-worker', cfg);

    // Rerun the init — must leave the operator's choices alone.
    await run([]);

    const after = readContainerConfig('frontlane-access-worker').resources;
    expect(after).toEqual({ memoryMb: 4096, cpus: 0.5, pidsLimit: 1024 });
  });

  it('provisions both primary and lab frontdesks by default (ADR-0008)', async () => {
    await run([]);

    const primary = getAgentGroupByFolder('frontlane-frontdesk');
    const lab = getAgentGroupByFolder('frontlane-lab-frontdesk');
    expect(primary).toBeDefined();
    expect(primary?.name).toBe('FrontLane Desk');
    expect(lab).toBeDefined();
    expect(lab?.name).toBe('FrontLane Lab Desk');

    const FRONTDESK_RESOURCES = { memoryMb: 768, cpus: 1, pidsLimit: 384 };
    expect(readContainerConfig('frontlane-frontdesk').a2aSessionMode).toBe('root-session');
    expect(readContainerConfig('frontlane-lab-frontdesk').a2aSessionMode).toBe('root-session');
    expect(readContainerConfig('frontlane-frontdesk').resources).toEqual(FRONTDESK_RESOURCES);
    expect(readContainerConfig('frontlane-lab-frontdesk').resources).toEqual(FRONTDESK_RESOURCES);
  });

  it('only the primary frontdesk owns reverse worker destinations (no double-bind)', async () => {
    await run([]);

    const primary = getAgentGroupByFolder('frontlane-frontdesk');
    const lab = getAgentGroupByFolder('frontlane-lab-frontdesk');
    const accessWorker = getAgentGroupByFolder('frontlane-access-worker');
    expect(primary).toBeDefined();
    expect(lab).toBeDefined();
    expect(accessWorker).toBeDefined();

    const reverse = getDestinationByName(accessWorker!.id, 'frontdesk');
    expect(reverse).toBeDefined();
    expect(reverse?.target_id).toBe(primary!.id);
    expect(reverse?.target_id).not.toBe(lab!.id);

    expect(getDestinationByName(lab!.id, 'access-worker')).toBeUndefined();
  });

  it('single-frontdesk back-compat: --frontdesk-folder skips secondary desks', async () => {
    await run(['--frontdesk-folder', 'frontlane-frontdesk']);

    expect(getAgentGroupByFolder('frontlane-frontdesk')).toBeDefined();
    expect(getAgentGroupByFolder('frontlane-lab-frontdesk')).toBeUndefined();
  });

  it('--frontdesks accepts a custom comma-separated list', async () => {
    await run(['--frontdesks', 'frontlane-frontdesk:FrontLane Desk,frontlane-research-desk:FrontLane Research Desk']);

    const primary = getAgentGroupByFolder('frontlane-frontdesk');
    const research = getAgentGroupByFolder('frontlane-research-desk');
    expect(primary?.name).toBe('FrontLane Desk');
    expect(research?.name).toBe('FrontLane Research Desk');
    expect(getAgentGroupByFolder('frontlane-lab-frontdesk')).toBeUndefined();
  });

  it('rejects mixing --frontdesks with --frontdesk-folder', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        run(['--frontdesks', 'frontlane-frontdesk:FrontLane Desk', '--frontdesk-folder', 'frontlane-other']),
      ).rejects.toThrow('process.exit called');
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
