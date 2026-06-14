# ADR-0039: Host-owned `conversation_thread_id` correlation id

- **Status**: Accepted
- **Date**: 2026-06-14
- **Decider(s)**: 平台 owner（拍板）；coding agent（提案 + 执行）；设计经一次 design+对抗评审 workflow（5 agents）核实并纠偏
- **Tags**: `a2a`, `observability`, `identity-trust-chain`, `migration`, `three-db-single-writer`, `backward-compat`
- **Supersedes**: —

---

## Context

业务侧优化 backlog 2.2（价值 高,标注为 load-bearing、需 ADR + 多 commit):没有贯穿
frontdesk classify → worker A → worker B → 回复的**顶层会话线程 id**。classification_log
记单次事件,messages_in/out 按 session 记,a2a 用 `source_session_id` + `in_reply_to`。
三张表都没有 conversation 级标识 → 追一个请求的完整多跳链路要多表 join + 时序重建,
运营者无法快速回答"请求 X 现在在哪""这次多跳花了多久"。

**`root_session_id` 不能替代**(对抗评审核实 `agent-route.ts:200/212`):它只在
`a2aSessionMode='root-session'` 时跨 hop;默认 `agent-shared` 路径传 null,**不跨**默认
frontdesk→worker 链。所以缺口真实存在。

已知约束 / load-bearing 不变量(不可削弱):身份信任链(batch 级 RequestIdentity、
`origin_user_id` 跨 a2a 跳 + host 交叉校验 `agent-route.ts:287-310`、HMAC、gateway_audit);
后端网关是唯一 authz 路径;三库单写(central + inbound host 写、outbound container 写;
session-DB schema 变更走 `migrateMessagesInTable` ALTER-on-open 覆盖在飞会话);可观测只读。

本 ADR 经 design+对抗评审 workflow 产出并核实(对照真实代码),评审给出 **SHIP IT** 并
**纠正了 explorer 的共识错误**(见 Decision)。

## Options Considered

- **Option A — host 拥有的纯关联 id(选中)**:在会话起点(channel ingress)由 host mint 一次,
  存 `sessions` 行;跨 a2a 跳由 host 从**源 session**(host 写、可信)读出、在既有 origin 交叉校验**之后**
  经 `writeSessionMessage` 传给目标;记到 `classification_log` + `messages_in`(均 host 写)。
  **绝不进 `messages_out`(container 写)**,**绝不**进任何 authz/路由/优先级判断。
- **Option B — container 供给 thread_id(镜像 origin_user_id 的 emit-time stamp)**:**驳回**(评审纠偏)。
  origin_user_id 需要 emit-time 捕获是因为会话内"负责人"会变;conversation_thread_id 整段会话**稳定**,
  host 本就知道,无需 container 供给。container 供给会(a)制造跨仓合并 blocker,(b)开 **trace-poisoning**
  面(prompt-injected agent 伪造 thread_id 把两段无关会话拼接,污染审计视图)——零收益。
- **Option C — 复用 `root_session_id`**:驳回。默认 `agent-shared` 模式下不跨 hop(已核实),关不上缺口。
- **Option D — 独立 thread 映射表**:驳回。一个 nullable 列 + 既有 ALTER-on-open 迁移模式更简单,
  无需新表/新单写面。

## Decision

> **拍板**:选 Option A —— **host 拥有、纯关联、additive** 的 `conversation_thread_id`。
> container 永不触碰它。

为何安全(纯关联、永不 authz 的保证,可验证):
1. **路由/身份结构性绑定在别的 key 上**:a2a 目标选择用 `platform_id` + `agent_destinations` ACL;
   回程用 `source_session_id` + `in_reply_to`;会话 scope 用 `root_session_id`;身份用 host 交叉校验过的
   `origin_user_id`。conversation_thread_id **碰不到这些**——只被 classification_log/messages_in 的 INSERT
   写、被可观测 SELECT 读。
2. **host 拥有每一份权威副本**:全部由 host 写(router/agent-route → writeSessionMessage → insertMessage;
   recordClassification)。container 不是权威副本的 writer,连供给都不需要(`handleClassifyIntent` 已用
   session-trusted 字段覆盖 agent 自报,thread_id 同此纪律)。
3. **先例**:平台已有两个"纯关联/永不 authz"字段同此纪律——`origin_user_id`(ADR-0017,文档化只读、
   伪造被拒 + 计数)、escalation reason/urgency(ADR-0038)。conversation_thread_id 比 origin_user_id **更弱**
   (无跨会话捕获、host-only 无可伪造 emit 路径),零新增信任面。
   **评审唯一硬性要求**:让它远离 `messages_out`,远离每一个喂决策的 WHERE/JOIN。

### 形状 + 关键守则

- 列:`classification_log.conversation_thread_id`(central v2.db,nullable TEXT)+
  `messages_in.conversation_thread_id`(per-session inbound.db,nullable TEXT,加索引)。**不加 messages_out**。
- mint 点:**唯一一处**——`router.ts` channel ingress,仅在**新建 root session**(`created=true`)时,
  格式 `conv-${Date.now()}-${rand}`,存 `sessions` 行以持久。**不在 resolveSession 无条件 mint**(否则每个
  a2a 子会话重 mint、打碎线程)。
- 传播:`agent-route.ts` 在既有 origin 交叉校验**之后**从源 session 读出、`writeSessionMessage` 转给目标;
  **每跳不重新 mint**。null-safe:源是迁移前/在飞会话无 thread_id 时传 null 并继续路由,**绝不抛**。
- nullable + best-effort 处处:channel-only / 迁移前行保持 NULL;mint/record 失败像 classification_log 一样
  log-and-drop,**绝不阻断投递**(可观测特性绝不能变成消息流的 load-bearing 依赖)。
- **两个 writeSessionMessage 调用点**(router channel ingress + agent-route a2a)**都必须**填该列,否则
  不一致 NULL 会让 `WHERE thread_id=?` trace 静默漏行。
- 不进 gateway 请求契约(host-local 可观测列);加 guard 测试/lint 断言 src/ 无 SELECT 在该列上做
  authz/路由过滤。

## Consequences

**正面**:运营者可端到端追多跳请求 + 测多跳时延(同一 thread_id 贯穿 messages_in + classification_log);
纯 additive、对四条 load-bearing 不变量均安全(评审 SHIP IT);比 origin_user_id 信任面更小。

**负面/代价**:触及 ~10 文件(schema + 迁移 + 两个 writeSessionMessage 签名 + agent-route 传播 +
classification-log 记录),故**分 4 个独立可验证 commit**(下);两处写入点必须同步填列(评审标为最易出的 bug)。

**load-bearing 不变量检查**(评审逐条):身份链——thread_id 在 origin 交叉校验**之后**附加、host-only、
永不入 authz,比 origin_user_id 弱 ✓;网关唯一 authz——不进 gateway payload ✓;三库单写——权威副本全 host 写、
**不碰 container 写的 outbound.db**、session-DB 走 migrateMessagesInTable ALTER-on-open 覆盖在飞会话 ✓;
可观测只读——nullable + best-effort、绝不阻断消息流 ✓。

### 分阶段落地(roadmap "ADR + 多 commit, 不一次赶工")

1. **Commit 1 — schema + 迁移**(无行为变更):INBOUND_SCHEMA 加列 + 迁移 031(central classification_log
   真 ALTER 仿 migration024;session-DB 部分 marker-only 仿 migration020)+ migrateMessagesInTable 加幂等
   ALTER 分支(覆盖在飞 inbound.db)+ messages_in 索引。无 writer,全行 NULL。验:旧库升级干净、列在、测全绿。
2. **Commit 2 — 起点 mint + 记录**:sessions 承载 + resolveSession 分配(仅 created root);router ingress
   mint 并经 writeSessionMessage→insertMessage(加 nullable conversationThreadId 参,镜像 originUserId);
   handleClassifyIntent 从 host session 读 thread_id 记入 classification_log(非 agent payload)。验:channel
   inbound 的 messages_in 行与 classification_log 行共享同一 thread_id。
3. **Commit 3 — 跨 a2a 跳传播**:agent-route 在 origin 校验后从源 session 读 thread_id(null-safe)转给目标;
   **不碰** messages_out / a2a-origin / resolveTargetSession / hasDestination / spawn-depth。验:两跳委派每个目标
   inbound + classification_log 行 thread_id 一致;container 伪造值无法影响(container 根本不供给)。
4. **Commit 4 — 测试 + 守则 + 文档/本 ADR**:全链集成测试(frontdesk→A→B 一致 thread_id + 多跳时延查询)、
   向后兼容(NULL 行优雅)、guard 断言(无 authz SELECT 该列)、更新 isolation-model.md/architecture.md +
   列文档(CLAUDE.md 契约同步)。

**回滚**:列保留无害(nullable);移除 mint + 传播即停。
