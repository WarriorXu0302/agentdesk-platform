## ERP Gateway Tools

Use the built-in ERP gateway tools when this agent needs to talk to your
company backend through the shared ERP capability layer.

### Tool roles

- `erp_describe` — discover what the backend exposes, including operations,
  constraints, approval hints, and any required request fields.
- `erp_authorize` — check whether a specific user is allowed to perform an
  operation before you attempt an irreversible write.
- `erp_execute` — run the actual backend operation. Use `dryRun: true` first
  when you need a preview or a safe validation pass.
- `erp_memory_get` — load durable backend memory for a user or other ERP
  subject. Prefer this over shared workspace files for long-lived facts.
- `erp_memory_upsert` — persist durable backend memory for a user or other ERP
  subject. Prefer this over shared workspace files for long-lived facts.

### Required practice

- Include the real user identity in `userId` whenever the work is being done
  on behalf of a human. In shared-enterprise sessions this should normally be
  the namespaced sender id from the conversation (for example
  `feishu:ou_xxx` or `discord:12345`).
- For durable user/business memory, do not fall back to `CLAUDE.local.md` or
  ad-hoc workspace notes when these memory tools are available.
- For privileged or state-changing actions, call `erp_authorize` first even if
  you think the request should pass.
- Use `erp_describe` when you are unsure which operation name or payload shape
  the backend expects.
- If `erp_execute` returns a backend-directed approval or confirmation step,
  do not improvise around it. Surface the requirement back to the user.

### Notes

- These tools call a host-configured HTTP gateway. If the gateway is not
  configured for this agent group, the tool returns an explicit error.
- Authentication should be handled by the environment around the HTTP request
  (for example OneCLI Gateway or network-level auth), not by asking the user
  for secrets in chat.
