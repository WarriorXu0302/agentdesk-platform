/**
 * Host message-path e2e skeleton (channel-test-gap audit item; ADR-0030).
 *
 * Drives the REAL host message path end-to-end with an in-memory adapter:
 *
 *   ① inbound  — an in-memory adapter raises an inbound event → real
 *                routeInbound → assert the message lands in messages_in for the
 *                correct session, with the sender identity (senderId → origin)
 *                preserved in the persisted content.
 *   ② outbound — a (simulated) container writes a messages_out row → one real
 *                delivery drain → assert the in-memory adapter.deliver is called
 *                with the correct channel / platform / content.
 *
 * BOUNDARY (deliberate): this is the HOST segment of the main path — router,
 * session DBs, delivery drain. The container "turn" (LLM, tools, the bun-side
 * agent-runner) is OUT OF SCOPE here: it runs under Bun against bun:sqlite and
 * is exercised by container/agent-runner's own suite. This e2e fakes the
 * container by writing the outbound row the runner would have written, so the
 * host path is verified deterministically without Docker or a live model.
 *
 * Harness mirrors delivery.test.ts (real central + session DBs, on-disk session
 * folders under a temp DATA_DIR, container-runner mocked).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-e2e-path', DELIVERY_TIMEOUT_MS: 300 };
});

const TEST_DIR = '/tmp/nanoclaw-test-e2e-path';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from '../db/index.js';
import { createMessagingGroupAgent } from '../db/messaging-groups.js';
import { findSession } from '../db/sessions.js';
import { routeInbound, setSenderResolver } from '../router.js';
import { setDeliveryAdapter, deliverSessionMessages } from '../delivery.js';
import { resolveSession, inboundDbPath, outboundDbPath } from '../session-manager.js';
import { registerChannelAdapter, initChannelAdapters, getChannelAdapter } from './channel-registry.js';
import { assertChannelAdapterContract } from './channel-contract.js';
import type { ChannelAdapter, ChannelSetup, InboundEvent, InboundMessage, OutboundMessage } from './adapter.js';

function now(): string {
  return new Date().toISOString();
}

/**
 * Minimal in-memory ChannelAdapter that fully satisfies the ChannelAdapter
 * contract. It records outbound deliveries to an array so the test can assert
 * on them, and exposes emitInbound() to simulate a platform handing the host
 * an inbound message. Reused as the canonical "reference adapter" for the host
 * e2e — and itself asserted against the contract.
 */
function createInMemoryAdapter(channelType = 'memchan') {
  let cfg: ChannelSetup | null = null;
  const delivered: Array<{ platformId: string; threadId: string | null; message: OutboundMessage }> = [];

  const adapter: ChannelAdapter & {
    delivered: typeof delivered;
    emitInbound(platformId: string, threadId: string | null, message: InboundMessage): Promise<void>;
  } = {
    name: channelType,
    channelType,
    supportsThreads: false,
    delivered,

    async setup(config: ChannelSetup) {
      cfg = config;
    },
    async teardown() {
      cfg = null;
    },
    isConnected() {
      return cfg !== null;
    },
    async deliver(platformId, threadId, message) {
      delivered.push({ platformId, threadId, message });
      return `mem-msg-${delivered.length}`;
    },

    async emitInbound(platformId, threadId, message) {
      if (!cfg) throw new Error('adapter not set up');
      await cfg.onInbound(platformId, threadId, message);
    },
  };

  return adapter;
}

/**
 * The ChannelSetup the host hands an adapter at init. Mirrors the bridge in
 * src/index.ts: onInbound stitches the adapter's channelType onto an
 * InboundEvent and forwards to the real routeInbound.
 */
function bridgeSetup(adapter: ChannelAdapter): ChannelSetup {
  return {
    onInbound: (platformId, threadId, message) =>
      routeInbound({
        channelType: adapter.channelType,
        platformId,
        threadId,
        message: {
          id: message.id,
          kind: message.kind,
          content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          timestamp: message.timestamp,
          isMention: message.isMention,
          isGroup: message.isGroup,
        },
      }),
    onInboundEvent: (event: InboundEvent) => routeInbound(event),
    onMetadata: () => {},
    onAction: () => {},
  };
}

function seedTopology(channelType: string): void {
  createAgentGroup({ id: 'ag-1', name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: channelType,
    platform_id: 'mem:room-1',
    name: 'Mem Room',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.', // always engage
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('host e2e — in-memory reference adapter satisfies the contract', () => {
  it('the reference in-memory adapter passes assertChannelAdapterContract', () => {
    expect(() => assertChannelAdapterContract(createInMemoryAdapter())).not.toThrow();
  });
});

describe('host e2e ① inbound — adapter → routeInbound → messages_in', () => {
  it('writes the inbound to the correct session with sender identity preserved', async () => {
    seedTopology('memchan');

    // Register a sender resolver so the host derives a namespaced origin id from
    // the inbound senderId — the seam the permissions module uses to propagate
    // identity. With it we can assert the senderId → origin mapping was actually
    // consulted; the resolved row also carries the raw senderId for downstream.
    const resolved: Array<string | null> = [];
    setSenderResolver((event) => {
      const parsed = JSON.parse(event.message.content) as { senderId?: string };
      const origin = parsed.senderId ? `memchan:${parsed.senderId}` : null;
      resolved.push(origin);
      return origin;
    });

    const adapter = createInMemoryAdapter('memchan');
    registerChannelAdapter('memchan-e2e-in', { factory: () => adapter });
    await initChannelAdapters(bridgeSetup);
    expect(getChannelAdapter('memchan')).toBe(adapter);

    await adapter.emitInbound('mem:room-1', null, {
      id: 'mem-in-1',
      kind: 'chat',
      timestamp: now(),
      content: { text: 'hello from the user', sender: 'Alice', senderId: 'ou_alice' },
    });

    // The sender resolver was consulted with the inbound sender identity.
    expect(resolved).toEqual(['memchan:ou_alice']);

    const session = findSession('mg-1', null);
    expect(session).toBeDefined();

    const db = new Database(inboundDbPath('ag-1', session!.id));
    const rows = db.prepare('SELECT id, channel_type, platform_id, content FROM messages_in').all() as Array<{
      id: string;
      channel_type: string;
      platform_id: string;
      content: string;
    }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].channel_type).toBe('memchan');
    expect(rows[0].platform_id).toBe('mem:room-1');
    const content = JSON.parse(rows[0].content) as { text: string; senderId: string };
    expect(content.text).toBe('hello from the user');
    expect(content.senderId).toBe('ou_alice'); // origin identity preserved in the row
  });
});

describe('host e2e ② outbound — container row → delivery drain → adapter.deliver', () => {
  it('delivers a container-written outbound row through the in-memory adapter', async () => {
    seedTopology('memchan');

    const adapter = createInMemoryAdapter('memchan');
    registerChannelAdapter('memchan-e2e-out', { factory: () => adapter });
    await initChannelAdapters(bridgeSetup);

    // Same bridge index.ts wires: delivery → live channel adapter by type.
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId, kind, content, files) {
        const a = getChannelAdapter(channelType);
        if (!a) return undefined;
        return a.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
      },
    });

    // Resolve/create the session the host would have created for this chat.
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // Simulate the container writing a reply to its outbound.db (the bun-side
    // turn that is out of scope for this host e2e).
    const outDb = new Database(outboundDbPath('ag-1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
         VALUES (?, datetime('now'), 'chat', ?, ?, ?)`,
      )
      .run('out-1', 'mem:room-1', 'memchan', JSON.stringify({ text: 'agent reply' }));
    outDb.close();

    // One real delivery drain (the same function the active/sweep polls call).
    await deliverSessionMessages(session);

    expect(adapter.delivered).toHaveLength(1);
    const got = adapter.delivered[0];
    expect(got.platformId).toBe('mem:room-1');
    expect(got.threadId).toBeNull();
    expect((got.message.content as { text: string }).text).toBe('agent reply');
  });
});
