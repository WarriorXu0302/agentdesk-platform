# ADR-0007: Observability 框架 — 纯 Arize Phoenix（ELv2）+ Grafana 综合面板（Q7 镜像）

- **Status**: Accepted
- **Date**: 2026-05-18
- **Decider(s)**: 用户（项目负责人）
- **Tags**: `observability`, `framework`, `phoenix`, `grafana`, `constitution`
- **Supersedes**: 撤回 v0.1 通用 LGTM 栈（Pino+structlog+Alloy+LGTM），归档于 `../../../openclaw/CLOSEOUT/archive/distributed-logging-design.md`
- **Superseded by**: 无

> **本 ADR 是迁移宪法 v1.2 §11 Q7 在 MUAP 仓内的镜像记录，是 MUAP observability 的最终决议。**
> 上游：[`../../../openclaw/CLOSEOUT/migration-to-muap.md`](../../../openclaw/CLOSEOUT/migration-to-muap.md) v1.2 §0 + §11
> 详细设计：[`../../../openclaw/CLOSEOUT/agent-observability-design.md`](../../../openclaw/CLOSEOUT/agent-observability-design.md) v1.0 FINAL

---

## Context

Q6（ADR-0006）拍板 Phase 0b 与 Phase 0a 并行后，剩下的是框架选型：MUAP 的 LLM agent observability 用什么后端？

v1.0 / v1.1 阶段一度选用通用 LGTM 栈（Pino + structlog + Alloy + Loki/Grafana/Tempo/Mimir），但用户在评审阶段指出三个核心问题：
1. **LLM-specific 维度缺失**：prompt 完整可读、token 用量、tool call 入参出参的展开、retry 链——通用日志栈做不到一等公民支持
2. **工程量过大**：14 工程师日的初始落地与 LGTM 栈本身的运维负担不成比例
3. **prompt 可视化是核心需求**：必须能在 UI 上直接看完整 prompt 树，而不是从 log 拼凑

v1.2 撤回 v0.1 LGTM 方案，进入 Q7 框架重选。

## Options Considered

- **方案 A — 纯 Arize Phoenix（OSS, ELv2 license）+ Grafana 综合面板**：
  - Phoenix 作为 LLM trace 后端，原生支持 prompt 树展开、token 计数、tool call 展示、retry 链
  - OpenInference instrumentation 库覆盖 pydantic-ai / TypeScript SDK / OpenAI / Anthropic 等
  - Grafana 用于 Phoenix 原生面板之外的综合数据（系统指标、业务 KPI）
  - **工时：2.5 工程师日**
- **方案 B — Phoenix + Logfire 双栈**：Phoenix 做 LLM trace，Logfire 做应用日志。优点：分层清晰。缺点：双栈耦合层维护成本；账号/计费/数据合规复杂度翻倍。
- **方案 C — 仅用 Langfuse**：开源 self-host LLM observability。优点：focus on LLM。缺点：与 OpenInference 生态集成度不如 Phoenix；Grafana 集成需自行造轮子。
- **方案 D — 自建轻量 trace（DIY）**：自己写 instrumentation + SQLite 后端。优点：零外部依赖。缺点：永远做不完，等于 V1 教训重演。
- **方案 v0.1 撤回 — 通用 LGTM 栈**：Pino + structlog + Alloy + LGTM。已在 v1.2 撤回，归档至 `archive/`。

## Decision

> **拍板：方案 A — 纯 Arize Phoenix（OSS, ELv2）+ Grafana 综合面板**

强约束（constitution 级，未经用户批准不得变更）：
- **不引入 Logfire 耦合层**（撤回方案 B）
- **不引入 Langfuse**（撤回方案 C）
- **不做 DIY logging**（撤回方案 D）
- **撤回的 v0.1 LGTM 方案不得复活**

理由：
1. Phoenix 是当前 LLM observability 生态里唯一同时具备 [OSS 自托管 + 原生 prompt 可视化 + OpenInference 全语言覆盖 + ELv2 商业可用 license] 四项的开源后端
2. OpenInference instrumentation 现成支持 pydantic-ai（见 ADR-0005）与 TS SDK，零成本接入
3. 工时从 14 工程师日缩到 2.5 工程师日，是 Phase 0b 能与 Phase 0a 并行的关键
4. Grafana 不被 Phoenix 替代——它继续承担"系统指标 + 业务 KPI"的综合面板角色

## Consequences

- **Positive**：
  - Phase 0b 总工时 2.5 工程师日，可并行于 Phase 0a
  - prompt 完整可读、token 用量、tool call、retry 链全部一等公民
  - Phase 0.5 mock gate 的 O01-O03 验收（trace 树同根 / prompt 完整可读 / attribute 可过滤）有现成 UI 支撑
  - 总工期 13-15 周收敛到 11-13 周
- **Negative**：
  - 引入两个新风险：R15（Phoenix OOM）+ R16（PII 上链）— 必须在 Phase 0b 实施时落地缓解措施
  - 增加一个外部服务运维点（Phoenix 容器）
  - ELv2 license 在某些极度严格的商业场景下需用户法务确认
- **Trade-offs**：接受 Phoenix 单点依赖，换取 LLM-specific 一等公民支持与 zero-instrument 接入成本。

## Implementation Notes

- **部署形态**：
  - Sim 模式：单容器 Phoenix（开发机/CI 内）
  - Prod 模式：三容器 Phoenix（HA / 数据隔离 / read-replica）
- **PR 实施清单**：PR-O1 至 PR-O7（迁移宪法 v1.2 §"立即行动"）
- **Gap matrix G18**：从原 14 工程师日（v1.1 LGTM 栈）缩至 2.5 工程师日（v1.2 Phoenix）
- **风险登记新增**：
  - R15 — Phoenix OOM（buffer / sampling / retention 策略）
  - R16 — PII 上链（attribute redaction / sampling exclusion）
- **关联产物**：
  - `../../../openclaw/CLOSEOUT/agent-observability-design.md` v1.0 FINAL（详细设计）
  - `../../../openclaw/CLOSEOUT/agent-observability-design.html` v1.0（HTML 阅读版，含 4 块 mock UI，65,966 B）
  - 撤回归档：`../../../openclaw/CLOSEOUT/archive/distributed-logging-design.{md,html}`
  - 撤回归档：`../../../openclaw/CLOSEOUT/archive/agent-observability-design-v0.3.html`（基于错误前提的旧草案）

## References

- 迁移宪法 v1.2 §0 / §6 / §11 Q7 / §"立即行动"
- `../../../openclaw/CLOSEOUT/agent-observability-design.md` v1.0 FINAL
- ADR-0005（pydantic-ai 与 Phoenix OpenInference 原生集成）
- ADR-0006（Phase 0b 与 Phase 0a 并行）
- CLAUDE.md §"Constitution-level rules"（Phoenix 是唯一 sanctioned observability backend）
