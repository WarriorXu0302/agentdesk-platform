# ADR-0046: 记录型面的 actor 身份交叉校验（ADR-0017 一致性扩展）

- **Status**: Accepted
- **Date**: 2026-06-15
- **Decider(s)**: 用户（platform owner）；coding agent（提案/执行/审计）
- **Tags**: `identity-trust-chain`, `audit`, `a2a`, `classification`, `fail-closed`
- **Supersedes**: 无（扩展 ADR-0017 到 ADR-0038/0040 的记录型面）

---

## Context

对 cancel-pending 跨用户隔离 + a2a「recording-only / never authz」面跑 as-merged 红队(每条 3 怀疑者复核、≥2/3)。cancel-pending 隔离判为**稳健**(findClassifiableForOwner 严格按调用者 owner_user_id JOIN,shared/agent-shared owner=NULL → 零命中 no-op,无跨用户取消)。确认 **1 条 low** 审计归因缺陷:

三个记录型 handler(`handleClassifyIntent`/`handleEscalate`/`handleRoutingFeedback`,`src/modules/classification-log/index.ts`)算 actor 用 `session.owner_user_id ?? claimedUserId ?? null`,其中 `claimedUserId` 直接取自容器写的 payload。owner_user_id 仅在 root-pinned / per-user(-per-thread)模式非空;**最常见的群聊 frontdesk 拓扑(shared / per-thread / agent-shared)owner=NULL**,于是表达式落到容器自报 id,**零校验、零告警**。被注入的 frontdesk/worker 容器可把任意 victim id 盖进 `classification_log.user_id` 与 `enterprise_audit` 的 `agent_escalation`/`agent_routing_feedback` actor。

**严重度 low**(3/3 一致):invariant 3 成立——三个 handler 是纯记录,无 send/route/authz 路径(已结构性核实,且有 ADR-0040 的「provably recording-only」守卫测试)。被盖的 id **从不**流入授权/路由/优先级:`classification_log` 仅被 reconcileClassification 按 session_id+action 读回(从不读 user_id),`enterprise_audit` 只写/导出从不读入决策。所以仅污染审计 ground truth(归因伪造/抵赖),不导致越权或误投。但它违背 invariant 4(归因要用 host 校验身份)的精神,而这些表的注释自称「audit-level ground truth」。

**不对称点**:同样的容器自报身份,a2a hop(`agent-route.ts`)早已用 `collectLegitimateOrigins(host 写的 inbound.db)` 交叉校验并 reject+计数+告警;这三个 handler 拿到同一个 inDb(经 DeliveryActionHandler 签名传入)却忽略它。

## Options Considered

- **Option A(选中):owner=NULL 时交叉校验**。复用 a2a 的 `collectLegitimateOrigins(inDb)`:claimedUserId 仅当**确实在本会话出现过**(host 写的 inbound.db 里有该 origin)才采信,否则置 null + 计数 + 告警。owner 非空时维持原行为(owner 权威,claimed 不符则忽略+告警)。优点:**保住合法多用户群会话的正确归因**(群里真实参与者触发的 escalation 仍正确记名),只挡伪造;与 ADR-0017 既有模式一致。缺点:多一次 inbound.db 读(已在手,廉价)。
- **Option B:owner=NULL 时一律置 null**(丢弃所有 claimed)。最小改动、最保守。缺点:在最需要归因的群拓扑里**丢失合法归因**(无法记录是群里哪个真实用户触发的)。
- 两者都修了漏洞;A 在不牺牲合法归因的前提下挡伪造,信息量更高,且与 a2a 路径对称。

## Decision

> **拍板**:选 Option A。owner 非空 → 用 owner(原行为);owner=NULL → 交叉校验 claimedUserId ∈ `collectLegitimateOrigins(inDb)`,否则 null + `classificationActorRejectedTotal{action}` + 告警。

三个 handler 抽共享 `resolveTrustedActor(action, session, claimedUserId, inDb)`。`collectLegitimateOrigins` 来自 `agent-to-agent/origin-user.ts`——经核实是**纯叶子**(仅 type-only `better-sqlite3` 依赖、零副作用),静态 import 不激活可选 a2a 模块,且复用它保证命名空间化(`<channel>:<id>`)与 a2a 校验**逐字一致**(否则 `.has()` 比较会错)。

## Consequences

- **正向**:记录型面的 actor 归因现在 host-anchored;伪造的 victim id 在 owner-less 会话被置 null 并计数,合法参与者归因不受损。补齐了 ADR-0017 身份链在 ADR-0038/0040 面上的一致性。R1-R5 + recording-only(invariant 3)不变,纯 fail-closed 加固。
- **可观测**:新增 `*_classification_actor_rejected_total{action}`(镜像 `a2a_origin_rejected_total`),非零=有人试图伪造审计归因,值得排查。
- **行为**:owner 非空的会话(per-user 等)行为完全不变。owner=NULL 且 claimed 不在身份集 → 该行 user_id/actor 记 null(而非伪造值)。回归测试覆盖伪造丢弃(+计数)、合法保留、owner 优先三种路径,且**已实测在修复前为红**。
- 纯 host 改动(`classification-log/index.ts`、`metrics.ts`),无 schema/契约变更,无容器改动。inbound.db 读失败兜底置 null(不抛、不阻断记录流)。
