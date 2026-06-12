# Observability Span Naming Schema
> **位置**：`docs/observability-span-schema.md`
> **目的**：定义本平台 manual `withSpan(...)` spans 的 binding naming + attribute governance。任何后续 PR 在新增、重命名、删除、迁移 manual spans 之前，**必须**先读这一篇。
> **状态**：v1.0（binding · 2026-05-31）
> **适用范围**：host 与 runner 的 manual spans；third-party auto-instrumentation 可共存，但不支配本平台 naming。
---
## §0. Status Block
> **Version**: `v1.0`
> **Authority**: **binding** for all manual `withSpan(...)` calls.
> **Date**: `2026-05-31`
> **Supersedes**: none（本文件是第一版 schema spec，不替代历史 runtime code）
> **Relates to**: `ADR-0011`、`ADR-0014`、`docs/observability-instrumentation-methodology.md` v1.0
> **Scope**: 只约束本平台手写 spans 的 naming / attribute contract，不重命名 third-party auto-instrumentation spans。
> **Precedence**: 若本文件与旧 prose 示例冲突，以本 schema 为准；`docs/observability-instrumentation-methodology.md` 解释 how to instrument，本文件定义 what to name and what attributes to set。
本文件是 governance spec，不是 runtime patch。
它回答三类问题：
1. span 名字应该叫什么；
2. span 至少要带哪些 OpenInference / OTel attributes；
3. 未来扩展时，namespace 如何继续长而不乱。
本版本同时吸收了：
- ADR-0011 已落地 host-side tracing 的上下文；
- methodology v1.0 关于 Phoenix / OpenInference 的方法论纪律；
- user 已批准的 5 个 schema decisions；
- Oracle review 的 5 个 critical fixes + 7 个 additions。
因此，本文件不是 brainstorming draft，也不是 advisory checklist；它是后续 span review 的 normative contract。
---
## §1. Design Goals
下面五条 goal 是本 schema 的设计北极星；任何新 span name 若不能同时满足它们，应先修正设计，再写 code。
1. **Simple, accurate, flat tags describing system events**
   - span 名称首先是统计与聚合标签，不是 sentence。
   - 它要能稳定描述“哪一类工作正在发生”，而不是“这一次具体发生了什么”。
   - 例如 `delivery.message.deliver` 描述一个 delivery class；具体 message id、channel id、thread id 必须进入 attributes。
2. **Hierarchical extensibility**
   - 本平台目前只 shipped 11 个 unique names，但未来 observability surface 会扩到 channel、agent、provider、MCP、ERP、DB、mock、hardware、GUI、python skill。
   - 命名必须天然支持新增 family，而不需要每次再发明一个全新的顶层前缀。
   - 结构上统一采用 `<subsystem>.<entity-or-operation>[.<action>]`，保证未来扩展 still legible。
3. **OTel-compliant low-cardinality naming**
   - span name 是 low-cardinality label，不得承载 IDs、timestamp、ERP operation payload、LLM model variant、device serial 等动态值。
   - OTel 的 naming guidance 关注 statistically interesting classes，而不是人类自然语言可读句子。
   - 这意味着有时“少一点信息”反而更对，因为它可聚合、可采样、可比对。
4. **OpenInference-compatible: every span has `openinference.span.kind`**
   - Phoenix 不是 generic trace viewer；它会用 `openinference.span.kind`、`session.id`、`input.value`、`output.value`、`tool.*`、`llm.*` 等语义键去渲染 LLM-native UI。
   - 所以 naming schema 不能与 attribute schema 分离；否则 name 统一了，Phoenix 还是碎的。
   - 本文件在 §5 authoritative 地定义 required attribute matrix。
5. **Phoenix-grouping-friendly root placement**
   - 名字本身不只为了 grep，它还服务 trace topology。
   - session traces 必须有稳定的 root placement，才能让 Phoenix Sessions 把同一会话的人类输入 / AI 输出正确连成时间线。
   - 因此 `router.deliver_to_agent` 被锁定为 current session-trace root；pre-session spans 与 session trace 分离处理，见 §5b。
这五条 goal 共同约束一个核心判断：
> **一个好的 span name = 可扩展的层级 + 可聚合的 low-cardinality + Phoenix 可理解的语义入口。**
---
## §2. Naming Grammar
### 2.1 Canonical grammar
- `<span-name> = <subsystem> "." <entity-or-operation> ["." <action>]`
- `<subsystem> = lowercase ALPHA *(ALPHA / DIGIT / "_")`
- `<entity-or-operation> = lowercase ALPHA *(ALPHA / DIGIT / "_")`
- `<action> = lowercase ALPHA *(ALPHA / DIGIT / "_")`
本 grammar 的含义是：
- 第 1 段回答“这个 span 属于哪个 subsystem / namespace”；
- 第 2 段回答“该 subsystem 下被观测的 entity 或 coarse operation 是什么”；
- 第 3 段（若存在）回答“正在做的动作是什么”。
### 2.2 Hard rules
1. **2-3 segments only**
   - `router.route` ✅
   - `delivery.message.deliver` ✅
   - `mcp.erp.approve.purchase.order` ❌（4+ segments forbidden）
2. **lowercase only**
   - `agent.turn` ✅
   - `Agent.Turn` ❌
3. **snake_case throughout segments**
   - segment 内可用 `_`，不可用 `-`。
   - `python_skill.run` ✅
   - `python-skill.run` ❌
4. **hyphen forbidden in span names**
   - span names 不是 file names。
   - file 可以是 `cancel-broker`，span slug 必须是 `cancel_broker`。
5. **present-tense / operation form only**
   - `receive`, `send`, `deliver`, `request`, `execute`, `route`, `wake`, `spawn`, `kill`, `resolve` ✅
   - `received`, `delivered`, `requested`, `executed` ❌
   - outcome 不在 name 里表达；成功/失败应写入 `status.code`、`status.message`、exception events、`<namespace>.failure.category`（默认 `agentdesk.failure.category`）。
6. **no dynamic values in names**
   - 不允许把 `session_id`、`user_id`、message id、ERP operation 参数、model name、hardware device id、timestamp、hostname 放进 span name。
   - dynamic information 必须进 attributes。
7. **no service names, model names, or device names in the span path**
   - service / hardware / model 变化通常高基数，且更适合作为 queryable attributes。
   - 用 `python_skill.name`、`hardware.device_id`、`llm.model_name`、`erp.operation` 表达，不写进 name。
8. **second segment should stay coarse**
   - `mcp.erp.execute` ✅
   - `mcp.erp.approve_purchase_order` ❌
   - 具体 tool behavior already lives in `tool.name`, `tool.parameters`, `erp.operation`。
### 2.3 Good / BAD examples
| Good | BAD | Why the BAD form is forbidden |
|---|---|---|
| `channel.feishu.receive` | `cli.event.received` | BAD：past tense + channel-as-prefix instead of unified `channel.*` family |
| `mcp.erp.execute` | `mcp.erp.approve_purchase_order` | BAD：dynamic business operation leaked into name |
| `module.cancel_broker.request` | `module.cancel-broker.request` | BAD：hyphen in segment |
| `python_skill.run` | `python-skill.run` | BAD：hyphen instead of snake_case |
| `delivery.message.deliver` | `delivery.message.delivered` | BAD：past tense |
### 2.4 Naming intent by pattern
| Pattern | Intended meaning | Typical examples | Anti-pattern to avoid |
|---|---|---|---|
| `<subsystem>.<operation>` | subsystem-level action with no extra entity layer | `router.route`, `container.wake`, `provider.request` | using prose like `router.route_inbound_message` |
| `<subsystem>.<entity>.<action>` | subsystem handling a stable entity with one action | `delivery.message.deliver`, `db.audit.write`, `module.gateway_audit.emit` | encoding payload details in the third segment |
| `mcp.<group>.<tool>` | MCP group + tool slot | `mcp.core.send_message`, `mcp.erp.execute`, `mcp.knowledge.query` | making group dynamic per ERP operation |
| `module.<slug>.<action>` | platform module registry under `src/modules/` | `module.a2a.route`, `module.permissions.check_sender` | inventing a new top-level namespace for each module |
### 2.5 Attribute placement examples
当你想把额外细节塞进 name 时，通常说明它其实应该进 attribute：
| Temptation | Correct attribute home |
|---|---|
| “我想区分 `mcp.erp.approve_purchase_order` 与 `mcp.erp.cancel_purchase_order`” | `erp.operation`, `tool.name`, `tool.parameters` |
| “我想看哪个 model 被调” | `llm.model_name`, `llm.system` |
| “我想知道哪个 Python skill service” | `python_skill.name` |
| “我想区分哪张显卡 / 哪个 camera” | `hardware.device_id`, `hardware.system`, `hardware.capability` |
| “我想知道是哪个 channel message type” | `message.kind`, `channel.type` |
### 2.6 Review checklist before merging a new name
- 这个 name 是否只有 2-3 段？
- 是否全部 lowercase？
- 是否全部 snake_case？
- 是否完全没有 hyphen？
- 是否使用 present-tense operation form？
- 是否没有 ID / timestamp / payload / model / service / operation 参数？
- 第 1 段是否来自 §3 已注册 top-level namespace？
- 第 2、3 段是否已在 §4 或后续 schema amendment 中注册？
如果其中任一答案是 “no”，不要 merge code；先 amend schema。
---
## §3. Top-Level Namespace Catalog
下表是 **authoritative top-level namespace registry**。任何 manual span 的第 1 段必须来自这 20 个 namespace 之一。
| Namespace | Domain | Default `openinference.span.kind` | Trace role | Status | Example span | Owning files |
|---|---|---|---|---|---|---|
| `channel.*` | ingress channel adapters (`cli`, `feishu`, future sanctioned channels) | `CHAIN` | pre-session ingress span；通常 own short trace | Active | `channel.feishu.receive` | `src/channels/` |
| `router.*` | inbound routing / session resolution / delegation decisions | `CHAIN` | routing spine；`router.deliver_to_agent` is current session-trace root (`AGENT` kind) | Active | `router.deliver_to_agent` | `src/router.ts` |
| `delivery.*` | outbound queue draining, message materialization, channel delivery | `CHAIN` | downstream session child spans | Active | `delivery.message.deliver` | `src/delivery.ts` |
| `container.*` | host-side container wake / spawn / kill orchestration | `CHAIN` | host infra child spans inside session trace | Active | `container.spawn` | `src/container-runner.ts` |
| `session.*` | session lifecycle governance | `CHAIN` | lifecycle spans outside or inside trace depending event source | Reserved for explicit lifecycle spans | `session.archive` | `src/router.ts`, `src/host-sweep.ts`, `src/db/` |
| `sweep.*` | periodic sweeper real-work units | `CHAIN` | maintenance trace when real work exists | Reserved with no-empty-loop guard | `sweep.run` | `src/host-sweep.ts` |
| `agent.*` | container-side agent lifecycle / turn loop | `AGENT` | runner root / child spans after context extraction | Active (ADR-0026 runner tracing) | `agent.turn` | `container/agent-runner/src/` |
| `provider.*` | LLM provider request boundary | `LLM` | model invocation span | Active (ADR-0026 runner tracing) | `provider.request` | `container/agent-runner/src/providers/` |
| `mcp.*` | MCP tool surface grouped by tool family | `TOOL` | tool invocation span | Active (ADR-0026 runner tracing) | `mcp.core.send_message` | `container/agent-runner/src/mcp-tools/` |
| `erp.*` | ERP gateway HTTP / RPC contract boundary | `TOOL` | gateway call span | Planned (gateway tracing) | `erp.call` | `container/agent-runner/src/mcp-tools/gateway.ts`, `scripts/configure-enterprise-gateway.ts` |
| `identity.*` | identity resolution / propagation / trust-chain handling | `CHAIN` | authorization-context span | Reserved | `identity.resolve` | `src/router.ts`, `src/channels/`, `src/modules/permissions/` |
| `module.*` | platform modules under `src/modules/` | `CHAIN` | module-local business child spans | Active / extensible by registry | `module.permissions.check_sender` | `src/modules/` |
| `db.*` | bounded logical aggregates only | `TOOL` | storage boundary span | Reserved with strong granularity limits | `db.session.write` | `src/db/`, `src/delivery.ts`, `src/router.ts` |
| `bootstrap.*` | startup / topology bootstrap / init flows | `CHAIN` | setup trace, not per-request trace | Reserved | `bootstrap.topology.init` | `scripts/init-enterprise-topology.ts` |
| `circuit.*` | circuit-breaker / fail-open / fail-closed control points | `CHAIN` | resilience child span | Reserved | `circuit.open` | `src/`, `container/agent-runner/src/` |
| `config.*` | config resolution / validation gates | `CHAIN` | startup or boundary validation span | Reserved | `config.resolve` | `src/`, `scripts/` |
| `mock.*` | simulation / mock cluster / test doubles | `TOOL` | synthetic external-system span | Planned (mock cluster) | `mock.erp.execute` | `scripts/`, future mock services |
| `hardware.*` | hardware-facing service boundaries | `TOOL` | external device / lab-system span | Planned (hardware skills) | `hardware.robot.execute` | future hardware services behind ERP gateway |
| `gui.*` | GUI automation service boundaries | `TOOL` | desktop/UI automation span | Planned (GUI automation) | `gui.chromeleon.run` | future GUI services behind ERP gateway |
| `python_skill.*` | Python skill service execution boundary | `TOOL` | external Python skill span | Planned (Python skill services) | `python_skill.run` | future Python skill services |
**Inventory reconciliation**：本 registry 是 **20 top-level namespaces + 1 reserved family**。
**Reserved family note**：`mcp.knowledge.*` 暂时不是第 21 个顶层 namespace；它是 `mcp.*` 之下的 reserved family，直到对 knowledge tooling 做出更高阶拆分前，都必须继续留在 `mcp.*` 内。
### 3.1 How to interpret `Status`
- **Active**：现在已经存在对应 runtime surface，或应该立即用于当前 shipped path。
- **Reserved**：namespace 已被占位并受治理，但当前实现还没大规模发 span。
- **Planned**：phase roadmap 已明确会进入 observability surface，可以提前锁定名字，避免临时命名。
### 3.2 Ownership rule
namespace ownership 不是说“只有这些文件能 emit spans”，而是说：
- 谁负责维护该 family 的 naming registry；
- 谁在 review 时对 drift 负责；
- 哪些目录的 future work 应优先使用该 namespace，而不是另造 top-level。
例如：
- channel receive spans 应由 `src/channels/` family 维护，但真正 session root placement 仍受 `src/router.ts` 约束；
- `module.*` spans 必须由对应 `src/modules/<module>/` 拥有者遵守 registry，而不是每个模块自己发明前缀。
---
## §4. Standard Sub-Operations Within Common Namespaces
本节注册常见 2nd / 3rd segment，目的是减少 future PR 的 naming judgment call。
### 4.1 `channel.*`
`channel.*` family 用于 ingress adapters 收到一个 inbound event，并准备进入 routing path。
| Namespace pattern | Allowed action(s) | Canonical examples | Notes |
|---|---|---|---|
| `channel.<channel>.receive` | `receive` | `channel.cli.receive`, `channel.feishu.receive` | 只表示 ingress receive；不在这里表达 routing outcome |
约束：
- `channel` 是固定 top-level；
- 第 2 段是 stable channel slug；
- 第 3 段一律 `receive`，不使用 `received`、`ingest`、`handle` 混写。
### 4.2 `router.*`
`router.*` family 描述 host 侧 routing spine。
| Span | Operation role | Required notes |
|---|---|---|
| `router.route` | coarse routing decision before session-bound work | pre-session span；不得承担 session root 语义 |
| `router.deliver_to_agent` | session resolution + delivery handoff | current session-trace root；root attributes belong here |
命名纪律：
- `router.container.wake` 不再是允许名字；wake 属于 `container.*` family。
- router family 不应继续往第 4 段延展；跨层动作应换 family，而不是堆叠 segments。
### 4.3 `delivery.*`
`delivery.*` family 负责 outbound work 的 materialization 与 send path。
| Span | Allowed action | Meaning | Notes |
|---|---|---|---|
| `delivery.session.drain` | `drain` | drain one session's undelivered outbound queue | 必须有 no-empty-loop guard |
| `delivery.message.deliver` | `deliver` | materialize and process one outbound message | canonical attr key is `message.kind` |
| `delivery.channel.send` | `send` | adapter sends user-visible output to channel | 常是 output-bearing span |
### 4.4 `container.*`
`container.*` family 表示 host 管理 runner container 的边界动作。
| Span | Allowed action | Meaning | Notes |
|---|---|---|---|
| `container.wake` | `wake` | attempt to reuse or wake existing runner | keep one layer only |
| `container.spawn` | `spawn` | create runner with propagated trace context | inject `OTEL_TRACEPARENT` here |
| `container.kill` | `kill` | terminate runner after controlled shutdown path | no fire-and-forget flush |
### 4.5 `session.*`
`session.*` family 预留给 lifecycle governance，不等于每次 session DB query 都打 span。
| Span | Allowed action | Meaning | Notes |
|---|---|---|---|
| `session.open` | `open` | create or activate a new logical session | use only on actual lifecycle transition |
| `session.close` | `close` | close or finalize active session | not for every idle loop |
| `session.archive` | `archive` | archive inactive session data | maintenance work only when archival actually occurs |
### 4.6 `sweep.*`
`sweep.*` family 保留给 host sweeper 的 real-work span，不允许空轮询污染 trace 列表。
| Span | Allowed action | Meaning | Notes |
|---|---|---|---|
| `sweep.run` | `run` | execute one maintenance sweep with real work | guard before span creation |
### 4.7 `agent.*`
`agent.*` family 描述 runner 内 agent lifecycle。
| Span | Allowed action | Meaning | Notes |
|---|---|---|---|
| `agent.run` | `run` | top-level runner execution unit | often container-side trace entry after context extraction |
| `agent.turn` | `turn` | one think/act/respond iteration | output-bearing when it yields user-visible result |
| `agent.cancel` | `cancel` | explicit cancellation handling | future cancel broker integration |
### 4.8 `provider.*`
`provider.*` family is intentionally coarse。
| Span | Allowed action | Meaning | Notes |
|---|---|---|---|
| `provider.request` | `request` | actual LLM request boundary | preferred canonical LLM span name |
为什么不预注册 `provider.respond` 为 canonical shipped name？
- 因为当前 primary observability boundary 是 request span；
- response details 应优先进入 `output.value`、`llm.output_messages`、token counts；
- 如未来确实需要单独 response span，必须先修 schema amendment，不可随手新增。
### 4.9 `mcp.*`
`mcp.*` family uses **exactly** `mcp.<group>.<tool>`.
| Group | Canonical tool slot | Canonical example | What goes into attributes instead |
|---|---|---|---|
| `core` | stable core tool name | `mcp.core.send_message` | message payload, recipient, attachments |
| `core` | stable core tool name | `mcp.core.send_file` | file ids, MIME details |
| `core` | stable core tool name | `mcp.core.edit_message` | edit target ids |
| `core` | stable core tool name | `mcp.core.add_reaction` | emoji, message target |
| `erp` | stable ERP gateway entry tool | `mcp.erp.execute` | `erp.operation`, business payload |
| `knowledge` | reserved family under `mcp.*` | `mcp.knowledge.query` | source ids, retrieval params |
| `gui` | future group | `mcp.gui.run_step` | application/window specifics |
| `hardware` | future group | `mcp.hardware.execute` | device ids, action payloads |
规则总结：
- 第 2 段是 MCP group；
- 第 3 段是 tool slot；
- business operation 不能塞进第 3 段；
- `tool.name` / `erp.operation` / `tool.parameters` 才是业务细节的归宿。
### 4.10 `erp.*`
`erp.*` family 不是 MCP tool name 的替代物；它表示 gateway boundary itself。
| Span | Allowed action | Meaning | Notes |
|---|---|---|---|
| `erp.call` | `call` | outbound call from the tool layer into ERP gateway | typically child of `mcp.erp.execute` |
### 4.11 `identity.*`
`identity.*` family 用于 trust-chain、session identity、user propagation。
| Span | Allowed action | Meaning | Notes |
|---|---|---|---|
| `identity.resolve` | `resolve` | resolve trusted request identity from channel/session context | use for real resolution work only |
| `identity.propagate` | `propagate` | propagate identity into downstream tool / runner context | avoid duplicate spans if pure attribute copy |
### 4.12 `db.*`
`db.*` family 只允许 bounded logical aggregates，不允许 span-per-SQL 或 span-per-table。
| Aggregate | Allowed action(s) | Canonical examples | Boundary rule |
|---|---|---|---|
| `session` | `read`, `write` | `db.session.read`, `db.session.write` | session-level logical state only |
| `outbox` | `write` | `db.outbox.write` | outbound queue persistence |
| `audit` | `write` | `db.audit.write` | business / ERP audit append |
| `identity` | `read` | `db.identity.read` | trusted identity mapping lookup |
如果某个 DB 工作只是 routine query storm，正确答案通常是 metrics，不是 new span family。
### 4.13 `module.*`
`module.*` is the sanctioned home for platform modules under `src/modules/`.
| Slug | Source dir | Actions | Canonical examples | Notes |
|---|---|---|---|---|
| `a2a` | `src/modules/agent-to-agent/` | `route`, `deliver` | `module.a2a.route`, `module.a2a.deliver` | frontdesk -> worker delegation path |
| `approvals` | `src/modules/approvals/` | `intercept`, `resolve` | `module.approvals.intercept`, `module.approvals.resolve` | approval gate and decision resolution |
| `permissions` | `src/modules/permissions/` | `check_sender`, `check_channel` | `module.permissions.check_sender`, `module.permissions.check_channel` | sender / channel policy enforcement |
| `progress_status` | `src/modules/progress-status/` | `reaction_set`, `reaction_clear` | `module.progress_status.reaction_set`, `module.progress_status.reaction_clear` | Feishu reaction progress UX |
| `scheduling` | `src/modules/scheduling/` | `trigger`, `enqueue`, `cancel` | `module.scheduling.trigger`, `module.scheduling.enqueue`, `module.scheduling.cancel` | scheduled task orchestration |
| `classification_log` | `src/modules/classification-log/` | `write` | `module.classification_log.write` | audit-like classifier trace point |
| `gateway_audit` | `src/modules/gateway-audit/` | `emit`, `flush` | `module.gateway_audit.emit`, `module.gateway_audit.flush` | backend gateway audit pipeline |
| `typing` | `src/modules/typing/` | `start`, `stop` | `module.typing.start`, `module.typing.stop` | typing indicator lifecycle |
| `provider_errors` | `src/modules/provider-errors/` | `classify`, `record` | `module.provider_errors.classify`, `module.provider_errors.record` | provider failure categorization |
| `mount_security` | `src/modules/mount-security/` | `validate`, `reject` | `module.mount_security.validate`, `module.mount_security.reject` | mount safety contract |
| `self_mod` | `src/modules/self-mod/` | `propose`, `apply` | `module.self_mod.propose`, `module.self_mod.apply` | self-mod proposal / application path |
| `interactive` | `src/modules/interactive/` | `ask`, `resolve` | `module.interactive.ask`, `module.interactive.resolve` | HITL request / resolution path |
| `cancel_broker` | `src/modules/cancel-broker/` | `request`, `settle` | `module.cancel_broker.request`, `module.cancel_broker.settle` | future cancel contract |
### 4.14 Registration rule for future additions
若未来某 family 需要新 2nd / 3rd segment：
- 不需要每次都写新 ADR（除非新增 top-level namespace）；
- 但至少要 amend 本 schema 或其明确后续版本；
- code review 不接受“先写 code、再补 doc”的 unregistered name。
---
## §5. Required Attributes Per Span
methodology §3 解释了 Phoenix / OpenInference 为什么需要语义 attributes；本节把它收敛为 **authoritative attribute matrix**。
### 5.1 `openinference.span.kind` vs OTel `SpanKind`
这两个概念不要混淆：
- OTel `SpanKind`（`INTERNAL`, `SERVER`, `CLIENT`, ...）描述 transport role；
- OpenInference `openinference.span.kind`（`CHAIN`, `AGENT`, `LLM`, ...）描述 AI semantic role。
本平台 review gate 首先检查 `openinference.span.kind` 是否正确；OTel `SpanKind` 作为 secondary transport detail，可按实现边界补充。
### 5.2 Attribute Matrix
| Span class | Required `openinference.span.kind` | Required attributes | Conditionally required attributes | Recommended examples / notes |
|---|---|---|---|---|
| Root spans（current session roots） | `AGENT` | `session.id`, `user.id`, `input.value`, `input.mime_type` | `output.value`, `output.mime_type` if root also emits user-visible output | current canonical root is `router.deliver_to_agent` |
| Output-bearing spans | keep family-specific kind | `output.value`, `output.mime_type` | `message.kind`, `channel.type`, `tool.output` if applicable | canonical outbound examples: `delivery.channel.send`, `agent.turn` |
| LLM spans (`provider.*`) | `LLM` | `llm.system`, `llm.model_name`, `llm.invocation_parameters`, `llm.input_messages`, `llm.output_messages` | `llm.token_count.prompt`, `llm.token_count.completion`, `llm.token_count.total` when available | use one request span per model invocation |
| TOOL spans (`mcp.*`, `erp.*`) | `TOOL` | `tool.name`, `tool.parameters` | `tool.output`, `erp.operation`, `erp.request_id` if available | `mcp.erp.execute` and `erp.call` are distinct but both TOOL |
| CHAIN spans (`router.*`, `delivery.*`, default orchestration spans) | `CHAIN` | none beyond global kind | `session.id`, `user.id`, `message.kind`, `channel.type` when query value is high | use for orchestration, routing, queueing, coordination |
| AGENT spans (`agent.run`, `agent.turn`) | `AGENT` | none beyond global kind | `session.id`, `user.id`, `output.value`, `output.mime_type` when turn yields answer | do not re-label provider calls as AGENT; nested provider stays LLM |
### 5.3 Required-by-category detail
#### Root spans
当前版本只锁定一个 current session root：`router.deliver_to_agent`。
它必须携带：
- `openinference.span.kind=AGENT`
- `session.id`
- `user.id`
- `input.value`
- `input.mime_type`
如果 root span 自己就 materialize 了最终用户可见输出，也可以在 root 上带：
- `output.value`
- `output.mime_type`
但更常见的策略是让 `delivery.channel.send` 或 `agent.turn` 承担 output-bearing 责任。
#### Output-bearing spans
任何 span 只要产出 user-visible output、tool-returned textual result、or model completion summary，就应带：
- `output.value`
- `output.mime_type`
本 schema 推荐两个 canonical output-bearing anchors：
- `delivery.channel.send`：host outbound user-visible reply；
- `agent.turn`：container-side reasoning turn output，尤其当它直接生成最终答复时。
#### LLM spans (`provider.*`)
LLM spans 必须是 Phoenix 可读的 model invocation boundary。
必须优先考虑这些 keys：
- `llm.system`
- `llm.model_name`
- `llm.invocation_parameters`
- `llm.input_messages`
- `llm.output_messages`
如果 token accounting available，也应补：
- `llm.token_count.prompt`
- `llm.token_count.completion`
- `llm.token_count.total`
#### TOOL spans (`mcp.*`, `erp.*`)
TOOL spans 至少要能回答三件事：
1. 调的是哪个 tool slot（`tool.name`）；
2. tool 收到了什么 coarse parameters（`tool.parameters`）；
3. tool 回了什么 coarse output（`tool.output`，若有）。
对于 ERP boundary，另加：
- `erp.operation`
- any safe request metadata，前提是不泄漏 secrets。
#### CHAIN spans
CHAIN spans 是 orchestration glue。
它们通常不需要 LLM / TOOL 专用 attributes，但依然必须：
- 设置 `openinference.span.kind=CHAIN`
- 在有 query 价值时带 `session.id`、`user.id`
- 在 message flow 中带 canonical `message.kind`
#### AGENT spans
AGENT spans 用来表示 autonomous agent lifecycle，而不是所有 container code。
- `agent.run` = coarse runner execution unit；
- `agent.turn` = a single turn / loop iteration。
AGENT span 可带 `output.value`，但不要把 nested provider call 的 `LLM` 语义抹掉。
### 5.4 Minimal TypeScript example
```typescript
import { SpanStatusCode } from '@opentelemetry/api';

await withSpan('router.deliver_to_agent', {
  'openinference.span.kind': 'AGENT',
  'session.id': session.id,
  'user.id': userId,
  'input.value': userText,
  'input.mime_type': 'text/plain',
}, async () => {
  try {
    await deliverToAgent();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getActiveSpan()?.recordException(error);
    getActiveSpan()?.setStatus({
      code: SpanStatusCode.ERROR,
      message,
    });
    throw error;
  }
});
```
### 5.5 Attribute authority summary
- methodology doc explains the rationale;
- this schema decides the review contract;
- future code reviews should quote §5, not re-debate Phoenix semantics each time。
---
## §5b. Trace Topology Rules
### 5b.1 Root distinction
本 schema 明确区分两种 span：
- **session-trace root**：进入 Phoenix Sessions grouping 的 canonical root；
- **pre-session span**：在 session 解析之前发生的 ingress / routing short span。
当前 locked rule：
> `router.deliver_to_agent` is the OTel root for session traces (kind=`AGENT`).
它也是当前唯一必须稳定承担这些 root attributes 的 span：
- `session.id`
- `user.id`
- `input.value`
- `input.mime_type`
### 5b.2 Pre-session behavior
`channel.*.receive` 与 `router.route` 都属于 **pre-session span**。
它们 **MUST**：
- 要么在 suppressed context 下创建；
- 要么各自作为 separate short traces 存在；
- 但不能抢占 `router.deliver_to_agent` 的 session root 语义。
换句话说：
- `channel.feishu.receive` 可以测 ingress latency；
- `router.route` 可以测 coarse routing latency；
- 但 Phoenix Sessions 里真正代表“这个用户会话请求”的 root 仍是 `router.deliver_to_agent`。
### 5b.3 Current topology
Tree-wise，可以这样理解：
- pre-session short trace #1：`channel.feishu.receive`
- pre-session short trace #2：`router.route`
- session trace root：`router.deliver_to_agent`
  - child：`container.wake`
  - child：`delivery.session.drain`
  - child：`delivery.message.deliver`
  - child：`delivery.channel.send`
### 5b.4 Container boundary
host -> container 仍按 W3C propagation 过边界：
- carrier：`OTEL_TRACEPARENT`
- inject point：`container.spawn`
- extract point：before `agent.run` / `agent.turn`
`OTEL_TRACEPARENT` 是 transport carrier，不是 span-name segment，也不是 namespace。
session / user semantic context 继续通过 OpenInference context propagation preserve，不靠 ad-hoc custom env var duplication。

**ADR-0026 runner-tracing 落地后的实际拓扑**：
- runner 主进程（poll-loop）在 `OTEL_TRACEPARENT` parent 下创建 `agent.turn`（AGENT），
  `provider.request`（LLM）在 `agent.turn` 仍 active 时创建，进程内自动成为其 child。
- 内置 MCP server 是**独立进程**（StdioServerTransport），in-process OTel context
  不过进程边界，故它自己 bootstrap OTel 并从 `OTEL_TRACEPARENT` 读 parent。
  因此 `mcp.<group>.<tool>`（TOOL）span 与 `agent.turn` **同处一棵 trace**，
  但挂在 host session root 之下（是 root 的 sibling，不是 `agent.turn` 的 child）。
- host endpoint 在 `container.spawn` 注入时把 `localhost`/`127.0.0.1` 改写为
  `host.docker.internal`，使容器内 exporter 可达 Phoenix。
### 5b.5 Why this matters
如果 pre-session spans 直接混进 session root chain，会导致：
- Phoenix Sessions root placement 不稳定；
- 同一 session 出现不该有的 ingress-only root；
- `session.id` 需要在过早阶段伪造；
- channel layer 与 router/session layer 语义纠缠。
因此，**session-trace root** 与 **pre-session span** distinction 是本 schema 的架构性规则，不是实现细节偏好。
### 5b.6 Root span lifecycle bridge
`router.deliver_to_agent` root span 的生命周期跨越 router 和 delivery 两个模块：
- **创建**：`src/router.ts` 中 `tracer.startActiveSpan('router.deliver_to_agent', ...)`
- **存储**：`storeSessionRootSpan(sessionId, span)` 将活跃 Span 实例存入 `context-bridge.ts` 的 `rootSpanBridge` Map
- **结束（正常）**：`src/delivery.ts` drain 完成后调用 `endSessionRootSpan(sessionId, lastDeliveredText)`，设置 `output.value` + `output.mime_type` 并 `span.end()`
- **结束（异常）**：`src/container-runner.ts` 在 container crash/error/kill 时调用 `failSessionRootSpan(sessionId, error)`

幂等保证：`endSessionRootSpan` 和 `failSessionRootSpan` 先从 Map 中 delete 再 end，第二次调用为 no-op。

非 wake 路径（accumulate、command gate filter/deny）在 router 内直接 `rootSpan.end()`，不经过 bridge。
---
## §6. Forbidden Patterns
下面这些 pattern 在 v1.0 中一律禁止；看到它们不应“先 merge 再 cleanup”，而应直接视为 schema violation。
| Forbidden pattern | Why it is forbidden | Replace with |
|---|---|---|
| Dynamic IDs in span names（`session-123`, `msg-456`, `user-789`） | high cardinality；破坏聚合 | put IDs in attributes |
| Missing **no-empty-loop guard** on poll/sweep spans | 空轮询会淹没 real traces | only create span after real work is known |
| Using `msg.kind` as canonical key | key drift；Phoenix / queries 无法稳定聚合 | canonical key is `message.kind`; `msg.kind` deprecated |
| fire-and-forget span end on shutdown / kill path | exporter flush may never complete | await the span work / flush path before exit |
| Empty-string attrs such as `provider=''` | looks set but semantically empty | omit attribute or use meaningful value |
| Duplicate spans across layers（例如 `router.container.wake` + `container.wake`） | double counts one concept at two layers | keep the concept in the owning family only |
| camelCase / PascalCase / kebab-case in names | breaks naming uniformity | lowercase snake_case only |
| More than 3 segments | hierarchy becomes ad-hoc and brittle | move detail to attributes or registry |
| Raw tokens / cookies / JWTs / credentials in attributes | security leak | redact/hash/truncate and mark `attribute.redacted=true` |
| Full prompts > 4KB copied blindly into attributes | runaway cardinality / privacy risk | truncate safely, hash if needed, mark `attribute.redacted=true` |
### 6.1 Specific bugs this schema calls out
1. **`router.container.wake` vs `container.wake`**
   - 一个语义只能由一个 owning family 表达。
   - wake belongs to `container.*`.
2. **`container.kill` fire-and-forget bug**
   - kill path 若不 await span / flush，就会丢 trace tail。
   - 正确修复是 await controlled shutdown path，而不是把 span 去掉。
3. **`container.spawn` empty attr bug**
   - `provider=''` 不是“有值”；它是 misleading empty data。
   - empty-string attrs 应删除，或在上游补真实值。
4. **`delivery.message.deliver` canonicalization bug**
   - 旧 key `msg.kind` 必须迁到 `message.kind`。
   - 两套 key 并存会造成 query drift。
### 6.2 Disallowed naming forms
以下形式全部 forbidden：
- `deliveryMessageDeliver`
- `Delivery.Message.Deliver`
- `delivery-message-deliver`
- `delivery.message.delivered`
- `mcp.erp.approve_purchase_order`
- `module.cancel-broker.request`
- `python-skill.run`
- `router.deliver.to.agent`
### 6.3 Disallowed granularity for DB spans
`db.*` 不允许：
- span-per-SQL
- span-per-table
- span-per-index-hit
- span-per-ORM-call
真正允许的是 bounded aggregate 边界，例如 `db.session.write`、`db.audit.write`。
### 6.4 Redaction is part of correctness, not a post-processing step
如果 attribute 可能含：
- raw access token
- cookie
- JWT
- password / credential
- unbounded prompt text
那么“不加该 attribute”也比“先全量写进去再说”更正确。
redaction 后应显式标记：
- `attribute.redacted=true`
这样后续 review / query 才知道 data 被安全处理过。
---
## §7. Migration Plan
下表是当前 11 个 shipped unique span names 的 normative migration registry。它记录目标名字，不在本任务里直接修改 `src/**`。
| Current name | New name | Action | Notes |
|---|---|---|---|
| `router.route` | `router.route` | Keep | pre-session span；keep as routing short trace |
| `router.deliver_to_agent` | `router.deliver_to_agent` | Keep | session-trace root |
| `router.container.wake` | — | DELETE | duplicate of `container.wake` |
| `delivery.session.drain` | `delivery.session.drain` | Keep | gate behind `undelivered.length > 0` |
| `delivery.message.deliver` | `delivery.message.deliver` | Keep | normalize `msg.kind` → `message.kind` |
| `delivery.channel.send` | `delivery.channel.send` | Keep | outbound user-visible send boundary |
| `container.wake` | `container.wake` | Keep | owning family is `container.*` |
| `container.spawn` | `container.spawn` | Keep | drop empty `provider=''` attr |
| `container.kill` | `container.kill` | Keep | fix fire-and-forget (await span before exit) |
| `cli.event.received` | `channel.cli.receive` | Rename | D1 channel namespace normalization |
| `feishu.event.received` | `channel.feishu.receive` | Rename | D1 channel namespace normalization |
### 7.1 Example migration: rename channel spans
```typescript
await withSpan('channel.cli.receive', {
  'openinference.span.kind': 'CHAIN',
  'channel.type': 'cli',
}, async () => {
  await handleCliLine(input);
});
```
### 7.2 Example migration: remove duplicate wake wrapper
```typescript
// Keep the wake concept in the container family only.
await wakeContainer(sessionId);
```
### 7.3 Example migration: add real-work guard before `delivery.session.drain`
```typescript
const undelivered = loadUndeliveredMessages(sessionId);
if (undelivered.length === 0) return;

await withSpan('delivery.session.drain', {
  'openinference.span.kind': 'CHAIN',
  'session.id': sessionId,
  'message.count': undelivered.length,
}, async () => {
  for (const message of undelivered) {
    await deliverMessage(message);
  }
});
```
### 7.4 Example migration: canonicalize `message.kind`
```typescript
await withSpan('delivery.message.deliver', {
  'openinference.span.kind': 'CHAIN',
  'message.kind': message.kind,
}, async () => {
  await deliverMessage(message);
});
```
### 7.5 Example migration: avoid fire-and-forget on kill
```typescript
await withSpan('container.kill', {
  'openinference.span.kind': 'CHAIN',
  'session.id': sessionId,
}, async () => {
  await terminateRunner(sessionId);
  await flushTracingBeforeExit();
});
```
### 7.6 What this section is and is not
- It **is** the migration source of truth for existing names.
- It is **not** permission to invent adjacent names during cleanup.
- It **does** document future implementation intent.
- It **does not** change runtime code in this governance task.
---
## §8. Decision Log
### D1 — Channel namespace pattern — LOCKED
**Decision**
- Rename `cli.event.received` → `channel.cli.receive`.
- Rename `feishu.event.received` → `channel.feishu.receive`.
**Rationale**
- `channel.*` unifies ingress naming and avoids top-level sprawl.
- `receive` matches present-tense / messaging operation form.
- Phoenix / grep consumers can now query one channel family instead of N unrelated roots.
**References**
- §2 Naming Grammar
- §3 Top-Level Namespace Catalog
- §7 Migration Plan
### D2 — MCP tool pattern — LOCKED
**Decision**
- Use `mcp.<group>.<tool>` exactly 3 segments.
- Canonical examples: `mcp.core.send_message`, `mcp.erp.execute`, `mcp.knowledge.query`.
**Rationale**
- MCP spans need stable grouping by tool family, not by business payload.
- Dynamic ERP operations belong in `tool.name` / `erp.operation`, not in span names.
- Three fixed segments keep MCP traces queryable while remaining extensible.
**References**
- §2 Naming Grammar
- §4.9 `mcp.*`
- §9 Operational Discipline
### D3 — Action verb tense — LOCKED
**Decision**
- Span actions use present-tense / operation form only: `receive`, `send`, `deliver`, `execute`, `request`, `drain`, `wake`, `spawn`, `kill`, `route`, `resolve`.
- Past tense forms are forbidden.
**Rationale**
- A span name classifies the operation being observed, not the outcome after it finished.
- outcome is already represented by `status.code`, `status.message`, exception events, and `<namespace>.failure.category` (default `agentdesk.failure.category`).
- tense discipline prevents drift like `deliver` / `delivered` / `delivery_done`.
**References**
- §2 Naming Grammar
- §6 Forbidden Patterns
- OTel / messaging operation guidance in §11
### D4 — `module.*` vs flat top-level namespaces — LOCKED
**Decision**
- All platform modules under `src/modules/` use `module.<slug>.<action>`.
- Initial slug registry is the 13-row table in §4.13.
**Rationale**
- Modules are implementation partitions, not separate observability topologies deserving their own top-level root.
- A single `module.*` family keeps namespace budget under control while still exposing module-local behavior.
- It also creates one obvious review checkpoint for new module spans.
**References**
- §3 Top-Level Namespace Catalog
- §4.13 `module.*`
- §9.5 Ownership / amendment rules
### D5 — `db.*` granularity — LOCKED
**Decision**
- `db.*` spans cover bounded logical aggregates only.
- Canonical examples: `db.session.read`, `db.session.write`, `db.outbox.write`, `db.audit.write`, `db.identity.read`.
- span-per-SQL and span-per-table are forbidden.
**Rationale**
- DB workloads are often high-frequency and structurally noisy.
- Aggregate-level spans preserve business meaning while staying queryable.
- Fine-grained SQL tracing belongs to other observability layers, not the platform's manual span naming.
**References**
- §4.12 `db.*`
- §6 Forbidden Patterns
- §9 Operational Discipline
---
## §9. Operational Discipline
### 9.1 Scope rule（S1）
本 schema governs the platform's **manual `withSpan(...)`** calls。
这句话有两个约束：
1. future host / runner code 写 manual spans 时，name 与 required attributes 必须 obey 本文件；
2. third-party auto-instrumentation spans（例如 provider SDK 自带 spans、HTTP client auto spans）可以作为 children 存在，但它们不控制本平台的 naming registry。
换句话说：
- auto spans can coexist;
- auto spans cannot redefine the platform's span surface;
- manual spans remain the business-governed trace skeleton。
### 9.2 Container trace boundary（S2）
host -> runner boundary uses W3C propagation carrier:
- inject `OTEL_TRACEPARENT` at `container.spawn`
- extract before `agent.run` / `agent.turn`
注意：
- `OTEL_TRACEPARENT` 只负责 trace continuity；
- `session.id` / `user.id` / OpenInference semantics 继续通过 contextual propagation preserve；
- 不要再设计平行自定义 env var 协议去表达同一 tracing concern。
### 9.3 Error conventions（S3）
span failure 要遵循 OTel + OpenInference 兼容写法：
- `span.recordException(err)`
- `span.setStatus({ code: SpanStatusCode.ERROR, message })`
- emit standard `exception.type`, `exception.message`, `exception.stacktrace`
- add `<namespace>.failure.category` for stable business-level filtering
示例：
```typescript
import { SpanStatusCode } from '@opentelemetry/api';

try {
  await runOperation();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const span = getActiveSpan();
  span?.recordException(error);
  span?.setAttributes({
    'agentdesk.failure.category': 'provider_timeout',
    'exception.type': error instanceof Error ? error.name : 'UnknownError',
    'exception.message': message,
    'exception.stacktrace': error instanceof Error ? error.stack ?? '' : '',
  });
  span?.setStatus({ code: SpanStatusCode.ERROR, message });
  throw error;
}
```
### 9.4 Sampling guidance（S4）
- local / dev：use `AlwaysOn`
- production：head-based sampling at the root
- never tail-drop child spans randomly as a substitute for proper root sampling
- high-volume “empty work” should be prevented before span creation, not sampled away after pollution happens
Critical categories that **must not** be sampled out:
- ERP writes
- cancel flows
- E-stop / safety-critical traces
- security / permissions traces
原则上，sampling 是 coarse trace-volume control；不是逃避 bad span hygiene 的借口。
### 9.5 Namespace ownership and change control（S6）
Governance rules:
1. new top-level namespace requires ADR
2. new registered 2nd / 3rd segment requires schema spec amendment
3. code must not introduce unregistered span names
也就是说：
- 想新增 `vector.*` 这种第 21 个顶层前缀？要 ADR。
- 想在 `module.*` 下面加新 slug 或 action？至少要 amend schema。
- 想先写 code 再补 doc？不允许。
### 9.6 Redaction and cardinality discipline（S7）
禁止直接落入 attributes 的内容包括：
- raw tokens
- cookies
- JWTs
- passwords / credentials
- full prompts > 4KB
推荐策略：
- 若值对调试不关键：omit
- 若要保留可比性：hash
- 若需要保留片段：truncate
- 任何 redaction 发生时：set `attribute.redacted=true`
示例：
```typescript
const promptPreview = prompt.length > 4096 ? `${prompt.slice(0, 4096)}…` : prompt;
const wasRedacted = prompt.length > 4096;

span.setAttributes({
  'input.value': promptPreview,
  'input.mime_type': 'text/plain',
  'attribute.redacted': wasRedacted,
});
```
### 9.7 Discipline summary
如果一个新 span 同时违反 naming、topology、redaction 三者中的任意一个，它就不是“小问题”；它是 schema violation。
---
## §10. Future Extensions
本节回答：“当平台继续长大时，schema 怎么扩，不至于失控？”
### 10.1 Surface-oriented extension map
| Future surface | Registered direction | Naming notes |
|---|---|---|
| mock cluster | `mock.<service>.*` | service details stay in attributes when dynamic |
| cancel broker | `module.cancel_broker.*`, `agent.cancel` | module family keeps top-level stable |
| knowledge tooling | `mcp.knowledge.*` | remains under `mcp.*` until explicit elevation |
| hardware skills | `hardware.<system>.*` | dynamic device ids go to `hardware.device_id` |
| Python skill services | `python_skill.run` | service name goes to `python_skill.name` |
| GUI automation | `gui.*` | GUI app/window specifics stay in attributes |
### 10.2 Extension heuristics
未来新增 family 时，优先套用这些 heuristics：
- 新 surface 如果本质上是 MCP tool group，先放进 `mcp.*`；
- 新 module 如果位于 `src/modules/`，先放进 `module.*`；
- 新 persistence concern 如果只是 DB aggregate，先放进 `db.*`；
- 新 external service 如果 behind ERP gateway or service boundary，优先 `erp.*` / `python_skill.*` / `hardware.*` / `gui.*`；
- 只有当上述 family 都无法容纳，才考虑新的 top-level namespace，并走 ADR。
### 10.3 Flow tree examples
这些 flow tree 不是 pseudo-ideas；它们是 future reviewers 检查 topology 的 canonical examples。
#### Tree 1 — Inbound session trace split
- `channel.feishu.receive`
- （separate trace）`router.route`
- `router.deliver_to_agent` (root)
- `container.wake`
- `delivery.session.drain`
- `delivery.message.deliver`
- `delivery.channel.send`
同一棵 narrative 应解释为：
- `channel.feishu.receive` 是 pre-session ingress short trace；
- `router.route` 是 pre-session routing short trace；
- `router.deliver_to_agent` 才是 session trace root。
#### Tree 2 — Container agent turn
- `agent.run`
- `agent.turn`
- `provider.request`
- `mcp.core.send_message`
这个 tree 表示 runner 内的 turn loop：
- AGENT root / child spans 包住 reasoning lifecycle；
- actual model call stays `provider.request` with `LLM` kind；
- outbound tool interaction stays `mcp.core.send_message` with `TOOL` kind。
#### Tree 3 — ERP/MCP execution chain
- `mcp.erp.execute`
- `erp.call`
- `module.gateway_audit.emit`
- `db.audit.write`
这个 tree 表示：
- MCP tool slot 是入口；
- ERP gateway boundary 自成 `erp.call`；
- 审计模块与 DB audit append 各自在自己的 owning family 里表达。
#### Tree 4 — A2A delegation
- `mcp.core.send_message`
- `module.a2a.route`
- `db.session.write`
- (worker) `agent.run`
它强调两点：
- a2a delegation 不是新 top-level namespace；它属于 `module.a2a.*`；
- cross-session / worker handoff 仍可通过 stable spans 被 Phoenix / trace query 看见。
### 10.4 Future family notes
#### `mock.*`
- 用于 simulation / dry-run / mock cluster 边界。
- service 名若动态，不要写进 name；用 attributes。
#### `hardware.*`
- `hardware.<system>.*` 是 coarse system boundary，不是 device id boundary。
- 例如 `hardware.robot.execute` 可以接受；`hardware.robot.arm-7.execute` 不可以。
- device id belongs in `hardware.device_id`。
#### `gui.*`
- GUI automation 常常带 window title、screen position、OCR fragment；这些都不应进入 name。
- 保持 coarse names，如 `gui.chromeleon.run` 或 `gui.desktop.capture`，具体 UI metadata 进 attributes。
#### `python_skill.*`
- `python_skill.run` 是 current coarse service boundary。
- skill service 名称用 `python_skill.name`，不要做 `python_skill.remote_liquid_exec.run` 这种 4 段扩展。
### 10.5 Non-goals for v1.0
本版本不做这些事：
- 不为 every hypothetical module 预注册几十个 action；
- 不把 raw transport semantics 映射成新的 top-level namespace；
- 不回头重写 ADR-0011；
- 不给 third-party SDK auto spans 改名。
---
## §11. References
- `docs/decisions/ADR-0011-host-otel-instrumentation.md`
- `docs/decisions/ADR-0014-observability-span-schema.md`
- `docs/observability-instrumentation-methodology.md` v1.0
- OpenTelemetry trace API / span guidance: `https://opentelemetry.io/docs/specs/otel/trace/api/#span`
- OpenTelemetry naming guidance: `https://opentelemetry.io/docs/specs/semconv/general/naming/`
- OpenTelemetry messaging spans: `https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/`
- OpenInference semantic conventions: `https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md`
- OpenInference project home: `https://github.com/Arize-ai/openinference`
- Phoenix Sessions docs: `https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/setup-sessions`
- Phoenix project home: `https://phoenix.arize.com`
本 schema 的 review / implementation / future amendment 都应优先引用本页与 ADR-0014，而不是重新从零解释一次“为什么 span naming 需要治理”。
