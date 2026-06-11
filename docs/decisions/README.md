# Architecture Decision Records (ADR)

> 本目录是本仓的**架构决策档案**。每一份 ADR 记录一个值得后人知道"为什么"的决定。
> 失去"为什么"，下一个 coding agent 就只能从代码里反向猜测，而代码本身从不解释自己。

---

## 为什么需要 ADR

关键决策若只口头讨论或散落在 issue / chat / wiki 里，会导致：
- 接手者看不懂某些"看似多余"的代码为什么这样写
- 新 agent 容易"善意地"还原一个早已被否决的方案
- 顶层契约与实现细节之间没有清晰边界

ADR 是低成本的反熵机制：5 分钟落一份，下一个 agent 节省数小时。

---

## 何时必须写 ADR

下面任一情形发生，必须在同次 PR 内提交 ADR：

1. **改动公共契约**：DB schema、ERP gateway 接口、channel adapter 形状、container ↔ host 协议
2. **在 2 个以上可行方案中做出选择**（即使最后选了"看起来显然"的那个）
3. **引入新的依赖类别**：新的 LLM provider、新的 observability 后端、新的 storage、新的 sidecar
4. **否决 / 撤销 一个先前的 ADR**（写新 ADR + 把旧 ADR 标记为 Superseded）

何时**不必**写 ADR：
- 重命名局部变量、修 typo、补单元测试、debug 一个不改契约的 bug
- 已有 ADR 完全覆盖的实现细节

---

## 命名与格式约定

- 文件名：`ADR-NNNN-kebab-case-title.md`，N 为 4 位顺序号
- 顺序号**单调递增、不复用**（即使某份 ADR 被 Supersede，编号仍保留）
- 模板：`_template.md`
- 状态字段限定值：`Proposed | Accepted | Superseded by ADR-XXXX | Deprecated | Reverted`

## 与 `docs/audit/` 的关系

- `docs/audit/` 用于记录**审计型记录**（例如安全审计、合规复核、第三方评估的结论）
- `docs/decisions/`（本目录）用于记录**主动设计决策**
- 二者不重叠：审计是回看 + 评估，决策是前瞻 + 拍板

---

## ADR 索引

| ADR | 标题 | 状态 | 日期 | 标签 |
|---|---|---|---|---|
| [ADR-0007](ADR-0007-observability-phoenix-grafana.md) | Observability 框架：纯 Phoenix (ELv2) + Grafana | Accepted | 2026-05-18 | `observability`, `framework` |
| [ADR-0010](ADR-0010-rename-default-frontdesk-to-template.md) | Rename default frontdesk → template frontdesk（命名歧义修复 + LEGACY fallback） | Accepted | 2026-05-20 | `naming`, `refactor`, `frontdesk` |
| [ADR-0011](ADR-0011-host-otel-instrumentation.md) | Host OpenTelemetry Instrumentation（OTel SDK bootstrap + manual span + context bridge + trace-log 关联） | Accepted | 2026-05-29 | `observability`, `tracing`, `host-runtime` |
| [ADR-0014](ADR-0014-observability-span-schema.md) | Observability Span Naming Schema v1.0（hierarchical snake_case + OpenInference attribute matrix + 20 namespaces + 5 LOCKED decisions） | Accepted | 2026-05-31 | `observability`, `tracing`, `naming` |
| [ADR-0015](ADR-0015-observability-coverage-gate.md) | Observability Coverage Gate（schema/runtime drift CI gate） | Accepted | 2026-05-31 | `observability`, `tracing`, `ci`, `schema-governance` |

---

## 在 PR 中如何引用 ADR

- commit message 与 PR 描述里直接写 ADR 编号，例如：`refs ADR-0007`、`supersedes ADR-0011`
- 代码中如果某段实现是某 ADR 的直接落地，加注释：`// See ADR-0007: Phoenix is the only sanctioned observability backend.`

---

## 提交流程速查

1. 选下一个未占用编号 `NNNN`（看本索引最后一行 +1）
2. 复制 `_template.md` → `ADR-NNNN-<title>.md`
3. 填写每个章节（不要留 placeholder）
4. 在本 README 的索引表追加一行
5. 在同次 PR 里提交，并在 PR 描述里点名引用本 ADR
