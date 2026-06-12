# ADR-0024: OpenAI provider 摘要式上下文压缩

- **Status**: Accepted
- **Date**: 2026-06-12
- **Decider(s)**: 用户（提案/验收），coding agent（执行）
- **Tags**: `provider`, `openai`, `context-management`, `cleanup`
- **Supersedes**: —
- **Superseded by**: —

---

## Context

OpenAI provider（`container/agent-runner/src/providers/openai.ts`，注册名 `openai`/`codex`）
此前已具备完整的工具调用（`OpenAIMcpBridge` + `runTurn` 工具循环）与正确的
usage 上报，唯一与 Claude provider 不对等的能力是**长对话上下文管理**：

- Claude 走 SDK 的 auto-compact（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`，默认 165k token），
  并通过 `PreCompact` 钩子注入路由保留指令（`compact-instructions.ts`），压缩后发
  `compacted` 事件，poll-loop（`poll-loop.ts:613-629`）借此把 `<message to="…">`
  路由约定重新注入活跃 query。
- OpenAI provider 只有**硬截断**：`trimTranscript` 在超过
  `MAX_REPLAY_TRANSCRIPT_ITEMS=128` / `MAX_REPLAY_TRANSCRIPT_CHARS=120_000` 时直接
  `slice` 丢弃最旧的条目，且从不发 `compacted` 事件。

后果：长对话里 OpenAI 会无声地丢失最早的上下文，且 poll-loop 的压缩后路由提醒对
OpenAI 完全失效——多目标群组里压缩后模型可能丢掉 `<message to="…">` 包裹，导致回复
路由错误。

同时仓库里还存在一个 `sdk-openai` 玩具 provider（Vercel AI SDK，119 行）：无
transcript、无工具、`end()` 后把 pending 当 result 吐回，与生产 `openai` provider
完全不在一个量级，属于早期探索遗留面。

触发事件：把 OpenAI provider 做到与 Claude provider 同等效果的需求。

已知约束：
- `compacted` 事件契约（`types.ts:83-90`）与 poll-loop 处理（`613-629`）已就绪，本
  改动不应触碰它们。
- 三库单写者不变量：container 侧只写 `outbound.db`；压缩归档若落盘必须是单向写文件，
  不得回注、不得碰 `outbound.db`。
- 不引入 tokenizer 依赖（沿用 JSON 字符数作 token 代理）。

## Options Considered

- **Option A：维持硬截断**。零工作量，但与 Claude 不对等、丢上下文、路由提醒失效。
  不可接受。
- **Option B：接入某个第三方 SDK 的内建压缩**（如复活/扩展 sdk-openai 走 Vercel AI
  SDK）。该 SDK 既无工具也无 transcript，等于重写整个 provider，且引入新依赖类别；
  与现有 `openai` provider 的 Responses/chat-completions 双传输、stateless 降级、F2
  stale-tool-call 处理都不兼容。工作量大且风险高。
- **Option C：在 `openai` provider 内自实现摘要式压缩**。复用已有的
  `transcriptToChatMessages` + `createChatCompletionResponse` 路径，用一次便宜模型的
  纯文本 chat-completions 把旧窗口压成摘要，近窗保留原样。工作量中等，无新依赖，与
  现有传输/降级/F2 逻辑天然兼容。

## Decision

> **拍板**：选 Option C，在 `openai` provider 内自实现摘要式上下文压缩；删除
> `sdk-openai` 玩具 provider。

核心理由（可验证）：

1. **provider 自实现而非依赖 SDK**：OpenAI 兼容后端没有统一的服务端压缩契约，且本
   provider 已自己管理 transcript（为支持 stateless 降级与 F2 stale-tool-call 处理）。
   压缩必须在同一层做，才能与这些机制一致。

2. **“本地压缩 = 服务端续接终止点”**：一旦本地把旧窗口换成摘要，本地 transcript 就与
   服务端 `previous_response_id` 背后存的全量历史**分叉**。若继续带
   `previous_response_id`，服务端会重新注入压缩前的旧上下文，等于压缩没生效还翻倍。
   因此压缩一旦发生，强制 `mode='stateless'`、`previousResponseId=undefined`、
   `nextInput=压缩后全量 transcript`，走与现有 Responses→stateless 降级同一条路径。

3. **与 Claude auto-compact 对齐，但机制独立**：两者都在“接近上下文上限时压缩并保留
   路由约定”，且共用同一份指令文本（见下）。但 Claude 走 SDK 内建 + PreCompact 钩子，
   OpenAI 走 provider 内的一次额外 chat-completions 调用——实现独立，仅对外行为
   （发 `compacted` 事件 + 摘要含路由约定）对齐。本 ADR 与 ADR-0023（roster-dm）无关。

4. **删除 `sdk-openai`**：按 CLAUDE.md “删遗留面而非留 shim”。它从不是生产 provider，
   保留只会让新 agent 误以为有第二条 OpenAI 路径。`provider-registry.ts` 对
   `sdk-openai` 名给出明确报错指向 `openai`，避免旧 `container.json` 撞上泛化错误。

## Consequences

- **Positive**：
  - OpenAI 长对话不再无声丢上下文；旧窗口被摘要保留要点。
  - poll-loop 的压缩后路由提醒对 OpenAI 生效（OpenAI 现在会发 `compacted`）。
  - 摘要复用共享指令 `buildCompactionInstructions`，与 Claude PreCompact 不漂移。
  - 摘要调用也产 usage 事件，成本可观测。
  - 删掉 119 行死代码与一条误导性 provider 路径。

- **Negative**：
  - 触发压缩时多一次 LLM 调用（成本/延迟）；用 `OPENAI_COMPACT_MODEL` 回落便宜模型缓解。
  - 阈值用 JSON 字符数作 token 代理，不精确——保守地设在 120k 硬上限与 165k 之间（150k）。
  - `@ai-sdk/openai-compatible` 与 `ai` 两个依赖随 `sdk-openai` 删除后成为孤儿（仍留在
    `package.json`，本次未动 lockfile，见 Open Questions）。

- **Neutral / Trade-offs**：
  - 持久化/恢复的 transcript 上限从 120k 提到 200k（`MAX_PERSIST_TRANSCRIPT_CHARS`），
    否则每次 save/restore 都会把 transcript 砍到 150k 触发线以下、使压缩成为死代码。
    硬截断（120k）退化为**兜底**：摘要失败、无可安全切分的窗口、或压缩后仍超硬上限时才用。
  - 压缩边界不可拆散成对的 `function_call`/`function_call_output`，否则产生孤儿
    `call_id`——`computeCompactionBoundary` 把边界外推到工具对之外。

## Implementation Notes

- `container/agent-runner/src/providers/openai.ts`
  - 新增 `COMPACT_TRIGGER_CHARS=150_000`、`KEEP_RECENT_ITEMS=20`、
    `MAX_PERSIST_TRANSCRIPT_CHARS=200_000`；env：`OPENAI_COMPACT_MODEL`（回落
    `OPENAI_MODEL`）、`OPENAI_COMPACT_ARCHIVE`（默认关）。
  - `trimTranscriptTo(items,maxChars)` 抽出；`trimTranscript`（120k 兜底）、
    `trimTranscriptForPersist`（200k 存储/回放）。
  - `runTurn`：追加新 prompt 后、首调用前评估 `totalTranscriptChars`，超阈值调
    `runCompaction`；成功则换 transcript + 强制 stateless + 发 `compacted`，失败兜底
    `trimTranscript`。
  - `runCompaction` / `summarizeOldWindow` / `callSummaryCompletion` / `archiveWindow`。
  - 返回值加 `compacted`；generator 在 `init` 之后、`result` 之前 yield `compacted`。
- `container/agent-runner/src/compact-instructions.ts`：抽出共享纯函数
  `buildCompactionInstructions(destinations)`，CLI 入口收敛到 `import.meta.main`。
- `container/agent-runner/src/providers/provider-registry.ts`：`sdk-openai` 明确报错。
- 删除 `container/agent-runner/src/providers/sdk-openai.ts` 及 `providers/index.ts` 的导入。
- 文档：`docs/agent-runner-details.md` provider 事件语义补 `compacted`（OpenAI 现也发）。
- 测试：`container/agent-runner/src/providers/openai.test.ts` 新增 6 个用例（见下）。
- 验收点：`pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` 与 host
  `pnpm typecheck` 均绿；bun 测试由编排者 docker 跑。

## Open Questions

- `@ai-sdk/openai-compatible` 与 `ai` 现已无引用，可从 `container/agent-runner/package.json`
  移除（需更新 lockfile）。本次未动，留给依赖清理任务。

## References

- `docs/decisions/_template.md`
- `container/agent-runner/src/providers/openai.ts`、`claude.ts`、`types.ts`
- `container/agent-runner/src/poll-loop.ts:613-629`
- qwibitai/nanoclaw#2325（压缩后路由提醒的来由）
