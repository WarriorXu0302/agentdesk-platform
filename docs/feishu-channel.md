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
- `im.chat.member.user.deleted_v1` (roster-DM leave revoke, best-effort; ADR-0023 item 11b)
- `im.chat.disbanded_v1` (roster-DM disband revoke, best-effort; ADR-0023 item 11b)

Subscribe the bot to the two `im.chat.*` events in the Feishu developer console
if you enable roster DMs and want the best-effort leave/disband revoke (the
hard guarantee is the opt-out command + the optional send-time membership
re-check below — the events only tighten the window).

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

> **The same `cardActionOperatorAllowed` gate also scopes approval cards
> (ADR-0019).** Approval flows (`requestApproval`, OneCLI credential, unknown-
> sender, channel-registration) thread the chosen approver's `open_id` onto the
> `ask_question` card via `approverExpectedUserId()`, and the render prefers that
> explicit value (`resolveAskQuestionExpectedUserId`) over the delivery-target
> derivation. So an approval card is actionable **only by the picked approver**,
> by design — not as a side effect of the DM target happening to be an `open_id`.
> A non-`open_id` approver handle falls back to the derivation rather than
> scoping to an id the gate can't match (which would reject the legit approver).

### Make the consent card self-explanatory (onboarding)

The platform only **parses** the `roster.optin` value (`scopeId`, `slotLabel`,
`agentGroupId`, `expectedUserId`, optional `expiresAt` / `maxSends`) — those keys
are an opaque scope binding, meaningless to a human. **Whoever builds the card
(the operator/gateway or the agent via `send_card`) owns the human-readable
framing**, and a bare "Allow" button with no context produces bad outcomes both
ways: people click consent without understanding what they signed up for (then
complain about DM volume), or decline defensively (and the agent can't reach
them). So build the card to answer "what am I subscribing to?" *before* the
button:

- **Render the subscription terms in the card body**, above the opt-in button —
  what will be sent, how often, and who is sending it. Add a one-line
  **rationale** ("so I can ping you when your review is ready").
- **Make the button text specific** — "Subscribe to daily product updates", not
  "Allow". The button's *action value* still carries the `roster.optin` payload;
  only the label changes.
- **Offer a way out** — mention that they can opt out anytime by sending
  `{"kind":"roster.optout","scopeId":...}` (or a directed opt-out card), so
  consenting feels reversible (see [Opt-out / leave revoke](#opt-out--leave-revoke-adr-0023-item-11)).

Example directed-card shape (member-scoped, so `expectedUserId` is the clicker's
own `open_id`):

```json
{
  "type": "card",
  "card": {
    "title": "Subscribe to QA review pings?",
    "body": "Sender: QA Frontdesk bot. You'll get a direct message when a review you own is ready — about 1–3 per day, only for your reviews. Opt out anytime.",
    "actions": [
      { "label": "Subscribe to QA review pings",
        "value": { "kind": "roster.optin", "scopeId": "scope-...", "slotLabel": "reviewer",
                   "agentGroupId": "ag-...", "expectedUserId": "ou_<this member>" } }
    ]
  }
}
```

These description/rationale strings are **informational only** — the grant's
semantics (scope, slot, expiry, send cap) come entirely from the validated
`roster.optin` value, never from the card prose. This keeps the platform generic
(it mints consent from the binding, not the marketing copy) while giving
operators the hooks to make consent legible.

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

### Agent surface — discover / send / invite (ADR-0044)

ADR-0023 (above) is the **host machine**; ADR-0044 adds the **agent-facing**
triple on top of it, all host-mediated — the container is a thin emitter and
every security-critical field is host-stamped.

- **Discover.** On every container wake (only when `ALLOW_ROSTER_DM` is on) the
  host projects the scope's *live* grants into the session's `inbound.db`
  `roster_slots` table — **only** `{slot_label, sends_remaining, expires_at}`,
  with **zero identity fields** (no `open_id`, no `dm_platform_id`, no
  `scope_id`). The container reads it into a "Roster slots you can DM"
  system-prompt section, so the agent learns which slots exist but never who is
  behind one. Revoked / expired / max-sends-reached grants drop out on the next
  wake; the send-time re-check stays authoritative for any mid-turn change.

- **Send.** `send_roster_dm({slot, text})` emits the `kind='roster'` row the
  Delivery section above describes. The tool result is opaque — it never echoes a
  resolved `open_id` / `dm_platform_id`.

- **Invite (new-contact vector — a stricter bar than send).**
  `invite_to_roster({member, slot_label})` emits a `kind='system'`
  `{action:'roster.invite', …}` intent row; the host
  `registerDeliveryAction('roster.invite')` handler decides everything and
  **builds the directed opt-in card itself** — the only place that ever builds
  one, because `captureDirectedCardConsent` trusts the `expectedUserId`/`scopeId`
  carried on the card value rather than re-deriving them. Guards, all
  fail-closed:
  1. `ALLOW_ROSTER_DM` on **and** `a2aSessionMode: "root-session"`.
  2. `scopeId` + `agentGroupId` are re-derived from the session — never read from
     the container's row.
  3. `member` must be a p2p `open_id` (`ou_*`); anything else is rejected.
  4. **One-shot per `(scope, member)`:** if *any* grant row already exists (live
     **or** revoked/opted-out) the re-invite is suppressed — a harassment guard,
     not just a rate limit. Someone who already chose (in or out) is never
     re-asked.
  5. **Membership is mandatory:** the target must be a *current* member of the
     wired origin group (`isMember === true`). **Unknown also rejects** — for a
     new-contact vector the bar is absolute (unlike the send path, which may fall
     back on unknown). An ambiguous origin (the session is not wired to exactly
     one feishu group) also fails closed.

  Plus an invite rate ledger (scope **3 / 60s** + the shared deploy daily cap),
  charged **before** the card is built/sent, and a host-stamped **24h** card
  expiry so a stale click can't mint a live grant days later. Rejections bump
  `*_roster_invite_rejected_total{reason}` and write a `dm_audit` row.

### Opt-out / leave revoke (ADR-0023 item 11)

A consented participant can stop being reached at any time:

1. **Explicit opt-out (always available, no membership source needed).** The
   participant DMs the bot a leave command — `leave`, `unsubscribe`, `opt out`,
   `退出`, `退订`, `取消` (optionally prefixed with `@bot`), or a structured
   `{"kind":"roster.optout","scopeId":...}` payload — or clicks a directed
   "exit" card. The host revokes that participant's grant. A plain-text `leave`
   (no scope) revokes the participant across **all** scopes; a scoped payload
   revokes only that scope. The participant id always comes from the inbound
   sender, so a forged `scopeId` can at most revoke the sender's **own** grant.

2. **Platform leave/disband events (best-effort).** When the bot is subscribed
   to `im.chat.member.user.deleted_v1` / `im.chat.disbanded_v1`, leaving or
   dissolving the group revokes grants that were consented **in that chat**
   (matched on the grant's recorded `origin_platform_id`). Pure p2p opt-ins have
   no origin group and are untouched by these events — they end only via
   explicit opt-out or scope teardown. Events can be missed (host downtime), so
   this is best-effort; the real backstop is item 12 below.

### Send-time membership re-check (optional, ADR-0023 item 12)

Default behavior re-checks only that the grant has not been revoked. Set
`ROSTER_VERIFY_MEMBERSHIP=true` to add a **strong** real-time check immediately
before each send: the host calls the Feishu adapter's group-members API to
confirm the participant is still in the scope's origin group.

- A definite **"not a member"** → fail-closed: the DM is dropped and the grant
  is revoked.
- **Unknown** (members API errored, or the channel can't answer) → falls back to
  the item-11 revoke paths (does NOT drop a legitimate DM on a transient blip).

A 30s membership cache collapses bursts into one API call per (group, member)
per window — so a per-participant broadcast doesn't hammer the API, at the cost
of up to ~30s of staleness on a membership change.

Trade-off: when off (the default), revocation latency depends on the opt-out
command + the best-effort leave events. Turn this on for deployments where a
participant silently leaving the source group must stop DMs within seconds.

### Gateway authorization authority (optional, ADR-0023 item 13)

By default the local `dm_grants` table is the authorization source of truth
(the documented PoC transitional state). To move the source of truth toward the
backend gateway, set `ROSTER_GATEWAY_AUTHORITY=true` AND configure the agent
group's `container.json` `backendGateway`. The host then asks the gateway
`POST <baseUrl>/authorizeDm` (HMAC-signed with the same headers as the
container's gateway calls) **before** honoring the local grant:

- Request body: `{ operation:"roster.dm.authorize", scopeId, slotLabel,
  participantOpenId, dmPlatformId, agentGroupId, channelType }`.
- The gateway must reply `{"decision":"allow"}` (optionally with an authoritative
  `target:{channelType,dmPlatformId}` override, re-validated to a `feishu:p2p:ou_*`
  p2p destination) to permit the send; anything else denies.
- **fail-closed:** an unreachable / non-2xx / malformed gateway response rejects
  the send. If you configured a gateway authority you asked to trust it.
- When the flag is off, or no gateway is configured for the group, the local
  table remains authoritative.

### Worst-case blast radius (ADR-0023 item 14)

Quantified ceilings for a single deployment with roster DMs enabled:

| Bound | Mechanism | Default | Env knob |
|-------|-----------|---------|----------|
| Addressable people per scope | `UNIQUE(scope_id, participant_open_id)` — one slot per participant; only consented participants are addressable | bounded by number of consents in the scope | — (consent-gated) |
| Sends per grant (lifetime) | per-grant `max_sends` (auto-revoke) | 0 = uncapped | set `maxSends` on the opt-in payload |
| Sends per grant / window | rate ledger `grant` key | 3 / 60s | (code default) |
| Sends per participant / window | rate ledger `participant` key | 5 / 60s | (code default) |
| Sends per scope / window | rate ledger `scope` key | 20 / 60s | (code default) |
| Sends per deployment / short window | rate ledger `deploy` key | 100 / 60s | `ROSTER_DEPLOY_WINDOW_CAP`, `ROSTER_DEPLOY_WINDOW_SEC` |
| Sends per deployment / day (tumbling, UTC boundary) | deploy daily cap | 0 = off | `ROSTER_DEPLOY_DAILY_CAP` |

All windows are AND-combined (a send must be under every key) and the ledger is
host-single-writer, so the limits survive a process restart. The deploy daily
cap is the hard blast-radius ceiling: with `ROSTER_DEPLOY_DAILY_CAP=N`, a fully
compromised agent group can emit at most N roster DMs across the whole
deployment per day (tumbling window floored to a UTC boundary; up to ~2x the cap may land across a boundary) regardless of how many scopes/participants it holds.

### Operator enablement checklist

1. Set `ALLOW_ROSTER_DM=true` for the specific agent group (its
   `container.json` `env`), and ensure that group runs
   `a2aSessionMode: "root-session"`.
2. Pick a deployment blast-radius ceiling: set `ROSTER_DEPLOY_DAILY_CAP` (and,
   if needed, `ROSTER_DEPLOY_WINDOW_CAP` / `ROSTER_DEPLOY_WINDOW_SEC`).
3. Recommended: set a per-grant `maxSends` on consent payloads so individual
   grants self-expire.
4. If silent leavers must stop DMs within seconds, set
   `ROSTER_VERIFY_MEMBERSHIP=true` and grant the bot the group-members read
   scope in the Feishu console.
5. Subscribe the bot to `im.chat.member.user.deleted_v1` and
   `im.chat.disbanded_v1` for best-effort leave/disband revoke.
6. If the backend gateway is the authorization authority, set
   `ROSTER_GATEWAY_AUTHORITY=true` and implement `POST /authorizeDm` on the
   gateway (HMAC-verified).
7. Monitor `*_roster_dm_rejected_total{reason}` — a sustained non-zero rate
   means an agent is attempting DMs it isn't entitled to.
8. Enabling the flag also exposes the agent tools `send_roster_dm` +
   `invite_to_roster` and the discovery projection (ADR-0044). `invite_to_roster`
   posts a consent card into the wired group and is bounded by its own ledger
   (scope 3 / 60s + the deploy daily cap) — monitor
   `*_roster_invite_rejected_total{reason}` alongside the send metric.

## Current limitations

- outbound reactions are not implemented yet
- attachments are summarized as filenames in text replies for now
- long connection only covers event subscriptions; card-action callbacks still
  benefit from webhook or hybrid mode
- no interactive setup wizard yet; use Feishu's own app tooling/CLI and wire
  AgentDesk with env vars
