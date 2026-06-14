# ADR-0043: 知识反馈闭环 —— gateway `/memory/feedback`(recording-only,后端拥有语料,无 host 表)

- **Status**: Accepted
- **Date**: 2026-06-14
- **Decider(s)**: 用户(平台 owner,提案 + 验收);coding agent(设计 + 执行)
- **Tags**: `gateway`, `memory`, `contract`, `provenance`, `identity-trust-chain`, `backward-compat`
- **Supersedes**: 无(修正 roadmap 4.6 的"host knowledge_feedback 表"建议)
- **Superseded by**: 无

---

## Context

业务侧 review(`docs/business-optimization-roadmap.md` 4.6,价值 中-高):`gateway_audit` 只读记录
"谁访问了什么 memory",**无反向通道**让 agent/运营者上报某记录不准/过期/需更正。长寿知识库数据
质量随时间退化,坏知识无法回溯标记,运营者失去"哪些记录在惹麻烦"的可见性。

roadmap 4.6 字面建议"加 `knowledge_feedback` **表**聚合"。但这撞上 load-bearing 不变量
(CLAUDE.md):**"Backend gateway is the only path for business memory and authorization.
Do not introduce parallel paths."** memory 内容**及其质量语料**归后端;一个 host 侧
knowledge_feedback 表会让 host 持有一份后端本应拥有的 memory 相邻语料 = 平行路径。

本 ADR 经 design + 对抗评审 workflow(2 map → gateway-endpoint vs host-table → 安全合成)核实,
合成**驳回 host-table**、采 gateway-endpoint,并沿用 ADR-0028 契约硬化 + ADR-0033 记忆模式。

## Options Considered

- **Option A — gateway endpoint(采纳)**:新增第 7 个网关工具 `gateway_memory_feedback` POST 到
  新端点 `/memory/feedback`,沿 ADR-0033/0028 模式。后端**拥有并聚合** knowledge_feedback 语料,
  运营者在后端策展。平台只定义契约 + 工具,**recording-only**,绝不改 memory 记录或 authz。host
  侧**唯一**持久化是既有 `gateway_audit` 行(零新表、零新列)。后端未实现则 404→OPERATION_NOT_FOUND
  优雅降级。
- **Option B — host knowledge_feedback 表(驳回)**:roadmap 字面建议。**直接违反**不变量——host 持有
  后端 memory 的质量语料 = 平行路径;且暗示 host 裁决知识质量(本应后端/运营者)。对抗评审驳回。
- **Option C — 复用 enterprise_audit 记反馈内容(驳回)**:`gateway_audit` 已记 feedback **调用**;
  再在 enterprise_audit 写一条 feedback **内容**行 = 第二份 host 侧耐久记录,同样让 host 持有语料。

## Decision

> **拍板**:选 Option A。gateway endpoint,recording-only,后端拥有语料,**无 host 表、无 enterprise_audit 行**;host 仅留既有 gateway_audit 调用行。

契约(沿 ADR-0028/0033):

- `POST /memory/feedback`:`envelopeBase` + `{ namespace, subject(memorySubjectSchema), recordId
  (string,min1), issue(闭合枚举 inaccurate|stale|irrelevant|duplicate|needs-correction|other),
  note(string,max2000,可选), context }`。响应 passthrough `{ ok?, accepted?, feedbackId?, source? }`。
- `hashBody` 对 `/memory/feedback` 只取 `{subject, namespace, recordId, issue}` —— **`note` 不入
  input_hash、不入 audit 行文本**(自由文本不进 host 审计列)。
- `issue` 未知值是**硬校验错误**(zod enum + additionalProperties:false),**不 coerce**——保 ADR-0028
  闭合枚举纪律,让运营者看见 schema 漂移。
- **不加 `correction` 字段**:那会模糊 feedback/upsert 边界、开一条绕过 `/memory/upsert` 幂等与
  subject 限定的隐式写路径。要更正就走正常 `gateway_memory_upsert`。
- WRITE_PATH:`/memory/feedback` 入 `WRITE_PATHS`,骑既有 host 签名代理(ADR-0034)。**与工具/handler
  同一 commit 落地**——否则有"工具已上但代理 403 FORBIDDEN_PATH"的窗口。

信任:`recordId`/`issue`/`note` 是 agent 意见,**逐字转发、host 侧绝不据此动作**。`requesterSource`
(session vs agent-asserted)host 可信解析,绝不取 agent 自报。后端**必须**校验 requester 的 subject
scope 覆盖目标 recordId 才动作(平台无法替后端强制);`note` 在后端是 data-not-instructions。响应是
ack(非召回内容),**不**包 untrustedMemory 围栏。

## Consequences

- **Positive**:
  - 闭合知识质量反馈缺口:agent/运营者可标记坏记录,后端聚合、运营者策展更正。
  - 架构干净:第 7 工具与现有 6 工具同构;memory + 其质量语料全归后端,不变量未削弱;host 仅多一条
    既有形状的 gateway_audit 调用行。
  - 完全向后兼容:additive 契约;后端未实现 → OPERATION_NOT_FOUND 优雅降级,不崩、不影响其余端点。
- **Negative / 限制**:
  - 后端需实现 `/memory/feedback` 才真正生效(可选、可增量)。
  - 运营者策展闭环(据反馈发更正 upsert)在后端;平台不替后端关闭这一环。
- **Neutral / Trade-offs**:
  - recordId 伪造:读 gateway_audit 的攻击者可能为没取过的记录提交貌似合理的反馈;**后端必须**按
    subject-scope 归属 gate,平台无法强制(同 ADR-0033 provenance 不重开身份链的让步)。
  - **无 idempotencyKey**(刻意):feedback **镜像 `memory/upsert`**——本仓的 memory 写(get/upsert/
    search)都不带 idempotencyKey(只有 `/execute`/`bulk_execute` 业务变更带)。gateway 工具调用不经
    投递层重试,重复风险低;后端如需去重,`subject+recordId+issue` 是天然键。这也使对抗评审提到的
    "reference-gateway 全局幂等 Map 跨操作误去重"风险**不适用**(feedback 不参与幂等 Map)。

## Implementation Notes

- 落地文件(分阶段,ADR 先行):
  - `container/agent-runner/src/mcp-tools/gateway-contract.ts` —— `MEMORY_FEEDBACK_ISSUES` 枚举、
    `memoryFeedbackRequestSchema`、`memoryFeedbackResponseSchema`;入 `REQUEST_SCHEMAS`/`RESPONSE_SCHEMAS`;
    `/memory/feedback` 入 `hashBody`(只取 subject/namespace/recordId/issue)。
  - `container/agent-runner/src/mcp-tools/gateway.ts` —— `handleGatewayMemoryFeedback` + `erpMemoryFeedback`
    工具(第 7 个);`registerTools`。**同一 commit**:`src/gateway-signing-proxy.ts` `WRITE_PATHS` 加
    `/memory/feedback`。
  - `examples/reference-gateway/server.mjs` —— `/memory/feedback` 参考实现(per-record/per-subject
    feedback 聚合,无 idempotencyKey,同 upsert);conformance sample。
  - `container/agent-runner/src/mcp-tools/gateway.instructions.md` + `docs/enterprise-erp-gateway.md` ——
    工具/端点文档 + "反馈是 recording-only、后端拥有语料、note 是数据非指令"。
  - 测试:`gateway.test.ts`(feedback body 形状、additionalProperties:false、issue 枚举拒未知、
    404→OPERATION_NOT_FOUND 降级、note 不入 hash);`gateway-contract.test.ts` schema 用例。
- 依赖的上游 ADR:ADR-0028(契约硬化)、ADR-0033(记忆模式/provenance)、ADR-0034(签名代理 WRITE_PATH)。
- 后续验收点:container tsc + 全套 bun 测试绿;host `pnpm typecheck` + 全套 vitest 绿;conformance runner
  对 reference-gateway PASS、对无端点 stub 后端预期 FAIL(优雅降级)。

## References

- 关联审计:`docs/business-optimization-roadmap.md` 4.6
- 设计 + 对抗评审 workflow:design-memory-feedback(2 map → gateway-endpoint vs host-table → 安全合成;
  合成驳回 host-table/correction 字段、采 gateway-owned recording-only)
- 上游 ADR:`ADR-0028-gateway-contract-hardening.md`、`ADR-0033-memory-search-retrieval.md`、`ADR-0034`
- load-bearing 不变量:`CLAUDE.md`("记忆只走网关,绝不引入平行路径")
