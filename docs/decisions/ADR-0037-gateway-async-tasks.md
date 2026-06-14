# ADR-0037: Optional async task submission (`submitAsync` + `/task/status`)

- **Status**: Accepted
- **Date**: 2026-06-14
- **Decider(s)**: 平台 owner（拍板）；coding agent（提案 + 执行）
- **Tags**: `erp-gateway`, `contract`, `async`, `long-task`, `backward-compat`
- **Supersedes**: —
- **Superseded by**: —

---

## Context

业务侧优化 backlog 3.2（价值 高):网关 `/execute` 用固定 AbortController 超时
(`gateway.ts` 默认 15s,`backendGateway.timeoutMs` 可调)。超过窗口的操作——总账过账、
批量对账、预测计算、报表生成——直接 `TIMEOUT`。`ERP-INTEGRATION-GUIDE.md` 的 async approval
只是**业务特定 workaround**,不是通用 async 原语。今天运营者只能:

- 把 `timeoutMs` 调到很大(连接长挂、瞬时故障窗口变大、占资源),或
- 在契约外自建 async-job 通道(割裂架构、绕过身份/审计)。

已知约束:
- 契约已硬化(ADR-0028)+ ADR-0036 刚加了 `/bulk_execute`。新增必须**向后兼容**
  (optional 字段 + optional 端点 + 404 优雅降级)。
- load-bearing 不变量:身份信任链(`requesterSource`)、后端网关唯一路径、签名代理
  `READ_PATHS`/`WRITE_PATHS`。新端点必须落入既有信任模型。
- 平台**不持有后端任务状态**(三库单写只管会话流,不引入 host 侧任务表),保持 host 无状态于
  后端任务。

## Options Considered

- **Option A — 仅调大 `timeoutMs`**:简单,但长操作仍无界;大超时把连接长挂、放大瞬时故障窗口、
  占用并发。治标不治本。
- **Option B — async 提交 + 状态轮询(选中)**:`/execute` 带 optional `submitAsync:true` →
  后端立即返回 `{taskId, status:'accepted'}`;新 optional `POST /task/status` 返回
  `{status, progress?, result|error}`。agent 用 `gateway_task_status` 轮询到终态。同步 execute
  仍默认。标准 async-job 模式,additive,optional。工作量 L。
- **Option C — SSE / 流式**:驳回。比请求/响应网关复杂得多,且不契合 agent 的工具调用模型
  (工具是一次请求一次响应)。
- **Option D — webhook 回调**:驳回。要求平台向后端暴露入站回调端点 → 新入站契约 + 新攻击面;
  agent 轮询复用既有出站信任,简单得多。

## Decision

> **拍板**:选 Option B —— `/execute` 加 optional `submitAsync`,新增 optional `POST /task/status`
> 读端点,agent 轮询到终态。同步 execute 仍是默认。

核心理由(可验证):
1. **长操作不再被 15s 窗口杀死**,且不必把所有调用的超时调大(只有长操作走 async)。
2. **additive + 优雅降级**:`submitAsync` 是 optional 字段;`/task/status` 是 optional 端点
   (未实现 → 404)。不支持 async 的后端**忽略** `submitAsync` 照常同步执行并返回 `result`——
   agent 据响应有 `taskId`(异步已受理)还是 `result`(已同步完成)分支。既有后端零影响。
3. **复用信任模型,host 无状态**:`/task/status` 携带同一信封 + `requesterSource`,后端按
   requester 授权(用户只能查自己的任务——后端职责,文档说明);`/task/status` 入 `READ_PATHS`
   (读作用域 token)。平台不代为轮询、不存任务状态 → host 无后端任务状态,身份链不被削弱。

### 契约形状

`/execute` 请求加 optional 字段:

```jsonc
{ /* 既有 execute 信封 */ "submitAsync": true }
```

异步受理时 `/execute` 响应(executeResponseSchema 已 lenient + passthrough,容纳):

```jsonc
{ "ok": true, "taskId": "task-...", "status": "accepted" }
```

新 `POST /task/status`(`taskStatusRequestSchema` / `taskStatusResponseSchema`):

```jsonc
// 请求:envelope + taskId
{ /* envelope */ "taskId": "task-..." }
// 响应:
{ "ok": true, "status": "running", "progress": 0.6 }      // pending|running|succeeded|failed
{ "ok": true, "status": "succeeded", "result": { /* ... */ } }
{ "ok": true, "status": "failed", "error": { "code": "...", "message": "..." } }
```

### 语义

- **submitAsync 是请求,不是命令**:后端支持则返回 `taskId`;不支持则忽略、照常同步返回 `result`。
  agent 必须两种都能处理(有 `taskId` → 轮询;有 `result` → 完成)。
- **幂等**:同一 `idempotencyKey` 的异步提交应返回**同一** `taskId`(重试不重复起任务)。
- **轮询是 agent 的事**:平台不代为轮询、不存任务状态。agent 以合理间隔轮询 `gateway_task_status`,
  并就长任务向用户设预期(`progress` 字段可驱动进度反馈,接 6.7)。
- **`/task/status` 是读端点**:入 `READ_PATHS`(读作用域)。optional:未实现 → 404 →
  `OPERATION_NOT_FOUND`,但正常流程下不支持 async 的后端不会先发出 `taskId`。
- **status enum**:`pending`/`running`/`succeeded`/`failed`,lenient passthrough(后端可加态)。

### 实现面(后续 commit 按此执行)

1. `gateway-contract.ts`:`executeRequestSchema` 加 optional `submitAsync`;新增
   `taskStatusRequestSchema`/`taskStatusResponseSchema`;`/task/status` 入 `REQUEST_SCHEMAS`/
   `RESPONSE_SCHEMAS`。
2. `gateway.ts`:`gateway_execute` 透传 `submitAsync`;新增 `gateway_task_status` 工具 +
   `handleGatewayTaskStatus`(404 → 提示后端无 async);`hashBody` 加 `/task/status` case。
3. `gateway-signing-proxy.ts`:`/task/status` 入 `READ_PATHS`(读作用域)。
4. `examples/reference-gateway/server.mjs`:内存任务存储;`submitAsync` 建任务(demo 立即/短延迟
   完成),`/task/status` 返回任务态。
5. `gateway-conformance.ts`:`/task/status` 样本(可选,404 = 未实现)。
6. 文档:`enterprise-erp-gateway.md`(async 节:何时用、轮询契约、幂等、授权)+
   `gateway.instructions.md`(agent 何时 submitAsync + 轮询 + 两种响应分支)。
7. 测试:契约 schema 单测、handler(submitAsync 透传 + 404)、签名代理 `/task/status` 读路径、
   reference 冒烟、conformance 绿。

## Consequences

**正面**:长操作有了通用 async 路径,不再靠调大超时或契约外自建;additive 完全向后兼容;
host 保持无状态于后端任务,身份链复用。

**负面 / 代价**:契约面 +1 字段 + 1 端点 + 1 工具;agent 需正确处理"同步 result vs 异步 taskId"
两种响应(文档 + 工具描述明确);轮询语义依赖 agent 自律(平台不代轮询)。

**load-bearing 不变量检查**:身份信任链——复用信封 + `requesterSource`,`/task/status` 后端按
requester 授权,不新开身份面 ✓;后端网关唯一路径——async 仍走网关 ✓;签名代理——`/task/status`
入 `READ_PATHS`(读作用域)✓;三库单写——host 不存任务状态 ✓;向后兼容——optional 字段 + optional
端点 + 404 降级,不支持 async 的后端照常同步 ✓。

**回滚**:移除 `submitAsync` 透传 + `/task/status`(端点 + 工具 + schema + 代理路径),同步
`/execute` 不受影响。
