# ADR-0035:OpenAI/直连 provider 的密钥经 OneCLI vault 注入(不进容器)

- 状态:Accepted(已实现;默认 OFF)
- 日期:2026-06-13
- 标签:`security`, `provider`, `credential-isolation`, `openai`, `onecli`

> 这是 ADR-0034 划界的 **phase2**(LLM provider key),但**没有**按 phase1 的"自建流式
> 凭证代理"路线走 —— 改为复用平台**已有**的 OneCLI vault(它本就为 Claude provider 做凭证
> 注入)。决策由用户在成本/取舍清楚后拍板(self-contained 流式代理 vs 复用 vault vs 不做)。

## 背景与问题

ADR-0034 把 backend gateway 的 signingKey 移出容器。LLM provider 的 key 是另一处暴露:

- **Claude provider(默认)**:key **不在容器里**。容器的 LLM 调用经 OneCLI vault 的
  HTTPS 转发代理,vault 在线注入 Anthropic 凭证(MITM TLS + 注入 Authorization)。已安全。
- **OpenAI / codex provider**:`container-runner.ts` **刻意跳过** OneCLI("direct-credential
  provider"),`src/providers/openai.ts` 把 `OPENAI_API_KEY` 直接 `-e` 进容器 env。被注入的
  agent 能从 `/proc/<pid>/environ` / `docker inspect` 读出这把(运营者自己的)OpenAI key。

风险低于 phase1(这把 key 只是运营者的 OpenAI 账号凭证 —— 可轮换、可设消费上限、可限流;
不是身份链伪造密钥),且仅影响**主动切到 openai/codex provider** 的部署(默认 Claude 不受影响)。

## 决策

引入 flag `AGENTDESK_OPENAI_VIA_ONECLI`(默认 OFF)。开启 + provider ∈ {openai, codex} 时:

1. **不再跳过 OneCLI**:`container-runner` 对 openai/codex 也走 `ensureAgent +
   applyContainerConfig`,把 vault 的 HTTPS_PROXY + CA 注进容器(mock 仍永远离线跳过)。
2. **key 不进容器**:`buildOpenAIContribution` 省略 `OPENAI_API_KEY`,只保留 baseUrl/model/
   timeout 等非密字段;并注入 `OPENAI_CREDENTIAL_VIA_PROXY=true` 告知容器处于 vault 模式。
3. **容器侧不自带 Authorization**:`openai.ts` vault 模式下不要求 key、`requestHeaders()` 不发
   `Authorization`(vault 在线注入);仍请求**真实** baseUrl(`https://api.openai.com/...`
   或运营者配置的真实端点),HTTPS_PROXY 把它透明转去 vault。
4. **bun fetch 信任 vault CA(红队修订:探测而非硬编码)**:容器的 OpenAI 调用用 bun 的
   `fetch`,它认 `NODE_EXTRA_CA_CERTS` 而非 `SSL_CERT_FILE`。OneCLI **只在能构建合并 CA 时**
   (host 有可读系统 CA)才挂 CA 并设 `SSL_CERT_FILE`,但 `applyContainerConfig` 无论如何都返
   回 true。所以**探测 OneCLI 实际注入的 `SSL_CERT_FILE` 值**(`findInjectedEnvValue`)再镜像进
   `NODE_EXTRA_CA_CERTS`;若没探到(OneCLI 没挂 CA)则**spawn 直接抛错 fail-loud**,而不是静默
   起一个 OpenAI TLS 必失败的容器。(原设计硬编码 `/tmp/onecli-combined-ca.pem` 会在无系统 CA
   的 host 上指向不存在的文件 → 调用静默全挂,红队 low。)
5. **启动校验感知 vault 模式(红队修订)**:`config-validate` 原本只要 OPENAI_* 配了就硬要
   `OPENAI_API_KEY`,会**挡住安全部署启动**并逼运营者把 key 写回 host 磁盘。vault 模式下改为
   **不要 `OPENAI_API_KEY`、改要 `ONECLI_URL`**(没它 vault 注入不了,调用必 401)。direct 模式
   不变。
6. **默认 OFF 零变化**:flag 关 = openai/codex 仍直连拿 key(历史行为),字节级不变。

## 为什么选"复用 vault"而非"自建流式代理"

- OpenAI 是 SSE 流式,自建凭证代理要写"边收边转 + 背压"的流式转发器(ADR-0034 phase2 边界
  里描述的那套)——代码量大、在核心 LLM 热路径上新增维护面。
- vault **已经**为 Claude 在做完全相同的事(凭证注入 + 流式转发),复用它 = 近乎零新代码、
  单一凭证出口,与"backend gateway/vault 是唯一凭证路径"一致。
- 代价:**耦合 OneCLI**(平台对 openai 的 key 隔离依赖运营者在自己的 vault 里配好 OpenAI
  凭证 + 接受 `/tmp/onecli-combined-ca.pem` 这个 OneCLI 固定路径耦合)。因此是 **opt-in**:
  翻开关 = 运营者声明"我的 vault 能注入 OpenAI 凭证"。

## 失败模式 / fail-closed

- vault 未配 OpenAI 凭证就开了 flag:请求到 OpenAI 没凭证 → 401,agent 拿到错误。**不泄漏
  key,只是调用失败** —— 安全方向。文档要求运营者先在 vault 配好再翻开关。
- vault CA 不可信 / 路径缺失:bun fetch 证书校验失败 → 调用失败(同样 fail-closed)。
- 这不是结构性 fail-closed(不像 phase1 容器"根本没 key"):direct 模式仍存在(flag 关时);
  但 vault 模式下容器确实没有 key,做不出有效签名/认证的直连。

## 与既有 ADR 的关系

- **ADR-0024**:OpenAI provider 上下文压缩等不变;本 ADR 只动"key 从哪来 + 是否带 Authorization"。
- **ADR-0034**:同一目标(凭证不进容器)的 phase2,但实现路线不同(复用 vault 而非自建代理)。
  两者正交:gateway-signing-proxy 管 backend 网关签名;本 ADR 管 LLM provider key。一个容器可
  同时处于两种模式(目标主机不同:backend 网关 vs api.openai.com)。
- **ADR-0032(egress)**:vault 模式下,egress 必须放行容器 → vault 代理(与放行 backend 同理)。

## 红队结论(实现后,4 视角对抗复审 + 怀疑者反驳:5 确认 / 6 驳回)

- **medium(已修)**:启动校验在 vault 模式仍硬要 `OPENAI_API_KEY` → 安全部署起不来、逼 key 回
  磁盘。修:vault 模式不要 key、改要 `ONECLI_URL`(见决策 5)。
- **low(已修)**:`NODE_EXTRA_CA_CERTS` 硬编码路径,但 OneCLI 仅条件性挂 CA → 无系统 CA 的 host
  上 OpenAI 调用静默全挂。修:探测实际 `SSL_CERT_FILE`、没有则 spawn 报错(见决策 4)。
- **low(已修)**:vault 模式只看 flag、不校验 `ONECLI_URL` → 误配表现为无限重试 + 误导信息。修:
  并入决策 5 的启动校验(flag 开则要 `ONECLI_URL`)。
- 驳回 6 条(多为"已被 fail-closed/默认 OFF/既有机制覆盖")。

## 残余风险

- 耦合 OneCLI 与其固定 CA 路径;非 OneCLI 部署用不了本特性(那种部署要么用 Claude、要么接受
  direct 模式 + 运营层缓解:轮换 key / 锁 egress / 设消费上限)。
- vault 自身成为 OpenAI 凭证的信任点(本就是 Claude 的信任点,未扩大信任面)。
- 仍未覆盖:完全不依赖任何 vault 的"平台自建流式凭证代理"(若未来要彻底 self-contained,
  另开 ADR 走 ADR-0034 phase2 的自建路线)。

## 后果

- 正向:用 OpenAI/codex 的部署可一键(flag)把 key 移出容器,复用既有 vault,近乎零新代码。
- 成本:依赖运营者 vault 配置;耦合 OneCLI CA 路径;多一条 egress↔vault 可达性约束(已存在)。
- 测试:host 验 contribution 在 vault 模式省略 key + 注入标志、`routeOpenAiThroughVault` 纯函数;
  container 验 vault 模式不要求 key、不发 Authorization、仍打真实 baseUrl,direct 模式照发 Bearer。
  真·vault 端到端(凭证真被注入)需运营者用自己的 OneCLI 验证。
