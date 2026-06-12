/**
 * Minimal shared HTTP server for webhook-based adapters.
 *
 * Starts lazily on first adapter registration. Routes requests by exact path:
 *   /webhook/{adapterName} → chat.webhooks[adapterName](request)
 *   /custom/path         → raw native handler
 *
 * Multiple Chat instances and native adapters can share one listener.
 */
import http from 'http';

import type { Chat } from 'chat';

import { getDb } from './db/connection.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { spawn } from 'child_process';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import { handleMetricsRequest, webhookRejectedTotal } from './metrics.js';

const DEFAULT_PORT = 3000;

/** Ingress body ceiling. Bodies past this get a 413 instead of being buffered
 *  into host memory unbounded. Override with WEBHOOK_MAX_BODY_BYTES. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

/** Node socket timeouts. requestTimeout caps the whole request; headersTimeout
 *  caps the header phase (slowloris). Override with WEBHOOK_REQUEST_TIMEOUT_MS
 *  / WEBHOOK_HEADERS_TIMEOUT_MS. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;

/** Health/readiness endpoint paths. Exported so probes and tests reference one
 *  source of truth rather than re-typing the literal. These are matched before
 *  the route table (like /metrics) and never require auth — they are liveness
 *  and readiness checks for orchestrators (k8s, compose healthcheck). */
export const HEALTHZ_PATH = '/healthz';
export const READYZ_PATH = '/readyz';
export const METRICS_PATH = '/metrics';

/** Body too large — raised inside toWebRequest, caught at dispatch → 413. */
class PayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeded ${limit} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

function resolveMaxBodyBytes(): number {
  const dotenv = readEnvFile(['WEBHOOK_MAX_BODY_BYTES']);
  const raw = process.env.WEBHOOK_MAX_BODY_BYTES || dotenv.WEBHOOK_MAX_BODY_BYTES;
  const parsed = parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BODY_BYTES;
}

interface WebhookEntry {
  chat: Chat;
  adapterName: string;
}

export type RawWebhookHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

type RouteEntry =
  | {
      kind: 'chat';
      entry: WebhookEntry;
    }
  | {
      kind: 'raw';
      handler: RawWebhookHandler;
    };

const routes = new Map<string, RouteEntry>();
let server: http.Server | null = null;

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error('webhook path cannot be empty');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Convert Node.js IncomingMessage to a Web API Request. Aborts with
 *  PayloadTooLargeError once the buffered body crosses maxBodyBytes so a
 *  hostile or runaway sender can't OOM the host by streaming an unbounded
 *  body (the old version buffered the whole request unconditionally). */
async function toWebRequest(req: http.IncomingMessage, maxBodyBytes: number): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBodyBytes) {
      throw new PayloadTooLargeError(maxBodyBytes);
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks);

  const host = req.headers.host || 'localhost';
  const url = `http://${host}${req.url}`;

  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (typeof val === 'string') headers[key] = val;
    else if (Array.isArray(val)) headers[key] = val.join(', ');
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method || 'GET',
    headers,
    body: hasBody ? body : undefined,
  });
}

/** Write a Web API Response back to a Node.js ServerResponse. */
async function fromWebResponse(webRes: Response, nodeRes: http.ServerResponse): Promise<void> {
  nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  if (webRes.body) {
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  nodeRes.end();
}

/**
 * Register a webhook adapter on the shared server.
 * Starts the server lazily on first call.
 */
export function registerWebhookAdapter(chat: Chat, adapterName: string): void {
  const path = `/webhook/${adapterName}`;
  routes.set(path, {
    kind: 'chat',
    entry: { chat, adapterName },
  });
  ensureServer();
  log.info('Webhook adapter registered', { adapter: adapterName, path });
}

/**
 * Register an exact-path webhook handler on the shared server.
 * Useful for native adapters that need raw request access for signature checks.
 */
export function registerWebhookHandler(path: string, handler: RawWebhookHandler): void {
  const normalized = normalizePath(path);
  routes.set(normalized, {
    kind: 'raw',
    handler,
  });
  ensureServer();
  log.info('Webhook handler registered', { path: normalized });
}

function reject413(res: http.ServerResponse): void {
  webhookRejectedTotal.labels('body_too_large').inc();
  if (!res.headersSent) {
    res.writeHead(413, { 'Content-Type': 'text/plain' });
  }
  if (!res.writableEnded) {
    res.end('Payload Too Large');
  }
}

function ensureServer(): void {
  if (server) return;

  const dotenv = readEnvFile(['WEBHOOK_PORT', 'WEBHOOK_REQUEST_TIMEOUT_MS', 'WEBHOOK_HEADERS_TIMEOUT_MS']);
  const port = parseInt(process.env.WEBHOOK_PORT || dotenv.WEBHOOK_PORT || String(DEFAULT_PORT), 10);
  const maxBodyBytes = resolveMaxBodyBytes();
  const requestTimeout = parsePositiveInt(
    process.env.WEBHOOK_REQUEST_TIMEOUT_MS || dotenv.WEBHOOK_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const headersTimeout = parsePositiveInt(
    process.env.WEBHOOK_HEADERS_TIMEOUT_MS || dotenv.WEBHOOK_HEADERS_TIMEOUT_MS,
    DEFAULT_HEADERS_TIMEOUT_MS,
  );

  server = http.createServer(async (req, res) => {
    const host = req.headers.host || 'localhost';
    const pathname = new URL(req.url || '/', `http://${host}`).pathname;

    // Health probes are handled before the route table and never require
    // auth — orchestrators must be able to reach them on the same port.
    if (pathname === HEALTHZ_PATH) {
      handleHealthz(res);
      return;
    }
    if (pathname === READYZ_PATH) {
      await handleReadyz(res);
      return;
    }
    if (pathname === METRICS_PATH) {
      await handleMetricsRequest(req, res);
      return;
    }

    const route = routes.get(pathname);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    // Cheap declared-size pre-check: reject an oversized Content-Length before
    // reading a single byte. Protects the raw-handler path too (those handlers
    // own the stream and may not all guard size themselves). Chunked bodies
    // with no Content-Length still hit the streaming guard in toWebRequest.
    const declaredLen = parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declaredLen) && declaredLen > maxBodyBytes) {
      reject413(res);
      req.resume(); // drain so the socket can be reused / closed cleanly
      return;
    }

    try {
      if (route.kind === 'raw') {
        await route.handler(req, res);
        return;
      }

      const webReq = await toWebRequest(req, maxBodyBytes);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const webhooks = route.entry.chat.webhooks as Record<string, (r: Request, opts?: any) => Promise<Response>>;
      const handler = webhooks[route.entry.adapterName];
      const webRes = await handler(webReq, {
        waitUntil: (p: Promise<unknown>) => {
          p.catch(() => {});
        },
      });
      await fromWebResponse(webRes, res);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        log.warn('Webhook body exceeded limit', { path: pathname, limit: maxBodyBytes });
        reject413(res);
        req.resume(); // drain any remaining body so the connection closes cleanly
        return;
      }
      log.error('Webhook handler error', { path: pathname, url: req.url, err });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      if (!res.writableEnded) {
        res.end('Internal Server Error');
      }
    }
  });

  // Cap the header and full-request phases so slow-loris style holds can't pin
  // a connection open indefinitely. Defaults: 10s headers / 30s request.
  server.headersTimeout = headersTimeout;
  server.requestTimeout = requestTimeout;

  server.listen(port, '0.0.0.0', () => {
    log.info('Webhook server started', { port, adapters: [...routes.keys()], maxBodyBytes });
  });
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Liveness: the process event loop is responsive. Always 200. */
function handleHealthz(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ok');
}

/**
 * Readiness: dependencies needed to serve traffic are reachable. Probes are
 * deliberately light and read-only, and must never throw out of here — any
 * failure is treated as not-ready (503) rather than crashing the probe path.
 *
 *   - central DB readable: a single `SELECT 1`.
 *   - container runtime reachable: `<runtime> info`, short timeout. Agents
 *     can't run without it, so a host that can't reach the runtime is not
 *     ready to accept work.
 */
async function handleReadyz(res: http.ServerResponse): Promise<void> {
  const reasons: string[] = [];

  try {
    getDb().prepare('SELECT 1').get();
  } catch {
    reasons.push('db_unreadable');
  }

  if (!(await probeContainerRuntime())) {
    reasons.push('container_runtime_unreachable');
  }

  if (reasons.length === 0) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ready');
    return;
  }
  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`not ready: ${reasons.join(',')}`);
}

/** Cache window for the runtime probe. readyz can be polled every few seconds;
 *  a hung runtime must not trigger a fresh subprocess + timeout wait each time. */
const RUNTIME_PROBE_CACHE_MS = 5_000;
const RUNTIME_PROBE_TIMEOUT_MS = 3_000;
let runtimeProbeCache: { ok: boolean; at: number } | null = null;

/** Test seam: clear the cached runtime-probe result between cases. */
export function resetRuntimeProbeCache(): void {
  runtimeProbeCache = null;
}

/**
 * Soft, async reachability probe for the container runtime. Returns false (not
 * ready) on any failure rather than throwing — readiness must not crash.
 *
 * Async (spawn, not execSync) so the probe never blocks the single host event
 * loop: a slow/hung runtime would otherwise freeze webhook delivery, /metrics,
 * and the delivery/sweep poll callbacks for the whole timeout. Results are
 * cached for RUNTIME_PROBE_CACHE_MS so frequent probes don't each pay a
 * subprocess. See ADR-0020.
 */
async function probeContainerRuntime(): Promise<boolean> {
  const now = Date.now();
  if (runtimeProbeCache && now - runtimeProbeCache.at < RUNTIME_PROBE_CACHE_MS) {
    return runtimeProbeCache.ok;
  }
  const ok = await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const child = spawn(CONTAINER_RUNTIME_BIN, ['info'], { stdio: 'ignore' });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(false);
      }, RUNTIME_PROBE_TIMEOUT_MS);
      timer.unref?.();
      child.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    } catch {
      done(false);
    }
  });
  runtimeProbeCache = { ok, at: Date.now() };
  return ok;
}

/**
 * Start the shared HTTP listener if no adapter has registered yet. Called by
 * the host at boot so /metrics is always reachable — otherwise adapters that
 * don't use webhooks (Feishu in long-connection mode, CLI-only setups) would
 * leave the server unbound and scraping would fail.
 */
export function ensureMetricsServer(): void {
  ensureServer();
}

/**
 * Shut down the webhook server. Stops accepting new connections, then releases
 * idle keep-alive connections immediately (otherwise `close()` waits on them up
 * to keepAliveTimeout). In-flight requests get a bounded grace window
 * (WEBHOOK_CLOSE_GRACE_MS, default 5s); past that, lingering connections are
 * force-closed so `close()` can resolve and shutdown can proceed to draining
 * deliveries instead of hanging on a stuck handler. See ADR-0020.
 */
export async function stopWebhookServer(): Promise<void> {
  if (!server) return;
  const srv = server;
  server = null;
  routes.clear();

  const graceMs = parsePositiveInt(
    process.env.WEBHOOK_CLOSE_GRACE_MS || readEnvFile(['WEBHOOK_CLOSE_GRACE_MS']).WEBHOOK_CLOSE_GRACE_MS,
    5_000,
  );

  srv.closeIdleConnections?.();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => srv.closeAllConnections?.(), graceMs);
    timer.unref?.();
    srv.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  log.info('Webhook server stopped');
}
