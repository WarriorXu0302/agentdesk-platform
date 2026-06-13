#!/usr/bin/env node
/**
 * Reference backend gateway — a minimal, runnable implementation of the
 * AgentDesk backend gateway contract.
 *
 * This is the executable companion to docs/enterprise-erp-gateway.md and the
 * single source of truth at
 * container/agent-runner/src/mcp-tools/gateway-contract.ts. It implements all
 * six endpoints with shapes that pass the conformance runner
 * (container/agent-runner/scripts/gateway-conformance.ts):
 *
 *   POST /describe        -> { ok, backend, operations: [...] }
 *   POST /authorize       -> { allowed, reason?, obligations? }
 *   POST /execute         -> { ok, result | preview, auditId }
 *   POST /memory/get      -> { ok, value, source? }
 *   POST /memory/upsert   -> { ok, value, source }
 *   POST /memory/search   -> { ok, results: [{ value, source, score }] }
 *
 * Design goals (deliberately NOT production):
 *   - Zero dependencies. Node built-ins only (node:http, node:crypto).
 *     Runs with plain `node server.mjs` — no install, no build step.
 *   - In-memory storage. All memory lives in a Map and is lost on restart.
 *   - Keyword search. /memory/search does a naive substring/term match over
 *     stored JSON and attaches a `source` provenance block + a `score`.
 *   - Optional HMAC verification (off by default). Set GATEWAY_SIGNING_KEY to
 *     require + verify the same `<timestamp>.<nonce>.<body>` signature the
 *     runtime emits, using the brand-namespaced headers.
 *
 * It is intentionally permissive about *business* authorization so an operator
 * can see the whole flow run green; the inline comments mark exactly where a
 * real backend would plug in identity mapping, permission checks, idempotency,
 * and durable storage. Treat this as a structural template, not a drop-in.
 *
 * Usage:
 *   node examples/reference-gateway/server.mjs              # listens on :8088
 *   PORT=9090 node examples/reference-gateway/server.mjs    # custom port
 *   GATEWAY_SIGNING_KEY=secret node .../server.mjs          # require HMAC
 *
 * Then point a group at it and run the conformance runner — see the README.
 */
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number.parseInt(process.env.PORT || '8088', 10);

/**
 * The brand namespace controls the signing-header prefix. It defaults to
 * `agentdesk`; if an operator overrides BRAND_NAMESPACE on the platform side,
 * set the same value here so the header names line up.
 */
const NS = (process.env.BRAND_NAMESPACE || 'agentdesk')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/^-+|-+$/g, '') || 'agentdesk';
const HDR_TIMESTAMP = `x-${NS}-timestamp`;
const HDR_NONCE = `x-${NS}-nonce`;
const HDR_SIGNATURE = `x-${NS}-signature`;

/** When set, every request must carry a valid HMAC signature. */
const SIGNING_KEY = process.env.GATEWAY_SIGNING_KEY?.trim() || null;

/** Wire-contract version the platform stamps; we echo it back. */
const CONTRACT_VERSION = 1;

/**
 * In-memory durable store. Real backends use a database.
 * key = `${namespace}::${subject.type}::${subject.id}` -> { value, source }
 */
const memory = new Map();

function memKey(namespace, subject) {
  return `${namespace}::${subject?.type ?? ''}::${subject?.id ?? ''}`;
}

/**
 * The operation catalog this reference backend "supports". A real /describe
 * would reflect what the fronted system can actually do, with required fields
 * and approval hints per operation.
 */
const OPERATIONS = [
  {
    // The conformance runner probes /authorize and /execute with this exact
    // operation name. Exposing it as a safe, non-mutating no-op lets a
    // freshly-stood-up backend pass conformance without inventing business
    // operations first. A real backend keeps this entry (or any other safe
    // read) so `bun scripts/gateway-conformance.ts` stays green.
    name: 'conformance.noop',
    description: 'No-op probe used by the conformance runner. Safe, read-only.',
    requiredFields: [],
    mutating: false,
  },
  {
    name: 'demo.echo',
    description: 'Echo the input back. Safe, read-only, no side effects.',
    requiredFields: [],
    mutating: false,
  },
  {
    name: 'demo.order.create',
    description: 'Pretend to create an order. Mutating — requires confirmation.',
    requiredFields: ['sku', 'quantity'],
    mutating: true,
    approval: 'required',
  },
];
const OPERATION_NAMES = new Set(OPERATIONS.map((o) => o.name));

// --- HMAC verification ------------------------------------------------------

/**
 * Verify the request signature exactly as the runtime produces it:
 * HMAC-SHA256 over `<timestamp>.<nonce>.<rawBody>`. Returns null on success or
 * a {status, body} error to send back.
 *
 * A production gateway should additionally enforce a clock-skew window and a
 * replay/nonce cache (see docs/enterprise-erp-gateway.md "HMAC request
 * signing"); this reference keeps only the core signature check.
 */
function verifySignature(headers, rawBody) {
  if (!SIGNING_KEY) return null; // signing disabled — accept unsigned
  const ts = headers[HDR_TIMESTAMP];
  const nonce = headers[HDR_NONCE];
  const sig = headers[HDR_SIGNATURE];
  if (!ts || !nonce || !sig) {
    return { status: 401, body: { code: 'BACKEND_UNAUTHORIZED', message: 'missing signing headers' } };
  }
  const expected = crypto.createHmac('sha256', SIGNING_KEY).update(`${ts}.${nonce}.${rawBody}`).digest('hex');
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { status: 401, body: { code: 'BACKEND_UNAUTHORIZED', message: 'bad signature' } };
  }
  return null;
}

// --- endpoint handlers ------------------------------------------------------

/**
 * Decide how much to trust the requester block. The platform tells us via
 * `requesterSource`: 'session' is host-derived and authoritative;
 * 'agent-asserted' means no trusted identity was available, so a real backend
 * should reject writes. This reference only *demonstrates* the gate.
 */
function isTrusted(req) {
  return req?.requesterSource === 'session';
}

function provenance(namespace, subject, req, recordId) {
  return {
    namespace,
    subjectType: subject?.type,
    subjectId: subject?.id,
    recordId,
    updatedAt: new Date().toISOString(),
    // Backend-asserted metadata, NOT a verified identity (see ADR-0033).
    writtenBy: req?.requester?.userId ?? null,
  };
}

const handlers = {
  '/describe': () => ({
    ok: true,
    backend: { id: 'reference-gateway', version: '1.0.0' },
    operations: OPERATIONS,
  }),

  '/authorize': (req) => {
    const op = String(req.operation || '');
    if (!OPERATION_NAMES.has(op)) {
      return { allowed: false, reason: `unknown operation: ${op}` };
    }
    const def = OPERATIONS.find((o) => o.name === op);
    // A mutating op from an untrusted (agent-asserted) caller is denied — this
    // is exactly where a real backend runs its permission/approval policy.
    if (def.mutating && !isTrusted(req)) {
      return { allowed: false, reason: 'mutating operation requires a session-trusted requester' };
    }
    return {
      allowed: true,
      obligations: def.approval === 'required' ? ['user-confirmation'] : [],
    };
  },

  '/execute': (req) => {
    const op = String(req.operation || '');
    if (!OPERATION_NAMES.has(op)) {
      // Surface a structured, classifiable error (maps to OPERATION_NOT_FOUND).
      return { status: 404, body: { code: 'OPERATION_NOT_FOUND', message: `unknown operation: ${op}` } };
    }
    const def = OPERATIONS.find((o) => o.name === op);
    if (def.mutating && !isTrusted(req)) {
      return { status: 403, body: { code: 'BACKEND_UNAUTHORIZED', message: 'untrusted requester may not mutate' } };
    }
    const auditId = crypto.randomUUID();
    if (req.dryRun) {
      // dryRun touches no committed state; return a preview, not a result.
      return { ok: true, preview: { operation: op, input: req.input ?? {} }, auditId };
    }
    // A real backend would dedupe on req.idempotencyKey before committing.
    return { ok: true, result: { operation: op, input: req.input ?? {}, committed: true }, auditId };
  },

  '/memory/get': (req) => {
    const key = memKey(req.namespace, req.subject);
    const rec = memory.get(key);
    if (!rec) return { ok: true, value: null };
    return { ok: true, value: rec.value, source: rec.source };
  },

  '/memory/upsert': (req) => {
    const key = memKey(req.namespace, req.subject);
    const recordId = crypto.randomUUID();
    const existing = memory.get(key);
    const value = req.merge && existing && isObject(existing.value) && isObject(req.value)
      ? { ...existing.value, ...req.value }
      : req.value;
    const source = provenance(req.namespace, req.subject, req, recordId);
    memory.set(key, { value, source });
    return { ok: true, value, source };
  },

  '/memory/search': (req) => {
    const query = String(req.query || '').toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    const limit = Number.isInteger(req.limit) && req.limit > 0 ? req.limit : 10;
    const wantSubjectId = req.subject?.id;
    const results = [];
    for (const [key, rec] of memory.entries()) {
      // Scope to namespace + subject so one user's recall can't reach another's.
      if (req.namespace && !key.startsWith(`${req.namespace}::`)) continue;
      if (wantSubjectId && rec.source?.subjectId && rec.source.subjectId !== wantSubjectId) continue;
      const haystack = JSON.stringify(rec.value).toLowerCase();
      // Naive keyword score: fraction of query terms found. A real backend
      // would use full-text / vector retrieval here.
      const hits = terms.filter((t) => haystack.includes(t)).length;
      const score = terms.length === 0 ? 0 : hits / terms.length;
      if (score > 0) results.push({ value: rec.value, source: rec.source, score });
    }
    results.sort((a, b) => b.score - a.score);
    return { ok: true, results: results.slice(0, limit) };
  },
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// --- HTTP plumbing ----------------------------------------------------------

function send(res, status, body) {
  const payload = JSON.stringify({ contractVersion: CONTRACT_VERSION, ...body });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function sendError(res, status, body) {
  // Structured error body the platform can classify onto the closed enum.
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    return sendError(res, 405, { code: 'VALIDATION_FAILED', message: 'use POST' });
  }
  const path = (req.url || '').split('?')[0];
  const handler = handlers[path];
  if (!handler) {
    return sendError(res, 404, { code: 'OPERATION_NOT_FOUND', message: `no such endpoint: ${path}` });
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');

    const sigError = verifySignature(req.headers, rawBody);
    if (sigError) return sendError(res, sigError.status, sigError.body);

    let parsed;
    try {
      parsed = rawBody.length === 0 ? {} : JSON.parse(rawBody);
    } catch {
      return sendError(res, 400, { code: 'VALIDATION_FAILED', message: 'body is not valid JSON' });
    }

    let result;
    try {
      result = handler(parsed);
    } catch (err) {
      return sendError(res, 500, {
        code: 'BACKEND_UNAVAILABLE',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // A handler may return { status, body } to signal a non-2xx structured error.
    if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
      return sendError(res, result.status, result.body);
    }
    return send(res, 200, result);
  });
});

server.listen(PORT, () => {
  console.error(`reference-gateway listening on http://localhost:${PORT}`);
  console.error(`  signing: ${SIGNING_KEY ? `required (headers x-${NS}-*)` : 'disabled (set GATEWAY_SIGNING_KEY to require)'}`);
  console.error(`  endpoints: /describe /authorize /execute /memory/get /memory/upsert /memory/search`);
});
