# AgentDesk Agent Platform Specification

## Overview

AgentDesk is an enterprise-oriented multi-user agent platform.

> The brand is configurable. The default display name is `AgentDesk` and the machine namespace is `agentdesk` (override via `BRAND_NAME` / `BRAND_NAMESPACE`). This spec uses the defaults.

Its primary deployment model is:

```text
Feishu / CLI
  -> frontdesk agent
  -> user-scoped session
  -> worker agents
  -> backend gateway
  -> ERP / approval / permission systems
```

The platform is responsible for message ingress, session isolation, agent routing, tool execution, and reply delivery. Business authorization, approval policy, audit, and long-term memory are intentionally pushed to the backend gateway layer.

## Product Positioning

AgentDesk is not a generic personal assistant shell.

It is designed for:

- multiple employees sharing one enterprise bot entrypoint
- per-user context isolation by default
- frontdesk-to-worker delegation
- Feishu-first enterprise deployment
- backend-gateway-backed authorization and memory

It is not designed to encode backend-specific business rules inside the model runtime.

## Core Components

### Host

The host is a Node.js process that owns:

- the central SQLite database
- inbound routing
- outbound delivery
- session lifecycle
- enterprise auto-wiring
- worker spawning

### Channels

Channels adapt external messaging systems into the platform routing model.

Current baseline channels:

- `feishu`
- `cli`

Feishu supports:

- private chat
- group chat
- `@bot` mentions
- long-connection event delivery
- webhook callbacks
- reaction-based progress status

### Frontdesk Agent

The frontdesk agent is the enterprise entrypoint.

Responsibilities:

- receive employee requests
- interpret intent
- decide whether to answer directly or delegate
- route work to worker agents
- preserve the employee's session boundary while delegating

The frontdesk should not become the permanent owner of business permissions. It may ask for authorization context, but the final decision belongs to the backend gateway.

### Worker Agents

Workers execute bounded business capabilities such as:

- access control queries
- sales lookups
- finance tasks
- approval assistance
- operations support

Workers can be called through agent-to-agent routing and can inherit the caller's root session context when configured with `a2aSessionMode=root-session`.

### Agent Runner

Each active session runs inside an isolated containerized agent runner. The runner owns:

- model provider integration
- MCP tools
- workspace-local notes
- session transcript handling

The host and runner communicate through per-session SQLite files and filesystem signals, not direct process IPC.

### Backend Gateway

The backend gateway is the stable backend contract between AgentDesk and any concrete business system (e.g. ERP, CRM, ticketing).

Recommended endpoints:

- `POST /describe`
- `POST /authorize`
- `POST /execute`
- `POST /memory/get`
- `POST /memory/upsert`

This layer should own:

- user mapping
- permission checks
- approval checks
- idempotency
- audit logging
- long-term memory persistence
- backend-specific schema translation

## Session Isolation Model

### Private Chat

Private chat should default to one isolated session per employee. Employee A and employee B must not share context.

### Group Chat

Group chat should usually run in one of these modes:

- `per-user`
- `per-user-per-thread`

This keeps each employee's context isolated even inside the same group. The group itself is treated as a coordination surface, not a trust boundary for sensitive writes.

### Worker Session Mode

For enterprise delegation, worker groups should normally use:

```text
a2aSessionMode=root-session
```

This means the delegated worker sees the same root employee context that originated the request, rather than a shared worker-global conversation.

## Memory Model

AgentDesk has two memory layers.

### Short-Term Working Memory

Short-term context lives in the current session history and container workspace. This is useful for ongoing reasoning and temporary notes.

### Long-Term Business Memory

Long-term business memory should use:

```text
memoryMode=gateway
```

In this mode, durable memory is stored behind the backend gateway instead of the agent workspace. Recommended records include:

- user preferences
- business summaries
- approval history
- permission hints
- structured customer or task context

## Message Flow

Typical private-chat flow:

1. Feishu sends a message event to AgentDesk.
2. The router resolves the sender, conversation, and session scope.
3. Enterprise autowire connects the sender to `agentdesk-frontdesk` if needed.
4. The frontdesk session is woken and processes the request.
5. If needed, frontdesk delegates to a worker agent.
6. The worker uses backend gateway tools for authorization, execution, or memory.
7. The final reply is delivered back through Feishu.

## Concurrency Model

AgentDesk scales through session-level isolation:

- different users map to different sessions
- each active session can wake its own agent runner
- frontdesk can delegate work to multiple worker agents
- reaction-based progress avoids sending noisy placeholder text

This is the basis for enterprise concurrency. The platform should scale by increasing session and worker parallelism, not by sharing one global agent context across all employees.

## Security Boundaries

Security is intentionally layered:

- channel layer: message origin and basic routing
- session layer: user-scoped context isolation
- container layer: runner isolation
- gateway layer: authorization, approval, audit, long-term memory

Important rule:

High-risk writes must not rely only on chat-layer heuristics or group membership. They should require backend gateway authorization.

## Extension Model

AgentDesk is meant to be extended in three stable directions:

- channel adapters
- model providers
- backend gateway implementations

The goal is to keep the platform core generic while allowing business systems to vary behind the gateway.

## Non-Goals

AgentDesk does not try to be:

- a full ERP implementation
- a generic workflow engine
- a replacement for backend authorization
- a shared global memory for all employees

## Naming and Compatibility

The brand name and machine namespace are configurable through `BRAND_NAME` and `BRAND_NAMESPACE`. Runtime tags derived from the namespace — metric prefix, HMAC header prefix, OTEL service name, default frontdesk folder — all follow the configured value (default `agentdesk`). A small number of low-level environment variable names still carry a legacy prefix for backward compatibility; these are read as-is by the host and do not affect the configurable brand identity.
