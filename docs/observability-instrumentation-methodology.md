# Phoenix + OpenInference 可观测性接入方法论

> **Companion spec**: For the binding span naming schema, see [`docs/observability-span-schema.md`](./observability-span-schema.md) v1.0. The schema is the authoritative source for span names, namespace registry, attribute matrix, and migration plan. This methodology doc explains "how to instrument"; the schema doc defines "what to name and what attributes to set".

> **位置**：`docs/observability-instrumentation-methodology.md`
> **目的**：MUAP host / runner 一切 OpenTelemetry tracing 工作的方法论 single source of truth。任何 Sub-agent 在改动 `src/observability/` 或新增 span 之前，**必须**先读这一篇。
> **状态**：v1.0（pending review · 2026-05-29）
> **依据**：Phoenix Sessions 官方教程 + OpenInference 语义规范 + FlowiseAI 38k★ 生产实现

---

## 1. 为什么需要方法论

之前 PR-O2 的实现把 `withSpan` 当成"加日志"——结果：

- Phoenix UI 列表：14 个 column 中只有 `name` / `latency` / `start time` 有值，其它（`kind` / `input` / `output` / `total tokens` / `feedback`）全 `unknown` / `--`
- Phoenix Sessions 视图：HUMAN / AI 卡片全是 `undefined`
- Trace 列表被 `delivery.poll.active` / `host.sweep` / `delivery.session.drain` 等空轮询淹没（每秒 1 个 root trace）

根因：**OpenTelemetry tracing 没有"语义"**——span 名字 + latency 在工程系统里够用，但 Phoenix 是为 AI 系统设计的可观测性平台，它的 UI 是**OpenInference schema 驱动**的。不按 schema 喂数据，等于关掉 Phoenix 90% 的能力。

这份方法论把 Phoenix 的 schema 内化为接入纪律。

---

## 2. 核心概念

### 2.1 Trace 拓扑

```
trace（一次用户请求）
  └─ root span  ←  必须有 session.id 才能进入 Phoenix Sessions 分组
      ├─ child span（自动继承 session.id via OTel context）
      ├─ child span
      └─ ...（跨进程时用 W3C traceparent 续接）
```

**Phoenix 只看 root span 的 `session.id`** 来分组 trace。子 span 设不设 session.id 不影响分组（但建议显式设，便于直接查询）。

### 2.2 OpenInference 是 AI 语义层

OpenInference 是 OpenTelemetry 之上的 AI 专用语义规范。它定义了一套属性键（attribute names）+ 枚举值（attribute values），让 Phoenix UI 知道：

- 这个 span 是什么类型的 AI 操作（`openinference.span.kind`）
- 输入是什么（`input.value` / `input.mime_type`）
- 输出是什么（`output.value` / `output.mime_type`）
- 属于哪个会话（`session.id`）
- 哪个用户（`user.id`）
- LLM 用了多少 token（`llm.token_count.*`）
- 完整的对话消息列表（`llm.input_messages.*` / `llm.output_messages.*`）

**没有这些属性 = Phoenix 退化成普通 trace 查看器。**

### 2.3 Phoenix Sessions 视图

Sessions 视图把同一 `session.id` 的所有 trace 按时间线排列，每个 trace 显示一对 HUMAN / AI 卡片。卡片内容来自：

| Phoenix UI 元素 | 数据来源（在 root span attribute 上） |
|---|---|
| 卡片标题 `HUMAN` | 任意 span（root 或 LLM 类型）的 `input.value` |
| 卡片标题 `AI` | 同 trace 任意 span 的 `output.value` |
| 卡片下方 latency / tokens | root span 的 latency + 子 span 的 `llm.token_count.*` 累加 |
| Session ID 顶部 | root span 的 `session.id` |

如果 `input.value` / `output.value` 没设 → Phoenix 显示 `undefined`。

---

## 3. 必设属性 schema（the "contract"）

### 3.1 Required（每个 span 都要有）

| 属性键 | 类型 | 取值 | 说明 |
|---|---|---|---|
| `openinference.span.kind` | string enum | `LLM` / `EMBEDDING` / `CHAIN` / `RETRIEVER` / `RERANKER` / `TOOL` / `AGENT` / `GUARDRAIL` / `EVALUATOR` / `PROMPT` | 必填，决定 Phoenix UI 的 kind 列 |

### 3.2 Required on Root Span（trace 入口）

| 属性键 | 类型 | 说明 |
|---|---|---|
| `session.id` | string | 同一会话所有 trace 的分组键。**键名是 `session.id`，不是 `openinference.session.id`** |
| `input.value` | string | 用户请求文本（HUMAN 卡片内容） |
| `input.mime_type` | string | 通常 `text/plain`；JSON 时 `application/json` |

### 3.3 Required on Output-bearing Span（产生回复的 span）

| 属性键 | 类型 | 说明 |
|---|---|---|
| `output.value` | string | AI 回复文本（AI 卡片内容） |
| `output.mime_type` | string | 通常 `text/plain` |

### 3.4 Recommended

| 属性键 | 类型 | 说明 |
|---|---|---|
| `user.id` | string | 触发该 trace 的用户。Phoenix 可按 user 切片分析 |

### 3.5 LLM-Specific（仅 `openinference.span.kind = "LLM"`）

| 属性键 | 类型 |
|---|---|
| `llm.model_name` | string |
| `llm.provider` / `llm.system` | string |
| `llm.invocation_parameters` | JSON string |
| `llm.token_count.prompt` | int |
| `llm.token_count.completion` | int |
| `llm.token_count.total` | int |
| `llm.input_messages.{i}.message.role` | `user` / `assistant` / `system` / `tool` |
| `llm.input_messages.{i}.message.content` | string |
| `llm.output_messages.{i}.message.role` | string |
| `llm.output_messages.{i}.message.content` | string |

---

## 4. Span Kind 映射规则

按"操作的本质"选 kind，不是按"代码层"：

| 业务场景 | 推荐 kind | 例子 |
|---|---|---|
| 编排器 / 入口 / 协调多步 | `CHAIN` | router、channel handler、deliver_to_agent |
| 自主 AI Agent 思考一步 | `AGENT` | container 内 agent 的 plan/act 循环 |
| 实际调 LLM API | `LLM` | OpenAI 完成、Claude 完成 |
| 调外部 API / IO | `TOOL` | DB 查询、HTTP 调外部服务、文件读写、channel adapter 发消息 |
| 向量检索 | `RETRIEVER` | RAG 检索阶段 |
| 重排 | `RERANKER` | reranker 模型 |
| 嵌入向量生成 | `EMBEDDING` | embedding API 调用 |
| 内容审核 | `GUARDRAIL` | moderation / 安全过滤 |
| 自动评估 | `EVALUATOR` | 在线评测 |
| Prompt 模板渲染 | `PROMPT` | 模板填充阶段 |

**纯基础设施操作（容器 spawn/kill、DB 打开、心跳）不应该是 span。** 见 §6。

---

## 5. 设置时机（the "discipline"）

### 5.1 已知数据 → 创建时设

```typescript
await withSpan('cli.event.received', {
  'channel.type': 'cli',
  'openinference.span.kind': 'CHAIN',
}, async () => { ... });
```

### 5.2 异步解析后的数据 → 用 `getActiveSpan()` 补设

```typescript
await withSpan('router.deliver_to_agent', { 'agent.group.id': agentGroupId }, async () => {
  const session = await resolveSession(...);   // 异步
  getActiveSpan()?.setAttributes({
    'openinference.span.kind': 'CHAIN',
    'session.id': session.id,
    'user.id': userId,
    'input.value': parsedText,
    'input.mime_type': 'text/plain',
  });
  // ...
});
```

### 5.3 跨 span 传 session.id → 用 `setSession`

子 span 不必每个手动设 `session.id`。在 root span 里 wrap 一个 context：

```typescript
import { setSession } from '@arizeai/openinference-core';

context.with(
  setSession(context.active(), { sessionId: session.id }),
  async () => {
    // 这里所有用 OpenInference helpers 创建的 span 自动带 session.id
  }
);
```

### 5.4 严禁的反模式

| ❌ 错误 | 影响 |
|---|---|
| `span.end()` 之后再 `setAttribute` | 属性丢失 |
| 属性键拼错（如 `input` 不是 `input.value`） | Phoenix UI 不识别 |
| Root span 不设 session.id | 整个 trace 不进 Sessions 视图 |
| 不同 trace 共用 session.id 但相互无关 | Sessions 视图错误聚合 |
| 把 polling / sweep / heartbeat 加 span | 列表噪声，淹没真消息 |

---

## 6. 反噪声纪律

**span 必须代表"真实的业务工作"，不是"代码经过这里"。**

### 6.1 经验法则

写完一个 `withSpan(...)` 后问自己：

1. 这次执行**有可能**没做实际工作就返回吗？（空 poll、无消息、无变更）
2. 如果无工作时也会创建 span → 重构，把 span 移到"已知有工作"之后
3. 如果工作内容是"打开数据库 / 关闭数据库 / 心跳" → 不该是 span

### 6.2 PR-O2 后清单（已删 / 待删）

| Span | 状态 | 原因 |
|---|---|---|
| `delivery.poll.active` | ✅ 删除 | 每秒空 fire |
| `host.sweep` | ✅ 删除 | 每 60s 空 fire |
| `host.sweep.sessions` | ✅ 删除 | 每 session 每 60s 空 fire |
| `delivery.session.drain` | 🔧 待重构 | poll loop 调用，无消息时也 fire；要把 DB 查询移到 span 外，仅在 `undelivered.length > 0` 时包 span |
| `router.container.wake` | 🗑️ 待删 | 与 `container.wake` 完全重叠（router 包了一层 wake，container 内又包一层） |

### 6.3 重构 pattern

把"可能为空"的 span 改造为"已知非空才创建"：

```typescript
// BEFORE - span 包了整个函数（即使无工作也 fire）
async function drainSession(s) {
  await withSpan('delivery.session.drain', { 'session.id': s.id }, async () => {
    const allDue = getDueOutboundMessages(outDb);
    if (allDue.length === 0) return;  // ← span 已创建，浪费
    // ...
  });
}

// AFTER - 先检查工作量，仅在有真消息时创建 span
async function drainSession(s) {
  const allDue = getDueOutboundMessages(outDb);
  if (allDue.length === 0) return;
  const undelivered = allDue.filter(m => !delivered.has(m.id));
  if (undelivered.length === 0) return;

  // 已知有 N 条要投递 → 才进 span
  await withSpan('delivery.session.drain', {
    'session.id': s.id,
    'openinference.span.kind': 'CHAIN',
    'message.count': undelivered.length,
  }, async () => {
    for (const msg of undelivered) await deliverMessage(msg, ...);
  });
}
```

---

## 7. Trace 拓扑规则（架构层）

### 7.1 一次用户请求 = 一个 root span

不要在 channel handler、router、delivery 各自创建独立 root span。一次入站消息从 channel 到回复，应当是**一棵 span 树**，root 在最早能识别 session 的位置。

### 7.2 Root span 选址规则

Root 必须满足：
- 是用户请求生命周期的最早入口
- 此时 `session.id` 已知

如果入口（cli/feishu channel handler）此时 session 还未解析，怎么办？

**两种方案，本项目选 B：**

- **A. 入口不开 span，root 推迟到 session 解析处** → 抛弃 channel 层的 timing 信息
- **B. 入口开 span 但**不**作为 trace root**，root span 是 `router.deliver_to_agent`（session 解析点）。channel span 是上游兄弟 span（自己的 trace）。

> **本项目决策**：方案 B。`cli.event.received` / `feishu.event.received` 是上游 spans（自己的 trace 短链路），`router.deliver_to_agent` 是 Phoenix Sessions 视图意义上的 root（session.id 在此设置 + setSession context wrap，向下传播给所有 container / delivery 子 span）。

### 7.3 跨进程边界（host → container）

W3C traceparent 已在 PR-O2 通过 `OTEL_TRACEPARENT` 容器环境变量贯通。container-runner 内部需用 OTel propagator 解析后作为 root context。container 内部新建的 span 自动成为 host span 的 child（PR-O3 完成后）。

### 7.4 不重复包同一概念

**禁止**：

```typescript
// router.ts 内
await withSpan('router.container.wake', { ... }, async () => {
  await wakeContainer(session);  // wakeContainer 内部又包了 'container.wake'
});
```

留一个，删另一个。本项目删 `router.container.wake`，保留 `container.wake`（因为 wake 概念属于 container-runner 模块）。

---

## 8. mime_type 约定

| 内容 | mime_type | 例 |
|---|---|---|
| 用户文本消息 / AI 文本回复 | `text/plain` | `"hello world"` |
| 结构化对象 / JSON payload | `application/json` | `JSON.stringify({...})` |
| 模型完整 request / response | `application/json` | `JSON.stringify(openaiResponse)` |

Phoenix UI 当前对 `application/json` **不**特殊渲染，按字符串展示。但 Phoenix 评测 / 实验功能会按 mime_type 解析，所以如实标注更安全。

---

## 9. 推荐依赖

### 9.1 必装

```bash
pnpm add @arizeai/openinference-semantic-conventions @arizeai/openinference-core
```

| 包 | 作用 |
|---|---|
| `@arizeai/openinference-semantic-conventions` | 类型化常量：`SemanticConventions.SESSION_ID`、`OpenInferenceSpanKind.CHAIN` 等。避免拼错 |
| `@arizeai/openinference-core` | helpers：`setSession()` / `setUser()` / `setMetadata()` / `getLLMAttributes()` / `withSpan()` |

### 9.2 使用范式

```typescript
import { trace, context } from '@opentelemetry/api';
import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';
import { setSession, setUser, getLLMAttributes } from '@arizeai/openinference-core';

const tracer = trace.getTracer('muap-host');

// 入口（router.deliver_to_agent，session 已知）
return tracer.startActiveSpan('router.deliver_to_agent', async (span) => {
  span.setAttributes({
    [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
    [SemanticConventions.SESSION_ID]: session.id,
    [SemanticConventions.USER_ID]: userId,
    [SemanticConventions.INPUT_VALUE]: userText,
    [SemanticConventions.INPUT_MIME_TYPE]: 'text/plain',
  });

  // 让 session.id 自动传播到所有子 span
  return context.with(
    setUser(setSession(context.active(), { sessionId: session.id }), { userId }),
    async () => {
      // ... wakeContainer / deliverMessage / etc.
      // 所有这里创建的 span 自动带 session.id 和 user.id
    }
  );
});
```

---

## 10. 验证 SQL（Phoenix Postgres）

`obs:reset` 清掉旧噪声后，发一条消息触发完整链路，跑这些 SQL 确认接入到位：

```sql
-- 1. 移除的噪声 span 不再出现
SELECT name, count(*) FROM spans
WHERE name IN ('delivery.poll.active','host.sweep','host.sweep.sessions','router.container.wake')
GROUP BY name;
-- 期望：空结果

-- 2. delivery.session.drain 计数应该约等于实际触发的消息数
SELECT name, count(*) FROM spans
WHERE name = 'delivery.session.drain';
-- 期望：5-10（不是几百）

-- 3. openinference.span.kind 已设
SELECT
  name,
  attributes->>'openinference.span.kind' AS kind,
  count(*)
FROM spans
GROUP BY name, kind
ORDER BY name;
-- 期望：每个 span 都有非 NULL 的 kind 值

-- 4. session.id 已在 root span 设置
SELECT
  t.trace_id,
  s.name AS root_span,
  s.attributes->>'session.id' AS session_id
FROM traces t
JOIN spans s ON s.trace_rowid = t.id AND s.parent_id IS NULL
ORDER BY t.id DESC
LIMIT 10;
-- 期望：session_id 全部非 NULL（除 channel-only trace）

-- 5. input.value / output.value 已填
SELECT
  name,
  left(attributes->>'input.value', 60) AS input_preview,
  left(attributes->>'output.value', 60) AS output_preview
FROM spans
WHERE attributes ? 'input.value' OR attributes ? 'output.value'
ORDER BY start_time DESC
LIMIT 10;
-- 期望：能看到真实消息片段，不是 NULL
```

UI 验证：Phoenix Sessions 视图打开 → HUMAN 卡片显示用户消息文本 / AI 卡片显示回复文本，不再 `undefined`。

---

## 11. 项目级决策（applied to MUAP）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 属性键名是 `session.id` 还是 `openinference.session.id` | `session.id` | Phoenix 官方 + Flowise 一致 |
| Trace root 在哪里 | `router.deliver_to_agent` | 最早能识别 session 的点；channel span 是上游短 trace |
| `router.container.wake` vs `container.wake` | 删前者，保留后者 | wake 概念属于 container-runner 域 |
| 依赖 | 装 `openinference-semantic-conventions` + `openinference-core` 全套 | helpers 减少手写错误 |
| Channel span 是否设 session.id | 否（channel 层 session 还未解析） | 设了也会和 root 分裂 |
| 是否禁止纯基础设施 span（DB open、idle heartbeat）| 是 | 见 §6 |

---

## 12. 来源 / 进一步阅读

- Phoenix Sessions tutorial：`arize-ai/phoenix` repo `docs/phoenix/tracing/how-to-tracing/setup-tracing/setup-sessions.mdx`
- OpenInference 语义规范：`arize-ai/openinference` repo `spec/semantic_conventions.md` / `spec/llm_spans.md` / `spec/traces.md`
- TypeScript helpers：`arize-ai/openinference` repo `js/packages/openinference-core/`
- 生产参考：`FlowiseAI/Flowise` repo `packages/components/src/handler.ts`（38k★）
- 现有 ADR：`docs/decisions/ADR-0011-host-otel-instrumentation.md`（PR-O2 host runtime 边界与 exporter 选型）

---

## 13. 后续 ADR 需要

本方法论一旦获批后，应至少创建以下 ADR 固化决策：

- **ADR-0012**: `Trace root span placement = router.deliver_to_agent`（§7.2 决策）
- **ADR-0013**: `Adopt OpenInference semantic conventions for all host & container spans`（§3 schema 引入）

ADR 在 PR-O2.1 实施 commit 中一并落地。

---

**审批后归档路径**：本文件保留在 `docs/observability-instrumentation-methodology.md`，作为 LLM-facing source of truth；HTML 渲染版交付 `reports/human/observability-methodology-2026-05-29.html`。
