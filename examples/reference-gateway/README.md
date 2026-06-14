# reference-gateway — a runnable backend gateway

A minimal, **zero-dependency** implementation of the AgentDesk backend gateway
contract. It is the executable companion to the prose contract in
[`docs/enterprise-erp-gateway.md`](../../docs/enterprise-erp-gateway.md) and the
machine-verifiable source of truth at
[`container/agent-runner/src/mcp-tools/gateway-contract.ts`](../../container/agent-runner/src/mcp-tools/gateway-contract.ts).

Use it to:

- see a complete gateway answer all eight endpoints with contract-compliant shapes,
- run the conformance runner against something real and watch it go green,
- copy as the skeleton for your own gateway (replace the in-memory store and the
  no-op operations with calls into your ERP / CRM / ticketing backend).

It is **not** production code: storage is an in-memory `Map` (lost on restart)
and authorization is illustrative. The idempotency cache is process-local (a
real backend persists it with the write). The inline comments in
[`server.mjs`](server.mjs) mark exactly where a real backend plugs in.

> **Going to production?** [`docs/gateway-kickstart.md`](../../docs/gateway-kickstart.md)
> walks this skeleton → your backend, with the hardening recipes (identity
> mapping, permission denial, idempotency, audit, HMAC + clock-skew + nonce
> cache, error-code mapping) and an Express port.

## What it implements

| Endpoint | Behaviour |
|---|---|
| `POST /describe` | returns an operation catalog (`conformance.noop`, `demo.echo`, `demo.order.create`, plus a realistic read+write pair `todo.list` / `todo.create`) and a memory-namespace catalog |
| `POST /authorize` | allows reads; denies a **mutating** op when `requesterSource` is `agent-asserted` |
| `POST /execute` | `dryRun` → `preview`; otherwise → `result`; **replays the same result for a repeated `idempotencyKey`** so host retries can't double-write; returns an `auditId`; unknown op → structured `OPERATION_NOT_FOUND` |
| `POST /bulk_execute` | runs many operations in one round-trip (ADR-0036); per-op idempotency replay; `atomic` pre-validates then commits all-or-nothing; best-effort returns per-op `results[]` + `partial` |
| `POST /task/status` | async task poll (ADR-0037); `submitAsync:true` on `/execute` returns a `taskId`, this returns its `{status, result?}` (idempotent by key; unknown id → `failed`, not 404) |
| `POST /memory/get` | exact lookup by `(namespace, subject)`; returns `value` + `source` provenance |
| `POST /memory/upsert` | stores (optionally merges) `value`; returns the stored value + `source` |
| `POST /memory/search` | naive keyword match over stored JSON, scoped by namespace + subject; returns `{ value, source, score }[]` (ADR-0033) |

Every response carries `contractVersion: 1`. The `requesterSource='session'` vs
`'agent-asserted'` gate on mutating operations is the contract's identity-trust
model in miniature — a real backend should keep that gate and harden it.

## Run it

No install, no build step — Node built-ins only (`node:http`, `node:crypto`):

```bash
node examples/reference-gateway/server.mjs            # listens on http://localhost:8088
PORT=9090 node examples/reference-gateway/server.mjs  # custom port
```

Optional HMAC verification (off by default). When `GATEWAY_SIGNING_KEY` is set,
every request must carry a valid `<timestamp>.<nonce>.<body>` signature in the
brand-namespaced headers (`x-agentdesk-timestamp/nonce/signature`, following
`BRAND_NAMESPACE`):

```bash
GATEWAY_SIGNING_KEY="$(openssl rand -hex 32)" node examples/reference-gateway/server.mjs
```

## Verify it with the conformance runner

The conformance runner POSTs a contract-compliant sample to each endpoint and
validates the response against the **same** zod schemas the runtime uses. From
the container runner package:

```bash
cd container/agent-runner
bun scripts/gateway-conformance.ts http://localhost:8088
```

No `bun`? The script is plain TypeScript with no `bun:` imports, so `tsx` works
just as well:

```bash
cd container/agent-runner
pnpm exec tsx scripts/gateway-conformance.ts http://localhost:8088
```

Expected output — all eight green:

```
  PASS        /describe       [200]
  PASS        /authorize      [200]
  PASS        /execute        [200]
  PASS        /bulk_execute   [200]
  PASS        /task/status    [200]
  PASS        /memory/get     [200]
  PASS        /memory/upsert  [200]
  PASS        /memory/search  [200]

All 8 endpoints conformant.
```

Other modes (all pass against this reference):

```bash
# Strict response mode — fail on any response-schema mismatch:
GATEWAY_STRICT_RESPONSES=true pnpm exec tsx scripts/gateway-conformance.ts http://localhost:8088

# Signed gateway — start it with GATEWAY_SIGNING_KEY, then probe with the same key:
GATEWAY_SIGNING_KEY=test-key pnpm exec tsx scripts/gateway-conformance.ts http://localhost:8089
```

(Probing a signed gateway *without* the key returns `401` on every endpoint —
that is the verification working, not a contract violation.)

## Point an agent group at it

After bootstrapping a topology (see [`../README.md`](../README.md)), point your
group's `backendGateway.baseUrl` at the reference gateway with the configure
helper — don't hand-edit `container.json`:

```bash
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url http://localhost:8088 \
  --folders agentdesk-frontdesk
```

Now `gateway_describe` / `gateway_authorize` / `gateway_execute` /
`gateway_memory_get` / `gateway_memory_upsert` / `gateway_memory_search` from
that group's agent hit this server. Watch the per-call audit trail land in the
central DB:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT occurred_at, user_id, path, operation, status, http_status
     FROM gateway_audit ORDER BY id DESC LIMIT 20"
```

## Quick manual probe

```bash
# upsert a memory record (session-trusted requester)
curl -s -X POST http://localhost:8088/memory/upsert -H 'content-type: application/json' -d '{
  "contractVersion": 1,
  "agent": { "agentGroupId": "ag1", "groupName": "FD", "assistantName": "FD" },
  "requester": { "userId": "feishu:ou_alice" },
  "requesterSource": "session",
  "namespace": "conversation.summary",
  "subject": { "type": "user", "id": "feishu:ou_alice" },
  "value": { "note": "alice prefers async approvals for the Q3 budget" },
  "merge": true,
  "context": {}
}'

# search it back (keyword match → score 1.0, with provenance)
curl -s -X POST http://localhost:8088/memory/search -H 'content-type: application/json' -d '{
  "contractVersion": 1,
  "agent": { "agentGroupId": "ag1", "groupName": "FD", "assistantName": "FD" },
  "requester": { "userId": "feishu:ou_alice" },
  "requesterSource": "session",
  "namespace": "conversation.summary",
  "query": "Q3 budget approvals",
  "subject": { "type": "user", "id": "feishu:ou_alice" },
  "limit": 5,
  "context": {}
}'
```
