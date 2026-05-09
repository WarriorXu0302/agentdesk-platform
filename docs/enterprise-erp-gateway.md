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
  --folders frontlane-frontdesk,frontlane-finance-worker \
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
    "groupName": "FrontLane Desk",
    "assistantName": "Frontdesk"
  },
  "requester": {
    "userId": "feishu:ou_xxx",
    "channelType": "feishu",
    "platformId": "oc_xxx",
    "threadId": null
  },
  "operation": "sales.order.create",
  "input": {},
  "context": {},
  "dryRun": false,
  "idempotencyKey": null
}
```

`/describe` only needs `agent` and `requester`.

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
