# Enterprise Multi-User Pattern

AgentDesk can act as shared agent infrastructure if you keep the trust boundary in your own backend and use AgentDesk for chat ingress, session isolation, container runtime, and agent-to-agent delegation.

> The brand namespace below (`agentdesk`) is the default; override via `BRAND_NAME` / `BRAND_NAMESPACE`.

## Recommended topology

```text
Feishu / Slack / Discord bot
  -> entry agent group
  -> user-scoped session
  -> worker agent groups
  -> backend capability layer
  -> ERP / business systems
```

## Responsibilities

AgentDesk should own:

- inbound message routing
- per-user or per-thread session isolation
- containerized execution
- agent-to-agent delegation

Your backend should own:

- user identity
- authorization
- approval rules
- business-side audit

## Access evaluation & revocation timing

When does revoking a role actually take effect? The honest answer has three
parts — important for offboarding and incident response:

- **Inbound admission is re-checked on every message.** The router evaluates the
  access gate (`canAccessAgentGroup` — owner / admin / group member) per inbound
  event, *before* it resolves or creates the session (`src/router.ts`
  `routeInbound` → access gate → session write). So on a role-gated group,
  **`revokeRole()` blocks that user's very next message** — revocation is
  effectively real-time for *getting in*. It is not a "checked once at session
  creation" model.
- **But the platform does not proactively tear down a running session.** No push
  revocation: a turn already in flight completes, and the user's container
  lingers until idle-exit / `AGENTDESK_SESSION_TTL_DAYS`. The revoked user simply
  can't feed it new input. If you need hard mid-turn termination, that's an
  operator action (kill the container / archive the session).
- **A `public` messaging group does not gate on membership at all** (by design —
  `unknown_sender_policy='public'` admits anyone). Role revocation has no effect
  on who can *message* a public group; gate sensitive behaviour behind the
  backend gateway there, not group membership.

For **business-action authorization** (not just message admission), the
enforcement point is your backend gateway: `gateway_authorize` / `gateway_execute`
are evaluated per call against live backend state, so a revocation reflected in
your backend takes effect on the **next sensitive action**, independent of
session lifecycle. Real-time policy belongs there (see
[enterprise-erp-gateway.md](enterprise-erp-gateway.md)); the platform's
session-level gate is admission control, not a substitute for per-action authz.

> Optional, off by default: if a deployment needs the platform itself to hard-stop
> in-flight sessions on revocation, that would be an explicit opt-in
> (`revoked_at` column + active-session teardown) with a documented cost — it is
> deliberately not the default, because per-action gateway authz already covers
> the security-critical case.

## Escalation to a human (ADR-0038)

In a mixed AI/human deployment the frontdesk sometimes needs to hand a request
*out* of the AI flow to a person. That is distinct from delegating to another
worker agent, and the platform makes it **explicit and observable** rather than
letting it look like any other a2a message.

The agent calls the `escalate_to_human` tool with a `reason` and an `urgency`
(`low|medium|high|critical`). The platform then **records** the escalation —
nothing more:

- a `classification_log` row with `action='escalate'` (+ `escalation_reason`,
  `urgency_level`);
- an `enterprise_audit` `agent_escalation` row (the durable governance record,
  carrying the full reason + the host-trusted actor);
- the `agentdesk_escalation_total{reason,urgency,outcome}` metric, so handoff
  rate and urgency mix are visible (vs. being invisible inside plain a2a).

**What the platform does NOT do** — and why that's correct: it does not route
the escalation to a specific person, apply queue priority, or run SLA timers.
Those are business policy and belong to **your backend gateway**, which reads
the audit row and decides. Critically, `urgency_level` is agent-supplied and
therefore *untrusted* — it is recorded for observability only and **never**
drives any core routing or priority decision (a prompt-injected agent must not
be able to jump a human queue by claiming `urgency='critical'`). The actor on
the audit row is the host-established session owner, not an agent-claimed id.

To wire the human side, have your gateway/tooling watch for `agent_escalation`
audit rows (or `action='escalate'` in `classification_log`) and route/page/
ticket accordingly:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT occurred_at, actor, details FROM enterprise_audit
     WHERE event_type='agent_escalation' ORDER BY id DESC LIMIT 20"
```

## Session modes for shared bots

- `shared`: one session per chat surface. Best for 1:1 DMs where each user already has a distinct messaging group.
- `per-user`: one session per sender in a shared chat.
- `per-user-per-thread`: one session per sender and thread in a shared chat.
- `agent-shared`: one shared conversation across several channels. Useful for webhook + operator-room pairings, not for multi-user private work.

## Suggested frontdesk / worker pattern

### Entry agent

- Keep one visible bot identity per platform.
- Wire shared channels to the entry agent with `per-user` or `per-user-per-thread`.
- Let the entry agent classify, ask follow-up questions, and delegate.

### Worker agents

- Create durable specialist agent groups like `sales`, `finance`, `approvals`, `research`.
- Delegate through agent destinations.
- Treat each user-scoped session as the concurrency boundary.

## Group safety boundary

For enterprise use, assume groups are low-trust surfaces:

- allow explanations, previews, and coordination
- avoid direct irreversible writes
- move sensitive confirmations into DM or approval-card flows

That keeps the visible chat lightweight while the real action still happens in isolated sessions and backend-enforced business flows.

## Bootstrap the topology

AgentDesk includes a bootstrap script for this shape:

```bash
pnpm exec tsx scripts/init-enterprise-topology.ts
```

By default that creates or reuses a single blank template frontdesk:

- `agentdesk-frontdesk`

No business workers are created by default. To add workers, pass `--workers` with the names you want — for example `access-worker,sales-worker,finance-worker,approval-worker,ops-worker`:

```bash
pnpm exec tsx scripts/init-enterprise-topology.ts \
  --workers access-worker,sales-worker,finance-worker
```

Worker folders are created as `<namespace>-<name>` (e.g. `agentdesk-finance-worker`). The script also seeds starter `CLAUDE.local.md` instructions and wires frontdesk `<->` worker destinations.

To wire a shared entry channel at the same time:

```bash
pnpm exec tsx scripts/init-enterprise-topology.ts \
  --channel feishu \
  --platform-id oc_xxx \
  --group-name "AgentDesk Frontdesk" \
  --threaded
```

For Feishu specifically, this repo now ships a built-in `feishu` adapter.
See [feishu-channel.md](feishu-channel.md) for the runtime env and webhook
contract.

If your Feishu app is configured with the platform's long-connection event
subscription mode, set:

```bash
FEISHU_EVENT_MODE=long-connection
```

Or keep:

```bash
FEISHU_EVENT_MODE=hybrid
```

when you still want webhook callbacks available for interactive cards.

Defaults for shared entry wiring:

- group surface: `mention-sticky`
- session mode: `per-user`
- threaded group surface: `per-user-per-thread`
- DM surface (`--dm`): `shared`

### Default container resource caps

`init-enterprise-topology` also seeds conservative Docker resource caps
into each new group's `container.json`, so a runaway worker can't
exhaust host memory or fork-bomb the kernel:

| Role      | memoryMb | cpus | pidsLimit |
|-----------|----------|------|-----------|
| frontdesk | 768      | 1    | 384       |
| worker    | 1024     | 1    | 512       |

Only written when `resources` is absent — hand-tuned caps survive
script reruns. Raise / lower them in `groups/<folder>/container.json`
based on what the worker actually does (e.g. `agent-browser` workers
typically need 2048 MB).

The script is intentionally infra-only. It does not implement backend auth, role resolution, or business permissions. Those still belong in your backend capability layer.

## Runtime auto-ingress for Feishu

If you want the first employee DM to land on `agentdesk-frontdesk`
without an owner approval step, enable the enterprise autowire policy:

```bash
ENTERPRISE_FRONTDESK_FOLDER=agentdesk-frontdesk
ENTERPRISE_AUTO_WIRE_CHANNELS=feishu
ENTERPRISE_AUTO_WIRE_P2P=true
ENTERPRISE_AUTO_WIRE_GROUPS=false
ENTERPRISE_AUTO_WIRE_GROUP_SESSION_MODE=per-user
```

Behavior:

- first Feishu p2p message auto-creates the messaging group
- that DM is auto-wired to `agentdesk-frontdesk`
- the wiring is `pattern='.'`, `session_mode='shared'`
- `unknown_sender_policy` is forced to `public`

This is deliberate. The trust boundary moves out of AgentDesk's owner/member
ACL and into your backend gateway, where `gateway_authorize` / `gateway_execute` can
map the Feishu user, check permissions, and audit the business action.

If you later enable `ENTERPRISE_AUTO_WIRE_GROUPS=true`, group mentions will
wire with `mention-sticky` and `session_mode=per-user` so users keep
isolated context inside the shared chat surface.

## Generic backend pattern

To keep this portable across different backend vendors, use the built-in
backend gateway tools plus a backend HTTP gateway that implements one stable contract.

See [enterprise-erp-gateway.md](enterprise-erp-gateway.md).

To point the enterprise groups at that backend gateway:

```bash
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url https://gateway.internal/api/agent
```
