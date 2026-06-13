# AgentDesk Agent Platform

一个开源、与具体业务解耦的企业级多用户 Agent 平台:多人上下文隔离、frontdesk→worker 派活、不可伪造的身份信任链、容器化执行,以及一个可插拔的后端网关。

平台核心是通用的,不预设任何特定公司、后端或业务领域。你需要自带:

- 一个聊天通道(内置 `feishu` 和本地 `cli`)
- 一个后端网关(任意 HTTP 服务,后面接你的 ERP / CRM / 内部 API / 工单系统)
- 你自己业务的 agent 提示词和拓扑

> **品牌可配置。** 默认显示名是 `AgentDesk`,机器命名空间是 `agentdesk`。
> 用 `BRAND_NAME` / `BRAND_NAMESPACE` 两个环境变量即可整体改名 —— 它们会渗透到
> 容器 label、镜像名、指标前缀、签名 header、配置路径。详见 `src/branding.ts`。

<p align="center">
  <img src="docs/assets/architecture.png" alt="AgentDesk 架构总览:多通道接入 → 单进程宿主编排与按用户隔离的会话 → 容器化执行与后端网关,全程由一条不可伪造的身份信任链贯穿;底部是只读可观测性、可靠性与供应链硬化。" width="100%">
</p>

<p align="center"><sub>通道接入 → frontdesk 派活 → 按用户隔离的会话 → 沙箱化执行 → 唯一的、带审计与身份绑定的后端网关</sub></p>

## 它替你解决了什么

| 关注点 | 平台负责的部分 |
|---|---|
| 多人 | 每个用户**完全隔离**的 session,上下文不串味 |
| 身份 | 每次后端调用都归属到**真实终端用户**,prompt-injected 的 agent 无法伪造 |
| 派活 | frontdesk 分类分流到专项 worker;身份跨 hop 传递不漂移 |
| 审计 | 中央 `gateway_audit` 表,每次后端调用一行(who / what / when / 结果) |
| 容器 | 每 session 一个容器,per-group cgroup 资源上限 + 全局并发上限 |
| 可观测 | Prometheus `/metrics` + OpenTelemetry trace(Phoenix + Grafana) |

## 架构总览

完整的分层架构见[顶部总览图](docs/assets/architecture.png)(也收录于 [`docs/architecture.md`](docs/architecture.md))。文字版主链路:

```text
聊天用户 / 群聊
  -> 通道适配器 (feishu / cli)
  -> frontdesk agent      (接待、分类、分流)
  -> worker agents        (专项执行)
  -> 后端网关             (你的 HTTP 契约)
  -> 你的 ERP / CRM / 审批 / 权限系统
```

职责边界:

- **平台负责**:消息接入、上下文隔离、派活、推理、回复、审计
- **你的后端网关负责**:用户映射、权限判断、审批校验、幂等、长期记忆

## 已经落地的能力

**消息接入 / 会话**

- 内置 `feishu` 通道(webhook / long-connection / hybrid)
- 内置 `cli` 通道,方便本地调试
- session 隔离模式:shared、per-user、per-user-per-thread 等
- frontdesk → worker 的 agent-to-agent 派活
- `root-session` worker 模式:同一用户派出的任务带着该用户自己的根上下文进入 worker

**身份与审计(企业信任链)**

- Batch 级 `RequestIdentity`:tool 调用用的用户身份在 poll 批次开始时固定,杜绝多人群聊里的归属漂移
- `origin_user_id` 跨 a2a 链路传递:frontdesk 派给 worker 的任务仍带着原始终端用户身份
- 身份链 host 侧交叉校验:用可信 inbound.db 校验容器自报的 `origin_user_id`,堵跨会话冒充(ADR-0017)
- 可选 HMAC 签名:每次网关请求带 `x-<namespace>-timestamp/nonce/signature`;未签名 group 由启动扫描暴露为指标 + 告警(ADR-0018)
- 中央 `gateway_audit` 审计表:每次后端调用(成功或失败)一行
- 显式 `requesterSource: 'session' | 'agent-asserted'`,后端可对无可信身份的请求拒绝写操作
- fail-closed 安全默认:历史上三处 fail-open 的安全默认值统一收紧为 fail-closed(ADR-0019)
- 名册定向私聊(roster DM):宿主强制的、本人显式同意的 per-scope 私聊授权,出站走槽位间接寻址闸,不放宽群聊写权限(ADR-0023)

**后端网关契约(可验证)**

- `gateway_describe` / `gateway_authorize` / `gateway_execute`
- `gateway_memory_get` / `gateway_memory_upsert`
- `gateway_memory_search` + 召回来源 provenance + 召回内容注入隔离(ADR-0033)
- 契约硬化:散文约定 → zod 可验证契约(闭合错误码、envelope `contractVersion`、写操作 `idempotencyKey`、agent 输入白名单),配套 conformance 自测脚本(ADR-0028)。可运行参考实现见 [`examples/reference-gateway/`](examples/reference-gateway/)

**Provider 与容器**

- Claude 与 OpenAI-compatible provider
- OpenAI provider 摘要式上下文压缩(长会话上下文对齐,ADR-0024)
- 容器 lazy idle-exit
- Per-agent-group Docker 资源限制(`resources.memoryMb / cpus / pidsLimit`)
- 进程/供应链硬化:agent 容器 `--no-new-privileges`、observability sidecar `cap_drop`、镜像 digest pin、git pre-commit 密钥扫描(ADR-0029)
- 容器 egress 联网管控:可配置、默认不限制、opt-in 锁定到运营者管理的 egress-proxy 网络(ADR-0032)
- 不 fork 主仓的通道扩展加载:把 adapter 放进 `EXTENSIONS_DIR` 即可加通道(ADR-0031),示例见 [`examples/echo-channel/`](examples/echo-channel/)

**投递与路由韧性**

- 出站投递韧性:超时 + 有界并发 + 持久化退避重试 + 死信(DLQ)工具(ADR-0016)
- 入站消息路由前持久化:可恢复账本 + 操作员显式重放(ADR-0022)
- persist-before-route 与投递韧性共同保证 at-least-once、宿主重启不丢消息

**运维与可观测**

- Prometheus `/metrics`:入站、session、路由时延、容器退出、provider 错误、分类
- 指标抓取 + 告警闭环:Prometheus + Alertmanager,指标必须有抓取者与告警承载体(ADR-0021)
- 宿主进程硬化:ingress 限制、`/readyz` 健康探针、SIGTERM 优雅停机排空(ADR-0020)
- 配置安全三件套:`.env.example` 权威清单 + 拒绝占位密钥 + 保守 fail-fast(ADR-0025)
- OpenTelemetry trace 贯通宿主与 runner(ADR-0011 / ADR-0026),可选全明文内容捕获(默认关,ADR-0027)
- 通道契约一致性测试 + 宿主主链路 e2e 骨架(ADR-0030)
- Session TTL + 归档
- 入站 webhook 去重

## 快速启动

> **一键脚本**:`pnpm quickstart`(或 `./quickstart.sh`)按顺序跑完确定性步骤——装依赖 → 构建镜像 → 初始化「frontdesk + 示例 worker」拓扑——然后打印剩下两步(接你的后端网关 URL、配聊天通道凭证)的明确指引。想手动走、或想看每步在做什么,继续往下读。

### 1. 安装依赖

```bash
pnpm install
```

### 2. 准备环境变量

最小可用示例:

```bash
# 品牌(可选,默认 agentdesk)
# BRAND_NAME=AcmeDesk
# BRAND_NAMESPACE=acme

# 飞书
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_EVENT_MODE=hybrid
FEISHU_BOT_OPEN_ID=ou_xxx

# Provider(OpenAI 兼容)
OPENAI_BASE_URL=https://your-llm-gateway
OPENAI_API_KEY=sk-xxx
OPENAI_MODEL=gpt-5.4

# 入口 autowire
ENTERPRISE_FRONTDESK_FOLDER=agentdesk-frontdesk
ENTERPRISE_AUTO_WIRE_CHANNELS=feishu
ENTERPRISE_AUTO_WIRE_P2P=true
```

webhook 模式额外需要 `FEISHU_ENCRYPT_KEY` / `FEISHU_VERIFICATION_TOKEN` / `WEBHOOK_PORT`。

容量保护。`MAX_CONCURRENT_CONTAINERS` **默认就开**(默认 10,全局并发容器上限),
另外两项默认关闭(`0`),生产建议显式开启(向后兼容):

```bash
MAX_CONCURRENT_CONTAINERS=10        # 默认 10;调大/调小按宿主容量
AGENTDESK_IDLE_EXIT_MS=120000       # 默认 0（关）。命名空间前缀随 BRAND_NAMESPACE 变化
AGENTDESK_SESSION_TTL_DAYS=30       # 默认 0（关）
```

### 3. 构建 agent 容器镜像

```bash
pnpm container:build
```

每个 session 的 agent 都跑在这个镜像里,首次部署必须先构建,否则首条消息会因 "No such image" 失败。镜像名由 `BRAND_NAMESPACE` + 安装路径哈希派生,改了 `BRAND_NAMESPACE` 或挪了 checkout 路径后需要重新构建。

### 4. 初始化拓扑

```bash
pnpm init:enterprise
```

默认只创建**一个空白模板 frontdesk**(`agentdesk-frontdesk`),不含任何业务 worker。
按需扩展:

```bash
# 加 worker
pnpm exec tsx scripts/init-enterprise-topology.ts --workers access-worker,finance-worker

# 顺手接上飞书入口
pnpm exec tsx scripts/init-enterprise-topology.ts \
  --channel feishu --platform-id oc_xxx --group-name "Front Desk" --threaded
```

想要一个带完整领域提示词的参考样例,见 [`examples/`](examples/)。

### 5. 配置后端网关

```bash
pnpm configure:enterprise-gateway --base-url https://your-gateway.example.com/api/agent
```

这会把目标组的 `container.json` 写成 `backendGateway.baseUrl` + `memoryMode=gateway` + `a2aSessionMode=root-session`。

### 6. 启动

```bash
pnpm dev                # 开发模式
# 或
pnpm build && pnpm start
```

## 常用命令

```bash
pnpm typecheck
pnpm test
pnpm container:build
pnpm init:enterprise
pnpm configure:enterprise-gateway --base-url <gateway>
```

## 后端网关约定

平台内 agent 不直连具体后端表结构或私有接口。在后端前面放一层稳定网关,统一暴露:

- `POST /describe` · `POST /authorize` · `POST /execute`
- `POST /memory/get` · `POST /memory/upsert`

不同后端(ERP / CRM / 内部 API / 工单)只需换网关实现,不动 agent 工具面。详见 [docs/enterprise-erp-gateway.md](docs/enterprise-erp-gateway.md)。

## 相关文档

- [docs/PLATFORM.md](docs/PLATFORM.md) — 平台总览 + 文档地图(新人优先)
- [docs/architecture.md](docs/architecture.md) — message flow + identity model
- [docs/isolation-model.md](docs/isolation-model.md) — session 隔离模式
- [docs/enterprise-multi-user.md](docs/enterprise-multi-user.md) — 多人共享 frontdesk 拓扑
- [docs/enterprise-erp-gateway.md](docs/enterprise-erp-gateway.md) — 后端网关协议
- [docs/configuration-reference.md](docs/configuration-reference.md) — per-group `container.json` 字段全表 + 环境变量入口
- [docs/feishu-channel.md](docs/feishu-channel.md) — 飞书接入
- [docs/decisions/README.md](docs/decisions/README.md) — ADR 决策档案
- [docs/business-optimization-roadmap.md](docs/business-optimization-roadmap.md) — 业务侧优化 backlog(56 条经核实的待办 + 优先级)
- [examples/](examples/) — 把业务接入框架的参考样例

## License

MIT
