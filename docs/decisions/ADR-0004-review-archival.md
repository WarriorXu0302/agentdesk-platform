# ADR-0004: 评审归档落盘 `migration-to-muap.md`（Q4 镜像）

- **Status**: Accepted
- **Date**: 2026-05-18
- **Decider(s)**: 用户（项目负责人）
- **Tags**: `process`, `documentation`, `archival`
- **Supersedes**: 无
- **Superseded by**: 无

> **本 ADR 是迁移宪法 v1.2 §11 Q4 在 MUAP 仓内的镜像记录。**
> 上游：[`../../../openclaw/CLOSEOUT/migration-to-muap.md`](../../../openclaw/CLOSEOUT/migration-to-muap.md) v1.2

---

## Context

迁移评审过程产生了 Q1-Q7 决议、Gap matrix（G1-G23）、风险登记（R1-R16）、PR 清单（PR-A 至 PR-F + PR-O1 至 PR-O7）等大量结构化决议。这些决议需要一个**单一事实源**承载，避免：
- 散落到 issue/Slack/Notion 导致 reverse-engineering 成本极高
- 跨仓多份复制导致升版漂移
- 新 coding agent 接手时找不到"为什么是这样"

## Options Considered

- **Option A — 全部落盘到 `openclaw/CLOSEOUT/migration-to-muap.md`**，MUAP 仓只放跨仓指针。优点：单一事实源、版本号可追、跨仓导航清晰。缺点：MUAP coding agent 必须能访问 `../openclaw/` 兄弟仓。
- **Option B — 双仓各放一份**：openclaw 与 MUAP 各维护一份完整副本。优点：MUAP 仓自包含。缺点：两边升版必然漂移；维护成本翻倍。
- **Option C — 放到外部 Notion / Confluence**：优点：脱离代码仓。缺点：与代码失去版本绑定；新 agent 不易发现。

## Decision

> **拍板：Option A — 落盘到 `openclaw/CLOSEOUT/migration-to-muap.md`**

理由：
- 单一事实源原则：所有 Q1-Q7 / Gap / Risk / PR 计划只在 `migration-to-muap.md` 内升版
- MUAP 仓通过 `docs/migration-from-v1.md` 单向指针引用
- 升版只需改一个文件，cross-repo 自动失效保护（指针文件会显式声明版本号）

## Consequences

- **Positive**：所有迁移级决策可在一个 markdown 内完整看完；版本演进（v1.0 → v1.1 → v1.2）有清晰 changelog；不会发生"两份文档说法不一致"。
- **Negative**：MUAP 仓在不挂载 `../openclaw/` 时会失去迁移上下文；接手 agent 必须先确认姊妹仓可达。
- **Trade-offs**：接受跨仓依赖，换取单一事实源。

## Implementation Notes

- 升级流程：在 `openclaw/CLOSEOUT/migration-to-muap.md` 内升版（v1.x），同时更新 MUAP 仓 `docs/migration-from-v1.md` 的「迁移宪法」行版本号
- HTML 阅读版（v1.2）：`openclaw/CLOSEOUT/migration-to-muap.html`（93,281 B / 1,854 行 / 0 外链）
- 归档前期撤回的版本到 `openclaw/CLOSEOUT/archive/`（例如 `distributed-logging-design.md` v0.1）
- 入口 README：`openclaw/CLOSEOUT/README.md`（MUAP-audience 导航）

## References

- 迁移宪法 v1.2 §11 Q4 / §"附录 — 关联产物"
- `openclaw/CLOSEOUT/README.md`
- `docs/migration-from-v1.md`（本仓指针）
