# FrontLane Agent Platform

这个文件保留为中文兼容入口。

当前仓库已经不再按原始 NanoClaw 的“个人 AI 助手”定位维护，而是收敛为一个面向企业场景的多用户 Agent 基础设施。完整文档请直接看 [README.md](README.md)。

## 当前定位

- 飞书作为统一入口
- 一个 `frontdesk` 入口 Agent 负责接待、分流、派活
- 多个 `worker` Agent 负责具体业务执行
- 不同员工默认使用隔离上下文
- 群聊只保留基础安全边界
- ERP 权限、审批、审计、长期记忆统一下沉到后端网关

## 当前特色

- 支持 `feishu` 通道，含 long-connection / webhook / hybrid 模式
- 支持用飞书 reaction 表示“处理中”，完成后自动取消
- 支持 `frontdesk -> worker` 的 agent-to-agent 派活
- 支持 `per-user`、`per-user-per-thread`、`root-session` 等隔离模式
- 支持通过 ERP Gateway 统一适配不同 ERP 后端
- 支持 OpenAI compatible provider，可直接接企业模型网关

## 推荐链路

```text
飞书用户 / 群聊
  -> Feishu Bot
  -> frontlane-frontdesk
  -> 用户独立 session
  -> worker agents
  -> ERP gateway
  -> ERP / 审批 / 权限系统
```

## 设计原则

- Agent 平台负责消息接入、上下文隔离、路由、派活、推理和回复
- 业务系统负责鉴权、权限判断、审批流、幂等、审计和长期记忆
- 高风险写操作不要直接依赖群聊上下文判断
- 对外品牌统一使用 `FrontLane`

## 快速开始

```bash
pnpm install
pnpm init:enterprise
pnpm configure:enterprise-gateway --base-url https://your-gateway.example.com/api/agent
pnpm dev
```

环境变量、飞书接入和 ERP Gateway 约定请看 [README.md](README.md)。

## 兼容性说明

项目代码最初来自 `NanoClaw v2`，因此少量底层脚本名、迁移文档、历史命令和测试路径仍保留 `nanoclaw` 字样。

这类遗留命名当前只作为兼容层存在，不代表项目定位；新部署、新文档和默认企业拓扑统一使用 `FrontLane`。
