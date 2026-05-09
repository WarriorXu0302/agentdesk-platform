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

import { readEnvFile } from './env.js';
import { log } from './log.js';

const DEFAULT_PORT = 3000;

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

/** Convert Node.js IncomingMessage to a Web API Request. */
async function toWebRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
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

function ensureServer(): void {
  if (server) return;

  const dotenv = readEnvFile(['WEBHOOK_PORT']);
  const port = parseInt(process.env.WEBHOOK_PORT || dotenv.WEBHOOK_PORT || String(DEFAULT_PORT), 10);

  server = http.createServer(async (req, res) => {
    const host = req.headers.host || 'localhost';
    const pathname = new URL(req.url || '/', `http://${host}`).pathname;
    const route = routes.get(pathname);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    try {
      if (route.kind === 'raw') {
        await route.handler(req, res);
        return;
      }

      const webReq = await toWebRequest(req);
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
      log.error('Webhook handler error', { path: pathname, url: req.url, err });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      if (!res.writableEnded) {
        res.end('Internal Server Error');
      }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log.info('Webhook server started', { port, adapters: [...routes.keys()] });
  });
}

/** Shut down the webhook server. */
export async function stopWebhookServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    routes.clear();
    log.info('Webhook server stopped');
  }
}
