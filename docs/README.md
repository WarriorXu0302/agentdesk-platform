# Documentation Index

这个目录现在以本地设计文档为准，不再以原来的 NanoClaw 官网为准。

如果你要继续把这个仓库往企业多用户 Agent 平台方向推进，优先看下面几份：

- [enterprise-multi-user.md](enterprise-multi-user.md)
  frontdesk + worker、多员工会话隔离、群聊边界、自动接线策略
- [enterprise-erp-gateway.md](enterprise-erp-gateway.md)
  ERP 网关协议、长期记忆落点、权限与审计边界
- [feishu-channel.md](feishu-channel.md)
  飞书通道环境变量、事件模式、私聊/群聊 identity 模型
- [architecture.md](architecture.md)
  主机、central DB、session DB、container runner 的整体结构
- [isolation-model.md](isolation-model.md)
  shared / per-user / per-user-per-thread / agent-shared 的隔离模型

其他文档多数还是底层实现说明，可按需查看：

- [db-central.md](db-central.md)
- [db-session.md](db-session.md)
- [build-and-runtime.md](build-and-runtime.md)
- [agent-runner-details.md](agent-runner-details.md)
- [docker-sandboxes.md](docker-sandboxes.md)
