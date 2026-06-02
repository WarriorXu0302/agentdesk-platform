# ADR-0005: pydantic-ai 纳入主路线（Phase 5）（Q5 镜像）

- **Status**: Accepted
- **Date**: 2026-05-18
- **Decider(s)**: 用户（项目负责人）
- **Tags**: `provider`, `python`, `pydantic-ai`, `phase-5`
- **Supersedes**: 无
- **Superseded by**: 无

> **本 ADR 是迁移宪法 v1.2 §11 Q5 在 MUAP 仓内的镜像记录。**
> 上游：[`../../../openclaw/CLOSEOUT/migration-to-muap.md`](../../../openclaw/CLOSEOUT/migration-to-muap.md) v1.2

---

## Context

当前 MUAP container-side provider 列表是 `claude / openai / mock`（见 `container/agent-runner/src/providers/`）。V1 部分 Python 技能与未来期望的多 LLM 编排（含本地 / 私有部署）需要更结构化的 agent 框架。

`pydantic-ai` 是 Python 端类型安全的 LLM agent 框架，能同时承接：
- V1 残留 Python 技能的承载层（在 ERP gateway 后端）
- MUAP 未来的多 LLM 编排（Phase 5 演进）
- 与已选 Phoenix observability 后端原生集成（OpenInference instrumentation 现成）

## Options Considered

- **Option A — 纳入主路线，Phase 5 引入**：在 ERP gateway 后端 / future Phase 5 引入 pydantic-ai。优点：与 Phoenix 原生集成；类型安全；Python 生态完整。缺点：增加一个非 TS 的依赖类别。
- **Option B — 不引入，全 TS 实现**：所有 agent 编排留在 TS。优点：单语言栈。缺点：Python 技能必须重写；Phoenix 集成需要自己实现 instrumentation。
- **Option C — 当作可选 provider，不进主路线**：仅当用户主动选择时引入。优点：保持灵活。缺点：在路线图上没有位置，团队会逐步遗忘。

## Decision

> **拍板：Option A — 纳入主路线，Phase 5 演进**

理由：
- Phoenix 已选定为唯一 observability 后端（见 ADR-0007），pydantic-ai 与 OpenInference 的原生集成显著降低 instrumentation 成本
- V1 Python 技能挂在 ERP gateway 后是 ADR-0001 已定的路径，pydantic-ai 是承载它们的自然选择
- Phase 5 是路线图既定演进点，提前在主路线占位避免"事到临头才发现没规划"

## Consequences

- **Positive**：Python 技能有规范承载层；Phoenix instrumentation 几乎零成本；类型安全（pydantic 模型）能减少 runtime 错误。
- **Negative**：MUAP 团队需要维护一个非 TS 的依赖栈（Python + pydantic-ai）；CI 工具链复杂度上升。
- **Trade-offs**：接受多语言栈复杂度，换取 V1 Python 资产复用 + Phoenix 原生集成。

## Implementation Notes

- 不在 Phase 0a / 0b / 0.5 阶段引入；Phase 5 启动时再做架构落地
- ERP gateway 后端目前是黑盒（由用户的 ERP 实现），pydantic-ai 落在 ERP 后还是 MUAP 内部需在 Phase 5 启动前再决议（届时另写 ADR）
- 与 ADR-0007 联动：Phoenix + OpenInference 是默认 instrumentation 栈

## References

- 迁移宪法 v1.2 §11 Q5 / §6 路线图 Phase 5
- ADR-0001（V1 Python 技能挂在 ERP 后）
- ADR-0007（Phoenix observability）
