# ADR-0055: per-user 状态作用域(stateScope)——把工作区/记忆边界对齐到会话的 owner

- 状态:Accepted
- 日期:2026-08-17
- 关联:ADR-0052(org 隔离)、ADR-0053(per-group agent)、ADR-0054(强制路由)、2026-08 架构自洽性审查

## Context

2026-08 架构自洽性审查(6 接缝全判不自洽,47 条发现)定位出一条贯穿性剪切线:
**`agent_group` 同时承担六个职责(身份/配置/记忆/工作区/租户锚/提示词组装),
而 `session` 才是算力与"文档所承诺的隔离"的单位**。文件系统永远听 agent_group 的,
承诺永远是 session 给的。

具体到本 ADR 要修的五处高危(企业默认 `session_mode: per-user` 下):

1. **共享 cwd**:每个容器的工作目录是 `/workspace/agent` = groups/<folder>(组级 RW 共享)。
   两个用户同时让 agent"生成个报告",相对路径写文件互相覆盖——A 拿到 B 的文件。
2. **共享记忆**:`CLAUDE.local.md` 组级共享,而基础提示词明确指示 agent 把
   "用户偏好、项目上下文"写进去——张三的偏好李四读得到。
3. **转录泄漏**:压缩(PreCompact)把**整段逐字对话**写进组级 `conversations/`,
   文件名只有日期+主题(无 session/user 键)——并发互覆,且每个用户的 agent
   被基础提示词指示去搜索该目录。
4. **`/home/node/.claude` 组级共享**:Claude Code 自身的项目状态、自动记忆、
   会话索引、settings hooks 全组一个命名空间——A 的自动记忆,B 的进程直接加载。
5. **continuation 指针与转录体分离**:指针 per-session(outbound.db),
   转录体在组级 `.claude-shared`,所有并发会话 RW 可见。

`docs/isolation-model.md` 把 `per-user` 卖成"keeps each employee's context isolated",
同页又承认"information will cross-pollinate through agent memory"——承诺与实现互相矛盾。

## Decision

> 引入**状态作用域(state scope)**:agent 的可写持久状态(工作区 + `.claude`)
> 不再按 `agent_group` 挂载,而是按**会话的 owner 轴**挂载。有 owner 的会话得到
> **per-user 作用域**;无 owner 的会话保持组级作用域(原行为逐字节不变)。

### 作用域解析规则(`src/state-scope.ts`)

```
session.owner_user_id 存在(per-user / per-user-per-thread / 带 owner 的 root-session a2a)
  → user 作用域:DATA_DIR/v2-scopes/<agentGroupId>/<scopeKey>/{workspace,claude}
     scopeKey = u-<slug(userId)[:24]>-<sha1(userId)[:8]>(确定性、防撞,同 ADR-0053 指纹法)

session.owner_user_id 为 NULL(shared / per-thread / agent-shared / 无 owner 的 a2a)
  → group 作用域(遗留路径,零迁移):
     workspace = groups/<folder>/           claude = data/v2-sessions/<agId>/.claude-shared/
```

关键性质:

- **同一用户跨消息组共会话际共享作用域**——(ag, user) 是 key,thread/messaging_group 不参与。
  一个人的 agent 记忆跟着人走,不按聊天室碎片化;对话状态本来就 per-session,不受影响。
  **这就是 personal agent 的物理载体**:模板层(agent_group)× 人 = 个人实例。
- **root-session a2a 继承 owner**(`resolveSession` 已如此),所以 per-user 隔离
  **穿过委派链传播**:worker 为张三干活时,写的是 worker×张三 的作用域。
- **scope 目录放 DATA_DIR/v2-scopes/,不放 groups/<folder>/ 之内**——否则混合接线
  (同组既有 shared 又有 per-user 的 messaging group)时,组级会话会在
  `/workspace/agent/scopes/` 下看到所有用户的私有状态。
- 容器内路径**一个都不变**(cwd 仍 `/workspace/agent`,`.claude` 仍 `/home/node/.claude`),
  runner 零改动——变的只是宿主侧这些路径由什么目录支撑。

### 挂载布局(变更处)

| 容器路径                                | 旧(全部会话)                    | 新(owned 会话)                     | 新(ownerless 会话)    |
| --------------------------------------- | ------------------------------- | ---------------------------------- | --------------------- |
| `/workspace/agent` RW                   | groups/<folder>                 | **v2-scopes/<ag>/<key>/workspace** | groups/<folder>(不变) |
| `/home/node/.claude` RW                 | v2-sessions/<ag>/.claude-shared | **v2-scopes/<ag>/<key>/claude**    | .claude-shared(不变)  |
| `/workspace/agent/container.json` RO    | groupDir(redacted)              | groupDir(不变)                     | 不变                  |
| `/workspace/agent/CLAUDE.md` RO         | groupDir 合成产物               | groupDir(不变)                     | 不变                  |
| `/workspace/agent/.claude-fragments` RO | groupDir                        | groupDir(不变)                     | 不变                  |
| `/workspace/agent/prompts/<f>` RO       | groupDir                        | groupDir(不变)                     | 不变                  |

即:**配置/合成产物仍来自模板层(groupDir,RO 嵌套挂载遮蔽);
agent 手写的一切(CLAUDE.local.md、conversations/、工作文件、Claude 状态)落作用域层。**
合成 CLAUDE.md 的相对引用(`@./.claude-shared.md`、`@./.claude-fragments/…`)在容器内
按 `/workspace/agent/*` 解析,作用域初始化时补齐 `.claude-shared.md → /app/CLAUDE.md`
符号链接即可,合成器不感知作用域。

### 初始化与幂等

- user 作用域首次使用时初始化(buildMounts 内,docker run 之前——bind 源目录必须先存在):
  `workspace/`(CLAUDE.local.md 空种子、conversations/、`.claude-shared.md` 符号链接)+
  `claude/`(settings.json 按 memoryMode 定 auto-memory 开关、skills/)。
- `.claude` 目录初始化逻辑从 `initGroupFilesystem` 提取为共用的 `initClaudeStateDir`,
  组级与作用域级同一套种子/修补逻辑(PreCompact hook、auto-memory 同步)。
- 技能符号链接每次 spawn 向**当前作用域**的 `claude/skills/` 同步(原本就每 spawn 同步)。

## Consequences

- **修复**:上述五处高危在 owned 会话下全部关闭——跨用户看不到彼此的 cwd 产物、
  CLAUDE.local.md、conversations/ 转录、自动记忆与 Claude 状态。
  `isolation-model.md` 的 per-user 承诺第一次与实现一致(同步更新该文档)。
- **兼容**:ownerless 模式逐字节保持原行为(路径都没变);既有部署升级后,
  owned 会话的记忆**从空开始**——旧的组级混合记忆无法按用户归因(这正是修的 bug),
  不做自动迁移;运营者可手工把明确属于某人的内容拷入其作用域。
- **诚实边界(本 ADR 不解决,后续步骤)**:
  - 同一用户多个并发会话仍共享其作用域(RW)——同人自竞写仍可能;
    第 3 步"会话内写本地、会话末蒸馏 merge"(用户已拍板 B)是正解。
  - conversations/ 文件名仍无会话键(同人并发互覆);随第 3 步一并处理。
  - **留存**:v2-scopes/ 是长命的个人状态,**有意**不进 session 清扫器;
    scope 级 TTL/审计导出属后续留存工作(与"转录无人回收"发现同族)。
  - memoryMode / 网关记忆维度、frontdesk role 列(用户已拍板 A 分工、C 加列)
    分别在第 3、2 步落地。
- **资源**:每 (agent_group, 活跃用户) 一个作用域目录;容器数不变(仍随会话)。

## 验证

- `state-scope.test.ts`:解析规则(owned/ownerless、**a2a root-session 走真实
  `resolveSession`**)、确定性 key、防撞、同用户跨 mg 同作用域、初始化幂等、
  符号链接与 settings 种子、owned+routing 的 prompts RO 遮蔽、指令通道端到端。
- `container-runner` 挂载集成:owned 会话 `/workspace/agent` 与 `/home/node/.claude`
  指向作用域目录且 RO 遮蔽仍指向 groupDir;ownerless 会话与旧布局逐项相等。
- 全套本地 CI(tsc×2 / eslint / prettier / vitest / bun / audit)+ 真实 CI 双 job。

## 更新(2026-08-17):合并前红队修正(5 视角 × 对抗验证,15 条确认)

初版有一个设计盲点和若干接缝,合并前已全部修复:

1. **运营者种子指令丢失(major,5 个视角独立命中)**。`CLAUDE.local.md` 实为**双职**:
   既是模板产物(init-enterprise-topology / create_agent / init-cli-agent 把前台人设、
   classify_intent 协议、worker 守则种进去),又是实例产物(agent 写记忆)。初版把整个
   文件划入实例层、给 user 作用域种空文件——企业默认拓扑(per-user + root-session worker)
   下**所有 owned 会话裸启动**。修正:职责拆分——种子指令改落 **`groups/<folder>/instructions.md`
   (模板层)**,合成 CLAUDE.md 条件导入 `@./instructions.md`,并对**所有**会话 RO 遮蔽
   (agent 不得改写自己的人设,这顺带比旧行为更强);`CLAUDE.local.md` 自此纯为记忆。
   **存量部署**:旧种子仍在组级 CLAUDE.local.md 里(ownerless 会话继续自动加载);
   **重跑 init-enterprise-topology 即补齐 instructions.md**(幂等,缺文件才写)。
2. **升级中会话 continuation 硬失败(major)**。存量 owned 会话的 continuation 指向旧
   `.claude-shared` 下的转录,升级后首条消息会以原始 SDK 错误回给用户并吞掉该消息。
   修正(runner,普适自愈):poll-loop 捕获 `isSessionInvalid` 时**同回合清掉 continuation
   并重试一次 fresh**(stale 错误发生在会话装载阶段、模型尚未产出,重试安全),
   不再把用户的回合烧在错误上。
3. **删组遗留 v2-scopes 孤儿 + ADR-0053 确定性 id 复活已删状态(major)**。
   `delete-cli-agent` 现在同时删除 `data/v2-scopes/<ag.id>`。
4. **DM 面泄漏(码根)**:autowire p2p 接线从 `shared` 改为 **`per-user`**——DM 本就
   一人一 messaging group,但 `shared` 使 owner 为 NULL → 所有 DM 用户共用组作用域。
   per-user 让 DM 与该用户的群聊 lane 共享同一个人作用域(记忆跟人走;DM 正是
   personal agent 的主战场)。只影响新接线,存量 wiring 行不动。
5. **悬空符号链接误判(minor)**:`.claude-shared.md` 指向容器路径,宿主上悬空;
   `existsSync` 会跟随链接永远答"无"→ 每次 spawn 重试 symlink 打 EEXIST 警告。
   改用 `lstat`(与 claude-md-compose 的既有做法一致)。
6. 文档修正:isolation-model 的 skills 措辞(技能**选择**落作用域 claude/skills 符号链接,
   技能**内容**是共享 RO /app/skills)与 DM 建议(企业场景 DM 用 per-user);
   enterprise-multi-user 的播种描述改指 instructions.md。
