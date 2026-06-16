# Examples

Worked reference setups that show how to put a real business on top of the
platform. **None of this is loaded by default** — the baseline ships a single
blank template frontdesk and no workers. These directories are here to copy
from, not to run as-is.

## How a group folder becomes a live agent

Agent group working directories live under `groups/` at runtime and are
created by the bootstrap script (`scripts/init-enterprise-topology.ts`) or by
an admin agent. An example here is just a `groups/<folder>/` payload you can
copy in:

```bash
# 1. Copy an example into your live groups dir under whatever folder name you want
cp -r examples/lab-frontdesk groups/my-frontdesk

# 2. Register it + wire a channel (see the init script header for all flags)
pnpm exec tsx scripts/init-enterprise-topology.ts \
  --frontdesk-folder my-frontdesk \
  --frontdesk-name "My Front Desk" \
  --channel feishu --platform-id <chat-id>

# 3. Point it at your backend gateway
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url https://your-gateway.example.com/api/agent \
  --folders my-frontdesk
```

## What's here

| Example | What it demonstrates |
|---|---|
| [`reference-gateway/`](reference-gateway/) | A **runnable backend gateway** — a zero-dependency Node server that answers all six contract endpoints with conformance-passing shapes. Start it, point a group at it, and the gateway tools work end to end. The executable companion to `docs/enterprise-erp-gateway.md`. |
| [`lab-frontdesk/`](lab-frontdesk/) | A self-contained frontdesk that talks to a backend gateway directly (no worker pool). Originally a lab-automation assistant; a good template for a single-desk deployment with a rich domain prompt. |
| [`echo-channel/`](echo-channel/) | A **fork-free channel extension** (ADR-0031): a minimal in-memory channel adapter you drop into `EXTENSIONS_DIR` to add a channel without forking the repo. See also `docs/channels/writing-a-channel.md`. |
| [`multi-tenant/`](multi-tenant/) | **Org isolation walk-through** (ADR-0052): a runnable, self-checking demo (`tsx examples/multi-tenant/demo.ts`, in-memory DB) that sets up two tenants and asserts a user in org A can't reach org B. The readable companion to the `scripts/org.ts` operator CLI. |

## Worked walk-through: a frontdesk → worker topology on the reference gateway

The headline platform shape is `frontdesk → worker → backend gateway`. Here is
that whole path stood up from scratch, using the real bootstrap script and the
runnable [`reference-gateway/`](reference-gateway/). Every command below runs
against trunk as-is.

**1. Build the agent image** (first deploy only — the runner runs in a container):

```bash
pnpm install
pnpm container:build
```

**2. Start the reference gateway** (in its own terminal; in-memory, no setup):

```bash
node examples/reference-gateway/server.mjs
# → reference-gateway listening on http://localhost:8088
```

**3. Bootstrap a frontdesk + two workers.** The first frontdesk is "primary": it
gets the worker pool wired as agent-to-agent destinations, and the workers get a
reverse `frontdesk` destination. `pnpm init:enterprise` with `--workers`:

```bash
pnpm exec tsx scripts/init-enterprise-topology.ts \
  --workers access-worker,finance-worker
```

This creates `groups/agentdesk-frontdesk` (classify + delegate prompt),
`groups/agentdesk-access-worker`, and `groups/agentdesk-finance-worker` — each
with conservative default container resource caps and `a2aSessionMode=root-session`
(so a delegated worker sees the originating employee's context, not a shared
worker-global one).

**4. Point all three groups at the reference gateway:**

```bash
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url http://localhost:8088 \
  --folders agentdesk-frontdesk,agentdesk-access-worker,agentdesk-finance-worker
```

This writes `backendGateway.baseUrl` + `memoryMode=gateway` into each group's
`container.json`. (Add `--signing-key "$GATEWAY_SIGNING_KEY"` once your gateway
verifies HMAC — and start the reference gateway with the same key.)

**5. Verify the contract before sending traffic:**

```bash
cd container/agent-runner
pnpm exec tsx scripts/gateway-conformance.ts http://localhost:8088   # → All 6 endpoints conformant.
cd ../..
```

**6. Wire a channel and start the host.** For local testing, the `cli` channel
needs no credentials; for Feishu, add `--channel feishu --platform-id oc_xxx` to
the init command above (and the Feishu env vars from `.env.example`). Then:

```bash
pnpm dev
```

**What happens when a message arrives** (the path the topology above realizes):

1. The channel adapter hands the inbound message to the host router.
2. The router resolves the sender to a **user-scoped session** on the frontdesk
   group (`per-user` / `per-user-per-thread` for a shared surface), writes it to
   that session's `inbound.db`, and wakes the frontdesk container.
3. The frontdesk agent calls `classify_intent`, then **delegates** to the right
   worker (`access-worker` / `finance-worker`) via an agent-to-agent message.
   The host copies the originating employee's `origin_user_id` onto the worker's
   inbound row, so identity does not drift across the hop.
4. The worker calls the **backend gateway** tools — `gateway_authorize` /
   `gateway_execute` / `gateway_memory_*` — which hit the reference gateway on
   `:8088`. Each call carries `requesterSource='session'` (host-derived, not
   agent-asserted), so the gateway's mutating-op gate permits the write.
5. The worker returns a result to the frontdesk; the frontdesk replies to the
   user through the originating channel.
6. Every gateway call lands one row in the central DB's `gateway_audit` table:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT occurred_at, user_id, path, operation, status FROM gateway_audit ORDER BY id DESC LIMIT 20"
```

For a single-desk variant (one capable frontdesk that calls the gateway directly
with no worker pool), copy [`lab-frontdesk/`](lab-frontdesk/) instead of running
`--workers`, and point it at the same reference gateway.
