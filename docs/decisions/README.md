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
| [ADR-0048](ADR-0048-stable-gateway-idempotency-key.md) | 网关写入稳定幂等键（对标清单 #1）—— **纠正 benchmark**:网关写入早有幂等键(自动随机 UUID),真缺口是"崩溃-重放跨轮去重"。**design+对抗评审挡下一次坏 ship**:原 step-counter 设计 UNSAFE/空转(网关 handler 在**独立子进程**,poll-loop 模块状态 getCurrentInReplyTo/RequestIdentity 恒 null → 生产永不触发 + in-process 测试 false green;并发 tool 调用 + 共享计数器 → 折叠丢写)。修(Option A):锚**源自 `processing_ack`**(outbound.db,真跨进程通道)+ **内容键 occurrenceIndex**(非 dispatch-order,扛并行)+ 重置信号 anchor+MAX(status_changed)(重驱归零但键不含信号 → 重跑复现同键)+ `canonicalJSON`(稳定哈希,先行提交 347c22f)。**洞察**:锚源自 DB 表 → in-process seed processing_ack 就走真子进程同款 DB 读路径 → 无 false green、无需 Docker 即可忠实验证。best-effort(LLM 重跑确定性),漂移退化为双写绝不丢写;`/memory/upsert` 不碰;显式键优先。容器 317/317 全绿。 | Accepted | 2026-06-15 | `reliability`, `idempotency`, `gateway`, `data-integrity`, `agent-runner` |
| [ADR-0047](ADR-0047-agent-eval-harness.md) | agent eval/replay 回归门（对标 GitHub 成熟框架后落地 benchmark 清单 #2,对标 Rasa Pro/Google ADK）—— 利用"万物皆消息行"这一独特优势:seed 好的 inbound.db + 跑出的 outbound.db **本身就是**可重放可断言的轨迹。`container/agent-runner/eval/`:声明式 `cases/*.json`(无 TS 样板)→ 进程内跑**真 poll-loop** + 脚本化 MockProvider(**无 Docker/无 LLM**)→ 小词汇表断言出站(delegates_to/delivers_to/text_*/in_reply_to/thread_id/count/no_output),经既有容器 `bun test` 进 CI。**PLUMBING 模式**仍能守 misroute/nack(ADR-0040)关心的委派路由——`<message to=worker>` 打到 `type:agent` destination 解析成 `channel_type=agent` 出站(同真 send_to_agent);**QUALITY 模式**(换真 provider + LLM-judge 测分类质量)作同形用例的可选扩展、文档化。4 条落地用例(回源/委派/裸文本兜底/扇出),容器 303 测试全绿。纯新增测试设施,不碰 core/契约/身份链。 | Accepted | 2026-06-15 | `testing`, `eval`, `agent-runner`, `quality-gate`, `ci` |
| [ADR-0046](ADR-0046-recording-surface-actor-cross-validation.md) | 记录型面 actor 身份交叉校验（ADR-0017 一致性扩展）—— as-merged 红队发现:记录型 handler 算 actor 用 `session.owner_user_id ?? claimedUserId`,而群聊 frontdesk 拓扑(shared/per-thread/agent-shared)owner=NULL → 落到容器自报 id、零校验零告警,被注入容器可把任意 victim 盖进 classification_log.user_id + enterprise_audit actor。**low**(纯审计归因伪造:invariant 3 成立,id 从不流入授权/路由/优先级,只被当 WHERE 过滤输入读)。修=owner=NULL 时复用 a2a 的 `collectLegitimateOrigins(host 写的 inbound.db)` 交叉校验(claimed 须确在本会话出现过,否则 null + `recording_actor_rejected_total` + 告警);**保住合法多用户群会话的正确归因**(选 Option A 而非一律置 null)。抽公共件 `src/trusted-actor.ts`,origin-user.ts 是纯叶子静态 import 不激活可选 a2a。**完整性扫描:四个记录型面统一(classify_intent/escalate/routing_feedback + 漏网的 gateway_audit)**——修完一类全仓 grep 把 sibling 一次修净。回归测试实测修复前为红。纯 host 改动。cancel-pending 跨用户隔离同批审计判为稳健。 | Accepted | 2026-06-15 | `identity-trust-chain`, `audit`, `a2a`, `classification`, `fail-closed` |
| [ADR-0045](ADR-0045-roster-surface-redteam-hardening.md) | roster-DM 接口 as-merged 红队加固（ADR-0023/0044 后续）—— 对已合并的 agent 接口跑 5 视角对抗红队(每条 3 怀疑者复核、≥2/3 才算真),确认并修 **3 个真 bug**。**①同意卡伪造(critical,破 ADR-0044 载重不变量)**:飞书 `deliver()` 仅凭 `content.type==='roster_invite'` 建同意卡、**不看 `message.kind`**;容器(有 Bash+拥 outbound.db)写一行 `kind='chat'` 普通渠道消息携自造 `optIn`,绕开 invite 闸落普通渠道分支(p2p 反绕过只拦 `feishu:p2p:`、群 id 不拦)、发进源群过 isOriginChat,点击者即卡上 `expectedUserId` 时 `captureDirectedCardConsent` 逐字信任卡字段铸 grant——关着 `ALLOW_ROSTER_DM` 也成。修:`delivery.ts` 在轮询投递路径 fail-closed 拒任何 roster 同意卡(`isForgedRosterOptInCard`)+ 审计 `forged_optin_card`;**合法 invite 走 `adapter.deliver` 直投、从不经 deliverMessage**,故此处出现必伪造(选 host 边界把关,纵深的 feishu `kind` 把关留待身份门禁 WIP 后叠)。**②撤销竞态(medium)**:开 gateway/membership 可选闸时 `checkGrantLive`→`reserveRosterSend` 间夹 await,撤销落窗口被漏;修:reserve 的 grant UPDATE 加 `revoked_at IS NULL` 原子复查。**③重试重复发送(high)**:非超时 catch 无条件回滚,把前序超时保留(可能已投)的预留 un-count/un-revoke/删标记 → 重发;修:仅 `reservation.fresh` 才回滚。三条均配 pre-fix 必红回归测试(已 stash 源码验证)。纯 host 改动,R1-R5+不变量 1-6 全保、全 fail-closed。经 5 视角红队 + 3 怀疑者复核 workflow。 | Accepted | 2026-06-15 | `security`, `delivery`, `identity-trust-chain`, `feishu-channel`, `fail-closed`, `roster-dm` |
| [ADR-0044](ADR-0044-roster-dm-agent-surface.md) | roster-DM 的 agent 对外接口（ADR-0023 后续）—— **host-mediated 三件套** send/discover/invite。宿主侧机器(同意 grant/投递闸/撤销/限速)已就绪但 agent 无触发入口;补薄工具,**所有安全关键字段(scope/agentGroup/expectedUserId/卡片)只由宿主盖章**(驳回 container-crafted——会让容器选 grant 的 scope/受众,洞开 R2/R4)。send 写 kind='roster' null 路由 + content.slot(返回不透明);discover 由宿主把"活槽位投影"写进 inbound.db(零身份字段、无 open_id);invite 发 kind='system' 意图行、宿主建定向同意卡。5 条新加固:`listLiveGrantsForScope`、invite 每(scope,member)一次抑制(防骚扰)、invite `isMember=undefined` fail-closed、invite 卡宿主盖 24h 过期、invite 限速。R1-R5 全保(invite 路径 R2 加强)。分 4 stage(0 query→1 discover→2 send→3 invite 单独评审),经 design+对抗评审 workflow。 | Accepted | 2026-06-14 | `security`, `delivery`, `feishu`, `identity`, `agent-surface`, `authorization` |
| [ADR-0043](ADR-0043-memory-feedback.md) | 知识反馈闭环（roadmap 4.6）—— 第 7 个网关工具 `gateway_memory_feedback` POST `/memory/feedback`，让 agent/运营者标记某 memory 记录不准/过期/需更正。**gateway-endpoint、recording-only、后端拥有语料**——**驳回** roadmap 字面建议的 host `knowledge_feedback` 表(违反"记忆只走网关、无平行路径")；host 侧唯一持久化是既有 `gateway_audit` 调用行(零新表/列/enterprise_audit 行)。契约沿 ADR-0028/0033:`{namespace,subject,recordId,issue(闭合枚举),note?(≤2000)}`,`issue` 未知值硬拒不 coerce,**`note` 不入 input_hash/audit 文本**,**不加 correction 字段**(避免绕过 upsert 的隐式写路径)。WRITE_PATH 与工具同 commit(防 FORBIDDEN_PATH 窗口)。recordId/issue/note 不可信、host 绝不据此动作,后端按 subject-scope gate。404 优雅降级。经 design+对抗评审 workflow。 | Accepted | 2026-06-14 | `gateway`, `memory`, `contract`, `provenance`, `identity-trust-chain`, `backward-compat` |
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
