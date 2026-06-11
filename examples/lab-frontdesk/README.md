# Example: lab-frontdesk

A worked example of a **single self-contained frontdesk** — one agent that
receives user requests directly and calls a backend gateway itself, without
delegating to a worker pool. It originated as a lab-automation assistant
("小环"), so its `CLAUDE.local.md` is a fully fleshed-out domain prompt:
intent routing table, hardware-operation confirmation rules, memory policy,
and reply-format preferences.

Use it as a template when you want one capable desk with a deep domain prompt
rather than a frontdesk + specialist-worker topology.

## Files

- `CLAUDE.local.md` — the agent's persistent system prompt (domain identity,
  routing rules, operating constraints). This is the part worth reading as a
  reference for writing your own.
- `container.json` — per-group container config: backend gateway endpoint,
  `memoryMode: "gateway"` (durable memory goes through the gateway, not
  workspace files), resource caps.

## Notes

- `backendGateway.baseUrl` points at `http://localhost:8088` as a placeholder.
  Override it with `scripts/configure-enterprise-gateway.ts --base-url ...`
  after copying into `groups/`.
- The prompt is intentionally specific to a lab-automation domain. Treat it as
  a structural template (sections, rules, tone), not a drop-in for your
  business — rewrite the domain content for your own use case.
