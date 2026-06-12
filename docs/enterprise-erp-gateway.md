# Backend Gateway Contract

To keep AgentDesk generic across different backend systems, do not teach the
agents a vendor-specific API surface. Put a thin HTTP gateway in front of
your backend (ERP, CRM, ticketing, or any internal system) and make every
backend implement the same contract.

> The brand namespace below (`agentdesk`) is the default; signing-header
> prefixes follow `BRAND_NAMESPACE` if you override it.

## Why this shape

AgentDesk then stays stable at the agent layer:

- frontdesk and workers always call the same built-in MCP tools
- different backend products only swap the gateway implementation
- auth, permission checks, and business-side audit stay on your backend

## Built-in agent tools

When `backendGateway` is configured in `container.json`, agents get one
stable tool surface:

- `gateway_describe`
- `gateway_authorize`
- `gateway_execute`
- `gateway_memory_get`
- `gateway_memory_upsert`

## Configure it on enterprise groups

Use the helper script after `init-enterprise-topology`:

```bash
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url https://gateway.internal/api/agent
```

Optional examples:

```bash
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url https://gateway.internal/api/agent \
  --folders agentdesk-frontdesk,agentdesk-finance-worker \
  --timeout-ms 20000 \
  --header x-tenant=tenant-a
```

## Expected HTTP endpoints

The built-in tools call these paths on the configured `baseUrl`:

- `POST /describe`
- `POST /authorize`
- `POST /execute`
- `POST /memory/get`
- `POST /memory/upsert`

## The contract is machine-verifiable

This document is the human-readable view of the contract; the **single source
of truth** is the zod schema at
`container/agent-runner/src/mcp-tools/gateway-contract.ts`. The runtime and the
conformance runner (see [Conformance runner](#conformance-runner)) both consume
those schemas, so the wire shape can't drift from this doc. See ADR-0028 for the
hardening rationale.

The platform applies an **asymmetric** stance (ADR-0028):

- What the platform **emits** is tightened freely — the envelope carries a
  `contractVersion`, write operations always carry an `idempotencyKey`, and the
  agent's tool inputs are whitelisted (`additionalProperties: false`). These are
  platform-produced, so tightening them can never break an existing backend.
- What the backend **returns** is validated **leniently**. You still control the
  payload shape; a response that doesn't match the recommended schema is, by
  default, only a warning — never a rejection. Opt into hard rejection with
  `GATEWAY_STRICT_RESPONSES=true` (see [Strict response mode](#strict-response-mode)).

## Request envelope

Each request includes:

```json
{
  "contractVersion": 1,
  "agent": {
    "agentGroupId": "ag-...",
    "groupName": "AgentDesk Frontdesk",
    "assistantName": "Frontdesk"
  },
  "requester": {
    "userId": "feishu:ou_xxx",
    "channelType": "feishu",
    "platformId": "oc_xxx",
    "threadId": null
  },
  "requesterSource": "session",
  "operation": "sales.order.create",
  "input": {},
  "context": {},
  "dryRun": false,
  "idempotencyKey": "b1a7c0de-..."
}
```

`/describe` only needs `contractVersion`, `agent`, `requester`, and
`requesterSource`.

### `contractVersion`

The platform stamps the integer wire-contract version onto every request
(currently `1`). Bump only happens on a backward-incompatible change to the
envelope or the closed error shape. Your backend MAY echo `contractVersion` in
its response; if the value differs from what the platform sent, the platform
**warns** (a backend may legitimately lag a platform upgrade) — it never rejects
on a version mismatch.

### `idempotencyKey` (write operations)

For `/execute`, the platform guarantees a non-null `idempotencyKey` on every
**committing** call: if the agent supplies one it is passed through unchanged;
if the agent omits it, the runtime auto-generates a UUID. A `dryRun=true`
execute touches no committed state, so its `idempotencyKey` stays `null`. Use
this key to dedupe retried writes on your side.

### `requesterSource` is how the gateway decides how much to trust the `requester` block

| value | meaning | recommended gateway policy |
|-------|---------|----------------------------|
| `session` | Identity was derived from the session's inbound messages — host-written, container cannot forge. Authoritative. | Normal permission flow. Attribute the action to `requester.userId`. |
| `agent-asserted` | No trusted identity was available at batch start (scheduled task, a2a hop with no attribution source, orphan session). The `requester` block reflects whatever the agent passed as tool arguments. | Be strict. Default to rejecting writes. Allow only read / aggregate / non-destructive operations, and clearly log the ambiguity. |

The agent cannot set this field — it's set by the container runtime based on
what it could resolve at the start of the batch. See
`container/agent-runner/src/request-identity.ts` for the resolution rules.

## Identity propagation across agent-to-agent hops

When frontdesk delegates to a worker (`messages_out.channel_type = 'agent'`),
the host copies the originating employee's namespaced user id onto the
target session's inbound row as `origin_user_id`. The worker's batch
identity resolver prefers that column, so a gateway call from a deeply-nested
worker still attributes to the real human, not to a generic
`agent-asserted` fallback.

This means: you don't need to reconstruct the identity chain on the
gateway side. One `requester.userId` per call is enough — it's the same
user id whether frontdesk or a 3-hop worker made the call.

## HMAC request signing

If `container.json`'s `backendGateway.signingKey` is set, every gateway
request carries three headers (the `agentdesk` prefix follows `BRAND_NAMESPACE`):

- `x-agentdesk-timestamp` — unix seconds
- `x-agentdesk-nonce` — 32-char hex
- `x-agentdesk-signature` — HMAC-SHA256 over `<timestamp>.<nonce>.<body>`

Gateway-side verification (reference implementation):

```ts
import crypto from 'node:crypto';

const expected = crypto
  .createHmac('sha256', process.env.GATEWAY_SIGNING_KEY!)
  .update(`${ts}.${nonce}.${rawBody}`)
  .digest('hex');
const valid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
```

Recommended companion policies on the gateway:

- reject timestamps more than ±5 minutes out of sync
- reject nonces that have been seen in the last 10 minutes (in-process LRU
  or Redis TTL is fine)
- reject any request missing the three headers when a signing key is
  configured

Header names can be overridden per group via
`backendGateway.signingHeaders.{timestamp,nonce,signature}` if the
gateway you're fronting has mandatory naming conventions.

### Enabling signing

Don't hand-edit `container.json`. Use the configure script, which writes the
key into each target group and masks it in its output:

```bash
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url https://gateway.internal/api/agent \
  --folders my-frontdesk,my-finance-worker \
  --signing-key "$GATEWAY_SIGNING_KEY"
```

- `--signing-key` falls back to the `GATEWAY_SIGNING_KEY` environment variable
  so the key need not appear in shell history.
- `--signing-headers timestamp,nonce,signature` (optional) overrides the three
  header names in that order; omit it to keep the brand-namespaced defaults.
- Re-running the script **without** `--signing-key` preserves an existing key —
  it never silently downgrades a signed group back to unsigned.

### Signing is opt-in (but observed)

Leaving `signingKey` unset skips the headers entirely, so existing deployments
don't break on upgrade. The trade-off is that unsigned gateway requests can be
forged by anything that can reach the gateway baseUrl. To keep that gap from
staying silent, the host runs a startup scan
(`src/gateway-signing-check.ts`): it reports the
`<namespace>_gateway_unsigned_groups` gauge and logs a warning listing any
group that has a `baseUrl` but no `signingKey`. Alert on that gauge being
`> 0` and remediate with the script above.

The platform deliberately does **not** enforce signing or store nonces — see
ADR-0018 for why (backward compatibility + gateways often sit on a trusted
network). Replay protection (nonce cache + clock-skew window) stays on the
gateway side, per the companion policies above. Turn signing on once your
gateway is ready to verify.

## Host-side audit trail (gateway_audit)

Independently of what the gateway itself logs, AgentDesk writes a
per-call audit row into the central DB's `gateway_audit` table. The container
emits a `kind='system', action='gateway_audit'` message after every gateway
call (win or lose); the host's `src/modules/gateway-audit/index.ts` handler
persists it.

Recorded fields:

- `occurred_at`, `session_id`, `agent_group_id`, `user_id`
- `path` — `/describe` / `/authorize` / `/execute` / `/memory/get` / `/memory/upsert`
- `operation` — for authorize/execute calls
- `requester_source` — same `'session'` / `'agent-asserted'` value the
  gateway saw
- `status` — `ok` / `error`
- `http_status`, `duration_ms`, `idempotency_key`
- `input_hash` — SHA256 of the business payload, scoped by path so
  `/memory/*` and `/execute` calls don't collapse to the same digest
- `error_msg` on failure — prefixed with the closed `[ERROR_CODE]` (see
  [Error responses](#error-responses)); also used to carry warn-only markers
  like `[RESPONSE_SCHEMA_MISMATCH]` / `[CONTRACT_VERSION_MISMATCH]` on
  otherwise-`ok` calls. The container-emitted audit message also carries a
  dedicated `errorCode` field; the `gateway_audit` table keeps the code inside
  `error_msg` rather than adding a column (ADR-0028).

Typical queries:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT occurred_at, user_id, path, operation, status, http_status
     FROM gateway_audit
     WHERE occurred_at > datetime('now', '-1 hour')
     ORDER BY id DESC LIMIT 50"
```

The audit write is best-effort (container → host → DB); if the DB write
itself fails, the row is dropped. For environments where the gateway side
needs to reconcile the full trail even when that happens, run audit on
the gateway as well and match by `idempotencyKey` / returned audit id.

## Error responses

On any non-2xx response, the platform classifies the failure onto a **closed
error-code enum** and surfaces `{code, retryable, retryAfterMs?}` back to the
agent so it can decide whether to retry. Two ways your backend can drive this:

1. **Structured error body (preferred)** — return a JSON body matching the
   error shape (either top-level or nested under an `error` key):

   ```json
   { "code": "BACKEND_UNAVAILABLE", "message": "primary db unreachable", "retryable": true, "retryAfterMs": 2000 }
   ```

   When present, your `code` / `retryable` / `retryAfterMs` win.

2. **HTTP status only** — if the body isn't a structured error, the platform
   maps the status code:

| HTTP status | error code | retryable (default) |
|-------------|-----------|---------------------|
| 401, 403 | `BACKEND_UNAUTHORIZED` | no |
| 404 | `OPERATION_NOT_FOUND` | no |
| 400, 422 | `VALIDATION_FAILED` | no |
| 5xx | `BACKEND_UNAVAILABLE` | yes |
| other | `UNKNOWN` | no |

Additional codes the platform itself can emit (not from your HTTP status):

| code | when |
|------|------|
| `TIMEOUT` | request exceeded `backendGateway.timeoutMs` (retryable) |
| `GATEWAY_NOT_CONFIGURED` | the agent group has no `baseUrl` |
| `CONTRACT_VERSION_MISMATCH` | backend echoed a different `contractVersion` (warn-only, not a hard error) |

The code is also folded into the `gateway_audit` row (see below) as an
`[CODE]`-prefixed `error_msg`, and as a dedicated `errorCode` field in the
container-emitted audit message.

## Strict response mode

By default, a successful (2xx) response that doesn't match the recommended
response schema is **allowed** — the platform logs a warning, records an
`errorCode: RESPONSE_SCHEMA_MISMATCH` audit marker, and still returns the
payload to the agent. This preserves the "you control the payload shape"
promise.

Set the runner environment variable `GATEWAY_STRICT_RESPONSES=true` to turn a
schema mismatch into a hard error (`VALIDATION_FAILED`) instead. Use this once
your backend is fully aligned with the recommended response shapes and you want
the platform to enforce them. Note: `contractVersion` drift stays a warning even
in strict mode.

## Conformance runner

Before bringing a backend online (or after upgrading one), self-test it against
the same schemas the runtime uses:

```bash
cd container/agent-runner && bun scripts/gateway-conformance.ts https://gateway.internal/api/agent
```

It POSTs a contract-compliant sample request to each of the five endpoints and
validates each response. Exit code `0` = every endpoint conformant; non-zero =
at least one failure (or, under `GATEWAY_STRICT_RESPONSES=true`, at least one
schema mismatch).

Optional environment:

- `GATEWAY_SIGNING_KEY` — signs each request exactly as the runtime does.
- `GATEWAY_HEADERS` — extra headers as JSON, e.g. `'{"x-tenant":"tenant-a"}'`.
- `GATEWAY_STRICT_RESPONSES=true` — fail on a response-schema mismatch.
- `GATEWAY_TEST_USER_ID` — the sample `requester.userId`.

The runner sends dummy payloads with `requesterSource='agent-asserted'` and sets
`dryRun=true` on `/execute` — point it at a staging backend, not one that would
commit real writes.

## Response guidance

You control the payload shape, but keep it explicit. Recommended patterns:

- `/describe`
  - backend id/version
  - supported operations
  - required fields per operation
  - approval hints
- `/authorize`
  - `allowed: true | false`
  - deny reason
  - obligations, approval requirements, or policy notes
- `/execute`
  - `ok: true | false`
  - business result payload
  - `preview` when `dryRun=true`
  - audit id / request id for traceability
- `/memory/get`
  - `ok: true | false`
  - durable profile / preference / note payload for a subject
  - backend version or source metadata when useful
- `/memory/upsert`
  - `ok: true | false`
  - normalized stored payload
  - audit id / request id for traceability

## Recommended durable-memory model

For shared enterprise agents, keep long-lived memory in your backend instead
of the agent workspace.

Recommended request shape for the memory endpoints:

```json
{
  "agent": {
    "agentGroupId": "ag-...",
    "groupName": "AgentDesk Frontdesk",
    "assistantName": "AgentDesk Frontdesk"
  },
  "requester": {
    "userId": "feishu:ou_xxx"
  },
  "namespace": "user.preferences",
  "subject": {
    "type": "user",
    "id": "feishu:ou_xxx"
  },
  "query": {},
  "value": {
    "preferred_language": "zh-CN"
  },
  "merge": true,
  "context": {}
}
```

Suggested namespaces:

- `user.profile`
- `user.preferences`
- `user.permission_hints`
- `conversation.summary`
- `approval.history`

## Operation naming

Use stable dot-separated names so agent prompts stay portable:

- `sales.order.create`
- `sales.quote.list`
- `finance.invoice.approve`
- `finance.payment.status`
- `approval.request.submit`
- `access.user.resolve`

## Responsibility split

AgentDesk should do:

- chat ingress
- per-user session isolation
- worker orchestration
- human-facing reasoning

Your backend gateway should do:

- user identity mapping
- permission checks
- approval enforcement
- idempotency
- audit logging
- backend-specific API translation
