# ADR-0002: 立即启动迁移（Q2 镜像）

- **Status**: Accepted
- **Date**: 2026-05-18
- **Decider(s)**: 用户（项目负责人）
- **Tags**: `migration`, `timeline`
- **Supersedes**: 无
- **Superseded by**: 无

> **本 ADR 是迁移宪法 v1.2 §11 Q2 在 MUAP 仓内的镜像记录。**
> 上游：[`../../../openclaw/CLOSEOUT/migration-to-muap.md`](../../../openclaw/CLOSEOUT/migration-to-muap.md) v1.2。

---

## Context

ADR-0001 拍板 Option A 渐进式迁移路径后，剩下的问题是启动时机：是立即启动 Phase 0a，还是等 V1 当前迭代收尾后再启动。

V1 的硬件 harness 当前仍处可演进状态；如果等 V1 完全收口再启动 MUAP 迁移，时间窗口不可估计，且 V1 状态会继续漂移，迁移成本越拖越大。

## Options Considered

- **Option A — 立即启动**：Phase 0a 立即开干，并行执行 Phase 0b（observability）和 Phase 0.5（mock cluster gate）。优点：避免 V1 状态继续漂移；窗口可控；MUAP 团队对 V1 的记忆度仍高。缺点：需要 phase 间严格协同。
- **Option B — V1 收口后启动**：等 V1 当前里程碑闭环再迁。优点：V1 状态可参考性最强。缺点：V1 收口时间不确定；MUAP 迁移工期不可估算；记忆度衰减。
- **Option C — 部分启动**：只启动 phase 0a，phase 0b/0.5 延后。优点：节省并行复杂度。缺点：Q3 mock cluster 是 phase 2B 阻断 gate，不前置就会让后期硬件移植硬卡。

## Decision

> **拍板：Option A — 立即启动**

理由：
- V1 状态漂移成本随时间线性增长
- Phase 0b（observability）+ Phase 0.5（mock）必须前置，越早开始越早解锁后续 phase
- 项目负责人已具备 phase 化协同的执行能力

## Consequences

- **Positive**：迁移窗口可控（v1.2 总工期 11-13 周）；Phase 0a/0b 并行节省约 1-2 周；mock gate 提前曝光风险。
- **Negative**：要求 MUAP coding agent 与 V1 状态做并行隔离（不污染 V1，不被 V1 污染）；需要持续维护跨仓导航与边界。
- **Trade-offs**：接受短期并行复杂度，换取长期窗口可控。

## Implementation Notes

- 立即启动后第一批 PR：见迁移宪法 v1.2 §"立即行动" PR-A 至 PR-F，以及 §6 路线图 Phase 0a/0b 子任务
- 触达本仓的入口脚本仍是 `scripts/init-enterprise-topology.ts`
- Phase 0b observability 实施细节：见 ADR-0006、ADR-0007

## References

- 迁移宪法 v1.2 §11 Q2
- ADR-0001 / ADR-0006
