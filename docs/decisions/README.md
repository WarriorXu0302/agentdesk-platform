# Architecture Decision Records (ADR)

> 本目录是本仓的**架构决策档案**。每一份 ADR 记录一个值得后人知道"为什么"的决定。
> 失去"为什么"，下一个 coding agent 就只能从代码里反向猜测，而代码本身从不解释自己。

---

## 为什么需要 ADR

关键决策若只口头讨论或散落在 issue / chat / wiki 里，会导致：
- 接手者看不懂某些"看似多余"的代码为什么这样写
- 新 agent 容易"善意地"还原一个早已被否决的方案
- 顶层契约与实现细节之间没有清晰边界

ADR 是低成本的反熵机制：5 分钟落一份，下一个 agent 节省数小时。

---

## 何时必须写 ADR

下面任一情形发生，必须在同次 PR 内提交 ADR：

1. **改动公共契约**：DB schema、ERP gateway 接口、channel adapter 形状、container ↔ host 协议
2. **在 2 个以上可行方案中做出选择**（即使最后选了"看起来显然"的那个）
3. **引入新的依赖类别**：新的 LLM provider、新的 observability 后端、新的 storage、新的 sidecar
4. **否决 / 撤销 一个先前的 ADR**（写新 ADR + 把旧 ADR 标记为 Superseded）

何时**不必**写 ADR：
- 重命名局部变量、修 typo、补单元测试、debug 一个不改契约的 bug
- 已有 ADR 完全覆盖的实现细节

---

## 命名与格式约定

- 文件名：`ADR-NNNN-kebab-case-title.md`，N 为 4 位顺序号
- 顺序号**单调递增、不复用**（即使某份 ADR 被 Supersede，编号仍保留）
- 模板：`_template.md`
- 状态字段限定值：`Proposed | Accepted | Superseded by ADR-XXXX | Deprecated | Reverted`

### 关于缺失的编号

下面索引里的编号**不连续**——`0001-0006`、`0008`、`0009`、`0012`、`0013`
在仓库里都没有对应文件。这**不是丢了 ADR**：这些编号要么是在本仓泛化重构
（把单用户/特定业务的早期形态改造成通用企业多用户平台）之前就删除的旧 ADR，
要么从未真正存在，只在 git 历史里留过痕迹。按「顺序号单调递增、不复用」的约定，
重构时删掉的编号也不回收。需要追溯某个缺失编号的来历，去 git 历史里查，
不要新建文件去「补」它——补进来会和历史编号语义冲突。

## 与 `docs/audit/` 的关系

- `docs/audit/` 用于记录**审计型记录**（例如安全审计、合规复核、第三方评估的结论）
- `docs/decisions/`（本目录）用于记录**主动设计决策**
- 二者不重叠：审计是回看 + 评估，决策是前瞻 + 拍板

---

## ADR 索引

| ADR | 标题 | 状态 | 日期 | 标签 |
|---|---|---|---|---|
| [ADR-0007](ADR-0007-observability-phoenix-grafana.md) | Observability 框架：纯 Phoenix (ELv2) + Grafana | Accepted | 2026-05-18 | `observability`, `framework` |
| [ADR-0010](ADR-0010-rename-default-frontdesk-to-template.md) | Rename default frontdesk → template frontdesk（命名歧义修复 + LEGACY fallback） | Accepted | 2026-05-20 | `naming`, `refactor`, `frontdesk` |
| [ADR-0011](ADR-0011-host-otel-instrumentation.md) | Host OpenTelemetry Instrumentation（OTel SDK bootstrap + manual span + context bridge + trace-log 关联） | Accepted | 2026-05-29 | `observability`, `tracing`, `host-runtime` |
| [ADR-0014](ADR-0014-observability-span-schema.md) | Observability Span Naming Schema v1.0（hierarchical snake_case + OpenInference attribute matrix + 20 namespaces + 5 LOCKED decisions） | Accepted | 2026-05-31 | `observability`, `tracing`, `naming` |
| [ADR-0015](ADR-0015-observability-coverage-gate.md) | Observability Coverage Gate（schema/runtime drift CI gate） | Accepted | 2026-05-31 | `observability`, `tracing`, `ci`, `schema-governance` |
| [ADR-0016](ADR-0016-delivery-resilience.md) | 出站投递韧性（超时 + 有界并发 + 持久化退避重试 + dlq 死信工具） | Accepted | 2026-06-12 | `delivery`, `reliability`, `session-db`, `migration` |
| [ADR-0017](ADR-0017-identity-origin-crossvalidation.md) | 身份链 host 侧交叉校验 origin_user_id（用可信 inbound.db 校验容器自报，堵跨会话冒充） | Accepted | 2026-06-12 | `identity`, `security`, `a2a`, `trust-chain` |
| [ADR-0018](ADR-0018-hmac-signing-enablement.md) | HMAC 签名开通路径 + 未签名 group 可观测/告警 | Accepted | 2026-06-12 | `security`, `gateway`, `hmac`, `observability` |
| [ADR-0019](ADR-0019-fail-closed-security-defaults.md) | 安全默认值统一收紧为 fail-closed（admin/engage 正则/审批卡片操作者） | Accepted | 2026-06-12 | `security`, `fail-closed`, `permissions`, `feishu` |
| [ADR-0020](ADR-0020-process-hardening.md) | 宿主进程硬化（ingress body 上限/超时 + /healthz·/readyz 探针 + /metrics 鉴权 + 优雅停机排空） | Accepted | 2026-06-12 | `hardening`, `ingress`, `health`, `shutdown` |
| [ADR-0021](ADR-0021-metrics-alerting-loop.md) | 指标→告警闭环（Prometheus + Alertmanager + 告警规则 + RUNBOOK 防漂移测试） | Accepted | 2026-06-12 | `observability`, `metrics`, `alerting`, `runbook` |
| [ADR-0022](ADR-0022-inbound-persist-before-route.md) | 入站 persist-before-route（路由前持久化 + 操作员显式重放，关掉静默丢失窗口） | Accepted | 2026-06-12 | `reliability`, `ingress`, `recovery`, `at-least-once` |
| [ADR-0023](ADR-0023-roster-dm-grants.md) | Roster DM：宿主管控的、本人显式同意的、per-scope 定向私聊授权（槽位强制边界 + grant 生命周期） | Accepted | 2026-06-12 | `security`, `delivery`, `identity-trust-chain`, `feishu-channel`, `fail-closed` |
| [ADR-0024](ADR-0024-openai-context-compaction.md) | OpenAI provider 摘要式上下文压缩（对齐 Claude auto-compact，替代硬截断；删除 sdk-openai 玩具 provider） | Accepted | 2026-06-12 | `provider`, `context-management`, `openai`, `agent-runner` |
| [ADR-0025](ADR-0025-config-safety.md) | 配置安全：.env.example 权威清单 + 启动期保守 fail-fast + 拒绝占位密钥（仅功能启用时必填、不误伤现有部署） | Accepted | 2026-06-12 | `config`, `security`, `fail-closed`, `ops` |
| [ADR-0026](ADR-0026-runner-otel-instrumentation.md) | 容器 runner OTel 接入（端到端 trace：host root span → 容器内 turn/LLM/tool span；不上明文，纯旁路 fail-open） | Accepted | 2026-06-12 | `observability`, `tracing`, `agent-runner`, `phoenix` |
| [ADR-0027](ADR-0027-otel-content-capture.md) | trace 明文内容捕获（OTEL_CAPTURE_CONTENT opt-in，默认关；开启上完整 prompt/LLM消息/工具参数+结果，不脱敏；偏离 ADR-0007 R16 由运营者自担） | Accepted | 2026-06-12 | `observability`, `tracing`, `privacy`, `opt-in` |
| [ADR-0028](ADR-0028-gateway-contract-hardening.md) | 网关契约硬化（封闭错误码 + contractVersion 信封 + execute 幂等键 + 输入白名单 + zod 真相源 + conformance 跑手；发出收紧、响应默认 warn-only 向后兼容） | Accepted | 2026-06-12 | `gateway`, `contract`, `conformance`, `backward-compat` |
| [ADR-0029](ADR-0029-supply-chain-hardening.md) | 供应链/最小权限硬化（pre-commit 密钥拦截 + Dockerfile digest pin + obs 服务 cap_drop/no-new-privileges + agent 容器 no-new-privileges、cap_drop 可配置默认不动） | Accepted | 2026-06-12 | `security`, `supply-chain`, `least-privilege`, `pre-commit` |
| [ADR-0030](ADR-0030-channel-contract-testing.md) | 通道契约一致性测试（assertChannelAdapterContract 软门 + feishu 有状态路径测试 + 宿主主链路 e2e 骨架） | Accepted | 2026-06-12 | `channels`, `testing`, `contract`, `e2e` |
| [ADR-0031](ADR-0031-fork-free-channel-extensions.md) | 不 fork 主仓的通道扩展加载（运营者自控 EXTENSIONS_DIR + 版本门 + 契约门 + fail-open） | Accepted | 2026-06-13 | `channels`, `extensibility`, `open-source` |
| [ADR-0032](ADR-0032-container-egress-policy.md) | 容器 egress 联网管控（可配置 --network，默认不限制向后兼容；egress-proxy allowlist 缓解容器内明文密钥；host 侧签名代理记为后续） | Accepted | 2026-06-12 | `security`, `egress`, `container`, `least-privilege` |
| [ADR-0033](ADR-0033-memory-search-retrieval.md) | 记忆检索 gateway_memory_search（provenance + 召回内容 nonce 围栏注入隔离 + conformance；仍只走网关，后端未实现优雅降级） | Accepted | 2026-06-12 | `memory`, `gateway`, `retrieval`, `prompt-injection` |
| [ADR-0034](ADR-0034-host-signing-credential-proxy.md) | Host 侧网关签名凭证代理（signingKey 不进容器，per-session 不可伪造 group 代签 + 源 IP/限速/读写分离/NO_PROXY/规范化重序列化签名/两阶段审计；默认 OFF 零变化；fail-closed 结构性；phase2 OpenAI 流式另开）— **已实现，红队抓到 1 critical + 1 high 均已修** | Accepted | 2026-06-13 | `security`, `gateway`, `identity-trust-chain`, `fail-closed`, `credential-isolation` |

---

## 在 PR 中如何引用 ADR

- commit message 与 PR 描述里直接写 ADR 编号，例如：`refs ADR-0007`、`supersedes ADR-0011`
- 代码中如果某段实现是某 ADR 的直接落地，加注释：`// See ADR-0007: Phoenix is the only sanctioned observability backend.`

---

## 提交流程速查

1. 选下一个未占用编号 `NNNN`（看本索引最后一行 +1）
2. 复制 `_template.md` → `ADR-NNNN-<title>.md`
3. 填写每个章节（不要留 placeholder）
4. 在本 README 的索引表追加一行
5. 在同次 PR 里提交，并在 PR 描述里点名引用本 ADR
