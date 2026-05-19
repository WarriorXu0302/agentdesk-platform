# `reports/` — 人机分目录

> 本目录存放**生成的产物**：审查报告、看板、HTML 富文本面板、阅读版文档等。

## 子目录约定

| 子目录 | 用途 | 受众 |
|---|---|---|
| `reports/human/` | **人面向**的 HTML 报告、看板、富文本文档（PDF/HTML/可打印） | 项目负责人、外部读者 |
| `reports/machine/`（按需新建） | 机器可读产物（JSON/CSV/SARIF/metrics dump 等） | CI、下游工具、agent |
| `reports/archive/`（按需新建） | 已被新版本取代但需保留的历史报告 | 审计追溯 |

> 建议：每次新建 HTML 报告时，文件名形如 `<kind>-<topic>-YYYY-MM-DD.html`，落在 `reports/human/` 下。

## 当前清单

### `reports/human/`

| 文件 | 类型 | 主题 | 关联 ADR / 工作 |
|---|---|---|---|
| `muap-harness-scorecard.html` | 审查报告 | MUAP dev-harness 七维评分 + 跨仓发现性分析（21/35 = 60%） | 触发 P0 修复 |
| `p0-harness-fixes-2026-05-18.html` | 变更报告 | P0 三项修复完成情况、ADR 系统建立、Before/After 对比 | ADR-0001 ~ ADR-0007 落地 |
| `next-phase-milestones-2026-05-19.html` | 富文本看板 | MUAP 下一阶段工作 + 里程碑：关键路径甘特 / 8 阶段 kanban / 当前状态盘点 / ERP 操作索引 / 风险登记 / 验收门集合 / 立即可执行行动 | 落地 v1.2 宪法 + ADR-0001~0007 |

## 维护规则

- HTML 必须自包含（无 CDN / 远程字体 / 外部 image），符合 `~/.agents/skills/html-interface/SKILL.md` 的 HTML Output Policy
- 同主题如有多版，旧版移入 `reports/archive/`，文件名追加 `-v0.x` 后缀
- 不要在 `reports/` 顶层散落文件——全部归类到 `reports/human/` 或 `reports/machine/`
- 不要把 ADR / 设计文档放在这里——它们的家在 `docs/decisions/` 和 `docs/`
