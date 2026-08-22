# 容量:一台宿主能承载多少人

这份文档回答一个运营问题:**在当前配置下,多少并发用户会开始排队,排多久。**
它是可测量的,不是估算的——下面每个数字要么来自实测,要么来自 `/metrics` 上的真实指标。

## 结论先行

瓶颈是**容器坑位**,不是宿主进程。

- 宿主每个空闲会话的 sweep 开销实测 **~0.15 ms**,且随会话数**严格线性**
  (10 / 50 / 100 / 250 / 500 / 1000 会话分别为 1.4 / 7.5 / 15.1 / 36.5 / 80.3 / 147.3 ms 一轮;
  本地 SSD,better-sqlite3)。即便把每会话开销放大 100 倍(慢速网络卷),
  一轮 tick 也要**数千**会话才逼近 60 秒的 sweep 周期。
  **不要为 sweep 做容量优化**——那里没有问题。
- 真正的上限是 `MAX_CONCURRENT_CONTAINERS`(默认 **10**)。超出的唤醒进准入队列
  (ADR-0059),由容器退出事件即时交棒。

## 吞吐上限

```
吞吐上限(次唤醒/秒) = MAX_CONCURRENT_CONTAINERS / mean(container_lifetime_seconds)
```

容器不是每条消息起停一次——它会服务完一串对话后闲置退出,所以
`container_lifetime_seconds` 就是**坑位持有时长**,是这个式子唯一需要实测的输入。
默认 10 个坑位、平均寿命 120 秒,上限约 **0.083 次唤醒/秒 ≈ 每分钟 5 个用户**。
这个数字对你的部署几乎肯定是错的——去看你自己的直方图。

排队等待用 Little 定律估:`平均等待 ≈ 队深 / 吞吐`。但不必推导,
`admission_wait_seconds` 直接测了它。

## 该看哪些指标

| 指标                                          | 类型      | 读法                                                                        |
| --------------------------------------------- | --------- | --------------------------------------------------------------------------- |
| `<brand>_container_slots_in_use`              | gauge     | 贴着 `slots_max` 跑 = 已饱和,后续用户在排队                                 |
| `<brand>_container_slots_max`                 | gauge     | 配置的上限。与 in_use 分开发布,这样"抬高上限"和"负载下降"在图上不会长得一样 |
| `<brand>_admission_wait_seconds`              | histogram | **用户实际感受到的排队延迟**。p95 是你的 SLO 抓手                           |
| `<brand>_container_lifetime_seconds{outcome}` | histogram | 坑位持有时长,吞吐公式的分母                                                 |
| `<brand>_admission_queue_depth`               | gauge     | 当前排队会话数                                                              |
| `<brand>_admission_admitted_total`            | counter   | 经队列放行的次数;与 `container_exits_total` 对照可看交棒是否在工作          |
| `<brand>_wake_rejected_total`                 | counter   | 因容量被拒的唤醒                                                            |

`<brand>` 是 `PLATFORM_PROTOCOL_NAMESPACE`(见 `src/branding.ts`)。

### 两个容易读错的地方

1. **`container_lifetime_seconds` 必须按 `outcome` 分开看。** 崩溃循环表现为
   大量极短寿命——如果不看标签,它在图上和"健康的高速周转"一模一样,
   而后者是好事、前者是事故。
2. **`admission_wait_seconds` 从会话_首次_入队开始计,不因重排队重置。**
   一个抢坑失败被放回队列的会话,等的是全程;若在重排队处重置时钟,
   报出来最漂亮的恰好是体验最差的那些会话。只有**成功准入**才记一次观测;
   陈旧跳过和驱逐不记——从未通过队列拿到坑位的会话,没有队列等待可言。

## 要加容量,按这个顺序

1. **先看 `container_lifetime_seconds`。** 如果 p50 很长而 agent 大部分时间在空转,
   缩短闲置退出比加坑位便宜得多。
2. **再抬 `MAX_CONCURRENT_CONTAINERS`。** 每个坑位是一个容器,受内存与 CPU 约束;
   抬到宿主扛不住只是把排队换成了抖动。抬完盯 `container_slots_in_use`
   和宿主自身的资源。
3. **然后才是横向扩展。** 尚未支持——三库通道走本地文件挂载,多机需要先把
   该通道网络化(见 ADR-0058 关于云沙箱 provider 的同一段讨论)。

## 尚未做的

- **公平性**:没有每租户/每用户令牌桶。一个话痨用户可以占满全部坑位,
  准入队列只保证 FIFO,不保证公平(ADR-0059 明确列为独立 PR)。
- **端到端压测台**:没有,也**刻意不建**。上面的 sweep 数字是一次性实测得出的;
  剩下的两个输入(坑位持有时长、排队等待)由 LLM 回合时长主导,
  合成负载无法复现,只能在生产里量——这正是上面那两个直方图存在的原因。

## 复现 sweep 那组数字

那是一次性测量,不是仓库里的常驻工具(见"尚未做的")。方法:在临时目录下建
N 个会话目录、各含 inbound.db / outbound.db,然后对每个执行 `sweepSession`
对空闲会话所做的等价工作,计时。等价工作是:

1. 打开 inbound.db 与 outbound.db(各含 `journal_mode` / `busy_timeout` pragma);
2. 扫 `processing_ack` 里 `status='completed'` 的行;
3. 数 inbound 的 due 消息;
4. 扫一遍 recurrence 候选;
5. 关掉两个库。

若某次改动让每会话开销上一个数量级,这个测法能在几分钟内复现出来。
