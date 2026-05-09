# FrontLane Agent Platform

一个面向企业飞书入口、多人隔离上下文、ERP 派活协同的多用户 Agent 基础设施。

当前代码的目标不是“个人 AI 助手”，而是做一层企业入口 Agent 平台：

- 飞书作为统一入口
- 一个 frontdesk 入口 Agent 负责接待、分流、派活
- 多个 worker Agent 负责具体业务执行
- 不同员工默认使用隔离上下文
- 群聊只保留最基础的安全边界
- ERP 权限、鉴权、审计、长期记忆放在后端网关，不放在 Agent 本体里

## 当前已经落地的能力

- 内置 `feishu` 通道，支持 webhook / long-connection / hybrid
- 内置 `cli` 通道，方便本地调试
- 支持 shared、per-user、per-user-per-thread 等 session 隔离模式
- 支持 frontdesk -> worker 的 agent-to-agent 派活
- 支持 `root-session` worker 会话模式：同一个员工的请求会带着自己的根会话上下文进入 worker
- 支持企业前台自动接线：员工第一次私聊飞书机器人时可自动接到 `frontlane-frontdesk`
- 支持 ERP Gateway MCP 工具：
  - `erp_describe`
  - `erp_authorize`
  - `erp_execute`
  - `erp_memory_get`
  - `erp_memory_upsert`
- 支持 OpenAI compatible provider
- 飞书通道支持用 reaction 做“处理中”状态提示，避免机器人先发一条废话消息

## 当前推荐架构

```text
飞书用户 / 群聊
  -> Feishu Bot
  -> frontlane-frontdesk
  -> user-scoped session
  -> worker agents
  -> ERP gateway
  -> 你的 ERP / 审批 / 权限系统
```

职责边界建议保持清楚：

- Agent 平台负责：消息接入、上下文隔离、派活、推理、回复
- ERP 后端负责：用户映射、权限判断、审批校验、幂等、审计、长期记忆

## 会话与记忆模型

### 私聊

- 一个员工私聊机器人，默认是一个独立会话
- 其他员工看不到这个会话，也不会复用这个上下文

### 群聊

- 推荐用 `per-user` 或 `per-user-per-thread`
- 同一个群里，不同员工各自有自己的上下文
- 群本身只作为入口和协作面，不应该直接承担敏感写操作

### Worker 会话

- 当前企业脚本会把 worker 的 `a2aSessionMode` 设为 `root-session`
- 这意味着同一位员工从 frontdesk 派出去的任务，会带着该员工自己的根上下文进入 worker
- 不会把 A 用户的上下文串到 B 用户那里

### 长期记忆

- 如果 `memoryMode=erp`，长期记忆不写在 agent workspace，而是走 ERP Gateway
- 推荐把用户偏好、业务摘要、审批历史、权限提示都落到后端

## 目录说明

```text
src/
  channels/                 通道适配器（当前内置 cli + feishu）
  modules/                  平台模块（权限、调度、agent-to-agent、progress-status 等）
  db/                       中央库和 migration
  enterprise-autowire.ts    企业入口自动接线策略

container/agent-runner/
  src/providers/            容器内 provider（claude / openai / mock）
  src/mcp-tools/            内置 MCP 工具，包括 ERP gateway

scripts/
  init-enterprise-topology.ts
  configure-enterprise-gateway.ts

docs/
  enterprise-multi-user.md
  enterprise-erp-gateway.md
  feishu-channel.md
```

## 快速启动

### 1. 安装依赖

```bash
pnpm install
```

### 2. 准备环境变量

最小可用示例：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_EVENT_MODE=hybrid
FEISHU_BOT_OPEN_ID=ou_xxx

OPENAI_BASE_URL=https://www.d1token.com/
OPENAI_API_KEY=sk-xxx
OPENAI_MODEL=gpt-5.4

ENTERPRISE_FRONTDESK_FOLDER=frontlane-frontdesk
ENTERPRISE_AUTO_WIRE_CHANNELS=feishu
ENTERPRISE_AUTO_WIRE_P2P=true
ENTERPRISE_AUTO_WIRE_GROUPS=false
ENTERPRISE_AUTO_WIRE_GROUP_SESSION_MODE=per-user
```

如果你走 webhook，还需要：

```bash
FEISHU_ENCRYPT_KEY=xxx
FEISHU_VERIFICATION_TOKEN=xxx
WEBHOOK_PORT=3000
FEISHU_WEBHOOK_PATH=/webhook/feishu
```

### 3. 初始化企业拓扑

```bash
pnpm init:enterprise
```

这一步会创建或复用：

- `frontlane-frontdesk`
- `frontlane-access-worker`
- `frontlane-sales-worker`
- `frontlane-finance-worker`
- `frontlane-approval-worker`
- `frontlane-ops-worker`

并自动写入基础派活关系。

如果你要在初始化时顺手把飞书入口也接上：

```bash
pnpm exec tsx scripts/init-enterprise-topology.ts \
  --channel feishu \
  --platform-id oc_xxx \
  --group-name "FrontLane Desk" \
  --threaded
```

### 4. 配置 ERP Gateway

```bash
pnpm configure:enterprise-gateway --base-url https://your-gateway.example.com/api/agent
```

这会把企业组的 `container.json` 统一写成：

- `enterpriseGateway.baseUrl`
- `memoryMode=erp`
- `a2aSessionMode=root-session`

### 5. 启动

开发模式：

```bash
pnpm dev
```

构建后启动：

```bash
pnpm build
pnpm start
```

## 常用命令

```bash
pnpm typecheck
pnpm test
pnpm init:enterprise
pnpm configure:enterprise-gateway --base-url https://your-gateway.example.com/api/agent
```

## 飞书接入说明

当前飞书通道特点：

- 支持私聊和群聊消息接入
- 支持 `@机器人` 场景
- 支持长连接事件模式
- 支持卡片动作回调
- 支持 reaction 进度提示

如果你在飞书开放平台配置的是“长连接”事件订阅模式，建议：

```bash
FEISHU_EVENT_MODE=long-connection
```

如果你既要长连接收消息，又想保留 webhook 处理卡片动作：

```bash
FEISHU_EVENT_MODE=hybrid
```

## ERP Gateway 约定

平台内 Agent 不应该直连具体 ERP 表结构或私有接口。

推荐在 ERP 前面放一层稳定网关，统一暴露：

- `POST /describe`
- `POST /authorize`
- `POST /execute`
- `POST /memory/get`
- `POST /memory/upsert`

这样不同 ERP 只需要换网关实现，不需要改 Agent 工具面。

详细约定见 [docs/enterprise-erp-gateway.md](docs/enterprise-erp-gateway.md)。

## 当前状态

这个仓库现在是“企业版 agent infra baseline”，不是一个完全产品化的平台。

已经适合继续往下接业务，但你应该明确下面几点：

- 鉴权和权限边界仍然要靠 ERP Gateway，不要指望聊天层 ACL
- 群聊安全边界目前是轻量的，适合接待、分流、解释、预览，不适合直接做高风险写操作
- 当前对外品牌已切到 `FrontLane`，少量底层实现仍沿用历史结构，但不影响新部署和使用
- 文档已经切到企业场景，但代码层还没有做完整品牌重命名

## 相关文档

- [docs/enterprise-multi-user.md](docs/enterprise-multi-user.md)
- [docs/enterprise-erp-gateway.md](docs/enterprise-erp-gateway.md)
- [docs/feishu-channel.md](docs/feishu-channel.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/isolation-model.md](docs/isolation-model.md)

## License

MIT
