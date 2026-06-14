# ADR-0045: roster-DM 接口 as-merged 红队加固（ADR-0023/0044 后续）

- **Status**: Accepted
- **Date**: 2026-06-15
- **Decider(s)**: 用户（platform owner）；coding agent（提案/执行/审计）
- **Tags**: `security`, `delivery`, `identity-trust-chain`, `feishu-channel`, `fail-closed`, `roster-dm`
- **Supersedes**: 无（加固 ADR-0023 + ADR-0044，不替代）

---

## Context

ADR-0044 把 roster-DM 的 agent 对外接口（send/discover/invite）合并到 main 后，对**已合并的真实代码**跑了一次 5 视角对抗红队（每条发现再经 3 个不同视角的怀疑者复核，只保留 ≥2/3 判定为真的）。复核确认了 **3 个真 bug**（其中 consent 伪造为 critical），全部在干净代码上可复现：

1. **同意卡伪造（critical，违反 ADR-0044 载重不变量）**：飞书 adapter `deliver()` 在 `src/channels/feishu.ts` 仅凭 `content.type === 'roster_invite'` 就构建 roster 同意卡，**从不检查 `message.kind`**。容器拥有 `outbound.db`（且 agent 有 Bash），可绕过 MCP 工具直接写一行 `kind='chat'` 的普通渠道消息，content 携带容器自造的 `optIn`。该行不走 `kind='roster'` 也不走 `kind='system'` 的 invite handler，落到普通渠道投递分支；既有 p2p 反绕过守卫只匹配 `feishu:p2p:`、群 id `feishu:oc_` 不被拦，发往本会话源群又满足 `isOriginChat` ACL。于是一张"宿主样式"的同意卡被发进群，点击者一旦是卡上 `expectedUserId`，`captureDirectedCardConsent` 便**逐字信任**卡里的 `scopeId/agentGroupId/maxSends/expiresAt` 铸出 grant——绕开 invite 闸的全部防护（成员校验、每(scope,member)一次抑制、限速、宿主盖的 24h 过期）。这正是 `roster-invite.ts:18-26` 明文记载的载重不变量（"本 handler 是构建 roster 同意卡的**唯一**地方"）被破。
   - 危害上限（诚实标注，不抵消 bug）：容器拿不到自身宿主派生的 `scope_id`（随机 UUID，不经 env/挂载/投影下发），故一般无法用伪造 grant 给自己发 DM；真正坐实的危害是**同意钓鱼面**（向任意成员发宿主样式的同意卡、零审计、绕全部 invite 防护）+ 容器自选 grant 字段。且该路径**不**校验 `ALLOW_ROSTER_DM`，关着开关也能铸 grant。

2. **撤销竞态（medium）**：开启 `ROSTER_GATEWAY_AUTHORITY` 或 `ROSTER_VERIFY_MEMBERSHIP`（均默认关）时，`checkGrantLive`（权威存活闸）与 `reserveRosterSend` 之间夹着一次网络 `await`。撤销（opt-out/退群/scope 结束）若落在 await 窗口里，`reserveRosterSend` 的 grant UPDATE 只看 `sends_used`、**不看 `revoked_at`**，于是给一个已撤销的人投了 DM（违反"撤销在投递瞬间生效"）。

3. **重试重复发送（high-correctness）**：`deliverRosterMessage` 的非超时 catch 分支**无条件**回滚预留。超时分支故意**保留**预留（超时是 at-least-once、可能已投递）；但若某 tick 超时保留了预留、下一 tick 同一消息重投又遇**非超时**错误，回滚会把一笔（可能已投递的）发送 un-count、把 grant un-revoke、删掉幂等标记 → 下一 tick 重新 fresh 预留并**重复投递**（`max_sends≥2`/无限时），违反 R5/不变量 6。

## Options Considered

针对 #1（核心）：

- **Option A：adapter 侧按 `kind` 把关**——在 `feishu.ts:1020` 要求 `message.kind === 'roster.invite'` 才建卡。能堵，但补丁落在 `feishu.ts`，与本仓正在进行的另一股身份门禁 WIP 同文件冲突；且只是 adapter 层的纵深防御，不是宿主信任边界处的把关。
- **Option B（选中）：宿主投递路径 fail-closed 拒绝**——在 `src/delivery.ts deliverMessage` 里，对任何到达**轮询投递路径**、其 content 是 roster 同意卡（`type==='roster_invite'` 或 `optIn.kind==='roster.optin'`）的行直接拒投 + 审计。**关键事实**：唯一合法的建卡者 `handleRosterInvite` 是经 `adapter.deliver(..., 'roster.invite', ...)` **直接**投卡的，**从不写 messages_out 行**，故永不经过 `deliverMessage`——所以任何在此出现的同意卡必是伪造。该判定与 ADR-0023/0044 的信任模型一致（容器写的每个字段都不可信），落在干净文件、不碰 WIP。
- Option A 与 B 不互斥；选 B 作为载重修复，A 作为可选纵深防御留待身份门禁 WIP 落地后再叠加。

针对 #2/#3：均为 ADR-0023 既有 reserve-before-send 设计内的正确性修补，无设计层取舍，采纳红队 3 视角一致的最小修法。

## Decision

> **拍板**：采 Option B 作为 #1 的载重修复，并按最小修法补 #2/#3。

1. **#1**：`delivery.ts` 新增 `isForgedRosterOptInCard(content)`，在 `deliverMessage` 的 `kind==='roster'` 分支之后、任何渠道分发之前 fail-closed：命中即 `rosterDmRejectedTotal{forged_optin_card}` + `recordDmAudit(reason='forged_optin_card')` + throw。**不分 flag 开关**（同意/铸造路径本就不看 flag）。
2. **#2**：`reserveRosterSend` 的 grant 条件 UPDATE 增加 `revoked_at IS NULL`，把撤销复查折进同一串行化事务里原子完成。WHERE 看 UPDATE 前的行状态，故首个达上限的预留仍照常通过并经 CASE 自撤销——不破坏既有 max_sends 自撤销语义。
3. **#3**：在 `978` 行捕获的 `reservation.fresh` 现在被读用——非超时 catch 仅当 `reservation.fresh === true`（本 tick 新建的预留）才回滚；`fresh === false`（前序超时保留下来的预留）按超时分支处理：保留 + rethrow，绝不 un-count/重发。

理由（可验证）：每条都配了**会在修复前失败、修复后通过**的回归测试（`src/roster-dm.test.ts` 的 `red-team hardening (audit 2026-06-15)` 块，已用 stash 源码、跑测试确认 4 例在 pre-fix 全红）。

## Consequences

- **正向**：堵死一条 critical 同意卡伪造链（关 ADR-0044 载重不变量的洞）；撤销在投递瞬间生效（即便开了 gateway/membership 两个可选闸）；超时后重试不再重复投递/over-budget。R1-R5 + 不变量 1-6 全保，且都是 fail-closed 加固，不放宽任何授权。
- **审计/可观测**：新增审计原因 `forged_optin_card` 与 metric 标签值 `rosterDmRejectedTotal{forged_optin_card}`，伪造尝试在 `/metrics` 与 `dm_audit` 可见。
- **行为**：合法 invite 路径**完全不受影响**（它不经 `deliverMessage`）；普通 chat/卡片消息不受守卫影响（`isForgedRosterOptInCard` 对 `{text}` 等返回 false）。
- **遗留/纵深防御（非阻断）**：Option A（`feishu.ts` 按 `kind` 把关）作为第二层留待身份门禁 WIP 落地后叠加；`captureDirectedCardConsent` 仍逐字信任卡字段——本 ADR 通过"建卡路径宿主独占"维持该信任的前提成立，未改 consent 侧（若日后要再加 HMAC 盖章则另立 ADR）。
- 纯 host 侧改动（`src/delivery.ts`、`src/db/dm-grants.ts`），无 schema/契约变更，无容器改动。
