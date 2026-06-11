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

// Derived from the default branding namespace (agentdesk). The bootstrap
// script builds folder names off `DEFAULT_FRONTDESK_FOLDER` /
// `buildWorkerFolder`, so the tests reference the same derived slugs.
const FRONTDESK_FOLDER = 'agentdesk-frontdesk';
const FRONTDESK_NAME = 'AgentDesk Frontdesk';
const ACCESS_WORKER_FOLDER = 'agentdesk-access-worker';

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

    const frontdesk = getAgentGroupByFolder(FRONTDESK_FOLDER);
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
    await run(['--workers', 'access-worker']);

    const frontdesk = getAgentGroupByFolder(FRONTDESK_FOLDER);
    const worker = getAgentGroupByFolder(ACCESS_WORKER_FOLDER);
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

    await run(['--workers', 'access-worker']);

    expect(getDestinationByName(worker!.id, 'parent')?.target_id).toBe(frontdesk!.id);
    expect(getDestinationByName(worker!.id, 'frontdesk')?.target_id).toBe(frontdesk!.id);
  });

  it('writes root-session a2a policy into enterprise group configs', async () => {
    await run(['--workers', 'access-worker']);

    expect(readContainerConfig(FRONTDESK_FOLDER).a2aSessionMode).toBe('root-session');
    expect(readContainerConfig(ACCESS_WORKER_FOLDER).a2aSessionMode).toBe('root-session');
  });

  it('writes conservative default resources for frontdesk and workers', async () => {
    await run(['--workers', 'access-worker']);

    const frontdeskResources = readContainerConfig(FRONTDESK_FOLDER).resources;
    expect(frontdeskResources).toEqual({ memoryMb: 768, cpus: 1, pidsLimit: 384 });

    const workerResources = readContainerConfig(ACCESS_WORKER_FOLDER).resources;
    expect(workerResources).toEqual({ memoryMb: 1024, cpus: 1, pidsLimit: 512 });
  });

  it('does not clobber hand-tuned resource caps on rerun', async () => {
    // First init sets the defaults.
    await run(['--workers', 'access-worker']);

    // Operator hand-edits container.json — raises worker memory, lowers cpus.
    const { writeContainerConfig } = await import('../src/container-config.js');
    const cfg = readContainerConfig(ACCESS_WORKER_FOLDER);
    cfg.resources = { memoryMb: 4096, cpus: 0.5, pidsLimit: 1024 };
    writeContainerConfig(ACCESS_WORKER_FOLDER, cfg);

    // Rerun the init — must leave the operator's choices alone.
    await run(['--workers', 'access-worker']);

    const after = readContainerConfig(ACCESS_WORKER_FOLDER).resources;
    expect(after).toEqual({ memoryMb: 4096, cpus: 0.5, pidsLimit: 1024 });
  });

  it('provisions a single blank template frontdesk by default (no workers, no extra desks)', async () => {
    await run([]);

    const primary = getAgentGroupByFolder(FRONTDESK_FOLDER);
    expect(primary).toBeDefined();
    expect(primary?.name).toBe(FRONTDESK_NAME);

    // No business workers and no secondary desk are provisioned by default.
    expect(getAgentGroupByFolder(ACCESS_WORKER_FOLDER)).toBeUndefined();
    expect(getAgentGroupByFolder('agentdesk-lab-frontdesk')).toBeUndefined();

    expect(readContainerConfig(FRONTDESK_FOLDER).a2aSessionMode).toBe('root-session');
    expect(readContainerConfig(FRONTDESK_FOLDER).resources).toEqual({ memoryMb: 768, cpus: 1, pidsLimit: 384 });
  });

  it('only the primary frontdesk owns reverse worker destinations (no double-bind)', async () => {
    await run([
      '--frontdesks',
      `${FRONTDESK_FOLDER}:${FRONTDESK_NAME},agentdesk-secondary-desk:Secondary Desk`,
      '--workers',
      'access-worker',
    ]);

    const primary = getAgentGroupByFolder(FRONTDESK_FOLDER);
    const secondary = getAgentGroupByFolder('agentdesk-secondary-desk');
    const accessWorker = getAgentGroupByFolder(ACCESS_WORKER_FOLDER);
    expect(primary).toBeDefined();
    expect(secondary).toBeDefined();
    expect(accessWorker).toBeDefined();

    const reverse = getDestinationByName(accessWorker!.id, 'frontdesk');
    expect(reverse).toBeDefined();
    expect(reverse?.target_id).toBe(primary!.id);
    expect(reverse?.target_id).not.toBe(secondary!.id);

    expect(getDestinationByName(secondary!.id, 'access-worker')).toBeUndefined();
  });

  it('single-frontdesk back-compat: --frontdesk-folder skips secondary desks', async () => {
    await run([
      '--frontdesks',
      `${FRONTDESK_FOLDER}:${FRONTDESK_NAME},agentdesk-secondary-desk:Secondary Desk`,
      '--workers',
      'access-worker',
    ]);
    closeDb();
    if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });

    await run(['--frontdesk-folder', FRONTDESK_FOLDER]);

    expect(getAgentGroupByFolder(FRONTDESK_FOLDER)).toBeDefined();
    expect(getAgentGroupByFolder('agentdesk-secondary-desk')).toBeUndefined();
  });

  it('--frontdesks accepts a custom comma-separated list', async () => {
    await run(['--frontdesks', `${FRONTDESK_FOLDER}:${FRONTDESK_NAME},agentdesk-research-desk:Research Desk`]);

    const primary = getAgentGroupByFolder(FRONTDESK_FOLDER);
    const research = getAgentGroupByFolder('agentdesk-research-desk');
    expect(primary?.name).toBe(FRONTDESK_NAME);
    expect(research?.name).toBe('Research Desk');
  });

  it('rejects mixing --frontdesks with --frontdesk-folder', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        run(['--frontdesks', `${FRONTDESK_FOLDER}:${FRONTDESK_NAME}`, '--frontdesk-folder', 'agentdesk-other']),
      ).rejects.toThrow('process.exit called');
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
