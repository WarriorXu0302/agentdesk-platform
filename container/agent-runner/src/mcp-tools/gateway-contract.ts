/**
 * Backend gateway contract — the single, machine-verifiable source of truth.
 *
 * This module hardens what used to be a prose-only agreement
 * (`docs/enterprise-erp-gateway.md`) into zod schemas the runner and the
 * conformance runner (`scripts/gateway-conformance.ts`) both consume. Keeping
 * the request envelopes, the response shapes, the closed error-code enum and
 * the HTTP-status classifier in one place means the platform and an operator's
 * backend describe the same wire contract from the same definitions.
 *
 * Compatibility stance (see ADR-0028):
 *   - What the platform EMITS is tightened freely: envelopes carry a
 *     `contractVersion`, write operations always carry an `idempotencyKey`,
 *     and the agent's tool inputs are whitelisted. These are platform-produced,
 *     so tightening them can never break an existing backend.
 *   - What the backend RETURNS is validated leniently. The prose contract
 *     always promised "you control the payload shape", so a response that
 *     doesn't match the schema is, by default, a warning — not a rejection.
 *     Strict rejection is opt-in via GATEWAY_STRICT_RESPONSES=true.
 *
 * This module MUST NOT touch the identity trust chain. `requester` /
 * `requesterSource` are resolved by `resolveRequester()` from host-written
 * inbound rows; the schemas here only describe their shape, they never widen
 * how the values are obtained.
 */
import { z } from 'zod';

/**
 * Wire contract version. Integer, starts at 1. Bump only on a
 * backward-incompatible change to the request envelope or the closed error
 * shape. The platform stamps every outbound request with this value; the
 * backend may echo it. A mismatch is, by default, a warning (the backend may
 * legitimately lag a platform upgrade) — never a hard reject.
 */
export const CONTRACT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Closed error-code enum
// ---------------------------------------------------------------------------

/**
 * Closed set of gateway error codes. A backend MAY return one of these in a
 * structured error body to get precise classification (and a `retryable`
 * signal the agent can act on); when it doesn't, `classifyHttpError` maps the
 * HTTP status onto the same enum so downstream consumers always see a code.
 */
export const GATEWAY_ERROR_CODES = [
  'BACKEND_UNAUTHORIZED',
  'OPERATION_NOT_FOUND',
  'VALIDATION_FAILED',
  'BACKEND_UNAVAILABLE',
  'TIMEOUT',
  'GATEWAY_NOT_CONFIGURED',
  'CONTRACT_VERSION_MISMATCH',
  'UNKNOWN',
] as const;

export const gatewayErrorCodeSchema = z.enum(GATEWAY_ERROR_CODES);
export type GatewayErrorCode = z.infer<typeof gatewayErrorCodeSchema>;

/**
 * Structured error shape a backend may return on a non-2xx response. All
 * fields beyond `code`/`message` are optional so a backend can adopt this
 * incrementally. `retryable` lets the agent decide whether to retry;
 * `retryAfterMs` is an optional backoff hint.
 */
export const gatewayErrorSchema = z.object({
  code: gatewayErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
});
export type GatewayError = z.infer<typeof gatewayErrorSchema>;

// ---------------------------------------------------------------------------
// Common request envelope
// ---------------------------------------------------------------------------

/**
 * Trusted requester identity. NOTE: the shape is described here, but the
 * values are resolved by the runtime from host-written inbound rows — never
 * from agent tool arguments. Do not read identity from this schema as if the
 * agent supplied it.
 */
export const requesterSchema = z.object({
  userId: z.string().optional(),
  channelType: z.string().optional(),
  platformId: z.string().optional(),
  // Explicit null ("no thread") is distinct from absent ("unknown").
  threadId: z.string().nullable().optional(),
});
export type Requester = z.infer<typeof requesterSchema>;

export const requesterSourceSchema = z.enum(['session', 'agent-asserted']);
export type RequesterSource = z.infer<typeof requesterSourceSchema>;

export const agentBlockSchema = z.object({
  agentGroupId: z.string().nullable(),
  groupName: z.string().nullable(),
  assistantName: z.string().nullable(),
});

/** Fields present on every request the platform emits. */
const envelopeBase = {
  contractVersion: z.number().int(),
  agent: agentBlockSchema,
  requester: requesterSchema,
  requesterSource: requesterSourceSchema,
};

// ---------------------------------------------------------------------------
// Per-operation request schemas
// ---------------------------------------------------------------------------

export const describeRequestSchema = z.object({
  ...envelopeBase,
});

export const authorizeRequestSchema = z.object({
  ...envelopeBase,
  operation: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  context: z.record(z.string(), z.unknown()),
});

export const executeRequestSchema = z.object({
  ...envelopeBase,
  operation: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  context: z.record(z.string(), z.unknown()),
  dryRun: z.boolean(),
  // Write operations always carry a key (auto-generated if the agent omits
  // one). May be null only on a dryRun, where there is no committed state.
  idempotencyKey: z.string().nullable(),
  // Optional async submission (ADR-0037). When true AND the backend supports it,
  // the backend returns `{ taskId, status:'accepted' }` immediately instead of
  // blocking; the agent then polls `/task/status`. A backend that doesn't
  // support async ignores this and runs synchronously (returns a `result`).
  submitAsync: z.boolean().optional(),
});

/**
 * One operation inside a `/bulk_execute` batch (ADR-0036). Each op carries its
 * OWN `idempotencyKey` — per-operation, not per-batch — so a retry after a
 * partial commit replays the committed ops and executes only the rest, never
 * double-writing. Null only on a dryRun.
 */
export const bulkExecuteOperationSchema = z.object({
  operation: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().nullable(),
});

/**
 * Optional batch endpoint (ADR-0036, roadmap 3.1). Lets the agent submit N
 * operations in one round-trip instead of N `/execute` calls. Optional: a
 * backend that doesn't implement it returns 404 (OPERATION_NOT_FOUND) and the
 * client falls back to per-op `/execute`. `atomic` REQUESTS all-or-nothing — the
 * backend must honor it in a single transaction or reject it; the platform has
 * no cross-op coordinator. Default (`atomic` absent/false) is best-effort.
 */
export const bulkExecuteRequestSchema = z.object({
  ...envelopeBase,
  operations: z.array(bulkExecuteOperationSchema).min(1),
  context: z.record(z.string(), z.unknown()),
  dryRun: z.boolean(),
  atomic: z.boolean().optional(),
});

/**
 * Optional async task-status poll (ADR-0037). After an async `/execute`
 * (`submitAsync:true`) returns a `taskId`, the agent polls this read endpoint
 * until the task reaches a terminal state. Optional: unimplemented → 404.
 */
export const taskStatusRequestSchema = z.object({
  ...envelopeBase,
  taskId: z.string().min(1),
  context: z.record(z.string(), z.unknown()),
});

const memorySubjectSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
});

export const memoryGetRequestSchema = z.object({
  ...envelopeBase,
  namespace: z.string().min(1),
  subject: memorySubjectSchema,
  query: z.record(z.string(), z.unknown()),
  context: z.record(z.string(), z.unknown()),
});

export const memoryUpsertRequestSchema = z.object({
  ...envelopeBase,
  namespace: z.string().min(1),
  subject: memorySubjectSchema,
  value: z.record(z.string(), z.unknown()),
  merge: z.boolean(),
  context: z.record(z.string(), z.unknown()),
});

/**
 * Memory search request (ADR-0033). The platform emits a free-text `query`
 * plus the same subject scoping as get/upsert. The backend owns the actual
 * retrieval (keyword, full-text, vector, …) — the platform deliberately keeps
 * NO host-side index/vector store, so search is just one more gateway call.
 */
export const memorySearchRequestSchema = z.object({
  ...envelopeBase,
  namespace: z.string().min(1),
  query: z.string().min(1),
  subject: memorySubjectSchema,
  limit: z.number().int().positive(),
  context: z.record(z.string(), z.unknown()),
});

/**
 * Knowledge feedback issue kinds (ADR-0043, roadmap 4.6). CLOSED enum — an
 * unknown value is a hard validation error (NOT coerced), so the agent can't
 * invent issue types and operators see schema drift (ADR-0028 discipline).
 */
export const memoryFeedbackIssueSchema = z.enum([
  'inaccurate',
  'stale',
  'irrelevant',
  'duplicate',
  'needs-correction',
  'other',
]);

/**
 * Knowledge feedback request (ADR-0043). The agent/operator reports a recalled
 * memory record as inaccurate/stale/etc. so the BACKEND — which owns the memory
 * corpus — can aggregate it for operator curation. Recording-only: the platform
 * never mutates a record or authz on feedback. `recordId` is the provenance id
 * from a prior get/search (`memorySourceSchema.recordId`); the backend MUST gate
 * on the requester's subject scope before acting. `note` is optional free text
 * the backend treats as data (never instructions) and is EXCLUDED from the audit
 * input_hash (see hashBody). Mirrors memory/upsert's shape (no idempotencyKey —
 * memory writes aren't idempotency-keyed in this contract). Deliberately NO
 * `correction` field: a correction goes through the normal `gateway_memory_upsert`
 * so it keeps that path's idempotency + subject-scoping, instead of an implicit
 * write smuggled through feedback.
 */
export const memoryFeedbackRequestSchema = z.object({
  ...envelopeBase,
  namespace: z.string().min(1),
  subject: memorySubjectSchema,
  recordId: z.string().min(1),
  issue: memoryFeedbackIssueSchema,
  note: z.string().max(2000).optional(),
  context: z.record(z.string(), z.unknown()),
});

/** Path → request schema. Single lookup the conformance runner reuses. */
export const REQUEST_SCHEMAS = {
  '/describe': describeRequestSchema,
  '/authorize': authorizeRequestSchema,
  '/execute': executeRequestSchema,
  '/bulk_execute': bulkExecuteRequestSchema,
  '/task/status': taskStatusRequestSchema,
  '/memory/get': memoryGetRequestSchema,
  '/memory/upsert': memoryUpsertRequestSchema,
  '/memory/search': memorySearchRequestSchema,
  '/memory/feedback': memoryFeedbackRequestSchema,
} as const;

export type GatewayPath = keyof typeof REQUEST_SCHEMAS;

// ---------------------------------------------------------------------------
// Response schemas (lenient: backend controls the payload)
// ---------------------------------------------------------------------------

/**
 * Lenient response shapes. The prose contract promised backends control their
 * payload, so these only assert the *recommended* discriminators
 * (`allowed` / `ok` / `operations`) and otherwise allow arbitrary extra
 * fields. A response that fails these is, by default, only a warning.
 *
 * `passthrough()` keeps backend-specific fields; the optional structured
 * `contractVersion` echo lets the platform detect drift.
 */
const responseEnvelope = {
  contractVersion: z.number().int().optional(),
  error: gatewayErrorSchema.optional(),
};

/**
 * Optional memory-namespace descriptor in a /describe response (roadmap 4.3/4.2).
 *
 * Lets a backend advertise which memory namespaces exist so the agent can
 * DISCOVER them (instead of hard-coding namespace knowledge in its prompt) and
 * adapt when an operator adds one. `freshnessWindowMs` (4.2) is an advisory TTL:
 * a recalled record older than this should be re-fetched or flagged as stale
 * rather than trusted blindly. All fields optional + passthrough → a backend
 * adopts this incrementally and one that omits `namespaces` stays conformant.
 */
export const memoryNamespaceSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    // Backend's own scope vocabulary (e.g. 'user' | 'team' | 'org'); the
    // platform never interprets it.
    scope: z.string().optional(),
    writeable: z.boolean().optional(),
    // Advisory freshness TTL in ms; compare against a record's `source.updatedAt`.
    freshnessWindowMs: z.number().int().positive().optional(),
  })
  .passthrough();

/**
 * Optional operation descriptor in a /describe response (roadmap 3.3).
 *
 * Lets a backend advertise an operation's input shape (`schema.properties`:
 * field types / required / enums) so the agent learns it at RUNTIME instead of
 * hard-coding field knowledge in its prompt — and stays in sync when the backend
 * adds/removes/renames a field. Fully lenient (every field optional + passthrough,
 * `schema` an open object) so it never tightens what a backend may return: a
 * backend that lists only `{ name }` per operation stays conformant.
 */
export const operationDescriptorSchema = z
  .object({
    name: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    mutating: z.boolean().optional(),
    approval: z.string().optional(),
    requiredFields: z.array(z.string()).optional(),
    // e.g. { properties: { sku: { type: 'string', required: true }, ... } }.
    // Left as an open object — the platform surfaces it to the agent but does
    // not deeply validate it (the recommended field-descriptor shape is documented).
    schema: z.object({}).passthrough().optional(),
  })
  .passthrough();

export const describeResponseSchema = z
  .object({
    ...responseEnvelope,
    // Operation catalog. Recommended shape is operationDescriptorSchema[], but
    // every field is optional + passthrough so existing backends are unaffected.
    operations: z.array(operationDescriptorSchema).optional(),
    // Optional namespace catalog so the agent can discover memory namespaces
    // (and their freshness policy) at runtime instead of hard-coding them.
    namespaces: z.array(memoryNamespaceSchema).optional(),
  })
  .passthrough();

export const authorizeResponseSchema = z
  .object({
    ...responseEnvelope,
    allowed: z.boolean().optional(),
  })
  .passthrough();

export const executeResponseSchema = z
  .object({
    ...responseEnvelope,
    ok: z.boolean().optional(),
  })
  .passthrough();

/**
 * One result inside a `/bulk_execute` response (ADR-0036). Mirrors a single
 * `/execute` outcome: `result` (committed) or `preview` (dryRun), an `auditId`,
 * or a structured per-op `error` when that op failed (best-effort mode). Lenient
 * + passthrough so a backend shapes entries however it likes.
 */
export const bulkExecuteResultItemSchema = z
  .object({
    ok: z.boolean().optional(),
    result: z.unknown().optional(),
    preview: z.unknown().optional(),
    auditId: z.string().optional(),
    error: gatewayErrorSchema.optional(),
  })
  .passthrough();

export const bulkExecuteResponseSchema = z
  .object({
    ...responseEnvelope,
    ok: z.boolean().optional(),
    // Per-operation results, index-aligned with the request `operations`.
    results: z.array(bulkExecuteResultItemSchema).optional(),
    // best-effort mode: true when at least one op failed. atomic mode: on any
    // failure `ok` is false and nothing committed (so `partial` stays false).
    partial: z.boolean().optional(),
  })
  .passthrough();

/**
 * Async task status (ADR-0037). `status` recommended values:
 * `pending` | `running` | `succeeded` | `failed` — lenient + passthrough so a
 * backend may add its own states. `result` is present on `succeeded`, `error`
 * on `failed`, `progress` (0..1, advisory) while running.
 */
export const taskStatusResponseSchema = z
  .object({
    ...responseEnvelope,
    ok: z.boolean().optional(),
    status: z.string().optional(),
    progress: z.number().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

/**
 * Recommended provenance block for a recalled memory record (ADR-0033).
 *
 * Provenance lets an agent (and the audit trail) answer "where did this recalled
 * fact come from, and who wrote it" — the antidote to treating an injected blob
 * as if the platform vouched for it. Every field is optional so a backend can
 * adopt it incrementally; `passthrough()` keeps backend-specific provenance
 * fields. This is NOT trust: a `writtenBy` value is still backend-asserted data,
 * not a verified identity.
 */
export const memorySourceSchema = z
  .object({
    namespace: z.string().optional(),
    subjectType: z.string().optional(),
    subjectId: z.string().optional(),
    recordId: z.string().optional(),
    updatedAt: z.string().optional(),
    writtenBy: z.string().optional(),
  })
  .passthrough();

/** A single recalled record with its value, provenance, and optional score. */
export const memorySearchResultSchema = z
  .object({
    value: z.unknown(),
    source: memorySourceSchema.optional(),
    // Backend-defined relevance score. Semantics (range, direction) are the
    // backend's — the platform never ranks or interprets it.
    score: z.number().optional(),
    // Optional conflict metadata (roadmap 4.4). `conflictsWith` lists recordIds
    // this value disagrees with (same subject/key, divergent values); `resolved`
    // is whether the backend considers the conflict settled. Lets the agent
    // surface "these facts disagree" instead of silently acting on the first
    // result. Both optional + passthrough → a backend adopts this incrementally.
    conflictsWith: z.array(z.string()).optional(),
    resolved: z.boolean().optional(),
  })
  .passthrough();

export const memoryGetResponseSchema = z
  .object({
    ...responseEnvelope,
    ok: z.boolean().optional(),
    // Optional provenance — not forced, so an existing /memory/get backend that
    // returns only a value stays conformant (backward-compatible).
    source: memorySourceSchema.optional(),
  })
  .passthrough();

export const memoryUpsertResponseSchema = z
  .object({
    ...responseEnvelope,
    ok: z.boolean().optional(),
  })
  .passthrough();

export const memorySearchResponseSchema = z
  .object({
    ...responseEnvelope,
    ok: z.boolean().optional(),
    // The recall list. Recommended shape is `memorySearchResultSchema[]`, but
    // the array is lenient (`z.unknown()` elements would also pass via the
    // outer passthrough) so a backend can shape entries however it likes.
    results: z.array(memorySearchResultSchema).optional(),
  })
  .passthrough();

/**
 * Knowledge feedback response (ADR-0043). A backend ack — not recalled data, so
 * it is NOT wrapped in the untrusted-memory fence. All fields optional/passthrough
 * so a backend shapes the ack freely (or returns an empty body).
 */
export const memoryFeedbackResponseSchema = z
  .object({
    ...responseEnvelope,
    ok: z.boolean().optional(),
    accepted: z.boolean().optional(),
    feedbackId: z.string().optional(),
    source: memorySourceSchema.optional(),
  })
  .passthrough();

/** Path → response schema. */
export const RESPONSE_SCHEMAS = {
  '/describe': describeResponseSchema,
  '/authorize': authorizeResponseSchema,
  '/execute': executeResponseSchema,
  '/bulk_execute': bulkExecuteResponseSchema,
  '/task/status': taskStatusResponseSchema,
  '/memory/get': memoryGetResponseSchema,
  '/memory/upsert': memoryUpsertResponseSchema,
  '/memory/search': memorySearchResponseSchema,
  '/memory/feedback': memoryFeedbackResponseSchema,
} as const;

// ---------------------------------------------------------------------------
// HTTP-status → error-code classification
// ---------------------------------------------------------------------------

/**
 * Map a non-2xx response onto the closed error-code enum.
 *
 * If the body parses as a structured `GatewayError`, that code wins — the
 * backend's own classification is the most precise. Otherwise the HTTP status
 * decides: 401/403 → unauthorized, 404 → operation-not-found, 400/422 →
 * validation, 5xx → backend-unavailable, everything else → unknown.
 */
export function classifyHttpError(status: number, bodyText: string): GatewayErrorCode {
  const structured = parseGatewayError(bodyText);
  if (structured) return structured.code;

  if (status === 401 || status === 403) return 'BACKEND_UNAUTHORIZED';
  if (status === 404) return 'OPERATION_NOT_FOUND';
  if (status === 400 || status === 422) return 'VALIDATION_FAILED';
  if (status >= 500 && status <= 599) return 'BACKEND_UNAVAILABLE';
  return 'UNKNOWN';
}

/**
 * Try to read a structured `GatewayError` out of a response body. Tolerates
 * the error being nested under an `error` key (e.g. `{ "error": { code, ... }}`)
 * as well as being the top-level object. Returns undefined on any mismatch.
 */
export function parseGatewayError(bodyText: string): GatewayError | undefined {
  if (!bodyText) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  const direct = gatewayErrorSchema.safeParse(parsed);
  if (direct.success) return direct.data;
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const nested = gatewayErrorSchema.safeParse((parsed as { error: unknown }).error);
    if (nested.success) return nested.data;
  }
  return undefined;
}

/** Conservative default retryability per code, when the backend doesn't say. */
export function defaultRetryable(code: GatewayErrorCode): boolean {
  switch (code) {
    case 'BACKEND_UNAVAILABLE':
    case 'TIMEOUT':
      return true;
    default:
      return false;
  }
}
