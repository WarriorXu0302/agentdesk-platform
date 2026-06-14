# ADR-0042: 待处理交互请求的带外取消(out-of-band cancel)

- **Status**: Accepted
- **Date**: 2026-06-14
- **Decider(s)**: 用户(平台 owner,提案 + 验收);coding agent(设计 + 执行)
- **Tags**: `interactive`, `routing`, `session-isolation`, `ux`, `backward-compat`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

业务侧 review(`docs/business-optimization-roadmap.md` 6.6,价值 中):`ask_user_question`
发出的待处理交互卡(尤其审批卡)一旦误发(错单号/错收件人),用户**无法即时止住**——只能
等 agent 跑完再请求回滚,审批工作流尤其糟。现状:agent 可在 options 里塞 Cancel 按钮,但
**无渠道级、无带外的取消命令**。

`ask_user_question`(container)是阻塞调用:写卡到 outbound.db,然后每秒轮询 inbound.db 找
`question_response` 系统消息(host 在按钮点击时经 `handleInteractiveResponse` 写入)。`pending_questions`
表(host)记录活动问题。

决策时的 load-bearing 约束:**保持 user/session 隔离**(改路由逻辑不得削弱);**飞书群聊
写权限保守**;**host 建立的身份是权威**,不信 agent/sender 自报字段;**三库单写**(host 写
session inbound.db)。本设计经一轮 **design + 对抗评审 workflow** 核实。

## Options Considered

- **Option A — reuse-expiry 信号**:复用已有过期/不可操作路径。但对抗评审发现 6.2 过期路径
  **只通知用户、不删 pending_questions、不给 container 信号**,所以没有可复用的"取消"信号——
  取消是全新的。
- **Option B — explicit cancel,返回 err()**:container 把取消当 `err()` 返回。被**驳回**:
  err() 与超时/真错误共用返回类型,现有容器 retry 逻辑无法区分"别重试(取消)"与"可重试"——
  比 ok(sentinel) 更脆弱。
- **Option C(采纳)— ok(sentinel) + owner_user_id 限定**:host 用 `__cancelled__` sentinel
  经**与按钮点击相同**的 `question_response` 路径解析用户自己的待处理问题;container 经既有成功
  路径返回 sentinel,agent 据约定回滚。取消按 `sessions.owner_user_id` 限定到发送者本人。

## Decision

> **拍板**:选 Option C。带一个**前置重构**与一条**结构性隔离**机制。

1. **前置重构(独立 commit)**:`router.ts` 的 `setMessageInterceptor` 从**单槽**改为**有序数组**。
   原本单槽会被 permissions 模块的自由文本捕获拦截器占用,再注册一个会**静默覆盖**它(对抗评审标记
   为 day-1 回归)。改为按注册序遍历,第一个返回 true 的消费消息。
2. **结构性隔离(取消的全部安全机制)**:`findCancelablePendingQuestions(userId)` 用
   `JOIN sessions ON s.owner_user_id = ?`。在 shared / per-thread / agent-shared 会话里
   `owner_user_id` 为 NULL,查询**零命中**——取消在那里是结构性 no-op,一个用户**永远无法**取消
   另一个用户的请求,无需额外守卫代码。取消因此仅在 per-user / per-user-per-thread 会话生效。
3. **信号形状**:写与按钮点击**同一** `question_response` 形状,`selectedOption: '__cancelled__'`
   + additive `cancelled: true`。container 经既有成功路径 `ok('__cancelled__')` 返回(**不用
   err()**),向后兼容(旧读者忽略未知字段)。`wakeContainer` 必须调用(否则 container 轮询到下一拍)。
4. **保守拦截**:仅匹配**精确整条消息** token(`/cancel`、`cancel`、`取消`、`停止`,绝不子串),
   且**仅当发送者确有可取消的待处理问题时**才消费消息——否则透传给 agent(所以"cancel my 3pm
   meeting"正常路由,且无待处理问题时 bare "cancel" 也透传)。任何错误降级为透传,绝不打断路由。

## Consequences

- **Positive**:
  - 用户可即时止住误发的交互/审批请求;agent 经 `__cancelled__` 约定干净回滚。
  - 跨用户取消**结构上不可能**(owner_user_id JOIN 零命中),零额外守卫。
  - 复用既有 `question_response` 解析线 + `resolvePendingQuestion`(从 handleInteractiveResponse
    抽出),无新跨边界契约;三库单写不变(host 写 session inbound.db,同按钮点击)。
  - 拦截器链式化让 permissions 自由文本捕获与 cancel 共存(修了潜在 day-1 回归)。
- **Negative / 已知限制**:
  - **shared/agent-shared 会话取消是永久 no-op**(owner_user_id 为 NULL),直到给 pending_questions
    加 per-asker 列。这类会话的用户键入取消会收到"无可取消"——可接受(隔离优先),记录在此。
  - `pending_questions` 仍无 TTL/清扫(既有缺口,本 ADR 不修):超时/废弃的行会累积。建议后续
    给 host-sweep 加 `expireStalePendingQuestions`(镜像 `expireStalePendingApprovals`)。
- **Neutral / Trade-offs**:
  - agent 自塞的 Cancel 按钮(value='__cancelled__')走正常点击路径,由 handleInteractiveResponse
    解析、container 返回 `ok('__cancelled__')`——天然正确;依赖工具描述里的约定让模型据此回滚。
  - 6.6 建议的"扩 schema 加 role:'cancel' 渲染红按钮"**未做**:agent 已可塞 Cancel 选项,渲染样式
    是渠道层 nice-to-have,价值低于带外取消本身。

## Implementation Notes

- 落地文件:
  - `src/router.ts` — `setMessageInterceptor` 单槽→数组(前置 commit);新增 `resolveSender(event)`
    导出(让拦截器用 host 建立的身份,不碰 agent 自报)。
  - `src/db/sessions.ts` — `findCancelablePendingQuestions(userId)`(owner_user_id JOIN)。
  - `src/channels/ask-question.ts` — `CANCEL_SENTINEL = '__cancelled__'`。
  - `src/modules/interactive/index.ts` — 抽出导出 `resolvePendingQuestion(session, pq, selectedOption,
    userId, {cancelled?})`,handleInteractiveResponse 复用之。
  - `src/modules/interactive/cancel.ts` — 新拦截器(精确 token + owner 限定 + ack + try/catch→透传);
    `src/modules/index.ts` 在 permissions **之后** import(name-capture 优先)。
  - `container/agent-runner/src/mcp-tools/interactive.ts` — ask_user_question:`cancelled===true ||
    selectedOption==='__cancelled__'` 分支返回清晰"已取消、停止回滚"串;工具描述补 `__cancelled__` 约定。
- 依赖的上游:`handleInteractiveResponse`(同解析线)、permissions 的 `setSenderResolver`(身份)。
- 后续验收点:host `pnpm typecheck` + 全套 vitest(含 cancel.test.ts:per-user 取消、shared no-op、
  跨用户不可取消、精确 token、错误透传)、container tsc + 全套 bun 测试绿。

## References

- 关联审计:`docs/business-optimization-roadmap.md` 6.6
- 设计 + 对抗评审 workflow:design-cancel-pending(2 map → reuse-expiry vs explicit-cancel → 安全合成;
  合成采 ok(sentinel)+owner_user_id 限定,驳回 err(),并标出单槽拦截器 day-1 回归)
- load-bearing 不变量:`CLAUDE.md`(session 隔离、保守群聊写、host 身份权威、三库单写)
