# ADR-0022: 入站消息路由前持久化 — 可恢复账本 + 操作员显式重放

- **Status**: Accepted
- **Date**: 2026-06-12
- **Decider(s)**: yingqi2（用户，批准）；coding agent（提案 + 执行）
- **Tags**: `inbound`, `reliability`, `router`, `migration`, `observability`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

2026-06 全仓成熟度审计在出站侧（ADR-0016）之外，留下了入站主路径的一个结构性丢消息缺口。

入站消息的持久化点在 router 深处：`routeInbound → routeInboundInner → deliverToAgent → writeSessionMessage`，
后者才真正写入该 session 的 `inbound.db.messages_in`。在到达这一步**之前**的任何抛错，都会让消息无声蒸发：

- session `inbound.db` 跨挂载写入触发 `SQLITE_BUSY`；
- 附件落盘 IO 失败（`writeSessionMessage` 会把附件 stage 到磁盘）；
- 中央库瞬时错误；
- host 在路由中途崩溃。

这类失败的后果是：**没有 `messages_in` 行、没有 `dropped_messages` 行、没有重试**——
webhook 早已返回 200,渠道不会重推；唯一的痕迹只是 `inbound_total{rejected}` 自增一个无主体的计数。

这是三处投递缺口里唯一**无法靠现有重试机制自愈**的：

- 出站失败由 ADR-0016 的持久化退避重试 + DLQ 兜底；
- `messages_in` 写入之后的容器侧失败由 host-sweep 的 `resetStuckProcessingRows` 兜底;
- 但 `messages_in` **写入之前**的失败没有任何账本,消息从未在系统里留下可恢复的痕迹。

### 关键已知约束（决定了方案形状）

1. **去重在 adapter 层,不在 router**。`src/channels/feishu.ts` 在调用 `routeInbound` **之前**调用
   `markInboundSeen('feishu', msg:<event_id>)`（`src/db/inbound-dedup.ts`,`INSERT OR IGNORE`,first-seen-wins）。
   因此**任何自动重放 `routeInbound` 的机制都会绕过这层去重 → 重复投递**。
2. **三库单写者不可弱化**(CLAUDE.md load-bearing invariant)。中央 `v2.db` 由 host 单写、WAL;
   每个 session 的 `inbound.db` 由 host 写、`outbound.db` 由容器写。新账本必须落在中央 `v2.db`,
   绝不能碰 session 的 inbound/outbound.db。
3. **`routeInboundInner` 有多个"正常 return"路径**(未 wired 频道、非 mention、denied channel 等,
   见 `src/router.ts` line 215/246/253 等)——这些是**有意忽略,不是失败**,不应留存为待恢复项。

## Options Considered

- **Option A:让 adapter 在 webhook 返回前同步等 routeInbound 完成,失败则返回非 200 让渠道重推。**
  优点:复用渠道自身的 at-least-once 重投。缺点:(a) 飞书长连接模式没有"返回非 200"语义;
  (b) 会把 routing 全程塞进 webhook 响应预算(<1s),与 ADR-0016 的有界异步投递相悖;
  (c) 渠道重推会再次命中 adapter 去重,行为不确定。不可行。

- **Option B:把 `inbound_dedup` 改造成 ingress 表,既做去重又做恢复账本。**
  优点:少一张表。缺点:**致命地混淆两个关注点**——去重键是渠道 `event_id`(语义:这条事件见过没有),
  恢复账本键应是 routing 尝试(语义:这次路由完成没有)。共用一张表会让"删除恢复行"与"清除去重记录"
  纠缠,且一旦用 `event_id` 做主键,重放就无从与去重区分。驳回。

- **Option C(选中):在 `routeInbound` 入口、`routeInboundInner` 之前,向中央 `v2.db` 新表
  `inbound_ingress` 写一行 `status='received'`(原始 envelope JSON + synthetic uuid 主键);
  正常完成(含有意忽略的 return)→ DELETE;抛错 → `markFailed`(`status='failed'`,记 `last_error`,
  `attempts++`)保留,然后照常抛出异常。重放由独立 CLI `scripts/replay-inbound.ts` 操作员显式触发。**

## Decision

> **拍板**:选 Option C。

核心理由(均可验证):

1. **持久化层 ≠ 去重层**。`inbound_ingress` 主键是 synthetic uuid,**不是** `event_id`;
   它回答"这次路由尝试完成了吗",与 `inbound_dedup` 回答的"这条渠道事件见过吗"正交,二者共存。
   这条边界写进了表注释、模块 doc 与 metrics help,防止后人再次想合表。
2. **重放必须操作员显式触发,绝不自动**。因为去重在 adapter 边界、在 `routeInbound` 之前,
   任何在 host 启动或 sweep 里自动重跑 `routeInbound` 的机制都会**绕过去重 → 重复投递**。
   所以 host 启动只 `surfaceOrphanedIngress()`(只统计 + 告警 + 反映指标),sweep **不碰**这些行,
   重放只发生在 `scripts/replay-inbound.ts --replay`,且 CLI 头注释与每次重放输出都明确警告可能重复投递。
3. **稳态不留存成功行**。正常路由(含有意忽略的 return)立即 DELETE,
   使该表在稳态只含"在途 + 失败",不随消息量无界膨胀——这是它能放在 host 主路径上的前提。

## Consequences

- **Positive**:
  - 入站主路径不再有静默丢消息缺口;失败消息以原始 envelope 形式可查、可重放。
  - host 崩溃后,残留 `status='received'` 的在途行在下次启动被 `surfaceOrphanedIngress()` 暴露。
  - 新增 `inbound_ingress_failed_total{channel}` 指标,可对"持久化后路由失败"告警。
  - 全部落在中央 `v2.db`,不触碰 session DB,三库单写者不变。

- **Negative / 风险**:
  - **重放可能重复投递**(绕过 adapter 去重)。这是刻意的取舍:宁可让操作员在确认未处理后显式重放、
    承担重复风险,也不接受静默丢失。风险通过 CLI 警告 + "建议 host 停机/低峰运行"缓解。
  - 主路径每条入站消息多一次中央库 `INSERT` + 成功后一次 `DELETE`。中央库 WAL 单写,
    相对 routing 本身的开销可忽略;无法接受的高吞吐场景可用 `INGRESS_DURABILITY=off` 回退。

- **Neutral / Trade-offs**:
  - `status='received'` 的孤儿行不自动清理(可能是崩溃遗留)。默认保留,清理交给重放 CLI 成功后的 DELETE;
    若未来出现无界增长,可考虑对超长(如 >24h)的 received 行做保留期回收——本次未实现,留给后续。
  - 启动时把 `failed` 计数以合成 channel 标签 `__startup_backlog__` 反映到指标(逐条增量在进程崩溃后丢失),
    属可观测性补偿,不影响身份链与消息流(observability 只读 invariant 保持)。

## 与既有机制的边界

- **vs ADR-0016(出站韧性)**:ADR-0016 解决 `messages_out` **已存在**之后的投递失败(持久化退避重试 + DLQ);
  本 ADR 解决 `messages_in` **尚未写入**之前的入站路由失败。二者是消息流的两端,互不重叠。
- **vs `dropped_messages`/`unregistered_senders`**:后者记录**结构性丢弃审计**(无 agent wired、未授权发送者、
  无 agent engaged)——这些是**有意的、预期内的**丢弃。`inbound_ingress` 记录的是**意外的、待恢复的**路由失败。
  有意忽略的 return 路径**删除** ingress 行(不是失败),与 `dropped_messages` 的记录互不冲突。
- **vs `inbound_dedup`**:见上,正交,共存。

## Implementation Notes

- 落地文件:
  - `src/db/migrations/026-inbound-ingress.ts`(新表)+ `src/db/migrations/index.ts`(注册,version 26)
  - `src/db/inbound-ingress.ts`(insert/markFailed/delete/get/list/countByStatus)
  - `src/router.ts`(`routeInbound` 入口 persist;成功/忽略 DELETE;失败 markFailed + 指标 + 重抛;
    `ingressDurabilityEnabled()` 读 `INGRESS_DURABILITY`,默认 on)
  - `src/metrics.ts`(新增 `inbound_ingress_failed_total{channel}`,本任务唯一改动点)
  - `src/ingress-recovery-check.ts` + `src/index.ts`(启动序列在 `checkGatewaySigningCoverage()` 后调用
    `surfaceOrphanedIngress()`,只统计/告警/反映指标,**不自动重放**)
  - `scripts/replay-inbound.ts`(`--list` / `--replay <id>` / `--replay-all`,重放 = 读 envelope 重新
    `routeInbound`,成功 DELETE,失败 `attempts++`;头注释 + 重放输出明确警告绕过去重→可能重复投递,
    建议 host 停机/低峰运行)
- 开关:`INGRESS_DURABILITY`(默认 on;`off`/`0`/`false` 跳过持久化,高吞吐回退),
  读取走 `readEnvFile` + `process.env` 既有模式。
- 验收点:`src/db/inbound-ingress.test.ts`(模块单测 + 迁移幂等)、`src/host-core.test.ts` 的
  "Inbound ingress persist-before-route" 用例(成功删除 / 有意忽略删除 / 抛错保留为 failed +
  `inbound_ingress_failed_total` 自增 + 异常仍抛 + `inbound_total{rejected}` 语义不变 /
  `INGRESS_DURABILITY=off` 不写)。

## References

- ADR-0016(出站投递韧性)— 消息流另一端的可恢复性
- ADR-0017 / ADR-0018(身份链)— 本改动不触碰身份链,纯入站可恢复性
- `src/channels/feishu.ts`(`markInboundSeen` 调用点,去重在 `routeInbound` 之前)
- MEMORY:platform-maturity-audit-2026-06.md(确认入站丢消息缺口)
