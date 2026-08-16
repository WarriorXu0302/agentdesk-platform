# Channel Isolation Model

AgentDesk is an enterprise multi-user platform: the primary deployment puts one
shared bot in front of many employees and keeps **each employee's context
isolated by default** (see [SPEC.md](SPEC.md) and
[enterprise-multi-user.md](enterprise-multi-user.md)). The user-scoped session
modes that deliver that — `per-user` and `per-user-per-thread` — are the
headline of this doc; see [User-Scoped Sessions](#user-scoped-sessions-the-enterprise-default)
below.

Underneath that, AgentDesk decouples messaging channels from agent groups: when
you wire a channel (Feishu, CLI, or an installed adapter) you also decide how it
relates to your agent groups. That channel ↔ agent-group relationship has three
isolation levels, described next. The user-scoped modes layer on top of them to
give per-employee isolation inside a single shared surface.

## The Three Channel ↔ Agent-Group Levels

### 1. Shared Session

Multiple channels feed into the same conversation. The agent sees all messages from all channels in one thread.

**What's shared:** Everything — workspace, memory, CLAUDE.md, and the conversation itself. A GitHub PR comment and a Slack message appear side by side in the agent's context.

**Example:** A Slack channel paired with GitHub webhooks. The agent receives PR review requests via GitHub and discusses them in Slack — all in one session. When someone comments on a PR, the agent can reference the earlier Slack discussion about that feature.

**When to use:** When one channel feeds context into another. Webhook/notification channels (GitHub, Linear) paired with a chat channel (Slack, Discord) are the classic case.

**Technical:** Both messaging groups are wired to the same agent group with `session_mode: 'agent-shared'`. Session resolution looks up by agent group ID only, ignoring the messaging group — so all channels converge on one session.

---

### 2. Same Agent, Separate Sessions

Multiple channels share the same agent (same workspace, memory, personality) but have independent conversations.

**What's shared:** Workspace, memory, CLAUDE.md, and all persistent state. If you tell the agent something in one session, it can save that to memory and recall it in another. The agent's personality, knowledge, and tools are identical across sessions.

**What's separate:** The conversation thread. Messages from one channel don't appear in the other channel's session. Each channel has its own context window and conversation history.

**Example:** One support agent group is wired to several team rooms — one per department. All rooms share the same agent workspace and memory, so a fact stored in one (e.g. a backend operation naming convention) can be recalled in another, but each room's conversation stays independent.

**When to use:** When the same audience (or a trusted set of operators) spans several surfaces and you want one unified agent identity with shared memory but separate conversation threads.

**Technical:** Multiple messaging groups are wired to the same agent group with `session_mode: 'shared'` (or `'per-thread'`). Each messaging group gets its own session, but they all run in the same agent group folder.

> Note: this level isolates by **channel/room**, not by **sender**. Two
> different employees writing in the _same_ room share one session here. For an
> enterprise bot where many employees share one surface and must not see each
> other's context, use the user-scoped modes below — that is the platform
> default, not this level.

---

### 3. Separate Agent Groups

Each channel gets its own agent with its own workspace, memory, and personality. Nothing is shared.

**What's shared:** Nothing. The agents don't know about each other. Different CLAUDE.md, different memory, different workspace, different conversation history.

**Example:** You have a Telegram group with a friend and a Discord server for a team project. The friend shouldn't know what you discuss with your team, and vice versa. Each gets its own agent with its own memory and personality.

**When to use:** When different people are involved, or when the information in one channel should never leak to another. This is the right choice whenever there's a privacy or confidentiality boundary between channels.

**Technical:** Each channel is wired to a different agent group, each with its own folder under `groups/`. Separate containers, separate session databases, separate everything.

---

## How to Decide

The key question: **Are you okay with any and every piece of information from one channel being available in the other?**

- **No** → Separate agent groups (level 3)
- **Yes, and the channels should see each other's messages** → Shared session (level 1)
- **Yes, but the conversations should be independent** → Same agent, separate sessions (level 2)

### Rules of Thumb

| Scenario                                                                       | Recommended Level / Mode                                                      |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **Shared enterprise bot, many employees, one surface**                         | **User-scoped: `per-user` / `per-user-per-thread`** (the default — see below) |
| One agent group fronting several team rooms (same trusted audience)            | Same agent, separate sessions                                                 |
| Webhook channel + ops-room chat channel (notifications feed context into chat) | Shared session                                                                |
| Two business units that must never see each other's context                    | Separate agent groups                                                         |
| Frontdesk desk and a sensitive worker with different access levels             | Separate agent groups                                                         |

### When in Doubt

If many distinct **end users** share one surface → use a user-scoped mode (`per-user` / `per-user-per-thread`). This is the enterprise default.

If the channels serve the **same trusted audience** → the same agent group is usually fine.

If a hard confidentiality boundary divides the audiences → separate agent groups. Information will cross-pollinate through agent memory if you don't.

## User-Scoped Sessions (the enterprise default)

The three levels above isolate by **channel ↔ agent group**. For the platform's
primary use case — one shared bot in front of many employees — that is not
enough on its own: one bot may sit in a single chat surface while still needing
a separate context **per sender**.

AgentDesk supports two user-scoped `session_mode` values for that case:

- `per-user` — one session per `(agent_group, messaging_group, user)`
- `per-user-per-thread` — one session per `(agent_group, messaging_group, user, thread)`

Use these when:

- many employees share one entry bot
- you want the same agent (template, config, skills) but a **separate workspace,
  memory, and conversation state per person**
- group chat is only a coordination surface and execution should not share context

**State isolation (ADR-0055):** a user-scoped session mounts a per-user _state
scope_ — its own `/workspace/agent` (working files, `CLAUDE.local.md` memory,
`conversations/` transcripts) and its own `/home/node/.claude` (Claude state,
auto-memory) under `data/v2-scopes/<agent_group>/<user>/`. Config and composed
artifacts (`container.json`, `CLAUDE.md`, operator-seeded `instructions.md`,
`prompts/`) stay group-level as read-only mounts; skill **content** is a shared
read-only mount (`/app/skills`) while the group's skill **selection** is synced
as symlinks into each scope's own Claude state dir at spawn. So per-user modes isolate **workspace and memory per
person**, not just conversation state; ownerless modes (`shared`, `per-thread`,
`agent-shared`) keep the historical group-level layout, where memory sharing is
the documented feature. The same-user scope is shared across that user's
sessions and threads — memory follows the person, not the chat room — and
root-session a2a lanes inherit the owner, so per-user isolation propagates
through delegation.

Recommended defaults:

- 1:1 DM with the bot: `per-user` (each DM is its own messaging group, but
  `shared` leaves the owner unset, so every DM user's session would mount the
  GROUP state scope — all DM users of one bot sharing workspace and memory.
  `per-user` gives the person their own scope, shared with their group-chat
  lanes on the same agent; enterprise autowire wires DMs this way by default)
- shared group/channel: `per-user` or `per-user-per-thread`
- webhook + ops-room pair: `agent-shared`

## Entity Model

```
agent_groups (workspace, memory, CLAUDE.md, personality)
    ↕ many-to-many
messaging_groups (a specific channel/chat/group on a platform)
    via
messaging_group_agents (session_mode, trigger_rules, priority)
```

- **Shared session:** multiple messaging_groups → same agent_group, `session_mode = 'agent-shared'`
- **Same agent, separate sessions:** multiple messaging_groups → same agent_group, `session_mode = 'shared'`
- **Same chat, separate user contexts:** one messaging_group → same agent_group, `session_mode = 'per-user'` or `per-user-per-thread`
- **Separate agents:** each messaging_group → different agent_group

## Organization tenancy (ADR-0052)

Above the channel↔agent isolation is an optional **tenant** boundary. An
`agent_group` belongs to at most one `organization` (`agent_groups.organization_id`,
nullable — `NULL` = legacy / un-orged, no tenancy). `organizations` +
`organization_members` (membership = _reachability_, never privilege) draw the
boundary; `user_roles.organization_id` carries org-scoped grants (`org-admin`,
org-scoped `operator`/`viewer`).

```
organizations
   ↑ organization_id (nullable)        ↑ membership (reachability, not privilege)
agent_groups                        organization_members
```

Enforcement is **entirely host-side** at `canAccessAgentGroup` (and its admin /
operability / operator-query cousins): a non-platform user can reach an
org-scoped group only if they're a member of its org (`cross_org_denied`
otherwise). `owner` / `global_admin` are platform superusers **above** the
boundary. a2a delegation and channel wiring are constrained to one org; the
operator triage surface (ADR-0049) is org-scoped for a non-global actor.
sessions / messaging_groups / audit carry **no** org column — they derive org by
JOIN through their immutable `agent_group_id`, so there is no second copy to
drift, and org never enters the backend-gateway business-authz path (invariant:
the gateway is the only authorization path; org isolation is host gating only).
