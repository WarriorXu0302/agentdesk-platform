# 从 V1（openclaw / 小环）迁移到 MUAP — 入口指针

> **本文件作用**：MUAP 仓内的迁移导航入口。所有 V1→MUAP 迁移工作的设计文档**不在 MUAP 仓内**，而是位于姊妹仓 `../openclaw/CLOSEOUT/`。
> **不要在本仓里复制粘贴**：保持单一事实源，避免漂移。

---

## 一句话状态

- **V1 主仓**：`/Users/desjajja/Dev/realityloop/openclaw/`（实验室硬件 harness，"小环"）
- **MUAP 主仓（本仓）**：`/Users/desjajja/Dev/realityloop/MultiUserAgentPlatform/`（FrontLane v2.x）
- **迁移宪法**：[`../openclaw/CLOSEOUT/migration-to-muap.md`](../../openclaw/CLOSEOUT/migration-to-muap.md) — **v1.2 / Q1-Q7 全部已决议**
- **当前阻断**：Phase 0.5 mock cluster gate（Q3）+ Phase 0b observability（Q6/Q7，已拍板待实施）

---

## 必读入口（按角色）

### MUAP coding agent（第一次接触本项目）

```
1. 读这份文件（你正在读）
2. 读 ../openclaw/CLOSEOUT/README.md      ← 文档系统总入口
3. 读 ../openclaw/CLOSEOUT/migration-to-muap.md v1.2  ← 迁移宪法
4. 按需要深入子主题（observability / mock / ERP ops / phase0 pack）
```

### 要在 MUAP 实现 Phase 0a（agent group 引导）

- 设计：[`../openclaw/CLOSEOUT/migration-to-muap.md`](../../openclaw/CLOSEOUT/migration-to-muap.md) §6 路线图 Phase 0a
- 实施套件（直接拷贝 + 5 步运维）：
  - [`../openclaw/CLOSEOUT/phase0-implementation-pack/README.md`](../../openclaw/CLOSEOUT/phase0-implementation-pack/README.md)
  - [`../openclaw/CLOSEOUT/phase0-implementation-pack/groups/frontlane-lab-frontdesk/`](../../openclaw/CLOSEOUT/phase0-implementation-pack/groups/frontlane-lab-frontdesk/)
- 触达本仓的脚本：`scripts/init-enterprise-topology.ts`

### 要在 MUAP 实现 Phase 0b（observability — Phoenix + Grafana）

- 设计：[`../openclaw/CLOSEOUT/agent-observability-design.md`](../../openclaw/CLOSEOUT/agent-observability-design.md) v1.0 FINAL
- HTML 阅读版（含 4 块 mock UI）：[`../openclaw/CLOSEOUT/agent-observability-design.html`](../../openclaw/CLOSEOUT/agent-observability-design.html)
- 工时：**2.5 工程师日**（7 个 PR，PR-O1 至 PR-O7）
- 关键决策：纯 Arize Phoenix（OSS, ELv2）+ Grafana 综合面板，**不引入 Logfire / Langfuse 耦合层**

### 要落 ERP `/execute` operations（Phase 2A/2B）

- 冻结表：[`../openclaw/CLOSEOUT/erp-operations-frozen-v1.md`](../../openclaw/CLOSEOUT/erp-operations-frozen-v1.md)（50 op）
- 实现入口：`container/agent-runner/src/mcp-tools/erp-gateway.ts`、`scripts/configure-enterprise-gateway.ts`

### 要做 Phase 0.5 mock cluster（Q3 阻断）

- 方案：[`../openclaw/CLOSEOUT/v1-mock-simulation-replication-plan.md`](../../openclaw/CLOSEOUT/v1-mock-simulation-replication-plan.md)
- 9 项验收 gate
- O01-O03 联动 observability：依赖 Phase 0b 已完成

---

## V1 文档边界（**不要读**）

以下 V1 文件**禁止**被 MUAP coding agent 读取（来自 V1 `openclaw/AGENTS.md` 强约束）：

- `openclaw/SOUL.md`
- `openclaw/USER.md`
- `openclaw/memory/YYYY-MM-DD*.md`

V1 顶层运行期文件（`HARNESS.md` / `DISPATCH.md` / `FACTS.md` / `IDENTITY.md` / `MEMORY.md` / `AGENTS.md`）是 V1 运行行为契约，**不是设计文档**；MUAP 仓只通过 `phase0-implementation-pack` 的合并脱敏版本接收其内容。

---

## 决议矩阵速查（Q1-Q7）

| Q | 主题 | 决议 |
|---|---|---|
| Q1 | 整体路径 | A 同意（V1 prompt 迁 `CLAUDE.local.md`，Python 技能挂 ERP 后） |
| Q2 | 启动时机 | A 立即启动 |
| Q3 | 部署拓扑 | C-Optimized 混合双套（sim 同主机 / prod LAN） |
| Q4 | 评审归档 | A 落盘 `migration-to-muap.md` |
| Q5 | pydantic-ai | A 纳入主路线（Phase 5） |
| Q6 | Phase 0b observability | A 需要（与 Phase 0a 并行） |
| **Q7** | **observability 框架** | **方案 A：纯 Phoenix（ELv2）+ Grafana 综合面板** |

---

## 维护规则

- 本文件**只能含指针**，不复制 `openclaw/CLOSEOUT/` 内容
- 当 `openclaw/CLOSEOUT/migration-to-muap.md` 升新版（v1.3、v1.4 ...）时，更新本文件「迁移宪法」行的版本号
- 不在 MUAP 仓做与迁移设计冲突的工程改动（详见迁移宪法 §10「不做的事」）
- 涉及硬件/API/MQTT 的真实操作必须经用户确认；模拟模式（`RUNTIME_MODE=simulation`）下亦遵守 sim 边界
