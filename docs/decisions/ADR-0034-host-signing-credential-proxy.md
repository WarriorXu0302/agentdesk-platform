# ADR-0034:Host 侧网关签名凭证代理(签名密钥不进容器)

- 状态:Accepted(已实现 + 已过对抗红队;默认 OFF)
- 日期:2026-06-13
- 标签:`security`, `gateway`, `identity-trust-chain`, `fail-closed`, `credential-isolation`

> 本特性已实现并合入,默认 OFF(`AGENTDESK_GATEWAY_SIGNING_PROXY` 未开 = 字节级零变化)。
> 实现后做了一轮 6 视角对抗红队(13 确认 / 4 驳回),抓到 1 个 critical(代理 env 未透传到
> 内置 MCP 子进程 → 特性形同虚设且降级为"无签名直连后端",绿测未发现)和 1 个 high
> (redacted container.json 仍留 baseUrl → 无签名直连回退,违背结构性 fail-closed),连同
> 其余 medium/low 已全部修复(见末尾"红队结论")。

## 背景与问题

今天 backend gateway 的 HMAC `signingKey` 经只读挂载的 `container.json` 进容器,
容器内 `applySigningHeaders()`(`container/agent-runner/src/mcp-tools/gateway.ts`)用它对
`<ts>.<nonce>.<body>` 签名。任何被提示注入或越权读文件的容器(威胁模型:bypassPermissions +
Bash 可用)能读出该 group 的长期签名密钥 = 对 backend 的永久、任意 body、跨重启伪造能力。
这是全仓成熟度审计确认的"身份链可伪造"类根因之一,目前由 ADR-0032(容器 egress 管控)在
**网络层缓解**(锁出口 → 泄漏的 key 到不了任意地址),但密钥本身仍在容器内。

目标:signingKey 不再进容器。容器对网关的请求发给 host 侧本地代理,host 按调用方**真实
group**(central DB 的 session→group 权威映射)代签后转发到 backend。容器只持一个 host
颁发、per-session、作用域受限、短 TTL、可撤销的代理 token。

非目标(phase1):不改 backend 看到的线上契约(同一 HMAC/头/body 字节/错误码);不改三库
单写者;不动 observability 只读;不引入第二条业务路径;不覆盖 OpenAI/LLM provider key 的
移出(见 phase2 边界)。

## 决策

1. **方案 B**:signingKey 完全不进容器,per-session 自包含签名 token 替代。否决方案 A
   (容器内仍持短期 token 走容器内签名逻辑)——它不消灭"容器内存在可签整个 group 的能力"。
2. **group 信任根 = central DB `session.agent_group_id`**,与 ADR-0017 同构(host 不信容器
   自报,用可信侧反查)。本设计比 ADR-0017 更强:签名 key 干脆不在容器里。
3. **规范化重序列化后签名(红队修订)**:代理 `JSON.parse` 请求体做 `agent.agentGroupId`
   identity 校验(不符即 409),随后 `JSON.stringify(parsed)` 得到**规范化字节**,对该规范化
   字节签名并转发(**不是**原始字节)。原设计是"字节透传不覆盖",但红队发现:原始字节里可塞
   重复键(两个 `agent` 块),V8 last-wins 让代理校验到 GROUP-A 通过,而 first-wins 的异构
   后端解析同一字节会读到 GROUP-B → 用 A 的密钥签了"意思是 B"的请求(parser differential)。
   重序列化把重复键折叠成单一无歧义键,后端对收到字节重算 HMAC == 代理所签字节,从结构上消除
   该差异。合法机器请求本就是规范化 JSON,重序列化对其字节无变化。backend 仍 MUST 对收到的
   原始字节重算 HMAC。
4. **fail-closed 是结构性的**:容器无 key,代理不可达时回退不了(不依赖代码自觉)。
5. **默认 OFF 零变化**:flag(`AGENTDESK_GATEWAY_SIGNING_PROXY`)关 = 不启动 listener +
   `container.json` 含 key(现状) + 不注入 env。字节级零行为变化。
6. **审计两阶段 + 结构化列(破例加列)**:host 权威行先写 intent 再 update 终态;
   `gateway_audit` 加 `signed_as_group`/`token_jti`/`proxy_request_id`/`identity_mismatch`/
   `requester_source_coerced`/`audit_phase`。host 行是唯一权威,容器行永不去重覆盖它。
7. **红队后从"可选"提为出厂必须**:代理独立 listener/端口(不复用对外 ingress 的
   `0.0.0.0:WEBHOOK_PORT`)+ 源 IP 绑定 + per-token 限速 + allowedPaths 读写分离 +
   `NO_PROXY=host.docker.internal` 注入(防 OneCLI 的 HTTPS_PROXY 隧道吞掉流量) +
   mint 记录/撤销持久化 central DB(防 host 重启丢内存 Map)。

## 为什么(红队驱动的硬化要点)

- **token 是"低保密强作用域"凭据**:env 可被 `docker inspect` / `/proc/<pid>/environ` 读出,
  所以安全不压在保密性,而压在作用域(短 TTL / 读写分离 path / 源 IP / 限速 / 可撤销)。
- **代理面对全宿主可达**:故源 IP 绑定 + 独立端口,token 不是唯一闸。
- **OneCLI 注入的 HTTPS_PROXY 会吞掉容器→代理流量**:故 NO_PROXY 是硬前置条件。
- **崩溃窗口造成零审计行**:故两阶段(intent-before-forward)审计。

## 与既有 ADR 的关系

- **ADR-0017**:沿用同一信任范式(host 可信侧反查、覆盖/拒绝容器自报),并继承其已知残留
  (R5:容器直写 outbound.db 伪造 `requesterSource='session'`,本特性不改善不恶化)。
- **ADR-0028**:线上契约字节不变;本 ADR **破例**给 gateway_audit 加列(理由:身份代签是新
  信任语义,关键事实必须结构化可查询而非埋进 error_msg)。
- **ADR-0032(egress)**:proxy(key 不进容器)与 egress(限制能发去哪)是**正交两层**,
  proxy 上线**不**替代 egress;backend HMAC/时间戳/nonce/重放是必需第三层。部署约束:proxy
  模式下 egress 网络 MUST 放行容器→host 代理端口(且只放行这一个)。
- **ADR-0023 / `roster-gateway.ts`**:复用同一 `computeGatewaySignature` 原语(拟抽到
  `src/gateway-signing.ts`)与 fail-closed 哲学;路由/鉴权/审计独立(信任语义相反)。

## phase2 边界(OpenAI 流式代签,本 ADR 先划界不实现)

phase1 只覆盖 backend gateway 的 JSON 请求/应答(5 path、小体积、非流式):read-body → sign
→ forward → read-response。phase2(把 OpenAI/LLM key 也移出容器代签)形状不同:SSE/chunked
流式、长连接、大 body、可能 CONNECT 隧道,**不能复用**"读全 body 再签"模型,需独立流式
转发器(pipe + 背压)。phase2 **复用** phase1 的 token mint/作用域、代理位置/独立端口、
fail-closed 哲学;**不复用** body 签名/契约层与一次性转发模型。phase2 另开 ADR。

## 红队结论(实现后,6 视角对抗复审 + 怀疑者独立反驳)

- **critical(已修)**:代理 env 未透传到内置 MCP 子进程。内置网关工具跑在独立 `bun run` MCP
  子进程,其 env 是显式白名单(`mcp-child-env.ts`),`AGENTDESK_GATEWAY_PROXY_URL/TOKEN` 不在
  其中 → `getSigningProxyTarget()` 恒 null → 走直连分支 → 因 key 已 redact,实际**无签名直连
  后端**(fail-open)。单测因在测试进程内设 env 而漏过。修:把两个 proxy var 加进
  `MCP_CHILD_ENV_KEYS`(与 OTEL 透传同一已验证路径),并加回归测试。
- **high(已修)**:redacted container.json 只删了 signingKey、留着 baseUrl,容器走直连分支时
  `applySigningHeaders` 空操作 → 无签名直连真实 baseUrl,违背"结构性 fail-closed"。修:redact
  时同时把 `baseUrl` 置空,使直连分支命中 `GATEWAY_NOT_CONFIGURED`(无 key 且无目标)。
- **medium(已修)**:parser-differential(见决策 3,改规范化重序列化);两阶段审计崩溃窗口残留
  `intent`/`pending` 行无回收(启动期 `reconcileOrphanedProxyAudit` 一次性收尾);intent 行污染
  运营查询的 `{ok,error}` status 域(`queryGatewayAudit` 默认过滤非 final 行);host 重启后孤儿
  token/redacted 文件残留(启动期 `cleanupProxyRuntimeOnBoot` revoke-all + 清目录)。
- **low(已修/已记)**:`gateway_proxy_token` 无界增长(host-sweep 接入 `purgeStaleProxyTokens`);
  迁移 029 加 `hasTable` 守卫;源 IP pin 在非 Linux/NAT 上跨容器不可分辨(启动期 loud warn);
  读写 path 分离当前全量 mint(端到端已强制,缺 per-group 角色模型,记为 forward-compat);
  redact/mount 缺测试(已补 redaction + 路径单测)。

## 实现成本与取舍

- **这是整条加固线里 blast radius 最高的一项**:在核心业务路径上新建一个带鉴权的 host
  服务(token mint/验签 + 源 IP 绑定 + 两阶段审计 + 限速 + 迁移 + 容器侧硬分叉)。默认 OFF,
  phase1 只解决 signingKey,OpenAI key 仍需 phase2。
- **它是"超出已达到的生产级门槛"的深度加固**:第二次成熟度审计判定平台对"单机 + 数十用户 +
  运营者按清单加固"已生产可用;本特性把"容器被攻破即泄漏长期 group 伪造能力"从 egress 网络层
  缓解升级为结构性根治(密钥不进容器)。

## 实现切片(实际落地映射)

- **P0 共享原语**:抽 `src/gateway-signing.ts`(`computeGatewaySignature`,roster-gateway 改 import);flag 解析。
- **P1 host 代理 + mint**:迁移 `029-gateway-audit-proxy-columns.ts`(加上述 6 列,全 nullable)+ `recordGatewayAudit`/新 `updateGatewayAuditFinal`/`queryGatewayAudit` 过滤;新模块 `src/modules/gateway-signing-proxy/index.ts`(独立 http.Server + 自包含签名 token mint/验签 + central DB mint/tombstone 持久化 + handler:源 IP→token→path 白名单→identity 比对 409→字节透传签名→转发 mint baseUrl→两阶段审计 + 限速);`src/index.ts` flag 开才启动 + 启动期连通性 loud warn。
- **P2 spawn 注入**:`container-runner.ts`(image tag 前)mint token + 登记容器 docker IP + allowedPaths 收窄 + 注入 proxy/port/token + 合并 `NO_PROXY`;容器退出 + host-sweep kill 同一路径撤销 token;`writeContainerConfig` flag 开时省略 signingKey。
- **P3 容器侧分叉**:`gateway.ts` `callGateway` 顶部 `if (proxyMode()) return proxyCall(...)` 早返回、绕环境代理 dispatcher fetch、不签名、不 fall through;idempotencyKey 上移稳定锚点。
- **测试**:proxy 模式 container.json 无 signingKey;proxy 不可达无 baseUrl fetch;NO_PROXY 注入;恶意 body.baseUrl/signingHeaders 被丢弃、出站目标恒等 mint baseUrl;identity_mismatch 409;字节透传;CI grep 禁 proxy 路径调 applySigningHeaders / token 进 log。

## 残余风险

- token 仍是容器内 secret(env 可读),blast 更小但非"拿不到"。
- 能读 docker socket = 能在 TTL 内冒充活动 session(需运营层隔离 docker socket)。
- phase1 不含 OpenAI/provider key。
- R5(requesterSource 直写伪造)继承自 ADR-0017,不在本范围。
- 读操作 fail-closed 是可用性代价(非安全必需);backend 强制校验 HMAC 是安全前提。

## 后果

- 正向:容器被攻破不再泄漏长期 group 伪造能力;越权代签可结构化审计告警;默认关零变化。
- 成本:新增 host 代签热路径;schema 演进一次;部署多一条 egress↔代理可达性约束;读操作
  引入对代理可用性的硬依赖。
