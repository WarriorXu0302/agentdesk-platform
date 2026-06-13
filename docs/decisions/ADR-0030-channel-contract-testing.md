# ADR-0030: 通道契约一致性测试与宿主主链路 e2e 骨架

- **Status**: Accepted
- **Date**: 2026-06-13
- **Decider(s)**: yingqi2（用户，提案/拍板）；coding agent（执行）
- **Tags**: `channels`, `testing`, `contract`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

成熟度审计点名【通道层测试缺口】（openclaw 对标 ⑤）：

- Feishu 的有状态路径（验签 / 解密 / webhook 分发 / 去重 / token 刷新 / deliver
  分支）此前**零覆盖** —— 只有纯函数（签名 / 解密 helper / 平台 id 归一化）被测，
  真正的 `handleWebhook`、token 单飞、`deliver` 路由从未跑过测试。
- 没有**宿主主链路 e2e** —— `routeInbound → session DB → 投递轮询 → adapter.deliver`
  这条核心路径只在各自单元里被局部验证，没有一条确定性的端到端用例。
- 没有**通道契约一致性测试** —— `ChannelAdapter` 是第三方 adapter 的接入契约
  （ADR 里多次强调 adapter 可外部安装），但除了 TypeScript 编译期检查，没有运行时
  的结构校验。一个用 JS 编写、或由 Chat SDK 桥接拼装出来的 adapter，结构跑偏时
  router/delivery 只会在运行时炸，而不是在接入时被挡住。

约束：
- 纯加测试，**不得改变任何运行时行为/逻辑**；现有宿主测试必须保持全绿。
- 容器内的 turn（LLM、工具、bun 侧 agent-runner）在 Bun + `bun:sqlite` 下运行，
  不在 vitest 宿主测试范围内 —— e2e 的边界必须讲清楚。

## Options Considered

- **Option A**：只补 Feishu 有状态测试，不引入通用契约校验。
  优点：改动最小。缺点：第三方 adapter 仍无接入门；e2e 缺口仍在。工作量低。
- **Option B**：补 Feishu 测试 + 引入可复用的 `assertChannelAdapterContract` 作为
  adapter 结构契约门，并加一条宿主主链路 e2e 骨架（in-memory adapter 跑真实
  router/delivery/session DB）。优点：契约可验证、可被第三方 import 自测；主链路有
  确定性回归网。缺点：需要新增一个 export（资产）+ 两个测试用 seam。工作量中。
- **Option C**：把契约门做成运行时强制（`initChannelAdapters` 里对每个 adapter 调用
  `assertChannelAdapterContract`，不合格直接拒绝注册）。优点：真正的"准入闸"。
  缺点：改变了运行时行为（本次约束明确禁止），且与"degrade 而非 fail-fast"的既有
  注册容错风格冲突。本次不可行。

## Decision

> **拍板**：选 Option B。

1. 新增 `src/channels/channel-contract.ts` 导出 `assertChannelAdapterContract(adapter)`：
   一个零依赖的**结构契约校验器**。校验必填面（`name`/`channelType` 非空串、
   `supportsThreads` 为 boolean、`setup`/`teardown`/`isConnected`/`deliver` 为函数）
   与可选方法面（`setTyping`/`syncConversations`/`resolveChannelName`/`isMember`/
   `subscribe`/`openDM` 若存在必须是函数）。它**只校验结构、不触发行为**（不发网络、
   不调 `setup`/`deliver`）—— 调用签名由 TypeScript 编译期保证，运行时这层管的是
   "结构跑偏 / 可选方法不是函数"这类逃过类型系统的情况。第三方 adapter 作者可直接
   `import` 它在自己的测试里自测，这就是"契约可验证"的小资产。

2. 该校验器是**软准入门**：当前仅在测试里作为 adapter 接入的结构闸（遍历 registry
   的所有已注册 adapter 跑断言，cli + feishu 必在集合内）。**不**在运行时强制拒绝
   注册（见 Option C 的驳回理由），保留既有注册容错风格。

3. 宿主主链路 e2e（`src/channels/e2e-message-path.test.ts`）用一个 in-memory adapter
   跑**真实** `routeInbound` + 真实投递轮询 + 真实 session DB，覆盖入站
   （adapter → routeInbound → `messages_in`，身份 senderId→origin 保留）与出站
   （容器写 outbound 行 → 一次投递 drain → `adapter.deliver` 被以正确
   channel/platform/content 调用）。

理由（可验证）：契约门有对应单测；主链路 e2e 是确定性用例（无 Docker、无真 LLM）；
Feishu 有状态路径走真实代码（仅 fetch/HTTP req-res 是 fake，验签/解密/去重/分发为真）。

## Consequences

- **Positive**：
  - Feishu 验签/解密/webhook 分发/去重/413/token 单飞/deliver 路由从零覆盖变为有
    真实代码路径的回归网。
  - 第三方 adapter 作者有一个可 import 的契约自测资产，接入门从"运行时炸"前移。
  - 宿主消息主路径有一条确定性 e2e，重构 router/delivery 时能立刻发现回归。
- **Negative**：
  - 引入两个测试用 seam（见下），扩大了一点点公共表面。它们标注为 `__*ForTests` /
    "test seam"，不参与运行时逻辑。
- **Neutral / Trade-offs**：
  - **e2e 边界**：本骨架只覆盖**宿主段**（router / session DB / 投递 drain）。容器内
    的 turn（LLM、工具调用、bun 侧 agent-runner 读写 `bun:sqlite`）**不在范围内**，
    由 `container/agent-runner` 自己的 Bun 套件覆盖。e2e 通过"模拟容器写好的
    outbound 行"来 fake 容器段，从而在不起 Docker、不连真模型的前提下确定性验证宿主
    段。若未来要打通容器段的端到端，需另起测试设施（起容器或 stub bun-runner），并
    回头重审本 ADR 的边界声明。
  - 契约门是**软门**（测试期校验，非运行时强制）。若未来希望在 `initChannelAdapters`
    里运行时拒绝不合格 adapter（Option C），属于运行时行为变更，需新 ADR + 用户批准。

## Implementation Notes

- 资产：`src/channels/channel-contract.ts`（`assertChannelAdapterContract`，可被第三方 import）。
- 测试：
  - `src/channels/channel-contract.test.ts` —— 校验器单测 + registry 一致性（cli+feishu 必在）。
  - `src/channels/feishu-webhook.test.ts` —— Feishu 有状态路径（真实 crypto/dedup/分发，fake fetch+HTTP）。
  - `src/channels/e2e-message-path.test.ts` —— 宿主主链路入站/出站 e2e（in-memory adapter）。
- 测试 seam（仅供测试，不改运行时逻辑）：
  - `src/channels/feishu.ts` 导出 `createFeishuAdapter(config)` —— 用显式 config 构造真实
    adapter（薄封装既有 `createAdapter`），让测试驱动真实 `setup`/`deliver`/webhook handler。
  - `src/channels/channel-registry.ts` 导出 `__getRegisteredFactoryForTests(name)` —— 取出
    真实注册的 factory（证明是真注册而非重建），不经过会调用 `setup()`/绑端口的
    `initChannelAdapters`。
- 后续验收点：`pnpm typecheck` + `pnpm exec vitest run` 全绿；新增三份测试通过、无回归。

## References

- 成熟度审计：`MEMORY.md` → platform-maturity-audit-2026-06、openclaw-benchmark-2026-06（对标 ⑤）。
- 契约定义：`src/channels/adapter.ts`（`ChannelAdapter`）。
- 关联设计：`docs/feishu-channel.md`、`docs/architecture.md`、`docs/isolation-model.md`。
- 关联 ADR：ADR-0016（投递 at-least-once / 重试）、ADR-0022（入站 durability）、ADR-0023（roster-DM，isMember 等可选方法）。
