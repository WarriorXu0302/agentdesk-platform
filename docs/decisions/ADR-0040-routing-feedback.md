# ADR-0040: Worker 路由反馈(误路由 + nack)—— recording-only，驳回 active-reroute

- **Status**: Accepted
- **Date**: 2026-06-14
- **Decider(s)**: 用户（平台 owner，提案 + 验收）；coding agent（设计 + 执行）
- **Tags**: `a2a`, `routing`, `audit`, `observability`, `identity-trust-chain`, `three-db-single-writer`, `backward-compat`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

业务侧 review（`docs/business-optimization-roadmap.md`）确认两条相关缺口：

- **2.1 误路由后几乎没有反馈与学习机制**（价值 高）：frontdesk 误路由后运营者无信号，
  classification_log 没有"我们路到了 X 但其实该路到 Y"这条业务信号，无混淆矩阵、无学习语料。
- **2.5 "我改主意了" / 返工(nack)流程无正式支持**（价值 中）：worker 收到越界/误投的请求
  只能手工回复，没有结构化的"退回 + 建议重路由"通道。

两者本质是**同一个面**：让 worker 把"这条不该到我"这个判断回传给 host。2.1 的建议(2)"容器内加
工具让 worker 标记误路由 + 建议目标"几乎就是 2.5 的 nack。所以合并设计。

决策时的已知约束（load-bearing 不变量，CLAUDE.md）：

- **身份信任链**：actor 永远取 host 建立的 `session.owner_user_id`，不信 agent payload 里的
  字段；跨会话 a2a 跳要过 `collectLegitimateOrigins` 交叉校验（ADR-0017）。
- **三库单写**：central DB / 每会话 inbound.db 由 host 写，outbound.db 由 container 写；
  open-write-close 跨挂载可靠性模式不能破。
- **后端网关是 authz/业务记忆的唯一路径**，不引平行授权路。
- **可观测性只读**：classification_log / enterprise_audit / Prometheus 是记录汇,绝不回灌进
  路由/身份决策。
- 刚落地的 `escalate`（ADR-0038）已确立"正交 system action + 不可信字段只记录不决策"的范式,
  本 ADR 必须沿用,不另起炉灶。

本 ADR 的设计经一轮 **design + 对抗评审 workflow**（2 张只读 map → recording-only vs
active-reroute 两个设计 → 安全评审合成）核实。

## Options Considered

- **Option A — recording-only**：worker 经新 MCP 工具 `report_routing_feedback` 发**正交**
  `routing_feedback` system action（`kind: misroute|nack` + 可选 reason + 可选 suggestedTarget）。
  host **只记录**：classification_log 一行（action='routing_feedback'）+ enterprise_audit 面包屑
  + 一个有界标签的混淆矩阵指标。suggestedTarget 原样存进 `recommended_worker` 列作运营者看板提示,
  **绝不解析成 session、绝不 ACL 校验、绝不路由**。优点：与 escalate 同构、零新授权决策、结构上
  无 send 路径 → 不变量全保。缺点：worker 仍需自己正常回复(不自动重投)。
- **Option B — active-reroute（flag 默认关 + 本 ADR）**：在 A 之上,nack 时 host 重读原始
  host-written inbound 行、重校验身份、对**原始委派组**重 ACL、经 `routeAgentMessage` 把**原始内容**
  重投到 host 解析的目标。优点：真正"止血"。缺点：见下方驳回理由。
- **Option C — 自动重投（无 flag、无 ADR）**：worker 说重投就重投。**直接违反不变量,不予考虑。**

## Decision

> **拍板**：选 Option A（recording-only）。**驳回 Option B(active-reroute),不是"暂缓"而是"否决"。**

### 为什么 recording-only 安全且足够

- actor = `session.owner_user_id`(host 建立),`kind` coerce 到闭合枚举,reason/suggestedTarget
  是不可信元数据**只记录**。handler **没有任何 send/inbound 写路径** → 三库单写、身份链、平行授权
  路三条不变量结构上不可能被触碰(没有第二个写目标)。
- 满足 2.1：classification_log 多了 action='routing_feedback' 行,带 `classification_id`(回指
  frontdesk 原始 classify 行)+ `recommended_worker`(worker 认为该去的组)→ 运营者可 SQL join 出
  "误投 X / 应为 Y"的混淆矩阵 + 学习语料。满足 2.5 的**结构化信号**诉求(退回 + 建议)。

### 为什么 active-reroute 被否决(对抗评审找到两条结构性不变量违规,flag 修不了)

1. **agent-shared inbound.db 身份污染 → 跨用户重定向**。共享 worker 模式下,一个 worker 的
   inbound.db 累积了**所有**曾委派给它的用户的 origin_user_id。被提示注入的 worker 发一个
   suggestedTarget 指向特权 agent 的 nack,host 在共享 inbound.db 上跑 `collectLegitimateOrigins`
   会发现**另一个用户**的 origin 在合法集里(那是之前合法跳写进去的),校验通过,于是用那个用户的身份
   把消息路由到特权 agent —— 跨用户消息重定向。这是身份信任链的结构性违规,无非侵入式缓解。
2. **双 return-path 链冲突**。重投是 source_session_id = worker 会话的**新前向跳**,而原始
   frontdesk→worker 跳的 return-path(in_reply_to)仍指向 worker 会话。于是同时存在两条
   source_session_id 冲突的回复链(MAP B 的"reply routing loop"风险),"只加不改"并不能化解。

这两条是不变量违规、不是风险容忍度,**default-OFF flag 只是把违规推迟到一次 flag flip**,不能算
缓解。队列优先级/路由到人/真正的重投仍归运营者后端网关——它有完整的每租户身份与授权上下文,平台核心
没有。

## Consequences

- **Positive**：
  - 2.1 误路由有了 host-single-writer 的学习语料 + 混淆矩阵(SQL 自 classification_log)+ 告警面。
  - 2.5 nack 有了结构化信号(worker 退回 + 建议目标,运营者可见)。
  - 与 escalate 完全同构,零新授权决策,所有 load-bearing 不变量保持。
  - 完全向后兼容:additive nullable 列 + 无 CHECK 的 action 列加值;旧后端/旧行不受影响。
- **Negative**：
  - worker 不能让平台自动重投——它必须仍正常回复用户/frontdesk(工具返回串明确告知)。真正的
    重投要运营者在网关侧基于这些审计行实现。
  - `recommended_worker` 列双语义(classify 行=已校验 worker 名;routing_feedback 行=未校验提示),
    下游分析**必须**按 `action` 过滤。已在列注释 + 本 ADR 注明。
- **Neutral / Trade-offs**：
  - 混淆矩阵的"误投到 X"轴依赖 worker 回传当前 `classificationId`(host runtime 在 a2a 跳已传播);
    直投 worker(非 a2a)的反馈行 classification_id 为 NULL,看板单独分桶。
  - **未做的 per-session 限流**:被注入的 worker 可刷 routing_feedback 噪声行 + 抬高指标。当前与
    escalate 同样靠 `routing_feedback_total{kind=nack}` 的速率告警暴露异常,不在 handler 里加状态化
    限流。若运营者实测有滥用,再在本 ADR 下追加 per-session 上限(open question)。

## Implementation Notes

- 落地文件：
  - `src/db/migrations/033-routing-feedback-fields.ts` —— `classification_log` 加 nullable
    `feedback_kind TEXT`(PRAGMA guard + 无 backfill + 无 CHECK,镜像 030);`src/db/migrations/index.ts`
    注册 migration033。
  - `src/db/classification-log.ts` —— `ClassificationLogEntry.action` 加 `'routing_feedback'`;
    加 `feedbackKind?: string|null`;`recordClassification` INSERT 加列;`recommended_worker` 列注释
    标注双语义。
  - `src/modules/classification-log/index.ts` —— `coerceFeedbackKind` + `handleRoutingFeedback`
    (镜像 handleEscalate:信 session owner、coerce kind、recordClassification + enterprise_audit
    `agent_routing_feedback` + `routingFeedbackTotal`,best-effort,无 send 路径);
    `registerDeliveryAction('routing_feedback', ...)`。
  - `src/metrics.ts` —— `routingFeedbackTotal{kind, reported_by}`(两个标签都有界:kind 闭合枚举、
    reported_by = 配置的 agent_group 集)。**有意不加 `suggested` 标签**(即使 bucket 也有 cardinality
    风险,且其值由 classification_log.recommended_worker 的 SQL 覆盖)。
  - `container/agent-runner/src/mcp-tools/classify-intent.ts` —— `reportRoutingFeedback` 工具(取
    `getCurrentClassificationId()` 作 misroute 关联 + `getRequestIdentity()` 作上下文,发
    `routing_feedback` system 行,返回"只记录、不重投、请仍正常回复");`registerTools`。
  - `infra/observability/prometheus/alerts.yml` + RUNBOOK —— 持续 nack 速率告警(配线坏/注入探测信号)。
  - `docs/enterprise-multi-user.md` —— "Routing feedback (misroute / nack)" 段(记录什么、重投归网关、
    suggestedTarget 不可信、查询示例)。
- 依赖的上游 ADR：ADR-0038(escalation hook,同构范式)、ADR-0017(origin 交叉校验,active-reroute
  否决理由的依据)、ADR-0039(conversation_thread_id,纯关联复用)。
- 后续验收点：host `pnpm typecheck` + 全套 vitest 绿(含 handleRoutingFeedback + 迁移 033);container
  tsc + tool 测试绿;`routing_feedback_total` 入 alerts 后 metrics-alerts-consistency 测试仍绿。

## References

- 关联审计：`docs/business-optimization-roadmap.md` 2.1 / 2.5
- 设计 + 对抗评审 workflow：design-routing-feedback(2 map → 2 设计 → 安全合成,合成驳回 active-reroute)
- 上游 ADR：`ADR-0038-escalation-hook.md`、`ADR-0017-identity-origin-crossvalidation.md`、
  `ADR-0039-conversation-thread-id.md`
- load-bearing 不变量：`CLAUDE.md`
