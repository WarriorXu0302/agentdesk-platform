# ADR-0050: 记忆调和 + 时效性契约（A.U.D.N. + temporal validity,对标清单 #5）

- **Status**: Accepted
- **Date**: 2026-06-15
- **Decider(s)**: coding agent（对标 GitHub 成熟框架后落地 benchmark 清单 #5，对标 Mem0）
- **Tags**: `gateway`, `memory`, `contract`, `provenance`, `backward-compat`, `reference-gateway`

---

## Context

对标 Mem0 的发现：成熟记忆层在**写侧调和**——upsert 一条事实时先读同 subject 的邻居，
判定 **A.U.D.N.**（add / update / delete / no-op）再落库，而不是按 key 盲写覆盖。
AgentDesk 的 `/memory/upsert` 是**纯 key-addressed 盲写**（可选 merge），长期命名空间
（`user.preferences` / `conversation.summary`）会沉积陈旧/相互矛盾的事实。ADR-0043 的
`/memory/feedback` 只能**标记**某记录不准，**无法解决**——解决（调和）是后端拥有的 curation 步骤，
而契约里缺一个让被取代的事实"可被保留但不污染默认召回"的表达。

诚实定位：调和的**语义判定**（哪条该 update、哪条该 delete）在生产里是 LLM/领域规则的活，
属后端、平台不做也不强制。平台能做的、且**零 host 风险、全本地可验**的是两件：
①给召回结果加一对可选时效字段，让后端能表达"这条何时生效/何时失效"；
②在**契约文档 + 参考网关**里把推荐的 A.U.D.N.+时效语义讲清楚、跑通给运营者看。

## Decision

> **契约（加性、向后兼容）**：`memorySearchResultSchema` 加两个可选 ISO-8601 字段
> `validAt`（本版本何时成为生效事实）/ `invalidAt`（何时被取代/退休；缺省=仍生效）。
> 二者皆 optional + passthrough，非时效后端保持 conformant。平台**绝不解释**这对字段——
> 像任何召回字段一样裹进 `UNTRUSTED_MEMORY` 栅栏转发，由 agent 自行决定陈旧事实是否还重要。
>
> **文档**：`docs/enterprise-erp-gateway.md` 新增"Memory curation & temporal validity"小节，
> 讲清推荐的写侧 A.U.D.N. 形状（add/update/delete/no-op，按 (namespace,subject) 邻居调和）+
> **invalidate-don't-delete**（取代时盖 `invalidAt` 留审计轨，别删行）+ 推荐召回行为
> （默认只返回生效事实，`includeHistory` 才带出被取代的）。
>
> **参考网关**（`examples/reference-gateway/server.mjs`）：把 per-key 单记录改为**版本列表**，
> 用**确定性**（canonical-value 等值判 no-op、变更则取代）演示 A.U.D.N. 形状，落 `validAt`/
> `invalidAt`，`/memory/search` 默认只返回 live、`includeHistory:true` 带出历史。明确注释
> "真后端按**语义**调和（LLM/领域规则），此处只是结构样例"。

**为何契约只动 search-result、不强制写侧**：调和是后端语义判定，把它焊进契约会违背业务无关约束。
平台给的是**表达能力**（时效字段）+ **推荐语义**（文档/样例），不是 mandate——这与每个网关
端点一贯的非对称姿态一致（宽松校验、可选采纳）。

## Consequences

- **正向**：闭合 ADR-0043 留的 curation 环——flag→resolve 的 resolve 端现在有契约表达（时效字段）
  + 推荐语义（A.U.D.N.）+ 可跑通的参考实现。长期命名空间的陈旧事实可被取代且不污染默认召回，
  agent 也能按需查历史。契约纯加性，老 search 后端零改动仍 conformant。
- **边界（诚实）**：这是**契约 + 文档 + 参考样例**，**不**是 host 行为改动——平台不做也不强制语义调和
  （那是后端的活）。参考网关的等值判 no-op 是确定性 demo，**不**等于生产级语义调和；DELETE
  （矛盾退休）需语义判定，确定性 demo 不演示、文档点明。
- **不变量**：网关仍是业务记忆唯一路径（无平行存储）；时效字段裹 `UNTRUSTED_MEMORY` 栅栏转发，
  read-side 注入隔离不变；身份链/三-DB/observability 全不碰。
- **验证**：容器 `bun test` 320/320（gateway-contract.test.ts +3 时效用例）；参考网关
  `node --check` + 9/9 conformance 仍绿 + A.U.D.N. 行为冒烟（add→noop→update 取代→默认召回只 live、
  includeHistory 带出 invalidAt 历史）。
- **未来**：若要把调和上移成平台能力，需后端契约里加显式 reconciliation 钩子——但那会引入语义耦合，
  按需再议；当前止于"表达 + 推荐 + 样例"。
