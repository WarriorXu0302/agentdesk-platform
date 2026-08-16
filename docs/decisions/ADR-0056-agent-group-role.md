# ADR-0056: agent_groups.role — 把"前台/worker"从约定建模成数据

- **状态**:Accepted
- **日期**:2026-08-17
- **关联**:ADR-0053(per-group 克隆)、ADR-0054(强制双 LLM 路由)、ADR-0055(per-user 状态作用域);架构自洽性审查(2026-08)接缝 5

## Context

"这个 agent group 是不是前台?"在平台里由**四个互不相关的载体**回答,彼此没有任何关联校验:

1. **folder 名**(autowire 用 `ENTERPRISE_FRONTDESK_FOLDER` / 品牌默认名解析前台);
2. **`container.json` 的 `llm.routing.enabled`**(ADR-0054 的强制路由机器只看这个);
3. **`agent_destinations` 里有没有出边**(可委派性);
4. **init-enterprise-topology 里 script-local 的 `AgentRole` 类型**(只用来选资源缺省)。

后果:没有任何校验**能**存在——"worker 被误配了路由"“配置的前台其实是个 worker”都无从检测。
ADR-0054 把一整套强制机器建在一个**数据模型里不存在的概念**上;ADR-0053×0054 的撞车
(克隆漏 prompts,已修于 c2f4c90)正是这类"约定漂移"的实例。

同期(2026-08 自洽性审查)还确认:ownerless 布局下 `prompts/` 通过组目录 RW 挂载**可被 agent 改写**,
只有当前激活的路由提示词单独钉了 RO——模板层"只读"承诺不完整。

## Decision

> 给 `agent_groups` 加一列 `role TEXT`('frontdesk' | 'worker' | NULL),
> 让拓扑角色成为**可校验的数据**;并把 `prompts/` 整目录纳入模板层 RO 遮蔽。

**迁移(036,行为保持)**:nullable ALTER,无重建;NULL = 未分类(存量行、独立/CLI agent)。
存量部署**重跑 init-enterprise-topology 即打戳**(ensure 幂等,复用时也校正角色——拓扑脚本是角色权威)。

**写点**:

- init-enterprise-topology:前台 'frontdesk'、worker 'worker'(script-local `AgentRole` 从此接到真列);
- `create_agent`(a2a 孵化):'worker'(被委派的专家,定义使然);
- ADR-0053 per-group 克隆:**逐字继承**前台的 role(NULL 保持 NULL);
- init-cli-agent:不打戳(独立 agent 两者皆非,NULL 诚实)。

**读点(强制/校验,NULL 一律按 legacy 放行)**:

- **spawn 闸(buildMounts)**:`role='worker'` 且 `llm.routing.enabled` → **拒绝启动**,错误信息给出两条修法。
  worker 开路由是纯矛盾:路由是前台机器(ADR-0054),worker 开了会把自己的 a2a 回复挡成 opaque、
  在 task 回合上白烧路由调用。
- **autowire 角色 sanity**:解析出的"前台"若 `role='worker'` → 响亮 warn(不拒绝)。
- **委派隐私降级观测**:owned 源会话落入 `agent-shared` 目标 lane 时,**每边一次** warn
  (该 hop 之后用户隔离终止——所有用户共享一个会话/容器/(ADR-0055)状态作用域),
  并附修法(目标 container.json 设 `a2aSessionMode='root-session'`)。不拒绝:存量拓扑依赖共享 worker。

**模板加固**:`groups/<folder>/prompts/` 存在即整目录 RO 遮蔽到 `/workspace/agent/prompts`
(owned 作用域顺带获得全套模板提示词的读视图);既有的单文件路由挂载原样叠加在上。

## 不做什么(边界)

- **role 不进任何授权判定**——访问闸(ADR-0052)、网关 authz、身份链一概不读它。
  它是拓扑元数据,不是权限轴;把它掺进 authz 会制造第二条平行授权路径。
- 不自动回填存量行(folder 名启发式会误判);升级路径 = 重跑拓扑脚本。
- 不强制"前台必须有出边"(合法的引导期状态);那留给拓扑脚本自身的输出。

## Consequences

- "frontdesk"第一次成为**可查询、可校验**的概念:`SELECT * FROM agent_groups WHERE role='frontdesk'`。
- 四载体收敛为一列 + 三个读点;后续(第 3 步蒸馏、监督 agent)有了可靠的拓扑地基。
- 新增列 nullable、全读点 legacy 放行 → 升级零行为变化,直到操作员重跑拓扑脚本打戳。
- spawn 闸是本 ADR 唯一的硬拒绝,且只拒绝"显式 worker + 显式路由"的确定矛盾。

## 验证

- `agent-role.test.ts`:role round-trip 与 NULL 缺省、幂等打戳、worker×routing 拒绝、
  NULL/frontdesk×routing 放行、无路由 worker 不受影响、prompts/ RO 遮蔽(有/无目录两态)。
- `enterprise-autowire.test.ts`:克隆逐字继承 role。
- schema-drift 守卫覆盖迁移 036 与 schema.ts 的一致性。
- 全套本地 CI(tsc×2 / eslint / prettier / vitest / bun / audit)+ 真实 CI 双 job。
