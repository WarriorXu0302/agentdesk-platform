# Audit Records

> 本目录用于沉淀**审计型记录**：安全审计、合规复核、第三方评估、内部健康度盘点等"回看 + 评估"型产出。

## 与 `docs/decisions/`（ADR）的边界

| 维度 | `docs/decisions/`（ADR） | `docs/audit/`（本目录） |
|---|---|---|
| 时态 | 前瞻 | 回看 |
| 目的 | 拍板、规定未来做什么 | 评估、记录历史状态 |
| 触发 | 设计选择 / 契约变更 | 安全/合规检查、定期复核、第三方评估 |
| 命名 | `ADR-NNNN-<title>.md` | `audit-YYYY-MM-DD-<scope>.md` 或 `<area>-audit-vN.md` |

简单判断：
- "我准备这样做"→ ADR
- "我们当前是这样的"→ audit

## 何时往这里写

- 安全 / 合规第三方评估的结论摘要
- 定期内部健康度盘点（例如 dev-harness 审查、迁移就绪度评估、文档系统盘点）
- 对 ADR 已落地状态的事后审计（验证某 ADR 是否被实施且未漂移）

## 何时**不**写在这里

- 设计选择与拍板：写 ADR
- 实现细节文档：放 `docs/<area>.md`
- TODO / Roadmap：放对应 plan / roadmap 文档（待建）
- coding agent 的会话工作痕迹：留在 `.sisyphus/`（advisory）

## 命名约定（建议）

- 时间点型审计：`audit-YYYY-MM-DD-<scope>.md`
  - 例：`audit-2026-05-18-dev-harness.md`
- 领域型重复审计：`<area>-audit-vN.md`
  - 例：`security-audit-v1.md`, `migration-readiness-audit-v2.md`

## 当前状态

本目录目前为空。第一份正式 audit 产物预计在 Phase 0a/0b 启动后由用户指派写入。
