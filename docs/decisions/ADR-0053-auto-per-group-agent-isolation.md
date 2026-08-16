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
`container/CLAUDE.md` + 技能片段),**技能在 spawn 时按 `container.json` symlink 同步**。所以"克隆前台"要拷的是
**`container.json` 及其引用的 `prompts/` 资产,外加把前台的委派边镜像进 `agent_destinations`**(原文写"只需拷
一个 container.json",被证明漏了两个依赖——见文末 2026-08-16 更新);CLAUDE.md / 技能会自己长出来,记忆全新。

## Decision

> 把"群 → 哪个 agent_group"的决策做成**可插拔策略表**(registry),而非写死的布尔开关。

`GroupAgentStrategy = (input: { frontdesk; mg; event }) => AgentGroup`,用 `registerGroupAgentStrategy(name, fn)`
注册、`listGroupAgentStrategies()` 列举。内置两条:

- **`shared`**(默认)—— `({ frontdesk }) => frontdesk`:所有群接到同一共享前台(**逐字保持原行为**)。
- **`per-group`** —— `({ frontdesk, mg }) => resolveOrCreatePerGroupAgent(frontdesk, mg)`:**新群** autowire 时,用从
  `platform_id` 派生的确定性 folder(`<frontdeskFolder>-g-<slug>-<fp>`,`<fp>`=`sha1(platform_id)[:8]` 指纹)
  **resolve-or-create** 一个**克隆自前台**的 per-group agent_group(`initGroupFilesystem` + 拷前台
  `container.json`+`prompts/` + 镜像委派边,见 2026-08-16 更新),
  把群接到**它**。**指纹是防撞**:slug 会小写并把非字母数字段折叠成 `-`,`oc.sales` 与 `oc_sales` 会撞同一 slug;
  指纹保证不同 `platform_id` 绝不落到同一 folder(否则两群静默共享一个 agent + 记忆,正是本模式要防的跨群外溢)。

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

验证:host 全绿(+9 autowire 用例:isolated 建独立 agent / 幂等 / 两群两 agent / **同 slug 不同 `platform_id` 仍得独立
agent(防撞)** / 默认走共享前台 / DM 走共享前台 / 显式 `STRATEGY=per-group` / **自定义策略**接管目标 agent /
未知策略名失败安全回退共享前台);tsc + prettier 干净。

## 更新(2026-08-16):克隆完整性修正

原文"克隆只需拷 container.json"漏了两个**随 config 走的依赖**,与 ADR-0054(强制双 LLM 路由)组合时会静默瘫痪:

1. **`prompts/`**:ADR-0054 的 `llm.routing.promptFile` 必须位于**克隆自己的** `prompts/` 之下
   (`resolveRoutingPromptMount` 强制,防路径逃逸)。克隆缺它 → provision/接线/审计全走成功路径,
   但每次 spawn 在 buildMounts 抛错——**容器永远起不来,且失败静默、无限重试**。
   修正:`prompts/` **先于** `container.json` 拷贝;prompts 拷贝失败则连 container.json 一起跳过,
   克隆回退到**可启动的默认值**,而不是继承一份它满足不了引用的配置。
2. **委派边**:config 走文件系统,可委派性走 DB(`agent_destinations`,键是 `agent_group_id`)。
   克隆拿到全新 id → **零边** → 路由判 `delegate` 却无授权目标(白烧路由调用后只能 clarify)。
   修正:镜像前台的 agent 出边(同 local name),并给每个 worker 一条**回克隆的应答边**
   ——a2a ACL(`routeAgentMessage` 的 `hasDestination`)**没有"回复豁免"**,worker 的答复也是一次
   跨 agent 发送。双向授权与 init-enterprise-topology / `create_agent` 的既有惯例一致;
   应答边以克隆 folder 命名(确定性派生,天然每克隆唯一,不会在 worker 上撞名)。

修正前已创建的损坏克隆**不自动治愈**(resolve 对已存在的 folder 早退):删掉克隆的 groups/<folder>/
与 `agent_groups` 行后重新触发,或手工补拷 `prompts/` + 补边。
