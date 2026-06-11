# AgentDesk Agent Platform

一个开源、与具体业务解耦的企业级多用户 Agent 平台:多人上下文隔离、frontdesk→worker 派活、不可伪造的身份信任链、容器化执行,以及一个可插拔的后端网关。

平台核心是通用的,不预设任何特定公司、后端或业务领域。你需要自带:

- 一个聊天通道(内置 `feishu` 和本地 `cli`)
- 一个后端网关(任意 HTTP 服务,后面接你的 ERP / CRM / 内部 API / 工单系统)
- 你自己业务的 agent 提示词和拓扑

> **品牌可配置。** 默认显示名是 `AgentDesk`,机器命名空间是 `agentdesk`。
> 用 `BRAND_NAME` / `BRAND_NAMESPACE` 两个环境变量即可整体改名 —— 它们会渗透到
> 容器 label、镜像名、指标前缀、签名 header、配置路径。详见 `src/branding.ts`。

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
- 可选 HMAC 签名:每次网关请求带 `x-<namespace>-timestamp/nonce/signature`
- 中央 `gateway_audit` 审计表:每次后端调用(成功或失败)一行
- 显式 `requesterSource: 'session' | 'agent-asserted'`,后端可对无可信身份的请求拒绝写操作

**后端网关 MCP 工具**

- `gateway_describe` / `gateway_authorize` / `gateway_execute`
- `gateway_memory_get` / `gateway_memory_upsert`

**Provider 与容器**

- Claude 与 OpenAI-compatible provider
- 容器 lazy idle-exit
- Per-agent-group Docker 资源限制(`resources.memoryMb / cpus / pidsLimit`)

**运维与可观测**

- Prometheus `/metrics`:入站、session、路由时延、容器退出、provider 错误、分类
- Session TTL + 归档
- 入站 webhook 去重

## 快速启动

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

生产建议开启的容量保护(默认关闭,向后兼容):

```bash
MAX_CONCURRENT_CONTAINERS=10
AGENTDESK_IDLE_EXIT_MS=120000       # 命名空间前缀随 BRAND_NAMESPACE 变化
AGENTDESK_SESSION_TTL_DAYS=30
```

### 3. 初始化拓扑

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

### 4. 配置后端网关

```bash
pnpm configure:enterprise-gateway --base-url https://your-gateway.example.com/api/agent
```

这会把目标组的 `container.json` 写成 `backendGateway.baseUrl` + `memoryMode=gateway` + `a2aSessionMode=root-session`。

### 5. 启动

```bash
pnpm dev                # 开发模式
# 或
pnpm build && pnpm start
```

## 常用命令

```bash
pnpm typecheck
pnpm test
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
- [docs/feishu-channel.md](docs/feishu-channel.md) — 飞书接入
- [docs/decisions/README.md](docs/decisions/README.md) — ADR 决策档案
- [examples/](examples/) — 把业务接入框架的参考样例

## License

MIT
