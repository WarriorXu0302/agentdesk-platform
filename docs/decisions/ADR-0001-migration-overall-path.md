# ADR-0001: 整体迁移路径（Q1 镜像）

- **Status**: Accepted
- **Date**: 2026-05-18
- **Decider(s)**: 用户（项目负责人）+ coding agent（提案/执行）
- **Tags**: `migration`, `constitution`
- **Supersedes**: 无
- **Superseded by**: 无

> **本 ADR 是迁移宪法 v1.2 §11 评审决议留痕表中 Q1 在 MUAP 仓内的镜像记录。**
> 上游单一事实源：[`../../../openclaw/CLOSEOUT/migration-to-muap.md`](../../../openclaw/CLOSEOUT/migration-to-muap.md) v1.2。

---

## Context

V1（openclaw / "小环"）是一个长期演进的实验室硬件 harness 仓库，承载了大量**运行行为契约**（`HARNESS.md`、`DISPATCH.md`、`FACTS.md`、`IDENTITY.md`、`MEMORY.md`、`AGENTS.md`）以及散落的 Python 技能、prompt、记忆文件。

MUAP（FrontLane v2.x，本仓）是新一代多用户 Agent 平台，目标是把 V1 的**有效产物**（精炼后的 prompt、稳定可移植的 skill、对外契约）带入 MUAP，同时**不背 V1 的运行期内部状态包袱**。

迁移路径在 v1.0 决议版（2026-05-15）由用户拍板。

## Options Considered

- **Option A — 渐进式拆解 + 重新组装**：V1 prompt 精简后落到 `CLAUDE.local.md`；V1 Python 技能挂在 ERP gateway 后；V1 运行期内部文件（SOUL/USER/memory/）**不进 MUAP**。优点：单一事实源清晰、不污染 MUAP 仓、可分 phase 渐进。缺点：需要 phase 化路线图与 mock cluster 验收 gate（Q3 阻断）。
- **Option B — V1 整体复制 + 翻新**：把 V1 全套搬进 MUAP 再删减。优点：上手快。缺点：把 V1 运行期状态污染带入 MUAP，破坏"企业 baseline"定位；删减边界难界定。
- **Option C — 完全重写不参考 V1**：MUAP 自起炉灶，V1 仅留作参考。优点：最干净。缺点：丢失 V1 已验证的 prompt/skill 资产，工期不可控。

## Decision

> **拍板：Option A**

V1 → MUAP 走渐进式拆解路径：
1. V1 经过精炼的 prompt 进入 MUAP 的 `CLAUDE.local.md`
2. V1 Python 技能挂在 ERP gateway 后端，通过 `erp_execute` 工具暴露
3. V1 运行期内部文件（`SOUL.md` / `USER.md` / `memory/`）**不进 MUAP**，保留在 V1 仓内由 V1 自己消化

理由：
- 保持 MUAP 作为"企业 baseline"的定位干净
- ERP gateway 已经是 MUAP 既定的业务边界，把 V1 skill 挂在后面是契约自然延伸
- phase 化能配合 Q3 mock cluster 的阻断 gate，不让前期工作被后期 blocker 掀翻

## Consequences

- **Positive**：MUAP 仓不被 V1 内部状态污染；ERP gateway 成为唯一业务出口，强化身份信任链；V1 资产以契约化方式被复用。
- **Negative**：V1 → MUAP 之间需要**长期跨仓边界**（参见 `docs/migration-from-v1.md`）；新 coding agent 必须理解"不读 V1 内部文件"的约束。
- **Trade-offs**：选择渐进式而非重写，意味着接受 phase 0a / 0b / 0.5 的并行/阻断复杂度。

## Implementation Notes

- 跨仓导航入口：`docs/migration-from-v1.md`（本仓）+ `../../../openclaw/CLOSEOUT/README.md`（上游）
- V1 边界禁读清单（来自 V1 `AGENTS.md` 强约束）：`SOUL.md` / `USER.md` / `memory/YYYY-MM-DD*.md`
- Phase 0a 具体实施：`../../../openclaw/CLOSEOUT/phase0-implementation-pack/`
- 触达本仓的脚本入口：`scripts/init-enterprise-topology.ts`、`scripts/configure-enterprise-gateway.ts`

## References

- 迁移宪法 v1.2 §0 / §11
- `docs/migration-from-v1.md`
- ADR-0002（立即启动） / ADR-0003（部署拓扑） / ADR-0005（pydantic-ai）
