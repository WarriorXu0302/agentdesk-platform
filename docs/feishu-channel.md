# Feishu Channel

AgentDesk now includes a built-in `feishu` channel adapter intended for the
enterprise frontdesk pattern:

- one visible Feishu bot
- per-user or per-user-per-thread session isolation in shared chats
- frontdesk -> worker delegation behind the bot

## Required environment

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

Optional:

```bash
FEISHU_EVENT_MODE=webhook
FEISHU_ENCRYPT_KEY=xxx
FEISHU_VERIFICATION_TOKEN=xxx
FEISHU_BOT_OPEN_ID=ou_xxx
FEISHU_BOT_NAME=Frontdesk Bot
FEISHU_WEBHOOK_PATH=/webhook/feishu
WEBHOOK_PORT=3000
```

`FEISHU_BOT_OPEN_ID` is strongly recommended for shared-group mention routing.
Without it, DM works, but group mention detection can only fall back to the
configured bot name.

## Event modes

`FEISHU_EVENT_MODE` supports:

- `webhook`
- `long-connection`
- `hybrid`

Behavior:

- `webhook`: current default, HTTP callback only
- `long-connection`: receive `im.message.receive_v1` over Feishu's long connection
- `hybrid`: start the long connection client and also keep webhook callbacks

Use `long-connection` or `hybrid` when your Feishu app is configured to use
the official long-connection event subscription mode.

For the enterprise frontdesk pattern, these runtime flags are also useful:

```bash
ENTERPRISE_FRONTDESK_FOLDER=agentdesk-frontdesk
ENTERPRISE_AUTO_WIRE_CHANNELS=feishu
ENTERPRISE_AUTO_WIRE_P2P=true
ENTERPRISE_AUTO_WIRE_GROUPS=false
ENTERPRISE_AUTO_WIRE_GROUP_SESSION_MODE=per-user
```

## Webhook surface

Configure Feishu event delivery to the AgentDesk host:

- path: `FEISHU_WEBHOOK_PATH` or `/webhook/feishu`
- port: `WEBHOOK_PORT` or `3000`

Webhook mode requires `FEISHU_ENCRYPT_KEY`. The adapter verifies
`x-lark-signature` before it parses the JSON body, and it accepts encrypted
webhook payloads.

Long-connection mode does not require a public callback URL for message
events, but webhook callbacks are still useful for interactive card actions.

## Event support

Current scope:

- `im.message.receive_v1`
- `card.action.trigger`
- `url_verification`

## Session identity model

- group chat inbound -> `platform_id = feishu:<chat_id>`
- p2p inbound -> `platform_id = feishu:p2p:<open_id>`

That synthetic p2p mapping is intentional. It keeps host-initiated DM delivery
and user-initiated DM replies on the same AgentDesk messaging-group/session key.

With `ENTERPRISE_AUTO_WIRE_P2P=true`, the first DM from a Feishu user is
auto-routed to the configured frontdesk agent group with an isolated DM
context. No channel-owner approval step is required.

## Roster directed messages (opt-in, ADR-0023)

A platform-generic capability that lets an agent privately message a participant
who has **explicitly consented** to be reached, scoped to a conversation lane
(a "scope" — the session's root lane). Default **OFF**; enable per agent group
with `ALLOW_ROSTER_DM=true` (read from the group's `container.json` `env`, then
process env, then `.env`).

Enabling requires the group to run `a2aSessionMode: "root-session"` — a
roster-DM-enabled group on `agent-shared` mode is rejected at enable time, so a
single unguessable per-scope key can't be shared across conversations.

### Two consent sources — and only two

1. **p2p-ingress** — the participant sends the bot a **direct (p2p) message**
   carrying a roster opt-in payload (`{"kind":"roster.optin","scopeId":...,
   "slotLabel":...,"agentGroupId":...}`). The participant's `open_id` is taken
   from `sender.sender_id.open_id` of *that* inbound event.

2. **directed-card** — the participant clicks a card whose action value is a
   roster opt-in AND whose `expectedUserId` is set to their **own member
   `open_id`**. The click is validated fail-closed (`cardActionOperatorAllowed`):
   an empty `expectedUserId` (anyone-can-click) mints **no** consent.

In both cases `participant_open_id` and `dm_platform_id` are derived **atomically
from the same `open_id`** and asserted to round-trip to `feishu:p2p:<open_id>`.
`union_id` / `user_id` / `chat_id` (`oc_*`) are rejected — the target must be a
p2p `open_id` (`ou_*`).

### Group chats record intent only

A roster opt-in arriving in a **group** chat records an intent log line and
mints **nothing** — it never creates a p2p messaging group from `chat_id`
(no group-context → p2p channel minting).

### Delivery

The agent emits a `kind='roster'` outbound row addressing a **slot label** (in
the content JSON `slot` field), never a concrete destination. The host gate
(`src/delivery.ts` `deliverRosterMessage`) reverse-looks-up the grant by
`(scope_id, slot_label)`, re-checks revoke/expiry/consent-source/`max_sends` and
a multi-key rate limit **inside the same critical section as the send (every
retry too)**, then **overwrites** the routing fields from the grant. A container
that writes a raw `feishu:p2p:ou_*` (on a roster row or, while the flag is on, a
plain channel row) is rejected. Roster rows may not carry `deliver_after` /
`recurrence`. Every decision (delivered and rejected) is written to `dm_audit`.

Scope teardown: when the scope's root session is archived, all of its grants are
revoked (`revokeScope`), so any not-yet-delivered roster row fails on its next
drain tick.

## Current limitations

- outbound reactions are not implemented yet
- attachments are summarized as filenames in text replies for now
- long connection only covers event subscriptions; card-action callbacks still
  benefit from webhook or hybrid mode
- no interactive setup wizard yet; use Feishu's own app tooling/CLI and wire
  AgentDesk with env vars
