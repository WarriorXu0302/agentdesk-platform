#!/usr/bin/env node
/**
 * Reference backend gateway — a minimal, runnable implementation of the
 * AgentDesk backend gateway contract.
 *
 * This is the executable companion to docs/enterprise-erp-gateway.md and the
 * single source of truth at
 * container/agent-runner/src/mcp-tools/gateway-contract.ts. It implements all
 * nine endpoints with shapes that pass the conformance runner
 * (container/agent-runner/scripts/gateway-conformance.ts):
 *
 *   POST /describe        -> { ok, backend, operations: [...] }
 *   POST /authorize       -> { allowed, reason?, obligations? }
 *   POST /execute         -> { ok, result | preview, auditId }
 *   POST /bulk_execute    -> { ok, results: [...], partial? }   (ADR-0036)
 *   POST /task/status     -> { ok, status, result | error, progress? } (ADR-0037)
 *   POST /memory/get      -> { ok, value, source? }
 *   POST /memory/upsert   -> { ok, value, source }
 *   POST /memory/search   -> { ok, results: [{ value, source, score }] }
 *   POST /memory/feedback -> { ok, accepted, feedbackId }       (ADR-0043)
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
 * Knowledge-feedback corpus (ADR-0043). The BACKEND owns it — the platform only
 * forwards "this record is inaccurate/stale/…" reports here, recording-only,
 * never mutating the memory record. key = namespace::subjectId::recordId ->
 * feedback[]. A real backend would surface high-feedback records to an operator
 * curation UI. There is intentionally no idempotency key (mirrors /memory/upsert).
 */
const feedback = new Map();

/**
 * Per-subject business records, to give /execute a realistic read+write pair
 * (`todo.list` / `todo.create`) instead of only echo/no-op operations.
 * key = subject.id -> item[]. A real backend reads/writes its own tables here.
 */
const todos = new Map();
function todosFor(subject) {
  const id = subject?.id ?? '';
  if (!todos.has(id)) todos.set(id, []);
  return todos.get(id);
}

/**
 * Idempotency cache: idempotencyKey -> the committed /execute response.
 * The platform stamps a stable `idempotencyKey` on every mutating execute and
 * retries with backoff on transient failure (ADR-0016). Replaying the cached
 * result instead of committing twice is what makes those retries safe. A real
 * backend persists this alongside the write (same transaction) rather than in a
 * process-local Map. See docs/gateway-kickstart.md "Idempotency replay".
 */
const idempotency = new Map();

/**
 * Async task store (ADR-0037). taskId -> { status, result?, error?, auditId }.
 * `asyncByKey` maps an idempotencyKey to its taskId so a resubmitted async
 * request returns the SAME task instead of starting a second one. A real backend
 * runs the work on a queue/worker; this reference completes it inline so the
 * demo's /task/status returns `succeeded` immediately.
 */
const tasks = new Map();
const asyncByKey = new Map();

/** Dispatch a committed operation to its business handler. */
function runOperation(op, req) {
  const input = req.input ?? {};
  if (op === 'todo.list') {
    return { operation: op, todos: todosFor(req.subject).slice() };
  }
  if (op === 'todo.create') {
    const item = { id: crypto.randomUUID(), title: input.title, due: input.due ?? null, done: false };
    todosFor(req.subject).push(item);
    return { operation: op, created: item };
  }
  // demo.* / conformance.noop: echo the input back, no real side effects.
  return { operation: op, input, committed: true };
}

/**
 * Run ONE operation for /bulk_execute (ADR-0036). Returns a per-op result item —
 * `{ ok:true, result|preview, auditId }` on success, or `{ ok:false, error }` on
 * failure — instead of an HTTP status, since a batch aggregates many outcomes.
 * Honors per-op idempotency replay exactly like single /execute.
 */
function runSingleForBulk(entry, req, dryRun) {
  const op = String(entry?.operation || '');
  if (!OPERATION_NAMES.has(op)) {
    return { ok: false, error: { code: 'OPERATION_NOT_FOUND', message: `unknown operation: ${op}` } };
  }
  const def = OPERATIONS.find((o) => o.name === op);
  if (def.mutating && !isTrusted(req)) {
    return { ok: false, error: { code: 'BACKEND_UNAUTHORIZED', message: 'untrusted requester may not mutate' } };
  }
  const key = entry?.idempotencyKey;
  if (def.mutating && !dryRun && key && idempotency.has(key)) {
    return { ...idempotency.get(key), replayed: true };
  }
  const auditId = crypto.randomUUID();
  if (dryRun) {
    return { ok: true, preview: { operation: op, input: entry?.input ?? {} }, auditId };
  }
  // Per-op input overrides the batch envelope; subject (if any) comes from the batch.
  const item = { ok: true, result: runOperation(op, { ...req, operation: op, input: entry?.input ?? {} }), auditId };
  if (def.mutating && key) idempotency.set(key, item);
  return item;
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
    // Optional per-field schema (roadmap 3.3): the agent reads this for the
    // exact input shape instead of hard-coding field knowledge in its prompt.
    schema: {
      properties: {
        sku: { type: 'string', required: true, description: 'Catalog SKU.' },
        quantity: { type: 'number', required: true, description: 'Units to order (>0).' },
        note: { type: 'string', required: false, description: 'Optional order note.' },
      },
    },
  },
  {
    // A realistic read+write pair so an operator sees a "shaped" operation, not
    // just echo/no-op. Backed by the per-subject `todos` store above.
    name: 'todo.list',
    description: "List the requester's todo items. Safe, read-only.",
    requiredFields: [],
    mutating: false,
  },
  {
    name: 'todo.create',
    description: 'Create a todo item for the requester. Mutating; no approval required (low-risk write).',
    requiredFields: ['title'],
    mutating: true,
    schema: {
      properties: {
        title: { type: 'string', required: true, description: 'Short todo title.' },
        due: { type: 'string', required: false, description: 'Optional ISO-8601 due date.' },
      },
    },
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
    // Optional namespace catalog (roadmap 4.3/4.2): lets the agent DISCOVER
    // memory namespaces instead of hard-coding them, and learn each one's
    // freshness policy. `freshnessWindowMs` is advisory — the agent re-fetches
    // or flags a record whose `source.updatedAt` is older than this.
    namespaces: [
      {
        name: 'user.preferences',
        description: 'Per-user durable preferences and settings.',
        scope: 'user',
        writeable: true,
        freshnessWindowMs: 1000 * 60 * 60 * 24 * 30, // 30 days
      },
      {
        name: 'org.directory',
        description: 'Org structure / people lookup (changes often).',
        scope: 'org',
        writeable: false,
        freshnessWindowMs: 1000 * 60 * 60 * 12, // 12 hours
      },
    ],
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

    // Async submission (ADR-0037): accept now, return a taskId; the agent polls
    // /task/status. dryRun takes precedence (you don't async a preview). A real
    // backend enqueues the work; this reference runs it inline and marks the
    // task succeeded so the demo poll returns a result. Idempotent by key.
    if (req.submitAsync === true && !req.dryRun) {
      if (req.idempotencyKey && asyncByKey.has(req.idempotencyKey)) {
        return { ok: true, taskId: asyncByKey.get(req.idempotencyKey), status: 'accepted' };
      }
      const taskId = `task-${crypto.randomUUID()}`;
      const auditId = crypto.randomUUID();
      tasks.set(taskId, { status: 'succeeded', result: runOperation(op, req), auditId });
      if (req.idempotencyKey) asyncByKey.set(req.idempotencyKey, taskId);
      return { ok: true, taskId, status: 'accepted', auditId };
    }

    // Idempotency replay (roadmap 1.4 recipe): a mutating execute carries a
    // stable idempotencyKey, and the host retries with backoff on transient
    // failure (ADR-0016). If we've already committed this key, replay the SAME
    // result rather than mutating twice. dryRun never commits, so it neither
    // consults nor fills the cache.
    if (def.mutating && !req.dryRun && req.idempotencyKey && idempotency.has(req.idempotencyKey)) {
      return { ...idempotency.get(req.idempotencyKey), replayed: true };
    }

    const auditId = crypto.randomUUID();
    if (req.dryRun) {
      // dryRun touches no committed state; return a preview, not a result.
      return { ok: true, preview: { operation: op, input: req.input ?? {} }, auditId };
    }

    const response = { ok: true, result: runOperation(op, req), auditId };
    if (def.mutating && req.idempotencyKey) idempotency.set(req.idempotencyKey, response);
    return response;
  },

  // Optional batch endpoint (ADR-0036). Runs N operations in one round-trip.
  '/bulk_execute': (req) => {
    const ops = Array.isArray(req.operations) ? req.operations : null;
    if (!ops || ops.length === 0) {
      return { status: 400, body: { code: 'VALIDATION_FAILED', message: 'operations must be a non-empty array' } };
    }
    const dryRun = req.dryRun === true;

    if (req.atomic === true) {
      // All-or-nothing. A real backend wraps the commits in ONE transaction; this
      // reference approximates by pre-validating every op (existence + trust) and
      // committing only if all pass — otherwise nothing commits.
      const problems = ops.map((o) => {
        const name = String(o?.operation || '');
        if (!OPERATION_NAMES.has(name)) return { code: 'OPERATION_NOT_FOUND', message: `unknown operation: ${name}` };
        const def = OPERATIONS.find((d) => d.name === name);
        if (def.mutating && !isTrusted(req)) {
          return { code: 'BACKEND_UNAUTHORIZED', message: 'untrusted requester may not mutate' };
        }
        return null;
      });
      const badIdx = problems.findIndex((p) => p !== null);
      if (badIdx !== -1) {
        // Nothing committed. partial stays false — atomic means all-or-nothing.
        return {
          ok: false,
          partial: false,
          results: problems.map((p, i) =>
            p ? { ok: false, error: p } : { ok: false, error: { code: 'UNKNOWN', message: 'aborted: atomic batch had a failing operation' } },
          ),
        };
      }
      return { ok: true, partial: false, results: ops.map((o) => runSingleForBulk(o, req, dryRun)) };
    }

    // Best-effort: each op runs independently; partial=true if any failed.
    const results = ops.map((o) => runSingleForBulk(o, req, dryRun));
    const anyFailed = results.some((r) => r.ok === false);
    return { ok: !anyFailed, partial: anyFailed, results };
  },

  // Optional async status poll (ADR-0037). Returns the task's terminal/interim
  // state. An unknown taskId is reported as a failed task (200), NOT an HTTP 404
  // — a 404 here would read as "endpoint not implemented".
  '/task/status': (req) => {
    const task = tasks.get(String(req.taskId || ''));
    if (!task) {
      return { ok: true, status: 'failed', error: { code: 'VALIDATION_FAILED', message: 'unknown taskId' } };
    }
    const out = { ok: true, status: task.status, auditId: task.auditId };
    if (task.status === 'succeeded') out.result = task.result;
    if (task.status === 'failed' && task.error) out.error = task.error;
    if (typeof task.progress === 'number') out.progress = task.progress;
    return out;
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

  // Knowledge feedback (ADR-0043). Recording-only: append the report to the
  // backend-owned corpus, NEVER mutate the memory record. A real backend MUST
  // first verify the requester's subject scope covers recordId (here we trust
  // the per-subject key) and would treat `note` as data, never instructions.
  '/memory/feedback': (req) => {
    const fbKey = `${req.namespace}::${req.subject?.id ?? ''}::${req.recordId}`;
    const list = feedback.get(fbKey) ?? [];
    const entry = {
      feedbackId: crypto.randomUUID(),
      issue: req.issue,
      note: typeof req.note === 'string' ? req.note : undefined,
      by: req.requester?.userId ?? null,
      requesterSource: req.requesterSource,
      at: new Date().toISOString(),
    };
    list.push(entry);
    feedback.set(fbKey, list);
    return { ok: true, accepted: true, feedbackId: entry.feedbackId };
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
  console.error(
    `  endpoints: /describe /authorize /execute /bulk_execute /task/status /memory/get /memory/upsert /memory/search /memory/feedback`,
  );
});
