# ADR-0053: 自动"每群一个 agent"隔离模式（autowire 扩展）

- **Status**: Accepted
- **Date**: 2026-06-16
- **Decider(s)**: 用户("能不能自动按一个群就是一个 group,配置太麻烦");coding agent(执行)
- **Tags**: `autowire`, `topology`, `isolation`, `enterprise`, `backward-compat`

---

## Context

默认 autowire(`ENTERPRISE_AUTO_WIRE_GROUPS=true`)把**所有**新群 @ 机器人都接到**同一个共享 frontdesk** agent_group
——它们共享 `/workspace/agent/`(`CLAUDE.local.md` + `conversations/` 记忆)。要让每个群"自成一体、记忆不外溢",
现状得**手动**(审批时选"新建 agent",或 bootstrap `--frontdesks` 拆多个),用户嫌麻烦,希望**自动每群独立**。

诚实定位:这是**新特性**,不是之前漏做的。ADR-0052(多租户 org 隔离)是**另一个轴**(按 org 做跨租户访问拒绝),
不自动给每个**群**建独立 agent/记忆。

关键技术前提(使方案变简单):**`CLAUDE.md` 每次 spawn 现场合成**(`composeGroupClaudeMd`,读共享 base
`container/CLAUDE.md` + 技能片段),**技能在 spawn 时按 `container.json` symlink 同步**。所以"克隆前台"**只需拷
一个 `container.json`**;CLAUDE.md / 技能会自己长出来,记忆全新。

## Decision

> 把"群 → 哪个 agent_group"的决策做成**可插拔策略表**(registry),而非写死的布尔开关。

`GroupAgentStrategy = (input: { frontdesk; mg; event }) => AgentGroup`,用 `registerGroupAgentStrategy(name, fn)`
注册、`listGroupAgentStrategies()` 列举。内置两条:

- **`shared`**(默认)—— `({ frontdesk }) => frontdesk`:所有群接到同一共享前台(**逐字保持原行为**)。
- **`per-group`** —— `({ frontdesk, mg }) => resolveOrCreatePerGroupAgent(frontdesk, mg)`:**新群** autowire 时,用从
  `platform_id` 派生的确定性 folder(`<frontdeskFolder>-g-<slug>`)**resolve-or-create** 一个**克隆自前台**的 per-group
  agent_group(`initGroupFilesystem` + 拷前台 `container.json`),把群接到**它**。

运营者用 `ENTERPRISE_AUTO_WIRE_GROUP_STRATEGY=<name>` 选策略(默认 `shared`);老开关
`ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED=true` 保留为 **`per-group` 的向后兼容别名**。**DM/p2p 永远走共享前台**(策略只对群生效)。
自定义拓扑(如按 org 池化、按渠道分流、固定到某专家 agent)**注册一条自己的策略即可,不改 core**。

- **幂等 + 防竞态**:folder 确定性派生,已存在则复用;并发首消息抢建时,丢的一方捕获 UNIQUE 冲突后 re-fetch 赢家。
- **org 继承**:per-group agent 继承前台的 `organization_id`(与 ADR-0052 一致,落在同租户)。
- **不建孤儿**:策略门(`allowPolicyDowngrade`)在 provision **之前**判定——被拒的接线绝不留下未接线的 agent_group。
- **顺带白送**:DM(共享前台)与群(各自独立 agent_group)天然不同 agent_group → 跨群记忆隔离(此前讨论的"私聊套群内容")自动成立。

## Consequences

- **正向**:`STRATEGY=per-group` 一开,每个新群自动得到独立工作区 + 记忆,零手工配置;默认 `shared` 则**逐字保持原行为**(向后兼容)。
- **可插拔(本轮)**:决策点是一张策略表,运营者**注册自己的策略**就能落地任意"群 → agent"拓扑(org 池化 / 渠道分流 / 固定专家),**不动 core、不发 PR**;未知策略名**失败安全回退到 `shared`**(只 warn,绝不丢消息)。
- **资源(诚实)**:**不多花容器**——容器数 = 活跃 session 数,与 agent_group 怎么分无关(单 poll-loop + `MAX_CONCURRENT_CONTAINERS` + idle 退出已兜底);per-group 只多一个 groups/<folder>/ 工作区目录(磁盘)+ 几行 DB。
- **配置漂移(by design)**:克隆的 `container.json` 不随前台模板更新而更新——对"各群独立 agent"这是合理的(各群可独立演化)。
- **非新安全闸绕过**:autowire 本身就是 opt-in 的"免审批";本特性只改"自动接到哪"(共享前台 → per-group 克隆),不新增绕过。
- **边界**:per-group agent 的 gateway 签名 key 跟随克隆的 `container.json`(= 前台的);若需 per-group 不同 key,运营者另跑 `configure-enterprise-gateway`。

验证:host 全绿(+8 autowire 用例:isolated 建独立 agent / 幂等 / 两群两 agent / 默认走共享前台 / DM 走共享前台 /
显式 `STRATEGY=per-group` / **自定义策略**接管目标 agent / 未知策略名失败安全回退共享前台);tsc + prettier 干净。
