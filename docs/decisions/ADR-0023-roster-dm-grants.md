# ADR-0023: 名册定向私聊授权（roster DM grants）— 宿主强制的同意 + 槽位间接寻址出站闸

- **Status**: Accepted
- **Date**: 2026-06-12
- **Decider(s)**: yingqi2（用户，批准）；coding agent（防御者草案 + 执行）
- **Tags**: `security`, `delivery`, `feishu`, `identity`, `migration`, `authorization`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

需要一个**通用企业能力**：让 agent 在宿主强制约束下，给"本人显式同意接收的参与者"按 scope（如某局/任务实例）定向私聊（审批通知、定向提醒、参与者广播）。这是 opt-in 能力，flag 默认关。

此特性改动的是 **load-bearing 的出站授权闸**（`src/delivery.ts`），并新引入"agent 可向个人发私信"的能力面——天然是高危面。设计经过一轮对抗红队：**22 个攻击向量，收敛为 5 个根因**。若不封堵，4 个 critical / 11 个 high 可被武器化：

- **R1 同意来源被复用**：a2a 跨会话累积身份（ADR-0017 的残余风险）可被用来伪造"某人同意"。`collectLegitimateOrigins` 的集合是"曾在该 session 出现过的身份"，一旦把它当作同意来源，被注入的 agent 就能让任意受害者"被同意"。
- **R2 群上下文 → p2p 通道伪造**：群 `platformId` 是 `chat_id`（`oc_*`），不是成员 `open_id`；群卡片若 `expectedUserId` 为空则人人可点。任一者都能让 agent 把"群里出现过的人"变成私聊目标，或把 `chat_id` 误当个人。
- **R3 槽位非强制边界**：容器可直写 `outbound.db`，因此容器写的 `channel_type/platform_id` 不可信——agent 可绕过任何"槽位"间接层，直接把私信投到任意 `feishu:p2p:ou_*`。
- **R4 放行键生命周期过长 + 粒度过粗**：若放行键绑 `session.id`（长生命周期）且只是布尔，agent-shared 模式下多个对话会共享同一把"私聊钥匙"。
- **R5 限速/撤销只是状态位**：若限速/撤销不在每次投递（含每次重试）的临界区实时复查，撤销后在途消息仍会投出，限速可被重启清零。

约束：必须保持 5 条 load-bearing 不变量（三库单写者 / 群聊保守 / 身份信任链 / 网关唯一业务路径 / observability 只读）。本次范围是 PoC-must（10 项），显式不做 harden-after（11-14，见 Open Issues）。

## Options Considered

- **Option A：容器自带目标 + 宿主仅校验布尔放行位**。优点：实现最小。缺点：R3/R4 直接洞开——容器写的 `platform_id` 不可信，布尔放行位无法约束"发给谁/发几条"。**驳回**。
- **Option B：把同意/目标下沉到后端网关，宿主只转发**。优点：契合"网关唯一业务路径"不变量，最干净。缺点：网关侧契约 + 实现工作量大，阻塞 PoC；且本能力是平台级消息授权，不是业务数据。**作为硬化目标保留（见 Trade-offs / Open Issues 13）**。
- **Option C（选中）：宿主单写的本地 grant 表 + 槽位间接寻址 + 每投递临界区实时复查**。同意只来自 channel 入口本人动作；容器只能寻址**槽位**，宿主用 `(scope_id, slot_label)` 反查 grant 并**覆盖**容器写的路由字段。优点：5 个根因逐条可封堵，不依赖网关即可上 PoC。缺点：本地表是过渡态，硬化后需下沉网关。

## Decision

> **拍板**：选 Option C。

五条核心决策（逐条对应根因）：

1. **同意来源硬约束（R1）**：grant 的同意**只**来自 channel 入口本人动作——p2p 主动私信（`consent_source='p2p-ingress'`，`open_id` 取自该入站事件 `sender.sender_id.open_id`）或定向卡片（`consent_source='directed-card'`，强制 `expectedUserId=成员 open_id`，走 `cardActionOperatorAllowed` fail-closed）。**禁止**从 a2a origin / `collectLegitimateOrigins` 派生。每条 grant 锚定 `consent_inbound_msg_id`。

2. **群保守 + 目标原子派生（R2）**：群内 join **只记意向不写 grant、绝不 `createMessagingGroup` mint p2p 通道**；`participant_open_id` 与 `dm_platform_id` 由**同一入站事件原子派生**并断言回环到同一 `open_id`；**拒** `union_id`/`user_id`/`chat_id`（只接受 `ou_` 开头的 open_id）。目标硬约束 `feishu:p2p:ou_* + is_group=0`。

3. **槽位强制 + 容器路由字段覆盖（R3）**：`src/delivery.ts` 新增 `kind='roster'` 分支，**与现有 channel 分支并列且互斥**。宿主用 `(scope_id, slot_label)` 反查 grant，`looksLikeRawPlatformId(msg.platform_id)` 则拒（容器试图绕槽直发原始目标），并用 grant 权威字段**覆盖** `channel_type/platform_id`。`scope_id` 由 `hostScopeForSession(session)` 独立确定，**绝不取容器字段**。现有 channel 分支在 flag 开启时收紧 `feishu:p2p:*` 绕槽直发。

4. **per-scope 不可猜放行键 + 强制 root-session（R4）**：放行键 = `scope_id`（= `root_session_id ?? session.id`，随机 uuid，不可猜），逐 `(scope_id, slot_label)` 反查目标；opt-in 的 agent group 若 `a2aSessionMode==='agent-shared'` 则**启用即报错**（`assertRootSessionForRosterDm`），强制 root-session 隔离对话 lane。

5. **每投递临界区实时复查 + 持久化限速 + 总量上限（R5）**：每次 `deliver`（含每次重试）前在**同一临界区**复查 `revoked_at IS NULL AND expires_at > hostNow AND scope 绑定 AND consent_source IN (...)`；持久化多键滑窗限速（grant/scope/participant/deploy，AND 语义，宿主单写跨重启存活）+ per-grant `max_sends` 总量（达上限自动 `revoke`）；**禁** roster kind 设 `deliver_after/recurrence`（发现即拒）；局结束/撤销显式 `revoke` 整个 scope。

### slot_label 承载方式

`messages_out` 有 `kind` 列但**无 slot 列**。本 ADR 选择**最小且不破坏 `kind` 语义**的做法：`slot_label` 放在 roster 行的 **content JSON 的 `slot` 字段**里，不新增 outbound 表列、不改容器侧写入契约。该字段是容器写入因而**不可信**——它只用于"选哪个槽位"，所有路由权威字段（`channel_type/platform_id`）由 grant 覆盖；选错/伪造槽位只会反查不到 grant 而 fail-closed。

## Consequences

- **Positive**：通用定向私聊能力上线（默认关），5 个红队根因逐条可证封堵；每条 roster DM（含拒投）落审计；身份链不被削弱（强制 root-session 正是 ADR-0017 Open Question 的缓解方向）。
- **Negative / Trade-offs**：
  - **PoC 本地表（`dm_grants`/`dm_rate_ledger`/`dm_audit`）是过渡态**。"网关唯一业务路径"不变量要求业务记忆/授权走网关；这里用宿主本地表是为不阻塞 PoC 的显式让步，**硬化后须下沉到 `gateway.authorizeDm`**（Open Issue 13）。本地表是宿主单写、v2.db 从不挂进容器，故不破坏"三库单写者"。
  - 本地限速是部署级粗粒度默认，部署级配额细化是 harden-after（Open Issue 14）。

### load-bearing 不变量论证（均保持）

- **三库单写者**：grant/ledger/audit 全在 v2.db、宿主单写；v2.db 从不挂进容器 → agent 无写句柄。
- **群聊保守**：群内只记意向、拒 `chat_id`、群卡空 `expectedUserId` 拒；绝不从群上下文 mint p2p 通道。
- **身份信任链**：`participant_open_id` 只来自 channel 入口直接解析、锚定 `consent_inbound_msg_id`、禁复用 a2a origin；强制 root-session。
- **网关唯一业务路径**：PoC 本地表为过渡态（见上），ADR 记录 Trade-off，硬化后下沉网关。
- **observability 只读**：审计/metrics 只追加记录，不改身份链或消息流。

## Implementation Notes

- 迁移：`src/db/migrations/027-dm-grants.ts`（建 `dm_grants` / `dm_rate_ledger` / `dm_audit`，幂等），在 `src/db/migrations/index.ts` 注册。
- 访问层（全宿主侧、参数化 SQL）：`src/db/dm-grants.ts`（insert/getBySlot/checkGrantLive/incrementSends/revokeScope + 多键滑窗限速）、`src/db/dm-audit.ts`。
- 宿主安全胶水：`src/roster-dm.ts`（flag 读取 `rosterDmEnabledForGroup`、`assertRootSessionForRosterDm`、`hostScopeForSession`、`looksLikeRawPlatformId`、`parseConsentTarget`、`revokeScope`）。
- 出站闸：`src/delivery.ts` 的 `deliverRosterMessage`（kind='roster' 分支）+ channel 分支 flag-on 收紧。
- consent 捕获：`src/channels/feishu.ts`（`handleMessageReceive` p2p、`handleCardAction` 卡片）+ `src/channels/feishu/roster-consent.ts`。
- 撤销钩子：`src/session-archive.ts`（root/scope-owner session 归档 → `revokeScope`）。
- 时间：宿主统一 `.toISOString()` 写、`parseSqliteUtc` 解析，绝不取容器侧时间。
- 测试：`src/roster-dm.test.ts`（vitest，host 侧，mock 风格随 host-core/delivery 测试）。
- metric：`*_roster_dm_rejected_total{reason}`。
- 关联 ADR：ADR-0016（delivery resilience，roster 复用 delivered 重试/幂等但禁调度）、ADR-0017（身份跨校验，强制 root-session 是其 Open Question 的缓解）、ADR-0019（fail-closed defaults，本特性全部 fail-closed）、ADR-0022（入站持久化，roster 不改入站路径）。

## References

- 2026-06 全仓成熟度审计（身份链可伪造一项）
- 红队对抗结果：22 攻击向量 / 5 根因 / 4 critical / 11 high
- 上游 ADR：ADR-0016 / ADR-0017 / ADR-0019 / ADR-0022
