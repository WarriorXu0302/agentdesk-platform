# ADR-0065: 准入公平性 — 最少占用桶优先,而不是令牌桶

- **Status**: Accepted
- **Date**: 2026-08-23
- **Decider(s)**: 仓库所有者(拍板);coding agent(提案 + 执行)
- **Tags**: `concurrency`, `fairness`, `admission`, `multi-user`
- **上游**: ADR-0059(准入队列,把公平性明确列为"不做什么/独立 PR")、
  ADR-0064(容量靠生产测量;`admission_wait_seconds` 让本决策的效果可观测)

---

## Context

ADR-0059 把容量拒绝后的等待从"最坏 60 秒一坑"降成了事件驱动交棒,但它是
**严格 FIFO**,并在"不做什么"里写明:公平性另开 PR,"防话痨占满坑是下一步"。

FIFO 在这套系统里不是中性的,因为**一次请求可以产生多个坑位需求**:
frontdesk 委派给 N 个 worker,而 worker 会话继承
`sourceSession.owner_user_id`(`agent-route.ts`)。所以一个人问一句话,
可能在队列里排进 8 个条目。下一个开口的人要等**8 个完整的模型回合**才轮到自己
——不是等 8 次调度,是等 8 次 LLM 生成。

坑位默认只有 10 个(`MAX_CONCURRENT_CONTAINERS`),所以这不是极端场景,
是"两个人同时用、其中一个触发了委派"就会发生的场景。

## Options Considered

- **Option A**:每租户/每用户**令牌桶**(ADR-0059 里写的那个)。表达力强,
  能表达"每人每分钟最多 N 次唤醒";但要配置速率与补充周期,而正确的数值
  取决于坑位持有时长(由 LLM 回合主导,见 ADR-0064),运营者没有依据可填。
  配错的两个方向都难受:太紧=空坑位闲置,太松=等于没做。
- **Option B**:**最少占用桶优先**,同占用时按队列顺序。无配置项;
  一个占 0 坑的桶永远赢过占 ≥1 的桶;而准入本身会抬高赢家自己的计数,
  所以桶之间自动收敛而不是一个赢到底。
- **Option C**:按桶轮转(round-robin over buckets)。与 B 接近,
  但需要维护游标与桶集合的生命周期;B 用一次线性扫描就得到同样的效果,
  队长本就被会话数上界约束。
- **Option D**:什么都不做,靠运营者调大 `MAX_CONCURRENT_CONTAINERS`。
  抬高上限只是把排队换成宿主抖动(ADR-0064 的扩容顺序里已写明),
  且不改变"一个人可以占满全部坑位"这一事实。

## Decision

> **拍板**:选 Option B。**没有速率可配,也没有饥饿可能。**

1. **公平桶(`sessionFairnessKey`)**:
   - 有 `owner_user_id` → `user:<id>`。委派继承 owner,所以扇出记在**发起的那个人**头上,
     这正是公平性要覆盖的情形。
   - 无 owner(群聊)→ `group:<messaging_group_id>`。**按群分桶而不是把所有无主会话
     堆成一桶**——否则一个忙碌的群会把另一个群的顺位往后推。
   - 两者皆无 → `session:<id>`,自成一桶。这个兜底只可能让它占优,是安全的方向。
2. **选取规则**:出队时取"所属桶当前占用坑位最少"的条目,**同占用按队列顺序**。
3. **无竞争时行为与之前完全一致**:所有桶占用相同 → 退化成 FIFO。
   这条由测试固定,因为它是"这次改动不会打乱现有顺序"的保证。
4. 桶在**首次入队**时记录,重排队沿用。会话的 owner 不该在等待途中改变它的顺位。
5. 坑位计数取自**活的容器表**,不是 DB——量的是此刻真正占着上限的东西。

## Consequences

- **Positive**
  - 一次委派扇出不再把后来者压在整整 N 个模型回合之后。
  - 零配置。运营者不需要知道任何速率,也没有配错的方向。
  - 无饥饿:准入抬高赢家自己的计数,桶间收敛;且同占用退化为 FIFO,
    桶内顺序严格保持。
  - 效果可观测:ADR-0064 的 `admission_wait_seconds` 分布长尾变短就是它在起作用。

- **Negative**
  - 公平的单位是**桶**,不是**工作量**。一个桶里跑着 10 分钟的回合、另一个桶跑 5 秒,
    两者被同等对待。要做到按时间公平需要加权,而权重又要依赖尚未测量的
    `container_lifetime_seconds` 分布——等有了生产数据再谈。
  - 每次准入 O(队长) 扫描。队长以会话数为上界,而准入发生在容器退出事件上
    (秒级),所以可以忽略;但如果将来队列语义变成"每次退出放行多批",要重新看。
  - 桶是**逐坑位**的,不是逐请求:一个用户如果保持 3 个长驻会话,
    他就长期占 3 个坑,这里只保证新来的人不必排在他后面,
    不保证他被降到 1 个。这是刻意的——降他等于中断正在进行的对话。

- **Neutral / Trade-offs**
  - 未记录桶的条目(理论上只在"入队路径没传 key"时出现)按**占用 0** 处理,
    即永不被压后。宁可让一个身份不明的条目占便宜,也不要凭猜给它安一个桶。
  - 组织(organization)不是桶的一层。多租户隔离是宿主侧的访问闸(ADR-0052),
    与调度公平是两回事;若将来要"按租户配额",那是另一个决策,不是把 org 塞进这里。

## Implementation Notes

- `src/admission-queue.ts`:`sessionFairnessKey`、`fairnessKeyOf`、`pop(slotsHeldBy)`、
  `AdmissionDeps.slotsHeldBy`
- `src/container-runner.ts`:容器条目带 `fairnessKey`;`countSlotsHeldBy`(纯函数,
  可测)与 `slotsHeldBy`(读活表)
- 测试:`src/admission-queue.test.ts` +10、`src/container-runner.test.ts` +2
- 验收(红先):
  - 还原为纯 `pop()` → "扇出后来者插队"与"未知桶按 0 处理"两条变红。
  - 把"未知桶=0"改成"未知桶=最大值" → 后一条变红。
  - "桶内 FIFO""同占用 FIFO""重桶最终排空"三条在纯 FIFO 下**本就应绿**
    ——它们是"没有竞争时不改变行为"的非回归守卫,绿了才对。
  - `countSlotsHeldBy` 拆成接收条目的纯函数,而不是只在散文里声称计数正确
    ——上一次(ADR-0064 的 once-only)就是这么补的课。

## References

- ADR-0059 "不做什么":公平性列为独立 PR — 本 ADR 即是
- ADR-0064:`admission_wait_seconds` / `container_lifetime_seconds`,
  本决策的效果与其加权版本的前提都在那里
- `agent-route.ts`:worker 会话继承 `sourceSession.owner_user_id`,
  这是"扇出记在发起人头上"成立的原因
