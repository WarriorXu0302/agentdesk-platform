# 容器 Egress 联网管控

> 适用：`src/container-runner.ts`（`buildNetworkArgs` / `resolveContainerNetwork`）、
> `src/container-config.ts`（`network` 字段）、全局 `AGENT_CONTAINER_NETWORK`。
> 决策记录：ADR-0032。相关：ADR-0029（`no-new-privileges` + 可配置 `cap_drop`）。

本文档描述 agent 容器的出站网络（egress）管控：威胁模型、为什么它是关键缓解、
怎么配，以及配完之后仍然残留的风险。

---

## 1. 威胁模型

agent 容器在设计上就要**执行任意代码**——agent 会跑工具、装包、起浏览器、写脚本。
这是平台的功能而非缺陷。但它与几处必需的明文密钥叠加后，构成一条真实的外泄路径：

1. **明文 LLM key 进容器 env**（默认配置）。`openai` / `codex` provider 默认把
   `OPENAI_API_KEY`（以及 `OPENAI_BASE_URL` 等）通过 `docker run -e` 注入容器环境
   （`src/providers/openai.ts`）。（对比：`claude` provider 走 OneCLI 网关代理，容器内只有
   `ANTHROPIC_AUTH_TOKEN=placeholder`，真 token 在代理上换；见 `src/providers/claude.ts`。）
   **已不再是"无法消除"**：`AGENTDESK_OPENAI_VIA_ONECLI=true`（ADR-0035）让 openai/codex
   也走 vault，key 不进容器、由 vault 在线注入 Authorization。前提是运营者的 vault 配了
   OpenAI 凭证;未开此开关时仍是明文 key 进容器,egress 仍是其缓解。

2. **group 目录连同 `container.json` 挂进容器**。`container.json` 可能含
   `backendGateway.signingKey`（HMAC 签名密钥，用于向后端网关证明"这是宿主签发的容器"）。
   它以**只读**方式挂在 `/workspace/agent/container.json`（`src/container-runner.ts`
   `buildMounts`），agent 改不了它，但**读得到**。**已可消除**：
   `AGENTDESK_GATEWAY_SIGNING_PROXY=true`（ADR-0034）把 signingKey 移出容器,由宿主代签;
   未开时仍在容器内,egress 仍是其缓解。

3. **容器跑任意代码**。一旦 prompt 注入 / 供应链投毒 / 恶意工具让 agent 执行攻击者
   控制的代码，上面两个明文密钥就都在它的可达范围内。

把三者连起来：**容器内的进程能读到 LLM key 和 signingKey，并且默认能向任意外网地址
发起出站连接。** 因此"把密钥发到攻击者的服务器"或"拿 key 去刷任意第三方 API"在默认
配置下没有任何网络层阻拦。

### "别让密钥进容器"现在可做到（opt-in），egress 仍是兜底

最初这俩密钥被当作"无法从容器拿掉"，egress 是唯一缓解。现在两条都有了**默认 OFF 的
结构性解法**:`AGENTDESK_GATEWAY_SIGNING_PROXY`（ADR-0034，signingKey 宿主代签不进容器）
与 `AGENTDESK_OPENAI_VIA_ONECLI`（ADR-0035，OpenAI key 经 vault 注入不进容器）。但它们
是 opt-in 且有前置(前者要配 egress 放行容器→宿主代理;后者要 vault 配好 OpenAI 凭证),
**egress 管控仍是默认配置下、以及这两个开关未启用时的真正可落地缓解**:既然密钥可能还在
容器内,那就锁住它能被发去哪里。两层正交,生产部署建议都开。

---

## 2. 为什么 egress 管控是关键缓解

把容器的出口锁到一个**运营者控制的网络**上，即使密钥在容器内是明文、即使 agent 执行
了恶意代码：

- **泄漏的密钥外传不出去**——容器无法连到攻击者的收集服务器。
- **被盗的 key 调不了任意 API**——容器只能到达 allowlist 内的目的地（如你的后端网关、
  LLM 端点），调用别的服务在网络层就被掐断。
- **signingKey 即使被读出，也只能用于向你自己的网关发请求**——而网关本就有时间戳 +
  nonce + 重放缓存（见 `docs/enterprise-erp-gateway.md`），泄漏面被进一步约束。

这不是"防止密钥被读"（读不住），而是"**让读到密钥的代码无处使用它**"。这正是纵深防御
里最贴近本场景的一层。

---

## 3. 怎么配

两个旋钮，**默认都关**（不设 = docker 默认 `bridge` = 不受限出网，与历史行为完全一致）：

### 3.1 per-group：`container.json` 的 `network`

```jsonc
// groups/<folder>/container.json
{
  "network": "egress-proxy"   // 该 group 的容器接到名为 egress-proxy 的 docker 网络
}
```

### 3.2 全局：`AGENT_CONTAINER_NETWORK`

```bash
# .env / 环境
AGENT_CONTAINER_NETWORK=egress-proxy   # 未单独配 network 的 group 默认接这个网络
```

**优先级**：per-group `network` > 全局 `AGENT_CONTAINER_NETWORK` > 不设（默认 bridge）。

### 3.3 取值与校验

接受两类值：

| 取值 | 含义 |
|---|---|
| 自定义网络名（`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`） | 接到该 docker 网络（推荐：运营者管理的 egress-proxy 网络） |
| `none` | 完全无网络。用于**只通过会话 DB 与宿主通信**的纯 DB worker |
| `host` | 共享宿主网络命名空间（极少推荐，容器能直达 host-local 服务） |
| `bridge` | docker 默认，等价于不设（显式写法） |

**非法值（空、前导 `-`、含空格 / `;` / `$(...)` 等 argv/shell 元字符、`container:<id>`
间接形式）会被拒绝**：记一条 `log.warn`，**回退到默认网络**（不 push `--network`），
**绝不**把未校验字符串拼进 docker 参数。这条规则同时满足两个约束——防注入、且"配错了
也不会把 agent 的网断掉"。

### 3.4 推荐生产姿态：egress-proxy + allowlist

1. 建一个 docker 网络（如 `egress-proxy`），网络里放一个**只放行 allowlist 目的地**
   的正向代理 / 防火墙（如 squid、tinyproxy、或 envoy + RBAC）。
2. allowlist 放：你的后端网关域名、所用 LLM 端点（`api.openai.com` / 你的私有推理服务）、
   以及 agent 业务确实需要的其它域名。
3. 把需要联网的 group 的 `network` 指到这个网络（或用全局 `AGENT_CONTAINER_NETWORK`
   设为默认）。

这样 agent 仍能正常浏览/调 API/装包（只要目的地在 allowlist 内），但泄漏的密钥到不了
allowlist 外的任何地方。

### 3.5 纯 DB worker：`network: "none"`

如果某 worker group 只通过 `inbound.db` / `outbound.db` 与宿主通信、不需要任何外网
（也不调 LLM——例如纯本地处理或经宿主代理的场景），直接 `network: "none"`，出口面归零。
注意：用 OneCLI 网关代理的 `claude` provider 需要能连到代理；`none` 只适合确实不需要
任何网络出口的 worker。

---

## 4. 与 ADR-0029（`no-new-privileges`）的关系

ADR-0029 的 `--security-opt=no-new-privileges:true`（恒开）缩小的是**提权面**——阻止
容器内进程通过 setuid 二进制获得新权限。它**不**限制网络。

本特性（ADR-0032）缩小的是**出站面**——限制容器内进程能连到哪里。二者正交、互补：

- `no-new-privileges`：拿不到更高权限。
- egress 管控：拿到了（哪怕是密钥），也发不出去 / 调不了任意 API。

两者都遵循同一条出厂原则——**默认零行为变化，opt-in 收紧**（ADR-0029 的 `cap_drop`
默认不丢，ADR-0032 的 `--network` 默认不设）。

---

## 5. 残留风险与建议

egress 管控是缓解，不是消除。配完之后仍然存在：

- **容器内密钥仍是明文**。能读到它的代码依然能在 allowlist 内**正常使用**它
  （例如照常调你放行的 LLM 端点、照常调你的网关）。egress 只挡"发去 allowlist 外"。
- **allowlist 配太宽 = 缓解失效**。如果 allowlist 里有一个能转发任意流量的目的地
  （开放的代理、能 SSRF 的内部服务），密钥仍可能被中转出去。allowlist 要按最小必需维护。
- **`host` 模式基本放弃了本层防护**——容器直接共享宿主网络。除非你清楚后果，否则别用。
- **signingKey 泄漏后在 allowlist 内仍可用**。egress 把它的可用范围压到"只能打你自己的
  网关"，但网关侧的时间戳/nonce/重放防护仍是必需的第二道闸（不要因为有了 egress 就放松
  网关校验）。

**建议**：

1. 生产部署用 §3.4 的 egress-proxy + allowlist 姿态，而不是放任默认 bridge。
2. 纯 DB worker 用 `none`。
3. allowlist 维护成最小必需集，定期审计。
4. 不要依赖 egress 单层——它与 ADR-0029 提权收敛、网关 HMAC 校验、会话隔离共同构成纵深。

---

## 6. 后续工作（不在本批范围）

- **宿主侧网关签名代理**：把 `backendGateway.signingKey` 从容器内挪走，改为容器经一个
  宿主侧代理发请求、由代理在出站时签名（类似 `claude` provider 的 OneCLI 模式）。这样
  容器内不再有 signingKey 明文，从根上消除挂载泄漏面。属架构级改造，记录于 ADR-0032 的
  "后续工作"，本批未做。
- **OpenAI key 的代理化**：同理，为 `openai` / `codex` 引入凭证代理，让真 key 也不进
  容器。需要 provider 侧与代理协议改造。
