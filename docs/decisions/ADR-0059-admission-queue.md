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
- 诚实边界:wakeContainer 的容量检查在异步 span 内注册 in-flight,drain 与并发
  router 唤醒之间存在**先前就有的**轻微超额竞态(可能短暂超 cap 1-2 个),本 ADR 未扩大它。

## 验证

- `admission-queue.test.ts`(全 DI):去重 / FIFO 一坑一放 / 陈旧条目连跳 /
  再拒回队头保顺位 / 空队 no-op / 查找异常丢弃不炸退出处理器。
- 全套本地 CI + 真实 CI;合并前红队(动唤醒路径,按惯例)。
