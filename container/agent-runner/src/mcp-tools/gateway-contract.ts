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

/** Path → request schema. Single lookup the conformance runner reuses. */
export const REQUEST_SCHEMAS = {
  '/describe': describeRequestSchema,
  '/authorize': authorizeRequestSchema,
  '/execute': executeRequestSchema,
  '/memory/get': memoryGetRequestSchema,
  '/memory/upsert': memoryUpsertRequestSchema,
  '/memory/search': memorySearchRequestSchema,
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

export const describeResponseSchema = z
  .object({
    ...responseEnvelope,
    operations: z.array(z.unknown()).optional(),
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

/** Path → response schema. */
export const RESPONSE_SCHEMAS = {
  '/describe': describeResponseSchema,
  '/authorize': authorizeResponseSchema,
  '/execute': executeResponseSchema,
  '/memory/get': memoryGetResponseSchema,
  '/memory/upsert': memoryUpsertResponseSchema,
  '/memory/search': memorySearchResponseSchema,
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
