# ADR-0008: Phase 0a `frontlane-lab-frontdesk` 在 MUAP 仓的落地策略

- **Status**: Accepted
- **Date**: 2026-05-19
- **Decider(s)**: 仓库 owner（用户）；coding agent（Sisyphus，执行 + 提案）
- **Tags**: `migration`, `phase-0a`, `topology`, `enterprise`, `env-management`
- **Supersedes**: —
- **Superseded by**: —

---

## Context

迁移宪法 `openclaw/CLOSEOUT/migration-to-muap.md` v1.2 第 Q1/Q2 决议要求立即开启 Phase 0a：把 V1 `小环` 的 prompt 契约以 MUAP 化形式落地为新的 agent group `frontlane-lab-frontdesk`。canonical artifacts 在 `openclaw/CLOSEOUT/phase0-implementation-pack/` 里已就绪（README + env-template + `groups/frontlane-lab-frontdesk/{container.json,CLAUDE.local.md}`）。

把 pack 直接 `cp` 进 MUAP 并不够，因为：

1. **MUAP `.gitignore` 整体忽略 `groups/`**。当前所有企业 group 的工作目录是运行时生成、非版本化的（参见 `src/group-init.ts` 与现有部署习惯）。但 Phase 0a 的 `frontlane-lab-frontdesk/CLAUDE.local.md` 是 **prompt 契约**，是 V1 → MUAP 迁移的可审计资产，必须随仓提交、必须 reviewable。直接 `cp` 后 git 不会追踪。
2. **`scripts/init-enterprise-topology.ts` 当前只支持单 frontdesk**（`--frontdesk-folder` 单值参数）。pack README Step 3 路径 A 给的伪代码假设存在 `FRONTDESKS = [{folder, name}, ...]` 数组结构 —— 这个结构现在不存在。
3. **pack `env-template.example` 含 `<PLACEHOLDER>`**（如 `<MQTT_BROKER_HOST>`、`<LAB_DB_API_BASE_URL>`），其顶部注释明令"do NOT commit real values"、redaction-guardrails 严格禁止把秘密直接写入 `.env.local`。pack README Step 2 写的 `cat env-template.example >> .env.local` 在 redaction 严格的工程语义下是危险的（占位符会和真值混在一起）。
4. **pack README Step 5 (`ENTERPRISE_FRONTDESK_FOLDER=frontlane-lab-frontdesk`) 是 optional**，env-template 里这一行也是注释状态。把它默认启用会立刻改变现有飞书入站消息的默认路由（generic frontdesk → lab frontdesk），与 v1.2 宪法 "lab desk 是新增不是替换" 的精神冲突。

三个独立的子决策（Step 3 重构方式、Step 2 env 处理方式、Step 5 默认 frontdesk）共同决定了 Phase 0a 是 "干净接入" 还是 "破坏式接入"。本 ADR 把三者一并拍板，避免散落在 commit message 中。

## Options Considered

### 子决策 1：Step 3 — `scripts/init-enterprise-topology.ts` 多 frontdesk 重构方式

- **Option A — `FRONTDESKS[]` 数组化重构**：把 frontdesk 的概念从单值变成数组，新增 `--frontdesks folder1:name1,folder2:name2` 与 `DEFAULT_FRONTDESKS = [{folder:'frontlane-frontdesk',...}, {folder:'frontlane-lab-frontdesk',...}]`。`--frontdesk-folder`/`--frontdesk-name` 仍可用于"只 init 单个 desk"。与 pack README 路径 A 完全一致。
  - 优点：与 canonical pack 一致；扩展性好（未来还可能再加 frontdesk）；一次 `pnpm init:enterprise` 端到端就位
  - 缺点：要小心 worker 反向 destination — 同一个 worker 不能有 2 个名为 `frontdesk` 的 destination
  - 工作量：1.5–2 h
- **Option B — 保留单值 + 新增 `--additional-frontdesks`**：默认行为不变，通过 opt-in 旗标追加。代码 2 条路径并存。
  - 优点：零 break
  - 缺点：与 pack README 不一致；代码两路；未来再加 frontdesk 复杂度雪球
  - 工作量：1 h
- **Option C — 新建独立脚本 `scripts/init-lab-frontdesk.ts`**：复用底层 init 逻辑但独立 CLI。
  - 优点：现脚本完全不变
  - 缺点：代码重复；用户多记一条命令；与 pack 一致性差
  - 工作量：2 h

### 子决策 2：Step 2 — `.env.local` 处理策略

- **Option A — 生成 `.env.local.proposed`（git-ignored）+ console diff 提示**：新增 `scripts/generate-env-local-proposed.ts`，渲染 pack 的 env 模板（保留 `<PLACEHOLDER>` 与注释）到仓根 `.env.local.proposed`，并在 stdout 输出与现 `.env.local`（如果存在）的差异行 + 操作建议（"请手工 review 后选择性 append"）。
  - 优点：redaction-safe；用户可 review/cherry-pick；不破坏现有 `.env.local`；和 `.gitignore` 配合好
  - 缺点：用户多一个手工 append 步骤
  - 工作量：1 h
- **Option B — `cat env-template.example >> .env.local`**：pack README Step 2 原样。
  - 优点：最省事
  - 缺点：`<PLACEHOLDER>` 会原样落到真实 `.env.local`，与现有键可能冲突；违反 redaction-guardrails；如果秘密管理后期切到 vault，这种"占位符常驻"会成为陷阱
  - 工作量：0
- **Option C — 纯文档**：把追加步骤写在 `groups/frontlane-lab-frontdesk/SETUP.md` + commit message 里，由用户全手工。
  - 优点：零自动化风险
  - 缺点：体验差；没有可机器渲染的 diff 提示
  - 工作量：0

### 子决策 3：Step 5 — 飞书 autowire 默认 frontdesk

- **Option A — 保持 `ENTERPRISE_FRONTDESK_FOLDER=frontlane-frontdesk`**：pack README 已标 optional、env-template 该行注释；现有 autowire 测试与行为不变；用户必须显式 `ENTERPRISE_FRONTDESK_FOLDER=frontlane-lab-frontdesk` 才切换。
  - 优点：与 v1.2 宪法 "新增不是替换" 一致；零 break；不影响现有飞书生产
  - 缺点：一次性切换的用户需多 1 步
  - 工作量：0
- **Option B — 切到 `frontlane-lab-frontdesk` 默认**：pack canonical 行为推到极限。
  - 优点：单 lab 部署一步到位
  - 缺点：现有 `frontlane-frontdesk` 路由会被默默改写；autowire 测试会破；与"新增不是替换"冲突
  - 工作量：0.5 h（需要改测试 + 文档）

## Decision

> **拍板**：选 1A + 2A + 3A（即三处全部选 Recommended 选项）。

理由：

1. **可审计性**（1A）。canonical pack 的多 frontdesk 是该 phase 的核心交付物，代码与文档一致才能避免下游 agent 反向推理。数组化是 pack README 路径 A 写给我们看的"正确路线"。
2. **Redaction 优先**（2A）。`<PLACEHOLDER>` 不该污染真实 `.env.local`，渲染出 `.env.local.proposed` 让用户人工合并是 redaction-guardrails 与"评审型工程"基本要求的交集。
3. **零破坏式接入**（3A）。v1.2 宪法明文 "lab desk 是新增不是替换"。默认 frontdesk 不改、用户 opt-in 才切，符合宪法精神，且避免任何现有飞书生产路由的"惊喜"。

## Consequences

- **Positive**
  - `pnpm init:enterprise` 在 fresh repo + 现有 repo 上都能创建 `frontlane-lab-frontdesk`；任何参数都不影响 `frontlane-frontdesk` 的现行行为。
  - `groups/frontlane-lab-frontdesk/{container.json,CLAUDE.local.md}` 入库为 prompt 契约的 single source of truth；diff 即可 review prompt 变更。
  - `.env.local.proposed` 是干净的渲染产物，用户 review 后才决定要不要 merge；可重复执行 `pnpm setup:lab-frontdesk` 也不会污染原 `.env.local`。
  - 现有 init-enterprise / configure-gateway 测试全部保持有效；新增测试覆盖双 frontdesk 与 lab desk 默认目标列表。
- **Negative**
  - `.gitignore` 需要例外（`!groups/frontlane-lab-frontdesk/**`）；以后如果再有 prompt 契约 group 入库，得每次加例外。可接受 — 这本来就是 case-by-case 决策。
  - `init:enterprise` CLI 表面新增 `--frontdesks` 参数 + `FRONTDESKS[]` 概念；后续脚本作者必须了解"多 desk"概念。
- **Neutral / Trade-offs**
  - 单 lab 部署的用户仍需一条 `ENTERPRISE_FRONTDESK_FOLDER=frontlane-lab-frontdesk` 显式配置；这是 v1.2 宪法的 deliberate 设计，保留可逆性。
  - 若将来 v1.x 宪法把 "lab desk 默认替换 generic" 升级为新策略，本 ADR 子决策 3 需被 supersede（届时再写新 ADR）。

## Implementation Notes

落地文件：

- `groups/frontlane-lab-frontdesk/container.json`：copy pack canonical；`enterpriseGateway.baseUrl` 仍为 `${ERP_GATEWAY_BASE_URL}` 占位（由 `configure:enterprise-gateway` 在 Step 4 真正写入运行时 baseUrl，对齐 ADR-0007 的 ERP gateway 契约）。
- `groups/frontlane-lab-frontdesk/CLAUDE.local.md`：copy pack canonical（V1 5 文件契约的 MUAP 化等价）。
- `.gitignore`：保留 `groups/` 默认忽略；新增 `!groups/frontlane-lab-frontdesk/**` 例外（以及 `!groups/frontlane-lab-frontdesk` 目录本身）；新增 `.env.local.proposed` 忽略。
- `scripts/init-enterprise-topology.ts`：
  - 引入 `interface FrontdeskSpec { folder, name, role:'frontdesk', workers? }`
  - `DEFAULT_FRONTDESKS = [{folder:'frontlane-frontdesk', name:'FrontLane Desk', workers:DEFAULT_WORKERS}, {folder:'frontlane-lab-frontdesk', name:'FrontLane Lab Desk', workers:[]}]`
  - 新增 `--frontdesks folder:name[,...]` 解析（含 `--frontdesks` 解析时 workers 默认空）
  - 保留 `--frontdesk-folder`/`--frontdesk-name`：当任意一个被指定时，回退到 **单 desk 模式**（DEFAULT_FRONTDESKS 被覆盖）
  - 在生成 frontdesk-workers destination 时只对 `workers` 非空的 desk 做反向 destination
  - `ensureSharedEntryWiring()` 仅作用于 "primary" frontdesk（数组第一个，仍是 `frontlane-frontdesk`），避免误连
- `scripts/configure-enterprise-gateway.ts`：`DEFAULT_FOLDERS` 加入 `'frontlane-lab-frontdesk'`（保留向后兼容 `--folders` 显式覆盖）。
  - **Addendum (manual-QA-driven)**：`config.enterpriseGateway` 改为 **merge** 而非 wholesale-replace。原行为会把 pack canonical `defaultHeaders["X-FrontLane-Source"]: "frontlane-lab-frontdesk"` 静默丢弃；新行为下 CLI `--header` 与既有 headers 合并，同名 key 时 CLI 覆盖，per-folder header 自动保留。`timeoutMs` 同样对称：CLI 未传时保留 container.json 既有值。`--base-url` 仍然必填覆盖。Regression 由 `configure-enterprise-gateway.test.ts` 中 "preserves pack-provided defaultHeaders" + "CLI --header overrides a same-key header" 两条用例守护。
- `scripts/generate-env-local-proposed.ts`（新增）：
  - 读取 `../openclaw/CLOSEOUT/phase0-implementation-pack/env-template.example`（如果姊妹 repo 不可达，回退到嵌入式 template 副本）
  - 写到 `<repo>/.env.local.proposed`（git-ignored）
  - stdout 提示 "review then optionally merge into .env.local"
- `package.json`：新增 `setup:lab-frontdesk`，串起 init + configure + generate-env-local-proposed（pure orchestration alias）。
- 测试：
  - `init-enterprise-topology.test.ts` 新增 case："both frontdesks created by default"、"single-frontdesk back-compat via --frontdesk-folder"
  - `configure-enterprise-gateway.test.ts` 新增 case："default folders include frontlane-lab-frontdesk"
  - 新增 `generate-env-local-proposed.test.ts`：渲染产物存在 + 内容含 `<MQTT_BROKER_HOST>` 占位符

后续验收：

- `pnpm typecheck` 0 err
- `pnpm test` 全绿
- 手工 QA：在干净 `data/` + 新建 `groups/` 上 `pnpm init:enterprise`，确认两个 frontdesk 都被 DB 创建，且 `groups/frontlane-lab-frontdesk/container.json` 不被 init 覆盖（pack canonical 字段如 `enterpriseGateway.defaultHeaders.X-FrontLane-Source` 仍保留）

## References

- 迁移宪法：`../../../openclaw/CLOSEOUT/migration-to-muap.md` v1.2 (Q1, Q2, Q6)
- Phase 0 实施包：`../../../openclaw/CLOSEOUT/phase0-implementation-pack/README.md`
- canonical artifacts：`../../../openclaw/CLOSEOUT/phase0-implementation-pack/groups/frontlane-lab-frontdesk/`
- env 模板：`../../../openclaw/CLOSEOUT/phase0-implementation-pack/env-template.example`
- redaction guardrails：`../../../openclaw/AGENT_MEMORY/99-migration/redaction-guardrails.md`
- 前置 ADR：ADR-0001（整体路径）、ADR-0002（立即启动）、ADR-0003（部署拓扑）、ADR-0006（Phase 0b 并行）、ADR-0007（observability 框架）
- 关联代码：`scripts/init-enterprise-topology.ts`、`scripts/configure-enterprise-gateway.ts`、`src/branding.ts`、`src/group-init.ts`、`src/container-config.ts`
