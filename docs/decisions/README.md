# Architecture Decision Records (ADR)

> 本目录是 MUAP 仓的**架构决策档案**。每一份 ADR 记录一个值得后人知道"为什么"的决定。
> 失去"为什么"，下一个 coding agent 就只能从代码里反向猜测，而代码本身从不解释自己。

---

## 为什么需要 ADR

V1（openclaw）时代很多关键决策只口头讨论或散落在 issue / Slack / Notion，导致：
- 接手者看不懂某些"看似多余"的代码为什么这样写
- 新 agent 容易"善意地"还原一个早已被否决的方案
- 宪法级决议（迁移 Q1-Q7）与实现细节没有清晰边界

ADR 是低成本的反熵机制：5 分钟落一份，下一个 agent 节省数小时。

---

## 何时必须写 ADR

下面任一情形发生，必须在同次 PR 内提交 ADR：

1. **改动公共契约**：DB schema、ERP gateway 接口、channel adapter 形状、container ↔ host 协议
2. **在 2 个以上可行方案中做出选择**（即使最后选了"看起来显然"的那个）
3. **引入新的依赖类别**：新的 LLM provider、新的 observability 后端、新的 storage、新的 sidecar
4. **否决 / 撤销 一个先前的 ADR**（写新 ADR + 把旧 ADR 标记为 Superseded）
5. **改动迁移宪法（v1.x）已锁定项**——这种情况须先经用户确认，再写 ADR

何时**不必**写 ADR：
- 重命名局部变量、修 typo、补单元测试、debug 一个不改契约的 bug
- 已有 ADR 完全覆盖的实现细节

---

## 命名与格式约定

- 文件名：`ADR-NNNN-kebab-case-title.md`，N 为 4 位顺序号
- 顺序号**单调递增、不复用**（即使某份 ADR 被 Supersede，编号仍保留）
- 模板：`_template.md`
- 状态字段限定值：`Proposed | Accepted | Superseded by ADR-XXXX | Deprecated | Reverted`

## ADR 与迁移宪法的关系

- **迁移宪法**（`../../../openclaw/CLOSEOUT/migration-to-muap.md` v1.2）是**项目顶层契约**：phase 顺序、scope、timeline、Q1-Q7 决议
- **ADR**：宪法在 MUAP 仓内的**落地决策**与**追加决议**
- ADR-0001 ~ ADR-0007 是 Q1-Q7 在本仓的镜像，便于本仓内导航；宪法升版时这些 ADR 也需要同步引用

## 与 `docs/audit/` 的关系

- `docs/audit/` 用于记录**审计型记录**（例如安全审计、合规复核、第三方评估的结论）
- `docs/decisions/`（本目录）用于记录**主动设计决策**
- 二者不重叠：审计是回看 + 评估，决策是前瞻 + 拍板

---

## ADR 索引

| ADR | 标题 | 状态 | 日期 | 标签 |
|---|---|---|---|---|
| [ADR-0001](ADR-0001-migration-overall-path.md) | 整体迁移路径（Q1 镜像） | Accepted | 2026-05-18 | `migration`, `constitution` |
| [ADR-0002](ADR-0002-immediate-kickoff.md) | 立即启动迁移（Q2 镜像） | Accepted | 2026-05-18 | `migration`, `timeline` |
| [ADR-0003](ADR-0003-deployment-topology.md) | 部署拓扑：C-Optimized 混合双套（Q3 镜像） | Accepted | 2026-05-18 | `topology`, `deployment` |
| [ADR-0004](ADR-0004-review-archival.md) | 评审归档落盘 `migration-to-muap.md`（Q4 镜像） | Accepted | 2026-05-18 | `process`, `documentation` |
| [ADR-0005](ADR-0005-pydantic-ai-main-path.md) | pydantic-ai 纳入主路线（Phase 5）（Q5 镜像） | Accepted | 2026-05-18 | `provider`, `python` |
| [ADR-0006](ADR-0006-phase0b-parallel-observability.md) | Phase 0b observability 与 Phase 0a 并行（Q6 镜像） | Accepted | 2026-05-18 | `observability`, `phase` |
| [ADR-0007](ADR-0007-observability-phoenix-grafana.md) | Observability 框架：纯 Phoenix (ELv2) + Grafana（Q7 镜像） | Accepted | 2026-05-18 | `observability`, `framework` |
| [ADR-0008](ADR-0008-phase0a-lab-frontdesk-onboarding.md) | Phase 0a `frontlane-lab-frontdesk` 落地策略（FRONTDESKS[] + .env.local.proposed + opt-in autowire） | Accepted | 2026-05-19 | `migration`, `phase-0a`, `topology`, `enterprise`, `env-management` |
| [ADR-0009](ADR-0009-observability-bootstrap-contract.md) | Phase 0b / PR-O1 Observability Bootstrap Contract（Phoenix + Grafana compose + read-only datasource + 端口/镜像 pin + env 协同 + 守门测试） | Accepted | 2026-05-20 | `observability`, `phase0b`, `infra`, `migration` |
| [ADR-0010](ADR-0010-rename-default-frontdesk-to-template.md) | Rename `frontlane-frontdesk` → `frontlane-template-frontdesk`（命名歧义修复 + LEGACY fallback） | Accepted | 2026-05-20 | `naming`, `refactor`, `frontdesk` |
| [ADR-0011](ADR-0011-host-otel-instrumentation.md) | Host OpenTelemetry Instrumentation（PR-O2：OTel SDK bootstrap + manual span + context bridge + trace-log 关联） | Accepted | 2026-05-29 | `observability`, `phase0b`, `tracing`, `host-runtime` |
| [ADR-0014](ADR-0014-observability-span-schema.md) | Observability Span Naming Schema v1.0（hierarchical snake_case + OpenInference attribute matrix + 20 namespaces + 5 LOCKED decisions） | Accepted | 2026-05-31 | `observability`, `phase0b`, `tracing`, `naming` |
| [ADR-0015](ADR-0015-observability-coverage-gate.md) | Observability Coverage Gate（schema/runtime drift CI gate for PR-O2 phase 2） | Accepted | 2026-05-31 | `observability`, `phase0b`, `tracing`, `ci`, `schema-governance` |

---

## 在 PR 中如何引用 ADR

- commit message 与 PR 描述里直接写 ADR 编号，例如：`refs ADR-0007`、`supersedes ADR-0003`
- 代码中如果某段实现是某 ADR 的直接落地，加注释：`// See ADR-0007: Phoenix is the only sanctioned observability backend.`

---

## 提交流程速查

1. 选下一个未占用编号 `NNNN`（看本索引最后一行 +1）
2. 复制 `_template.md` → `ADR-NNNN-<title>.md`
3. 填写每个章节（不要留 placeholder）
4. 在本 README 的索引表追加一行
5. 在同次 PR 里提交，并在 PR 描述里点名引用本 ADR
