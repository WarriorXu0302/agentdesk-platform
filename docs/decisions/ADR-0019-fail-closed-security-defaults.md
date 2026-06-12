# ADR-0019: 将三处 fail-open 安全默认值统一收紧为 fail-closed

- **Status**: Accepted
- **Date**: 2026-06-12
- **Decider(s)**: 用户（yingqi2@memov.ai，平台 owner）；coding agent（提案 + 执行）
- **Tags**: `security`, `identity-trust-chain`, `routing`, `feishu-channel`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

成熟度审计（MEMORY: platform-maturity-audit-2026-06）标记"身份链可伪造"等差距。
进一步排查发现三处安全默认值是 **fail-open**（出错/缺信息时放行），与平台其余
取向（如 `normalizeFeishuPlatformId` 对缺身份的 p2p "fail closed for p2p chats
without sender identity"、webhook 签名校验失败即 401）不一致。fail-open 在企业
多用户场景下意味着：一个配置错误或一次缺身份回调，就会把控制权交给非预期方。

三处具体位置（修复前）：

- **(a) `src/command-gate.ts` `isAdmin`**：`user_roles` 表不存在时
  `return true`（注释 "no permissions module = allow all"）。`/clear`
  `/compact` `/context` `/cost` `/files` 等管理命令对任意发送者开放。只要部署
  未安装 permissions 模块（或表尚未迁移），任何人都能清空/压缩他人会话上下文。
- **(b) `src/router.ts` `evaluateEngage`**（`engage_mode='pattern'` 分支）：
  `engage_pattern` 非法正则时 `catch` 返回 `true`（"fail open so admin sees
  the agent responding"）。一个写错的正则（如漏括号 `(`）会让该 agent 命中
  频道里**所有**消息——等于静默劫持整个频道。
- **(c) `src/channels/feishu.ts` `handleCardAction`**：原条件
  `action.expectedUserId && operatorUserId && action.expectedUserId !== operatorUserId`
  在 `operatorUserId` 为空串/缺失时短路跳过 wrong-user 检查。结果：当回调不带
  可验证操作者身份时，任意人（或无身份回调）可代答本应限定某用户的审批卡片，
  违背 CLAUDE.md "群聊不放宽写权限"。

约束：command-gate 的 allow-all 行为对单机/开发确有便利（无 permissions 模块
也能用管理命令），不能一刀切删除而不给逃生阀。

## Options Considered

- **Option A：全部改为 fail-closed，command-gate 提供显式 env 逃生阀。**
  缺信息/出错即拒绝；`ALLOW_ADMIN_WITHOUT_ROLES=true` 时 command-gate 恢复旧的
  allow-all 并告警一次。优点：企业默认安全，开发便利仍可显式开启且可审计；
  工作量小（三处 + 测试 + 本 ADR）。
- **Option B：维持 fail-open，仅加日志/指标观测。**
  优点：零行为变更。缺点：观测到时损害已发生（已被冒名、频道已被劫持），不解决
  根因。驳回。
- **Option C：command-gate 也无条件 fail-closed，不留逃生阀。**
  优点：最简单、无配置面。缺点：单机/开发用户在没装 permissions 模块时彻底用不了
  管理命令，体验断崖；易诱导用户去改代码绕过，反而更不安全。驳回。

## Decision

> **拍板**：选 Option A。三处统一 fail-closed；唯独 command-gate 因有正当的单机
> 用例，保留 `ALLOW_ADMIN_WITHOUT_ROLES` 显式逃生阀，**默认关闭**且生效时
> `log.warn` 一次。

核心理由（可验证）：

1. **企业正确默认是"无法证明授权即拒绝"。** (a) 缺 `user_roles` 表无法证明
   发送者是 admin；(c) 缺 `operatorUserId` 无法证明操作者就是受限用户。两者都该
   拒绝，而非放行。
2. **配置错误不应升级为权限扩大。** (b) 一个坏正则的正确后果是"该 agent 静默
   待修"，而不是"该 agent 接管全频道"。fail-closed 把影响面从"全频道劫持"收敛
   为"单 agent 不响应"，并用 metric + 日志让运维可见。
3. **逃生阀的取舍**：command-gate 的 allow-all 对单机有真实价值，但默认开启等于
   把"忘了装 permissions 模块"变成静默授权漏洞。改为默认关闭 + 显式 env 开启 +
   首次命中告警，便利仍在、风险显性化、且可在审计中追溯。(b)/(c) 无对称的正当
   宽松用例，故不设逃生阀。

## Consequences

- **Positive**：
  - 关闭"未装 permissions 模块即任意人可发管理命令"的提权面。
  - 坏正则不再能劫持频道；`<ns>_engage_pattern_invalid_total{agent_group}`
    指标让运维第一时间发现"某 agent 因坏正则静默"。
  - 受限审批卡片在操作者身份不可确认时被拒，符合"群聊不放宽写权限"。
- **Negative**：
  - 既有单机部署若依赖 user_roles 缺表时的 allow-all，升级后管理命令会被拒，
    需显式设 `ALLOW_ADMIN_WITHOUT_ROLES=true`（属预期、可审计的行为变更）。
  - 若上游飞书回调本就常不带 operator 身份，受限卡片将更频繁被拒——这是正确的
    收紧，但需运维知晓。
- **Neutral / Trade-offs**：
  - command-gate 保留一条显式宽松路径。假设"逃生阀仅用于单机/开发"。若未来出现
    共享部署滥用该 env 的情况，需重审本 ADR（例如改为按 agent group 粒度授权而非
    全局开关）。

## Implementation Notes

- 落地文件：
  - `src/command-gate.ts`：`isAdmin` 缺表时 `return adminWithoutRolesAllowed()`
    （默认 false）；逃生阀经 `readEnvFile(['ALLOW_ADMIN_WITHOUT_ROLES'])` 读取，
    进程级缓存，命中时 `log.warn` 一次。
  - `src/router.ts`（仅 `evaluateEngage`）：坏正则 `return false` +
    `engagePatternInvalidTotal.inc({ agent_group })` + `log.warn`（带 group 与坏
    正则）。
  - `src/channels/feishu.ts`（仅 `handleCardAction`）：新增导出纯函数
    `cardActionOperatorAllowed(expectedUserId, operatorUserId)`——`expectedUserId`
    存在时要求 `operatorUserId` 非空且相等，否则拒绝；沿用既有 `log.warn` + 提前
    返回的拒绝路径（不触发 `onAction`）。
- 指标 `engagePatternInvalidTotal`（`<ns>_engage_pattern_invalid_total{agent_group}`）
  由编排者预先加入 `src/metrics.ts`，本次直接引用。
- 后续验收点：
  - `src/command-gate.test.ts`：无表默认拒绝 / 逃生阀放行 / 仅告警一次 / null
    发送者恒拒。
  - `src/host-core.test.ts`（router describe）：坏正则不唤醒、无 session、指标 +1。
  - `src/channels/feishu.test.ts`：缺/错 operator 的受限卡片被拒，未限定卡片放行。

## References

- CLAUDE.md load-bearing invariants：身份信任链不可弱化；"群聊不放宽写权限"。
- MEMORY：`platform-maturity-audit-2026-06.md`（身份链可伪造等确认差距）。
- 相关指标定义：`src/metrics.ts`（`engagePatternInvalidTotal`）。
