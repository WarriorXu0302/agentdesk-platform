# ADR-0028: 后端网关契约硬化（散文约定 → 可验证契约）

- **Status**: Accepted
- **Date**: 2026-06-13
- **Decider(s)**: yingqi2@memov.ai（提案/拍板），coding agent（执行）
- **Tags**: `erp-gateway`, `contract`, `security`, `migration`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

后端网关是平台唯一的业务路径（CLAUDE.md load-bearing 不变量）：所有
授权、执行、长期记忆都必须经过它。但在本 ADR 之前，这条最关键的边界只是
一份**散文契约**（`docs/enterprise-erp-gateway.md`）+ 五个工具的 JSON
Schema。具体差距（已核实）：

- 五个工具的 `inputSchema` 没有 `additionalProperties: false`，agent 可以
  往工具参数里乱塞未声明字段——注入面比必要的宽。
- `callGateway` 在 `!response.ok` 时只返回一串自由文本错误，没有封闭的
  错误码、没有结构化形状，agent 无法据此判断"该不该重试"。
- 请求信封里没有版本号，平台和后端无法协商契约演进。
- 写操作（`/execute`）的 `idempotencyKey` 是可选的（gateway.ts:552），
  agent 不传就没有，后端无法对重试的写做去重。
- 响应完全不校验——散文契约明说"你控制 payload 形状"。

触发点：openclaw 对标清单里"契约硬化/契约测试"一项，以及全仓成熟度审计
中"身份链可伪造/契约松散"的确认差距。这是平台核心差异化，值得把散文升级
成机器可验证的单一真相源。

**硬约束**：绝不能让现有已部署的网关实现挂掉。

## Options Considered

- **Option A：全面强制（请求+响应都用 zod 严格校验，不符即拒）。**
  优点：最干净、最安全。缺点：直接违背"你控制 payload 形状"的既有承诺，
  现有后端响应一旦不完全匹配就全线报错——破坏向后兼容，不可接受。
- **Option B：维持散文，仅补文档。** 优点：零风险。缺点：没有任何机器
  可验证性，下一个 agent / 运营者仍要靠读散文 + 反推代码理解契约，等于
  没解决问题。
- **Option C（采纳）：非对称硬化。** 平台**发出**的东西收紧（信封版本、
  idempotency、输入白名单——都是平台自产，收紧绝对安全）；后端**返回**的
  东西默认只告警不拒（opt-in 严格模式），保住"你控制 payload"的承诺。
  错误码用封闭枚举 + HTTP 状态分类器兜底。配套一个 conformance 跑手让
  运营者主动自测后端。

## Decision

> **拍板**：选 Option C —— 非对称契约硬化。

核心理由（均可验证）：

1. **平台发出方向可无条件收紧**：信封字段、idempotency、输入白名单都是
   平台自己生成的，收紧不可能让任何后端收到比以前更宽松/更怪的请求，因此
   零兼容风险。对应测试见 `gateway.test.ts` 的 "gateway contract hardening"
   block。
2. **后端返回方向默认 warn**：响应不符 schema 时默认 `log.warn` + 记一条
   `errorCode: RESPONSE_SCHEMA_MISMATCH` 的审计标记，**仍返回 ok**；只有
   `GATEWAY_STRICT_RESPONSES=true` 时才当错误拒。这样既给出可观测信号，又
   不背叛"你控制 payload 形状"。
3. **单一真相源**：所有 schema、`CONTRACT_VERSION`、错误码枚举、HTTP 分类器
   都在 `src/mcp-tools/gateway-contract.ts`，运行时和 conformance 跑手共用，
   不再有"散文说一套、代码做一套"的漂移空间。

四件套：**封闭错误码 + contractVersion + idempotency + 输入白名单。**

## Consequences

- **Positive**：
  - 契约可被 CI / conformance 跑手机器验证，运营者上线后端前能自测。
  - agent 拿到 `{code, retryable, retryAfterMs}`，可对 `BACKEND_UNAVAILABLE`
    / `TIMEOUT` 做有依据的重试，而不是面对自由文本干瞪眼。
  - 写操作必有 idempotencyKey，后端去重有依据。
  - 输入白名单把 agent 注入面收窄到声明字段。
- **Negative / 债务**：
  - 引入了 `contractVersion` 协商语义，未来不兼容改动要负责任地 bump 并
    在本 ADR 系谱里记录。
  - 严格响应模式默认关闭，意味着"理论上"后端可以一直返回不合规 payload 而
    只产生 warn——需要运营者主动看告警 / metric 或开严格模式。
- **Neutral / Trade-offs**：
  - 错误码做成封闭枚举，新增码需改 `gateway-contract.ts` 并重新评估
    classifier 映射。
  - host 侧 `gateway_audit` 表没有新增 `error_code` 列（避免迁移），错误码
    以 `[CODE]` 前缀折进 `error_msg`，并在容器侧审计 content 里带独立
    `errorCode` 字段（host handler 透传 errorMsg 不变）。若将来要按码聚合
    查询，再考虑加列。

## 与身份信任链的关系（不碰）

契约硬化**完全不触碰**身份信任链：`resolveRequester()` 的身份解析、
`requesterSource`（`session` / `agent-asserted`）语义一字未改。新增的
`requester` schema 只是**描述**其形状，绝不改变其取值来源——身份永远来自
host 写入的 inbound.db，不从 agent 工具参数取。输入白名单
（`additionalProperties: false`）也不影响这条：身份本就不从 agent 输入读，
白名单只是额外挡掉 agent 乱塞字段。审计仍是每调用一行。

## Implementation Notes

- 契约真相源：`container/agent-runner/src/mcp-tools/gateway-contract.ts`
  （`CONTRACT_VERSION`、5 个请求信封 schema、宽松响应 schema、
  `GatewayErrorCode` 封闭枚举、结构化错误 schema、`classifyHttpError`、
  `parseGatewayError`、`defaultRetryable`）。
- 运行时接线：`container/agent-runner/src/mcp-tools/gateway.ts`
  （`callGateway` 加 `contractVersion`、结构化错误解析、`checkResponse`
  响应校验 warn/strict；`handleGatewayExecute` 自动生成 idempotencyKey；
  5 工具加 `additionalProperties: false`；`gatewayErr` 把 code/retryable
  回给 agent）。
- conformance 跑手：`container/agent-runner/scripts/gateway-conformance.ts`
  （`cd container/agent-runner && bun scripts/gateway-conformance.ts <baseUrl>`）。
- 文档：`docs/enterprise-erp-gateway.md`（信封含 contractVersion、错误码表、
  idempotency 语义、严格模式开关、conformance 用法）。
- 严格模式开关：环境变量 `GATEWAY_STRICT_RESPONSES=true`。
- 测试：`container/agent-runner/src/mcp-tools/gateway.test.ts` 的
  "gateway contract hardening" describe block（6 类验收）。
- 依赖的上游：ADR-0017（身份 origin 交叉校验）、ADR-0018（HMAC 签名启用）
  —— 本 ADR 不改动这两者建立的信任链。
- 后续验收点：conformance 跑手退出码、`gateway_audit` 中 `errorCode` 标记、
  `RESPONSE_SCHEMA_MISMATCH` 告警是否被运营者纳入监控。

## References

- `docs/enterprise-erp-gateway.md` — 正式化后的契约
- ADR-0017、ADR-0018 — 身份信任链与签名
- openclaw 对标清单（契约硬化/契约测试项）
- 全仓成熟度审计 2026-06（契约松散差距）
