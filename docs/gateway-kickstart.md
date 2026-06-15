# Backend Gateway Kickstart

How to go from the runnable reference to a production gateway in front of *your*
backend (ERP / CRM / internal API / ticketing) — without reverse-engineering the
contract.

You do **not** start from a blank file. The platform ships a complete,
contract-passing implementation at
[`examples/reference-gateway/server.mjs`](../examples/reference-gateway/server.mjs)
(zero dependencies, Node built-ins only). This guide treats it as your skeleton
and walks the changes a real backend needs: identity mapping, permission
decisions, idempotency, audit correlation, request signing, and error-code
mapping.

> **Prerequisites.** Read the contract first:
> [`docs/enterprise-erp-gateway.md`](enterprise-erp-gateway.md) (prose) and the
> machine-verifiable source of truth
> [`container/agent-runner/src/mcp-tools/gateway-contract.ts`](../container/agent-runner/src/mcp-tools/gateway-contract.ts)
> (zod schemas). The gateway is the **only** path for business memory and
> authorization — the platform never talks to your backend any other way.

---

## 1. Stand up the reference, point a group at it, watch it go green

```bash
# 1. run the reference gateway
node examples/reference-gateway/server.mjs            # http://localhost:8088

# 2. confirm it's contract-compliant
cd container/agent-runner
pnpm exec tsx scripts/gateway-conformance.ts http://localhost:8088   # 6/6 PASS

# 3. point an agent group at it (don't hand-edit container.json)
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url http://localhost:8088 --folders agentdesk-frontdesk
```

Now `gateway_describe` / `_authorize` / `_execute` / `_memory_get` / `_upsert` /
`_search` from that group's agent hit the reference. Full walkthrough (manual
curls, signed mode, audit query) is in
[`examples/reference-gateway/README.md`](../examples/reference-gateway/README.md).

That is your working baseline. Everything below is replacing the reference's
*illustrative* behaviour with your backend's *real* behaviour.

---

## 2. The six hookpoints

Each endpoint is one function in `server.mjs`. Replace its body; keep its
request/response shape (the conformance runner enforces the shape).

| Endpoint | Reference does | Your backend does |
|---|---|---|
| `POST /describe` | static op + namespace catalog | reflect what the fronted system can actually do *for this caller*; advertise memory namespaces + freshness |
| `POST /authorize` | allow reads, deny mutating from `agent-asserted` | run your real permission/approval policy; return `{allowed, reason?, obligations?}` |
| `POST /execute` | echo input; idempotency replay; trust gate | map identity, enforce permission, **dedupe on `idempotencyKey`**, commit, return `auditId` |
| `POST /memory/get` | `Map` lookup by `(namespace, subject)` | read your durable store; return `value` + `source` provenance |
| `POST /memory/upsert` | `Map` write (optional merge) | write your durable store; return stored `value` + `source` |
| `POST /memory/search` | naive keyword score | full-text / vector retrieval, **scoped by namespace + subject** (ADR-0033) |

The reference's inline comments mark each of these (`// A real backend would …`).

---

## 3. Production hardening recipes

The shape is the easy part. These are the things a real gateway must get right
and a demo skips.

### 3.1 Identity mapping — trust the source, then translate

Every request carries `requester` (e.g. `{ userId: "feishu:ou_alice" }`) and a
`requesterSource`:

- **`session`** — on the honest path, host-derived from the verified identity
  trust chain (read from inbound.db; the agent does not set it through the normal
  MCP tool). A useful signal for non-malicious traffic.
- **`agent-asserted`** — no trusted identity was available. The agent *claimed*
  an identity; the platform could not verify it.

Map `requester.userId` to your own user/principal system, and use the source as
a first-line gate on *writes*:

```js
function isTrusted(req) { return req?.requesterSource === 'session'; }
// in /authorize and /execute:
if (def.mutating && !isTrusted(req)) return deny('mutating op requires a session-trusted requester');
```

> **⚠️ `requesterSource` is defense-in-depth, NOT an authentication boundary
> against a hostile container.** On the host **signing-proxy** path (ADR-0034)
> the host signs the container-supplied request body *verbatim*: it validates the
> agent-group binding but does **not** stamp, override, or cross-validate
> `requesterSource` or `requester.userId`. The agent runs with shell access, so a
> compromised or prompt-injected agent can read the proxy token from its own
> environment and craft a direct request asserting `requesterSource: 'session'`
> with **any** `requester.userId` — and the host will HMAC-sign it as trusted.
> This is the platform's explicitly **accepted residual risk R5** (ADR-0017,
> ADR-0034): the *agent-group* is the trust unit; an agent that group can already
> act as can forge a peer user's identity *to your backend*. (An earlier version
> of this guide wrongly stated `session` "cannot be forged — stamped host-side";
> it can. Only the agent-group binding is enforced host-side.)
>
> **For your backend:** treat the `requesterSource`/`requester` gate as a useful
> default that stops *honest* mis-routing — not as authentication. For any write
> where one user impersonating another would be damaging, anchor authorization on
> something the container cannot forge: your own backend-side session/principal
> verification, and/or the platform approval flow
> (`obligations: ['user-confirmation']`, §3.2), which routes a confirmation to the
> *actual* end-user before the write commits. Scope each agent-group's blast
> radius accordingly. **Never** use `requester.userId` *or* `requesterSource` as a
> *verified* cross-user identity for a write; treat memory-write provenance the
> same way (`source.writtenBy` is backend-asserted, not verified, per ADR-0033).

### 3.2 Permission denial — deny in `/authorize`, not only `/execute`

The agent calls `/authorize` *before* `/execute` to decide whether to proceed
and whether it needs to ask the user first. Return a structured decision:

```js
// deny:
return { allowed: false, reason: 'user lacks finance.approve on cost-center 4100' };
// allow, but require explicit user confirmation before execute:
return { allowed: true, obligations: ['user-confirmation'] };
```

`obligations: ['user-confirmation']` tells the platform to surface an approval
to the real end-user before the mutating `/execute` runs (the platform's
approval flow — see `src/modules/approvals/`). Use it for any mutating op a
human should sign off on; the reference attaches it when an op declares
`approval: 'required'`.

Still enforce the same check in `/execute` (defense in depth) — `/authorize` is
advisory; a buggy or adversarial agent might skip it.

### 3.3 Idempotency replay — make host retries safe

The platform stamps a stable `idempotencyKey` on every mutating `/execute` and
**retries with backoff on transient failure** (ADR-0016 delivery resilience). If
you commit on each attempt you double-write. Dedupe on the key and replay the
first result:

```js
// reference-gateway/server.mjs — a working (process-local) version:
if (def.mutating && !req.dryRun && req.idempotencyKey && idempotency.has(req.idempotencyKey)) {
  return { ...idempotency.get(req.idempotencyKey), replayed: true };
}
const response = { ok: true, result: runOperation(op, req), auditId: crypto.randomUUID() };
if (def.mutating && req.idempotencyKey) idempotency.set(req.idempotencyKey, response);
return response;
```

In production, persist the key→result mapping **in the same transaction as the
write** (a `UNIQUE` column on `idempotency_key`), not in a process-local map —
otherwise a crash between commit and cache-set reopens the double-write window.
`dryRun: true` must never commit and never consult the cache (it returns a
`preview`, not a `result`).

### 3.4 Audit correlation

The platform writes one row to the central `gateway_audit` table per call
(who / what / when / http_status / result) — that ledger is host-owned and you
cannot weaken it. Your job is to make your backend's audit *correlatable*:
return an `auditId` on `/execute` and log it on your side so a platform audit
row joins to your backend's record. Inspect the platform side with:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT occurred_at, user_id, path, operation, status, http_status FROM gateway_audit ORDER BY id DESC LIMIT 20"
```

### 3.5 HMAC request signing (ADR-0018) + the two checks the reference skips

When a group is configured with a signing key, every request carries
`x-<namespace>-timestamp`, `x-<namespace>-nonce`, `x-<namespace>-signature`
(`<namespace>` follows `BRAND_NAMESPACE`, default `agentdesk`). The signature is
`HMAC-SHA256(key, "<timestamp>.<nonce>.<rawBody>")`. Verify it against the
**raw** request body, with a constant-time compare:

```js
const expected = crypto.createHmac('sha256', KEY).update(`${ts}.${nonce}.${rawBody}`).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return unauthorized();
```

The reference stops there. **Production must add two things it omits:**

1. **Clock-skew window** — reject if `|now - timestamp|` exceeds e.g. 5 minutes,
   so a captured request can't be replayed forever.
2. **Nonce replay cache** — remember recently-seen nonces (within the skew
   window) and reject duplicates, so a request can't be replayed *inside* the
   window.

> Prefer the **host signing proxy** (ADR-0034) so the signing key never enters
> the agent container. In proxy mode the container posts unsigned to the host,
> which signs and forwards. Your gateway still verifies exactly as above.

### 3.6 Error codes — return structured, classifiable failures

The platform maps your failures onto a **closed enum** so the agent can decide
whether to retry, fall back, or surface the error. You get the most precise
result by returning a structured body `{ code, message, retryable?, retryAfterMs? }`
(top-level or nested under `error`) — **your `code` wins**. Otherwise the
platform classifies by HTTP status:

| Your response | Platform code | Retryable? |
|---|---|---|
| `{code:"...", retryable, retryAfterMs}` body (any status) | your `code` | your `retryable` |
| HTTP 401 / 403 | `BACKEND_UNAUTHORIZED` | no |
| HTTP 404 | `OPERATION_NOT_FOUND` | no |
| HTTP 400 / 422 | `VALIDATION_FAILED` | no |
| HTTP 5xx | `BACKEND_UNAVAILABLE` | **yes** |
| connection failure / timeout | `BACKEND_UNAVAILABLE` / `TIMEOUT` | **yes** |
| other | `UNKNOWN` | no |

The full enum is `GATEWAY_ERROR_CODES` in
[`gateway-contract.ts`](../container/agent-runner/src/mcp-tools/gateway-contract.ts).
A version skew (`contractVersion` echo ≠ platform's) is a **warning, never a
reject** — a backend may legitimately lag a platform upgrade. Map a transient
dependency outage to a 5xx / `BACKEND_UNAVAILABLE` so the host's backoff kicks
in; map a permanent "this user can't do this" to 403 / `BACKEND_UNAUTHORIZED` so
it doesn't.

---

## 4. Porting to a real web framework

The reference uses `node:http` so it runs with zero install. The handler logic
is framework-agnostic — porting to Express/Fastify/Hono is mechanical: keep the
six handler bodies, swap the routing and body-parsing. Here is the Express
shape; **read the raw body for signature verification before JSON-parsing**:

```js
import express from 'express';
import crypto from 'node:crypto';

const app = express();
// capture the RAW body so HMAC verification sees exactly what was signed
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

function requireSignature(req, res, next) {
  if (!process.env.GATEWAY_SIGNING_KEY) return next(); // signing disabled
  const { ['x-agentdesk-timestamp']: ts, ['x-agentdesk-nonce']: nonce, ['x-agentdesk-signature']: sig } = req.headers;
  if (!ts || !nonce || !sig) return res.status(401).json({ code: 'BACKEND_UNAUTHORIZED', message: 'missing signing headers' });
  // TODO production: enforce clock-skew window + nonce replay cache here (§3.5)
  const expected = crypto.createHmac('sha256', process.env.GATEWAY_SIGNING_KEY).update(`${ts}.${nonce}.${req.rawBody}`).digest('hex');
  const a = Buffer.from(String(sig)), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ code: 'BACKEND_UNAUTHORIZED', message: 'bad signature' });
  next();
}

// NOTE: requesterSource is defense-in-depth, not authentication — a compromised
// container can forge 'session' (residual risk R5, see §3.1). For damaging
// writes, also anchor on backend-side principal verification / user approval.
const isTrusted = (req) => req.body?.requesterSource === 'session';
const CV = 1; // contractVersion

app.post('/authorize', requireSignature, async (req, res) => {
  const { operation } = req.body;
  // ... look up the op + run YOUR permission policy ...
  if (!(await userMayDo(req.body.requester, operation))) {
    return res.json({ contractVersion: CV, allowed: false, reason: 'not permitted' });
  }
  res.json({ contractVersion: CV, allowed: true, obligations: needsApproval(operation) ? ['user-confirmation'] : [] });
});

app.post('/execute', requireSignature, async (req, res) => {
  const { operation, input, idempotencyKey, dryRun, requesterSource } = req.body;
  if (mutating(operation) && requesterSource !== 'session') {
    return res.status(403).json({ code: 'BACKEND_UNAUTHORIZED', message: 'untrusted requester may not mutate' });
  }
  if (dryRun) return res.json({ contractVersion: CV, ok: true, preview: { operation, input }, auditId: crypto.randomUUID() });
  try {
    // dedupe + commit in ONE transaction keyed by idempotencyKey (§3.3)
    const { result, auditId } = await commitIdempotent(idempotencyKey, () => runOperation(operation, req.body));
    res.json({ contractVersion: CV, ok: true, result, auditId });
  } catch (err) {
    res.status(503).json({ code: 'BACKEND_UNAVAILABLE', message: String(err?.message ?? err), retryable: true });
  }
});

// /describe, /memory/get, /memory/upsert, /memory/search follow the same shape.
app.listen(8088);
```

Every response includes `contractVersion`. Fastify/Hono differ only in router
and body-parser syntax — the verification, trust gate, idempotency, and
error-mapping logic above is identical.

After porting, re-run the conformance runner against your server — it validates
responses against the *same* zod schemas the runtime uses:

```bash
cd container/agent-runner && pnpm exec tsx scripts/gateway-conformance.ts http://localhost:8088
GATEWAY_STRICT_RESPONSES=true pnpm exec tsx scripts/gateway-conformance.ts http://localhost:8088   # fail on any drift
```

---

## 5. Pre-production checklist

- [ ] All six endpoints return the contract shapes — conformance green, including `GATEWAY_STRICT_RESPONSES=true`.
- [ ] Writes gated on `requesterSource === 'session'` as a first line; `agent-asserted` is read-only at most. **But `requesterSource` is forgeable by a compromised container (residual risk R5) — for damaging writes, also anchor authorization on backend-side principal verification and/or user approval, not on `requesterSource` alone (§3.1).**
- [ ] `/authorize` runs your real permission policy and returns `obligations: ['user-confirmation']` for human-sign-off ops (§3.2).
- [ ] `/execute` dedupes on `idempotencyKey` in the same transaction as the write; `dryRun` never commits (§3.3).
- [ ] Every `/execute` returns an `auditId` your backend also logs (§3.4).
- [ ] HMAC verified against the **raw** body, with clock-skew window **and** nonce replay cache (§3.5).
- [ ] Failures return structured `{code, retryable}` or the right HTTP status; transient → 5xx (retryable), permission → 403 (§3.6).
- [ ] `/memory/search` scopes results by namespace + subject so one user can't recall another's records (ADR-0033).

## See also

- [`examples/reference-gateway/`](../examples/reference-gateway/) — the runnable skeleton this guide adapts.
- [`docs/enterprise-erp-gateway.md`](enterprise-erp-gateway.md) — the full contract reference.
- [`docs/configuration-reference.md`](configuration-reference.md) — `backendGateway` fields in `container.json`.
- [`docs/decisions/README.md`](decisions/README.md) — ADR-0018 (signing), ADR-0033 (recall isolation), ADR-0034 (host signing proxy), ADR-0028 (contract hardening).
