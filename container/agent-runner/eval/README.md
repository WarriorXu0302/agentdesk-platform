# Agent eval / replay harness (ADR-0047)

A declarative regression gate for the agent-runner's **behavioral** surface —
output parsing, destination resolution, a2a **delegation routing**, batching,
reply-source fallback, thread/identity propagation.

It exists because of AgentDesk's core property: **everything is a message row**.
A seeded `inbound.db` plus the resulting `outbound.db` *is* a replayable,
assertable trajectory — so an eval is just "seed these messages, run the real
poll-loop, assert these outbound rows." No new instrumentation, no Docker.

## Run it

```bash
cd container/agent-runner
bun test eval/eval.test.ts      # or just `bun test` (CI runs the whole suite)
```

## Add a regression case

Drop a JSON file in [`cases/`](cases/) — no TypeScript needed:

```jsonc
{
  "name": "short description of the behavior under test",
  "destinations": [
    { "name": "feishu-main", "type": "channel", "channelType": "feishu", "platformId": "oc_main" },
    { "name": "finance-worker", "type": "agent", "agentGroupId": "finance-worker" }
  ],
  "messages": [
    { "id": "m1", "text": "user message", "platformId": "oc_main", "channelType": "feishu" }
  ],
  "agentResponse": "<message to=\"finance-worker\">delegated text</message>",
  "assert": [
    { "delegatesTo": "finance-worker" },
    { "outboundCount": 1 }
  ]
}
```

### Assertion vocabulary

| Assertion | Passes when |
|---|---|
| `{ "outboundCount": N }` | exactly N outbound rows were produced |
| `{ "noOutput": true }` | zero outbound rows |
| `{ "delegatesTo": "<agentGroupId>" }` | some outbound is an a2a delegation (`channel_type='agent'`) to that worker |
| `{ "deliversTo": { "platformId": "…", "channelType": "…" } }` | some outbound was delivered to that channel destination |
| `{ "textContains": "…" }` / `{ "textEquals": "…" }` | some outbound's text matches |
| `{ "inReplyTo": "<msgId>" }` | some outbound replies to that inbound |
| `{ "threadId": "<id>" }` | some outbound carries that thread id |

Each assertion object has **exactly one** key (typos fail loudly).

## Two modes

- **PLUMBING (current):** `agentResponse` is a scripted `MockProvider` output, so
  cases are deterministic and run under `bun test` with no LLM and no Docker. This
  exercises the *runner's* routing/delivery logic — including the delegation
  routing the misroute/nack feedback (ADR-0040) is about. A scripted mock cannot
  invoke MCP tools, so delegation is expressed as `<message to="worker">` against
  a `type:'agent'` destination (which the poll-loop resolves to the same
  `channel_type='agent'` row a real `send_to_agent` would).
- **QUALITY (future, opt-in):** swap in a real provider + an LLM-judge assertion
  to test *classification/answer quality* (does the frontdesk actually choose the
  right worker for this message). Same case shape; the real provider invokes the
  MCP tools the mock cannot. Keep LLM-judge prompts behind the same untrusted-data
  discipline as the memory fence (ADR-0033).

See [ADR-0047](../../../docs/decisions/ADR-0047-agent-eval-harness.md) for the
rationale and the benchmark lesson it implements.
