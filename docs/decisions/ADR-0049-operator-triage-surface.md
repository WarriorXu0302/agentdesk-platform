# ADR-0049: 运营者分诊查询面（operability-at-scale,对标清单 #7-lean）

- **Status**: Accepted
- **Date**: 2026-06-15
- **Decider(s)**: 用户(要"能 scaling 的就做");coding agent(分析 + 执行)
- **Tags**: `observability`, `operability`, `governance`, `db`, `scaling`

---

## Context

用户要"挑能给项目 scaling 的做"。诚实评估:**真正的容量 scaling = 多机 HA,是刻意的非目标**(对标"别学"清单 + 成熟度审计都明示——会破三-DB 单写不变量,不预建)。单机边界内的 scaling 杠杆里:
- **#4 温池**:并非 benchmark 说的干净 win——Docker 挂载 create 后不可变,通用池无法安全 per-session 绑 DB(隔离风险),且框架**本就**保 idle 容器 30 分钟(返场会话已热)。
- **容器密度/host-loop**:真天花板是容器内存占用(基础设施限,非自主可改);host sweep 非主瓶颈。
- **#7 治理面**:唯一安全、host 可验、真正"在一台部署上 scale 到更多 tenant/org/并发用户"的杠杆,也是 benchmark 指出的缺失面(packaged 管理/治理面;**不抄** Dify 行级 tenant_id——本框架按会话隔离已更强)。

故选 **operability-at-scale**:让运营者能观测/分诊大量并发会话(跑不了你看不见/分诊不了的几百个会话/组织)。

## Decision

> 加一个**只读运营分诊查询面** `src/db/operator-queries.ts` + CLI `scripts/trace.ts`:
> - `listSessions(filter)`:按 agent group / owner / thread / root / status / container-state / channel 过滤会话队列(AND;channel 经 messaging_groups join;封顶 1000)。
> - `traceRequest(rootSessionId)`:从 `root_session_id`(委派树根)拼出**一个请求的完整 fan-out**(frontdesk 根 + 各委派 worker,root-session 模式下继承同 root)+ 这些会话的 classification_log 决策——跨会话"这个请求发生了什么"视图。

**关键设计修正(ADR-0039 守卫挡下)**:初版按 `conversation_thread_id = ?` 查 → 触发既有 `conversation-thread-id-guard.test.ts`(该 id 是**纯关联**,绝不能成等值查找/授权键)。修正:**改按 `root_session_id` 查**(合法结构/路由键)+ classifications 按 `session_id` 查;conv id 仍**显示**(SELECT *,供与 OTel trace 交叉引用)但**绝不**做查找键。这比 conv-id 查更结构正确(root_session_id 就是委派树),且零守卫弱化。

**只读 by construction**(纯 SELECT);读运营者自有的中央 DB,访问由"谁能跑 CLI"门控,无需 in-band 角色检查。
（**更新**:ADR-0051 给这个面加了**可选** in-band 角色闸 `canOperate` + `trace.ts --as`——supersede 此处"仅 OS 门控"，
不给 `--as` 时行为不变。）

## Consequences

- **正向**:运营者可分诊大规模会话队列(按用户/渠道/状态/组过滤)+ 一键追一个请求的跨会话 fan-out——支撑在单机上 scale 到更多并发用户/组织的**可运维性**。也是 eval 框架(ADR-0047)的数据源。host 813/813 全绿、typecheck/prettier 干净。
- **边界(诚实)**:这是 **operability-scaling 不是 capacity-scaling**。真容量 scaling(多机 HA)是刻意非目标(破三-DB 不变量)、需用户拥有的重大架构决策,不在此。
- **不变量**:纯新增只读查询 + 一个 CLE 脚本;无 schema/契约/身份链/路由改动。**遵守 ADR-0039**——conv_thread_id 仍只 SET + IS NOT NULL/显示,绝不等值查找(守卫继续通过)。
- **未来**:若要完整 #7(显式 admin/operator/member/viewer 角色 + workspace 多租户实体层),在此查询面上叠;但 benchmark 提醒本框架隔离已强,workspace 主要是 packaging,价值中等——按需再议。
