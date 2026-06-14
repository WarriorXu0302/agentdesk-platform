# ADR-0038: Explicit escalation hook (orthogonal `escalate` action + audit + metric)

- **Status**: Accepted
- **Date**: 2026-06-14
- **Decider(s)**: 平台 owner（拍板）；coding agent（提案 + 执行）；设计经一次 design+对抗评审 workflow（5 agents）核实
- **Tags**: `a2a`, `escalation`, `audit`, `observability`, `identity-trust-chain`, `backward-compat`
- **Supersedes**: —

---

## Context

业务侧优化 backlog 2.3（价值 高):a2a 路由(`agent-route.ts`)把所有转交一视同仁——
无论 worker→worker 派活还是 AI→人升级。没有 `escalation_reason`/`urgency_level` 概念,
`metrics.ts` 无 `escalation_total`,无升级审计。混合 AI/人部署里,升级被当普通转交,
易违反 SLA,且无升级率/响应可见性。

平台必须保持**业务无关**:队列优先级、SLA 计时、路由到具体人,都是运营者网关的职责
(roadmap 2.3 原文:"队列优先级属业务逻辑(归网关)")。核心只提供**钩子**。

已知约束 / load-bearing 不变量(不可削弱):
- 身份信任链:batch 级 `RequestIdentity`、`origin_user_id` 跨 a2a 跳传播 + host 交叉校验
  (`agent-route.ts:287-310`、`a2a-origin.ts:15-20` 当 source≠'session' 返 null 是 keystone)、
  HMAC 签名、`gateway_audit`。
- 后端网关是业务记忆 + 授权的唯一路径。
- 三库单写(central + inbound host 写,outbound container 写;open-write-close)。
- 可观测只读。

本 ADR 的设计经一次 design+对抗评审 workflow 产出并核实(对照真实代码:
`agent-route.ts:287-310`、`delivery.ts:1179-1194` handleSystemAction、`classification-log.ts:23`
action union 仅 TS 无 DB CHECK、`metrics.ts:247-256` approvalEventsTotal 模板、
`023-classification-log.ts` 加列迁移安全)。

## Options Considered

- **Option A — 正交 system action `escalate`(选中)**:容器发 `kind='system', action='escalate'`
  携带 `escalation_reason`(自由文本)+ `urgency_level`(闭合枚举)在 content JSON;host 经既有
  `registerDeliveryAction('escalate', handler)` 处理——交叉校验 origin、记 `enterprise_audit`
  `agent_escalation`、增 `escalation_total` 指标、(可选)关联 `classification_log`。与
  delegate/clarify **正交**,不进 classify_intent 枚举,不驱动核心路由/优先级。
- **Option B — 把 `escalate` 加进 classify_intent 动作枚举**:驳回。混淆两种关注点
  (classify 是"哪个 worker",escalate 是"无 worker、要人");若任何代码统一处理 classify 动作
  (把 escalate 当 delegate 路由给 worker)会误路由。对抗评审明确否决。
- **Option C — 新建专用 `escalations` 表**:驳回。与 `enterprise_audit` 冗余,多一个 host 单写
  审计面要维护(保留 sweep、索引),无额外收益。
- **Option D — urgency 驱动核心队列优先级**:驳回(**安全**)。`urgency_level` 是容器写(outbound.db,
  按 ADR-0017 不可信);若核心据此抢占人工队列,prompt-injected agent 伪造 `urgency='critical'`
  即可插队 → 绕过网关的**平行授权路径**。优先级必须归网关。

## Decision

> **拍板**:选 Option A —— 正交 `escalate` system action。核心只做四件事,其余归运营者网关。

核心提供且仅提供:
1. **`escalate` system action**(经 `registerDeliveryAction('escalate', handler)`),容器发
   `kind='system', action='escalate'`,content 携带 `escalation_reason` + `urgency_level`
   (闭合枚举 `low|medium|high|critical`)+ 可选 `classificationId`。**不是** classify_intent
   第五个枚举值,**不是** a2a 路由变体。
2. **host handler 复用既有 origin 交叉校验**(`collectLegitimateOrigins` against source session
   inbound.db),**绝不信任容器自报 origin**;`escalation_reason`/`urgency_level` 视为
   **不可信但记录**(只进日志 + 审计 + 指标 label,**绝不**作为任何 authz/权限/优先级决策的输入)。
   `urgency_level` 在 host 边界 coerce 到闭合枚举(未知→`unknown`);`reason` 在成为指标 label 前
   bucket/枚举化以防 Prometheus 基数爆炸。
3. **审计面包屑**:`recordEnterpriseAudit({ eventType:'agent_escalation', agentGroupId,
   actor: 校验后的 originUserId, details:{ reason, urgency, sourceSessionId, originValidated } })`
   ——复用既有 host 单写 `enterprise_audit`(central v2.db),**不建新表**。经新迁移给
   `classification_log` 加两个**可加(nullable)**列 `escalation_reason TEXT` / `urgency_level TEXT`
   关联到触发它的分类(additive ALTER ADD COLUMN 安全:action 是 TEXT NOT NULL 无 CHECK、表 append-only)。
4. **指标** `escalationTotal { name: agentdesk_escalation_total, labelNames:['reason','urgency','outcome'] }`
   仿 `approvalEventsTotal`,host handler 在审计落地时 increment(append-only、只读可观测)。必须在
   `alerts.yml` 引用前先注册,否则 `metrics-alerts-consistency.test.ts` drift guard 失败。

**归运营者网关(核心不做)**:队列优先级 / SLA 分层排序;路由到具体人(谁收、paging、建单);
SLA 计时 / 超时再升级循环;升级准入/接受规则(网关授权,经 gateway_audit);孤儿升级重排
(走既有投递韧性 + host-sweep,不另起路径);reason 词汇表(运营者 prompt/config 约束 agent,
核心只防御性 bucket 未知值)。

## Consequences

**正面**:AI→人升级首次可见可审计(`escalation_total{reason,urgency,outcome}` + `agent_escalation`
审计 + `classification_log` 关联),运营者能追 SLA / 升级率;完全向后兼容(新 action + 加列,既有流程零影响);
与 delegate/clarify 正交,杜绝误路由;核心不碰队列优先级 → 无平行授权路径。

**负面 / 代价**:新增容器侧 escalate 发射点 + host 侧 delivery-action handler + 1 迁移 + 1 指标;
`urgency`/`reason` 的"不可信但记录"语义必须在 host 边界严格执行(coerce + bucket),否则有基数/越权风险——
ADR 已明确,实现需测试覆盖。

**load-bearing 不变量检查**(对抗评审 CONDITIONAL APPROVE,逐条):身份链——复用 origin 交叉校验、
escalate 不建新 RequestIdentity batch、不做 per-action origin override、reason/urgency 永不入 authz ✓;
网关唯一路径——核心只记录 intent,网关读审计行决定路由/优先级 ✓;三库单写——审计进 host 单写
`enterprise_audit` + `classification_log` 加列(host 写),outbound.db 无 schema 变更、不新建表 ✓;
可观测只读——`escalation_total` append-only、不 backfill、不在指标路径触发重排 ✓。

**实现面(后续 commit)**:迁移(classification_log 加 2 列)→ metrics(escalationTotal)→ 容器
escalate 发射 + classify_intent 不变 → host escalate delivery-action handler(校验 + 审计 + 指标 +
log 关联)→ 文档(escalation 模式 + agent 指引)→ 测试(handler 校验/coerce/审计、指标契约、迁移)→
可选 alerts.yml + RUNBOOK。

**回滚**:移除 escalate action + handler + 指标;加的 nullable 列保留无害(不回滚迁移)。
