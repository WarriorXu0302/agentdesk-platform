/**
 * Process-hardening tests for the shared ingress server (ADR-0020).
 *
 * Covers the four behaviors added on top of the bare router:
 *   - request body ceiling → 413 + webhook_rejected_total{body_too_large}
 *   - GET /healthz → 200 liveness
 *   - GET /readyz → 200 when deps reachable, 503 + reason when not
 *   - GET /metrics optional bearer auth (two states)
 *
 * Each test spins the real http listener on a unique high port and tears it
 * down after, since the module holds the server + route table at module scope.
 */
import http from 'http';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';

import { EventEmitter } from 'node:events';

// Deterministic container-runtime probe for /readyz. probeContainerRuntime now
// uses async spawn(runtime, ['info']); stub it with a controllable fake child
// that emits exit/error on the next microtask. Default: reachable (exit 0).
const runtimeProbe: { exitCode: number | null; error: Error | null } = { exitCode: 0, error: null };
function setRuntimeReachable() {
  runtimeProbe.exitCode = 0;
  runtimeProbe.error = null;
}
function setRuntimeUnreachable() {
  runtimeProbe.exitCode = 1;
  runtimeProbe.error = new Error('cannot connect to docker daemon');
}

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
}));

vi.mock('child_process', () => ({
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = () => {};
    queueMicrotask(() => {
      if (runtimeProbe.error) child.emit('error', runtimeProbe.error);
      else child.emit('exit', runtimeProbe.exitCode);
    });
    return child;
  },
}));

import { initTestDb, closeDb, runMigrations } from './db/index.js';
import {
  registerWebhookHandler,
  registerWebhookAdapter,
  stopWebhookServer,
  ensureMetricsServer,
  HEALTHZ_PATH,
  READYZ_PATH,
  METRICS_PATH,
  resetRuntimeProbeCache,
} from './webhook-server.js';

/**
 * Minimal stand-in for a Chat instance: registerWebhookAdapter only touches
 * `chat.webhooks[name]`, invoked AFTER toWebRequest has buffered the body. For
 * the streaming-limit test the body never reaches it.
 */
function fakeChat(name: string): import('chat').Chat {
  const webhooks: Record<string, (r: Request) => Promise<Response>> = {
    [name]: async (r: Request) => new Response(await r.text(), { status: 200 }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { webhooks } as any;
}

let PORT = 39000 + Math.floor(Math.random() * 1000);

interface Res {
  status: number;
  body: string;
}

function request(opts: {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: opts.path, method: opts.method || 'GET', headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

beforeAll(() => {
  const db = initTestDb();
  runMigrations(db);
});

beforeEach(() => {
  PORT += 1; // fresh port per test so a slow TIME_WAIT socket can't collide
  setRuntimeReachable();
  resetRuntimeProbeCache(); // probe result is cached 5s — clear between cases
  delete process.env.METRICS_AUTH_TOKEN;
  delete process.env.WEBHOOK_MAX_BODY_BYTES;
  process.env.WEBHOOK_PORT = String(PORT);
});

afterEach(async () => {
  await stopWebhookServer();
  delete process.env.METRICS_AUTH_TOKEN;
  delete process.env.WEBHOOK_MAX_BODY_BYTES;
  delete process.env.WEBHOOK_PORT;
});

describe('ingress body ceiling', () => {
  it('rejects an oversized declared Content-Length before the handler reads (413)', async () => {
    process.env.WEBHOOK_MAX_BODY_BYTES = '100';
    let handlerCalled = false;
    registerWebhookHandler('/raw', async (_req, res) => {
      handlerCalled = true;
      res.writeHead(200);
      res.end('ok');
    });

    const big = 'x'.repeat(500);
    const res = await request({
      method: 'POST',
      path: '/raw',
      headers: { 'content-length': String(big.length) },
      body: big,
    });

    expect(res.status).toBe(413);
    // Pre-check fires before the handler reads the stream.
    expect(handlerCalled).toBe(false);
  });

  it('rejects an oversized chunked body mid-stream on the chat path (413)', async () => {
    // No Content-Length → chunked transfer → the dispatch pre-check can't
    // fire, so toWebRequest's streaming guard must catch it. The chat
    // webhook handler must never see the request.
    process.env.WEBHOOK_MAX_BODY_BYTES = '100';
    let handlerSaw = false;
    const chat = fakeChat('test');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chat.webhooks as any).test = async (r: Request) => {
      handlerSaw = true;
      return new Response(await r.text(), { status: 200 });
    };
    registerWebhookAdapter(chat, 'test');

    const big = 'x'.repeat(500);
    // Force chunked by NOT sending Content-Length (request helper omits it
    // unless passed in headers).
    const res = await request({ method: 'POST', path: '/webhook/test', body: big });

    expect(res.status).toBe(413);
    expect(handlerSaw).toBe(false);
  });

  it('lets an in-limit body through to the handler', async () => {
    process.env.WEBHOOK_MAX_BODY_BYTES = '1000';
    registerWebhookHandler('/raw', async (_req, res) => {
      res.writeHead(200);
      res.end('handled');
    });

    const res = await request({ method: 'POST', path: '/raw', body: 'small' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('handled');
  });
});

describe('health probes', () => {
  it('GET /healthz is always 200 ok', async () => {
    ensureMetricsServer();
    const res = await request({ path: HEALTHZ_PATH });
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('GET /readyz returns 200 when DB and runtime are reachable', async () => {
    setRuntimeReachable();
    resetRuntimeProbeCache();
    ensureMetricsServer();
    const res = await request({ path: READYZ_PATH });
    expect(res.status).toBe(200);
    expect(res.body).toContain('ready');
  });

  it('GET /readyz returns 503 with a reason when the container runtime is unreachable', async () => {
    setRuntimeUnreachable();
    resetRuntimeProbeCache();
    ensureMetricsServer();
    const res = await request({ path: READYZ_PATH });
    expect(res.status).toBe(503);
    expect(res.body).toContain('not ready');
    expect(res.body).toContain('container_runtime_unreachable');
  });
});

describe('/metrics bearer auth', () => {
  it('serves metrics without auth when METRICS_AUTH_TOKEN is unset (back-compat)', async () => {
    ensureMetricsServer();
    const res = await request({ path: METRICS_PATH });
    expect(res.status).toBe(200);
  });

  it('rejects /metrics without a matching bearer token when the token is set', async () => {
    process.env.METRICS_AUTH_TOKEN = 'secret-token';
    ensureMetricsServer();

    const noAuth = await request({ path: METRICS_PATH });
    expect(noAuth.status).toBe(401);

    const wrong = await request({ path: METRICS_PATH, headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);

    const ok = await request({ path: METRICS_PATH, headers: { authorization: 'Bearer secret-token' } });
    expect(ok.status).toBe(200);
  });

  it('does not require auth on /healthz or /readyz even when a token is set', async () => {
    process.env.METRICS_AUTH_TOKEN = 'secret-token';
    setRuntimeReachable();
    resetRuntimeProbeCache();
    ensureMetricsServer();

    expect((await request({ path: HEALTHZ_PATH })).status).toBe(200);
    expect((await request({ path: READYZ_PATH })).status).toBe(200);
  });
});

afterAll(() => {
  closeDb();
});
