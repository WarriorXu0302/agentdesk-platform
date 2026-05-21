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

### `reports/machine/`

| 路径 | 内容 | 关联报告 |
|---|---|---|
| `qa-evidence-2026-05-21/` | Phase 0b / PR-O1 manual Docker QA 11 步原始 stdout / JSON 证据 | `human/phase0b-pr-o1-qa-evidence-2026-05-21.html` |

### `reports/human/`

| 文件 | 类型 | 主题 | 关联 ADR / 工作 |
|---|---|---|---|
| `muap-harness-scorecard.html` | 审查报告 | MUAP dev-harness 七维评分 + 跨仓发现性分析（21/35 = 60%） | 触发 P0 修复 |
| `p0-harness-fixes-2026-05-18.html` | 变更报告 | P0 三项修复完成情况、ADR 系统建立、Before/After 对比 | ADR-0001 ~ ADR-0007 落地 |
| `next-phase-milestones-2026-05-19.html` | 富文本看板 | MUAP 下一阶段工作 + 里程碑：关键路径甘特 / 8 阶段 kanban / 当前状态盘点 / ERP 操作索引 / 风险登记 / 验收门集合 / 立即可执行行动 | 落地 v1.2 宪法 + ADR-0001~0007 |
| `phase0a-onboarding-2026-05-20.html` | 交付完成报告 | Phase 0a `frontlane-lab-frontdesk` 接入完成：多 frontdesk 拓扑 / configure gateway header merge 修复 / `.env.local.proposed` 生成器 / canonical pack 接入 / ADR-0008 / 验证证据（36 files · 345 tests 全绿 + 3 步手工 QA） | commit `dba7249` · ADR-0008 落地 |
| `phase0b-pr-o1-2026-05-20.html` | 交付报告（含 2026-05-21 §10 Addendum） | Phase 0b / PR-O1 Observability Bootstrap 落地：双 compose stack（Phoenix-sim / Phoenix+Postgres+Grafana-prod）/ image pin / Grafana host 3001 避让 webhook / read-only `grafana_ro` 角色 / Phoenix 内建 Prom 端点 / Grafana provisioning + 占位 dashboard / `pnpm obs:*` 8 个脚本 / TDD 6 条契约守门 / 验证证据（37 files · 351 tests 全绿 + 11 步 manual Docker QA） | commit `19a2031` 已落 · ADR-0009 + ADR-0010（frontdesk 模板改名）落地 · manual Docker QA 已于 2026-05-21 全部 PASS |
| `phase0b-pr-o1-qa-evidence-2026-05-21.html` | QA 证据补章 | Phase 0b / PR-O1 manual Docker QA 11 步实测证据：obs:config / obs:up / Phoenix UI / Grafana health / 2 datasource / 占位 dashboard / `grafana_ro` 角色权限 / host 3000 避让 / obs:down 保留卷 / obs:reset 清理 — 全部 PASS · 关闭 PR-O1 唯一未关闭闸门 | 关联 commit `19a2031` · ADR-0009 §Acceptance 闸门关闭 · 原始证据 `reports/machine/qa-evidence-2026-05-21/step1..step11.{txt,json}` |
| `minimal-demo-flow-2026-05-21.html` | 现状盘点 / 操作手册 | "现在可以做到的最小完整演示流程"：三条候选路径（Path A 离线 mock / Path B 真实 LLM / Path C ERP echo）+ 详细 5 步脚本 + ASCII 数据流图 + 演示覆盖矩阵 + 排错表 + 与生产部署的差距清单 | 关联 commit `4348ea9` 之后基线（lint baseline 已清零）· 演示路径完全离线，仅依赖 Node 20 + Docker |
| `phase0-recap-2026-05-21.html` | 阶段汇报 / 会议参考 | Phase 0 整段（Phase 0a + Phase 0b/PR-O1）面向开发团队的成果回顾：数字概览 / 迁移路线定位 / 双 frontdesk 拓扑 / observability infra 落地 / 守门 6/6 / manual QA 11/11 / ADR-0001~0010 决策矩阵 / 红线检查 / 最小演示路径 / 5 分钟上手指引 / PR-O2 / O3 启动门槛 | 关联 commit `ff0d18d` 基线 · 含 9 节 + 目录 + 会议一句话叙事 · 自包含 HTML |
| `architecture-explainer-2026-05-20.html` | 架构解释 | 双 Frontdesk / Lab Desk / ERP Gateway 三个核心概念详解：两种接待风格对比（委托模型 vs 直驱模型）/ Lab Desk 身份标记（X-FrontLane-Source）/ Gateway 5 端点 + 安全模型（身份传递 / HMAC / 审计）/ 全景数据流图 / 常见问题 | Phase 0a 架构背景 |

## 维护规则

- HTML 必须自包含（无 CDN / 远程字体 / 外部 image），符合 `~/.agents/skills/html-interface/SKILL.md` 的 HTML Output Policy
- 同主题如有多版，旧版移入 `reports/archive/`，文件名追加 `-v0.x` 后缀
- 不要在 `reports/` 顶层散落文件——全部归类到 `reports/human/` 或 `reports/machine/`
- 不要把 ADR / 设计文档放在这里——它们的家在 `docs/decisions/` 和 `docs/`
