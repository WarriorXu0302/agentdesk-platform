# ADR-0020: 宿主进程硬化 — ingress 限制、健康探针与优雅停机排空

- **Status**: Accepted
- **Date**: 2026-06-12
- **Decider(s)**: 用户（yingqi2@memov.ai，平台 owner）；coding agent（提案 + 执行）
- **Tags**: `reliability`, `security`, `delivery`, `observability`, `deployment`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

成熟度审计（MEMORY: platform-maturity-audit-2026-06）标记 host 进程缺乏生产运行时硬化。
排查 `src/webhook-server.ts` / `src/index.ts` / `src/delivery.ts` 确认四个结构性弱点：

1. **ingress 无上限缓冲（DoS）**：`toWebRequest` 把整个请求体无上限 `Buffer.concat`
   进 host 内存。一个恶意或失控的发送方流式推送超大 body 即可把单进程 host OOM。
2. **同端口暴露、无鉴权、无超时**：`/metrics` 与公网 webhook 同在 `0.0.0.0:WEBHOOK_PORT`，
   `/metrics` 无任何鉴权（指标可被任意抓取，泄露拓扑/流量画像）；`createServer` 未设
   `requestTimeout` / `headersTimeout`，slow-loris 式慢速连接可长期占住 socket。
3. **无健康探针**：编排器（k8s / compose healthcheck）没有 liveness/readiness 端点可
   探，滚动升级/自愈无法判断 host 是否就绪。
4. **停机不排空（重复投递放大）**：`index.ts` 的 `shutdown` 从不调用 `stopWebhookServer()`
   （监听始终不关）；`stopDeliveryPolls()` 只翻布尔标志，不等 `inflightDeliveries` 排空就
   `process.exit(0)`。`adapter.deliver()` 已成功但 `markDelivered()` 未落盘的窗口期里退出，
   会让重启后的补投把同一条消息再发一次 —— 直接放大 ADR-0016 的 at-least-once 重复窗口。

已知约束：

- **三库单写者不变量**（load-bearing）：排空只是"等内存里的 in-flight Set 清空"，不改变
  inbound.db 由 host 单写、open-write-close 的写入路径。
- **observability 只读**：新增的 `webhook_rejected_total` 计数器和 `/metrics` 鉴权都不触碰
  身份信任链或消息流。
- **向后兼容**：`/metrics` 在没有显式配置 token 时必须维持现状（公开），否则会打断已有的
  抓取部署。
- **品牌不硬编码**：新指标名走 `METRIC_PREFIX`（src/branding.ts）派生。
- 飞书 raw handler（`src/channels/feishu.ts`）已自行 size-limit 流式 body，本 ADR 不动它；
  host 层只补 Content-Length 预检兜底。

## Options Considered

- **Option A：在 host 进程内做最小硬化（本 ADR）**。`toWebRequest` 流式累加超限即抛 →
  413；dispatch 前加 Content-Length 预检；`createServer` 后设两个 timeout；新增免鉴权
  `/healthz`+`/readyz`；`/metrics` 加可选 bearer；`delivery.ts` 导出
  `drainInflightDeliveries`，`shutdown` 改为"先停监听 → 停轮询 → 排空 → teardown"。
  优点：零新依赖、改动局限在 4 个文件、与现有 readEnvFile/METRIC_PREFIX 风格一致；缺点：
  排空只能缩小不能消除重复窗口（SIGKILL 仍在）。工作量：小。
- **Option B：引入反向代理（nginx / envoy）承担限流、鉴权、超时、健康检查**。优点：能力更全、
  与应用解耦；缺点：把运行时硬化推给"操作者必须正确部署反代"，开箱即坏的默认不变，且健康探针
  仍需进程内 readiness 语义。工作量：中（且属部署形态，非平台核心）。被驳回为"取代"而非"补充"
  ——反代是可选叠加，进程自身仍应有底线防护。
- **Option C：把停机做成 two-phase drain + 取消在途 deliver()**。优点：理论上能在超时后强制
  中断卡死的渠道调用；缺点：`deliver()` 无法安全取消（底层可能已发出），强行中断反而制造"以为
  没发其实发了"的丢失，与 ADR-0016 选定的 at-least-once 取向冲突。被驳回。

## Decision

> **拍板**：选 Option A。

理由（均可验证）：

1. 进程自身的底线防护不应依赖操作者正确部署反代 —— body 上限、超时、`/metrics` 鉴权开关
   都是开箱即用的默认。反代（Option B）作为可选叠加仍然兼容。
2. 排空（drain）顺序"先停监听再排空"能保证排空期间不再有新投递进来，从而真正缩小 ADR-0016
   的重复窗口；无法消除的部分（SIGKILL、超过排空超时的 `deliver()`）由 DB 层幂等兜底，
   契约维持 at-least-once 不变。
3. `/metrics` 鉴权对未设 token 的部署保持公开（向后兼容），仅在显式设置 `METRICS_AUTH_TOKEN`
   时收紧 —— 不打断现有抓取，又给生产一个收口开关。

## Consequences

- **Positive**：
  - host 不再能被超大 body OOM；超大请求以 413 + `webhook_rejected_total{reason="body_too_large"}`
    可观测地拒绝。
  - 编排器可用 `/healthz`（liveness）与 `/readyz`（readiness：DB 可读 + 容器运行时可达）做
    自愈和滚动升级；摘流量后再 SIGTERM 可显著降低重复投递。
  - slow-loris 类慢速连接被 `headersTimeout`/`requestTimeout` 兜底。
  - `/metrics` 有了收口开关。
- **Negative / Trade-offs**：
  - **重复投递窗口缩小但不消除**：SIGKILL（如 `terminationGracePeriod` 太短）或单次 `deliver()`
    耗时超过排空超时，仍可能在 markDelivered 落盘前退出 → 重启补投重发。这是 ADR-0016 选定的
    at-least-once 的固有代价，本 ADR 只是把窗口从"必然"压到"边角"。运维须给足
    `terminationGracePeriod`（≥ 排空超时 + 余量）。
  - `/readyz` 的容器运行时探测每次请求执行一次 `<runtime> info`（3s 超时）。探针轮询过密会有
    额外开销，文档建议探测间隔 ≥10s。探测是软探测：任何失败都视为 not-ready 返回 503，绝不向上
    抛错（readiness 不能把探针自己搞崩）。
  - `/metrics` 默认仍公开（向后兼容）。生产若不设 `METRICS_AUTH_TOKEN` 也不用反代隔离，指标对
    同网段可见 —— 文档已显式提示。
  - **liveness vs readiness 语义边界**：`/healthz` 恒 200，只表示进程没死，不代表能干活；不要拿
    它当流量门控。`/readyz` 才是"能不能接活"，滚动升级/负载摘流应基于 `/readyz`。

## Implementation Notes

- 落地文件：
  - `src/webhook-server.ts`：`toWebRequest` 流式 size 守卫（超限抛 `PayloadTooLargeError` →
    dispatch 捕获返回 413）；dispatch 前 Content-Length 预检（兜底 raw handler 路径，因 raw
    handler 自己消费 stream）；`server.requestTimeout` / `server.headersTimeout`；
    `/healthz`（恒 200 `ok`）、`/readyz`（DB `SELECT 1` + 容器运行时 `info` 软探测，失败 503
    + 原因）；导出 `HEALTHZ_PATH` / `READYZ_PATH` / `METRICS_PATH` 常量。
  - `src/metrics.ts`：`webhookRejectedTotal{reason}` 计数器（`body_too_large` / `unauthorized`）；
    `handleMetricsRequest` 加可选 bearer（`METRICS_AUTH_TOKEN` 走 process.env → .env → 未设）。
  - `src/delivery.ts`：导出 `drainInflightDeliveries(timeoutMs=10000)` —— 轮询等 `inflightDeliveries`
    清空或超时，不 reject（停机必须继续）。
  - `src/index.ts`：`shutdown` 改序为 `await stopWebhookServer()`（此前**缺失**）→ `stopDeliveryPolls()`
    / `stopHostSweep()` → `await drainInflightDeliveries()` → teardown → 退出。
- env 变量：`WEBHOOK_MAX_BODY_BYTES`（默认 1 MiB）、`WEBHOOK_REQUEST_TIMEOUT_MS`（30s）、
  `WEBHOOK_HEADERS_TIMEOUT_MS`（10s）、`METRICS_AUTH_TOKEN`（未设=公开）；读取走 `readEnvFile` 既有模式。
- 端点：`GET /healthz`、`GET /readyz`、`GET /metrics`（鉴权可选）。
- 依赖的上游 ADR：ADR-0016（delivery 韧性 / at-least-once 与重复窗口的来源）。
- 验收点：`src/webhook-server.test.ts`（413 + 两态鉴权 + healthz/readyz 就绪/不就绪）、
  `src/delivery.test.ts`（drainInflightDeliveries 有在途/无在途/超时三态）。

## References

- ADR-0016 出站投递韧性（at-least-once、重复窗口）
- MEMORY: platform-maturity-audit-2026-06（进程硬化差距来源）
- 相关文件：`src/webhook-server.ts`、`src/index.ts`、`src/delivery.ts`、`src/metrics.ts`
- 文档：`docs/PLATFORM.md` §6.2 环境变量速查、§6.5 健康探针与优雅停机
