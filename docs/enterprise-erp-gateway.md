# Enterprise ERP Gateway Contract

To keep FrontLane generic across different ERP systems, do not teach the
agents a vendor-specific API surface. Put a thin HTTP gateway in front of
your ERP backend and make every backend implement the same contract.

## Why this shape

FrontLane then stays stable at the agent layer:

- frontdesk and workers always call the same built-in MCP tools
- different ERP products only swap the gateway implementation
- auth, permission checks, and business-side audit stay on your backend

## Built-in agent tools

When `enterpriseGateway` is configured in `container.json`, agents get one
stable tool surface:

- `erp_describe`
- `erp_authorize`
- `erp_execute`
- `erp_memory_get`
- `erp_memory_upsert`

## Configure it on enterprise groups

Use the helper script after `init-enterprise-topology`:

```bash
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url https://erp-gateway.internal/api/agent
```

Optional examples:

```bash
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url https://erp-gateway.internal/api/agent \
  --folders frontlane-template-frontdesk,frontlane-finance-worker \
  --timeout-ms 20000 \
  --header x-tenant=erp-a
```

## Expected HTTP endpoints

The built-in tools call these paths on the configured `baseUrl`:

- `POST /describe`
- `POST /authorize`
- `POST /execute`
- `POST /memory/get`
- `POST /memory/upsert`

## Request envelope

Each request includes:

```json
{
  "agent": {
    "agentGroupId": "ag-...",
    "groupName": "FrontLane Template Desk",
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
  "idempotencyKey": null
}
```

`/describe` only needs `agent`, `requester`, and `requesterSource`.

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
identity resolver prefers that column, so an ERP call from a deeply-nested
worker still attributes to the real human, not to a generic
`agent-asserted` fallback.

This means: you don't need to reconstruct the identity chain on the
gateway side. One `requester.userId` per call is enough — it's the same
user id whether frontdesk or a 3-hop worker made the call.

## HMAC request signing

If `container.json`'s `enterpriseGateway.signingKey` is set, every gateway
request carries three headers:

- `x-frontlane-timestamp` — unix seconds
- `x-frontlane-nonce` — 32-char hex
- `x-frontlane-signature` — HMAC-SHA256 over `<timestamp>.<nonce>.<body>`

Gateway-side verification (reference implementation):

```ts
import crypto from 'node:crypto';

const expected = crypto
  .createHmac('sha256', process.env.FRONTLANE_SIGNING_KEY!)
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
`enterpriseGateway.signingHeaders.{timestamp,nonce,signature}` if the
gateway you're fronting has mandatory naming conventions.

Signing is opt-in — leaving `signingKey` unset skips the headers entirely
(so existing deployments don't break on upgrade). Turn it on once your
gateway is ready to verify.

## Host-side audit trail (erp_audit)

Independently of what the gateway itself logs, FrontLane writes a
per-call audit row into the central DB's `erp_audit` table. The container
emits a `kind='system', action='erp_audit'` message after every gateway
call (win or lose); the host's `src/modules/erp-audit/index.ts` handler
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
- `error_msg` on failure

Typical queries:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT occurred_at, user_id, path, operation, status, http_status
     FROM erp_audit
     WHERE occurred_at > datetime('now', '-1 hour')
     ORDER BY id DESC LIMIT 50"
```

The audit write is best-effort (container → host → DB); if the DB write
itself fails, the row is dropped. For environments where the gateway side
needs to reconcile the full trail even when that happens, run audit on
the gateway as well and match by `idempotencyKey` / returned audit id.

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
    "groupName": "Xin Jiu Long Frontdesk",
    "assistantName": "Xin Jiu Long Frontdesk"
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

FrontLane should do:

- chat ingress
- per-user session isolation
- worker orchestration
- human-facing reasoning

Your ERP gateway should do:

- user identity mapping
- permission checks
- approval enforcement
- idempotency
- audit logging
- backend-specific API translation
