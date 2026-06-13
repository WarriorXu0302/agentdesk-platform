/**
 * Approval-decision audit (roadmap 5.2): every resolved approval must leave a
 * durable enterprise_audit row BEFORE the transient pending_approvals row is
 * deleted, so a compliance reviewer can reconstruct who approved/rejected what.
 */
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The reject / no-handler resolve paths call wakeContainer; stub the runtime so
// the test never touches Docker.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn(async () => false),
  isContainerRunning: () => false,
  killContainer: vi.fn(async () => {}),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval' };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createPendingApproval } from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { resolveSession } from '../../session-manager.js';
import { registerApprovalHandler, auditApprovalHandlerRegistry } from './primitive.js';
import { handleApprovalsResponse } from './response-handler.js';

const now = (): string => new Date().toISOString();

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
});
afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function payload(value: string): ResponsePayload {
  return {
    questionId: 'ap-1',
    value,
    userId: 'admin-1',
    channelType: 'feishu',
    platformId: 'feishu:p2p:ou_admin',
    threadId: null,
  };
}

function auditRows(
  eventType: string,
): Array<{ actor: string | null; agent_group_id: string | null; details: string | null }> {
  return getDb()
    .prepare('SELECT actor, agent_group_id, details FROM enterprise_audit WHERE event_type = ?')
    .all(eventType) as Array<{ actor: string | null; agent_group_id: string | null; details: string | null }>;
}

/** Seed an agent group + messaging group + a real session (on-disk folder so
 * the approval-notify path can write to inbound.db) + a pending approval row. */
function seed(action: string): void {
  createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'feishu',
    platform_id: 'feishu:p2p:ou_x',
    name: 'Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
  createPendingApproval({
    approval_id: 'ap-1',
    request_id: 'rq-1',
    action,
    payload: JSON.stringify({}),
    created_at: now(),
    title: 'T',
    options_json: '[]',
    session_id: session.id,
    agent_group_id: 'ag-1',
  });
}

describe('approval decision audit (roadmap 5.2)', () => {
  it('records approval_resolved=rejected with the acting admin', async () => {
    seed('install_packages');
    registerApprovalHandler('install_packages', async () => {});
    expect(await handleApprovalsResponse(payload('reject'))).toBe(true);
    const rows = auditRows('approval_resolved');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('admin-1');
    expect(rows[0].agent_group_id).toBe('ag-1');
    expect(JSON.parse(rows[0].details!)).toMatchObject({ action: 'install_packages', result: 'rejected' });
  });

  it('records approval_resolved=approved when approved and the handler applies', async () => {
    seed('install_packages');
    let applied = false;
    registerApprovalHandler('install_packages', async () => {
      applied = true;
    });
    expect(await handleApprovalsResponse(payload('approve'))).toBe(true);
    expect(applied).toBe(true);
    const rows = auditRows('approval_resolved');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details!)).toMatchObject({ result: 'approved', outcome: 'applied' });
  });

  it('records outcome=apply_failed with the handler error when the handler throws (roadmap 5.10)', async () => {
    seed('install_packages');
    registerApprovalHandler('install_packages', async () => {
      throw new Error('disk full');
    });
    expect(await handleApprovalsResponse(payload('approve'))).toBe(true);
    const rows = auditRows('approval_resolved');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details!)).toMatchObject({
      result: 'approved',
      outcome: 'apply_failed',
      error: 'disk full',
    });
  });
});

describe('approval handler registry audit (roadmap 5.10)', () => {
  it('flushes the registered-handler set to enterprise_audit, flagging overwrites', () => {
    // Two registrations for the same action — the second overwrites the first.
    registerApprovalHandler('roadmap_5_10_demo', async () => {});
    registerApprovalHandler('roadmap_5_10_demo', async () => {});
    auditApprovalHandlerRegistry();

    const rows = auditRows('approval_handlers_registered');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const details = JSON.parse(rows[rows.length - 1].details!);
    expect(details.actions).toContain('roadmap_5_10_demo');
    expect(details.overwrites).toContain('roadmap_5_10_demo');
    expect(typeof details.count).toBe('number');
  });
});
