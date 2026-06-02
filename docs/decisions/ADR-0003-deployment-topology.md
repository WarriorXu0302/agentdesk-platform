# ADR-0003: 部署拓扑 — C-Optimized 混合双套（Q3 镜像）

- **Status**: Accepted
- **Date**: 2026-05-18
- **Decider(s)**: 用户（项目负责人）+ 架构师
- **Tags**: `topology`, `deployment`, `simulation`, `hardware`
- **Supersedes**: 无
- **Superseded by**: 无

> **本 ADR 是迁移宪法 v1.2 §11 Q3 在 MUAP 仓内的镜像记录。**
> 上游：[`../../../openclaw/CLOSEOUT/migration-to-muap.md`](../../../openclaw/CLOSEOUT/migration-to-muap.md) v1.2 §0 + §6
> 关联专项设计：[`../../../openclaw/CLOSEOUT/v1-mock-simulation-replication-plan.md`](../../../openclaw/CLOSEOUT/v1-mock-simulation-replication-plan.md)

---

## Context

V1 的硬件 harness 是实验室设备（局域网内可达），但 V1 仓**完全没有可移植的 mock / sim / pytest 基础设施**（仅 2 个 dry-run flag + 2 个 demo skill）。MUAP 要做到本地可开发 + 远端可生产，必须解决两件事：
1. 模拟态：开发机本地能跑全套 agent + 假硬件
2. 真实态：生产部署能接到 lab LAN 的真实硬件

Q3 的争议在于：硬件服务部署位置——lab 局域网、MUAP 同主机、还是混合？

## Options Considered

- **Option A — 全部 lab LAN**：硬件服务只在实验室局域网内运行。优点：环境一致。缺点：本地无法独立开发；CI/CD 无法在云上跑。
- **Option B — 全部 MUAP 同主机**：所有硬件都用 mock 跑在 MUAP 主机上。优点：开发简单。缺点：失去与真实硬件的对接，无法做生产。
- **Option C — 混合双套（原始）**：开发用 sim，生产用 lab LAN，两套并存。优点：覆盖全场景。缺点：sim 套与 prod 套配置容易漂移。
- **Option C-Optimized — 混合双套 + Q3 专项阻断 gate**：在 Option C 基础上，引入 Phase 0.5 mock cluster 验收 gate（9 项验收 + 6 周路线图），不通过 gate 不开 Phase 2B。优点：sim 与 prod 配置一致性有强制保证；硬件服务化前必先有 mock。缺点：增加 2 周前置工期。

## Decision

> **拍板：Option C-Optimized — 混合双套 + Q3 专项阻断 gate**

部署形态：
- **Simulation 模式**：`RUNTIME_MODE=simulation`，agent + mock 硬件全部跑在 MUAP 同主机（含 CI）
- **Production 模式**：`RUNTIME_MODE=production`，agent 跑在 MUAP 主机，硬件服务在 lab LAN 内
- **Q3 阻断 gate**：Phase 0.5（week 2-4）必须通过 mock cluster 9 项验收，否则 Phase 2B（硬件服务化）不开

理由：
- 兼顾开发可独立、生产可对接真实硬件
- mock gate 把"V1 整库零 pytest"这个高风险缺口前置暴露
- sim 与 prod 共用同一组 contract，避免两套漂移

## Consequences

- **Positive**：本地开发体验良好；CI 可全自动；生产具备真实硬件入口；mock gate 把硬件移植风险前置。
- **Negative**：前期需要 2 周专门建 mock cluster；sim 边界需要严格守护（不允许 sim 模式下调用真实硬件 API）。
- **Trade-offs**：增加 phase 0.5 阻断 gate，换取长期 sim/prod 一致性。

## Implementation Notes

- `RUNTIME_MODE` 环境变量：`simulation` 或 `production`
- Sim 边界规则：sim 模式下涉及硬件/API/MQTT 的真实操作**必须经用户确认**（见 `docs/migration-from-v1.md` §"维护规则"）
- Phase 0.5 mock cluster 9 项验收：见 `v1-mock-simulation-replication-plan.md`
- O01-O03 observability 验收点与 Phase 0b 联动（trace 树同根 / prompt 完整可读 / attribute 可过滤）

## References

- 迁移宪法 v1.2 §0 / §6 / §11 Q3
- `v1-mock-simulation-replication-plan.md`（411 行 + 9 验收 gate）
- ADR-0006 / ADR-0007（observability 与 mock gate 联动）
