# ADR-0006: Phase 0b observability 与 Phase 0a 并行（Q6 镜像）

- **Status**: Accepted
- **Date**: 2026-05-18
- **Decider(s)**: 用户（项目负责人）
- **Tags**: `observability`, `phase`, `timeline`
- **Supersedes**: 无
- **Superseded by**: 无（具体实现框架由 ADR-0007 决定）

> **本 ADR 是迁移宪法 v1.2 §11 Q6 在 MUAP 仓内的镜像记录。**
> 上游：[`../../../openclaw/CLOSEOUT/migration-to-muap.md`](../../../openclaw/CLOSEOUT/migration-to-muap.md) v1.2 §6

---

## Context

V1 的可观测性极度薄弱（高度散乱的 print/log，几乎无结构化 trace），导致 V1 后期任何复杂调度问题都靠人工肉眼 grep。MUAP 不能继承这个状态；如果先做 Phase 0a（agent group 引导）再做 observability，Phase 0a 跑起来后任何问题都会丧失第一现场，调试成本巨大。

迁移宪法 v1.0 / v1.1 把 logging baseline 提为 Phase 0b，Q6 的拍板点是：是否将 Phase 0b 与 Phase 0a 并行。

## Options Considered

- **Option A — 并行（Phase 0a 与 Phase 0b 并跑）**：两个 phase 同时启动。优点：第一份 agent group 启动时即有 trace；调试成本最低。缺点：要求 phase 间协同、无 phase blocker。
- **Option B — 串行（Phase 0a 完成后再做 Phase 0b）**：优点：phase 边界清晰。缺点：Phase 0a 跑起来到加上 trace 之间的所有 bug 都难复盘；后期回填 instrumentation 成本高。
- **Option C — 推迟 observability 到 Phase 1+**：把 observability 当成"应用级"feature。缺点：违背 V1 教训，等于重蹈覆辙。

## Decision

> **拍板：Option A — Phase 0b 与 Phase 0a 并行**

理由：
- V1 教训：observability 后置 = 永远做不完
- Phoenix + OpenInference 的实施成本极低（v1.2 评估为 2.5 工程师日，见 ADR-0007）
- Phase 0.5 mock cluster 验收点（O01-O03）需要 observability 数据，并行能让 Phase 0.5 验收即时可做

## Consequences

- **Positive**：MUAP 自启动第一天起就有完整 trace；Phase 0.5 mock gate 的 O01-O03 验收无需等待；team 形成"先看 trace 再 grep log"习惯。
- **Negative**：Phase 0a / 0b 并行需要清晰任务分配（PR-A 至 PR-F vs PR-O1 至 PR-O7）；初期 PR review 压力增加。
- **Trade-offs**：接受短期协同复杂度，换取长期"第一现场不丢失"。

## Implementation Notes

- Phase 0b 实施清单：PR-O1 至 PR-O7（迁移宪法 v1.2 §"立即行动"）
- Phase 0b 总工时：2.5 工程师日（v1.2 修订后）
- 验收点：O01-O03（trace 树同根 / prompt 完整可读 / attribute 可过滤）— 这 3 项也是 Phase 0.5 mock gate 的子集
- 具体框架选型：见 ADR-0007

## References

- 迁移宪法 v1.2 §6 / §11 Q6 / §"立即行动"
- ADR-0002（立即启动）/ ADR-0007（Phoenix + Grafana）
- `../../../openclaw/CLOSEOUT/agent-observability-design.md` v1.0 FINAL
