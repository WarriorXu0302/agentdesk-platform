# ADR-0052: 真·多租户 org 隔离（对标清单 #7 完整版,用户显式选择）

- **Status**: Accepted（**分阶段**:Stage A + B 已落地全绿;2 子决策已确认[① public-within-org ② owner/global_admin 跨 org 旁路];剩 FIX-4b 选项/approver 过滤 + createNewAgentGroup org 继承 + Stage C bootstrap）
- **Date**: 2026-06-16
- **Decider(s)**: 用户(在明确警告后选"要更强的完整多租户隔离");coding agent(design+9 视角对抗评审 workflow wf_ef5a7824 + 执行)
- **Tags**: `multi-tenant`, `isolation`, `rbac`, `governance`, `identity-trust-chain`, `db`, `migration`, `security`, `fail-closed`

---

## Context

ADR-0051 给了运维角色 + 极薄 workspace 标签,并把"完整多租户 org 层"标为 **待显式确认**(它 re-read `schema.ts:9`
"所有 workspace 平等、权限挂用户"哲学行,且对抗评审否决了朴素 org 层的两处致命缺陷)。**用户在该警告下明确选择
"要更强的完整多租户隔离"**——接受哲学覆盖 + 契约返工,换取**真正的跨租户拒绝**(org X 的用户够不到 org Y 的
agent group / 会话 / 分诊数据)。这不违背业务无关核心(任何有多个隔离租户的运营者都受益,不焊死任何 ERP/CRM 逻辑)。

经 3 种隔离深度方案(D1 门控浅 schema / D2 深列冗余 / D3 强制默认 org)并行 + 9 视角对抗评审(隔离完整性 /
6 不变量 / 契约+迁移安全)+ 综合裁决。9 评审全 fixable、0 unsafe。**关键发现:schema/契约是小头;7 处跨切面修复
(create-agent、channel-approval、addMember-on-approve、public 入口、operator-query 粒度、a2a 守卫顺序、
isGlobalAdmin 收紧)才是大头,三方案都没 scope 到**——故方案选择次于这组强制修复。

## Decision

> **采 D3 主干(强制默认 org、org 只挂 agent_groups 作工作负载锚、org 作 host 访问闸前置条件、其余 JOIN 推导、
> 全 scope-tuple revoke)+ 嫁接 D1 的 `organization_members` 名册表(成员=可达性,绝非特权)+ 7 处强制修复。
> 否决 D2 冗余**(其三个"创建 chokepoint"经核实是错的:`createMessagingGroup` 在 wiring 之前跑、
> `createNewAgentGroup` 是未列出的第四写者;且 `gateway_audit.organization_id` 会把 org 读塞进签名代理热路径、
> 削弱不变量 2 的结构保证)。

**org 只活在两张工作负载表(`agent_groups`、`user_roles`)+ 名册表**;`sessions`/`messaging_groups`/`dm_grants`/
`classification_log`/`enterprise_audit`/`gateway_audit` **都不加 org 列**——它们都带 `agent_group_id`,经**不可变**
FK JOIN 推导 org(无第二份 org 拷贝可漂移/伪造)。**这把 org 挡在网关代理写路径之外(不变量 2 的决定性理由)。**

### 契约返工(修两处致命缺陷,核心)

互斥判别联合 `RoleScope`(让"恰好一个 scope 轴"违反时不可表示):
```ts
type RoleScope =
  | { kind: 'global' }                          // owner / global_admin / global operator|viewer  → (ag NULL, org NULL)
  | { kind: 'group';  agentGroupId: string }    // admin|operator|viewer @ 一个组               → (ag set,  org NULL)
  | { kind: 'org';    organizationId: string }; // org-admin|operator|viewer @ 一个 org          → (ag NULL, org set)
```
- **grantRole({userId, role, scope, grantedBy, grantedAt?})**:单条 6 列 INSERT(加 organization_id)、**永远**走
  `recordEnterpriseAudit`——org 授予骑同一条语句,无平行写路径(**修缺陷 2:审计旁路**)。group scope 不把组的 org
  拷进行(组经 `orgOfAgentGroup` 钉 org)。
- **revokeRole({userId, role, scope, revokedBy})**:3 个**互斥**删除谓词。global 分支加 `AND organization_id IS NULL`
  (旧版只 `agent_group_id IS NULL` → org 行也匹配 → 撤一个全局 admin 会连带抹掉全部 org 授予;**修缺陷 1:连带删除**);
  org 分支给出以前不可能的"精确单 org 撤销"。

### 访问闸语义(`canAccessAgentGroup`)

平台超级用户旁路(owner/global_admin,在算 org **之前**)→ **org 成员前置**(非成员 → `cross_org_denied`;org===null
即 legacy 无前置,逐字兼容)→ org-admin / group-admin / member / operability_only / not_member。
`hasAdminPrivilege`(审批卡/加成员权)得**同款**前置。

**强制修复 FIX-1(最危险陷阱)**:返工后 org-admin 行是 `(role='admin', ag NULL, org=X)`,会被**现有** `isGlobalAdmin`
(`role='admin' AND ag IS NULL`)匹配 → 每个 org-admin 变跨组超级用户。**所有 owner/global-admin/global-operability 的
`… AND agent_group_id IS NULL` 谓词必须加 `AND organization_id IS NULL`**(+ command-gate 内联 isAdmin)。非协商,随闸同 commit。

### 逐路径隔离完整性(攻击者在 org X、非 owner/global_admin、要够 org Y)

路由(per-wiring 闸)✓、create 路径(**FIX-3**:createAgentGroup 6 列写 org + create-agent 继承源组 org +
`createDestination` 同 org 断言 + a2a 运行时守卫置于 `resolveTargetSession` **之前**)✓、sessions(只在闸后建,org 由不可变
FK 推导)✓、operator-queries(**FIX-5**:必填 `actor` + 非全局则强制 `organization_id IN (actor orgs)` 谓词,**fail-closed**
空集→零行;`traceRequest` **逐 session 行**过滤非逐 root,因跨 org 委派树会漏)✓、a2a(同 FIX-3 守卫,origin_user_id 交叉校验
不动)✓、roster(scope 跨整棵委派树,隔离**依赖 FIX-3**——跨 org 边永不成树)✓、网关记忆(代理只按 token 绑定,**不加 org
输入**;跨 org 记忆隔离是后端 subject-scoping 职责 ADR-0033,且 org-X 用户永不获 org-Y 组的会话)✓、审计读(JOIN org +
同款 fail-closed actor 过滤)✓。
- **FIX-2(已落地,采子决策①"public within org")**:`public` 策略 + `sender_scope='all'` 在闸前短路 → 对 org-scoped
  组改为**仍强制 org 成员前置**(`publicIngressAllowed`:org 组要求已识别 org 成员或 owner/global_admin;NULL-org 全公开)。
  非"禁用",而是"org 内公开",保留能力的同时堵住跨组入口。
- **FIX-4**:approve-then-replay 对 orged 组会断(新 group-member 非 org-member → cross_org_denied → 静默丢)→ 3 个
  `addMember` admit 点同时 `addOrgMember`;审批选项列表 + `pickApprover` 按 approver 的 org 过滤。

### 不变量合规(1..6)

1 身份链 **COMPLY**(origin_user_id host 盖章/交叉校验不动,无新容器盖字段);**2 网关唯一业务授权 COMPLY,最高风险**
(org 隔离**全是** host 访问门控;代理不改、不读任何 org/role 函数;**FIX-6**:取证表不加 org 列、代理永不盖 org;
**FIX-7**:扩展 `operability-gateway-isolation.test.ts` 把 org 模块/`orgOfAgentGroup`/`isMemberOfOrg` 等加入 7 个
GATEWAY_AUTHZ_FILES 的禁引集;operator-queries 是读面、正确地在该集**之外**,其隔离靠 fail-closed actor 过滤 + 自有测试);
3 三-DB **COMPLY**(全中央 v2.db);4 可观测只读 **COMPLY**;5 Feishu 保守 **COMPLY 且强化**(org 挂组非渠道,每 wiring 独立
org 校验;FIX-2+FIX-4 堵住 public/审批两处 group-context 扩权);6 conv_thread_id **COMPLY**(全用结构键)。

## Consequences

- **正向**:真跨租户拒绝;单运营者多租户可运维。**向后兼容**(单 org = 今日逐字;NULL-org legacy 无前置)。
- **代价(诚实)**:破内部 `revokeRole`/`grantRole` 签名(一 commit 迁调用点,**全在测试**,无生产调用点);
  agent_destinations + spawn/channel 建组加同 org 约束;org-scoped wiring 禁 public/all;operator-queries 加必填 fail-closed
  actor;热路由路径加一次带索引成员查(可忽略)。owner/global_admin 按设计仍跨 org。
- **哲学覆盖(显式)**:本改**打破** `schema.ts:9`"所有 workspace 平等、权限挂用户不挂组"——agent_groups 现带 org 租户、
  可达性按 org 成员门控。用户显式授权此 trade 换真隔离。schema.ts 注释随同 commit 更新。**这是设计哲学覆盖,非安全不变量
  弱化**——6 条安全不变量全保。

## Alternatives rejected

D2 冗余(创建 chokepoint 错 + gateway_audit org 列削弱不变量 2);D1 无名册表(org 可达只能经特权授予 → 循环闸 +
断 approve-then-replay);薄标签无真拒绝(用户否决);把平台 owner 也墙进租户(范围外,另立更重的"无超级管理员"模型)。

## Staging（§ 实施分阶段,每阶段独立全绿)

- **Stage A(已落地)**:迁移 035(表+列+索引+回填)、types(UserRole.organization_id / UserRoleKind+='org-admin' /
  RoleScope)、createAgentGroup 6 列、新 `permissions/db/organizations.ts`、grant/revoke RoleScope 返工 + FIX-1 收紧 +
  全调用点迁移、Stage A 测试(迁移幂等/回填、revoke 契约回归、grant 审计含 organizationId)。**行为不变**(无 org 时逐字),
  把危险的契约返工**隔离 + 回归测**先落。
- **Stage B(已落地,分 B1/B2/B3)**:
  - **B1(010caa2)**:访问闸 org 前置 + `cross_org_denied` + `org_admin`、`hasAdminPrivilege` 同款前置、`canOperate`
    org 化、FIX-2 public-within-org。跨组拒绝测试套(canAccessAgentGroup/canOperate/hasAdminPrivilege + NULL-org 兼容)。
  - **B2(a42a0bd)**:FIX-3(create-agent 继承 org + `createDestination` 同 org 断言 + `routeAgentMessage` 运行时守卫)、
    FIX-4a(3 个 admit 点 addOrgMember)、FIX-4b 渠道 connect handler `canAccessAgentGroup` 校验。
  - **B3(本提交)**:FIX-5(operator-queries `orgScope` fail-closed 过滤 + `traceRequest` 逐行 + `trace.ts --as` 串联)、
    docs(enterprise-multi-user / isolation-model)、ADR 状态。FIX-6(取证表无 org 列、代理不盖)+ FIX-7(守卫扩展)在
    Stage A 已随 organizations.ts 落地。
- **剩余(收尾)**:FIX-4b 选项/approver org 过滤(纯 UX,被 B2 connect 校验兜底)+ createNewAgentGroup org 继承;
  Stage C bootstrap(init-enterprise-topology 可选 org 块 + `--org`/`--org-admin`)+ feishu-channel docs。

**2 项子决策(已由用户确认)**:① **采"public within org"**(非禁用 public,而是 org-scoped 组上 public 仍强制 org 成员前置,
保留能力);② **owner/global_admin 跨 org 旁路**(平台运营者见所有租户)。子决策 ③(回填:自动把所有当前可达用户纳入
org-default 防锁死)在 Stage A 已采推荐默认。
