import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { MessageInRow } from './db/messages-in.js';
import { closeSessionDb, initTestSessionDb } from './db/connection.js';
import { formatMessages } from './formatter.js';
import { stageDirectDelegationAttachments } from './poll-loop.js';

const roots: string[] = [];

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function message(content: object): MessageInRow {
  return {
    id: 'in-1',
    seq: 2,
    kind: 'chat',
    timestamp: '2026-08-09T00:00:00.000Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: 'local',
    channel_type: 'cli',
    thread_id: null,
    content: JSON.stringify(content),
    origin_user_id: null,
  };
}

describe('direct delegation attachments', () => {
  it('stages host-written inbound bytes in the outgoing outbox and suppresses source paths in the prompt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-direct-delegation-'));
    roots.push(root);
    const sourceDir = path.join(root, 'inbox', 'in-1');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'report.csv'), 'q3,revenue\n1,42\n');
    const inbound = message({
      sender: 'User',
      text: 'Please send this to Finance',
      attachments: [{ name: 'report.csv', localPath: 'inbox/in-1/report.csv' }],
    });

    const files = stageDirectDelegationAttachments([inbound], 'out-1', root);

    expect(files).toEqual(['report.csv']);
    expect(fs.readFileSync(path.join(root, 'outbox', 'out-1', 'report.csv'), 'utf8')).toBe('q3,revenue\n1,42\n');
    expect(formatMessages([inbound], { includeAttachments: false })).not.toContain('/workspace/inbox/in-1/report.csv');
  });

  it('does not stage paths or file types outside the inbound message directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-direct-delegation-'));
    roots.push(root);
    const sourceDir = path.join(root, 'inbox', 'in-1');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'safe.txt'), 'safe');
    const inbound = message({
      attachments: [
        { name: '../secret.txt', localPath: 'inbox/in-1/../secret.txt' },
        { name: 'missing.txt', localPath: 'inbox/in-1/missing.txt' },
      ],
    });

    expect(stageDirectDelegationAttachments([inbound], 'out-1', root)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'outbox', 'out-1'))).toBe(false);
  });
});
