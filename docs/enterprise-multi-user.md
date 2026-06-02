# Enterprise Multi-User Pattern

FrontLane can act as shared agent infrastructure if you keep the trust boundary in your own backend and use FrontLane for chat ingress, session isolation, container runtime, and agent-to-agent delegation.

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

FrontLane should own:

- inbound message routing
- per-user or per-thread session isolation
- containerized execution
- agent-to-agent delegation

Your backend should own:

- user identity
- authorization
- approval rules
- business-side audit

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

FrontLane now includes a bootstrap script for this shape:

```bash
pnpm exec tsx scripts/init-enterprise-topology.ts
```

That creates or reuses:

- `frontlane-template-frontdesk`
- `frontlane-access-worker`
- `frontlane-sales-worker`
- `frontlane-finance-worker`
- `frontlane-approval-worker`
- `frontlane-ops-worker`

It also seeds starter `CLAUDE.local.md` instructions and wires frontdesk `<->` worker destinations.

To wire a shared entry channel at the same time:

```bash
pnpm exec tsx scripts/init-enterprise-topology.ts \
  --channel feishu \
  --platform-id oc_xxx \
  --group-name "FrontLane Template Desk" \
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

The script is intentionally infra-only. It does not implement ERP auth, role resolution, or business permissions. Those still belong in your backend capability layer.

## Runtime auto-ingress for Feishu

If you want the first employee DM to land on `frontlane-template-frontdesk`
without an owner approval step, enable the enterprise autowire policy:

```bash
ENTERPRISE_FRONTDESK_FOLDER=frontlane-template-frontdesk
ENTERPRISE_AUTO_WIRE_CHANNELS=feishu
ENTERPRISE_AUTO_WIRE_P2P=true
ENTERPRISE_AUTO_WIRE_GROUPS=false
ENTERPRISE_AUTO_WIRE_GROUP_SESSION_MODE=per-user
```

Behavior:

- first Feishu p2p message auto-creates the messaging group
- that DM is auto-wired to `frontlane-template-frontdesk`
- the wiring is `pattern='.'`, `session_mode='shared'`
- `unknown_sender_policy` is forced to `public`

This is deliberate. The trust boundary moves out of FrontLane's owner/member
ACL and into your ERP gateway, where `erp_authorize` / `erp_execute` can
map the Feishu user, check permissions, and audit the business action.

If you later enable `ENTERPRISE_AUTO_WIRE_GROUPS=true`, group mentions will
wire with `mention-sticky` and `session_mode=per-user` so users keep
isolated context inside the shared chat surface.

## Generic ERP backend pattern

To keep this portable across different ERP vendors, use the built-in ERP
gateway tools plus a backend HTTP gateway that implements one stable contract.

See [enterprise-erp-gateway.md](enterprise-erp-gateway.md).

To point the enterprise groups at that backend gateway:

```bash
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url https://erp-gateway.internal/api/agent
```
