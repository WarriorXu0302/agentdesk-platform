## Backend Gateway Tools

Use the built-in gateway tools when this agent needs to talk to the company
backend (ERP, CRM, internal API, ticketing) through the shared gateway
capability layer.

### Tool roles

- `gateway_describe` — discover what the backend exposes, including
  operations, constraints, approval hints, and any required request fields.
  Takes no parameters.
- `gateway_authorize` — check whether the current user is allowed to perform
  a named `operation` (with optional `input` payload and `context`) before
  you attempt an irreversible write.
- `gateway_execute` — run the actual backend `operation` with its `input`
  payload. Use `dryRun: true` first when you need a preview or a safe
  validation pass. Pass an `idempotencyKey` for write operations you might
  retry.
- `gateway_memory_get` — load durable backend memory for a `namespace`
  (e.g. `user.profile`). Defaults to subject `user` / the current session
  user; pass `subjectType`/`subjectId` for other subjects, and `query` to
  filter.
- `gateway_memory_upsert` — persist durable backend memory: `namespace` and
  a structured `value` are required; `merge` defaults to `true` (set `false`
  to replace the record). Prefer these memory tools over shared workspace
  files for long-lived facts.

### Required practice

- Do not pass user identity yourself. When the turn was triggered by a user
  message, the runtime resolves the requester identity (userId, channel,
  thread) from the active session and overrides anything you pass. When the
  turn has no originating user (scheduled tasks, agent-to-agent work without
  an origin user), there is no session identity: anything you pass is
  forwarded as-is with `requesterSource='agent-asserted'` and treated as
  untrusted by the backend — never fabricate a userId. In those turns,
  `gateway_memory_get` / `gateway_memory_upsert` need an explicit
  `subjectId` (the `subjectType='user'` default comes from the session user,
  which doesn't exist there).
- For durable user/business memory, do not fall back to `CLAUDE.local.md` or
  ad-hoc workspace notes when these memory tools are available.
- For privileged or state-changing actions, call `gateway_authorize` first
  even if you think the request should pass.
- Use `gateway_describe` when you are unsure which operation name or payload
  shape the backend expects.
- If `gateway_execute` returns a backend-directed approval or confirmation
  step, do not improvise around it. Surface the requirement back to the user.

### Notes

- These tools call a host-configured HTTP gateway. If the gateway is not
  configured for this agent group, the tool returns an explicit error.
- Authentication should be handled by the environment around the HTTP request
  (for example an API gateway or network-level auth), not by asking the user
  for secrets in chat.
