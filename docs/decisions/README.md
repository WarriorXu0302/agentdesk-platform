# Architecture Decision Records (ADR)

> 本目录是本仓的**架构决策档案**。每一份 ADR 记录一个值得后人知道"为什么"的决定。
> 失去"为什么"，下一个 coding agent 就只能从代码里反向猜测，而代码本身从不解释自己。

---

## 为什么需要 ADR

关键决策若只口头讨论或散落在 issue / chat / wiki 里，会导致：
- 接手者看不懂某些"看似多余"的代码为什么这样写
- 新 agent 容易"善意地"还原一个早已被否决的方案
- 顶层契约与实现细节之间没有清晰边界

ADR 是低成本的反熵机制：5 分钟落一份，下一个 agent 节省数小时。

---

## 何时必须写 ADR

下面任一情形发生，必须在同次 PR 内提交 ADR：

1. **改动公共契约**：DB schema、ERP gateway 接口、channel adapter 形状、container ↔ host 协议
2. **在 2 个以上可行方案中做出选择**（即使最后选了"看起来显然"的那个）
3. **引入新的依赖类别**：新的 LLM provider、新的 observability 后端、新的 storage、新的 sidecar
4. **否决 / 撤销 一个先前的 ADR**（写新 ADR + 把旧 ADR 标记为 Superseded）

何时**不必**写 ADR：
- 重命名局部变量、修 typo、补单元测试、debug 一个不改契约的 bug
- 已有 ADR 完全覆盖的实现细节

---

## 命名与格式约定

- 文件名：`ADR-NNNN-kebab-case-title.md`，N 为 4 位顺序号
- 顺序号**单调递增、不复用**（即使某份 ADR 被 Supersede，编号仍保留）
- 模板：`_template.md`
- 状态字段限定值：`Proposed | Accepted | Superseded by ADR-XXXX | Deprecated | Reverted`

### 关于缺失的编号

下面索引里的编号**不连续**——`0001-0006`、`0008`、`0009`、`0012`、`0013`
在仓库里都没有对应文件。这**不是丢了 ADR**：这些编号要么是在本仓泛化重构
（把单用户/特定业务的早期形态改造成通用企业多用户平台）之前就删除的旧 ADR，
要么从未真正存在，只在 git 历史里留过痕迹。按「顺序号单调递增、不复用」的约定，
重构时删掉的编号也不回收。需要追溯某个缺失编号的来历，去 git 历史里查，
不要新建文件去「补」它——补进来会和历史编号语义冲突。

## 与 `docs/audit/` 的关系

- `docs/audit/` 用于记录**审计型记录**（例如安全审计、合规复核、第三方评估的结论）
- `docs/decisions/`（本目录）用于记录**主动设计决策**
- 二者不重叠：审计是回看 + 评估，决策是前瞻 + 拍板

---

## ADR 索引

| ADR | 标题 | 状态 | 日期 | 标签 |
|---|---|---|---|---|
| [ADR-0007](ADR-0007-observability-phoenix-grafana.md) | Observability 框架：纯 Phoenix (ELv2) + Grafana | Accepted | 2026-05-18 | `observability`, `framework` |
| [ADR-0010](ADR-0010-rename-default-frontdesk-to-template.md) | Rename default frontdesk → template frontdesk（命名歧义修复 + LEGACY fallback） | Accepted | 2026-05-20 | `naming`, `refactor`, `frontdesk` |
| [ADR-0011](ADR-0011-host-otel-instrumentation.md) | Host OpenTelemetry Instrumentation（OTel SDK bootstrap + manual span + context bridge + trace-log 关联） | Accepted | 2026-05-29 | `observability`, `tracing`, `host-runtime` |
| [ADR-0014](ADR-0014-observability-span-schema.md) | Observability Span Naming Schema v1.0（hierarchical snake_case + OpenInference attribute matrix + 20 namespaces + 5 LOCKED decisions） | Accepted | 2026-05-31 | `observability`, `tracing`, `naming` |
| [ADR-0015](ADR-0015-observability-coverage-gate.md) | Observability Coverage Gate（schema/runtime drift CI gate） | Accepted | 2026-05-31 | `observability`, `tracing`, `ci`, `schema-governance` |
| [ADR-0016](ADR-0016-delivery-resilience.md) | 出站投递韧性（超时 + 有界并发 + 持久化退避重试 + dlq 死信工具） | Accepted | 2026-06-12 | `delivery`, `reliability`, `session-db`, `migration` |
| [ADR-0017](ADR-0017-identity-origin-crossvalidation.md) | 身份链 host 侧交叉校验 origin_user_id（用可信 inbound.db 校验容器自报，堵跨会话冒充） | Accepted | 2026-06-12 | `identity`, `security`, `a2a`, `trust-chain` |
| [ADR-0018](ADR-0018-hmac-signing-enablement.md) | HMAC 签名开通路径 + 未签名 group 可观测/告警 | Accepted | 2026-06-12 | `security`, `gateway`, `hmac`, `observability` |
| [ADR-0019](ADR-0019-fail-closed-security-defaults.md) | 安全默认值统一收紧为 fail-closed（admin/engage 正则/审批卡片操作者） | Accepted | 2026-06-12 | `security`, `fail-closed`, `permissions`, `feishu` |
| [ADR-0020](ADR-0020-process-hardening.md) | 宿主进程硬化（ingress body 上限/超时 + /healthz·/readyz 探针 + /metrics 鉴权 + 优雅停机排空） | Accepted | 2026-06-12 | `hardening`, `ingress`, `health`, `shutdown` |
| [ADR-0021](ADR-0021-metrics-alerting-loop.md) | 指标→告警闭环（Prometheus + Alertmanager + 告警规则 + RUNBOOK 防漂移测试） | Accepted | 2026-06-12 | `observability`, `metrics`, `alerting`, `runbook` |
| [ADR-0022](ADR-0022-inbound-persist-before-route.md) | 入站 persist-before-route（路由前持久化 + 操作员显式重放，关掉静默丢失窗口） | Accepted | 2026-06-12 | `reliability`, `ingress`, `recovery`, `at-least-once` |
| [ADR-0023](ADR-0023-roster-dm-grants.md) | Roster DM：宿主管控的、本人显式同意的、per-scope 定向私聊授权（槽位强制边界 + grant 生命周期） | Accepted | 2026-06-12 | `security`, `delivery`, `identity-trust-chain`, `feishu-channel`, `fail-closed` |
| [ADR-0024](ADR-0024-openai-context-compaction.md) | OpenAI provider 摘要式上下文压缩（对齐 Claude auto-compact，替代硬截断；删除 sdk-openai 玩具 provider） | Accepted | 2026-06-12 | `provider`, `context-management`, `openai`, `agent-runner` |
| [ADR-0025](ADR-0025-config-safety.md) | 配置安全：.env.example 权威清单 + 启动期保守 fail-fast + 拒绝占位密钥（仅功能启用时必填、不误伤现有部署） | Accepted | 2026-06-12 | `config`, `security`, `fail-closed`, `ops` |
| [ADR-0026](ADR-0026-runner-otel-instrumentation.md) | 容器 runner OTel 接入（端到端 trace：host root span → 容器内 turn/LLM/tool span；不上明文，纯旁路 fail-open） | Accepted | 2026-06-12 | `observability`, `tracing`, `agent-runner`, `phoenix` |
| [ADR-0027](ADR-0027-otel-content-capture.md) | trace 明文内容捕获（OTEL_CAPTURE_CONTENT opt-in，默认关；开启上完整 prompt/LLM消息/工具参数+结果，不脱敏；偏离 ADR-0007 R16 由运营者自担） | Accepted | 2026-06-12 | `observability`, `tracing`, `privacy`, `opt-in` |
| [ADR-0028](ADR-0028-gateway-contract-hardening.md) | 网关契约硬化（封闭错误码 + contractVersion 信封 + execute 幂等键 + 输入白名单 + zod 真相源 + conformance 跑手；发出收紧、响应默认 warn-only 向后兼容） | Accepted | 2026-06-12 | `gateway`, `contract`, `conformance`, `backward-compat` |
| [ADR-0029](ADR-0029-supply-chain-hardening.md) | 供应链/最小权限硬化（pre-commit 密钥拦截 + Dockerfile digest pin + obs 服务 cap_drop/no-new-privileges + agent 容器 no-new-privileges、cap_drop 可配置默认不动） | Accepted | 2026-06-12 | `security`, `supply-chain`, `least-privilege`, `pre-commit` |
| [ADR-0030](ADR-0030-channel-contract-testing.md) | 通道契约一致性测试（assertChannelAdapterContract 软门 + feishu 有状态路径测试 + 宿主主链路 e2e 骨架） | Accepted | 2026-06-12 | `channels`, `testing`, `contract`, `e2e` |
| [ADR-0031](ADR-0031-fork-free-channel-extensions.md) | 不 fork 主仓的通道扩展加载（运营者自控 EXTENSIONS_DIR + 版本门 + 契约门 + fail-open） | Accepted | 2026-06-13 | `channels`, `extensibility`, `open-source` |
| [ADR-0032](ADR-0032-container-egress-policy.md) | 容器 egress 联网管控（可配置 --network，默认不限制向后兼容；egress-proxy allowlist 缓解容器内明文密钥；host 侧签名代理记为后续） | Accepted | 2026-06-12 | `security`, `egress`, `container`, `least-privilege` |
| [ADR-0033](ADR-0033-memory-search-retrieval.md) | 记忆检索 gateway_memory_search（provenance + 召回内容 nonce 围栏注入隔离 + conformance；仍只走网关，后端未实现优雅降级） | Accepted | 2026-06-12 | `memory`, `gateway`, `retrieval`, `prompt-injection` |
| [ADR-0034](ADR-0034-host-signing-credential-proxy.md) | Host 侧网关签名凭证代理（signingKey 不进容器，per-session 不可伪造 group 代签 + 源 IP/限速/读写分离/NO_PROXY/规范化重序列化签名/两阶段审计；默认 OFF 零变化；fail-closed 结构性；phase2 OpenAI 流式另开）— **已实现，红队抓到 1 critical + 1 high 均已修** | Accepted | 2026-06-13 | `security`, `gateway`, `identity-trust-chain`, `fail-closed`, `credential-isolation` |
| [ADR-0035](ADR-0035-openai-key-via-onecli-vault.md) | OpenAI/codex provider 的 API key 经 OneCLI vault 注入（ADR-0034 phase2 落地：复用既有 vault 而非自建流式代理；flag `AGENTDESK_OPENAI_VIA_ONECLI` 默认 OFF，开则不跳过 OneCLI、key 不进容器、容器不带 Authorization 由 vault 注入、bun fetch 经 NODE_EXTRA_CA_CERTS 信任 vault CA；fail-closed=调用失败不泄漏） | Accepted | 2026-06-13 | `security`, `provider`, `credential-isolation`, `openai`, `onecli` |
| [ADR-0036](ADR-0036-gateway-bulk-execute.md) | 可选 `/bulk_execute` 网关端点（批量操作原语，roadmap 3.1；per-operation 幂等比 per-batch 安全、可选 `atomic` 由后端保证、默认 best-effort `partial`；可选端点未实现返 404 优雅降级；复用 `/execute` 信封 + `requesterSource` 写门控、入签名代理 `WRITE_PATHS`，不新开身份面） | Accepted | 2026-06-14 | `erp-gateway`, `contract`, `bulk`, `idempotency`, `backward-compat` |
| [ADR-0037](ADR-0037-gateway-async-tasks.md) | 可选异步任务提交（`/execute` 加 `submitAsync` + 新 `/task/status` 读端点，roadmap 3.2；长操作不再被 15s 超时杀死；不支持的后端忽略 flag 照常同步、optional 端点 404 降级；agent 轮询、平台不存任务状态;`/task/status` 入 `READ_PATHS`、按 requester 授权，host 无状态、身份链复用） | Accepted | 2026-06-14 | `erp-gateway`, `contract`, `async`, `long-task`, `backward-compat` |
| [ADR-0038](ADR-0038-escalation-hook.md) | 显式升级钩子（roadmap 2.3；正交 `escalate` system action 经 `registerDeliveryAction`，**非** classify_intent 枚举、**非** a2a 路由变体；reason/urgency 不可信但记录、绝不入 authz/优先级；复用 origin 交叉校验 + `enterprise_audit` `agent_escalation` + `classification_log` 加列 + `escalation_total` 指标；队列优先级/路由到人/SLA 归网关。经 design+对抗评审 workflow 核实,否决了 urgency 驱动核心优先级的平行授权路径） | Accepted | 2026-06-14 | `a2a`, `escalation`, `audit`, `observability`, `identity-trust-chain`, `backward-compat` |
| [ADR-0039](ADR-0039-conversation-thread-id.md) | host 拥有的 `conversation_thread_id` 关联 id（roadmap 2.2；贯穿 frontdesk→worker 多跳的纯关联 id,additive、**永不入 authz/路由**；host-only,**不碰 container 写的 messages_out**,在 origin 交叉校验后从源 session 读出传播,nullable + best-effort 不阻断消息流;迁移 031 marker + migrateMessagesInTable ALTER-on-open 覆盖在飞会话。经 design+对抗评审 workflow SHIP IT,纠正了"container 供给 thread_id"的 trace-poisoning 错误、确认 root_session_id 默认模式不跨 hop。分 4 commit 落地） | Accepted | 2026-06-14 | `a2a`, `observability`, `identity-trust-chain`, `migration`, `three-db-single-writer`, `backward-compat` |
| [ADR-0042](ADR-0042-cancel-pending-request.md) | 待处理交互请求的带外取消（roadmap 6.6）—— 用户键入精确整条 token(`/cancel`/`cancel`/`取消`/`停止`)即可止住误发的 ask_user_question/审批卡。host 经**与按钮点击相同**的 `question_response` 线用 `__cancelled__` sentinel(+ additive `cancelled:true`)解析用户**自己**的待处理问题,container 经既有成功路径 `ok(sentinel)` 返回(**非** err(),避免 retry 混淆),agent 据工具描述约定回滚。**跨用户隔离是结构性的**:`findCancelablePendingQuestions` 用 `JOIN sessions ON owner_user_id=?`,shared/agent-shared 会话 owner 为 NULL → 零命中 → 取消在那里是 no-op,一个用户永远无法取消他人请求(无守卫代码)。前置重构:`setMessageInterceptor` 单槽→链式数组(否则覆盖 permissions 自由文本拦截器,day-1 回归)。保守拦截:仅精确整条 token + 仅当发送者确有待处理问题才消费,否则透传;错误降级透传。经 design+对抗评审 workflow。 | Accepted | 2026-06-14 | `interactive`, `routing`, `session-isolation`, `ux`, `backward-compat` |
| [ADR-0041](ADR-0041-conversation-summary-flush.md) | 压缩摘要落库 `conversation.summary`（roadmap 4.1；落地 ADR-0033 defer 的批次）—— **cost-neutral、OpenAI-only、Claude 暂不支持**。`compacted` 事件加可选 `summary`,OpenAI 透出压缩本就生成的摘要(零额外模型调用),poll-loop fire-and-forget 经既有 `/memory/upsert` 签名代理 WRITE_PATH 落 `value.autoSummary`(merge,不覆盖 agent 事实)。Claude SDK 无摘要文本 → flush 是 no-op(不伪造、不额外调模型)。对抗评审两条强制修正:身份**同步快照**传入(detached flush 可能晚于 turn 的 identity-clear)、`getConfig()` 折进 promise 链(throw 变可捕获、绝不打断事件循环)。**驳回**显式摘要调用(Claude PreCompact transcript 在事件发出时不可达 + 与在飞 turn 争 rate-limit)。纯 container 侧,无 host 改动。 | Accepted | 2026-06-14 | `memory`, `gateway`, `compaction`, `container-runtime`, `provider-asymmetry`, `backward-compat` |—— **recording-only,驳回 active-reroute**。正交 `routing_feedback` system action(`kind: misroute\|nack` + reason + suggestedTarget),host 只记录:classification_log 加 nullable `feedback_kind`(action='routing_feedback',复用 `recommended_worker` 存未校验建议、`classification_id` 回指原始 classify 行)+ enterprise_audit `agent_routing_feedback` + `routing_feedback_total{kind,reported_by}`(有界标签)。suggestedTarget 不可信、**绝不解析/ACL/路由**,handler 无 send 路径 → 不变量结构上不可破。对抗评审**否决** active-reroute:共享 inbound.db 身份污染致跨用户重定向 + 双 return-path 冲突,flag 修不了;真正重投归网关。经 design+对抗评审 workflow。 | Accepted | 2026-06-14 | `a2a`, `routing`, `audit`, `observability`, `identity-trust-chain`, `three-db-single-writer`, `backward-compat` |

---

## 在 PR 中如何引用 ADR

- commit message 与 PR 描述里直接写 ADR 编号，例如：`refs ADR-0007`、`supersedes ADR-0011`
- 代码中如果某段实现是某 ADR 的直接落地，加注释：`// See ADR-0007: Phoenix is the only sanctioned observability backend.`

---

## 提交流程速查

1. 选下一个未占用编号 `NNNN`（看本索引最后一行 +1）
2. 复制 `_template.md` → `ADR-NNNN-<title>.md`
3. 填写每个章节（不要留 placeholder）
4. 在本 README 的索引表追加一行
5. 在同次 PR 里提交，并在 PR 描述里点名引用本 ADR
