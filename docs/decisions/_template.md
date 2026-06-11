# ADR-NNNN: <短标题，祈使句或名词短语>

- **Status**: Proposed | Accepted | Superseded by ADR-XXXX | Deprecated | Reverted
- **Date**: YYYY-MM-DD
- **Decider(s)**: <用户姓名 / 角色>，coding agent 的角色（提案/执行/审计）
- **Tags**: `<area-1>`, `<area-2>`（例如 `observability`, `topology`, `erp-gateway`, `migration`）
- **Supersedes**: ADR-XXXX（若有）
- **Superseded by**: ADR-XXXX（若有）

---

## Context

简述决策发生时的背景、约束、待解决问题。回答"为什么需要这个决策"。

避免：
- 把整个项目背景重复一遍
- 用模糊词（"提升体验"、"优化架构"）

写明：
- 触发该决策的具体事件、issue、或前一份 ADR
- 列出当时 known constraints（已知约束），例如时间窗口、依赖、上游契约

## Options Considered

至少列 2 个选项（包含被驳回的方案）。每项给出 1-3 行客观对比，不要过早倾向。

- **Option A**: <名称>。优点 / 缺点 / 工作量预估。
- **Option B**: <名称>。优点 / 缺点 / 工作量预估。
- **Option C**: <名称>。优点 / 缺点 / 工作量预估。

如果某选项完全不可行，注明原因（外部约束、合规、技术 blocker）。

## Decision

> **拍板**：选 Option X。

简明陈述选择 + 1-3 条核心理由。理由必须可验证（可被未来反驳）。

## Consequences

- **Positive**: 此决策带来什么收益、解锁哪些后续工作。
- **Negative**: 引入了什么债务 / 风险 / 局限。
- **Neutral / Trade-offs**: 哪些维度做了让步、哪些假设若被推翻则需要重审本 ADR。

## Implementation Notes

- 落地相关文件路径：`src/...`, `docs/...`, `scripts/...`
- 依赖的上游 ADR
- 后续验收点（例如 PR 编号、测试用例、metrics 名）

## References

- 关联 issue / PR / 讨论记录 / Phoenix trace
- 相关设计文档
- 相关 commit hash
