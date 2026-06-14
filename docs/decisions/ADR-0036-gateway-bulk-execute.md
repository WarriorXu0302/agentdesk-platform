# ADR-0036: Optional `/bulk_execute` gateway endpoint for batch operations

- **Status**: Accepted
- **Date**: 2026-06-14
- **Decider(s)**: 平台 owner（拍板）；coding agent（提案 + 执行）
- **Tags**: `erp-gateway`, `contract`, `bulk`, `idempotency`, `backward-compat`
- **Supersedes**: —
- **Superseded by**: —

---

## Context

业务侧优化 backlog 3.1（价值 高):网关契约的 `/execute` 是**单操作信封**——
`input: Record<string, unknown>`,一次一个 `operation`。真实 ERP 流程常涉及批量:
薪资发放、发票对账、库存同步、"原子创建 50 个订单"。今天 agent 只能循环调用
`/execute` 50 次,代价是:

- **延迟倍增**:50 次串行往返,每次都进 agent 上下文。
- **审计膨胀**:`gateway_audit` 多 50 行(host 侧每次一行)。
- **部分失败窗口放大**:50 次独立调用,中途失败后状态难以推理。

后端**可以**自定义一个 `bulk_create` 操作,但平台对此**零指引、零示例、零脚手架**,
每个运营者从头发明自己的批量约定。

已知约束:
- 契约已按 ADR-0028 硬化为 zod 可验证 + 闭合错误码 + 写操作 `idempotencyKey`。任何新增
  必须**向后兼容**(passthrough + optional 字段),不能破坏既有后端。
- load-bearing 不变量:身份信任链(`requesterSource` 门控写)、后端网关是业务的唯一路径、
  host 签名代理(ADR-0034)的路径 allowlist(`READ_PATHS`/`WRITE_PATHS`)。新端点必须落入
  这套既有信任模型,不能新开身份面。
- 平台保持业务无关:不内置工作流/事务协调器(见 3.7 / ADR 无)。

## Options Considered

- **Option A — per-batch 单一 `idempotencyKey`**:整批一个 key。简单,但**部分提交后重试语义
  含糊**:批中前 30 个已提交、后 20 个失败,重试整批时后端无法仅凭一个批级 key 知道哪些该跳过。
  工作量 S,但正确性差。
- **Option B — per-operation `idempotencyKey`(选中)**:批里每个操作带自己的 key(agent 省略则
  客户端自动生成,镜像 `/execute` 的现有行为)。重试整批时,每个操作按自己的 key 去重——已提交的
  replay、未提交的执行。部分失败可安全重试。工作量 M。
- **Option C — 不加端点,文档化"循环 execute"**:驳回。3.1 价值 高,真实批量流程被 50 次往返
  的延迟 + 审计膨胀 + 部分失败窗口拖累;"零脚手架"正是痛点。
- **Option D — 平台侧 fan-out(host 循环 execute)**:驳回。违反"后端拥有业务逻辑";平台无法提供
  后端级原子性;host 不应编排业务操作(也会把批量审计/重试逻辑塞进 host,违背三库单写的简洁)。

## Decision

> **拍板**:选 Option B —— 新增**可选**的 `POST /bulk_execute`,per-operation 幂等,可选
> `atomic` 标志(由后端保证,平台不强制),默认 best-effort 部分成功。

核心理由(可验证):
1. **per-op 幂等比 per-batch 安全**:每个操作独立去重,部分提交后重试不会双写已提交项——
   这是批量正确性的关键,A 做不到。
2. **可选 + 404 优雅降级**:未实现的后端返回 404 `OPERATION_NOT_FOUND`(沿用 `/memory/search`
   的可选端点模式),客户端把它翻译成"回退到逐个 `gateway_execute`"。既有后端零影响。
3. **复用既有信任模型**:`/bulk_execute` 用与 `/execute` 相同的信封(`agent`/`requester`/
   `requesterSource`),写门控不变;加入签名代理 `WRITE_PATHS`(写作用域 token),与 `/execute`
   同等信任。不新开身份面 → 身份信任链不被削弱。
4. **原子性是后端的保证,不是平台的**:平台无跨操作事务协调器。`atomic:true` 只是**请求**
   后端在单事务内全做或全不做;无法保证的后端应**拒绝** `atomic:true`(返回错误),而不是假装。

### 契约形状

请求(`bulkExecuteRequestSchema`,加入 `REQUEST_SCHEMAS['/bulk_execute']`):

```jsonc
{
  // envelopeBase: contractVersion, agent, requester, requesterSource
  "operations": [
    { "operation": "demo.order.create", "input": { "sku": "A", "quantity": 1 }, "idempotencyKey": "..." }
    // 1..N。每项有自己的 idempotencyKey(dryRun 时可为 null)
  ],
  "context": {},
  "dryRun": false,
  "atomic": false   // 可选。默认 false=best-effort 部分成功;true=请求后端全做或全不做
}
```

响应(`bulkExecuteResponseSchema`,lenient + passthrough):

```jsonc
{
  "ok": true,
  "results": [
    { "ok": true, "result": { /* ... */ }, "auditId": "..." },   // 或 dryRun 时 "preview"
    { "ok": false, "error": { "code": "VALIDATION_FAILED", "message": "..." } }
  ],
  "partial": true   // best-effort 模式下有任一失败时为 true;atomic 模式失败则 ok:false 且不提交
}
```

### 语义

- **可选**:未实现 → 404 → 客户端回退提示逐个 `gateway_execute`(retryable=false)。
- **per-op 幂等**:agent 省略则客户端为每个非 dryRun 操作自动生成 key。
- **atomic**:默认 false(best-effort,`partial` 标失败)。true 由后端在单事务保证;不能保证应拒绝。
- **dryRun**:预览所有操作,**不提交任何一个**(conformance 用 dryRun 探测,不写真实数据)。
- **审计**:host `gateway_audit` 表每次网关调用一行,故 `/bulk_execute` 记**一行**(path=
  `/bulk_execute`,inputHash 按 operations 摘要)。每个操作的后端级审计由后端负责(各自返回
  `auditId`),可与 host 行关联。这是有意取舍:host 审计是"调用粒度",细到操作粒度的轨迹在后端。

### 实现面(后续 commit 按此执行)

1. `gateway-contract.ts`:加 bulk 请求/响应 + 操作项 schema;`/bulk_execute` 入 `REQUEST_SCHEMAS`/
   `RESPONSE_SCHEMAS`(→ 成为 `GatewayPath`)。
2. `gateway.ts`:加 `gateway_bulk_execute` MCP 工具(每个非 dryRun 操作自动生成 key);404 → 回退提示。
3. `gateway-signing-proxy.ts`:`/bulk_execute` 加入 `WRITE_PATHS`(写作用域)。
4. `examples/reference-gateway/server.mjs`:实现 `/bulk_execute`(循环 `runOperation` + per-op 幂等
   replay + `atomic` + best-effort `partial`)。
5. `gateway-conformance.ts`:加 `/bulk_execute` 样本(dryRun、`conformance.noop`),可选(404 不算违约)。
6. 文档:`enterprise-erp-gateway.md` + `gateway.instructions.md`(何时用 bulk、per-op vs per-batch
   幂等、atomic 语义、404 回退)。
7. 测试:契约 schema 单测、签名代理新路径单测、reference 冒烟、conformance 绿。

## Consequences

**正面**:
- 真实批量流程(薪资/对账/库存)一次往返完成,延迟与审计膨胀大幅下降。
- 运营者有可 clone 的范例(reference-gateway)+ 文档化的幂等/原子权衡,不再从零发明。
- 完全向后兼容:既有后端不实现即 404,客户端优雅回退。

**负面 / 代价**:
- 契约面 +1 端点 + 1 客户端工具,需维护 + conformance 覆盖。
- host `gateway_audit` 对 bulk 是"一行/调用"粒度;细粒度操作轨迹依赖后端审计(已在文档说明)。
- `atomic` 的真实性依赖后端诚实实现(平台无法验证);文档明确"不能保证就拒绝"。

**load-bearing 不变量检查**:身份信任链——复用 `/execute` 信封 + `requesterSource` 写门控,
不新开身份面 ✓;后端网关唯一路径——bulk 仍是网关调用 ✓;签名代理——bulk 入 `WRITE_PATHS`,
写作用域 token,与 execute 同等 ✓;三库单写 / 观测只读——不涉及 ✓;向后兼容——可选 + 404 降级 ✓。

**回滚**:移除端点即可(客户端工具 + schema + 代理路径),既有单操作 `/execute` 不受影响。
