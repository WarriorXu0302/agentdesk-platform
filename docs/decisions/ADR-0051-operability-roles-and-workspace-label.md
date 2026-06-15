# ADR-0051: 运维角色（operator/viewer）+ 治理用 workspace 标签（对标清单 #7,对标 Dify）

- **Status**: Accepted（Phase 1 已落地;Phase 2 workspace 标签待用户显式确认 scope-freeze）
- **Date**: 2026-06-16
- **Decider(s)**: 用户(选"做完整 #7 workspace 治理层");coding agent(design+对抗评审 workflow wf_c427ea8c + 执行)
- **Tags**: `rbac`, `governance`, `operability`, `identity`, `db`, `migration`, `backward-compat`

---

## Context

用户选"做完整 #7(显式 RBAC + workspace 多租户层)"。**实地勘查推翻了 benchmark 的前提**——这是 benchmark
**第 5 次**高估缺口:

- **RBAC 早已 live(非空壳)**:`src/modules/permissions/`(经 `src/modules/index.ts` 在 `src/index.ts:70`
  side-effect 加载)注册 `setAccessGate` → `canAccessAgentGroup`(`access.ts:21`),层级
  `owner > global_admin > group_admin > member > denied`;`grantRole/revokeRole` 落 `user_roles` +
  审计 `enterprise_audit`;角色可全局(`agent_group_id IS NULL`)或按 agent-group 限定。约 70% 的 #7 访问控制本就有。
- **真缺口**:① 无只读运维层——`operator`/`viewer` 角色缺失,fleet 分诊(ADR-0049)仅 OS 门控(谁能跑 CLI / 读 v2.db,
  且一读就读到全部);② 无 org/workspace 实体。
- **哲学张力**:`schema.ts:9` 明确"所有 workspace 平等;权限挂用户、不挂组",ADR-0049 与 benchmark 两次判多租户
  org 层为"隔离本就强、workspace 主要是 packaging、中等价值"。硬上 org 隔离边界与框架单运营者哲学顶牛。

设计经 3 方案并行 + 9 视角对抗评审 + 综合裁决 workflow(wf_c427ea8c)。

## Decision

> **采纳 Approach C(运维角色)为主干 + Approach B 的 L2(极薄 workspace 标签)**,作为两个**独立可回退**的迁移。
> **否决 Approach A(全 org 层)**、**否决 B 的 L3(workspace 限定的角色授予)**。

**Phase 1(本 commit,已落地)——运维角色 + in-band 闸,加性、零哲学张力、ADR-0049 已预批:**
- `UserRoleKind` 增 `operator`/`viewer`(`src/types.ts`)。迁移 034 **无 DDL on user_roles**(`role` 是无 CHECK 的
  TEXT,新值直接可插,沿 migration030 'escalate'/033 'routing_feedback' 同款路子;CHECK 会强制重建表 + 冻结词表,
  按"代码而非 schema 强约束"惯例否决),仅一条元数据索引 `idx_user_roles_role`。仅中央 v2.db,无三-DB 顾虑。
- **两条硬边界**:(a) 运维角色只门控 **HOST 运维/治理只读面**,**绝不**是 per-request 业务授权输入——业务授权仍唯一
  归后端网关(不变量 2);(b) **不赋予路由/写权**:`hasAdminPrivilege` **保持不变**(operator/viewer 不过审批卡闸,
  护住 ADR-0045 反伪造面),`canAccessAgentGroup` 对仅持 operator/viewer 者以新的显式 `operability_only` 理由**拒绝路由**
  (比误导的 `not_member` 清楚)。
- 新 `canOperate(userId, agentGroupId?)`(`operability.ts`):无 group=fleet-wide(仅 owner/global-admin/global
  operator/viewer);带 group=再加该组 scoped operator/viewer/admin。
- `scripts/trace.ts` 加可选 `--as <userId>`:给定则 `canOperate` 校验、不过则拒;**不给 = 行为不变**(仍 OS 门控)。
  **本条 supersede ADR-0049 的"仅 OS 门控"备注**——现可委派 fleet 分诊而不必发 shell + 裸 DB。
- **不变量-2 守卫测试与角色同 commit**(非后续):`operability-gateway-isolation.test.ts` 断言任何网关/签名/审计文件
  都不 import operability、不引用 `canOperate`,且 operability.ts 不 import 任何网关/业务模块。这是把设计**结构性**钉在
  "业务授权只走网关"不变量内的承诺。

**Phase 2(待用户显式确认,未落地)——极薄治理 workspace 标签:**
- 迁移 035:`workspaces` 表 + `agent_groups.workspace_id` 可空 FK(NULL=今日"未分组"行为,零迁移痛)。
- **`user_roles` 不加 `workspace_id` 列**——这是与 A/B-L3 的关键分野:workspace 是**纯运营视图/治理 rollup 标签**,
  **不授予任何权限、绝不做角色 scope**。规避了 PK 不可 ALTER、给安全攸关角色表加第二个应用层不变量、以及 A 的
  `revokeRole`(按 `agent_group_id IS NULL` 删,无 org 谓词→撤一个全局 admin 会连带抹掉其全部 org-admin)/`grantRole`
  (硬编码唯一审计 INSERT 路径→org 行绕审计)两处**已核实的致命缺陷**。
- `operator-queries.ts` 加 `workspaceId` 过滤(`LEFT JOIN agent_groups ag ON s.agent_group_id = ag.id`,**纯结构键**,
  conv-thread 守卫机械挡住任何误用 conv_thread_id)。`trace.ts` 加 `--workspace`。
- **需显式确认**:它新增一个 re-read `schema.ts:9` 哲学行的实体,且两次被判中等/packaging。故 freeze 其 scope:
  仅角色视图分组、**无**业务语义、**无**per-workspace 提示/配额/计费、**绝不**作为网关 entitlement 转发。

## Consequences

- **正向**:无需 shell+裸 DB 即可委派最小权限 fleet 分诊;是未来"渠道暴露的运维工具"的前置;完全向后兼容
  (无 operator/viewer 行 + workspace_id NULL = 今日逐字行为)。host 825/825(+12)、tsc/prettier 干净、迁移 034 干净应用。
- **边界(诚实)**:当前纯读面上 operator≡viewer 行为等价,是**前向定义**(待 act-capable 运维方法落地再分化);
  成本仅一个 TEXT 字面量 + 一个 getter,故现在就引入读/写区分,免得日后重评每条授予。
- **不变量**:1 身份链不碰(角色 host 侧评估,容器永不见 user_roles);**2 业务授权仍唯一走网关**(守卫测试钉死);
  3 仅中央 DB 元数据级 ALTER/INDEX,无 session-DB/ALTER-on-open;4 operator-queries 仍纯 SELECT;5 Feishu 路由层级
  不变、运维角色零写权;6 全部新 scope 用 `agent_group_id`/`workspace_id`/`root_session_id`,绝不 conv_thread_id。
- **语义蔓延风险**:"workspace"会勾起 per-workspace 提示/配额/计费的冲动——ADR 明令禁止,且 Phase 2 落地时
  `docs/enterprise-erp-gateway.md` 须补一条"不得把 workspace_id/角色作为网关 entitlement 转发"。

## Alternatives considered

- **Approach A(全 org 层 + org-scoped user_roles)**——**否决**。两处已核实致命缺陷(见 Phase 2):`revokeRole` 连带抹除、
  `grantRole` 绕审计;为一个 ~60% 与现有 scoped-admin 重复的中等价值项,强推它声明 out-of-scope 的公共契约返工。
- **B 的 L3(workspace 限定角色授予)**——**否决**其授予机制:逼着在不可 ALTER 的 PK 旁加并行 partial-unique-index +
  给安全攸关角色表加第二个应用层不变量,只为换"现有 scoped-admin 的语法糖"。保留 B 的 L1(角色)+ L2(workspace 标签)。
- **纯 C、完全不要 workspace**——可行且最低风险,但用户明确要 workspace 治理层,而标签式 workspace 能安全/加性/默认休眠地补上,
  故纳入其最小版(待确认)而非彻底丢弃。
