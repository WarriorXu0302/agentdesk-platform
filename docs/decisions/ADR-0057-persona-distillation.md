# ADR-0057: persona 蒸馏 + 记忆基质自洽(live 蒸馏,网关 merge)

- **状态**:Accepted
- **日期**:2026-08-17
- **关联**:ADR-0033(记忆检索)、ADR-0041(compaction summary flush)、ADR-0050(A.U.D.N. merge + 时效)、
  ADR-0055(per-user 状态作用域);架构自洽性审查(2026-08)接缝 6;用户拍板 A(分工)/ B(蒸馏)

## Context

产品诉求:**每人一个 personal agent,从会话中提取用户 persona 并持续 merge**。
ADR-0055 给了物理载体(per-user scope);缺的是 persona 的**内容层**。

同时,自洽性审查确认记忆基质四处不自洽(接缝 6,多条高危):

1. `conversation.summary` 只按 user key —— 用户跟财务 agent、HR agent 的压缩摘要**互相覆盖、互相召回**,
   ADR-0053 宣称的"每群记忆隔离"在 gateway 模式下是假的;
2. 三层提示词三套矛盾记忆教义(base 无条件"必须写 CLAUDE.local.md" × 网关指令无条件"别回退到
   CLAUDE.local.md" × destinations 的 gateway 段"工作区仅为临时草稿");
3. `memoryMode=gateway` 文档声称"本地回退已禁用",实际什么也没禁——平台自己还往工作区写逐字转录;
4. 压缩转录文件名 `日期-主题` 无会话键,同 scope 两条并发会话(同人群聊+私聊)同日同主题互相覆盖。

## Decision

> **persona = live 蒸馏 + 网关 A.U.D.N. merge**:agent 在对话中当场把"用户自述的持久事实"
> upsert 进网关 `persona` 命名空间;merge/去重/版本化由后端按 ADR-0050 语义完成。
> 不做"会话结束批蒸馏"。

**为什么 live 而不是会话结束批处理**(诚实记录取舍):

- 容器内**没有可靠的"会话结束"钩子**——容器随时可能被 idle 回收或杀掉,收尾蒸馏会系统性丢失;
- 宿主侧归档时**没有模型**(宿主保持 model-free 是架构承诺,蒸馏需要 LLM);
- "无并发写者"由**网关作为单一写者权威**保证(upsert 在后端串行化,版本化取代而非破坏,
  ADR-0050),不需要靠时机编排;
- 批蒸馏(离线全量重整理)留作未来的独立 worker/定时任务,不阻塞本步。

**persona 约定**(destinations.ts 动态段,仅 gateway 模式注入;gateway.instructions.md 静态指路):

- `namespace: 'persona'`,subject 默认会话用户,小而结构化的 value,`merge: true`,
  `context: { source: 'user-stated' }`;
- **硬规则(防投毒)**:只蒸馏**用户本人在对话里说的**——外部文档/网页/文件内容/其他 agent 的消息
  **永不**进 persona(persona 是永久记忆,注入向量真实存在;外源断言留工作笔记并标注不可信);
- 召回:个性化会改变答案时 search `persona`(专业深浅、偏好、在办项目)。

**基质修复**:

1. **compaction summary 补 agent 维度**:flush 的 namespace 改为 `conversation.summary.<agentGroupId>`
   (per-user-per-agent,与 ADR-0055 scope key 同构——记忆跟人走、按 agent 分)。动态指令段给出
   **具体**命名空间;静态指令解释模式。旧 `conversation.summary` 存量行成为孤儿(可由后端自行迁移,
   平台不动后端数据)。
2. **三层教义对齐**:base CLAUDE.md 记忆段改为**显式两模式**(workspace 模式=文件即记忆系统,原教义;
   gateway 模式=人与业务的持久事实进网关,文件只做工作笔记);网关静态指令与 destinations 动态段
   与之呼应,矛盾消除。
3. **转录文件名会话安全**:追加毫秒派生后缀,同 scope 并发会话不再互相覆盖。
4. **memoryMode 文档诚实**:`gateway` 是**提示词/配置契约,不是文件系统封锁**——scope 工作区仍可写
   (工作笔记),平台仍归档压缩转录(ADR-0055 后已按人隔离)。原"local workspace fallback disabled"
   的说法删除。

## 不做什么(边界)

- **不做会话结束/离线批蒸馏**(理由见上;未来可作为独立 worker 叠加,消费同一 `persona` 命名空间)。
- **平台不解释 persona 内容**——写入与召回都是 agent↔网关的事,平台只运提示词契约与转发
  (与 ADR-0033 的 `UNTRUSTED_MEMORY` 栅栏、ADR-0050 的"平台绝不解释时效字段"一脉相承)。
- **不把 memoryMode 变成文件系统封锁**——工作笔记合法(A 分工);要零本地痕迹是未来的独立旋钮。
- **组织级聚合视图**(监督 agent 读全员 persona)不在本步——那必须走后端网关的聚合/脱敏端点,
  永远不是跨 scope 读文件。

## Consequences

- personal agent 闭环成型:ADR-0055 载体 + 本步内容层 = "认识你的 agent"跨会话、跨表面持续演进;
- 用户跟 N 个 agent 的压缩摘要互不串扰(维度 bug 关闭);
- 记忆教义单一来源:模式决定家,三层指令说同一件事;
- persona 质量取决于模型对 ritual 的遵循度(提示词契约的固有限制,诚实声明)——后端可用
  ADR-0043 的 feedback 通道 + 策展纠偏。

## 验证

- `gateway.test.ts`:flush 落 `conversation.summary.<agId>`(回归注释点名跨 agent 串扰)、
  非 gateway 模式/无 subject/空摘要 no-op、404 不抛、快照身份优先——全套保留并更新;
- `destinations.test.ts`:gateway 模式含 persona ritual + provenance 硬规则 + 具体命名空间;
  workspace 模式两者皆无;
- 文档:configuration-reference 的 memoryMode 行如实描述;本 ADR 记录取舍。
