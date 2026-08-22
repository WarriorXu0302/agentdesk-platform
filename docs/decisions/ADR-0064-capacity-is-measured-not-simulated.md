# ADR-0064: 容量靠生产测量,不靠合成压测——并附 sweep 不是瓶颈的实测结论

- **Status**: Accepted
- **Date**: 2026-08-23
- **Decider(s)**: 仓库所有者(拍板);coding agent(测量 + 提案 + 执行)
- **Tags**: `capacity`, `observability`, `concurrency`, `metrics`
- **上游**: ADR-0059(准入队列)、ADR-0058(沙箱运行时可扩展性)

---

## Context

并发第 0 级原本列的是两件事:**准入队列**(ADR-0059,已落地)与**压测**(未做)。
本轮准备做压测台时,先做了一次实测来决定该测什么——结果推翻了动手前的假设。

**假设(错的)**:`host-sweep` 串行 `await` 每个活跃会话,且下一 tick 在整轮结束后
才排期,所以有效周期 = 60s + tick 耗时;每会话要开两个 SQLite 文件,
会话一多 tick 就会超过 60 秒,系统永久落后。

**实测(本地 SSD,better-sqlite3,每会话执行 `sweepSession` 对空闲会话的等价工作)**:

| 会话数 | 一轮 tick | 每会话   |
| ------ | --------- | -------- |
| 10     | 1.4 ms    | 0.144 ms |
| 50     | 7.5 ms    | 0.150 ms |
| 100    | 15.1 ms   | 0.151 ms |
| 250    | 36.5 ms   | 0.146 ms |
| 500    | 80.3 ms   | 0.161 ms |
| 1000   | 147.3 ms  | 0.147 ms |

**严格线性,每会话 ~0.15 ms。** 1000 会话一轮 147 ms。即便把每会话开销放大 100 倍
(慢速网络卷),也要数千会话才逼近 60 秒。顺带核实了另一个假设也是错的:
`isContainerRunning` 不是 `docker inspect` 子进程,只是内存 Map 查找。

所以宿主循环不是容量瓶颈,**坑位**才是:`MAX_CONCURRENT_CONTAINERS` 默认 10。
而回答"多少人会排队、排多久"需要两个输入——**坑位持有时长**与**排队等待时长**
——`/metrics` 上**一个都没有**(全文件只有一个 Histogram,`route_seconds`)。

## Options Considered

- **Option A**:建端到端压测台(N 个合成用户跑真实入站路径)。
  能给出一条曲线;但坑位持有时长由 **LLM 回合时长**主导,合成负载要么打真 LLM
  (贵、不确定、不可在 CI 跑),要么打桩(那就不是在测真正的分母)。
  且宿主侧要重定向 `DATA_DIR` 才能不污染真实数据目录,而 `DATA_DIR` 目前是
  `path.resolve(PROJECT_ROOT, 'data')` 硬编码,得为压测新开配置口子。
- **Option B**:给容器运行时加 provider 接缝,插一个空运行时来跑压测。
  **不可行**:ADR-0058 明确拒绝"只有一个实现的 provider registry",
  为压测引入它会直接违反该决策。
- **Option C**:补齐生产可观测性——把两个缺失的输入变成直方图,
  并把容量写成一份可算的文档;sweep 的那组数字作为**一次性实测结论**记录下来,
  不做成常驻工具。
- **Option D**:什么都不做,继续按感觉调 `MAX_CONCURRENT_CONTAINERS`。

## Decision

> **拍板**:选 Option C。**容量在生产里测,不在合成负载里模拟。**

1. 新增 `admission_wait_seconds`(histogram)——用户实际感受到的排队延迟。
2. 新增 `container_lifetime_seconds{outcome}`(histogram)——坑位持有时长,
   吞吐公式的分母;按 outcome 分标签,否则**崩溃循环与健康的高速周转在图上一模一样**。
3. 新增 `container_slots_in_use` / `container_slots_max`(两个 gauge,不是一个比值)
   ——比值会让"抬高上限"和"负载下降"看起来相同。
4. `docs/capacity.md` 写清吞吐公式、每个指标的读法、两处易读错的地方、扩容顺序,
   以及**明确的未做项**。
5. **不建压测台**,并在文档里写明理由,免得下一位重新提议。

**等待时长从会话_首次_入队开始计,重排队不重置。** 抢坑失败被放回队列的会话等的是全程;
在重排队处重置时钟,会让报出来最漂亮的数字恰好属于体验最差的会话。
只有成功准入才观测;陈旧跳过与驱逐清理时间戳但**不**观测——从未通过队列拿到坑位的
会话没有队列等待可言,把它们计入会污染分布。

## Consequences

- **Positive**
  - 容量从"拍脑袋"变成可算:`坑位数 / mean(container_lifetime_seconds)`,
    两个输入都有真实直方图。
  - 记录了一条**负面结论**:sweep 不是瓶颈(实测),省掉后来者的重复调查
    ——以及我自己差点动手的那个错误优化。
  - 崩溃循环现在能与健康周转区分开(outcome 标签)。
  - 不新增依赖、不新增配置口子、不违反 ADR-0058。

- **Negative**
  - 没有曲线可以在合并前跑。回归要靠生产上的指标,不是 CI 门。
  - 每容器多一个时间戳、每次退出多一次直方图观测——可忽略,但确实是新状态。
  - sweep 那组数字来自**一台机器一次测量**,不是持续基准。若某次改动让每会话
    开销上一个数量级,没有自动告警;`docs/capacity.md` 记了复现步骤作为补偿。

- **Neutral / Trade-offs**
  - 直方图桶是按预期量级选的(等待 0.05s–300s、寿命 1s–3600s),
    未经生产分布校准。若真实分布挤在某一端,桶需要重选。
  - **公平性仍然没做**:一个话痨用户可以占满全部坑位。准入队列只保证 FIFO。
    这些指标会让不公平**可见**(等待分布长尾),但不解决它——每租户令牌桶仍是独立 PR。
  - 若将来真要横向扩展,这些指标是必需的输入,但不充分;三库通道的网络化才是前提。

## Implementation Notes

- 新增指标:`src/metrics.ts`
- 埋点:`src/admission-queue.ts`(首次入队计时 / 成功准入观测 / 跳过与驱逐清理)、
  `src/container-runner.ts`(`spawnedAt` 挂在 `activeContainers` 条目上,
  随条目一起消失;`close` 与 `error` 都可能为同一次失败 spawn 触发,
  故**先读后删**使观测天然只发生一次)
- 文档:`docs/capacity.md`
- 测试:`src/admission-queue.test.ts` 新增 4 项;
  `src/container-runner.test.ts` 新增 2 项——**"只观测一次"原本是我口头声称、
  零测试的**(和"容器侧镜像零测试"是同一类问题,只是这次是我自己)。
  为此把观测逻辑改成接收**条目**而非 session id 的导出纯函数
  `observeContainerLifetime(entry, outcome, nowMs)`:once-only 于是成为参数的性质,
  不用起容器就能测——`close`/`error` 各自调用后立刻删条目,第二次拿到的是
  `undefined`。双观测会**把平均坑位持有时长直接砍半**,而吞吐上限就是拿它当分母算的。
- 验收(红先,逐条实测):
  - 移除跳过清理 → 变红;移除驱逐清理 → 变红;
    移除 once-only 守卫 → 变红;去掉 `outcome` 标签 → 变红。
  - "重排队不重置时钟"这条**头两版测试都是空的**:第一版只驱动了一次失败,
    而第一次失败走 `requeueFront`(根本不碰时间戳),所以改 `enqueueAdmission`
    对它无影响;第二版驱动到了回队尾路径,但把等待放在最后一次入队**之后**,
    于是重置与否结果相同。第三版把等待累积在重排队**之前**,才真正变红
    (`expected 0.001 to be >= 0.06`——重置丢掉了 80ms)。

## References

- ADR-0059 的"不做什么":公平性列为独立 PR——本 ADR 未改变这一点
- ADR-0058:拒绝单实现 provider registry,因而 Option B 不可行
- 实测:`isContainerRunning` 为 `activeContainers.has(sessionId)`,非子进程调用
