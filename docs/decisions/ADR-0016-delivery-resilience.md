# ADR-0016: 出站投递韧性 — 超时、有界并发、持久化退避重试与死信工具

- **Status**: Accepted
- **Date**: 2026-06-12
- **Decider(s)**: yingqi2（用户，批准）；coding agent（提案 + 执行）
- **Tags**: `delivery`, `reliability`, `session-db`, `migration`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

2026-06 全仓成熟度审计确认了出站投递路径的四个结构性弱点（`src/delivery.ts` / `src/db/session-db.ts`）：

1. **无超时**：`deliverMessage` 对 `deliveryAdapter.deliver` 没有任何超时包装。一次卡死的渠道 API 调用（飞书网关 hang、网络黑洞）会无限期占住该 session 的投递。
2. **全串行轮询**：`pollActive` / `pollSweep` 对所有 running/active session 逐个 `await`。叠加第 1 点，单个 session 的慢调用会队头阻塞**所有其他 session**的投递——多用户企业场景下不可接受。
3. **重试形同虚设**：`MAX_DELIVERY_ATTEMPTS=3`，重试发生在相邻 poll tick（约 1 秒间隔）。渠道侧任何超过 3 秒的故障（限流、网关重启、token 过期刷新）都会把消息打成永久 failed。秒级三连击不构成有意义的重试策略。
4. **失败不可恢复**：attempts 计数在内存 Map 里，host 重启即清零（旧注释甚至把这当作 feature）；更糟的是 `markDeliveryFailed` 写入 `delivered.status='failed'` 后，`getDeliveredIds` 不区分 status，failed 行从此**永久排除**在补投之外——没有任何重放工具，消息静默丢失。此外 `drainFn` 中 msg N 失败后循环继续投 msg N+1，破坏了用户可见消息流的 per-session 顺序。

已知约束：

- **三库单写者不变量**（load-bearing，CLAUDE.md）：`delivered` 表在 inbound.db 中，只能由 host 写；open-write-close + `journal_mode=DELETE` 是跨 mount 可靠性的前提，不是优化。
- 已存在的 session inbound.db 不能要求停机重建——schema 变更必须走 `migrateDeliveredTable` 式的"打开时列存在性检查 + ALTER TABLE"惰性升级（与 `migrateMessagesInTable` 同模式）。
- per-session 内部投递必须保持严格串行（`inflightDeliveries` 防重入守卫已存在且必须保留）。

## Options Considered

- **Option A：持久化退避重试（delivered 表加 `attempts` / `next_retry_at` 列）+ 进程内有界并发池 + 死信脚本**。
  优点：零新依赖；重试状态随 session 数据存活、host 重启天然恢复；到期的 failed 行被现有 poll/sweep 路径"自然补投"，无需独立重试调度器。
  缺点：退避精度受 sweep 间隔（60s）限制；跨 session 公平性靠小并发池而非真正队列。工作量：小。

- **Option B：引入外部消息队列（Redis/BullMQ、RabbitMQ 等）承载出站投递**。
  优点：成熟的重试/DLQ/并发语义。
  缺点：给"单 Node 进程 + SQLite"的平台核心引入第一个有状态外部依赖，部署复杂度跳变；且队列内容会成为 delivered 表之外的第二份投递事实来源，与三库单写者模型冲突（谁是 delivered 状态的权威？）。对当前规模（单 host、数十 session）严重过度设计。工作量：大。

- **Option C：只修内存问题（加大 MAX_ATTEMPTS、tick 间退避），不持久化**。
  优点：改动最小。
  缺点：host 重启仍然清零重试状态；长退避（小时级）期间一次重启就丢失"还欠这条消息"的事实；failed 行依旧永久死亡。治标不治本，不解决审计确认的核心差距。工作量：极小。

## Decision

> **拍板**：选 Option A。

1. 重试状态必须与 session 数据同生命周期——`delivered` 表本来就是投递事实的唯一权威（单写者：host），把 `attempts` / `next_retry_at` 放进去是唯一不引入第二事实来源的位置。
2. "到期 failed 行从 `getUndeliverableIds` 的排除集中消失 → 被 poll/sweep 当作未投递行自然重投"复用了全部现有投递机制，不需要新的调度器、新的定时器链，也不触碰单写者边界。
3. 外部队列在单进程 + 每 session 一对 SQLite 文件的架构下没有立足点；等平台真的横向扩展到多 host 时再重审（见 Consequences）。

具体语义（实现于本 ADR 同次提交）：

- **超时**：`adapter.deliver` 包 `DELIVERY_TIMEOUT_MS`（默认 30s，env 可配）。超时视为本次尝试失败。
- **有界并发**：poll/sweep 用 `DELIVERY_CONCURRENCY`（默认 4，env 可配）个 worker 消费 session 队列；per-session 仍由 `inflightDeliveries` 串行化。
- **退避**：失败按 1m / 5m / 30m / 2h / 6h（封顶）调度 `next_retry_at`；attempts 持久化；达 `DELIVERY_MAX_ATTEMPTS=10` 后 `next_retry_at=NULL`，停止自动重试但保留行（DLQ 候选）。
- **本 tick 停投**：msg N 失败后 `break`，N+1 不在同 tick 越位。
- **指标**：`*_delivery_failures_total{reason}` / `*_delivery_retries_total` / `*_delivery_permanent_failures_total`。
- **死信工具**：`scripts/dlq.ts` 列出/重置 failed 行。

## Consequences

- **Positive**:
  - 渠道侧小时级故障后消息自动恢复投递，host 重启不再丢失重试状态。
  - 单个卡死 session 不再阻塞全平台投递（队头阻塞上限从"无界"降到"并发池内一个槽位"）。
  - 永久失败从"静默丢失"变为"可观测（指标）+ 可操作（dlq 脚本）"。

- **Negative**:
  - **at-least-once 重复窗口**：超时后底层渠道调用可能仍然成功（响应在途、网关已收单），而 host 已把该次尝试记为失败——退避到期后重投会让用户看到重复消息。这是有意取舍：另一个方向（超时即视为已投递）会静默丢消息，比重复更糟。渠道 adapter 若支持幂等键可在 adapter 层收窄此窗口，平台核心不强求。
  - **跨 tick 的顺序让步**：msg N 失败进入退避窗口后，下一个 tick msg N+1 会越过它先投出去（同 tick 内不会）。严格全局顺序意味着一条坏消息能堵死整个 session 数小时，可用性优先。
  - 旧库上 pre-migration 的 failed 行（`next_retry_at=NULL`、`attempts=0`）**不会**被自动复活——升级瞬间重发陈年旧消息比留它们在 DLQ 里更危险，操作员可用 `dlq.ts --requeue` 显式重放。

- **Neutral / Trade-offs**:
  - **dlq.ts 的单写者注意事项**：脚本与 host 进程是同一 inbound.db 的两个潜在写者。它采用与 host 完全相同的 open-write-close + `journal_mode=DELETE` + `busy_timeout=5000` 模式，锁竞争下要么等到锁要么 SQLITE_BUSY 失败退出，不会破坏文件；但**建议在 host 停机或低峰时运行 requeue 操作**（纯 list 无害）。
  - 退避到期后的实际重投时机受 poll 间隔影响：running session 约 1s 内、非 running session 最迟下一个 sweep tick（60s）。对分钟级起步的退避表来说精度足够。
  - 若未来平台多 host 横向扩展（delivered 表不再单 host 可见），本 ADR 的进程内并发池与 SQLite 退避语义需要重审，届时 Option B 重新入场。

## Implementation Notes

- 落地文件：
  - `src/delivery.ts` — 超时包装、`drainSessionsBounded` 并发池、失败即 break、持久化 attempts 读写（内存 Map `deliveryAttempts` 已删除）
  - `src/db/session-db.ts` — `getUndeliverableIds`（取代 `getDeliveredIds`）、`markDelivered` 升级为 status 门控 upsert、`markDeliveryFailed(attempts, backoffSec)`、`getDeliveryAttempts`、`listFailedDeliveries`、`requeueFailedDelivery`、`migrateDeliveredTable` 增列
  - `src/config.ts` — `DELIVERY_TIMEOUT_MS` / `DELIVERY_CONCURRENCY` / `DELIVERY_MAX_ATTEMPTS` / `DELIVERY_BACKOFF_SCHEDULE_SEC`
  - `src/metrics.ts` — 三个投递计数器
  - `scripts/dlq.ts` — 死信列表 / requeue
  - `docs/db-session.md` §2.2、`docs/PLATFORM.md` env 表
- 注意：`src/db/schema.ts` 的 `INBOUND_SCHEMA` 基线**未**加 `attempts` / `next_retry_at`（该文件归并行任务的文件集），新库依赖投递路径上必经的 `migrateDeliveredTable` 补齐；后续可把两列合入基线 schema（纯整洁性，无行为差异）。
- 验收：`src/delivery.test.ts`（超时、本 tick 停投、退避窗口、达上限停投）、`src/db/session-db.test.ts`（旧库升级、`getUndeliverableIds` 语义、upsert 不降级、requeue）。
- 依赖上游 ADR：无直接依赖；与 ADR-0011/0014 的 observability 只读约束兼容（指标为 counter，不回写投递状态）。

## References

- 2026-06 全仓成熟度审计（用户 memory：platform-maturity-audit-2026-06）中"投递韧性"项
- `docs/db.md` 三库单写者模型；CLAUDE.md "Load-bearing invariants"
- 同次提交的实现 diff
