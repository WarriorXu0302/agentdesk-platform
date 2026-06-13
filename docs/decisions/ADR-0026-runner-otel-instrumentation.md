# ADR-0026: Runner OpenTelemetry Instrumentation（runner-tracing wave）

- **Status**: Accepted
- **Date**: 2026-06-12
- **Decider(s)**: User（批准），coding agent（提案 + 执行）
- **Tags**: `observability`, `tracing`, `phoenix`, `opentelemetry`, `container-runtime`
- **Supersedes**: None
- **Superseded by**: None

---

## Context

ADR-0011 落地了 host 侧 OTel tracing，并把 `OTEL_TRACEPARENT` 注入到容器
spawn 环境里（`src/container-runner.ts`），作为 runner-side tracing 的
forward-compatibility 契约 —— 但当时明确把 runner 侧 spans 列为
**Deferred**。ADR-0014/0015 把 span schema 锁成 binding，并装了 coverage
gate；ADR-0015 §47 **显式豁免** runner 侧 `openinference.span.kind` 强制，
注明"待 runner-tracing wave 批准"再放开。span schema §3 已把 `agent.*`、
`provider.*`、`mcp.*` 标为 `Planned (runner tracing)`。

触发本 wave 的诉求：Phoenix 里要能看到**端到端一棵树** —— host session
root span 之下挂上容器内的 turn / LLM / tool spans，便于排查"消息进来后
agent 到底调了哪个模型、跑了哪个工具、各阶段耗时"。

决策时的已知约束（load-bearing invariants，不可削弱）：

- **Observability 只读**：tracing 绝不能改 message flow / 身份链 / 三库单写。
- **三库单写**：parent 桥接只能走 env(`OTEL_TRACEPARENT`) + 进程内 OTel
  context，**不得**经 SQLite。
- **品牌不硬编码**：service.name / failure category key 必须从
  `PLATFORM_PROTOCOL_NAMESPACE` 派生。
- **镜像体积**：不引 `auto-instrumentations-node`。
- runner 在 **bun** 上跑；OTel JS SDK 在 bun 可用。
- 现状：host 已注入 `OTEL_TRACEPARENT`，但①未注入 OTLP endpoint
  ②容器零 OTel ③MCP server 是**独立 `bun run` 进程**，且当前以 `env: {}`
  启动（拿不到任何 OTEL_* 环境）。

## Options Considered

- **Option A**：本 wave 只做结构可见（turn/LLM/tool spans），**不上明文内容**
  （不上 LLM input/output、不上 tool 参数明文，只上脱敏摘要）。工作量小、
  风险低、不需要先把 ADR-0007 R16 全量 redaction 做完即可上生产。
- **Option B**：一步到位，连同 LLM input/output messages + tool parameters
  明文一起上。Phoenix UI 信息最全，但必须**先**把全量 redaction 做对
  （prompt/PII/credential/ERP payload 都可能进 attribute），否则就是安全
  事故；工作量与风险都显著更高。
- **Option C**：继续只靠 host 侧 tracing，runner 不插桩。零新代码，但
  Phoenix 里 host root 之下永远是空的，端到端排障诉求无法满足。

## Decision

> **拍板**：选 Option A。

本 wave = **Phase A（结构）+ 工具 span**，端到端结构全可见但**不上敏感内容**：

1. 开启 runner-tracing wave，**撤销 ADR-0011 对 runner spans 的 Deferred**。
2. **放开 ADR-0015 §47 的 runner-kind 豁免**：coverage gate 的 kind 检查从
   `hostSpanOccurrences` 改为 `allSpanOccurrences`，host 与 runner 的每个
   manual span 都必须带 `openinference.span.kind`。
3. 三类 runner span 全部落地并通过 gate：
   - `agent.turn`（AGENT）；
   - `provider.request`（LLM，带 model + token counts）；
   - `mcp.<group>.<tool>`（TOOL，带 `tool.name` + **脱敏** `tool.parameters`）。
4. **不做（本 wave 边界）**：LLM `input_messages` / `output_messages` 明文、
   `tool.parameters` 明文值、claude provider 的独立 LLM span（claude 走
   SDK，本 wave 接受看不到其内部 LLM 调用）、ADR-0007 R16 全量 redaction。

核心理由（可验证）：

- 结构可见就能满足"哪个模型 / 哪个工具 / 各段耗时"的主诉求，无需上明文。
- 不上明文 → 本 wave 不依赖全量 redaction，能独立、安全地上生产。
- fail-open：host 没开 tracing（无 `OTEL_TRACEPARENT`）时 runner 行为与改动
  前**完全一致**（纯旁路）。

### 上明文是后续，且必须配 redaction（明确边界）

把 `llm.input_messages` / `llm.output_messages` / `tool.parameters` **明文**
搬上 span，是一个**独立的后续 wave**，且**必须**与 ADR-0007 R16 全量
redaction（raw token / cookie / JWT / credential / unbounded prompt / ERP
payload 的 omit/hash/truncate + `attribute.redacted=true` 标记）**同批交付**。
在 redaction 落地前，任何上明文的 PR 都视为违反本 ADR 与 span schema §6.4 /
§9.6。

## 端到端 trace 怎么拼（实现要点）

- **host 注入 endpoint**（`src/container-runner.ts`
  `buildRunnerTracingEnvArgs`，紧接现有 `OTEL_TRACEPARENT` 注入）：仅当
  `carrier.traceparent` 存在时，注入
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`，并把
  `localhost`/`127.0.0.1` 改写为 `host.docker.internal`（容器够不到 host
  loopback；该 alias 由 `hostGatewayArgs()` 在 Linux 上补 `--add-host`，
  macOS/Windows Docker Desktop 内建）。`OTEL_SDK_DISABLED` 若设置则透传。
- **runner bootstrap**（`container/agent-runner/src/observability/init.ts`，
  `initRunnerObservability()`）：`OTEL_SDK_DISABLED==='true'` **或无
  `OTEL_TRACEPARENT`** 直接 `return false`（纯旁路）；否则 `try` 起一个
  `NodeSDK`（OTLP/proto exporter，`service.name=<namespace>-runner`），
  `catch` 全吞（fail-open，绝不抛/不阻塞）；`beforeExit` 时
  `sdk.shutdown().catch(()=>{})`，fire-and-forget 不阻塞 teardown。
  作为 `src/index.ts` **第 1 行** side-effect import。
- **MCP server 是独立进程**：`src/index.ts` 把 OTEL_* 环境（traceparent /
  endpoint / disabled / service / brand）显式塞进内置 MCP server 的
  `env`（原本是 `env: {}`），`src/mcp-tools/index.ts` 也把
  `../observability/init.js` 作为第 1 行 import。因此 MCP tool span 在自己
  的进程里 bootstrap OTel，并从 `OTEL_TRACEPARENT` 读 parent —— 它是 host
  session root 的 child，与 `agent.turn` 同处一棵 trace（是 root 的 sibling，
  **不是** `agent.turn` 的 child，因为跨进程 in-proc context 不过边界）。
- **进程内桥接**：`agent.turn` 用
  `context.with(parentContextFromEnv(), ()=>startActiveSpan('agent.turn',…))`
  挂到 host root；`provider.request` 在 `agent.turn` 仍是 active span 时创建，
  经 NodeSDK 注册的 async-hooks context manager 自动成为其 child。

## Consequences

- **Positive**：Phoenix 端到端可见 host→runner 一棵树（span schema §10.3
  Tree 2 的现实化）；解锁后续"明文 + redaction" wave 与 gateway(`erp.*`)
  tracing；coverage gate 现在对 runner spans 也强制 kind，drift 变成测试失败。
- **Negative**：runner 镜像新增 OTel 依赖（已避开 auto-instrumentations 以控
  体积）；MCP tool span 因跨进程只能挂在 host root 下（非 `agent.turn` child），
  Phoenix 树形上 turn 与 tool 是兄弟。
  - ~~claude provider 的内部 LLM 调用本 wave 看不到（仅 OpenAI provider 通过
    `usage` 事件产 `provider.request`）。~~ **已闭合(2026-06-13)**：claude provider
    现从 Agent SDK 的 `result` 消息(`usage`/`modelUsage`/`duration_api_ms`)抽出
    **整轮聚合**用量,经 `claudeUsageEvent()` 产 `usage` 事件 → poll-loop 产
    `provider.request` LLM span。粒度是「每轮一条聚合」(SDK 不暴露单次 API 调用
    用量),非「每次 API 调用一 span」;内容(prompt/result)仍只在 `agent.turn` span
    上(ADR-0027),故该 LLM span 仅 metadata。
- **Neutral / Trade-offs**：`mcp.<group>.<tool>` 运行时名经 `updateName()`
  设置；静态 coverage 扫描器只认字面量，故 `startActiveSpan` 用字面量
  `'mcp.tool.execute'` 占位、运行时 `updateName` 成真实 `mcp.<group>.<tool>`。
  若未来 OTLP endpoint 不可达，由 exporter 内部异步处理，不阻塞主流程。

## Implementation Notes

新增文件：

```text
container/agent-runner/src/observability/init.ts
container/agent-runner/src/observability/tracer.ts
container/agent-runner/src/observability/mcp-span-name.ts
container/agent-runner/src/observability/redact.ts
container/agent-runner/src/observability/observability.test.ts
docs/decisions/ADR-0026-runner-otel-instrumentation.md
```

修改文件：

```text
src/container-runner.ts                                  # buildRunnerTracingEnvArgs：注入 endpoint
src/container-runner.test.ts                             # 注入断言
container/agent-runner/src/index.ts                      # init 首行 import + MCP server OTEL env 透传
container/agent-runner/src/mcp-tools/index.ts            # init 首行 import
container/agent-runner/src/mcp-tools/server.ts           # mcp.* TOOL span
container/agent-runner/src/poll-loop.ts                  # agent.turn + provider.request span
container/agent-runner/package.json                      # OTel 依赖（bun.lock 由编排者 docker 重生成）
scripts/observability-coverage-lib.ts                    # kind 检查 host→all
scripts/observability-coverage.test.ts                   # runner spans 断言
docs/observability-span-schema.md                        # agent./provider./mcp. 相关 status Planned→Active
```

后续验收点：

- 容器 `tsc -p container/agent-runner/tsconfig.json --noEmit` 通过；host
  `pnpm typecheck` 通过。
- `pnpm test`（含 observability coverage gate）通过：runner 三类 span 被扫到、
  kind=present、零 forward/backward/kind violation。
- runner bun 测试（编排者 docker 跑）：init 在 disabled/无 traceparent 返回
  false 不抛；`parentContextFromEnv` 解析的 trace-id == 注入值；fake turn 下
  `agent.turn` 产生、`provider.request` 是其 child、traceId == host traceparent。

## References

- `docs/decisions/ADR-0011-host-otel-instrumentation.md`（撤销其 runner Deferred）
- `docs/decisions/ADR-0014-observability-span-schema.md`
- `docs/decisions/ADR-0015-observability-coverage-gate.md`（放开 §47 runner-kind 豁免）
- `docs/decisions/ADR-0007`（observability 栈 + R16 redaction，后续 wave 依赖）
- `docs/observability-span-schema.md` §3 / §5.2 / §5b.4 / §10.3 Tree 2 / §9.2
- W3C Trace Context propagation；Phoenix OTLP HTTP endpoint
