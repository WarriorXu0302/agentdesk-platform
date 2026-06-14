# ADR-0044: roster-DM 的 agent 对外接口（host-mediated 三件套:send / discover / invite）

- **Status**: Accepted
- **Date**: 2026-06-14
- **Decider(s)**: yingqi2(用户,选「全套」+ 验收);coding agent(设计 + 执行)
- **Tags**: `security`, `delivery`, `feishu`, `identity`, `agent-surface`, `authorization`
- **Supersedes**: 无
- **Superseded by**: 无(ADR-0023 的后续:补 agent 侧接口)

---

## Context

ADR-0023 建好了 roster-DM 的**宿主侧**机器(同意 grant、`kind='roster'` 投递闸、撤销、限速、可选网关授权、成员复查),经 22 向量红队收敛为 5 根因(R1-R5),默认关(`ALLOW_ROSTER_DM`)。但**agent 侧没有任何触发入口**——整套机器没有调用者,agent 无法真正"定向私聊某个已同意的人"。

本 ADR 补上 agent 对外接口,让"A 批完 → 通知 B 落实"这类流程端到端可用,**且绝不削弱 R1-R5**。经一轮 design+对抗评审 workflow:host-mediated vs container-crafted 两方案,评审**驳回 container-crafted**(同意路径会信任容器写的 `expectedUserId/scopeId`),采 host-mediated。

约束:R1-R5 + 5 条 load-bearing 不变量全部保持。新接口是**新攻击面**(尤其"邀请"=新建联系人通道),需逐条加固。

## Options Considered

- **Option A(选中)— host-mediated 三件套**:agent 工具是**薄意图发射器**,所有安全关键字段(scopeId、agentGroupId、expectedUserId、卡片 payload)**只由宿主 handler 盖章**(从 session 重新派生)。send 写 null 路由 + content.slot;invite 发 `kind='system'` 意图行、宿主建并发定向同意卡;discover 由宿主把"活槽位投影"写进 inbound.db(零身份字段)。
- **Option B(驳回)— container-crafted 卡片**:容器自己建定向同意卡、按 open_id 寻址。**驳回**:`captureDirectedCardConsent` 信任卡片 value 里的 `expectedUserId/scopeId` 而不重新派生——容器建卡 = 容器选了 grant 的 scope 与受众,直接洞开 R2/R4。

## Decision

> **拍板**:选 Option A(host-mediated)。三个 agent 工具薄如纸,授权全在宿主。

**三件套契约:**

1. **`send_roster_dm({slot, text})`** — 写 `kind='roster'`、`platform_id=null`、`channel_type=null`、`content={slot,text}`。宿主沿既有 `deliverRosterMessage` 闸处理(按 `(host-derived scope, slot)` 反查 grant、覆盖路由、live 复查、限速)。**工具返回串必须不透明**:绝不回显解析出的 open_id / dm_platform_id(否则 agent 能借返回值收割身份,破坏 R3 槽位间接)。

2. **discovery(发现)** — 宿主每次唤醒时用**新增** `listLiveGrantsForScope(scopeId)`(过滤 revoked/expired/max_sends)把"活槽位投影"写进 inbound.db 的 `roster_slots` 表,**只投影 `{slot_label, display_name, sends_remaining, expires_at}`——零身份字段(无 open_id)**;容器经 `getLiveRosterSlots()` 读、拼进系统提示。`scopeId` 绝不写进 inbound.db。

3. **`invite_to_roster({member: ou_*, slot_label})`** — 写 `kind='system'`、`content={action:'roster.invite', member, slotLabel}`、null 路由。宿主 `registerDeliveryAction('roster.invite')` handler:
   (1) fail-closed 复查 flag + root-session;
   (2) **scopeId、agentGroupId 由宿主从 session 派生——绝不读 content**(即便容器写了也忽略);
   (3) `parseConsentTarget(member)` 拒非 `ou_*`;
   (4) **`getByParticipant(scope, member)` 有任何行(含已撤销/已 opt-out)即抑制重复邀请**(每 (scope,member) 一次,防骚扰);
   (5) **`isMember(originGroup, member)===true` 否则 fail-closed**(`undefined` 也拒——新建联系通道,成员门槛绝对);
   (6) 发卡前**计 invite 限速**(scope 60s/3 + deploy 日上限);
   (7) 宿主盖 `expectedUserId=member` + **`expiresAt=now+24h`** + scopeId/agentGroupId。容器从不撰写这些字段。

**5 条强制新加固:**
- `listLiveGrantsForScope`(新 query,过滤 live)——发现投影正确性。
- invite **每 (scope,member) 一次**抑制(发卡前 `getByParticipant`)——防骚扰,不只是限速。
- invite 的 `isMember===undefined` **fail-closed**(send 路径 unknown 可退回 item-11;invite 是新通道,门槛绝对)。
- invite 卡**宿主盖 `expiresAt=now+24h`**——防过期卡被几天后点击 mint grant。
- invite **限速 ledger**(scope 60s/3 + deploy 日上限),发卡前计,超限 `roster_invite_rejected_total` + dm_audit。

## Consequences

- **Positive**:"定向私聊已同意的人"端到端可用(默认关、同意闸不变);R1-R5 逐条保持甚至 invite 路径加强(R2:宿主强制 expectedUserId 非空);agent 只见槽位标签、永不见 open_id。
- **Negative / Trade-offs**:invite 是新建联系通道,即便层层加固仍是平台最敏感面之一——故默认关 + 成员门槛绝对 + 一次性抑制 + 限速 + 24h 过期 + 单独评审落地。`roster_slots` 投影在 turn 内可能 stale(grant 中途撤销),靠 send 时 `checkGrantLive` 兜底(干净拒投)。
- **Neutral**:多群 a2a scope 下 invite 的 origin group 可能歧义——Stage 3 必须**显式 fail-closed**(歧义时拒邀)。

## Implementation Notes

- **load-bearing 不变量(记入,非仅当前行为)**:`captureDirectedCardConsent` 信任卡片 value 里的 `expectedUserId/scopeId`,故**建卡路径必须永远宿主控制**——任何未来在宿主 invite handler 之外建定向同意卡的扩展都会破坏 R2/R4。
- 落地(分阶段,每阶段独立可测 + 提交):
  - **Stage 0**:`src/db/dm-grants.ts` 加 `listLiveGrantsForScope(scopeId)`(WHERE scope_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now) AND (max_sends=0 OR sends_used<max_sends))+ 单测。无行为变更。
  - **Stage 1(discovery)**:inbound.db `roster_slots` 投影表 + 宿主 `writeRosterSlots`(用 listLiveGrantsForScope,零身份字段)+ 容器 `getLiveRosterSlots()` + 系统提示段。验证 agent 只见 slot 标签。
  - **Stage 2(send)**:容器 `send_roster_dm` 工具(写 kind='roster' null 路由,返回不透明)+ roundtrip e2e(断言 raw platform_id 直发被拒)。无新宿主代码。
  - **Stage 3(invite,单独评审)**:容器 `invite_to_roster` 工具 + 宿主 `registerDeliveryAction('roster.invite')` + 上述 5 加固;测试:非成员拒、isMember=undefined 拒、opt-out 抑制、限速、完整 点击→grant→槽位→发送 happy path、多群歧义拒。
- metric:`roster_invite_rejected_total{reason}`(新);复用 `roster_dm_rejected_total`。
- 依赖:ADR-0023(宿主机器)、ADR-0017(身份)、ADR-0019(fail-closed)。

## References

- 上游 ADR:ADR-0023(roster-DM 宿主侧)、ADR-0017、ADR-0019
- 设计 + 对抗评审 workflow:design-roster-dm-agent-surface(2 map → host-mediated vs container-crafted → 安全合成,驳回 container-crafted,5 加固)
- load-bearing 不变量:`CLAUDE.md`、ADR-0023 的 R1-R5
