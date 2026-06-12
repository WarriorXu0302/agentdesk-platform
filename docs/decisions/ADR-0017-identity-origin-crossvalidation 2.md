# ADR-0017: a2a 身份起点交叉校验 — host 侧验证容器自报的 origin_user_id

- **Status**: Accepted
- **Date**: 2026-06-12
- **Decider(s)**: yingqi2（用户，批准）；coding agent（提案 + 执行）
- **Tags**: `identity-trust-chain`, `agent-to-agent`, `security`, `session-db`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

平台的头号卖点是「跨多 agent 跳转仍能把 ERP/网关调用归因到真实员工」的身份信任链。
2026-06 全仓成熟度审计指出该链存在一个可被击穿的缺口（确认漏洞）：

**攻击路径**：容器以 `bypassPermissions` 运行、Bash 可用、`/workspace`（含 `outbound.db`）以
读写挂载。一个被 prompt 注入的 agent 可以绕过 MCP 工具，直接用容器内的 node/bun + sqlite
向 `messages_out` 写入一行伪造记录：`channel_type='agent'`、`platform_id=<目标 agent group>`、
`origin_user_id='feishu:ou_victim'`（任意 victim id）。

host 的 `src/modules/agent-to-agent/agent-route.ts` 在处理这行出站消息时，把
`msg.origin_user_id`（容器自报值）当作**优先级 1 的真值直接转发**写入下一跳的 `inbound.db`。
下一跳 worker 读到该 `origin_user_id` 后，以 `requesterSource='session'`（完全可信来源）调用
后端网关——于是攻击者可以让 worker 冒充任意 victim 执行业务操作。身份链被击穿。

**信任模型（修复依据，load-bearing — 见 CLAUDE.md「三库单写者不变量」）**：

- 每个 session 的 `inbound.db` 由 **host 写**（可信）；`outbound.db` 由**容器写**（不可信）。
- `agent-route.ts` 当前处理的 `msg` 来自**源会话的 outbound.db**——容器写，不可信。
- 源会话的 `inbound.db` 里恰好记录了「真正进入过该会话的身份全集」，且全部 host 写、可信：
  - ① channel-side chat 行的 `content.senderId`（host 投递时写入），归一化为 `<channel>:<id>`；
  - ② 之前 a2a hop 由 host 经 `writeSessionMessage` 写入、且**已经过本 ADR 校验**的
    `origin_user_id` 列（N 深链路逐跳收紧）。

已知约束：

- 不得弱化身份信任链的任何一层（CLAUDE.md load-bearing invariant）。
- 容器自报值在合法场景下**仍有价值**：源会话是多人群聊时，容器能正确归因到「当时正在跑的
  那个用户」，而 host 侧的「最近一条 chat」启发式可能因并发消息而归因到另一个用户。
  所以不能简单地「完全不信容器自报」。
- 三库单写者：只能读源会话已有的两个 DB，open-write-close 模式不变。

## Options Considered

- **Option A：交叉校验**。容器自报的 `origin_user_id` 只有在它 ∈「源会话 inbound.db 的合法身份
  全集」时才采用；否则视为伪造，丢弃并落到既有兜底链（host 侧 `resolveOriginUserId` →
  `session.owner_user_id`），同时计数 + 告警。
  优点：堵死「跨会话冒充任意 victim」；保留多人会话下容器对当前用户的正确归因（该用户确实在
  全集里）；零新依赖；只多一次对已打开 inbound.db 的全表扫描。
  缺点：若攻击者伪造的恰好是一个**确实在本会话出现过**的真实用户 id，仍可冒充该用户（见
  Consequences 的残余风险）。
- **Option B：完全不信容器自报，永远用 host 侧 `resolveOriginUserId`（最近一条 chat）**。
  优点：实现最简单，攻击面最小。
  缺点：破坏合法用例——多人会话里「最近一条 chat 已切换到另一个用户」时会把委派**误归因**给
  错误的用户。这正是当初引入容器自报值要解决的问题，等于回退一个已修的正确性 bug。驳回。
- **Option C：容器对 `origin_user_id` 做 HMAC 签名，host 验签**。
  优点：密码学强度，可校验任意自报值。
  缺点：签名密钥必须放进容器，而容器已被假定可被注入接管——密钥同样会泄露，签名沦为摆设；
  且需要新的密钥分发与轮换机制。投入产出不成立。驳回。

## Decision

> **拍板**：选 Option A（交叉校验）。

1. 在 `src/modules/agent-to-agent/origin-user.ts` 新增 `collectLegitimateOrigins(inboundDb): Set<string>`，
   扫描源会话 inbound.db 中 `kind IN ('chat','chat-sdk')` 的所有行，收集每行归一化后的
   `<channel>:<id>` 身份（复用与 `resolveOriginUserId` 同一套归一化逻辑，抽成共用
   `namespacedOriginOf`）。这是该会话的「合法身份全集」。
2. `agent-route.ts` 的 origin 解析改为：容器自报的 `msg.origin_user_id` 仅当 ∈ 合法全集时采用；
   否则丢弃，落到 `resolveOriginUserId` →（再无则）`session.owner_user_id` 兜底链，并
   `a2aOriginRejectedTotal.inc({source_agent_group})` + `log.warn` 记录被拒的自报值。
3. 校验集与兜底查询读同一个 inbound.db，合并为**一次** open-write-close，避免重复 IO。

核心理由（可验证）：(a) 合法全集只含 host 写过的身份，攻击者无法把一个从未进入会话的 victim
塞进去；(b) 多人会话的正确归因被保留，因为真实用户必在全集中；(c) 不引入新依赖、不改三库单写者。

## Consequences

- **Positive**：跨会话冒充任意 victim 的攻击被堵死——这是平台头号卖点的核心修复。被拒事件
  通过 `a2a_origin_rejected_total{source_agent_group}` 指标可观测，非零即代表「注入冒充尝试」或
  「某合法 emit 路径在 stamp host 无法验证的身份」，两者都需排查。
- **Negative / 残余风险（会话内身份混淆）**：若攻击者伪造的 `origin_user_id` 恰好是一个**确实在同一
  源会话里出现过**的真实用户 id，交叉校验无法识别——该 id 在合法全集中。这属于「会话内身份混淆」
  的更深问题（需要把 stamp 绑定到具体的触发 turn，而非整会话身份集），本 ADR 不解决，记为
  **Open Question**。
- **Negative / 残余风险（共享 worker 下「同一源会话」的真实边界）**：a2a 目标默认走 `agent-shared`
  会话模式（`findSessionByAgentGroup` 按 `agent_group_id` 复用唯一长生命周期 session）。该 session 的
  `inbound.db` 单调累积**历史上每一个曾委派进来的 `origin_user_id`**，且无 turn/对话/时间窗清理
  （`/clear` 只重置 SDK continuation，不删 `messages_in`）。因此 `collectLegitimateOrigins` 返回的「合法
  全集」是**跨对话、跨时间**的并集，随该 shared session 存活时间只增不减。后果：两个**从未共处同一
  对话**的真实用户，只要各自在该共享 worker 生命周期内任意时点委派过，即落入同一合法集而可互相冒充。
  所以「跨会话冒充任意 victim」的准确表述应为——**与 victim 在同一源会话从无交集才被堵死；而在共享
  worker 下「同一源会话」可横跨多个互不相关的对话**。彻底缓解需把合法集按 root 会话/触发 turn 分区
  （a2a 改用已存在的 `root-session` 模式，或给 `messages_in` a2a 行加对话边界），属后续 ADR 范畴。
  即便如此,**跨 agent-group、与该 worker 从无委派往来的任意 victim 仍无法被冒充**,这是原漏洞的主体。
- **Neutral / Trade-offs**：每次 a2a 路由多一次对源会话 inbound.db 的全表扫描（`messages_in`
  通常很小，单会话量级）。若未来单会话消息量极大需优化，可改为带 `LIMIT` 的近期窗口扫描——
  但那会引入「老身份被滑出窗口而误拒」的风险，需重审本 ADR。

## Implementation Notes

- `src/modules/agent-to-agent/origin-user.ts`：抽出 `namespacedOriginOf`，新增
  `collectLegitimateOrigins`；`resolveOriginUserId` 行为不变（仍取最近一条），复用同一归一化。
- `src/modules/agent-to-agent/agent-route.ts`：合并 origin 解析的 inbound.db 打开为一次；新增
  `import { a2aOriginRejectedTotal } from '../../metrics.js'`（指标由编排者预先在 metrics.ts
  定义，本 ADR 不改 metrics.ts）。
- 容器侧 stamp 逻辑（`container/agent-runner/src/a2a-origin.ts`）**未改动**：它产出的合法值
  （`identity.source==='session'` 时的 `userId`）天然落在合法全集内，因此正常 MCP 路径不受影响；
  只有绕过它、直写 outbound.db 的伪造值会被拒。
- 验收点：`src/modules/agent-to-agent/agent-route.test.ts` 新增 4 例（合法采用 / 伪造被拒并兜底
  且指标自增 / 多人会话各自合法被接受 / 空自报维持兜底链）；`src/modules/agent-to-agent/origin-user.test.ts`
  新增对 `collectLegitimateOrigins` 的直接单测。指标名：`<ns>_a2a_origin_rejected_total`。

## References

- 2026-06 全仓成熟度审计（身份链可伪造，确认差距之一）
- `src/branding.ts`（METRIC_PREFIX 命名空间）
- 信任模型出处：CLAUDE.md「三库单写者不变量」「身份信任链」load-bearing invariants
- 容器自报值的最初动机：`agent-route.ts` 中 `RoutableAgentMessage.origin_user_id` 字段注释
