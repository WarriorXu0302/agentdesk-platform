# PR #22 Routing 核心修复实施计划

**目标：** 在提交 `1761570` 的基础上修复三个已验证的 Review 问题：每个用户 trigger 必须得到新的 Routing 决策；直接委派必须保留附件字节；普通出站工具操作不得绕过当前 Routing 决策。

**架构：** 用户 `trigger=1` 是严格的回合边界。正在执行的任务不得领取、注入或取消新的用户 trigger；它应保持 pending，待当前 Session 执行通道完成后再由外层循环路由。直接委派复用现有的 `outbox → Host A2A copy → Worker inbox` 文件传输契约。普通 MCP 出站操作在写入面向外部收件人的行之前必须校验当前 Routing 策略。

## 全局约束

- 保留现有 Session continuation 模型；新的用户 trigger 不得使用 `query.push()`。
- 新 trigger 绝不能继承前一回合的 Routing Gate 或路由提示词。
- 不改变 Host ACL/consent 语义；Routing 策略是逐回合的额外边界。
- 除非有明确策略决定，否则保留既有的非用户系统响应和定时任务行为。
- 容器 Runner 与 Host A2A 路由均使用稳定、确定性的测试覆盖。

### 任务 1：强制以 trigger 划分 Routing 回合

**文件：** `container/agent-runner/src/request-identity.ts`、`container/agent-runner/src/poll-loop.ts`、`container/agent-runner/src/request-identity.test.ts`、`container/agent-runner/src/routing/poll-loop-routing.test.ts`

**依赖：** 现有 `trigger` 契约、`splitBatchByTurn`、Routing Gate 生命周期。

**产出：** 按 trigger 感知的批次切分和活动 query 交接逻辑，使每个新到的用户 trigger 保持 pending，交由外层循环单独路由。

**步骤：** 在身份切分前，于初始批次的第二个 `trigger=1` 处切分。活动 query 中，在领取行或运行预任务脚本前发现待处理用户 trigger 时让它保持 pending；既不注入当前执行，也不取消当前执行。仅在安全时保留非 trigger 系统提醒。

**验收：** 同一用户、同一 thread 的消息不会因用户 trigger 调用 `query.push()`，而会分别执行两次 Routing。单次轮询中收集的多个 trigger 分属不同回合。已累积的 `trigger=0` 上下文仍附着到后续 trigger。

### 任务 2：在直接委派中保留附件

**文件：** `container/agent-runner/src/poll-loop.ts`、`container/agent-runner/src/formatter.ts`、`container/agent-runner/src/routing/poll-loop-routing.test.ts`，以及必要的 Host A2A 路由测试。

**依赖：** 现有 `send_file` outbox 契约和 Host 的 `content.files` 转发行为。

**产出：** 直接委派 payload 会在对应出站消息 outbox 中暂存入站附件字节，并在 JSON envelope 中声明文件名。

**步骤：** 暂存前先生成出站消息 ID；校验附件源文件名，只能从源消息对应的 inbox 目录复制到该出站消息的 outbox。委派文本不再渲染源 Session 的本地附件路径。通过已有的 `files` 数组声明暂存文件，使 Host 转发后生成目标本地 `attachments`。

**验收：** 被委派附件的内容在目标 inbox 中可读且字节一致；委派文本不含源 inbox 路径。缺失或不安全的输入不会被声明为可传输文件。

### 任务 3：集中执行普通出站操作的 Routing 策略

**文件：** `container/agent-runner/src/mcp-tools/*`、`container/agent-runner/src/routing/gate.ts` 或聚焦的策略/emitter 模块，以及路由工具测试。

**依赖：** 活动 Routing Gate 与现有消息输出 writer。

**产出：** 所有普通、面向外部收件人的 MCP 输出都执行 Routing 校验，包括聊天、文件、消息修改、Roster 操作和交互输出。

**步骤：** 按目标与副作用分类每个工具操作；写出消息或开始外部副作用前执行当前 Routing 决策校验。保留范围明确的 Runner 内部/audit 行，不把它们视为普通 MCP 投递。

**验收：** 限制性的 Routing 决策会阻止所有指向未授权目标或产生未授权外部副作用的普通 MCP 操作，包括编辑、反应、Roster 私信和 Roster 邀请；允许来源会话回复和选定的委派目标继续工作。

### 任务 4：验证与交付

**文件：** 已修改测试，以及本计划（若验证改变范围）。

**依赖：** 任务 1–3 的完成结果。

**产出：** 针对性测试结果、相关完整包检查，以及提交前可供审阅的干净差异。

**步骤：** 每个任务后运行聚焦测试；随后运行 Runner typecheck/tests 和受 A2A 交付影响的 Host 测试。检查最终差异，避免意外扩大范围。

**验收：** 所有选定测试通过；在用户审阅已完成差异前不创建最终 git commit。
