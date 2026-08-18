# ADR-0059: 容器准入队列 — 事件驱动的坑位交棒

- **状态**:Accepted
- **日期**:2026-08-18
- **关联**:服务化方向(并发第 0 级);ADR-0058(沙箱可扩展);2026-08 编排调研

## Context

并发上限(`MAX_CONCURRENT_CONTAINERS`,默认 10)满员时,新会话的唤醒被拒绝后
**只能等 host-sweep 的下一个 60 秒 tick** 重试——第 11 个用户开口,最坏等一分钟才排上。
对"开箱即用的服务"这是不可接受的排队粒度;而调研中所有生产级聊天平台的共识是
坑位交棒必须事件驱动(队列/事件,不是轮询)。

两个可选方案:

- **A. 缩短 sweep 周期**(60s → 5s):全局轮询变频繁,所有会话的 IO 探测成本 ×12,
  且粒度仍是秒级轮询,不解决本质;
- **B. 事件驱动交棒**:容量拒绝时入队,容器退出事件即刻放行下一个。选 B。

## Decision

> 新增 `admission-queue`:容量拒绝的会话进**去重 FIFO**;每个**容器退出事件**
> (close/error)从队头放行一个。sweep 保持原样,作为兜底(belt & suspenders)。

- **一坑一放**:一次退出只做一次准入尝试;wake 再次被拒(抢坑竞态)→ **回队头**保住顺位。
- **陈旧条目跳过**:出队时校验(会话 active + inbound 有 due 消息——open-read-close,
  与 host-sweep 同款探测);被 sweep 抢先唤醒过的条目自然失效,跳过不算准入。
- **有界**:去重保证队长 ≤ 会话数;查找失败(关库/撕裂)丢条目并告警——sweep 兜底,
  队列 bug 最多延迟一次唤醒,**永远不会困死一个会话**(双路都汇入幂等的 wakeContainer)。
- **全 DI**:drain 逻辑依赖注入(getSession/hasDueWork/wake),单测不碰 Docker 与 DB。
- 指标:`admission_queue_depth`(gauge)、`admission_admitted_total`(counter);
  容量拒绝日志带上队深。

## 不做什么

- **不做公平性**(每租户/用户令牌桶)——独立 PR,防话痨占满坑是下一步;
- **不在 spawn 失败路径 drain**——失败常意味环境故障(dockerd 挂),drain 会立刻再失败
  形成 requeue-front↔drain 的乒乓;失败留给 sweep 的 60s 节奏恰当;
- 不改 sweep 周期、不改 cap 语义。

## Consequences

- 满员突发下的排队延迟从"最坏 60s/坑"降为"上一个容器退出即放行"(事件级)。
- 新增一条唤醒路径,但与 sweep 汇合于幂等的 wakeContainer——重复唤醒无害(joins in-flight)。
- ~~诚实边界:容量检查存在先前就有的超额竞态~~ **红队纠正**:容量检查与 in-flight
  注册在同一同步段内完成(单线程,无 await 间隔),**不存在**先前声称的超额竞态;
  drain 也未新增超额窗口。

## 验证

- `admission-queue.test.ts`(全 DI):去重 / FIFO 一坑一放 / 陈旧条目连跳 /
  再拒回队头保顺位 / 空队 no-op / 查找异常丢弃不炸退出处理器。
- 全套本地 CI + 真实 CI;合并前红队(动唤醒路径,按惯例)。

## 修正(2026-08-18,合并前红队:4 视角 17 agent,13 条确认全修/记录)

**两条 major(设计缺陷,已修):**

1. **队头饿死**:启动持续失败(如 container.json 损坏,readContainerConfig 失败关闭)的会话
   被无限回队头,烧掉之后每个坑位的唯一准入尝试——队列后面的所有人退化回 sweep 延迟,
   特性平台级静默失效;且与本 ADR"不做什么"里"不急切重试 spawn 失败"的声明自相矛盾。
   修复:**失败预算**——首败回队头(常见原因是抢坑竞态,保顺位),再败转队尾(不饿别人),
   连败 3 次**逐出**并告警(sweep 接管);成功清零计数。
2. **关机重生**:优雅关机时 stopAllContainers 停容器 → close 处理器触发 drain →
   孵出逃过关机快照的新容器,进程退出后仍在跑;快速重启 + 孤儿清理失败的极端场景 =
   **两个写者压一个 outbound.db(三库不变量违反)**。修复:stopAllContainers 起手置
   `admissionDrainDisabled`,此后所有退出事件不再交棒。

**连带修复的确认项:**

- **雪崩链**:daemon 挂掉时,每次失败 spawn 的快速退出会连锁 drain 把整个队列几秒内
  烧穿。修复:**快退不叫号**——非 idle 退出且存活 < 10s 视为环境故障,不交棒(sweep 节奏接管)。
- **双事件双 drain**:失败 spawn 可同时发 error+close。修复:每容器 handOffSlot 单次门闩。
- **"回队头"从未生效**:wakeContainer 的容量拒绝路径先把 id 排到了队尾,drain 的
  requeueFront 因去重成了 no-op。修复:requeueFront 改**强制移位**(先摘除再置前)。
- **探针异常浪费整个坑位**:probe 抛错原本直接 return。修复:丢弃该条目后 **continue**
  尝试下一个候选。
- **探针副作用**:probe 缺 existsSync 守卫,对已归档目录 open 会**创建**空 inbound.db。
  修复:先 existsSync(与 sweep 完全同款)。
- **已运行会话计入 admitted**:drain 缺 sweep 的 isContainerRunning 门。修复:补 isRunning
  依赖,运行中条目按 stale 跳过不计数。
- **ADR 自身的错误声明**:超额竞态段(见上方划线纠正)。

**记录为残留(不修,有据):**

- wake 返回 true 但属于"join 到 in-flight 唤醒"的窄窗仍会计入 admitted(概率极低,
  指标语义误差可接受);
- 接线层(拒绝入队/退出交棒/真实探针)无集成测试——需要 spawn 打桩,性价比差;
  正确性由 sweep 兜底不变量保证,队列语义已被 7 个全 DI 单测钉死。
