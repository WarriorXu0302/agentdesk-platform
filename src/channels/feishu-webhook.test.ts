/**
 * Feishu stateful-path tests (channel-test-gap audit item; openclaw ⑤).
 *
 * Covers the previously-zero-coverage stateful surface of the Feishu adapter
 * with REAL code paths (only fetch + the HTTP req/res are faked):
 *
 *   ① signature verification (verifyFeishuSignature) — timing-safe, rejects a
 *      tamper of body / timestamp / nonce.
 *   ② AES-256-CBC encrypt → decrypt round-trip (real crypto), bad ciphertext /
 *      wrong key return null without throwing.
 *   ③ webhook handler dispatch (end-to-end through the adapter's real
 *      handleWebhook): url_verification challenge echo; encrypted+signed event
 *      reaches onInbound with correct args; bad signature → 401, no onInbound;
 *      duplicate event_id deduped via real markInboundSeen (onInbound once);
 *      oversized body → 413.
 *   ④ tenant token single-flight + expiry refresh (fake fetch counts refreshes).
 *   ⑤ deliver branches: text / interactive card / image route to the right
 *      Feishu API path with the right body shape (fake fetch asserts URL+body).
 *
 * The webhook handler is a closure inside the adapter; we capture it by mocking
 * `registerWebhookHandler` and calling the real `setup()`.
 */
import { EventEmitter } from 'events';
import crypto from 'crypto';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  signFeishuBody,
  verifyFeishuSignature,
  decryptFeishuPayload,
  extractEffectivePayload,
} from './feishu/primitives.js';
import { createFeishuAdapter } from './feishu.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';
import type { FeishuConfig } from './feishu/types.js';
import type { RawWebhookHandler } from '../webhook-server.js';

// ── Capture the webhook handler the adapter registers during setup() ─────────
let capturedHandler: RawWebhookHandler | null = null;
let capturedPath: string | null = null;
vi.mock('../webhook-server.js', () => ({
  registerWebhookHandler: (path: string, handler: RawWebhookHandler) => {
    capturedPath = path;
    capturedHandler = handler;
  },
}));

// In-memory central DB so markInboundSeen (real dedup) has a table to write.
import { initTestDb, closeDb, runMigrations } from '../db/index.js';

const ENCRYPT_KEY = 'unit_test_encrypt_key';
const VERIFICATION_TOKEN = 'verif_token_xyz';

function baseConfig(overrides: Partial<FeishuConfig> = {}): FeishuConfig {
  return {
    appId: 'cli_app',
    appSecret: 'app_secret',
    encryptKey: ENCRYPT_KEY,
    verificationToken: VERIFICATION_TOKEN,
    webhookPath: '/webhook/feishu',
    baseUrl: 'https://open.feishu.cn',
    requestTimeoutMs: 15000,
    bodyTimeoutMs: 10000,
    maxBodyBytes: 1024,
    botOpenId: undefined,
    botName: undefined,
    eventMode: 'webhook',
    ...overrides,
  };
}

/** Feishu's outer encrypted-envelope shape: { encrypt: base64(iv|aes-256-cbc(json)) }. */
function encryptEnvelope(encryptKey: string, payload: Record<string, unknown>): string {
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  return Buffer.concat([iv, ct]).toString('base64');
}

/** Build a signed, JSON-content-typed fake request whose body streams via events. */
interface FakeReqOpts {
  body: string;
  timestamp?: string;
  nonce?: string;
  signature?: string; // override (for tamper tests); default = correct sig
  method?: string;
  contentType?: string | null;
  encryptKey?: string;
}

function fakeReq(opts: FakeReqOpts): EventEmitter & {
  method: string;
  url: string;
  headers: Record<string, string>;
  destroyed: boolean;
  destroy: () => void;
} {
  const timestamp = opts.timestamp ?? '1711111111';
  const nonce = opts.nonce ?? 'nonce-abc';
  const signature =
    opts.signature ??
    signFeishuBody({ encryptKey: opts.encryptKey ?? ENCRYPT_KEY, timestamp, nonce, rawBody: opts.body });

  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
    destroyed: boolean;
    destroy: () => void;
  };
  req.method = opts.method ?? 'POST';
  req.url = '/webhook/feishu';
  req.destroyed = false;
  req.destroy = () => {
    req.destroyed = true;
  };
  const headers: Record<string, string> = {
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': signature,
  };
  if (opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'application/json';
  req.headers = headers;

  // Stream the body after the handler has attached its listeners.
  setImmediate(() => {
    req.emit('data', Buffer.from(opts.body, 'utf8'));
    req.emit('end');
  });
  return req;
}

interface FakeRes {
  statusCode: number | null;
  headers: Record<string, string> | undefined;
  body: string;
  writeHead: (status: number, headers?: Record<string, string>) => FakeRes;
  end: (body?: string) => void;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: null,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
      return res;
    },
    end(body?: string) {
      if (body !== undefined) res.body = body;
    },
  };
  return res;
}

/** A no-op ChannelSetup with spies the tests can assert on. */
function makeSetup(): ChannelSetup & {
  inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }>;
  actions: Array<{ questionId: string; selectedOption: string; userId: string }>;
} {
  const inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];
  const actions: Array<{ questionId: string; selectedOption: string; userId: string }> = [];
  return {
    inbound,
    actions,
    onInbound: (platformId, threadId, message) => {
      inbound.push({ platformId, threadId, message });
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: (questionId, selectedOption, userId) => {
      actions.push({ questionId, selectedOption, userId });
    },
  };
}

function messageEvent(overrides: { messageId?: string; text?: string; chatId?: string; openId?: string } = {}) {
  return {
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', token: VERIFICATION_TOKEN },
    event: {
      sender: { sender_id: { open_id: overrides.openId ?? 'ou_sender_1' } },
      message: {
        message_id: overrides.messageId ?? 'om_msg_1',
        chat_id: overrides.chatId ?? 'oc_chat_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: overrides.text ?? 'hello bot' }),
        create_time: '1711111111000',
      },
    },
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  capturedHandler = null;
  capturedPath = null;
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('① verifyFeishuSignature — timing-safe, tamper-rejecting', () => {
  const ts = '1711111111';
  const nonce = 'nonce-abc';
  const body = JSON.stringify({ encrypt: 'whatever' });
  const goodSig = signFeishuBody({ encryptKey: ENCRYPT_KEY, timestamp: ts, nonce, rawBody: body });

  const headers = (sig: string, t = ts, n = nonce) => ({
    'x-lark-request-timestamp': t,
    'x-lark-request-nonce': n,
    'x-lark-signature': sig,
  });

  it('accepts a correctly-signed request', () => {
    expect(verifyFeishuSignature(headers(goodSig), body, ENCRYPT_KEY)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyFeishuSignature(headers(goodSig), body + 'x', ENCRYPT_KEY)).toBe(false);
  });

  it('rejects a tampered timestamp', () => {
    expect(verifyFeishuSignature(headers(goodSig, '9999999999'), body, ENCRYPT_KEY)).toBe(false);
  });

  it('rejects a tampered nonce', () => {
    expect(verifyFeishuSignature(headers(goodSig, ts, 'other-nonce'), body, ENCRYPT_KEY)).toBe(false);
  });

  it('rejects when any signing header is missing', () => {
    expect(
      verifyFeishuSignature({ 'x-lark-request-timestamp': ts, 'x-lark-request-nonce': nonce }, body, ENCRYPT_KEY),
    ).toBe(false);
  });

  it('rejects a signature of the wrong length (timing-safe path tolerates mismatched lengths)', () => {
    expect(verifyFeishuSignature(headers('deadbeef'), body, ENCRYPT_KEY)).toBe(false);
  });
});

describe('② AES-256-CBC decrypt round-trip (real crypto)', () => {
  it('decrypts an envelope produced with the matching key', () => {
    const payload = { type: 'event_callback', foo: 'bar', n: 7 };
    const encrypted = encryptEnvelope(ENCRYPT_KEY, payload);
    expect(decryptFeishuPayload(ENCRYPT_KEY, encrypted)).toEqual(payload);
  });

  it('extractEffectivePayload unwraps { encrypt } and passes through plaintext', () => {
    const payload = { type: 'url_verification', challenge: 'c1' };
    const wrapped = { encrypt: encryptEnvelope(ENCRYPT_KEY, payload) };
    expect(extractEffectivePayload(wrapped, ENCRYPT_KEY)).toEqual(payload);
    // Plaintext (no `encrypt`) is returned as-is.
    expect(extractEffectivePayload(payload, ENCRYPT_KEY)).toEqual(payload);
  });

  it('returns null on bad ciphertext or wrong key (never throws)', () => {
    expect(decryptFeishuPayload(ENCRYPT_KEY, 'not-base64!!')).toBeNull();
    const encrypted = encryptEnvelope(ENCRYPT_KEY, { a: 1 });
    expect(decryptFeishuPayload('a-different-wrong-key', encrypted)).toBeNull();
    expect(extractEffectivePayload({ encrypt: 'garbage' }, ENCRYPT_KEY)).toBeNull();
  });
});

describe('③ webhook handler dispatch (real handleWebhook end-to-end)', () => {
  async function setupAdapter(config = baseConfig()) {
    const adapter = createFeishuAdapter(config);
    const setup = makeSetup();
    await adapter.setup(setup);
    expect(capturedHandler).toBeTypeOf('function');
    expect(capturedPath).toBe(config.webhookPath);
    return { adapter, setup, handler: capturedHandler! };
  }

  it('echoes the challenge for an encrypted url_verification', async () => {
    const { handler } = await setupAdapter();
    const inner = { type: 'url_verification', challenge: 'challenge-123', token: VERIFICATION_TOKEN };
    const body = JSON.stringify({ encrypt: encryptEnvelope(ENCRYPT_KEY, inner) });
    const res = fakeRes();
    await handler(fakeReq({ body }) as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ challenge: 'challenge-123' });
  });

  it('rejects a non-POST with 405 and a non-JSON content-type with 415', async () => {
    const { handler } = await setupAdapter();
    const r1 = fakeRes();
    await handler(fakeReq({ body: '{}', method: 'GET' }) as never, r1 as never);
    expect(r1.statusCode).toBe(405);

    const r2 = fakeRes();
    await handler(fakeReq({ body: '{}', contentType: 'text/plain' }) as never, r2 as never);
    expect(r2.statusCode).toBe(415);
  });

  it('decrypts + verifies + dedupes a real message event and calls onInbound with correct args', async () => {
    const { setup, handler } = await setupAdapter();
    const inner = messageEvent({ messageId: 'om_a', text: 'hi there', chatId: 'oc_room', openId: 'ou_alice' });
    const body = JSON.stringify({ encrypt: encryptEnvelope(ENCRYPT_KEY, inner) });

    const res = fakeRes();
    await handler(fakeReq({ body }) as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(setup.inbound).toHaveLength(1);
    const got = setup.inbound[0];
    expect(got.platformId).toBe('feishu:oc_room'); // group chat → namespaced chat id
    const content = got.message.content as Record<string, unknown>;
    expect(content.text).toBe('hi there');
    expect(content.senderId).toBe('ou_alice');
    expect(got.message.isGroup).toBe(true);
    expect(got.message.id).toBe('om_a');
  });

  it('rejects an invalid signature with 401 and never calls onInbound', async () => {
    const { setup, handler } = await setupAdapter();
    const inner = messageEvent({ messageId: 'om_badsig' });
    const body = JSON.stringify({ encrypt: encryptEnvelope(ENCRYPT_KEY, inner) });

    const res = fakeRes();
    await handler(fakeReq({ body, signature: 'tampered-signature' }) as never, res as never);

    expect(res.statusCode).toBe(401);
    expect(setup.inbound).toHaveLength(0);
  });

  it('dedupes a repeated event_id — onInbound fires only once (real markInboundSeen)', async () => {
    const { setup, handler } = await setupAdapter();
    const inner = messageEvent({ messageId: 'om_dup', text: 'once please' });
    const body = JSON.stringify({ encrypt: encryptEnvelope(ENCRYPT_KEY, inner) });

    const r1 = fakeRes();
    await handler(fakeReq({ body }) as never, r1 as never);
    const r2 = fakeRes();
    await handler(fakeReq({ body }) as never, r2 as never);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200); // dedup is silent — still a 200 to Feishu
    expect(setup.inbound).toHaveLength(1);
  });

  it('rejects an event whose verification token does not match with 403', async () => {
    const { setup, handler } = await setupAdapter();
    const inner = {
      ...messageEvent({ messageId: 'om_badtoken' }),
      header: { event_type: 'im.message.receive_v1', token: 'WRONG-TOKEN' },
    };
    const body = JSON.stringify({ encrypt: encryptEnvelope(ENCRYPT_KEY, inner) });

    const res = fakeRes();
    await handler(fakeReq({ body }) as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(setup.inbound).toHaveLength(0);
  });

  it('returns 413 and destroys the request when the body exceeds maxBodyBytes', async () => {
    const { setup, handler } = await setupAdapter(baseConfig({ maxBodyBytes: 64 }));
    const huge = 'x'.repeat(500);
    const body = JSON.stringify({ encrypt: huge });

    const req = fakeReq({ body });
    const res = fakeRes();
    await handler(req as never, res as never);

    expect(res.statusCode).toBe(413);
    expect(req.destroyed).toBe(true);
    expect(setup.inbound).toHaveLength(0);
  });
});

describe('④ tenant access token — single-flight + expiry refresh', () => {
  /** Fake fetch that counts token requests and answers Feishu APIs minimally. */
  function installFakeFetch(expireSeconds = 7200): { tokenCalls: () => number } {
    let tokenCalls = 0;
    let issued = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/auth/v3/tenant_access_token/internal')) {
        tokenCalls += 1;
        issued += 1;
        return new Response(JSON.stringify({ code: 0, tenant_access_token: `tok-${issued}`, expire: expireSeconds }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Any message-send call: succeed with a message id.
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_out' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { tokenCalls: () => tokenCalls };
  }

  it('coalesces concurrent first-token fetches into a single refresh', async () => {
    const { tokenCalls } = installFakeFetch();
    const adapter = createFeishuAdapter(baseConfig());
    await adapter.setup(makeSetup());

    // Fire several concurrent deliveries on a cold token cache. Each deliver
    // needs the token; single-flight must collapse them to ONE token fetch.
    await Promise.all([
      adapter.deliver('feishu:p2p:ou_a', null, { kind: 'chat', content: { text: '1' } }),
      adapter.deliver('feishu:p2p:ou_a', null, { kind: 'chat', content: { text: '2' } }),
      adapter.deliver('feishu:p2p:ou_a', null, { kind: 'chat', content: { text: '3' } }),
    ]);

    expect(tokenCalls()).toBe(1);
  });

  it('refreshes again once the cached token has expired', async () => {
    // expire=60s → cache expiresAt = now + max(60, 60-60)*1000 = now + 60s, but
    // TOKEN_REFRESH_AHEAD_MS (5min) is subtracted at read time, so the very
    // next call already treats it as expired and refreshes.
    const { tokenCalls } = installFakeFetch(60);
    const adapter = createFeishuAdapter(baseConfig());
    await adapter.setup(makeSetup());

    await adapter.deliver('feishu:p2p:ou_a', null, { kind: 'chat', content: { text: '1' } });
    await adapter.deliver('feishu:p2p:ou_a', null, { kind: 'chat', content: { text: '2' } });

    // Two sequential sends, each preceded by a refresh because the short expiry
    // is always inside the proactive-refresh window.
    expect(tokenCalls()).toBe(2);
  });
});

describe('⑤ deliver branches route to the right Feishu API path + body shape', () => {
  interface Captured {
    url: string;
    method: string;
    body: unknown;
  }

  function installCapturingFetch(): { calls: Captured[] } {
    const calls: Captured[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/im/v1/images')) {
        calls.push({ url: u, method: init?.method ?? 'POST', body: '<<formdata>>' });
        return new Response(JSON.stringify({ code: 0, data: { image_key: 'img_key_1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      let parsedBody: unknown = undefined;
      if (typeof init?.body === 'string') {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }
      calls.push({ url: u, method: init?.method ?? 'POST', body: parsedBody });
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_out' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls };
  }

  async function setupAdapter() {
    const adapter = createFeishuAdapter(baseConfig());
    await adapter.setup(makeSetup());
    return adapter;
  }

  it('text → POST /im/v1/messages with msg_type=text and the text content', async () => {
    const { calls } = installCapturingFetch();
    const adapter = await setupAdapter();
    await adapter.deliver('feishu:p2p:ou_x', null, { kind: 'chat', content: { text: 'plain hi' } });

    const send = calls.find((c) => c.url.includes('/im/v1/messages'));
    expect(send).toBeDefined();
    expect(send!.url).toContain('receive_id_type=open_id');
    const body = send!.body as Record<string, unknown>;
    expect(body.msg_type).toBe('text');
    expect(body.receive_id).toBe('ou_x');
    expect(JSON.parse(body.content as string)).toEqual({ text: 'plain hi' });
  });

  it('card (type=card) → POST /im/v1/messages with msg_type=interactive', async () => {
    const { calls } = installCapturingFetch();
    const adapter = await setupAdapter();
    await adapter.deliver('feishu:p2p:ou_x', null, {
      kind: 'chat',
      content: { type: 'card', card: { title: 'T', description: 'D' } },
    });

    const send = calls.find((c) => c.url.includes('/im/v1/messages'));
    expect(send).toBeDefined();
    const body = send!.body as Record<string, unknown>;
    expect(body.msg_type).toBe('interactive');
    // The card content is a JSON string of a schema-2.0 card.
    const card = JSON.parse(body.content as string) as Record<string, unknown>;
    expect(card.schema).toBe('2.0');
  });

  it('image attachment → upload via /im/v1/images then send msg_type=image with the image_key', async () => {
    const { calls } = installCapturingFetch();
    const adapter = await setupAdapter();
    await adapter.deliver('feishu:p2p:ou_x', null, {
      kind: 'chat',
      content: { text: '' },
      files: [{ filename: 'pic.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }],
    });

    const upload = calls.find((c) => c.url.includes('/im/v1/images'));
    expect(upload).toBeDefined();

    const send = calls.find((c) => c.url.includes('/im/v1/messages'));
    expect(send).toBeDefined();
    const body = send!.body as Record<string, unknown>;
    expect(body.msg_type).toBe('image');
    expect(JSON.parse(body.content as string)).toEqual({ image_key: 'img_key_1' });
  });

  it('threaded text → POST /im/v1/messages/<thread>/reply with reply_in_thread', async () => {
    const { calls } = installCapturingFetch();
    const adapter = await setupAdapter();
    await adapter.deliver('feishu:oc_room', 'om_root_msg', { kind: 'chat', content: { text: 'in thread' } });

    const reply = calls.find((c) => c.url.includes('/reply'));
    expect(reply).toBeDefined();
    expect(reply!.url).toContain(encodeURIComponent('om_root_msg'));
    const body = reply!.body as Record<string, unknown>;
    expect(body.msg_type).toBe('text');
    expect(body.reply_in_thread).toBe(true);
  });

  it('respects FEISHU_REQUEST_TIMEOUT_MS — a hung fetch aborts and surfaces as a rejection', async () => {
    // A fetch that honors the AbortSignal: reject with an AbortError when the
    // adapter's request-timeout controller fires. Proves the timeout wiring is
    // live (config.requestTimeoutMs → AbortController → fetch signal).
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/auth/v3/tenant_access_token/internal')) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ code: 0, data: { message_id: 'om_out' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createFeishuAdapter(baseConfig({ requestTimeoutMs: 20 }));
    await adapter.setup(makeSetup());

    await expect(
      adapter.deliver('feishu:p2p:ou_x', null, { kind: 'chat', content: { text: 'will time out' } }),
    ).rejects.toThrow();
  });
});
