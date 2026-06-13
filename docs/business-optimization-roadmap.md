# AgentDesk · 业务侧优化路线图(Backlog)

> **生成方式**:2026-06-14 跑了一轮 8 视角业务侧 review(运营者上手 / 网关契约契合度 / 分流派活与对话质量 / 治理 / 记忆 / 多租户成本 / 终端体验 / 业务定制),每条发现都经**对抗式 verify 对照真实代码核实**,剔除了「其实已实现」「本就该留给运营者」的伪缺口(56 条真缺口/部分缺口存活)。
>
> **这是待办 backlog,不是承诺**。优先级见文末「优先级建议」。
>
> **维护提示**:实现某项后在此标注 commit;若某项经 ADR 决议为「不做」,在此注明并指向 ADR;文件行号会随代码漂移,引用时以函数名为准。

---

## 前言:这是产品/业务层优化,不是基建救火

先说结论:**这个平台的技术底座是成熟的**。身份信任链、三库单写、容器隔离、fail-closed 安全默认、可观测性栈都已落地且经过加固(见近期 commit `90b56f1`、`5db2bdf`、`03832df`)。下面列的不是 bug,而是**让真实企业更快上手、让业务流程更顺、让运营者更省心**的产品级优化。

更重要的是要分清两类问题,避免把第二类当缺陷去返工:

- **平台核心该做的**:对话链路追踪、误路由反馈、审批/审计完整性、终端用户失败反馈、契约能力(bulk/async/schema discovery)、记忆 summary 落库——这些是"业务无关但所有运营者都需要"的横切能力,放在核心最合理。
- **本就该留给运营者 gateway/examples 的**:每租户配额/计费、动态模型选路、按部门 LLM 策略、多步业务编排、能力发现菜单。`SPEC.md` L20、L34 明确把业务授权/配额/审批策略推到后端网关层。这是**架构正确**,不是缺口。对这类项,我们的建议是"补文档/补示例/补 hook",而不是"在核心里写业务逻辑"。

---

## 主题一:运营者上手与价值实现速度(降低首次部署门槛)

### 1.1 缺少一键 quickstart 脚本
> ✅ **已实现**(上手 batch):新增 `quickstart.sh` + `pnpm quickstart`。自动按序跑确定性步骤(install → container:build → init:enterprise **带默认示例 workers** `research-worker,ops-worker`),然后打印剩下两步(接后端网关 URL、配通道凭证——这两步需运营者特定信息,无法猜)的明确指引,含本地 demo 路径(跑 reference-gateway + configure + dev + chat)。支持 `--skip-build` / `QUICKSTART_WORKERS` 覆盖。README 快速启动段加了一键入口说明。
- **现状**:`README.md` L105-192 提供 5 步启动,`examples/README.md` L39-128 是 6 步手工演练,但**没有 `quickstart.sh` 或 make target** 把整个流程打包。`init-enterprise` 默认创建空白 frontdesk,运营者需自己理解要加 `--workers` 才能得到可用拓扑。
- **业务影响**:中等。30-60 分钟成本主要花在"理解编排顺序"而非执行困难。"需要自己编排"的心理障碍大于真实工作量。
- **建议**:写 `quickstart.sh`,顺序执行 install → container:build → init:enterprise(带默认 workers)→ configure-gateway → dev,STDOUT 显示进度。把"手工编排"变成"一键启动"。
- **工作量 S · 价值 中**

### 1.2 容器镜像缺失时宿主"假装启动成功" — ✅ 已落地(d13d1e6)
- **现状**:`src/container-runner.ts` 的 `checkBaseImage()` 在镜像缺失时**只记日志、不中止**;`src/index.ts:103` 调用后宿主继续启动。运营者跳过 `pnpm container:build` 时,宿主起来了,但第一条消息才失败。
- **业务影响**:中等偏低。错误消息清晰,但"启动成功 + 首条消息失败"的体验割裂,诊断要多一跳。
- **建议**:在 `init-enterprise` 输出末尾加一行明确提示 "Next: run pnpm container:build";或将 `checkBaseImage` 失败升级为 fail-fast(在 `initObservability` 之后)。
- **已实现**(选了不破坏既有设计的两手,**没有**采纳 fail-fast —— `checkBaseImage` 的 docstring 明确"非致命是有意为之:镜像缺失绝不能让宿主崩溃,通道与 /metrics 必须继续在线",fail-fast 会削弱这条可靠性决策):
  - **可观测化**:新增 gauge `agentdesk_agent_base_image_present`(1/0),`checkBaseImage` 在引导预检时落值;配套告警 `AgentDeskBaseImageMissing`(`== 0` for 10m,warning)。把"诊断要回翻 boot 日志"变成"告警自动触发"(符合 ADR-0021:指标必须有抓取者 + 告警承载体)。信号在宿主重启时刷新。
  - **引导提示**:`init-enterprise-topology.ts` 末尾的 "Next steps" 现在显式列出第 1 步 `pnpm container:build`(REQUIRED before first message),直接堵住"跳过 build"这个失败入口。
  - 测试:`container-runner.test.ts` 断言 gauge 在镜像存在/缺失时分别置 1/0。
- **工作量 S · 价值 低**

### 1.3 `.env.example` 342 行,缺"最小可用"导航 — ✅ 已落地(67849c8)
- **现状**:`.env.example` 确实 342 行,但 L16-24 已说明"Required 仅在功能启用时才需要",`src/config-validate.ts` L1-31 也实现了 fail-fast + 拒绝弱密钥。问题不是配置检查缺失,而是**缺一份"哪些变量真的必填"的导航**。
- **业务影响**:低到中等。新手看到 342 行有心理负担,但配错会被快速捕获,不会"静默错误"。
- **建议**:加 `docs/ENV-QUICK-START.md`,按场景分组(最小 CLI / 生产 Feishu+网关 / 可选 observability),每组附"为什么需要 + 如何获取"。文件本身不动,只加导航层。
- **已实现**:新增 `docs/ENV-QUICK-START.md`,按场景分组(A 最小本地 CLI / B 生产 Feishu+网关 / C 可选 tracing),每个变量标注"是否必填 + 为什么 + 哪儿拿",并把 fail-fast"仅功能启用时才必填"与弱密钥硬错误两条规则前置说清。`.env.example` 本身**未重构**,仅在头部加一行注释指针引导新人先看导航(注释行,`readEnvFile` 忽略,parser 安全)。README 文档区加链接。grounded:变量名/默认值/必填条件核对自 `.env.example`(`MAX_CONCURRENT_CONTAINERS` 默认 10、`WEBHOOK_PORT` 默认 3000、webhook/hybrid 下 `FEISHU_ENCRYPT_KEY`+`FEISHU_VERIFICATION_TOKEN` 必填等)。`scan-secrets` + `configure-enterprise-gateway` 测试仍绿(25 passed),确认头部注释不破坏密钥扫描/解析。
- **工作量 S · 价值 中**

### 1.4 网关只有可运行参考,缺生产框架模板和"业务化"示例 — 🟡 已落地(7f351e6)
- **现状**:契约文档(`docs/enterprise-erp-gateway.md`)、zod schema、零依赖参考实现(`examples/reference-gateway/server.mjs`,含 hookpoint 注释)都齐全。但:(1) 参考实现的 3 个操作都是 `conformance.noop / demo.echo / demo.order.create`,**离真实业务流程偏远**;(2) **没有 Express/Fastify/Hono 的生产骨架**,运营者容易误以为必须从零手写。
- **业务影响**:中等。运营者懂协议,但跳到"我自己的后端怎么接"时要多花 2-4 小时。真实企业受益于"clone 改配置",而非"逆向参考实现"。
- **建议**:建 `examples/gateway-templates/`(Express/Fastify/Hono 三套骨架),配 `docs/gateway-kickstart.md`(clone → 填凭证 → 部署 + 权限拒绝/审计/幂等重放/审批集成的错误处理菜谱)。reference-gateway 再补 1-2 个接近业务的操作(如 `todo.list`/`todo.create`)。
- **已实现**:
  - `docs/gateway-kickstart.md` —— "从可运行参考接到你自己后端"的上手指南:6 个 hookpoint 表 + 6 条生产硬化菜谱(身份映射与 `requesterSource` 信任门、`/authorize` 权限拒绝与 `obligations: ['user-confirmation']` 审批、幂等重放、审计 `auditId` 关联、HMAC + 时钟偏移窗口 + nonce 重放缓存、错误码→闭合枚举映射表)+ 一段 Express 移植骨架 + 上线前 checklist。从 README / `enterprise-erp-gateway.md` / reference-gateway README 三处交叉链入。
  - reference-gateway 补了真实读写对 `todo.list` / `todo.create`(per-subject 存储),取代"只有 echo/noop"的观感;并**真正实现了幂等重放**(`idempotencyKey` 命中即重放同一结果,而非原先仅一行注释),让 kickstart 的幂等菜谱有可运行代码背书。conformance 仍 6/6 绿。
  - 错误码映射表与 `classifyHttpError` / `defaultRetryable`(`gateway-contract.ts`)实际行为对齐(401/403→UNAUTHORIZED 不可重试、5xx→UNAVAILABLE 可重试、结构化 body 的 `code` 优先、版本漂移仅告警)。
- **有意未做(避免冗余)**:未建 Express/Fastify/Hono 三套独立骨架 —— 零依赖 reference-gateway 本身已是可运行模板,三套骨架只是同一份 handler 逻辑换 router 语法,价值低且增加维护面。kickstart 指南明确指出移植是机械工作并给出 Express 范例;Fastify/Hono 仅 router/body-parser 语法不同。如运营者实际需要再补。
- **工作量 M · 价值 高**

### 1.5 缺主流通道(Slack 等)参考实现
- **现状**:`docs/channels/writing-a-channel.md` + ADR-0031(fork-free 扩展加载)已让"不改主仓接通道"成为可能,`examples/echo-channel/` 是可运行极简示例。但 echo-channel 是 in-memory,**不足以作为有真实 webhook/认证的 Slack 通道的参考**。
- **业务影响**:中等。已用 Slack 的企业接入成本上升,但 ADR-0031 已大幅降低成本,缺的只是"一个完整 Slack 参考",不是整个能力。
- **建议**:建 `examples/slack-channel/`(完整 webhook 验证 + 事件解析 + 回复)或 `docs/channels/slack-channel.md`(对标 `docs/feishu-channel.md`)。让接入从"理解接口 + 手写 2-4h"降到"copy + 改配置 30min"。
- **工作量 M · 价值 中**

### 1.6 缺 prompt 模板库与配置参考
> 🟡 **配置参考已实现**(上手 batch):新增 `docs/configuration-reference.md`——穷举 per-group `container.json` 全部字段(identity/routing/memory/a2a/gateway/resources/network/skills/lifecycle,每条含类型/默认/host-or-container 读取/作用),并指向 `.env.example` 作为环境变量权威表。README「相关文档」加了入口;含「改字段同 PR 更新此表」维护提示。**未做**:prompt 模板库(`examples/prompt-templates/`)+ `docs/agent-prompts.md` 最佳实践——属内容创作,留作专项。
- **现状**:`CLAUDE.local.md` 机制完整(`src/group-init.ts` 自动加载),`examples/lab-frontdesk/CLAUDE.local.md` 是 300+ 行的好范例。但**没有 starter 模板、没有 `docs/agent-prompts.md` 最佳实践、没有 prompt-patterns 库**;同时运营者可配 `idleExitMs`/`memoryMode`/`a2aSessionMode`/`resources` 等却散落在 `container/agent-runner/src/config.ts` 各处,**无 `docs/configuration-reference.md` 汇总**。
- **业务影响**:中等。部署 5 个 agent 要从零写 5 份 prompt;运营者可能根本不知道某些 per-group 配置项存在,得逆向源码。
- **建议**:(a) 建 `examples/prompt-templates/`(frontdesk / generic-worker / approval-specialist / data-lookup / order-processing);(b) 写 `docs/agent-prompts.md`(结构/语气/错误处理/路由表/确认规则配方);(c) 写 `docs/configuration-reference.md` 穷举所有 per-group 字段 + 环境变量。
- **工作量 prompt 模板 M / 配置参考 S · 价值 prompt 高 / 配置 中**

---

## 主题二:分流派活与对话质量(平台核心的横切能力)

### 2.1 误路由后几乎没有反馈与学习机制 ⭐
- **现状**:分类日志已实现(`src/modules/classification-log/index.ts`、`src/db/classification-log.ts`),`reconcileClassification`(`src/delivery.ts:1094-1146`)做了 outcome 戳记。但 `src/metrics.ts:110-122` 的 `classification_bypass_total` **只统计技术性 bypass**,没有混淆矩阵;classification_log schema 无 `outcome_feedback`/`reroute_count` 字段;没有"我们路到了 X 但其实该路到 Y"这个业务信号,也无运营者面板。
- **业务影响**:**高**。规则失效或 prompt 漂移时运营者无信号,只能手工翻日志。多租户/大规模部署下是重大盲区。
- **建议**:(1) classification_log 加 `outcome_feedback`(软枚举 null/correct/misrouted);(2) 容器内加 MCP 工具让 worker 标记"误路由 + 建议目标";(3) 加混淆矩阵 metric(recommended_worker × actual_outcome);(4) 面板切片"本该我处理却流走的消息"。
- **工作量 M · 价值 高**

### 2.2 跨 worker 对话链缺统一 `conversation_thread_id` ⭐
> ⏸️ **评估后留作专项(需 ADR + 多 commit)**:这是 load-bearing 运行时契约变更——`conversation_thread_id` 要贯穿约 10 个文件(= `origin_user_id` 传播面),涉及①中央迁移(classification_log 加列)②session DB 迁移函数(messages_in/out 加列,走 migrateMessagesInTable 的 ALTER-on-open 模式覆盖在飞会话)③在对话起点生成④跨 a2a 跳传播(镜像 `origin_user_id` 的 writeSessionMessage 透传)。触及三库单写写路径 + a2a 身份传播这两条 load-bearing 路径,CLAUDE.md 要求契约变更同步文档,且不该在一次自主 pass 里赶工。**建议路径**:先写 ADR 定 schema + 传播契约,再分 commit(迁移 → 传播 → 测试),按 `origin_user_id` 已验证的模式做。**没有有意义的「安全小切片」**:单 classify 的 thread id ≈ 已有的 classification_id,价值全在多跳传播(即风险所在)。
- **现状**:无贯穿 frontdesk classify → worker A → worker B → 回复的顶层线程 id。classification_log 记单次事件,messages_in 按 session 记入站,a2a 用 `source_session_id` + `in_reply_to`。**三张表都没有 conversation 级别标识**。要追踪一个请求的完整链路需多表 join + 时序重建。
- **业务影响**:**高**。运营者无法快速回答"请求 X 现在在哪""这次多跳花了多久"。SLA 追踪和问题诊断要靠人肉翻日志。
- **建议**:给 classification_log、messages_in、messages_out 加 `conversation_thread_id`,在 frontdesk classify 时生成,通过 request-context 贯穿所有下游 a2a 跳。这是核心需要的列;之上的"对话时间线"视图可做成下游可观测性模块。
- **工作量 M · 价值 高**

### 2.3 "Escalation / 转人工"无显式模式和 SLA 保证 ⭐
- **现状**:a2a 路由(`src/modules/agent-to-agent/agent-route.ts`)把所有转交一视同仁,无论是 worker→worker 还是 AI→人。无 `escalation_reason`/`urgency_level`/优先队列概念,`src/metrics.ts` 无 `escalation_total`,无 escalations 审计表。AI 转人工只能复用普通 a2a `send_message`。
- **业务影响**:**高**。混合 AI/人部署中,升级被当普通转交,易违反 SLA;无升级成功率/响应时间可见性。
- **建议**:加 `escalate` 动作(与 delegate/clarify 并列)+ `escalation_reason`/`urgency_level`;建 escalations 审计表;emit `escalation_total{reason,urgency,outcome}`。队列优先级属业务逻辑(归网关),但核心应提供 hook:classification_log 的 escalation_reason 字段、a2a 元数据里的 urgency。
- **工作量 M · 价值 高**

### 2.4 置信度阈值硬编码 0.70,无法按队伍/场景调
> ✅ **已实现**(对话质量 batch):container.json 新增可选 `confidenceThreshold`(`RunnerConfig`,`buildRunnerConfig` 校验 (0,1) 否则回退默认 0.70);`confidenceAdvisory(confidence, candidateCount, clarifyBelow=0.70)` 用该阈值(文案里的数字也跟着插值),classify_intent handler 经 `getConfig()` 安全读取(未加载则回退默认)。财务组可设 0.85 更严、客服组设 0.55 更宽——**每组一份 container.json,核心零预设业务规则**。config.test.ts + classify-intent.test.ts 加了测试。
- **现状**:`classify-intent.ts:62-79` 的 `confidenceAdvisory` 全局硬编码 0.70。`agent_groups`/`messaging_group_agents` 表(`src/db/schema.ts:42-58`、`src/types.ts:84-100`)无 `confidence_threshold` 字段。财务(应更严)和客服(可更宽)用同一阈值。
- **业务影响**:中等。0.70 对多数场景保守合理,但多层级企业会觉得要么太严(过度澄清拖慢例行请求)要么太松(误路由返工成本高)。
- **建议**:在 agent_group 或 messaging_group_agent 加可选 `confidence_threshold` 覆盖;classify_intent 接受动态入参。核心保持业务无关(无预设规则),运营者通过 schema 配。
- **工作量 M · 价值 中** — ✅ **已实现(见上)**

### 2.5 "我改主意了" / 返工(nack)流程无正式支持
- **现状**:a2a 支持委派,`resolveTargetSession`(`agent-route.ts:173-212`)有三层会话解析(返回路径/peer 亲和/最新活跃),但**没有 nack/reject API** 让 worker 把消息退回并请求重路由。worker 收到越界请求只能手工回复(丢失结构化路由)或让消息留在自己这里。
- **业务影响**:中到高。多团队大规模部署下是每日摩擦点,影响 SLA 预期。
- **建议**:加可选 nack/reject-with-reason:(1) `delivery.ts` 加 `nack_message` 系统动作(reason + 可选 suggested_target);(2) classification_log 记为独立 outcome;(3) frontdesk 把 nack 当下次尝试的澄清提示。可与 2.3 的 escalate 一起设计。
- **工作量 M · 价值 中**

### 2.6 累积消息策略(accumulate)缺细粒度控制与观察
- **现状**:`src/router.ts:374-453` 实现了 `ignored_message_policy='accumulate'`(trigger=0 存储,`src/db/schema.ts:180-181`),但 messages_in **无 `accumulated_at`/`was_engaged`/priority 列**;router 记了 engaged/accumulated 计数(L386-387)却不按 group emit metric;无 backlog 清理/归档 API。策略是二元的(drop vs accumulate),无 per-worker 或时间上限。
- **业务影响**:中等。长对话中累积上下文降低信噪比,worker 要翻几百条旧消息;无内置清理或大 backlog 可见性。
- **建议**:把策略扩成结构化 `{policy, max_backlog, retention_hours}`;messages_in 加 `accumulated_at`/`was_engaged`;按 group emit backlog 大小 metric;加可选 `archive_accumulated` 动作。
- **工作量 M · 价值 中**

### 2.7 多意图/话题切换分解(留给 prompt,核心保持克制)
- **现状**:`classify-intent.ts:81-223` 设计上强制单一 `recommendedWorker`,低置信(<0.70)时 `confidenceAdvisory` 已 nudge 向 `clarify`(L62-79)。但**无内置多意图分解、无话题切换检测、无跨会话上下文链接**(per-session 上下文是有意为之)。
- **业务影响**:中等。多意图分解责任落在 LLM prompt 和系统设计上,低置信澄清部分缓解了痛点。
- **建议**:这是**业务逻辑,更适合放在网关/frontdesk prompt**,核心保持业务无关。若确需:可选地让 classify_intent 接受 `detected_topic_changes[]`,sessions 表加可选 `related_session_ids[]`。但**先验证是否真需要平台改动 vs 更好的 prompt 工程**。
- **工作量 M · 价值 中(优先 prompt 工程)**

---

## 主题三:后端网关契约对真实企业后端的契合度

### 3.1 缺批量/bulk 操作原语 ⭐
- **现状**:契约 `input` 是 `Record<string, unknown>`,`/execute` 只处理单操作(`gateway.ts:655-681`,`docs/ERP-INTEGRATION-GUIDE.md:104-134` 只有单操作示例)。"原子创建 50 个订单"必须拆成 50 次 `/execute`。后端虽可自定义 `bulk_create` 操作,但平台**零指引、零示例、零脚手架**。
- **业务影响**:**高**。薪资、发票对账、库存同步等真实 ERP 流程常涉及批量。50 次独立调用倍增延迟、撑大审计日志、放大部分失败窗口。
- **建议**:加**可选** `/bulk_execute` 指引:`POST {operations:[{operation,input,idempotencyKey}], atomic?}` → `{ok, results:[...], partial?}`。保持向后兼容(未实现返回 404 OPERATION_NOT_FOUND)。文档讲清权衡:per-operation 幂等比 per-batch 更安全。
- **工作量 M · 价值 高**

### 3.2 缺异步/长任务模式(只有同步超时模型)⭐
- **现状**:`gateway.ts:522-524` 固定 AbortController 超时(默认 15s)。超过窗口的操作(总账过账、批量对账、预测计算)直接 TIMEOUT。`ERP-INTEGRATION-GUIDE.md:279-302` 的 async approval 只是**业务特定 workaround**,不是通用 async 原语。无 `/task/status`、无 `/submit_async`。
- **业务影响**:**高**。很多 ERP 操作本就长耗时,强制 15s 不现实。运营者只能调大 timeout(增加失败风险)或在契约外自建 async-job(割裂架构)。
- **建议**:加**可选**异步提交:`/execute` 带 `{submitAsync:true}` 立即返回 `{taskId, statusUrl}`;加 `/task/status` 返回 `{status, progress?, result|error}`。同步 execute 仍是默认,async 选择性开启。
- **工作量 L · 价值 高**

### 3.3 `/describe` 缺操作 schema / 字段发现 ⭐
> ✅ **已实现**(网关契约 batch):新增 `operationDescriptorSchema`(name/summary/mutating/approval/requiredFields + 可选 `schema.properties.<field>.{type,required,enum,…}`,全可选 + passthrough,`describeResponseSchema.operations` 从 `z.unknown()` 收紧为它但保持完全宽松,向后兼容);`gateway.instructions.md` 指引 agent「读操作的 `schema` 取确切输入形状,别猜;调用校验失败就重查」;reference-gateway 的 `demo.order.create` 给了带 `schema.properties` 的示例;gateway.test.ts 加了结构化操作 + 向后兼容测试。
- **现状**:`/describe` 返回 `{operations:[...]}` 但**操作的字段 schema 未规定**,参考实现(`server.mjs:81-106`)只有 name/description/requiredFields。Agent 必须硬编码每个操作的字段知识。ERP schema 变更(新必填字段/废弃字段/枚举值)时 agent 失同步,要人工改 prompt。多租户运营者管 50+ ERP 时无法按版本自动生成 agent 指令。
- **业务影响**:中等。静态 schema 绑定脆弱,运营者要维护 per-ERP 文档并在变更时同步 agent。
- **建议**:扩 `/describe` 响应(可选)含操作 schema:`{operations:[{name, summary, schema:{properties:{field:{type,required,enum,pattern,...}}}, mutating, approval}]}`。后端暂返最小 schema;conformance runner 至少校验 name+summary。
- **工作量 M · 价值 中**

### 3.4 文件/附件处理不在契约内 ⭐ — ✅ 已落地(bf3f76e)
- **现状**:`gateway.ts:528-530` 固定 `Content-Type: application/json`。无 multipart、无 base64 约定、无二进制/大文档指引。"上传 PO PDF 审批"无标准传法。
- **业务影响**:中等。真实流程涉及发票/BOM/合同/PDF,缺标准文件处理逼运营者自建 workaround(本地文件服务 / S3 引用 / 手工 base64)。
- **建议**:在 `enterprise-erp-gateway.md` 文档化文件处理模式:(1) 小文件(<1MB)内联 base64;(2) URL 引用存 memory;(3) 大文档走带外文件服务(S3 签名 URL 经 context 传递)。Content-Type 保持 json,无需 multipart 改动。
- **已实现**(纯文档,无契约/代码变更——建议本就是"保持 json,无 multipart"):`enterprise-erp-gateway.md` 新增 "File & attachment handling" 章节。先说清网关是 **JSON 控制面**(`input`/`context` 均 free-form `z.record`,Content-Type 固定 json,有意无 multipart),再讲入站文件落地 `/workspace/downloads/{messageId}/`(agent 用 Read/Bash 取字节),按大小给 3 个模式:(1) ≲1MB 在 `input` 内联 base64(提示 ~33% 膨胀、勿塞大 blob);(2) 已托管文件传 URL/handle 不传字节、引用经 memory_upsert 记忆;(3) 大/二进制走带外预签名 URL(后端 `files.requestUpload` 返回 PUT URL → agent 直传字节 → 业务操作只引用 objectId;反向用 send_file),网关永不见字节。附 审计/保密提示:`gateway_audit` 存 body 摘要而非原文,但内联 base64 仍过宿主与签名代理,敏感件默认走(2)/(3)。grounded:`/workspace/downloads` 路径、free-form input/context、json-only、send_file、audit 摘要均已核对。
- **工作量 M · 价值 中**

### 3.5 部分失败 / 事务语义未明确 — ✅ 已落地(69c1343)
- **现状**:幂等**已支持**(写操作带 `idempotencyKey`,`ERP-INTEGRATION-GUIDE.md:236-256` 文档化,`gateway.ts:667` 自动生成),所以**重试是安全的**。但错误 schema 无字段区分"成功但有警告"vs"完全失败",无法表达"发票建了但总账过账失败"。ADR-0028 有意保持封闭简单错误枚举。
- **业务影响**:中等。运营者必须谨慎设计幂等,把操作拆成独立单元以防部分失败污染数据。契约不阻止好设计,但不强制。
- **建议**:扩 `enterprise-erp-gateway.md` 错误 schema 章节,讲清"何时用结构化错误 vs HTTP 状态"并举例;加"Transactions & Compensation"章节(dryRun preview + commit、显式补偿操作如 `sales.order.unpost`)。这主要是**应用设计责任**,非契约缺陷。
- **已实现**(纯文档,无契约变更——3.5 本就是"应用设计责任"):
  - `enterprise-erp-gateway.md` 错误段加 "Structured error vs HTTP status — which to use" 子节:永久可纠错的拒绝走 HTTP 状态(retryable=false 让 agent 停);瞬时基础设施失败走结构化 `retryable:true`/5xx 触发 ADR-0016 退避;非基础设施的业务"否"用 2xx + `ok:false` 带业务原因,而非传输错误码(封闭枚举只管传输/重试分类)。
  - 新增 "Transactions, partial failure & compensation" 章节:点明平台**无分布式事务协调器**、封闭枚举无"部分成功"码,给 3 个递进模式——(1) 让每个 `/execute` 是后端原子单元(原子 `createAndPost` 或拆成各自幂等的步骤);(2) `dryRun` preview 先校验再 commit;(3) 幂等保证重试安全、**显式补偿操作**(如 `sales.order.unpost`/`payment.refund`)保证多步可恢复,平台不回滚已提交写。批量部分结果用 `ok:true` + 结构化 per-item 状态表达,可接 6.9 的 attestation。
  - 交叉锚链到 `idempotencyKey` 段与 Execution attestation 段(6.9),锚已核对存在。
- **工作量 M · 价值 中**

### 3.6 分页 / 列表操作无协议支持(留给运营者)
- **现状**:契约有意 payload 无关,`/execute` 是单操作信封。后端**完全可以**定义 `sales.orders.list` 接 `{limit,offset,cursor}` 返 `{results,nextCursor,hasMore}`。`ERP-INTEGRATION-GUIDE.md` 不提分页是因为**分页是应用关注点,不是网关协议关注点**。
- **业务影响**:运营者实现差才有风险,但平台正确地把它留给后端设计者。
- **建议**:在 `enterprise-erp-gateway.md` 加**建议性(非规范)** "Recommended list operation patterns" 小节,示范 cursor 分页。后端自由发明自己的方案。这是**运营者侧的事**,非平台缺口。
- **工作量 S · 价值 低**

### 3.7 多步工作流编排(留给后端,核心不该做)
- **现状**:平台不定义工作流原语,`create_order → add_line_items → set_shipping → approve` 要拆成 4 次 `/execute`。但契约**有意业务无关**:后端**完全可以**定义 `sales.order.create_complete` 内部管多步、返单一结果。若要平台强制工作流语义(重试/回滚/状态机),反而**违反业务无关约束**。
- **业务影响**:中等。运营者设计复合操作或用外部工作流引擎——这**正确地**委托给后端,不是平台责任。
- **建议**:在 `ERP-INTEGRATION-GUIDE.md` 加一节,指导用复合操作 + idempotencyKey + dryRun preview 在后端内部编排多步。**纯文档,核心不改**。
- **工作量 L · 价值 低**

---

## 主题四:记忆与业务知识(平台 hook + 文档)

### 4.1 上下文压缩后未自动落库到 `conversation.summary` ⭐
- **现状**:上下文压缩已实现(ADR-0033、ADR-0024),poll-loop(`poll-loop.ts:686-707`)正确处理 `compacted` 事件并注入路由提醒,但**不调用 `gateway_memory_upsert` 落库压缩摘要**。ADR-0033 L88-89、L115 明确把这一步 defer 成独立批次,**至今未实现**。
- **业务影响**:**高**。长对话压缩后上下文即蒸发,agent 无法回忆上轮决策/事实,打破"agent 记得"的心智模型。
- **建议**:实现 defer 的 summary flush:`compacted` 事件后异步(不阻塞当前轮)调 `gateway_memory_upsert(namespace='conversation.summary')`,写入关键决策/用户偏好/待办。注意与消息投递不竞争。这是明确的独立工程任务,非设计缺陷。
- **工作量 M · 价值 高**

### 4.2 缺知识新鲜度 / staleness 指引 ⭐
> ✅ **已实现**(记忆契约 batch):`describeResponseSchema` 的 namespace 条目新增可选 `freshnessWindowMs`(每 namespace 的新鲜度 TTL);`gateway.instructions.md` 新增指引:agent 比对 `source.updatedAt` 与该 namespace 的 `freshnessWindowMs`(或快变领域),过窗口则重取或提示用户值可能过期;reference-gateway `/describe` 给了两个带 freshnessWindowMs 的 namespace 示例。
- **现状**:契约有可选 `updatedAt`(`gateway-contract.ts:241`),但 `gateway.instructions.md`(L28-35,83-86)**只说工具用法,不提新鲜度语义**。Agent 看得到时间戳却无阈值/重取逻辑指引,参考网关也无 staleness 演示。
- **业务影响**:中到高(价值高)。快速变化领域(定价、组织结构、权限)中,agent 可能基于过期事实行动而无警告信号。主要是运营者侧关注点,但平台缺指引。
- **建议**:在 `gateway.instructions.md` 加新鲜度模式:agent 检查 `updatedAt`,超窗口则重取或警告。可做成 `/describe` 的 per-namespace 策略(`namespaces:[{name, freshnessWindow}]`)。参考网关给一个含新鲜度元数据的 `/describe` 示例。
- **工作量 S · 价值 高**

### 4.3 Agent 无法发现可用 memory namespace ⭐
> ✅ **已实现**(记忆契约 batch):`describeResponseSchema` 新增可选 `namespaces: [{name, description?, scope?, writeable?, freshnessWindowMs?}]`(`memoryNamespaceSchema`,passthrough + 全可选 → 向后兼容);`gateway.instructions.md` 指引 agent「需要不确定的 namespace 时调 gateway_describe 看 namespaces,别瞎猜」;reference-gateway 给了示例;gateway.test.ts 加了 3 个 schema 测试(接受 namespaces / 无 namespaces 仍合规 / 缺 name 拒绝)。
- **现状**:`gateway_describe`(`gateway.ts:619-632`)响应 schema(`gateway-contract.ts:204-209`)**不含 `namespaces` 数组**。Agent 必须在 CLAUDE.md 硬编码 namespace 知识。运营者新增 namespace(如 `compliance.policies`)时,现有 agent 无法发现,得改 prompt。
- **业务影响**:中等。限制运营者敏捷性,多租户/演进部署中 agent 指令里的 namespace 列表易过期。
- **建议**:扩 `describeResponseSchema` 含可选 `namespaces:[{name, description, scope, writeable, expectedSchema?}]`。Agent 指令加 fallback:"需要没见过的 memory 时,调 gateway_describe 看 namespaces"。小 schema 改动,消除可用性缺口。
- **工作量 S · 价值 中**

### 4.4 冲突事实无检测/调和
> 🟡 **已实现核心**(记忆契约 batch 2):`memorySearchResultSchema` 新增可选 `conflictsWith: string[]`(冲突 recordIds)+ `resolved: boolean`(passthrough + 全可选,向后兼容);`gateway.instructions.md` 指引 agent「result 带 conflictsWith 且 resolved 非 true 时,别默默用第一条,向用户暴露分歧或按 updatedAt/provenance 取舍」;gateway.test.ts 加了 2 个 schema 测试。**未做(留运营者)**:reference-gateway 的冲突检测示例(naive keyword 后端造假冲突会误导)、后端版本向量/LWW 实现指南 → 属运营者后端文档。
- **现状**:工具齐全(`gateway_memory_get/upsert(merge)/search`),后端可实现 merge 语义,但响应契约**无冲突检测元数据**。search 返回多条冲突 `value` 时 agent 都看到却无"它们冲突"的信号。`merge` flag 定义为"后端语义",无版本/冲突标记/调和工具指引。
- **业务影响**:多 agent/多同步场景下高——冲突事实可静默存活,agent 可能基于 search 返回的第一条行动而不知有其他值。
- **建议**:扩 memory 响应 schema(可选)含 `conflictsWith: recordId[]` 和 `resolved` flag;给运营者一个检测冲突的后端示例(版本向量或 LWW);文档化 per-namespace 冲突策略。
- **工作量 M · 价值 高**

### 4.5 知识范围(org/team/user)无平台指引(留给运营者 + 文档)
- **现状**:契约接受任意 `subject.type`/`subject.id`(`gateway-contract.ts:137-148`),运营者**可建模任意范围**。但**无推荐 subject 类型词汇、无隔离规则示例、无一致性校验**。运营者可能本想写 team 却误写 user 而无警告。
- **业务影响**:中等。运营者要从零设计范围规则,后端隔离没做好则有跨用户/跨团队泄露风险。
- **建议**:写 memory-scoping 设计指南(docs 或 ADR),给推荐词汇(user/team/department/org/contract)和 per-type 隔离规则;`/describe` 可选含范围策略元数据;参考网关加范围隔离校验示例。**主要是运营者文档,非平台改动**。
- **工作量 M · 价值 中**

### 4.6 知识反馈闭环 / 运营者策展缺失
- **现状**:`gateway_audit`(`src/db/gateway-audit.ts`)只读记录"谁访问了什么 memory",**无反向通道**让 agent/运营者上报某记录不准/过期/需更正。审计记消费,无质量反馈。
- **业务影响**:中到高。长寿知识库数据质量随时间退化,坏知识无法回溯标记/更正,运营者失去"哪些记录在惹麻烦"的可见性。
- **建议**:设计可选 `/memory/feedback`(future ADR):agent 上报不准(recordId/issue/sessionId);加 `knowledge_feedback` 表聚合;运营者据高反馈记录排查更正。**当前版本可暂缓**。
- **工作量 L · 价值 中**

---

## 主题五:治理(审批 / RBAC / 审计合规)

> 这块整体是平台核心责任(身份链已是 load-bearing 不变量),下面是**审计完整性**的补洞,多数是 S 工作量高价值的快赢。

### 5.1 角色授予/撤销、成员变更无审计 ⭐
> 🟡 **部分已实现**(治理审计补洞 batch 1):`grantRole()` 现 emit `user_role_granted`、`revokeRole()` 加可选 `revokedBy` 参数并在实际删除时 emit `user_role_revoked`(`src/modules/permissions/db/user-roles.ts`),`permissions.test.ts` 加了验证测试。**剩余**:`agent_group_members` 成员变更的审计(同模式,后续批次)+ 把 `revokedBy` 真正接到生产 caller。
- **现状**:`grantRole()`/`revokeRole()`(`src/modules/permissions/db/user-roles.ts:8-30`)直接改 `user_roles` 表,**不调 `recordEnterpriseAudit`**;agent_group_members 变更同样无审计。`schema.ts:79` 的 `granted_by` 列只是信息性,未被审计。
- **业务影响**:**高**。越权授予或离职员工权限遗忘移除,在合规审查中无法发现;权限变更不可取证重建。
- **建议**:`grantRole()` 包 `recordEnterpriseAudit({eventType:'user_role_granted', actor:grantedBy, details:{userId,role}})`,`revokeRole()` 同理;要求所有 caller 传 grantedBy;在 permissions.test.ts 加测试验证每次 grant/revoke 都 emit 审计。agent_group_members 同模式。
- **工作量 S · 价值 高**

### 5.2 审批过期/拒绝/升级无集中审计,缺审批元数据 ⭐
> ✅ **已实现核心**(治理审计 batch 4):两条 resolve 路径在**删行前** emit `recordEnterpriseAudit({eventType:'approval_resolved', actor:审批人, details:{approvalId,action,result,outcome}})` + `approval_events_total{action,result}` 指标——OneCLI(`resolveOneCLIApproval` 加 `actorUserId` 入参)与 agent-initiated(reject / approve-applied / approve-no-handler / approve-failed 四个分支)。新增 response-handler.test.ts(用真 session 文件夹 + mock 容器运行时,验拒绝/批准都落审计)。**有意未加 schema 列**(approver/decision_timestamp/decision_reason):pending_approvals 行在 resolve 时即删,持久合规记录落在 enterprise_audit 才对,瞬态列价值低。
- **现状**:OneCLI 审批 resolve 时(`onecli-approvals.ts:81`)只 `log.info`,**删行前不 emit 审计**;agent-initiated 审批(`response-handler.ts:74,96`)也只 log.info。`pending_approvals` 表(`module-approvals-pending-approvals.ts`)**无 `approver_user_id`/`decision_timestamp`/`decision_reason` 列**。审批决策只在日志(易失),不在审计表(可查)。
- **业务影响**:中等(价值标中)。审计员无法回答"谁批了这个凭证请求""这个安装包何时被拒、为何",得关联日志。
- **建议**:`pending_approvals` 加 approver_user_id/decision_timestamp/decision_reason;在 resolve 前调 `recordEnterpriseAudit`(decision 结果);加 metric `approval_event{action,result,duration_ms}`。
- **工作量 S · 价值 中**

### 5.3 agent-initiated 审批无过期 sweep + 无多审批人
> 🟡 **过期 sweep 已实现**(治理审计 batch 5):`expireStalePendingApprovals(olderThanMs)`(db/sessions.ts)把超期的 `pending` 审批置 `expired` 并返回受影响行;host-sweep 周期调用(`AGENTDESK_APPROVAL_EXPIRY_DAYS` 默认 7,0=关),每行 emit `approval_expired` 审计 + `approval_events_total{result:'expired'}`,堵住「高风险 agent-initiated 审批无限挂起」。host-sweep.test.ts 加了 sweep 测试(只过期超期 pending、保留近期、幂等)。**未做**:多审批人共识(approvers JSON + threshold)——较大特性,单列后续。
- **现状**:OneCLI 审批过期**已正确强制**(`onecli-approvals.ts:200-214` 超时拒绝 + L222 设过期状态 + L90 启动 sweep)。但 **agent-initiated 审批**(install_packages/add_mcp_server)用了 `expires_at` 列却**无后台 sweep**,会无限挂起直到手工删。另外**无多审批人共识**(pickApprover 返优先列表,首个可达者赢)、无 `approval_votes` 表。
- **业务影响**:高。高风险动作的 agent-initiated 审批可无限挂起且无"谁被问 vs 谁批准"的审计,真实合规缺口。
- **建议**:在 host-sweep 加后台任务,过期 agent_group 类 pending_approvals(`APPROVAL_EXPIRY_DAYS`,默认 7 天),置 'expired' 并 emit 审计;多审批人:`pending_approvals` 加可选 approvers JSON + threshold,`handleRegisteredApproval` 按阈值放行。MVP 先单行记 approved_by_user_id。
- **工作量 M · 价值 高**

### 5.4 合规级审计导出 / 保留策略 / 防篡改缺失 ⭐
> 🟡 **导出已实现**(治理审计 batch 6):`exportAuditForCompliance({since,until,tables,signingKey})`(`src/db/audit-export.ts`)按时间窗读三张审计表、确定性序列化(行按 occurred_at,id 排序 + 对象键排序)、用 `AGENTDESK_AUDIT_EXPORT_KEY` 做 HMAC-SHA256 签名(未设则产出但 UNSIGNED 并告警);CLI `pnpm audit:export [--since --until --tables --out]`;audit-export.test.ts 验窗口过滤/确定性签名/可验证/无 key 降级/子集表。保留策略(2)**已在批E实现**(`AGENTDESK_AUDIT_RETAIN_DAYS`)。SECURITY.md 审计行已更新。**未做**:(3) 审计行防 UPDATE 约束 + (4) purge>10% 告警 + audit_retention_policy 表——需 schema 迁移,单列。
- **现状**:三张审计表(gateway/enterprise/dm)有 query 和 opt-in purge,但:(1) **无批量签名导出**;(2) **无自动保留策略**(运营者得记得手工 purge);(3) **审计行可被 UPDATE**(SQLite 默认无约束);(4) session DB 用 `journal_mode='DELETE'` 掉电不存活(`docs/db-central.md §3`)。
- **业务影响**:高。审计员无法可靠导出防篡改格式的审批决策;保留靠人工易错;无掉电数据存活 SLA。SOC2/GDPR 真实合规缺口。
- **建议**:加 `exportAuditForCompliance(since,until,format,tables)` 生成确定性 CSV/JSON + HMAC-SHA256 签名;建 `audit_retention_policy` 表;host-sweep 按 cron 调 purge(`AGENTDESK_AUDIT_RETENTION_DAYS`);审计 PK 加约束防静默 UPDATE;若 purge 将删 >10% 行则告警(疑似配置错误);文档化 `docs/audit/governance-export.md`。
- **工作量 M · 价值 高**

### 5.5 a2a 委派跳数无平台级审计 ⭐
> ✅ **已实现**(治理审计补洞 batch 3):`routeAgentMessage`(`src/modules/agent-to-agent/agent-route.ts`)在消息成功写入目标会话后 emit `agent_delegation`(actor=交叉校验后的 origin_user_id,details={from,to,sourceSessionId,targetSessionId,a2aMsgId,spawnDepth})。**仅跨 agent 边**(self-message 系统回环不算委派,不审计)。agent-route.test.ts 加了正/负两个测试。多跳审批链现在在平台层有面包屑。
- **现状**:`origin_user_id` 跨 a2a 跳传播(`docs/db-central.md §1.8`)已实现,但 `src/delivery.ts:491-505` 路由 a2a 消息时**不 emit `recordEnterpriseAudit`**。多跳审批链(frontdesk → 审批 worker → 财务 worker)只在网关层(gateway_audit)可审,**AgentDesk 委派边界无审计面包屑**。agent 若被攻陷注入假委派,单看 AgentDesk 审计无法发现。
- **业务影响**:中等。委派跳数无平台级审计,复杂审批链留无中心面包屑,真实合规缺口。
- **建议**:在 `delivery.ts` a2a 分支(L491-505)路由前 emit `recordEnterpriseAudit({eventType:'agent_delegation', actor:origin_user_id, agentGroupId, details:{target_agent_group_id, target_session_id, message_id, delegation_depth}})`。
- **工作量 S · 价值 中**

### 5.6 命令闸拒绝不审计,匿名 userId 仅记 warn
> ✅ **已实现**(治理审计补洞 batch 1):`router.ts` 在 gate `deny` 时 emit `command_gate_deny`(actor=userId,details={command});`gateCommand()` 保持纯函数(无副作用),审计放在 caller。**未做**:'pass' 不 emit(每条 admin 命令都记会噪音,按 review 建议略过)。
- **现状**:`gateCommand()`(`src/command-gate.ts:42-66`)接受 userId=null 返 deny 但**不 emit 审计**(只 log.warn)。ADR-0019 的 fail-closed 默认是对的,缺的只是**审计完整性**:被拒的 admin 命令应入审计表,不止日志。
- **业务影响**:中等(价值标中)。滥用尝试和命令拒绝在平台层不可审,安全团队无法检测可疑命令模式(如反复失败的提权)。
- **建议**:`gateCommand()` 返 deny 后 emit `recordEnterpriseAudit({eventType:'command_gate_deny', actor:userId??'anonymous', details:{command, reason}})`,通过的 emit `command_gate_pass`。这是审计完整性,非安全默认问题。
- **工作量 S · 价值 中**

### 5.7 Roster DM 授权生命周期(创建/撤销)未入 enterprise_audit
> ✅ **已实现**(治理审计补洞 batch 2):`insertDmGrant` emit `roster_grant_created`(actor=consentOriginUserId)、`revokeScope`/`revokeParticipantInScope` emit `roster_grant_revoked`(仅在实际撤销时)、`revokeGrantsForLeaver` emit `roster_grant_revoked_by_platform_event`(member_left / chat_disbanded);roster-dm.test.ts 加了验证测试。现可重建任意时刻的同意状态。
- **现状**:dm_audit(`src/db/dm-audit.ts`)记每次 roster DM **投递决策**(delivered/rejected),但 `insertDmGrant()`/`revokeScope`/`revokeParticipantInScope`(`src/db/dm-grants.ts:86-142,230-250`)**不 emit enterprise_audit**。审计员能看投递结果,但**无法重建某时刻的同意状态**(grant 何时建、谁建、何时撤)。
- **业务影响**:中等。完整审计重建的真实合规缺口。
- **建议**:insertDmGrant 时 emit `roster_grant_created`,revoke 时 emit `roster_grant_revoked`,平台 leave/disband 事件 emit `roster_grant_revoked_by_platform_event`。更新 ADR-0023 实现注记。
- **工作量 S · 价值 中**

### 5.8 fail-closed 决策无可查 metric/告警 — ✅ 已落地(81cd293)
- **现状**:ADR-0019 的 fail-closed 默认正确(命令闸拒绝、非法 engage_pattern regex 拒绝、审批卡运营者身份校验),但拒绝时运营者**只收 log.warn,无 metric/告警**。坏 regex 可能因不 emit metric 而几天无人察觉。
- **业务影响**:低(价值标低)。运营者不知 fail-closed 策略是频繁触发(配置错)还是从不触发(策略错)。
- **建议**:每个 fail-closed 决策 emit `policy_check_failed_total{policy,reason}`;Prometheus 告警阈值(`AGENTDESK_POLICY_VIOLATION_THRESHOLD`);RUNBOOK.md 文档化。
- **已实现**:新增统一 counter `agentdesk_policy_check_failed_total{policy,reason}`(`metrics.ts`),在三处 fail-closed 决策点 emit——`command_gate`/`admin_denied`(router.ts deny 分支,与 5.6 的 `command_gate_deny` 审计并排)、`engage_pattern`/`invalid_regex`(router.ts,与既有专用指标 `engage_pattern_invalid_total` 并存)、`approval_operator_identity`/`mismatch`|`absent`(feishu.ts 卡动作身份校验)。给出一个**收敛的可查面**(`sum by(policy,reason) rate(...)`)区分"频繁触发 vs 从不触发"。告警只为安全相关且非日常噪声的一项加:`AgentDeskApprovalIdentityRejections`(approval_operator_identity 持续非 0 → 可能卡受众配错或有人点别人审批卡);command_gate/engage_pattern 属日常或已有专用告警,不另发以免噪声。RUNBOOK §3.11 + 快查表行 + alerts.yml 规则。`metrics.test.ts` 锚定指标名/labels 契约(被告警与 RUNBOOK 逐字引用)。
- **未采纳**:可配阈值 env `AGENTDESK_POLICY_VIOLATION_THRESHOLD`——与既有告警风格(静态 `for:` + rate 阈值)不一致且对低价值项过度工程,改阈值直接改 alerts.yml 即可。
- **工作量 S · 价值 低**

### 5.9 审批无角色路由(所有审批人同一两按钮 UI)
- **现状**:`APPROVAL_OPTIONS` 硬编码两按钮(`src/modules/approvals/primitive.ts:36-39`),`pickApprover`(L76-93)返扁平优先列表无角色上下文。无法按动作类型路由到专门审批人(安全审查/财务审查)或条件审批("成本>$1k 需财务批")。
- **业务影响**:中等。所有审批用同一两选项界面,无视风险;无法按风险路由或条件审批。
- **建议**:扩 `RequestApprovalOptions` 含可选 `customApprovals:[{action,criteria?,roles?}]`;`pickApprover` 接 roleFilter;动态生成卡选项。需角色扩展,是较大特性,**除非客户紧迫否则可延后**。
- **工作量 M · 价值 中**

### 5.10 审批 handler 注册/分发无审计
- **现状**:`registerApprovalHandler`(`primitive.ts:59-64`)用内存 Map,重注册 warn 但**不 emit 审计**;handler 被调用(`response-handler.ts:81`)无"handler 被调"记录。
- **业务影响**:低。多数部署不动态加载模块,但对可观测性是真缺口。
- **建议**:注册时 emit `approval_handler_registered`,调用时包裹 emit `approval_handler_invoked{handler_status,error}`。**低优先**。
- **工作量 S · 价值 低**

### 5.11 角色/成员变更不触发会话重评估(留给运营者网关,补文档)
- **现状**:`revokeRole()` 后该用户的活跃 session 仍开着;router(`src/router.ts`)只在**会话创建时**查 `canAccessAgentGroup`,不 per-message 重查。但 `docs/enterprise-multi-user.md` 明确把实时策略执行定位在运营者网关——这是**架构设计,非 bug**。
- **业务影响**:中等。离职员工的开放 session 续到 timeout,但这**有意为之**,执行点是运营者网关。
- **建议**:在 `RBAC.md` 文档化:"访问控制在会话创建时评估一次;实时撤销需运营者在后端网关做 per-message 授权"。若特定客户需平台内撤销,加可选 `revoked_at` 列 + per-message 重查,但**仅在显式开启**(`AGENTDESK_RUNTIME_ACCESS_RECHECK=true`)并文档化性能影响。
- **工作量 M · 价值 中(优先文档)**

---

## 主题六:终端员工的渠道体验(Feishu)

> 这是面向真实使用者的体验层,多为 host 侧改动、不破坏渠道无关设计。

### 6.1 投递永久失败后对用户静默无反馈 ⭐
> ✅ **已实现**(渠道体验 batch):重试耗尽的永久失败分支(`src/delivery.ts`)在 `markProgressStatusFailed` 后,**直接**(非重新入队,loop-safe)用同一 adapter 给用户发一条「⚠️ I couldn't deliver my last reply … Please ask again」纯文本;best-effort——若整个渠道挂了这条也会失败(仅 log.warn),但消息特异性失败(太长/格式坏)时短文本能发出。delivery.test.ts 加了测试(种 attempts=9+逾期重试窗 → 跨过 cap 触发永久分支 → 断言通知被尝试)。
- **现状**:`src/delivery.ts:385-396` 重试耗尽时只记日志 + 调 `markProgressStatusFailed()`(`progress-status/index.ts:210-215` **仅移除 reaction emoji**),**不向用户发任何失败说明**。用户看到"思考中"emoji 消失却无解释。`delivery.ts:474-476` 若无 adapter 还会静默丢消息。
- **业务影响**:**高**。用户经历静默失败,困惑("我消息发出去了吗")、焦虑、重复发送,增加支持负担。
- **建议**:永久失败时(L385 markProgressStatusFailed 前)构造人类可读错误("因网络问题未完成,请重试")作为出站消息发回用户。host 侧责任,不破坏渠道无关设计。
- **工作量 M · 价值 高**

### 6.2 审批卡过期静默忽略,无用户通知 ⭐
> 🟡 **部分已实现**(渠道体验 batch):新增纯函数 `isExpiredQuestionPayload`(区分「过期」vs「真不支持」);`handleCardAction` 的 `!action` 分支在判定过期时,向卡片所在 chat 发一条「This request has expired … ask the assistant to send it again」纯文本提示(失败仅 log.warn),不再静默吞。primitives 测试覆盖该纯函数。**未做(可选增强)**:过期窗口可配(`FEISHU_APPROVAL_EXPIRY_MINUTES`,当前硬编码 5min)、卡体倒计时显示。
- **现状**:`src/channels/feishu/primitives.ts:376-395` 对过期 payload **静默返 null**(L386),传到 `feishu.ts:640` 只记 "unsupported payload" 日志,**不回用户**。5 分钟过期硬编码(`feishu.ts:932`)。用户午饭回来点过期卡,点击被静默吞掉,以为成功了,工作流停滞。
- **业务影响**:**高**。审批工作流中创造困惑和支持摩擦。
- **建议**:(1) 过期返 null 时带元数据让 handleCardAction 能区分过期 vs 其他不支持;(2) 发用户可见错误("审批链接已过期,请让 agent 重发");(3) 过期窗口可配(`FEISHU_APPROVAL_EXPIRY_MINUTES`);(4) 卡体显示倒计时。
- **工作量 M · 价值 高**

### 6.3 Feishu 无能力发现(help)入口 — ⏭️ 已三角(归运营者,核心不实现)
- **现状**:`feishu.ts:479-481` 解析文本但**无 help 关键词检测**;能力说明完全靠 agent prompt(`examples/lab-frontdesk/CLAUDE.local.md`)。这是**有意的业务无关设计**,但从终端用户看是真实摩擦。
- **业务影响**:高(价值标高)。新员工无可发现的方式了解 bot 能做什么,首次使用门槛高,增支持负担。
- **建议**:这**恰当地属运营者/网关责任**——运营者定义能力注册表,在网关层拦截 `/help`/'help'/'你能做什么' 返结构化卡。**平台核心不阻止此模式,纯运营者侧实现**。
- **三角结论**:确认**不在平台核心实现**。在核心 feishu.ts 里硬编码 help 关键词检测会把业务行为烤进平台,违反 CLAUDE.md "Business-specific … live in `examples/` or an operator's own deployment — not hardcoded into the core"。平台已不阻止此模式;运营者实现路径有二:(a) agent prompt 里写能力清单(已是现状,见 `examples/`),(b) 网关加 `help`/`capabilities` 操作或在网关/agent 层拦截 `/help` 返结构化卡。价值虽高但归属正确——保持核心通用。
- **工作量 M · 价值 高(归运营者)**

### 6.4 交互卡渲染失败无降级 fallback ⭐
> ✅ **已实现**(渠道体验 batch):ask_question 卡发送(`feishu.ts`)包了 try-catch,失败时降级到 `buildAskQuestionFallbackText`(primitives.ts 纯函数:问题文本 + 编号选项 + 「Reply with the option number or its text」)并以纯文本发出,同时 `log.warn` 记失败原因。pure helper 加了单测(feishu.test.ts);deliver() 路径本身无 fetch-mock 测试床,故只测可测的纯逻辑。
- **现状**:ask_question 卡(`feishu.ts:918-934`)直接传 `createMessage`(L934),若 Feishu API 拒绝(schema/尺寸/废弃字段),`createMessage`(L305)抛错,消息进重试 → 永久失败。**无降级为纯文本列选项的 fallback**。用户既没拿到卡也没文本替代,挂着无法回应。
- **业务影响**:中等。Feishu API 版本偏移或卡 schema 回归时审批工作流静默失败,瞬时失败尤其糟。
- **建议**:卡投递(L934)包 try-catch,失败 fallback 到 `buildMarkdownCard` 含显式选项("请回复:Approve | Reject"),编号列出所有选项 + 原问题文本;记卡失败原因供运营者排查。渠道适配器责任,不需容器改动。
- **工作量 S · 价值 中**

### 6.5 系统消息/卡片无多语言支持
- **现状**:`feishu.ts:919`("Question" 标题)、`progress-status/index.ts:19`、`primitives.ts:440-469`、错误消息(`feishu.ts:341,352,369`)**全硬编码英文**。无 locale 检测、无 i18n。
- **业务影响**:中等。Feishu 主市场是中文组织,用户收到英文系统提示("Question"/"Invalid signature"),agent 回复可中文——割裂的混语言体验。
- **建议**:抽 i18n(`i18n/feishu.json` en/zh);从 Feishu 事件检测 `user.locale` 或 `FEISHU_SYSTEM_LOCALE`;卡构建器接 locale 参数本地化按钮("Approve"→"确认")。host 侧责任。
- **工作量 M · 价值 中**

### 6.6 无显式取消/撤回待处理请求
- **现状**:ask_question 选项 schema(`channels/ask-question.ts`、`primitives.ts:397-413`)只有 label/value/selectedLabel,**无 cancel 语义**。agent **可**在 options 里塞 Cancel 按钮,但无渠道级取消、无文档化模式、无带外取消命令。
- **业务影响**:中等。误发请求(错单号/错收件人)无法即时止住,得等 agent 完成再请求回滚,审批工作流尤其糟。
- **建议**:(1) 文档化 agent 可在 payload 塞 Cancel 选项(已支持);(2) 可选扩 schema 加 `role:'cancel'` 标记(渲染红按钮);(3) 实现会话级取消命令('cancel'/'/cancel'/'取消')标记 pending_question 为 cancelled(需 host 小支持)。
- **工作量 S · 价值 中**

### 6.7 长任务无中间进度反馈
- **现状**:progress-status(`progress-status/index.ts`)只有 reaction emoji(入站加、首次投递/失败移除)。长任务(30s+)**无中间状态更新 API**。但 agent **已可**发多条普通消息当进度("1/3...2/3...")。
- **业务影响**:中等。长操作中用户全程只见 emoji,90s 后静默失败则无指示卡在哪,易焦虑/重复点击/放弃。
- **建议**:(1) 文档化 agent 可发中间状态消息(今天就支持);(2) 可选进度 API 发非终态更新而不刷屏;(3) PATCH 消息内联进度(需 Feishu 支持,超核心范围)。当前多消息 fallback 多数场景够用。
- **工作量 S · 价值 中**

### 6.8 审批拒绝无内联原因/补救建议 — ✅ 已落地(0470cee)
- **现状**:选项 schema 只有 label/value,用户选 Reject 回 `{selectedOption:'reject'}` **无结构化原因**,agent 得追问。但 agent **可**在问题文本里引导,或设计多步卡序列。缺的是 schema 对结构化拒绝原因的支持和文档化模式。
- **业务影响**:中等。审批工作流要 2-3 轮往返,增延迟。
- **建议**:(1) agent/网关责任,问题文本引导;(2) 可选扩 schema 支持 `{requiresReason:true, suggestedReasons:[...]}`;(3) 或两阶段审批卡。多消息架构已支持。
- **关键发现**:能力其实**已经存在**——核查 `src/channels/feishu/primitives.ts:497` 与 `src/modules/interactive/index.ts:43,51`,选项的 `value`(而非 `label`)就是回写给 agent 的 `selectedOption`。所以 agent 今天就能用不同的 `value` 一次往返拿到结构化拒绝原因(如 `{label:"Reject — amount wrong", value:"reject:amount"}`),根本不需要扩 schema。真正缺的只是**引导与文档**,正对应建议(1)。
- **已实现**(选最保守、零风险路径,**不**改 schema/不动渲染器/不碰审批生命周期):
  - 充实 `ask_user_question` 工具描述(`interactive.ts`):明确"选项 `value` 即工具返回值,用不同 value 一次拿到结构化答案,别 approve/reject 后再追问原因",给出审批的具体写法范例,补救建议放 question 文本,仅在原因真开放时才退回自由文本。
  - `docs/agent-runner-details.md` 的 MCP Tools 段补"Capturing a structured rejection reason (approval pattern)"小节 + 代码范例,点明这是 agent 侧 prompt/设计模式,平台只提供 `value` 回传、不强制问题形状。
  - 新增 `src/channels/ask-question.test.ts`(5 cases)锚定该机制:`normalizeOption` 保留与 `label` 不同的 `value` —— 回归会静默破坏整个模式。
  - 顺带修了 `interactive.ts` 一处日志 cosmetic bug(options 现为对象,`join` 原会打印 `[object Object]`,改为 `.map(o=>o.value)`)。
- **工作量 S · 价值 中**

### 6.9 回复无 citation / "我执行了 X" 信任信号 — ✅ 已落地(d01746a)
- **现状**:`delivery.ts:458-550` 原样投递内容,无内置 attestation/执行轨迹包装,无时间戳页脚。但 agent **可**在内容里塞 executionTrace,渠道**可**渲染。缺的是平台提供的 attestation 机制和文档化模式。
- **业务影响**:中等。用户无法验证 agent 真执行了还是只声称成功,受监管环境(金融/医疗)需用户可见审计轨迹,有合规风险。
- **建议**:(1) 文档化 agent 在出站内容含 executionTrace(动作/时间戳/HTTP 状态);(2) 渠道渲染为可折叠 "Details" 区;(3) 可选系统消息加 ISO 时间戳页脚。agent 层 opt-in,平台不阻止。
- **关键发现**:平台**已有现成的可验证锚点**——`gateway_execute` 响应携带 `auditId`,宿主在中央 `gateway_audit` 表写一行对应记录(load-bearing)。核查 `gateway.ts` 的 execute 返回 `ok(result.text)`(原始 JSON,含 `auditId`),所以 agent 现在就读得到。比起让 agent 自造 executionTrace,直接引用这个 auditId 是**更强的信任信号**(用户/审计员能拿 auditId 去 `gateway_audit` 核对)。
- **已实现**(沿用 6.8 的保守路线:**不**碰 `delivery.ts`/只读投递路径,纯 agent 侧 opt-in 模式 + 文档):
  - `gateway.instructions.md` 加 "Attest state-changing actions" 实践:改状态的动作要在回复里引用 操作名 + `auditId` + 结果(范例 "Created order ORD-5512 ✓ (operation `demo.order.create`, audit `a1b2c3…`)");明确区分真实 result 与 dryRun preview,绝不为只预览/失败的动作谎报 auditId。
  - `docs/enterprise-erp-gateway.md` 的 gateway_audit 段补 "Execution attestation (user-visible trust signal)" 小节:讲清这是 agent 侧 opt-in、平台 verbatim 透传不阻止、渠道可渲染为可折叠 Details、合规场景价值。
- **有意未做**:建议(3)"平台在系统消息加 ISO 时间戳页脚"会碰投递/渲染路径,与"observability/delivery 只读、不改写消息流"取向相悖且价值边际;auditId 引用已给出可验证锚点,故不做。
- **工作量 S · 价值 中**

### 6.10 Roster DM 配额耗尽对用户无反馈
- **现状**:roster-DM 配额超限时 host 记日志(`delivery.ts:1003-1011` rollback + `rosterDmRejectedTotal` metric),但**不发消息解释为何 DM 没到**。`docs/feishu-channel.md:212-230` 的配额说明只在运营者文档。
- **业务影响**:低。经理发每日广播撞日上限却无反馈,重发再撞,以为系统坏了,降信任增工单。
- **建议**:配额拒绝时发系统消息回 agent group 解释限额 + 重置时间 + 补救("明天再发或找管理员加配额");可选 `gateway_get_quota` 让 agent 发前查配额。
- **工作量 M · 价值 低**

### 6.11 Roster DM 同意卡无 onboarding/自助说明
- **现状**:同意卡(ADR-0023,`roster-consent.ts`)的 scopeId 对用户不透明,卡**无订阅内容/频率/发送方描述**。`parseRosterOptIn`(L56-70)无 description/rationale 字段。但卡 payload **可**含丰富描述。
- **业务影响**:中等。员工不懂在订阅什么就点同意(后抱怨 DM 太多)或谨慎拒绝(限制 agent 触达),两边都降采纳率。
- **建议**:文档化 opt-in 卡 payload 含 `{description, rationale}`;卡体在按钮前渲染描述;按钮文案具体化("订阅每日产品更新"非泛泛"允许");可选加 Learn more / Opt-out 链接。主要是运营者/网关责任,平台补文档支持。
- **工作量 S · 价值 中**

---

## 主题七:多租户/配额/成本(架构上正确地留给网关)

> 这一整块按 `SPEC.md` L20/L34 的设计意图,**绝大多数属运营者网关责任,核心不该做**。只有一项(失控成本检测)值得在核心补 hook。

### 7.1 失控 session 检测无 token/成本维度 ⭐(唯一核心该补的)
> ✅ **已实现**(成本 batch):`host-sweep.ts` 的 `enforceRunningContainerSla` 新增成本闸——`recentTokenUsage(outDb, 300s)` 汇总 outbound.db `llm-usage` 行的 `totalTokens`(host 只读容器写的 outbound.db,三库不变量保持),超过 `AGENTDESK_SESSION_TOKEN_BUDGET_PER_MIN`(默认 0=关)折算的窗口上限就 `killContainer(…, 'cost-ceiling')` + reset + emit `runaway_session_stops_total{agent_group}`。在心跳/claim 检查**之前**跑(循环 agent 心跳是新鲜的,只有 token 暴露它)。host-sweep.test.ts 测了 `recentTokenUsage`(窗口内求和/窗外排除/非 usage 行忽略/坏 JSON 容错)。.env.example 文档化。**可选follow-up**:加 Prometheus 告警规则 + RUNBOOK 处置(metric 已具备)。
- **现状**:容器存活检测正确(`host-sweep.ts:106-142` 的 `decideStuckAction` 按心跳/claim 超时杀容器),但**无失控成本检测**。session 进死循环 5 分钟调 LLM 1000 次会全部成功(并烧钱)才被发现"卡住"——而活跃运行时根本不会触发心跳超时。无 per-session token 预算或成本速率异常检测。
- **业务影响**:**高**。被 prompt 注入或有 bug 的 agent 可在被停前狂烧 token,成本失控。
- **建议**:(1) SessionConfig 加可选 `maxTokensPerMin`/`costBudgetUsd`(或读自网关 /authorize);(2) host poll loop 周期采样 session outbound.db 的 llm-usage 行,5 分钟窗口超阈值则杀;(3) 或在网关 /authorize 累计 token 花费、超预算拒新请求(更干净)。token 数据已在 outbound.db(`claude-usage.ts`)。
- **工作量 M · 价值 高**

### 7.2 Prompt 缓存仅 Claude、未系统级集成
- **现状**:Claude prompt cache 由 SDK 支持、token 已计(`claude-usage.ts:54-57` 含 cache_read/creation tokens),但 `container.json` **无 `cache` 配置项**,运营者无法启停/调优,无 hit/miss metric。
- **业务影响**:低(价值标中)。缓存生效但运营者无可见/可控,成本优化潜力未充分利用。
- **建议**:ContainerConfig 加可选 `cache?:{enabled?, ttlMs?}`;容器侧 Claude provider 读取应用;OTEL span 暴露 hit/miss。
- **工作量 S · 价值 中**

### 7.3 全局容器并发上限,无 per-tenant 配额(留给网关)
- **现状**:`MAX_CONCURRENT_CONTAINERS=10`(`config.ts:52`)由 `shouldAdmitWake()`(`container-runner.ts:210-225`)强制——这是**host 级安全机制**(防 fork 炸弹),正确。但**无租户级配额**,一个故障用户可饿死所有人。
- **业务影响**:host 级保护到位,但运营者无法做公平的 per-tenant 资源分配或 SLA 分层。
- **建议**:**按 SPEC.md L20 超出核心范围**。运营者应在网关 /authorize 实现 per-tenant 并发限制(租户已有 N 个活跃 session 则拒)或在平台前加速率限制器。**留给运营者**。
- **工作量 L · 价值 中(归运营者)**

### 7.4 无 per-tenant 计费模型(留给网关)
- **现状**:session 带 origin_user_id、有 agent_groups,但**无 tenant 抽象、无 tenant_config 表**,无法 per-tenant 设 LLM provider 或成本预算。这**有意为之**(SPEC.md L20 业务无关)。
- **业务影响**:单一业务模型部署正常;多业务单元需在网关做租户路由。
- **建议**:**按设计意图超出核心范围**。运营者在网关做 tenant/部门映射、按租户返不同 provider hint,或用 per-group `agent_provider`(推荐拓扑)。**留给运营者**。
- **工作量 L · 价值 低(归运营者)**

### 7.5 无动态 per-query 模型选路(留给 agent/网关)
- **现状**:provider 解析已实现(`container-runner.ts:410-416` 三级 fallback:session→group→container.json→claude),Claude/OpenAI 可 per-group 选。但**无 per-query 成本选路**("简单查询用便宜模型")。session 选定后锁定。
- **业务影响**:多 provider 支持已有;动态选路**正确地**属应用逻辑。
- **建议**:**核心无需改**。运营者用 a2a 委派建不同成本层 worker(fast-worker 便宜模型 / quality-worker 高级模型),frontdesk 按复杂度委派;或建网关端点返模型推荐。三级 provider 优先级已足够。**留给运营者**。
- **工作量 S · 价值 低(归运营者)**

---

## 优先级建议

### 快赢(高价值 + S/M,先做这批)
这些是平台核心该补、投入产出比最高的:

| 项 | 工作量 | 主题 |
|---|---|---|
| 🟡 **5.1 角色授予/撤销审计**(部分,见正文) | S | 治理(合规快赢之王) |
| ✅ **5.5 a2a 委派审计面包屑** | S | 治理 |
| ✅ **5.2 审批决策审计**(emit+metric;瞬态列有意不加) | S | 治理 |
| ✅ **4.2 知识新鲜度指引** | S | 记忆(文档为主) |
| ✅ **4.3 namespace 可发现性** | S | 记忆(小 schema) |
| ✅ **6.4 交互卡失败 fallback** | S | 渠道体验 |
| ✅ **1.1 quickstart.sh** | S | 上手速度 |
| ✅ **6.1 投递失败用户反馈** | M | 渠道体验 |
| 🟡 **6.2 审批卡过期通知**(核心已做;过期窗口可配/倒计时未做) | M | 渠道体验 |
| **2.1 误路由反馈机制** | M | 对话质量 |
| **2.2 conversation_thread_id** | M | 对话质量(追踪基石) |
| **2.3 escalation 显式模式 + hook** | M | 对话质量 |
| **4.1 conversation.summary 落库** | M | 记忆(ADR-0033 欠账) |
| 🟡 **5.4 合规审计导出**(✅)+ 保留(✅);防篡改约束未做 | M | 治理 |
| 🟡 **5.3 审批过期 sweep**(✅)** + 多审批人**(未做) | M | 治理 |
| ✅ **7.1 失控成本检测** | M | 成本(唯一核心该补的) |
| 🟡 **4.4 记忆冲突检测**(契约+指引已做;后端示例留运营者) | M | 记忆 |
| **3.1 bulk 操作契约** | M | 网关契约 |
| ✅ **3.3 /describe schema 发现** | M | 网关契约 |
| **1.4 网关生产模板 + kickstart** | M | 上手速度 |
| 🟡 **1.6 配置参考**(✅)+ prompt 模板库(未做) | M | 业务定制 |

**建议第一冲刺**聚焦三条线:**治理审计补洞**(5.1/5.5/5.2/5.4/5.3,大多 S,合规价值立竿见影)+ **对话可追踪**(2.2 thread_id 是 2.1/2.3 的地基,优先)+ **渠道失败可见**(6.1/6.2/6.4,直接降支持工单)。`4.1` 是 ADR-0033 明确记录的欠账,顺手还清。

### 战略级(高价值 + L,单独立项)
- **3.2 异步/长任务网关模式**(工作量 L,价值高):涉及新端点 + agent 轮询/webhook 逻辑 + 文档,但解锁真实 ERP 长操作。建议写 ADR 后单独迭代,保持 opt-in 向后兼容。
- **业务定制扩展系统**(综合):per-agent-group MCP 工具注册(原 "Skills & MCP" L 项)是 fork-free 扩展的最后一块拼图,但需设计 manifest + loader,L 工作量,建议作为独立架构项。

### 可不做 / 留给运营者(明确不要当核心缺陷返工)
这些按 `SPEC.md` 设计意图属运营者网关/examples 责任,**核心补文档/hook 即可,不要写业务逻辑进核心**:

- **7.3 per-tenant 并发配额**、**7.4 per-tenant 计费**、**7.5 动态模型选路** → 全部留给网关。SPEC.md L20/L34 已明确。
- **3.6 分页**、**3.7 多步工作流** → 后端应用关注点,只补建议性文档。
- **4.5 知识范围词汇**、**4.6 知识反馈闭环** → 4.5 补文档即可;4.6 是 future ADR,当前版本可暂缓(L 工作量价值中)。
- **2.7 多意图分解** → 先做 prompt 工程,验证确需平台改动再动核心。
- **5.11 实时权限重评估** → 架构上正确委托给网关,只需在 RBAC.md 文档化,除非客户明确需要才加 opt-in 开关。
- **6.3 能力发现 help** → 运营者/网关层实现,核心不阻止。
- **5.10 审批 handler 注册审计**、**5.8 fail-closed metric**、**1.2 镜像 fail-fast**、**6.10 配额反馈** → 低价值收尾项,有余力再做。

---

**一句话总结**:把第一冲刺押在**治理审计补洞**(都是 S、合规刚需)、**对话链路可追踪**(thread_id 是地基)、**终端用户失败可见**(直接降工单)这三条线上;`3.2 异步契约`作为唯一的战略级 L 项单独立项;成本/配额/选路这类**明确留给运营者网关**,只补文档和 hook,别在业务无关的核心里写业务逻辑。
