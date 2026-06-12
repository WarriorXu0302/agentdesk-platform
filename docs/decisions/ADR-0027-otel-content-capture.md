# ADR-0027: OTel 全明文 trace 内容捕获（opt-in，默认关）

- **Status**: Accepted
- **Date**: 2026-06-12
- **Decider(s)**: User（明确要求"不脱敏、上完整明文"并批准），coding agent（提案 + 执行）
- **Tags**: `observability`, `tracing`, `phoenix`, `opentelemetry`, `content-capture`, `privacy`
- **Supersedes**: None
- **Superseded by**: None

---

## Context

ADR-0026 落地了 runner 三类 span（`agent.turn` / `provider.request` /
`mcp.<group>.<tool>`），但**显式只做结构可见，不上明文内容**：LLM 只带
model + token，tool 只带 `tool.name` + **脱敏**的 `tool.parameters`（仅 key
形状，见 `observability/redact.ts`），并把"上明文"列为**独立后续 wave**。
ADR-0026 当时的措辞是：上明文**必须**与 ADR-0007 R16 全量 redaction（raw
token / cookie / JWT / credential / unbounded prompt / ERP payload 的
omit/hash/truncate + `attribute.redacted=true`）**同批交付**，否则视为违反。

本 ADR 是 ADR-0026 预留的"上明文"后续 wave，但**有意偏离**上述 redaction
前置条件。触发诉求：运营者要在自有内网 Phoenix 里把 trace 渲染成**内容可读
的 LLM/TOOL trace** —— 看见每轮真实的用户输入、模型 input/output messages、
工具实际参数与返回，而不只是 token 计数与脱敏摘要。用户**明确要求不脱敏、
上完整明文**。

决策时的已知约束（load-bearing invariants，不可削弱）：

- **Observability 只读**：内容捕获只能**读**消息 / 事件去填 attribute，
  绝不能改 message flow / 身份链 / 三库单写。
- **三库单写**：内容只进 span attribute（经 OTLP 出容器），**不得**额外
  写任何 SQLite；现有 `kind='llm-usage'` 旁路 outbound 行不变。
- **保守默认**：开源、业务无关的平台基线默认**不**把任何业务正文上链。
- **ADR-0026 单 span 不变**：`provider.request` 仍是每个 `usage` 事件一个
  span，不得为了上内容而重复建第二个 LLM span。

## Options Considered

- **Option A**：维持 ADR-0026 立场 —— 上明文必须先做完 ADR-0007 R16 全量
  redaction，二者同批。最稳、最合规，但工作量大（要把 prompt/PII/credential/
  ERP payload 的 omit/hash/truncate 全做对），且与用户"就是要看完整明文"的诉求
  正相反。
- **Option B（选中）**：内容捕获做成 **flag 门控 + 完整明文**：
  `OTEL_CAPTURE_CONTENT` **默认关**；关时 = 现状（只元数据，与 ADR-0026 后、
  本 ADR 前**逐字节一致**）；开时上**完整明文、不做任何脱敏**，仅保留一个
  **防 OTLP 导出器崩溃的硬上限**（单 attribute 50000 字符，超出截断 +
  `<truncated>` 标记）。把"是否上明文 + 合规责任"交给运营者显式选择。
- **Option C**：永远不上明文，只靠 token + 脱敏摘要。零隐私风险，但无法满足
  "trace 内容可读"的核心诉求，且 Phoenix 的 LLM-native UI（input/output
  messages 渲染）形同虚设。

## Decision

> **拍板**：选 Option B —— opt-in 全明文 trace 内容捕获，`OTEL_CAPTURE_CONTENT`
> 默认关。

这是对 ADR-0026 / ADR-0007 R16 "上明文必须配全量 redaction" 立场的**有意
偏离**，其正当性建立在三个同时成立的条件上：

1. **默认关 + 仅元数据为默认**：开源基线开箱即为保守默认（关）。关闭态行为与
   本 ADR 之前**完全一致** —— `agent.turn` 只 `provider`/`channel.type`，
   `provider.request` 只 `llm.model_name`/token，`mcp.*` 只 `tool.name` +
   `redactedParamSummary` 的脱敏摘要、**无** `tool.output`。零业务正文上链。
2. **运营者显式选择 + 自担合规**：开启需要运营者在自己的部署里把
   `OTEL_CAPTURE_CONTENT=true` 显式打开。运营者拥有自己的 Phoenix 实例与其中
   数据，是否把聊天正文 / LLM 消息 / 工具参数明文写进自己的 trace 后端，是
   运营者的合规判断与责任，平台不替其代决。
3. **硬上限不是脱敏**：开启态对**每一个**内容 attribute 过一个 50000 字符
   硬上限（`capContent`，`observability/tracer.ts`）。这**纯粹**是为了防止一个
   病态大值（多 MB 粘贴文档 / 巨大工具返回）撑爆 OTLP 导出器 payload 上限导致
   整批导出失败 —— 是**运维 crash-guard**，**不是** redaction：不 scrub、不
   hash、不 omit key，被截断的前缀是**逐字明文**，且只在超限时追加
   `<truncated>` 让读者知道尾部被切。**截断 ≠ 脱敏**，本 ADR 不声称做了任何
   隐私处理。

> **明确记录**：开启 `OTEL_CAPTURE_CONTENT` 后，用户聊天正文、LLM 完整
> input/output messages、工具调用参数与返回都会以**明文**写入 trace 并经 OTLP
> 导出到 Phoenix。这是 ADR-0007 R16 redaction 立场的偏离，理由如上三条。
> redaction 工具（`redact.ts`）**保留**，继续服务关闭态的 `tool.parameters`
> 脱敏摘要。

## 开启时三类 span 上什么（实现要点）

flag 单点读取：`captureContentEnabled(env)`（`observability/tracer.ts`，
`env.OTEL_CAPTURE_CONTENT === 'true'`，**只**认字面量 `'true'`）。

1. **`agent.turn`（AGENT）**（`poll-loop.ts`）：
   - `input.value` = 本轮 prompt 全文（`processQuery` 入参，由
     `runPollLoop` 透传）+ `input.mime_type='text/plain'`；
   - `output.value` = 最终 `result` 文本全文（`runQuery` 在
     `type==='result'` 事件记下 `lastResultText`，经 `QueryResult.resultText`
     回到 `processQuery`，在 turn span 仍 active 时 setAttribute）+
     `output.mime_type='text/plain'`。
2. **`provider.request`（LLM）**（`poll-loop.ts` 的 `usage` 事件分支）：
   - 内容**不**在 usage 事件里天然存在，故在 `providers/types.ts` 的 `usage`
     事件上**可选**新增 `inputMessages?: LlmMessage[]` / `outputText?: string`
     字段，**仅当** `captureContentEnabled()` 时由 provider 填充。
   - `openai.ts` 在 push usage 时，把本次调用送给模型的 transcript 经
     `transcriptToLlmMessages`（复用 `transcriptToChatMessages` 归一化为
     role+content）填入 `inputMessages`，把 `extractOutputText(response)` 填入
     `outputText`。
   - poll-loop 写成 OpenInference：
     `llm.input_messages.<i>.message.role` / `.content`、
     `llm.output_messages.0.message.role`/`.content`、`output.value` +
     `output.mime_type`。
   - 仍是 ADR-0026 的**单 span**：内容挂在既有 usage→`provider.request` 上，
     **没有**新建第二个 LLM span。
   - **已知限制（不变）**：claude provider 不发 `usage` 事件，本批仍看不到其
     内部 LLM 调用内容 —— 与 ADR-0026 一致，非本 ADR 回归。
3. **`mcp.<group>.<tool>`（TOOL）**（`mcp-tools/server.ts` handler）：
   - 开启时 `tool.parameters` = `JSON.stringify(request.params.arguments)`
     **全文**（取代关闭态的 `redactedParamSummary` 脱敏摘要）；
   - 开启时新增 `tool.output` = 工具结果文本全文
     （`toolResultToText` 拼接 text blocks / JSON）；
   - 关闭时维持现状：脱敏摘要、**无** `tool.output`。
   - MCP server 是**独立进程**，故 `OTEL_CAPTURE_CONTENT` 也经
     `container/agent-runner/src/index.ts` 的 MCP server env 透传进去。

所有内容 setAttribute 一律先过 `capContent`（50000 字符硬上限）。

## host 注入（端到端门控）

`src/container-runner.ts` 的 `buildRunnerTracingEnvArgs`：在注入 `OTEL_*`
（traceparent / endpoint / disabled）时，**当且仅当** host env 设了
`OTEL_CAPTURE_CONTENT` 才把它原样透传进容器。host 未设 => 容器内
`captureContentEnabled()` 为 false => 全程元数据-only，与本 ADR 前一致。

## Consequences

- **Positive**：开启后 Phoenix 能把 trace 渲染成内容可读的 LLM/TOOL trace
  （真实用户输入 / 模型 input-output messages / 工具实参与返回），满足"trace
  内容可读"主诉求；门控让开源基线保持保守默认，运营者按需开启。
- **Negative**：开启态把业务正文明文上链，是 ADR-0007 R16 redaction 立场的
  偏离 —— 合规风险转移给运营者，文档（本 ADR + `.env.example` 醒目注释 +
  span schema §5）必须把后果讲清。claude provider 内容仍缺失（已知限制）。
- **Neutral / Trade-offs**：50000 字符硬上限是导出可靠性与内容完整度的折中；
  正常聊天/工具调用远不及此，仅极端大 payload 会被截断并显式标记。若未来要
  回到"上明文也必须脱敏"，需重审本 ADR 并把 `redact.ts` 升级为开启态也走的
  全量 redaction。
- **coverage gate 不受影响**：span 名 / kind 不变，只多了内容 attribute；
  现有 observability-coverage 测试照过。

## Implementation Notes

修改文件：

```text
container/agent-runner/src/observability/tracer.ts        # captureContentEnabled() + capContent() + MAX_CONTENT_ATTRIBUTE_CHARS
container/agent-runner/src/poll-loop.ts                   # agent.turn input/output.value；provider.request llm.input_messages/output.value
container/agent-runner/src/providers/types.ts             # usage 事件可选 inputMessages?/outputText? + LlmMessage
container/agent-runner/src/providers/openai.ts            # 开启时填 inputMessages/outputText（transcriptToLlmMessages）
container/agent-runner/src/mcp-tools/server.ts            # 开启时 tool.parameters 全文 + tool.output 全文，关闭维持脱敏摘要
container/agent-runner/src/index.ts                       # MCP server OTEL env 透传新增 OTEL_CAPTURE_CONTENT
container/agent-runner/src/observability/observability.test.ts  # flag 开/关 + 硬上限截断断言
src/container-runner.ts                                   # buildRunnerTracingEnvArgs 透传 OTEL_CAPTURE_CONTENT
src/container-runner.test.ts                              # 透传/默认-off 断言
docs/observability-span-schema.md                         # §5 注明 input/output/tool content 受 OTEL_CAPTURE_CONTENT 门控
.env.example                                              # OTEL_CAPTURE_CONTENT 示例 + 醒目后果注释
```

保留（不动）：`container/agent-runner/src/observability/redact.ts` —— 关闭态
`tool.parameters` 脱敏摘要仍依赖它。

后续验收点：

- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` 通过；host
  `pnpm typecheck` 通过。
- bun 测试（编排者 docker 跑）：flag 开时 `agent.turn` 有 `input.value` /
  `output.value`、`provider.request` 有 `llm.input_messages.*` / `output.value`、
  tool span 有完整 `tool.parameters` / `tool.output`；flag 关时这些内容属性
  **一个都没有**（只剩元数据），与本 ADR 前一致；`capContent` 超长截断 +
  `<truncated>` 生效。
- host vitest：`buildRunnerTracingEnvArgs` 在 host 设了 `OTEL_CAPTURE_CONTENT`
  时透传、未设时不注入。
- observability coverage gate 通过（span 名/kind 未变）。

## References

- `docs/decisions/ADR-0026-runner-otel-instrumentation.md`（本 ADR 兑现其
  "上明文是后续 wave" 的预留，并有意偏离其 redaction 前置条件）
- `docs/decisions/ADR-0007-observability-phoenix-grafana.md`（R16 PII 上链
  redaction —— 本 ADR 为运营者显式 opt-in + 默认关而偏离）
- `docs/decisions/ADR-0014` / `ADR-0015`（span schema + coverage gate，未受影响）
- `docs/observability-span-schema.md` §5（attribute matrix，加门控注记）
- OpenInference semantic conventions：`llm.input_messages.*` / `output.value` /
  `tool.parameters` / `tool.output`
