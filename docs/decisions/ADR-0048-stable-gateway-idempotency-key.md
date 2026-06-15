# ADR-0048: 网关写入的稳定幂等键（对标清单 #1,跨进程边界 + 内容键设计）

- **Status**: Accepted
- **Date**: 2026-06-15
- **Decider(s)**: 用户(platform owner,选 Option A);coding agent(对标研究 + design+对抗评审 + 执行)
- **Tags**: `reliability`, `idempotency`, `gateway`, `erp-gateway`, `data-integrity`, `agent-runner`

---

## Context

对标成熟框架(DBOS/Inngest/Restate/Temporal)综合清单的**头号可靠性项 #1** 是跨步幂等键。深查后**纠正了 benchmark 的过度判断**:网关写入**早已有幂等键**——`gateway_execute`/`bulk_execute` 在 agent 省略时自动生成(`crypto.randomUUID()`),契约携带,后端按键去重(reference-gateway server.mjs)。投递是 at-least-once + DB 幂等(markDelivered)+ output-sent 去重。

**真正的窄缺口**:自动键是**每次调用随机**。若一轮在网关写入之后、出站投递/标记之前崩溃,host 重驱同一 inbound 行 → agent 重跑该轮 → 用**新随机键**再调网关 → 后端视为新操作 → **双写**。(output-sent 去重保的是面向用户的消息,不是轮内的网关副作用。)

## design+对抗评审(挡下一次坏 ship)

先对"step-counter 幂等键"设计做 3 视角对抗评审,**判定 UNSAFE/空转**,决定性发现是**架构**而非哈希数学:
- **进程边界(blocker)**:网关 handler 跑在**独立 `bun run` 子进程**(StdioServerTransport)。`getCurrentInReplyTo()`/`getRequestIdentity()` 是 poll-loop 父进程的**模块状态**,子进程里恒为 null。把稳定键 gate 在它非空 → **生产永不触发**、永远落随机 UUID = 没修。
- **false green**:in-process 单测在同进程里 set 这些状态 → 稳定分支会激活通过,**掩盖生产空转**。本仓被这个"env/context 不跨边界"类咬过两次(ADR-0026 OTel、ADR-0034 proxy)。
- **并发丢写**:默认 Claude provider 发并行 tool_use;MCP server 无序列化 → 模块计数器 read-then-increment 跨 await → 两个不同写拿同一 seq → **折叠成一个 → 静默丢写**。
- 还缺真 `canonicalJSON`(`hashBody` 用 raw `JSON.stringify`,key-order 敏感)。

## Options Considered

- **Option B:保留 random-UUID 为已接受残余**(像 R5):现状零数据丢失,只缺罕见崩溃-重放跨轮去重。安全但不改进。
- **Option A(选中):真正修复**——把稳定锚**源自 `processing_ack`(outbound.db)**(真正的跨进程通道:host 的 markProcessing 把当前轮 inbound 行标 'processing' 写进 outbound.db,子进程读得到),用**内容键 occurrenceIndex** 而非 dispatch-order seq,并发安全 + 重放稳定。用户接受"本地不能完全验证、靠 CI/真容器 e2e"前提。

**关键洞察(解锁 A 的本地可验证性)**:因为锚源自 **DB 表**(processing_ack)而非模块状态,in-process 测试只要 **seed processing_ack** 就能走**与真子进程完全相同**的 DB 读路径 → 不存在 false green(false green 是模块状态设计的产物,已消除),**无需 Docker** 即可忠实验证边界。

## Decision

> **拍板**:Option A。键 = `sha256(anchor | contentHash | occurrence)`:
> - `anchor` = `processing_ack` 中 status='processing' 的 message_id 排序拼接——**跨重驱稳定**(同行重标),故重跑复现同键。
> - `contentHash` = `sha256(canonicalJSON({callsite,operation,input,context,async}))`——不同写不同哈希(重放错位不会误去重;键是**内容**派生而非 dispatch-order,故扛得住并行 tool 调用)。
> - `occurrence` = 本轮-执行内相同 contentHash 的先前计数——两个**有意相同**的写拿不同键(无折叠丢写),**同步**在任何 await 前捕获(JS 单线程内原子)。
> - **重置信号** = `anchor + MAX(status_changed)`:重驱(≥60s 退避)使 status_changed 变 → 计数器归 0 → 重跑复现 0,1,…;**键不含信号**,故仍与原轮匹配。
> - 无 processing 批(定时/detached 路径)→ 回退 `crypto.randomUUID()`(不劣于今天)。agent 显式键永远优先。

先落地了纯函数前置 **`canonicalJSON`** + 用于 `hashBody`(稳定审计 inputHash),独立提交(347c22f)。本 ADR 落地核心:`resolveTurn` + occurrence tracker + `deriveStableIdempotencyKey`,接入 `/execute`(callsite `exec`)+ `/bulk_execute`(callsite `bulk[i]`)。

## Consequences

- **正向**:崩溃-重放跨轮去重(后端按键折叠双写),且**无数据丢失回归**(occurrence 防折叠合法重复写;内容键防错位误去重;同步捕获防并发竞态)。`/memory/upsert`(含 detached `flushCompactionSummary`)**不碰**(无 idempotencyKey 字段、轮后运行)。
- **best-effort 边界(用户已接受)**:稳定性只在 LLM 重跑复现**相同调用序列**时成立(结构化操作通常确定;自由文本可能漂移)。漂移时**退化为双写**(随机等价),**绝不**丢写/误去重。
- **验证**:7 个 in-process 测试 seed processing_ack + mock fetch 捕获键,覆盖:重驱复现同键 / 不同写不撞 / 相同写 occurrence 区分且重放复现 / 无锚回退随机 / 显式键优先 / dryRun 无键 / bulk 逐 op 区分且重放复现。容器 317/317 全绿、typecheck 干净。**后续(非阻断)**:真容器崩溃-重放 e2e(现 e2e 用 mock provider 跳过网关)作额外信心——边界正确性已由 DB 源 + processing_ack-seed 测试覆盖。
- 纯容器侧改动,无 host/契约/身份链改动。reference-gateway 共享 idempotency Map 靠 callsite 命名空间避免 exec/bulk 串键(已在键里 namespace)。
