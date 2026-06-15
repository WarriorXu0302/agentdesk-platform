# ADR-0047: agent eval / replay 回归门(对标 Rasa/ADK,落地 benchmark 清单 #2)

- **Status**: Accepted
- **Date**: 2026-06-15
- **Decider(s)**: 用户(platform owner);coding agent(对标研究 + 提案 + 执行)
- **Tags**: `testing`, `eval`, `agent-runner`, `quality-gate`, `ci`

---

## Context

对标 GitHub 上的成熟 agent 框架(LangGraph / OpenAI Agents SDK / AutoGen·MS Agent Framework / CrewAI / Temporal / Restate / Inngest / DBOS / E2B / Daytona / Modal / Cloudflare / Letta / Mem0 / Zep / Dify / Botpress / Rasa / n8n)后,综合清单的**头部可吸取项之一**是:**agent 质量的 eval/replay 回归门**(Rasa Pro 的 YAML 测试用例 + 按类型断言、Google ADK 的 evalset + `adk eval`/pytest 进 CI)。这是维护者明确承认的缺口("no eval/replay harness for agent quality")。

AgentDesk 有一个独特优势让这件事**几乎白捡**:**万物皆消息行**——一个 seed 好的 `inbound.db` + 跑出来的 `outbound.db` **本身就是**一条可重放、可断言的轨迹,无需任何新埋点。而且 `container/agent-runner/src/integration.test.ts` 已经证明 poll-loop 能**在进程内(bun、无 Docker)**驱动:seed inbound → `runPollLoop` + `MockProvider` → 断言 outbound。

## Options Considered

- **Option A:引入外部 eval 框架/真模型跑全链路**(类 ADK evalset 跑真 agent)。优点:测真实分类质量。缺点:需真 LLM(成本/非确定/CI 凭证)或 Docker(本仓 e2e 已用 Docker,但本地无 Docker、慢),且与"无 Docker 本地可跑"目标冲突。
- **Option B(选中):自建薄 harness,默认 PLUMBING 模式**。声明式 JSON 用例 seed inbound + destinations → 进程内跑**真 poll-loop** + 脚本化 MockProvider → 用小词汇表断言 outbound(delegates_to / delivers_to / text_* / in_reply_to / thread_id / count / no_output)。本地 `bun test` 可跑、进 CI(容器 `bun test` 步已存在)。**QUALITY 模式**(换真 provider + LLM-judge 测分类质量)作为同形用例的可选扩展、文档化、不阻塞。
- Option B 复用既有 integration.test.ts 模式,零新依赖,契合单机/无 Docker。

## Decision

> **拍板**:选 Option B。`container/agent-runner/eval/` 下:`harness.ts`(runEvalCase + 断言引擎)、`cases/*.json`(声明式用例)、`eval.test.ts`(glob 用例 → 进 `bun test` CI 门)、`README.md`。

**为什么 PLUMBING 模式仍有价值**:脚本化 mock 不能调 MCP 工具,但 a2a **委派是可观测的**——`<message to="worker">` 打到 `type:'agent'` destination 会被 poll-loop 解析成 `channel_type='agent'` 出站行(与真 `send_to_agent` 同),正是 misroute/nack 反馈(ADR-0040)关心的那条路由。所以 PLUMBING 模式就能守住"给定消息 X,frontdesk 委派到 worker Y / 回到源渠道 / 扇出"这类路由回归;LLM 分类质量留给 QUALITY 模式。

落地用例(4 条):reply-to-channel(显式回源)、delegate-to-worker(a2a 委派路由,头牌)、bare-text-falls-back-to-source(裸文本兜底)、broadcast-fan-out(双目的地扇出)。

## Consequences

- **正向**:把"录一对 DB = 可断言轨迹"变成**声明式回归门**;新增回归只需往 `cases/` 丢一个 JSON,无 TS 样板;misroute/nack 这类路由漂移在 CI 被挡在 prod 之前。容器 303 测试(+5)全绿,typecheck 干净。
- **边界**:PLUMBING 模式测的是 runner 的确定性路由/投递逻辑,**不是** LLM 分类质量(那需 QUALITY 模式 + 真 provider/LLM-judge,文档已标)。脚本化 mock 不覆盖 MCP 工具副作用(classify_intent/gateway 等系统动作),那些留给真 provider。
- **不变量**:纯新增测试设施,无 core/契约/host 改动;不碰身份链/三-DB/记忆栅栏。LLM-judge 扩展须沿用 ADR-0033 的不可信数据纪律。
- **后续(同清单)**:#1 跨跳幂等键、#4 温池、#3 写侧记忆 provenance、#5 后端 A.U.D.N. 调和——按价值/工作量逐条评估;eval 门正好成为这些改动的回归保险。
