# ADR-0041: 压缩摘要落库 conversation.summary（cost-neutral，OpenAI-only，Claude 暂不支持）

- **Status**: Accepted
- **Date**: 2026-06-14
- **Decider(s)**: 用户（平台 owner，提案 + 验收）；coding agent（设计 + 执行）
- **Tags**: `memory`, `gateway`, `compaction`, `container-runtime`, `provider-asymmetry`, `backward-compat`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

业务侧 review（`docs/business-optimization-roadmap.md` 4.1，价值 **高**）+ ADR-0033 都指出:
上下文压缩已实现(ADR-0024/0033),poll-loop 正确处理 `compacted` 事件并注入路由提醒,但
**不把压缩摘要落库**。长对话压缩后上下文蒸发,agent 无法回忆上轮决策/事实,打破"agent 记得"
的心智模型。ADR-0033 明确把这一步 defer 成**独立批次**("压缩前 memory-flush 自动写
conversation.summary…它在 poll-loop、与上下文压缩交互,风险面与本批正交")。

本 ADR 经 design+对抗评审 workflow 设计,核实出一个**关键的 provider 非对称性**:

- `compacted` 事件的 `text` 只是**状态串**("Context compacted (50k→… chars)"),**不是摘要**。
- **OpenAI**:压缩时内部确实生成了摘要(`summarizeOldWindow` → `compactedSummaryMessage`,
  openai.ts),但从未暴露给 poll-loop。
- **Claude**:Agent SDK **内部**自动压缩,只通过 `compact_boundary` 暴露 `pre_tokens`,
  **完全没有摘要文本**。要给 Claude 落摘要,只能**额外跑一次模型调用**。

已知约束(load-bearing 不变量):记忆只走后端网关(无 host 索引/平行路径);flush 是一次
`gateway_memory_upsert`,必须骑 host 签名代理(ADR-0034,WRITE_PATHS 已含 `/memory/upsert`);
**绝不阻塞**消息投递/当前 turn;后端无 `/memory/upsert` 或 memoryMode!=gateway 时优雅降级。

## Options Considered

- **Option A — cost-neutral best-effort**:只用各 provider **已经产出**的摘要。OpenAI 把内部
  `summary` 透出到 `compacted` 事件,poll-loop fire-and-forget 落库;Claude 无摘要 → flush 是
  no-op(**不伪造摘要、不额外调用模型**)。优点:零额外 token/延迟成本、不变量全保、最小事件契约
  变更。缺点:Claude 暂不覆盖(诚实记为已知 gap)。
- **Option B — 显式摘要调用**:压缩时额外跑一次模型生成摘要,两 provider 对称。缺点:对抗评审
  发现**结构性问题**——(1) Claude 的 PreCompact transcript 在 `compacted` 事件发出时已不可访问
  (PreCompact hook 与事件发射是不同代码路径,需新建状态通道桥接,非平凡);(2) detached 摘要调用与
  **仍在飞的当前 turn** 争抢同一 rate-limit,可经 backpressure 拖慢真实 turn;(3) 对称接口
  **掩盖**了 Claude 侧的非对称复杂度与真实 API 成本。ADR-0033 正是因这些交互把 Claude flush defer。

## Decision

> **拍板**:选 **Option A(cost-neutral)**,带两条强制修正。Claude **暂不支持**(显式记 gap,
> 不伪造摘要、不额外调模型);Option B **驳回**(PreCompact transcript 不可达 + rate-limit 争抢)。

两条强制修正(对抗评审):

1. **身份快照**:flush 是 detached 的,poll-loop 的 per-turn `finally` 可能在 flush 的 async body
   执行前就 `clearRequestIdentity()`。所以在 `compacted` handler 里**同步快照** `getRequestIdentity()`
   并把值传进 `flushCompactionSummary`——helper **不**自己调 `getRequestIdentity()`/`resolveRequester()`。
   (`_current` 是模块级 ref,`clearRequestIdentity` 置 null 不改对象,故快照引用安全。)
2. **value 子键**:写 `value={ autoSummary: summary }`(**非**扁平 value)+ `merge:true`,否则会
   **覆盖** agent 在同 namespace 写的事实/决策。

## Consequences

- **Positive**:
  - OpenAI 长会话压缩后,关键上下文落入 `conversation.summary`,agent 可经 `gateway_memory_search`
    回忆——零额外模型成本(复用压缩本就花的摘要)。
  - 不变量全保:走既有 `/memory/upsert` 签名代理 WRITE_PATH(无新路径、无 host 改动);
    fire-and-forget 绝不阻塞 turn;最小事件契约变更(`compacted` 加可选 `summary?: string`)。
  - 优雅降级:no event.summary(Claude / OpenAI 硬裁剪兜底)/ memoryMode!=gateway / 后端 404 →
    静默 no-op,绝不抛、绝不打断事件循环(`getConfig()` 折进 promise 链,其 throw 也被 catch)。
- **Negative / 已知 gap**:
  - **Claude 暂不落摘要**(SDK 不暴露摘要文本)。claude.ts 加注说明;未来若 SDK 暴露或决定接受额外
    调用成本,再开后续 ADR。
  - **OpenAI 硬裁剪边界无摘要**:`runCompaction` 返回 undefined(summarize 失败 / 仍超 MAX_REPLAY)
    时不发 compacted 事件,长会话仍会丢上下文且无可召回摘要。v1 接受,记录在此。
- **Neutral / Trade-offs**:
  - **无 idempotencyKey**:容器在代理 finalize-audit 窗口重启会重放 flush;`merge:true` + 同摘要
    幂等,不同压缩边界的摘要会静默覆盖。blast radius 低,待后端要求再加。
  - `value.autoSummary` 子键依赖后端把 value 当 partial patch merge;若后端是整体替换,需后端确认
    (kickstart/契约文档已建议 merge 语义)。

## Implementation Notes

- 落地文件(纯 container 侧,无 host 改动):
  - `container/agent-runner/src/providers/types.ts` — `compacted` 事件加可选 `summary?: string`。
  - `container/agent-runner/src/providers/openai.ts` — `runCompaction` 返回 `summary`;`runTurn` 的
    `compacted` 透出 `summary`;yield 带上。
  - `container/agent-runner/src/providers/claude.ts` — `compact_boundary` 处加注:SDK 无摘要,
    故无 `summary` 字段,flush 对 Claude 是 no-op。
  - `container/agent-runner/src/mcp-tools/gateway.ts` — 新增导出 `flushCompactionSummary(summary,
    identity, config)`:memoryMode/userId/空串三道 gate;直接构造 body(绕过 resolveRequester,用快照
    identity)走 `callGateway('/memory/upsert', …)`;`value.autoSummary` + merge:true;best-effort,
    失败只记日志。
  - `container/agent-runner/src/poll-loop.ts` — `compacted` handler:同步快照 identity,
    `void Promise.resolve().then(() => flushCompactionSummary(…, getConfig())).catch(log)`
    (getConfig 折进链,throw 变可捕获的 rejection,绝不打断事件循环)。
- 测试:`gateway.test.ts`(flush 6 例:happy/memoryMode gate/无 user/空串/404 优雅/快照身份);
  `openai.test.ts`(compacted 事件带 summary);`integration.test.ts`(CompactingProvider 带 summary
  → 真实 loop 中 flush 分支执行、getConfig throw 被吞、reminder 仍发)。
- 依赖的上游 ADR:ADR-0033(本 ADR 落地其 defer 的批次)、ADR-0034(签名代理 WRITE_PATH)、
  ADR-0024(压缩)。
- 后续验收点:container tsc + 全套 bun 测试绿(282+)。

## References

- 关联审计:`docs/business-optimization-roadmap.md` 4.1
- 上游 ADR:`ADR-0033-memory-search-retrieval.md`(line 88-89 deferral)、`ADR-0034`、`ADR-0024`
- 设计 + 对抗评审 workflow:design-summary-flush(2 map → cost-neutral vs summarize-call → 安全合成,
  合成 ship cost-neutral + 驳回 summarize-call)
- load-bearing 不变量:`CLAUDE.md`("记忆只走网关")
