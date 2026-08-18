# ADR-0060: 前台隐身 —— 用户面对的是"自己的助手",不是接待员

- **状态**:Accepted
- **日期**:2026-08-18
- **关联**:ADR-0055(per-user 状态作用域)、ADR-0054(强制路由)、ADR-0056(role 列)、
  ADR-0057(persona 蒸馏);2026-08 编排调研(Moveworks / Intercom Fin / Cloudflare Agents)

## Context

用户提出:"前台这个 agent 到底还需不需要面向用户,感觉不太需要了。"结论:**不需要**。

三条依据:

1. **地基已经变了**。ADR-0055 之后,每个用户与"前台"对话时,实际面对的是
   **前台模板为他长出来的个人实例**(独立作用域/记忆/容器),ADR-0057 让它还认识用户。
   也就是说 **personal agent 早已事实存在**,只是人设仍自称"接待员"、行为仍宣告"转接"。
2. **业界形态一致**。Moveworks 商业化交付的正是本形态(员工只见一个助手,分诊/规划/调专家
   在助手**内部**每回合发生);Intercom Fin **明确拒绝**了可见的专家路由;
   Cloudflare Agents 的 `getAgentByName(userId)` 把寻址变成查表而非 LLM 跳转。
   **没有一家成功产品让用户看见"接待员转接"。**
3. **"转接"UX 是负资产**:它把内部拓扑漏给用户,并让一次回答变成两跳体验。

## Decision

> **角色隐身,机器不动**:用户可见层去掉"接待员/路由器"人设;委派、路由闸、身份链、
> role 建模**全部原样保留**为内部管道。

具体:

- **入口 agent 人设重写**(`buildFrontdeskInstructions`):从"共享前台 agent,职责是问候+分诊+
  委派"改为"**你就是用户自己的助手**;专家能力在你身后,你**静默**使用它们"。新增
  **"Speaking as one assistant —— REQUIRED"**硬规则:
  禁止说"我帮你转接/我们的专员会回复你"等任何暴露内部 agent 的话;专家结果必须
  **以第一人称整合**后回答;专家追问要"作为你自己的问题"提出;专家失败时说明你做不到什么、
  下一步怎么办,**不得**把内部拓扑当理由;内部名称(worker/destination/agent group)
  **永不进入用户词汇**。
- **worker 人设**:自述从"共享前台背后的专家 worker"改为"**用户助手背后的内部能力**;
  终端用户从不寻址你、从不看见你的名字";并明确"结果写给助手**整合**用,不是给用户看的原文,
  不得直接称呼终端用户"。
- **solo 前台人设**:同样去掉"frontdesk/router/switchboard"自称。
- **用户可见显示名**:`DEFAULT_FRONTDESK_NAME` 从 `<Brand> Frontdesk` 改为
  **`<Brand> Assistant`**。folder slug(`*-frontdesk`)**保持不变**——那是运营者/拓扑标识,
  永不出现在聊天里。
- **classify_intent 话术**:中置信度原本要求"在回复里加一行确认"(易泄漏转接动作),
  改为"用你自己的话说明你据以行动的假设",既保留纠错价值又不暴露拓扑;
  "Never delegate silently"澄清为 **"对用户静默,对平台绝不静默"**(分类调用仍然强制)。

## 不做什么(边界)

- **不动任何机器**:强制路由闸(ADR-0054,本就跑在容器内、用户不可见)、委派授权边、
  HMAC 身份链、回程 owner 校验、role 列(ADR-0056)——一寸不改。
  隐身是**产品人设**变更,不是架构变更。
- **群聊仍有可见身份**:群成员必须能 @ 到一个东西,故群面它以"团队助手"出现
  (每人仍得到自己的实例,记忆隔离由 ADR-0055 保证)。准确表述是:
  **"接待员"这个角色消失,"助手"这个身份留下**。
- **不改代码里的内部标识符**(`maybeAutowireEnterpriseFrontdesk`、指标 help 文本等)——
  内部词汇,改名只有搬动成本。文档中面向运营者处逐步改用 "entry agent"。
- **不强制存量部署**:人设是**种子文件**(`instructions.md`,ADR-0055 模板层),
  已部署的组保留其现有文本;重跑 `init-enterprise-topology` 才采用新人设(幂等,只写缺失文件)。
  **想采用新人设的存量部署需手工替换 instructions.md 或删除后重跑**。

## Consequences

- 用户体验:一个助手从头答到尾;委派变成看不见的水管。
- 产品定位与 personal agent 方向合流:ADR-0055/0057 的地基第一次**在人设层面**兑现。
- 诚实边界:人设是**提示词契约**——模型遵循度决定隐身质量(与 ADR-0057 persona 同类限制)。
  平台不做输出过滤(那会违反"平台不解释 agent 内容"的一贯姿态);
  真出现泄漏话术,靠人设迭代与运营者定制,不靠运行时审查。
- desk 的幕后新职责(组织级聚合视图,Clio 式)本就不面向用户,不受本 ADR 影响。

## 验证

- `init-enterprise-topology.test.ts`:默认 provisioning 的种子含
  "Speaking as one assistant" / 禁止转接话术 / "你就是用户自己的助手",且**不再含**
  旧的"shared frontdesk agent"与"greet the user and classify the request";显示名断言更新。
- `host-core.test.ts`:autowire 默认名断言更新。
- 全套本地 CI(tsc×2 / eslint / prettier / vitest / bun)+ 真实 CI 双 job。
