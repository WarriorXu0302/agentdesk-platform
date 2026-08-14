# ADR-0054: Frontdesk 强制双 LLM Routing + Execution

- **Status**: Accepted
- **Date**: 2026-07-19
- **Decider(s)**: 用户（需求与 Spec 审批），coding agent（提案与执行）
- **Tags**: `frontdesk`, `routing`, `provider`, `llm`, `backward-compat`, `observability`

---

## Context

Frontdesk 原先只创建一个 provider。该模型同时理解意图、调用工具、选择目的地并生成回复；`classify_intent` 只记录模型已经做出的判断，不能强制路由。运营者需要动态调整意图 Prompt、让 Routing 使用轻量模型、让业务 Execution 使用更强模型，同时不改变 worker 流程或破坏既有 Claude/单 provider 部署。

约束包括：仅应用于 frontdesk 的渠道入口回合；Routing 必须无工具且无 continuation；决策必须跨 runner 与 MCP 子进程强制执行；失败只能回退到非委派动作；配置与策略集中在 `container.json`；不增加或升级依赖。

## Options Considered

- **Option A: 保留单模型并增强 `classify_intent`**。改动小，但分类仍发生在 Execution 内部，模型可先执行或选择不同目的地，无法独立配置模型与上下文。
- **Option B: Routing 仅给 Execution 建议**。可拆模型，但无法满足“强制执行”，错误或被注入的 Execution 仍能改投其他 worker。
- **Option C: runner 控制的强制双阶段**。Routing 只产出封闭 JSON 决策，控制器验证、持久化并在所有消息发送面执行同一 gate；非 `delegate` 才调用 frontdesk Execution。

## Decision

> **拍板**：选择 Option C，并由每个 frontdesk 的 `container.json.llm` 独立配置 Routing 与 Execution provider/model。

- Routing 只在 routing-enabled frontdesk 的渠道入口 chat 回合运行；worker A2A 回合不重复路由。
- Routing 输出限制为 `delegate | answer_self | clarify | reject`。控制器拥有 Prompt 加载、上下文裁剪、Zod 校验、重试、置信度、fallback、目标解析和最终执行权。
- `delegate` 由控制器直接发送到唯一验证过的 worker，不调用 frontdesk Execution；其他动作调用 frontdesk Execution，并用 outbound DB 中的共享 gate 禁止 agent 目的地。
- 非委派 Execution 只能向当前 turn 的原始 channel/platform/thread 发送；gate 在新 turn 开始前清除，崩溃残留决策不得复用。
- Routing 与 Execution 使用独立 provider 实例、模型、超时、工具面和 continuation。Claude 可独立用于任一角色；Claude Routing 为单轮、无工具/MCP/项目设置，Claude Execution 保留现有 Claude Code 行为。
- session/group 的 Execution provider override 由 host 解析并传入 runner；override 与 `llm.execution.provider` 不同时，后者的 model/transport 不参与运行。
- 本地默认 profile 为 `opencode-go/mimo-v2.5` Routing 和 `opencode-go/deepseek-v4-flash` Execution，均使用 Chat Completions。

## Consequences

- **Positive**: 路由 Prompt 可在宿主只读挂载文件中按请求动态调整；轻重模型可独立调优；决策、usage 与 Execution 通过同一 decision ID 可观测；错误路由不能由 Execution 静默覆盖。
- **Negative**: 非 `delegate` 渠道回合增加一次模型调用；runner 增加双 provider 生命周期、路由 gate 和配置复杂度。
- **Neutral / Trade-offs**: 初始上下文只含当前 post-split chat batch、live worker 名称与附件数量，不读取历史业务记忆或附件内容；失败回退只支持 `clarify/reject`；worker feedback 继续遵循 ADR-0040，仅记录、不自动重投。
- **Backward compatibility**: `llm.routing` 缺失或禁用时仍创建一个 provider、保留 `classify_intent` 与原有 Claude/OpenAI continuation 行为；`opencode-go` 是现有 OpenAI-compatible adapter 的新增别名；依赖与 lockfile 不变。

## Implementation Notes

- 完整契约与边界：`docs/specs/frontdesk-dual-llm-routing.md`
- 配置与 provider 合并：`src/container-config.ts`, `src/container-runner.ts`, `src/providers/openai.ts`
- 运行时角色与控制器：`container/agent-runner/src/provider-roles.ts`, `container/agent-runner/src/routing/`, `container/agent-runner/src/poll-loop.ts`
- 跨进程 gate：`container/agent-runner/src/routing/gate.ts`, `container/agent-runner/src/mcp-tools/core.ts`
- 本地 profile：`groups/agentdesk-frontdesk/container.json`, `groups/agentdesk-frontdesk/prompts/frontdesk-routing.md`
- 验收要求：同一 decision ID 的 usage 顺序必须显示 Routing `mimo-v2.5` 后接 Execution `deepseek-v4-flash`，并由 `pnpm chat "hello"` 获得成功回复。

## References

- ADR-0024：OpenAI provider continuation/compaction
- ADR-0026、ADR-0027：runner LLM span 与内容捕获
- ADR-0035：OpenAI credential via OneCLI vault
- ADR-0040：routing feedback recording-only
